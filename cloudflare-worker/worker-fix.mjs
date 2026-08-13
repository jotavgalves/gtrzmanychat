import { handleAdminApi } from '../src/api.js';
import { handleWebhook, handleWebhookVerification } from '../src/webhook.js';
import { assertSchema, requireDb } from '../src/db.js';
import { processComment, processInboundMessage } from '../src/automation-runner.js';
import { normalizeMessageEvents } from '../src/meta.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function errorMessage(error) {
  return String(error?.message || error || 'Erro inesperado');
}

function sqliteTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function normalizeCommentChange(change) {
  const field = change?.field;
  if (field !== 'comments' && field !== 'live_comments') return null;

  const value = change?.value || {};
  const commentId = value.id || value.comment_id;
  if (!commentId) return null;

  const from = value.from || {};
  const media = value.media || {};

  return {
    commentId: String(commentId),
    contactId: from.id != null
      ? String(from.id)
      : value.user_id != null
        ? String(value.user_id)
        : null,
    username: from.username || value.username || null,
    mediaId: media.id != null
      ? String(media.id)
      : value.media_id != null
        ? String(value.media_id)
        : null,
    text: typeof value.text === 'string' ? value.text : '',
    createdAt: sqliteTimestamp(value.created_time ?? value.timestamp),
    source: field === 'live_comments' ? 'live_comment' : 'comment',
  };
}

function normalizeCommentEvents(payload) {
  const comments = [];
  if (!payload || payload.object !== 'instagram' || !Array.isArray(payload.entry)) return comments;

  for (const entry of payload.entry) {
    if (Array.isArray(entry?.changes)) {
      for (const change of entry.changes) {
        const comment = normalizeCommentChange(change);
        if (comment) comments.push(comment);
      }
    }

    if (entry?.field && entry?.value) {
      const comment = normalizeCommentChange({ field: entry.field, value: entry.value });
      if (comment) comments.push(comment);
    }
  }

  const seen = new Set();
  return comments.filter((comment) => {
    if (seen.has(comment.commentId)) return false;
    seen.add(comment.commentId);
    return true;
  });
}

async function processQueueMessage(message, env) {
  const event = message.body || {};
  const eventId = String(event.eventId || message.id || crypto.randomUUID());
  const db = requireDb(env);

  const existing = await db
    .prepare('SELECT status FROM webhook_events WHERE id=?')
    .bind(eventId)
    .first();

  if (existing?.status === 'processed' || existing?.status === 'ignored') {
    return { retry: false };
  }

  if (!existing) {
    await db
      .prepare(`INSERT INTO webhook_events (id,object_type,status) VALUES (?,?, 'queued')`)
      .bind(eventId, event.payload?.object || null)
      .run();
  }

  const comments = normalizeCommentEvents(event.payload);
  const messages = normalizeMessageEvents(event.payload);

  console.log(JSON.stringify({
    scope: 'instagram_webhook_parsed',
    eventId,
    object: event.payload?.object || null,
    comments: comments.length,
    messages: messages.length,
  }));

  if (!comments.length && !messages.length) {
    await db
      .prepare(`UPDATE webhook_events SET status='ignored',processed_at=CURRENT_TIMESTAMP,error='No supported events found' WHERE id=?`)
      .bind(eventId)
      .run();
    return { retry: false };
  }

  let shouldRetry = false;

  for (const comment of comments) {
    const result = await processComment(env, comment);
    console.log(JSON.stringify({
      scope: 'instagram_comment_processed',
      eventId,
      commentId: comment.commentId,
      outcome: result?.outcome || null,
      automationId: result?.automationId || null,
    }));
    if (result?.retry) shouldRetry = true;
  }

  for (const inbound of messages) {
    await processInboundMessage(env, inbound);
  }

  if (shouldRetry) {
    await db
      .prepare(`UPDATE webhook_events SET status='queued',error='Meta rate limit' WHERE id=?`)
      .bind(eventId)
      .run();
    return { retry: true };
  }

  await db
    .prepare(`UPDATE webhook_events SET status='processed',processed_at=CURRENT_TIMESTAMP,error=NULL WHERE id=?`)
    .bind(eventId)
    .run();

  return { retry: false };
}

async function handleQueue(batch, env) {
  try {
    await assertSchema(env);
  } catch (error) {
    console.error(JSON.stringify({ scope: 'queue_schema', error: errorMessage(error) }));
    batch.retryAll({ delaySeconds: 60 });
    return;
  }

  for (const message of batch.messages) {
    try {
      const result = await processQueueMessage(message, env);
      if (result.retry) {
        message.retry({ delaySeconds: Math.min(900, 30 * Math.max(1, message.attempts || 1)) });
      } else {
        message.ack();
      }
    } catch (error) {
      console.error(JSON.stringify({
        scope: 'queue_message',
        messageId: message.id,
        error: errorMessage(error),
      }));
      message.retry({ delaySeconds: Math.min(900, 30 * Math.max(1, message.attempts || 1)) });
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/webhooks/instagram' && request.method === 'GET') {
        return handleWebhookVerification(request, env);
      }
      if (url.pathname === '/webhooks/instagram' && request.method === 'POST') {
        return handleWebhook(request, env);
      }
      if (url.pathname.startsWith('/api/')) {
        return handleAdminApi(request, env, url.pathname);
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(JSON.stringify({
        scope: 'fetch',
        path: url.pathname,
        error: errorMessage(error),
      }));
      return json({ ok: false, error: errorMessage(error) }, 500);
    }
  },

  async queue(batch, env) {
    return handleQueue(batch, env);
  },
};
