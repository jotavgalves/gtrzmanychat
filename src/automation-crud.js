import { requireDb } from './db.js';

function cleanText(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function asBooleanInt(value, fallback = 1) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 1 || value === '1' ? 1 : 0;
}

export function validateAutomationInput(body, existing = null) {
  const source = { ...(existing || {}), ...(body || {}) };
  const triggerType = source.trigger_type === 'keyword' ? 'keyword' : 'any_comment';
  const mediaScope = source.media_scope === 'specific' ? 'specific' : 'all';
  const status = source.status === 'active' ? 'active' : 'paused';
  const name = cleanText(source.name, 100);
  const replyText = cleanText(source.reply_text, 1000);
  const keyword = triggerType === 'keyword' ? cleanText(source.keyword, 120) : null;
  const mediaId = mediaScope === 'specific' ? cleanText(source.media_id, 120) : null;
  const mediaLabel = mediaScope === 'specific' ? cleanText(source.media_label, 240) : null;
  const cooldown = Math.max(0, Math.min(Number(source.cooldown_minutes) || 0, 43200));
  const priority = Math.max(0, Math.min(Number(source.priority) || 100, 10000));

  if (!name) throw new Error('Dê um nome para a automação.');
  if (!replyText) throw new Error('A mensagem da DM não pode ficar vazia.');
  if (triggerType === 'keyword' && !keyword) throw new Error('Informe a palavra-chave.');
  if (mediaScope === 'specific' && !mediaId) throw new Error('Selecione uma publicação específica.');

  return {
    name,
    status,
    trigger_type: triggerType,
    media_scope: mediaScope,
    media_id: mediaId,
    media_label: mediaLabel,
    keyword,
    reply_text: replyText,
    once_per_contact: asBooleanInt(source.once_per_contact, 1),
    cooldown_minutes: cooldown,
    priority,
    start_at: source.start_at ? String(source.start_at) : null,
    end_at: source.end_at ? String(source.end_at) : null,
  };
}

export async function listAutomations(env) {
  const { results } = await requireDb(env)
    .prepare(`SELECT a.*,
      COUNT(r.id) AS runs_total,
      SUM(CASE WHEN r.status = 'succeeded' THEN 1 ELSE 0 END) AS sent_total,
      SUM(CASE WHEN r.status IN ('failed','uncertain') THEN 1 ELSE 0 END) AS failed_total
      FROM automations a
      LEFT JOIN automation_runs r ON r.automation_id = a.id
      GROUP BY a.id
      ORDER BY a.priority DESC, a.created_at ASC`)
    .all();
  return results || [];
}

export async function createAutomation(env, input) {
  const data = validateAutomationInput(input);
  const id = crypto.randomUUID();
  await requireDb(env)
    .prepare(`INSERT INTO automations
      (id,name,status,trigger_type,media_scope,media_id,media_label,keyword,reply_text,once_per_contact,cooldown_minutes,priority,start_at,end_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(
      id,
      data.name,
      data.status,
      data.trigger_type,
      data.media_scope,
      data.media_id,
      data.media_label,
      data.keyword,
      data.reply_text,
      data.once_per_contact,
      data.cooldown_minutes,
      data.priority,
      data.start_at,
      data.end_at,
    )
    .run();
  return requireDb(env).prepare('SELECT * FROM automations WHERE id = ?').bind(id).first();
}

export async function updateAutomation(env, id, input) {
  const existing = await requireDb(env).prepare('SELECT * FROM automations WHERE id = ?').bind(id).first();
  if (!existing) throw new Error('Automação não encontrada.');
  const data = validateAutomationInput(input, existing);
  await requireDb(env)
    .prepare(`UPDATE automations SET
      name=?,status=?,trigger_type=?,media_scope=?,media_id=?,media_label=?,keyword=?,reply_text=?,
      once_per_contact=?,cooldown_minutes=?,priority=?,start_at=?,end_at=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=?`)
    .bind(
      data.name,
      data.status,
      data.trigger_type,
      data.media_scope,
      data.media_id,
      data.media_label,
      data.keyword,
      data.reply_text,
      data.once_per_contact,
      data.cooldown_minutes,
      data.priority,
      data.start_at,
      data.end_at,
      id,
    )
    .run();
  return requireDb(env).prepare('SELECT * FROM automations WHERE id = ?').bind(id).first();
}

export async function deleteAutomation(env, id) {
  const result = await requireDb(env).prepare('DELETE FROM automations WHERE id = ?').bind(id).run();
  return Number(result?.meta?.changes || 0) > 0;
}
