import { createSession, safeSecretEqual, sessionCookie, verifySession } from './auth.js';
import { assertSchema, getSetting, requireDb, setSetting, upsertContactFromMessage, writeAudit } from './db.js';
import { createAutomation, deleteAutomation, listAutomations, updateAutomation } from './automation-crud.js';
import { simulateAutomationSelection } from './automation-runner.js';
import { getMetaStatus, listInstagramMedia, sendDirectMessage, syncInstagramAccount, testInstagramCommentPolling } from './meta.js';

const MAX_JSON_BODY = 128 * 1024;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

function errorMessage(error) {
  return String(error?.message || error || 'Erro inesperado');
}

async function readJson(request, maxBytes = MAX_JSON_BODY) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > maxBytes) throw new Error('Corpo da requisição grande demais.');
  const raw = await request.arrayBuffer();
  if (raw.byteLength > maxBytes) throw new Error('Corpo da requisição grande demais.');
  if (!raw.byteLength) return {};
  try {
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new Error('JSON inválido.');
  }
}

async function requireAdmin(request, env) {
  if (!(await verifySession(request, env))) return json({ ok: false, error: 'Não autorizado.' }, 401);
  return null;
}

async function withAdmin(request, env, handler) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  try {
    await assertSchema(env);
    return await handler();
  } catch (error) {
    console.error(JSON.stringify({ scope: 'admin_api', error: errorMessage(error) }));
    return json({ ok: false, error: errorMessage(error) }, 503);
  }
}

async function handleLogin(request, env) {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
    return json({ ok: false, error: 'ADMIN_PASSWORD e SESSION_SECRET precisam ser configurados.' }, 503);
  }
  let body;
  try {
    body = await readJson(request, 8 * 1024);
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 400);
  }
  if (!(await safeSecretEqual(body.password, env.ADMIN_PASSWORD))) {
    return json({ ok: false, error: 'Senha incorreta.' }, 401);
  }
  const token = await createSession(env);
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(request, token) });
}

async function dashboard(env) {
  const db = requireDb(env);
  const statements = [
    db.prepare(`SELECT COUNT(*) AS value FROM comments WHERE received_at >= datetime('now','-24 hours')`),
    db.prepare(`SELECT COUNT(*) AS value FROM automation_runs WHERE status='succeeded' AND created_at >= datetime('now','-24 hours')`),
    db.prepare(`SELECT COUNT(*) AS value FROM messages WHERE direction='inbound' AND created_at >= datetime('now','-24 hours')`),
    db.prepare(`SELECT COUNT(*) AS value FROM automations WHERE status='active'`),
    db.prepare(`SELECT COUNT(*) AS value FROM contacts`),
  ];
  const [comments, sent, replies, active, contacts] = await db.batch(statements);
  const automations = await listAutomations(env);
  const { results: recent } = await db
    .prepare(`SELECT r.id,r.status,r.reason,r.created_at,r.meta_message_id,
      a.name AS automation_name,a.id AS automation_id,
      c.text AS comment_text,c.username,c.contact_id,c.media_id
      FROM automation_runs r
      JOIN automations a ON a.id=r.automation_id
      JOIN comments c ON c.id=r.comment_id
      ORDER BY r.created_at DESC LIMIT 12`)
    .all();
  return {
    metrics: {
      comments24h: Number(comments?.results?.[0]?.value || 0),
      sent24h: Number(sent?.results?.[0]?.value || 0),
      replies24h: Number(replies?.results?.[0]?.value || 0),
      activeAutomations: Number(active?.results?.[0]?.value || 0),
      contacts: Number(contacts?.results?.[0]?.value || 0),
    },
    globalPaused: (await getSetting(env, 'global_paused', '0')) === '1',
    automations,
    recent: recent || [],
  };
}

