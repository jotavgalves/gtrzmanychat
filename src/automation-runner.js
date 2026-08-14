import { getSetting, requireDb, upsertContactFromMessage } from './db.js';
import { sendPrivateReply } from './meta.js';

function automationMatches(automation, comment, now) {
  if (automation.status !== 'active') return false;
  if (automation.media_scope === 'specific' && String(automation.media_id || '') !== String(comment.mediaId || '')) return false;
  if (automation.start_at && now < new Date(automation.start_at)) return false;
  if (automation.end_at && now > new Date(automation.end_at)) return false;
  if (automation.trigger_type === 'keyword') {
    const keyword = String(automation.keyword || '').toLocaleLowerCase('pt-BR');
    const text = String(comment.text || '').toLocaleLowerCase('pt-BR');
    return Boolean(keyword) && text.includes(keyword);
  }
  return true;
}

async function isEligibleForContact(env, automation, contactId) {
  if (!contactId) return true;
  const db = requireDb(env);
  if (Number(automation.once_per_contact) === 1) {
    const prior = await db
      .prepare(`SELECT id FROM automation_runs WHERE automation_id = ? AND contact_id = ? AND status = 'succeeded' LIMIT 1`)
      .bind(automation.id, contactId)
      .first();
    if (prior) return false;
  }
  const cooldown = Number(automation.cooldown_minutes || 0);
  if (cooldown > 0) {
    const prior = await db
      .prepare(`SELECT created_at FROM automation_runs
                WHERE automation_id = ? AND contact_id = ? AND status = 'succeeded'
                ORDER BY created_at DESC LIMIT 1`)
      .bind(automation.id, contactId)
      .first();
    if (prior?.created_at) {
      const ageMs = Date.now() - new Date(`${prior.created_at}Z`).getTime();
      if (Number.isFinite(ageMs) && ageMs < cooldown * 60 * 1000) return false;
    }
  }
  return true;
}

