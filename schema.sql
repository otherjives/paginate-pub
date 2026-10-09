-- paginate-pub control plane (paginate.dev Cloudflare account only)
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  title TEXT,
  visibility TEXT NOT NULL DEFAULT 'public',   -- 'public' | 'private'
  hash TEXT NOT NULL,                            -- sha256(html), first 16 hex chars
  url TEXT NOT NULL,
  size_bytes INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pages_slug ON pages(slug);
CREATE INDEX IF NOT EXISTS idx_pages_visibility ON pages(visibility);

CREATE TABLE IF NOT EXISTS groups_t (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  cf_group_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES groups_t(id),
  email TEXT NOT NULL,
  PRIMARY KEY (group_id, email)
);

CREATE TABLE IF NOT EXISTS assets_groups (
  slug TEXT NOT NULL,
  hash TEXT NOT NULL,
  group_id INTEGER NOT NULL REFERENCES groups_t(id),
  PRIMARY KEY (slug, hash, group_id)
);

CREATE TABLE IF NOT EXISTS users_t (
  email TEXT PRIMARY KEY,
  cf_user_id TEXT,
  seat TEXT,
  last_seen TEXT
);

CREATE TABLE IF NOT EXISTS subdomains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT UNIQUE NOT NULL,
  purpose TEXT,                                  -- 'asset' | 'group' | 'email'
  asset_slug TEXT,
  group_id INTEGER,
  cf_app_id TEXT,
  dns_ok INTEGER DEFAULT 0,
  ssl TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dbs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  owner_slug TEXT,
  visibility TEXT NOT NULL,
  cf_d1_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS db_bindings (
  slug TEXT NOT NULL,
  hash TEXT NOT NULL,
  db_id INTEGER NOT NULL REFERENCES dbs(id),
  PRIMARY KEY (slug, hash, db_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS ops_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op TEXT NOT NULL,
  detail TEXT,
  ok INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ops_log_at ON ops_log(at);