async function listContacts(env, request) {
  const url = new URL(request.url);
  const q = String(url.searchParams.get('q') || '').trim();
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const statement = q
    ? requireDb(env).prepare(`SELECT * FROM contacts WHERE username LIKE ? OR id LIKE ? ORDER BY last_seen_at DESC LIMIT 200`).bind(like, like)
    : requireDb(env).prepare(`SELECT * FROM contacts ORDER BY last_seen_at DESC LIMIT 200`);
  const { results } = await statement.all();
  return results || [];
}

async function listActivity(env) {
  const { results } = await requireDb(env)
    .prepare(`SELECT r.id,r.status,r.reason,r.created_at,r.meta_message_id,
      a.name AS automation_name,c.text AS comment_text,c.username,c.contact_id,c.media_id
      FROM automation_runs r
      JOIN automations a ON a.id=r.automation_id
      JOIN comments c ON c.id=r.comment_id
      ORDER BY r.created_at DESC LIMIT 200`)
    .all();
  return results || [];
}

async function listInbox(env) {
  const { results } = await requireDb(env)
    .prepare(`SELECT c.*,
      (SELECT m.text FROM messages m WHERE m.contact_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
      (SELECT m.direction FROM messages m WHERE m.contact_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS last_direction,
      (SELECT m.created_at FROM messages m WHERE m.contact_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at
      FROM contacts c
      WHERE EXISTS (SELECT 1 FROM messages m WHERE m.contact_id=c.id)
      ORDER BY COALESCE(last_message_at,c.last_seen_at) DESC LIMIT 200`)
    .all();
  return results || [];
}

async function conversation(env, contactId) {
  const contact = await requireDb(env).prepare('SELECT * FROM contacts WHERE id=?').bind(contactId).first();
  if (!contact) return null;
  const { results } = await requireDb(env)
    .prepare(`SELECT id,direction,text,created_at,meta_message_id,automation_id FROM messages WHERE contact_id=? ORDER BY created_at ASC LIMIT 300`)
    .bind(contactId)
    .all();
  return { contact, messages: results || [] };
}

async function manualReply(env, contactId, text) {
  const messageText = String(text || '').trim().slice(0, 1000);
  if (!messageText) throw new Error('Digite a mensagem.');
  const contact = await requireDb(env).prepare('SELECT id,username FROM contacts WHERE id=?').bind(contactId).first();
  if (!contact) throw new Error('Contato não encontrado.');
  const result = await sendDirectMessage(env, contactId, messageText);
  if (!result.ok) throw new Error(result.error || `Meta retornou HTTP ${result.status}`);
  const id = `manual:${crypto.randomUUID()}`;
  await requireDb(env)
    .prepare(`INSERT INTO messages (id,contact_id,direction,text,meta_message_id) VALUES (?,?,'outbound',?,?)`)
    .bind(id, contactId, messageText, result.messageId)
    .run();
  await upsertContactFromMessage(env, contactId, contact.username, 'outbound');
  await writeAudit(env, 'manual_dm_sent', 'contact', contactId, { messageId: result.messageId });
  return { messageId: result.messageId };
}