async function claimRun(env, automation, comment) {
  const db = requireDb(env);
  const id = crypto.randomUUID();
  const result = await db
    .prepare(`INSERT OR IGNORE INTO automation_runs
      (id,automation_id,comment_id,contact_id,status) VALUES (?,?,?,?, 'claimed')`)
    .bind(id, automation.id, comment.commentId, comment.contactId)
    .run();
  if (Number(result?.meta?.changes || 0) > 0) return { id, claimed: true };

  const existing = await db
    .prepare('SELECT id,status FROM automation_runs WHERE automation_id = ? AND comment_id = ?')
    .bind(automation.id, comment.commentId)
    .first();
  if (existing?.status === 'rate_limited') {
    await db.prepare(`UPDATE automation_runs SET status='claimed', reason=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(existing.id).run();
    return { id: existing.id, claimed: true };
  }
  return { id: existing?.id || null, claimed: false };
}

export async function processComment(env, comment) {
  const db = requireDb(env);
  if (comment.contactId) {
    await db
      .prepare(`INSERT INTO contacts (id,username,first_source,last_source,comments_count)
                VALUES (?,?,'comment','comment',0)
                ON CONFLICT(id) DO UPDATE SET username=COALESCE(excluded.username,contacts.username),last_seen_at=CURRENT_TIMESTAMP,last_source='comment'`)
      .bind(comment.contactId, comment.username)
      .run();
  }
  const inserted = await db
    .prepare(`INSERT OR IGNORE INTO comments (id,contact_id,username,media_id,text,created_at)
              VALUES (?,?,?,?,?,?)`)
    .bind(comment.commentId, comment.contactId, comment.username, comment.mediaId, comment.text, comment.createdAt)
    .run();

  if (Number(inserted?.meta?.changes || 0) === 0) {
    const retryable = await db
      .prepare("SELECT id FROM automation_runs WHERE comment_id = ? AND status = 'rate_limited' LIMIT 1")
      .bind(comment.commentId)
      .first();
    if (!retryable) return { outcome: 'duplicate' };
  } else if (comment.contactId) {
    await db.prepare('UPDATE contacts SET comments_count=comments_count+1 WHERE id=?').bind(comment.contactId).run();
  }

  if ((await getSetting(env, 'global_paused', '0')) === '1') return { outcome: 'paused' };

  const { results } = await db.prepare(`SELECT * FROM automations WHERE status='active' ORDER BY priority DESC, created_at ASC`).all();
  const now = new Date();

  for (const automation of results || []) {
    if (!automationMatches(automation, comment, now)) continue;
    if (!(await isEligibleForContact(env, automation, comment.contactId))) continue;

    const claim = await claimRun(env, automation, comment);
    if (!claim.claimed) return { outcome: 'already_claimed', automationId: automation.id };

    let result;
    try {
      result = await sendPrivateReply(env, comment.commentId, automation.reply_text);
    } catch (error) {
      await db
        .prepare(`UPDATE automation_runs SET status='uncertain', reason=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .bind(String(error?.message || error).slice(0, 800), claim.id)
        .run();
      return { outcome: 'uncertain', automationId: automation.id };
    }

    if (result.ok) {
      await db
        .prepare(`UPDATE automation_runs SET status='succeeded', meta_message_id=?, meta_response=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .bind(result.messageId, JSON.stringify(result.data || {}).slice(0, 4000), claim.id)
        .run();
      if (comment.contactId) {
        await db
          .prepare(`INSERT OR IGNORE INTO messages (id,contact_id,direction,text,meta_message_id,automation_id)
                    VALUES (?,?,'outbound',?,?,?)`)
          .bind(`auto:${claim.id}`, comment.contactId, automation.reply_text, result.messageId, automation.id)
          .run();
        await upsertContactFromMessage(env, comment.contactId, comment.username, 'outbound');
      }
      return { outcome: 'sent', automationId: automation.id, messageId: result.messageId };
    }

    if (result.status === 429) {
      await db
        .prepare(`UPDATE automation_runs SET status='rate_limited', reason=?, meta_response=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .bind(result.error || 'Meta rate limit', JSON.stringify(result.data || {}).slice(0, 4000), claim.id)
        .run();
      return { outcome: 'rate_limited', automationId: automation.id, retry: true };
    }

    const status = result.status >= 500 ? 'uncertain' : 'failed';
    await db
      .prepare(`UPDATE automation_runs SET status=?, reason=?, meta_response=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .bind(status, result.error || `HTTP ${result.status}`, JSON.stringify(result.data || {}).slice(0, 4000), claim.id)
      .run();
    return { outcome: status, automationId: automation.id };
  }

  return { outcome: 'no_match' };
}

export async function processInboundMessage(env, message) {
  const db = requireDb(env);
  await db
    .prepare(`INSERT INTO contacts (id,first_source,last_source,inbound_messages_count) VALUES (?,'message','message',0)
              ON CONFLICT(id) DO UPDATE SET last_seen_at=CURRENT_TIMESTAMP,last_source='message'`)
    .bind(message.contactId)
    .run();
  const result = await db
    .prepare(`INSERT OR IGNORE INTO messages (id,contact_id,direction,text,created_at,meta_message_id)
              VALUES (?,?,'inbound',?,?,?)`)
    .bind(`ig:${message.messageId}`, message.contactId, message.text, message.timestamp, message.messageId)
    .run();
  if (Number(result?.meta?.changes || 0) === 0) return { outcome: 'duplicate' };
  await db.prepare('UPDATE contacts SET inbound_messages_count=inbound_messages_count+1 WHERE id=?').bind(message.contactId).run();
  return { outcome: 'stored' };
}

export async function simulateAutomationSelection(env, input) {
  if ((await getSetting(env, 'global_paused', '0')) === '1') return { matched: false, reason: 'Todas as automações estão pausadas pelo kill switch.' };
  const { results } = await requireDb(env).prepare(`SELECT * FROM automations WHERE status='active' ORDER BY priority DESC, created_at ASC`).all();
  const comment = {
    text: String(input?.text || ''),
    mediaId: input?.media_id ? String(input.media_id) : null,
    contactId: input?.contact_id ? String(input.contact_id) : null,
  };
  const now = new Date();
  for (const automation of results || []) {
    if (!automationMatches(automation, comment, now)) continue;
    if (!(await isEligibleForContact(env, automation, comment.contactId))) continue;
    return {
      matched: true,
      automation: {
        id: automation.id,
        name: automation.name,
        reply_text: automation.reply_text,
        trigger_type: automation.trigger_type,
        keyword: automation.keyword,
        media_scope: automation.media_scope,
        media_id: automation.media_id,
      },
    };
  }
  return { matched: false, reason: 'Nenhuma automação ativa corresponde a esse comentário.' };
}
