const BOOTSTRAP_SQL = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
INSERT OR IGNORE INTO app_settings (key,value) VALUES ('global_paused','0');
CREATE TABLE IF NOT EXISTS instagram_account (id TEXT PRIMARY KEY,username TEXT,account_type TEXT,synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'paused' CHECK (status IN ('active','paused')),trigger_type TEXT NOT NULL DEFAULT 'any_comment' CHECK (trigger_type IN ('any_comment','keyword')),media_scope TEXT NOT NULL DEFAULT 'all' CHECK (media_scope IN ('all','specific')),media_id TEXT,media_label TEXT,keyword TEXT,reply_text TEXT NOT NULL,once_per_contact INTEGER NOT NULL DEFAULT 1 CHECK (once_per_contact IN (0,1)),cooldown_minutes INTEGER NOT NULL DEFAULT 0 CHECK (cooldown_minutes >= 0),priority INTEGER NOT NULL DEFAULT 100,start_at TEXT,end_at TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_automations_status_priority ON automations(status,priority DESC,created_at ASC);
CREATE INDEX IF NOT EXISTS idx_automations_media_id ON automations(media_id);
CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY,username TEXT,display_name TEXT,first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,first_source TEXT,last_source TEXT,comments_count INTEGER NOT NULL DEFAULT 0,inbound_messages_count INTEGER NOT NULL DEFAULT 0,outbound_messages_count INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_contacts_last_seen ON contacts(last_seen_at DESC);
CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY,contact_id TEXT,username TEXT,media_id TEXT,text TEXT,created_at TEXT,received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE SET NULL);
CREATE INDEX IF NOT EXISTS idx_comments_received ON comments(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_media ON comments(media_id);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY,contact_id TEXT NOT NULL,direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),text TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,source TEXT NOT NULL DEFAULT 'instagram',meta_message_id TEXT,automation_id TEXT,FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE,FOREIGN KEY(automation_id) REFERENCES automations(id) ON DELETE SET NULL);
CREATE INDEX IF NOT EXISTS idx_messages_contact_created ON messages(contact_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
CREATE TABLE IF NOT EXISTS webhook_events (id TEXT PRIMARY KEY,object_type TEXT,received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,processed_at TEXT,status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processed','ignored','failed')),error TEXT);
CREATE INDEX IF NOT EXISTS idx_webhook_events_received ON webhook_events(received_at DESC);
CREATE TABLE IF NOT EXISTS automation_runs (id TEXT PRIMARY KEY,automation_id TEXT NOT NULL,comment_id TEXT NOT NULL,contact_id TEXT,status TEXT NOT NULL CHECK (status IN ('claimed','succeeded','failed','rate_limited','uncertain','skipped')),reason TEXT,meta_message_id TEXT,meta_response TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(automation_id) REFERENCES automations(id) ON DELETE CASCADE,FOREIGN KEY(comment_id) REFERENCES comments(id) ON DELETE CASCADE,FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE SET NULL,UNIQUE(automation_id,comment_id));
CREATE INDEX IF NOT EXISTS idx_runs_automation_created ON automation_runs(automation_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_contact_created ON automation_runs(contact_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status_created ON automation_runs(status,created_at DESC);
CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY,action TEXT NOT NULL,entity_type TEXT,entity_id TEXT,details TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
`;

export function requireDb(env) {
  if (!env.DB) throw new Error('Binding D1 DB não configurado.');
  return env.DB;
}

export async function assertSchema(env) {
  const db = requireDb(env);
  try {
    await db.prepare('SELECT value FROM app_settings WHERE key = ?').bind('global_paused').first();
  } catch {
    await db.exec(BOOTSTRAP_SQL);
  }
}

export async function getSetting(env, key, fallback = null) {
  const row = await requireDb(env).prepare('SELECT value FROM app_settings WHERE key = ?').bind(key).first();
  return row?.value ?? fallback;
}

export async function setSetting(env, key, value) {
  await requireDb(env)
    .prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
    .bind(key, String(value))
    .run();
}

export async function writeAudit(env, action, entityType = null, entityId = null, details = null) {
  await requireDb(env)
    .prepare('INSERT INTO audit_log (id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), action, entityType, entityId, details ? JSON.stringify(details) : null)
    .run();
}

export async function getInstagramAccount(env) {
  return requireDb(env).prepare('SELECT id, username, account_type, synced_at FROM instagram_account ORDER BY synced_at DESC LIMIT 1').first();
}

export async function saveInstagramAccount(env, account) {
  const db = requireDb(env);
  await db.prepare('DELETE FROM instagram_account').run();
  await db
    .prepare('INSERT INTO instagram_account (id, username, account_type, synced_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)')
    .bind(account.id, account.username ?? null, account.account_type ?? null)
    .run();
  return getInstagramAccount(env);
}

export async function upsertContactFromComment(env, comment) {
  if (!comment.contactId) return;
  await requireDb(env)
    .prepare(`INSERT INTO contacts (id, username, first_source, last_source, comments_count)
              VALUES (?, ?, 'comment', 'comment', 1)
              ON CONFLICT(id) DO UPDATE SET
                username = COALESCE(excluded.username, contacts.username),
                last_seen_at = CURRENT_TIMESTAMP,
                last_source = 'comment',
                comments_count = contacts.comments_count + 1`)
    .bind(comment.contactId, comment.username ?? null)
    .run();
}

export async function upsertContactFromMessage(env, contactId, username = null, direction = 'inbound') {
  const inbound = direction === 'inbound' ? 1 : 0;
  const outbound = direction === 'outbound' ? 1 : 0;
  await requireDb(env)
    .prepare(`INSERT INTO contacts (id, username, first_source, last_source, inbound_messages_count, outbound_messages_count)
              VALUES (?, ?, 'message', 'message', ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                username = COALESCE(excluded.username, contacts.username),
                last_seen_at = CURRENT_TIMESTAMP,
                last_source = 'message',
                inbound_messages_count = contacts.inbound_messages_count + ?,
                outbound_messages_count = contacts.outbound_messages_count + ?`)
    .bind(contactId, username, inbound, outbound, inbound, outbound)
    .run();
}
