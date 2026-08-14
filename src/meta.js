import { getInstagramAccount, saveInstagramAccount } from './db.js';

const encoder = new TextEncoder();

function sqliteTimestamp(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function apiVersion(env) {
  return env.META_API_VERSION || 'v25.0';
}

function requireToken(env) {
  if (!env.INSTAGRAM_ACCESS_TOKEN) throw new Error('INSTAGRAM_ACCESS_TOKEN não configurado.');
  return env.INSTAGRAM_ACCESS_TOKEN;
}

async function metaFetch(env, path, init = {}) {
  const token = requireToken(env);
  const headers = new Headers(init.headers || {});
  headers.set('authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(`https://graph.instagram.com/${apiVersion(env)}${path}`, { ...init, headers });
}

async function readJsonSafely(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function subscribeAccountWebhooks(env, accountId, fields = ['comments', 'messages']) {
  const requested = [...new Set(fields.map(String).filter(Boolean))];
  const response = await metaFetch(env, `/${encodeURIComponent(accountId)}/subscribed_apps`, {
    method: 'POST',
    body: JSON.stringify({ subscribed_fields: requested }),
  });
  const data = await readJsonSafely(response);
  if (!response.ok || data?.success !== true) {
    throw new Error(data?.error?.message || `Falha ao assinar webhooks: HTTP ${response.status}`);
  }
  return requested;
}

export async function syncInstagramAccount(env) {
  const response = await metaFetch(env, '/me?fields=id,username');
  const data = await readJsonSafely(response);
  if (!response.ok || !data?.id) {
    const message = data?.error?.message || `Meta retornou HTTP ${response.status}`;
    throw new Error(message);
  }
  const account = await saveInstagramAccount(env, data);
  await subscribeAccountWebhooks(env, data.id, ['comments', 'messages']);
  return account;
}

export async function resolveInstagramAccount(env) {
  return (await getInstagramAccount(env)) || syncInstagramAccount(env);
}

export async function getWebhookSubscriptions(env) {
  const account = await resolveInstagramAccount(env);
  const response = await metaFetch(env, `/${encodeURIComponent(account.id)}/subscribed_apps`);
  const data = await readJsonSafely(response);
  if (!response.ok) {
    throw new Error(data?.error?.message || `Falha ao consultar assinaturas de webhook: HTTP ${response.status}`);
  }
  const app = Array.isArray(data?.data) ? data.data[0] : null;
  return {
    appId: app?.id || null,
    fields: Array.isArray(app?.subscribed_fields) ? app.subscribed_fields.map(String) : [],
    raw: data,
  };
}

export async function ensureWebhookSubscriptions(env, requestedFields = ['comments', 'messages']) {
  const account = await resolveInstagramAccount(env);
  const fields = await subscribeAccountWebhooks(env, account.id, requestedFields);
  const current = await getWebhookSubscriptions(env);
  return {
    success: true,
    requested: fields,
    fields: current.fields,
    appId: current.appId,
  };
}

export async function getMetaStatus(env) {
  const configured = {
    accessToken: Boolean(env.INSTAGRAM_ACCESS_TOKEN),
    appSecret: Boolean(env.META_APP_SECRET),
    verifyToken: Boolean(env.META_VERIFY_TOKEN),
  };
  if (!configured.accessToken) return { connected: false, configured, error: 'Token do Instagram ainda não configurado.' };
  try {
    const account = await syncInstagramAccount(env);
    let subscriptions = null;
    let subscriptionError = null;
    try {
      subscriptions = await getWebhookSubscriptions(env);
    } catch (error) {
      subscriptionError = String(error?.message || error);
    }
    return {
      connected: true,
      configured,
      account,
      apiVersion: apiVersion(env),
      subscribedFields: subscriptions?.fields || [],
      webhookAppId: subscriptions?.appId || null,
      subscriptionError,
    };
  } catch (error) {
    return { connected: false, configured, error: String(error?.message || error), apiVersion: apiVersion(env) };
  }
}

export async function listInstagramMedia(env, limit = 50) {
  const account = await resolveInstagramAccount(env);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
  const response = await metaFetch(
    env,
    `/${encodeURIComponent(account.id)}/media?fields=id,caption,media_type,permalink,timestamp&limit=${safeLimit}`,
  );
  const data = await readJsonSafely(response);
  if (!response.ok) throw new Error(data?.error?.message || `Falha ao carregar publicações: HTTP ${response.status}`);
  return data?.data || [];
}

export async function listInstagramComments(env, mediaId, limit = 25) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
  const response = await metaFetch(
    env,
    `/${encodeURIComponent(mediaId)}/comments?fields=from,text&limit=${safeLimit}`,
  );
  const data = await readJsonSafely(response);
  if (!response.ok) {
    throw new Error(data?.error?.message || `Falha ao carregar comentários da mídia ${mediaId}: HTTP ${response.status}`);
  }
  return (data?.data || []).map((comment) => ({
    id: comment?.id ? String(comment.id) : null,
    text: typeof comment?.text === 'string' ? comment.text : '',
    from: comment?.from ? {
      id: comment.from.id != null ? String(comment.from.id) : null,
      username: comment.from.username || null,
    } : null,
  }));
}

export async function testInstagramCommentPolling(env, mediaLimit = 5, commentLimit = 25) {
  const media = await listInstagramMedia(env, mediaLimit);
  const results = [];
  for (const item of media) {
    try {
      const comments = await listInstagramComments(env, item.id, commentLimit);
      results.push({
        media: {
          id: String(item.id),
          media_type: item.media_type || null,
          permalink: item.permalink || null,
          timestamp: item.timestamp || null,
          caption: typeof item.caption === 'string' ? item.caption.slice(0, 160) : '',
        },
        comments,
        commentsCount: comments.length,
      });
    } catch (error) {
      results.push({
        media: {
          id: String(item.id),
          media_type: item.media_type || null,
          permalink: item.permalink || null,
          timestamp: item.timestamp || null,
          caption: typeof item.caption === 'string' ? item.caption.slice(0, 160) : '',
        },
        comments: [],
        commentsCount: 0,
        error: String(error?.message || error),
      });
    }
  }
  return {
    apiVersion: apiVersion(env),
    mediaCount: media.length,
    totalCommentsRead: results.reduce((sum, item) => sum + item.commentsCount, 0),
    results,
  };
}

export async function sendPrivateReply(env, commentId, text) {
  const account = await resolveInstagramAccount(env);
  const response = await metaFetch(env, `/${encodeURIComponent(account.id)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text } }),
  });
  const data = await readJsonSafely(response);
  return {
    ok: response.ok,
    status: response.status,
    data,
    messageId: data?.message_id || null,
    recipientId: data?.recipient_id || null,
    error: data?.error?.message || null,
  };
}

export async function sendDirectMessage(env, recipientId, text) {
  const account = await resolveInstagramAccount(env);
  const response = await metaFetch(env, `/${encodeURIComponent(account.id)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
  });
  const data = await readJsonSafely(response);
  return {
    ok: response.ok,
    status: response.status,
    data,
    messageId: data?.message_id || null,
    recipientId: data?.recipient_id || recipientId,
    error: data?.error?.message || null,
  };
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeStringEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

export async function verifyMetaSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret || !signatureHeader?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, rawBody);
  return constantTimeStringEqual(`sha256=${hex(new Uint8Array(signature))}`, signatureHeader);
}

export async function hashWebhookBody(rawBody) {
  const digest = await crypto.subtle.digest('SHA-256', rawBody);
  return hex(new Uint8Array(digest));
}

export function normalizeCommentEvents(payload) {
  const comments = [];
  if (!payload || payload.object !== 'instagram' || !Array.isArray(payload.entry)) return comments;

  for (const entry of payload.entry) {
    for (const change of entry.changes || []) {
      if (change?.field !== 'comments' && change?.field !== 'live_comments') continue;
      const value = change.value || {};
      const commentId = value.id || value.comment_id;
      if (!commentId) continue;
      comments.push({
        commentId: String(commentId),
        contactId: value.from?.id ? String(value.from.id) : null,
        username: value.from?.username || null,
        mediaId: value.media?.id ? String(value.media.id) : value.media_id ? String(value.media_id) : null,
        text: typeof value.text === 'string' ? value.text : '',
        createdAt: value.created_time ? sqliteTimestamp(new Date(Number(value.created_time) * 1000)) : null,
        source: change.field === 'live_comments' ? 'live_comment' : 'comment',
      });
    }
  }
  return comments;
}

export function normalizeMessageEvents(payload) {
  const messages = [];
  if (!payload || payload.object !== 'instagram' || !Array.isArray(payload.entry)) return messages;

  for (const entry of payload.entry) {
    for (const item of entry.messaging || []) {
      const message = item?.message;
      if (!message || message.is_echo || !item?.sender?.id) continue;
      messages.push({
        messageId: message.mid || crypto.randomUUID(),
        contactId: String(item.sender.id),
        text: typeof message.text === 'string' ? message.text : '',
        timestamp: item.timestamp ? sqliteTimestamp(new Date(Number(item.timestamp))) : sqliteTimestamp(new Date()),
      });
    }
  }
  return messages;
}
