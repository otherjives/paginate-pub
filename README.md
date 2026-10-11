# paginate-pub

A no-GUI Cloudflare publishing platform. A friend asks their AI (Claude Code
with the paginate-pub MCP server) to "publish this page" — and it's live on
the web. Everything runs on the free tier: **$0/mo + the domain**.

## Architecture

One Cloudflare Worker (`paginate-pub`), one KV namespace (content), one D1
database (control plane + per-page data), Analytics Engine (hit stats),
Email Service (verified-destination outbound). No build step, no GUI needed.

| Host | Purpose |
|---|---|
| `pub.paginate.dev` | public pages (`/s/<slug>/...`) + per-page JSON API (`/api/<slug>`) |
| `private.paginate.dev` | private pages behind Cloudflare Access; capability share links (`/x/<token>/`) |
| `mcp.paginate.dev/mcp` | the MCP endpoint (Bearer token: owner secret or per-user token) |
| `admin.paginate.dev` | Access-gated admin site: issue per-user Claude Code tokens |
| `<site>.paginate.dev` | vanity subdomains (e.g. `toolbox.paginate.dev`), per-site security mode |

**Custom domains attach via API** (`PUT /accounts/{id}/workers/domains`) —
`wrangler.toml` has no `[[routes]]` because every deploy reconciles routes to
the config and would silently delete API-attached domains.

## The MCP server

Stateless, Streamable HTTP, Bearer-authed. Two roles:
- **owner** (the account owner's secret): everything
- **user** (admin-site-issued token): everything except owner-only tools
  (`set_dns`, `set_worker_secret`, `rotate_mcp_token`, `create_db`)

Tool groups (28 tools):
- **Publishing**: `publish_page` (multi-file, template presets: slides/game/
  board/app), `list_assets`, `get_asset`, `delete_page`, `set_visibility`
- **Latest URLs**: every page has a stable `/s/<slug>/` URL that 302s to the
  current version — share once, edit forever
- **Per-page data API**: `/api/<slug>` JSON CRUD on D1 (16 KB records, 60
  writes/5 min per IP, visibility walls, self-explaining errors)
- **Share links**: `create_share_link` / `list_share_links` /
  `revoke_share_link` — capability URLs for private pages, hashed at rest,
  expiring, optional one-time (`max_uses: 1`), race-safe use counting
- **Subdomains**: `provision_subdomain` with `security: open | access |
  private` (password mode planned); `launch_group` one-shot
- **Access**: `create_group`, `grant_access`, `revoke_access`, `list_users` —
  path-scoped Access apps per private page
- **Email**: `send_email` (verified destinations only), address/route tools
- **Status**: `get_status` (spend, seats, usage), `audit_leaks`, `fix_leak`,
  `get_ops_log`; cost-watching cron every 6h

## Repo layout

```
src/
  index.ts        host routing: mcp / admin / share links / api / assets
  mcp.ts          core publishing tools + tool registration
  static.ts       KV asset serving, immutable caching, MIME, CSP
  api.ts          per-page JSON API (D1-backed)
  share.ts        capability share links
  subdomain.ts    vanity subdomains + launch_group
  access.ts       Cloudflare Access management (groups, path-scoped apps)
  adminsite.ts    Access-gated admin site (issue/revoke user tokens)
  email.ts        Email Service tools (verified-destination policy)
  status.ts       cost/usage status + leak audit
  admin.ts        owner-only tools (DNS, secrets, token rotation, ops log)
  cf.ts           typed Cloudflare API v4 client
  util.ts         slugify, hashing, KV keys, bearer auth (roles)
schema.sql        idempotent D1 schema (all tables)
scripts/
  acceptance.py   26-check acceptance suite against the live platform
  mcp_probe.py    minimal MCP client (sandbox edge-IP workaround)
```

## Deploy / operate

```bash
export CLOUDFLARE_API_TOKEN=...   # account-scoped token
npx wrangler d1 execute paginatepub --remote --file=schema.sql   # idempotent
npx wrangler deploy
```

Secrets: `MCP_TOKEN` (owner secret), `CF_API_TOKEN` (API token) —
`npx wrangler secret put <NAME>`. Both live only as Worker secrets; the owner
secret is also in a local password manager, nowhere in the repo.

MCP setup for a user (the admin site generates this command):

```
claude mcp add --transport http paginate-pub https://mcp.paginate.dev/mcp \
  --header "Authorization: Bearer <token>"
```

## Testing

`scripts/acceptance.py` — 26 checks against the live platform (publish,
privacy, groups, visibility moves, status, leak audit, email guard, secrets,
db). Uses slugs prefixed `acceptance-`; safe to re-run. Ad-hoc verification
scripts live in Temp during development and are not part of the repo.

## Known limits / deliberate decisions

- KV is the content store (1 GB, 1k writes/day free): eventual consistency is
  retried in code; R2 would be better if the account ever enables it
  (API-blocked: error 10042, dashboard-only)
- Outbound email only to verified destination addresses (free tier rule);
  arbitrary recipients need Workers Paid $5/mo — the tool refuses and says so
- Workers custom domains don't support wildcards — each vanity host is one
  DNS record + domain mapping (provisioned by the tool, ~1 min)
- Published pages run with a strict CSP (no external origins); side files
  publish under the version hash so relative paths "just work"
- The acceptance suite keeps its own fixtures (slugs `acceptance-*` and
  Access app on `private.paginate.dev/s/acceptance-secret`) — do not delete

## Security notes

- Owner secret and per-user tokens are SHA-256-hashed in D1 (`mcp_tokens`),
  shown once, 90-day expiry, revocable; owner-only tools are role-gated
- Share-link tokens are 32-byte random, SHA-256 at rest, use-counted before
  serving (one-time links are race-safe), served `no-store`
- Unregistered hosts fail closed; dead share links return an opaque 404
- The admin site verifies the Access JWT in-Worker (signature + iss + aud +
  exp) before anything renders
- No secrets in the repo; `.dev.vars` and `dryrun/` are gitignored