export async function handleAdminApi(request, env, pathname) {
  if (pathname === '/api/session' && request.method === 'GET') {
    return json({ ok: true, authenticated: await verifySession(request, env) });
  }
  if (pathname === '/api/login' && request.method === 'POST') return handleLogin(request, env);
  if (pathname === '/api/logout' && request.method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(request, '', 0) });
  }

  return withAdmin(request, env, async () => {
    if (pathname === '/api/dashboard' && request.method === 'GET') return json({ ok: true, ...(await dashboard(env)) });
    if (pathname === '/api/automations' && request.method === 'GET') return json({ ok: true, automations: await listAutomations(env) });
    if (pathname === '/api/automations' && request.method === 'POST') {
      const automation = await createAutomation(env, await readJson(request));
      await writeAudit(env, 'automation_created', 'automation', automation.id, { name: automation.name });
      return json({ ok: true, automation }, 201);
    }

    const automationMatch = pathname.match(/^\/api\/automations\/([^/]+)$/);
    if (automationMatch && request.method === 'PUT') {
      const id = decodeURIComponent(automationMatch[1]);
      const automation = await updateAutomation(env, id, await readJson(request));
      await writeAudit(env, 'automation_updated', 'automation', id, { name: automation.name, status: automation.status });
      return json({ ok: true, automation });
    }
    if (automationMatch && request.method === 'DELETE') {
      const id = decodeURIComponent(automationMatch[1]);
      const deleted = await deleteAutomation(env, id);
      if (!deleted) return json({ ok: false, error: 'Automação não encontrada.' }, 404);
      await writeAudit(env, 'automation_deleted', 'automation', id);
      return json({ ok: true });
    }

    if (pathname === '/api/global-pause' && request.method === 'POST') {
      const body = await readJson(request, 8 * 1024);
      const paused = Boolean(body.paused);
      await setSetting(env, 'global_paused', paused ? '1' : '0');
      await writeAudit(env, paused ? 'global_pause_enabled' : 'global_pause_disabled');
      return json({ ok: true, paused });
    }

    if (pathname === '/api/contacts' && request.method === 'GET') return json({ ok: true, contacts: await listContacts(env, request) });
    if (pathname === '/api/activity' && request.method === 'GET') return json({ ok: true, activity: await listActivity(env) });
    if (pathname === '/api/inbox' && request.method === 'GET') return json({ ok: true, conversations: await listInbox(env) });

    const conversationMatch = pathname.match(/^\/api\/inbox\/([^/]+)$/);
    if (conversationMatch && request.method === 'GET') {
      const data = await conversation(env, decodeURIComponent(conversationMatch[1]));
      if (!data) return json({ ok: false, error: 'Contato não encontrado.' }, 404);
      return json({ ok: true, ...data });
    }
    const replyMatch = pathname.match(/^\/api\/inbox\/([^/]+)\/reply$/);
    if (replyMatch && request.method === 'POST') {
      const body = await readJson(request);
      return json({ ok: true, ...(await manualReply(env, decodeURIComponent(replyMatch[1]), body.text)) });
    }

    if (pathname === '/api/meta/status' && request.method === 'GET') return json({ ok: true, status: await getMetaStatus(env) });
    if (pathname === '/api/meta/sync' && request.method === 'POST') {
      const account = await syncInstagramAccount(env);
      await writeAudit(env, 'instagram_synced', 'instagram_account', account.id, { username: account.username });
      return json({ ok: true, account });
    }
    if (pathname === '/api/media' && request.method === 'GET') return json({ ok: true, media: await listInstagramMedia(env) });
    if (pathname === '/api/meta/poll-test' && request.method === 'GET') {
      const url = new URL(request.url);
      const mediaLimit = Math.max(1, Math.min(Number(url.searchParams.get('mediaLimit')) || 5, 10));
      const commentLimit = Math.max(1, Math.min(Number(url.searchParams.get('commentLimit')) || 25, 50));
      return json({ ok: true, ...(await testInstagramCommentPolling(env, mediaLimit, commentLimit)) });
    }
    if (pathname === '/api/simulate' && request.method === 'POST') return json({ ok: true, result: await simulateAutomationSelection(env, await readJson(request)) });
    if (pathname === '/api/webhook-info' && request.method === 'GET') {
      const origin = new URL(request.url).origin;
      return json({
        ok: true,
        webhookUrl: `${origin}/webhooks/instagram`,
        subscribedFields: ['comments', 'messages'],
        secrets: {
          verifyTokenConfigured: Boolean(env.META_VERIFY_TOKEN),
          appSecretConfigured: Boolean(env.META_APP_SECRET),
          accessTokenConfigured: Boolean(env.INSTAGRAM_ACCESS_TOKEN),
        },
        apiVersion: env.META_API_VERSION || 'v25.0',
      });
    }

    return json({ ok: false, error: 'Endpoint não encontrado.' }, 404);
  });
}
