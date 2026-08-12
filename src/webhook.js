import { safeSecretEqual } from './auth.js';
import { assertSchema, requireDb } from './db.js';
import { processComment, processInboundMessage } from './automation-runner.js';
import { hashWebhookBody, normalizeCommentEvents, normalizeMessageEvents, verifyMetaSignature } from './meta.js';

const MAX_WEBHOOK_BODY = 120 * 1024;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

function errorMessage(error) { return String(error?.message || error || 'Erro inesperado'); }

export async function handleWebhookVerification(request, env) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const verifyToken = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (mode !== 'subscribe' || !challenge || !env.META_VERIFY_TOKEN) return new Response('Forbidden', { status: 403 });
  if (!(await safeSecretEqual(verifyToken, env.META_VERIFY_TOKEN))) return new Response('Forbidden', { status: 403 });
  return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

export async function handleWebhook(request, env) {
  if (!env.META_APP_SECRET) return json({ ok: false, error: 'META_APP_SECRET não configurado.' }, 503);
  if (!env.EVENT_QUEUE) return json({ ok: false, error: 'Queue EVENT_QUEUE não configurada.' }, 503);
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_WEBHOOK_BODY) return json({ ok: false, error: 'Webhook grande demais.' }, 413);
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_WEBHOOK_BODY) return json({ ok: false, error: 'Webhook grande demais.' }, 413);
  const valid = await verifyMetaSignature(raw, request.headers.get('x-hub-signature-256'), env.META_APP_SECRET);
  if (!valid) return json({ ok: false, error: 'Assinatura inválida.' }, 401);

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return json({ ok: false, error: 'Payload inválido.' }, 400);
  }

  const eventId = await hashWebhookBody(raw);
  await env.EVENT_QUEUE.send({ eventId, payload, receivedAt: new Date().toISOString() });
  return json({ ok: true, queued: true });
}

async function processQueueMessage(message, env) {
  const event = message.body || {};
  const eventId = String(event.eventId || message.id || crypto.randomUUID());
  const db = requireDb(env);

  const existing = await db.prepare('SELECT status FROM webhook_events WHERE id=?').bind(eventId).first();
  if (existing?.status === 'processed' || existing?.status === 'ignored') return { retry: false };
  if (!existing) {
    await db
      .prepare(`INSERT INTO webhook_events (id,object_type,status) VALUES (?,?, 'queued')`)
      .bind(eventId, event.payload?.object || null)
      .run();
  }

  const comments = normalizeCommentEvents(event.payload);
  const messages = normalizeMessageEvents(event.payload);
  if (!comments.length && !messages.length) {
    await db.prepare(`UPDATE webhook_events SET status='ignored',processed_at=CURRENT_TIMESTAMP WHERE id=?`).bind(eventId).run();
    return { retry: false };
  }

  let shouldRetry = false;
  for (const comment of comments) {
    const result = await processComment(env, comment);
    if (result.retry) shouldRetry = true;
  }
  for (const inbound of messages) await processInboundMessage(env, inbound);

  if (shouldRetry) {
    await db.prepare(`UPDATE webhook_events SET status='queued',error='Meta rate limit' WHERE id=?`).bind(eventId).run();
    return { retry: true };
  }
  await db.prepare(`UPDATE webhook_events SET status='processed',processed_at=CURRENT_TIMESTAMP,error=NULL WHERE id=?`).bind(eventId).run();
  return { retry: false };
}

export async function handleQueue(batch, env) {
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
      if (result.retry) message.retry({ delaySeconds: Math.min(900, 30 * Math.max(1, message.attempts || 1)) });
      else message.ack();
    } catch (error) {
      console.error(JSON.stringify({ scope: 'queue_message', messageId: message.id, error: errorMessage(error) }));
      message.retry({ delaySeconds: Math.min(900, 30 * Math.max(1, message.attempts || 1)) });
    }
  }
}
