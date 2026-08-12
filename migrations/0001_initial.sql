PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO app_settings (key, value) VALUES ('global_paused', '0');

CREATE TABLE IF NOT EXISTS instagram_account (
  id TEXT PRIMARY KEY,
  username TEXT,
  account_type TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'paused' CHECK (status IN ('active','paused')),
  trigger_type TEXT NOT NULL DEFAULT 'any_comment' CHECK (trigger_type IN ('any_comment','keyword')),
  media_scope TEXT NOT NULL DEFAULT 'all' CHECK (media_scope IN ('all','specific')),
  media_id TEXT,
  media_label TEXT,
  keyword TEXT,
  reply_text TEXT NOT NULL,
  once_per_contact INTEGER NOT NULL DEFAULT 1 CHECK (once_per_contact IN (0,1)),
  cooldown_minutes INTEGER NOT NULL DEFAULT 0 CHECK (cooldown_minutes >= 0),
  priority INTEGER NOT NULL DEFAULT 100,
  start_at TEXT,
  end_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_automations_status_priority ON automations(status, priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_automations_media_id ON automations(media_id);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  username TEXT,
  display_name TEXT,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  first_source TEXT,
  last_source TEXT,
  comments_count INTEGER NOT NULL DEFAULT 0,
  inbound_messages_count INTEGER NOT NULL DEFAULT 0,
  outbound_messages_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_contacts_last_seen ON contacts(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  contact_id TEXT,
  username TEXT,
  media_id TEXT,
  text TEXT,
  created_at TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_received ON comments(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_media ON comments(media_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  text TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source TEXT NOT NULL DEFAULT 'instagram',
  meta_message_id TEXT,
  automation_id TEXT,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_contact_created ON messages(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  object_type TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processed','ignored','failed')),
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_received ON webhook_events(received_at DESC);

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  contact_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('claimed','succeeded','failed','rate_limited','uncertain','skipped')),
  reason TEXT,
  meta_message_id TEXT,
  meta_response TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE,
  FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
  UNIQUE (automation_id, comment_id)
);

CREATE INDEX IF NOT EXISTS idx_runs_automation_created ON automation_runs(automation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_contact_created ON automation_runs(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status_created ON automation_runs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
