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


CREATE TABLE IF NOT EXISTS subdomains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT UNIQUE NOT NULL,
  purpose TEXT,                                  -- 'asset' | 'group' | 'email'
  asset_slug TEXT,
  group_id INTEGER,
  cf_app_id TEXT,
  dns_ok INTEGER DEFAULT 0,
  ssl TEXT,
  security TEXT NOT NULL DEFAULT 'private',      -- 'open' | 'access' | 'private' (later: 'password')
  owner_email TEXT,                               -- who the site belongs to (Access policy target)
  visibility TEXT NOT NULL DEFAULT 'private',    -- 'public' | 'private' (routing)
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

CREATE TABLE IF NOT EXISTS mcp_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  name TEXT,
  token_hash TEXT NOT NULL,          -- sha256 hex of the token; token shown once at issue
  role TEXT NOT NULL DEFAULT 'user', -- 'user' (admin-site issued) | 'admin' reserved
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT                      -- ISO date; user tokens expire (W1 fix)
);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_hash ON mcp_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_email ON mcp_tokens(email);


-- per-page public data API (Phase H): one JSON record store for all slugs.
-- A record is a JSON object the page owns; the platform enforces slug
-- existence + visibility match + size + rate limits (see src/api.ts).
CREATE TABLE IF NOT EXISTS page_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_page_data_slug ON page_data(slug, id);

-- per-slug+IP write rate limiting (60 writes / 5-min window). Rows are keyed
-- by window number; old windows are pruned lazily by the API handler.
CREATE TABLE IF NOT EXISTS rate_limit (
  k TEXT NOT NULL,
  window INTEGER NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (k, window)
);

-- capability share links (Phase H2): long random tokens that grant access to
-- one private slug. Token is stored SHA-256 hashed (shown once at creation),
-- optional expiry + max uses, revocable. Served from private.<domain>/x/<token>/.
CREATE TABLE IF NOT EXISTS share_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT,                    -- ISO date; NULL = never expires
  max_uses INTEGER,                   -- NULL = unlimited
  uses INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_share_links_slug ON share_links(slug);
CREATE INDEX IF NOT EXISTS idx_share_links_hash ON share_links(token_hash);
