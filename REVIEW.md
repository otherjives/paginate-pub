# Project Review — paginate-pub

**Reviewed:** 2026-10-11 · state: 26/26 acceptance checks green, deployed to
paginate.dev (its own Cloudflare account, isolated from all other accounts).

---

## 1. How well does it handle different types of small projects?

### Fits well (the design center)

| Project type | Fit | Why |
|---|---|---|
| **Static HTML demos / landing pages / one-page apps** | Excellent | The core loop. Content-addressed immutable URLs, browser + edge cache do all the work. Zero marginal cost. |
| **Interactive toys with inline JS (canvas, p5, three.js via CDN? no — CSP)** | Good | CSP allows `'unsafe-inline'` scripts from self, blocks external script origins. Self-contained pages shine; external-CDN pages need a CSP tweak per asset (see §3 Security). |
| **Documentation / reference sites** | Good | Many slugs, content-addressed = permanent links. `list_assets` is a poor-man's index (a `list` page tool would fix the "index page" need). |
| **Small portfolio / gallery** | Good | Same as demos. Images work (CSP allows `img-src 'self' data: blob:`); inline images (data URIs) are the easiest path. |
| **Private internal tools (admin panels, dashboards)** | Good (with care) | Access-gated host + per-user tokens is a solid base. But see "state" caveat below — these tend to need a backend/data layer. |

### Fits with limitations

| Project type | Limitation |
|---|---|
| **Forms / contact pages** | No server-side submission handler yet. `send_email` is MCP-side (Claude calls it), not a public POST endpoint. Adding a `POST /api/submit` route + rate limit + Turnstile is a Phase H-sized task. |
| **Small DB-backed apps (comments, likes, counters)** | `create_db` provisions D1 and enforces visibility tagging, but there is **no public read/write API surface for page JS yet** — a page cannot currently call its own DB from the browser. Needed: a `/api/db/:slug` worker route with strict schema + rate limits. Until then, "DB" is bookkeeping only. |
| **Multi-page sites with navigation** | Works (slug per page) but there's no linking convention or shared headers/footers — Claude must be told to build them self-contained per page. A "site" concept (shared template + multiple slugs) is a natural v2. |

### Does NOT fit (today)

| Project type | Why not |
|---|---|
| **Anything with server-side sessions / user auth of its own** | The platform has no per-page compute. The CSP blocks external origins; there is no place to run page-specific server code. Workers do support it, but not via this Worker as built. |
| **Highly dynamic / realtime (chat, collab)** | No WebSockets per-page, no per-page state. Needs a different architecture (Durable Objects), out of scope. |
| **Big media hosting** | KV 25 MB value limit; 1 GB free tier. Fine for demo HTML; not for video/CDN-scale assets. |

---

## 2. Transferability — how easy is it to move a project elsewhere?

**This is a genuine strength.** Deliberate design choices make exit easy:

1. **Every asset is raw HTML at a stable URL.** No build step, no framework
   runtime, no proprietary markup. `wrangler kv key get` (or the `get_asset`
   MCP tool) yields the exact bytes. Any static host (S3+CloudFront, GitHub
   Pages, Netlify, nginx) serves them as-is.
2. **No URL-embedded platform concepts.** Paths are `/s/<slug>/<hash>/` —
   dumb and portable. A 302/redirect file (or a small shim) reproduces the
   URL space anywhere.
3. **The control plane is plain SQL.** `wrangler d1 export` gives you pages,
   groups, tokens, subdomains, ops_log — a full machine-readable inventory
   for reconstructing elsewhere.
4. **Access control is optional and external.** Public pages have zero
   platform lock-in. Private pages depend on Cloudflare Access — the only
   real coupling — and moving them means either (a) basic-auth on the new
   host, (b) keeping Cloudflare (free tier) in front as a proxy, or
   (c) re-implementing auth. The *content* still transfers untouched.
5. **Email is the only soft spot** — DNS MX/SPF records point at Cloudflare
   Email Routing. Moving email providers is a DNS change, standard stuff.

**Verdict:** a public project moves in an afternoon (fetch HTML → drop on new
host → fix DNS). A private project moves in a day (add auth layer). Nothing
in the architecture fights you.

---

## 3. Security review

### Strong (as-built)

- **Two independent auth domains, never mixed:** the MCP endpoint (Bearer
  tokens: one owner secret + per-user hashed tokens) and the admin site
  (Cloudflare Access JWT, verified against team domain + AUD with real public-key
  signature verification — not just presence of the header).
- **Tokens are hashed at rest** (`sha256(token)` in `mcp_tokens`), shown once at
  issue, revocable, with `last_used_at` tracking. The owner secret lives only
  as a Worker secret — never in D1, never echoed by any tool (verified by the
  acceptance suite: "no secret values leaked").
- **Role gating:** `set_dns`, `set_worker_secret`, `rotate_mcp_token`,
  `create_db` refuse per-user tokens. A leaked user token cannot escalate.
- **Defense in depth on private assets:** Access app in front of the host AND
  the Worker only serves from the `private/` prefix. `audit_leaks` catches
  misconfigurations (anyone-on-private, dual-prefix copies, DB visibility
  mismatches).
- **No server-side execution of friend content.** Published HTML runs in the
  visitor's browser with a restrictive CSP, `X-Content-Type-Options`, and
  `frame-ancestors 'none'`. No cookies/sessions exist on the origin.
- **No secrets in the repo** (verified before the initial push; `.gitignore`
  blocks `.dev.vars`).
- **Every mutation is logged** (`ops_log`) — a real audit trail surfaced by a
  tool.

### Weak points / risks (honest list)

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| W1 | **Per-user tokens never expire.** Revocable but live forever until revoked. | Medium | Add `expires_at` to `mcp_tokens` (e.g. 90d) + check in `bearerRole`. |
| W2 | **Access JWT verification does not check `iss`** (team domain), only `aud`. | Low | Add `payload.iss === team domain` check in `verifyAccessJwt`. |
| W3 | **`grant_access` creates per-slug Access apps on the SAME host** (`private.<domain>`) — an app per slug on one hostname. Cloudflare allows one app per domain per type; the code adopts an existing app on conflict, so multiple slugs SHARE one app. This means: granting slug A to group X also exposes slug B to group X *if they share the host*. | **High** | Use path-scoped apps (`domain: private.<domain>/s/<slug>`) — Cloudflare Access supports path-scoped self-hosted apps. This is the most important fix in this review. |
| W4 | **No rate limit on the admin site** (only MCP has one). | Low | The site is Access-gated to a handful of people; still, a trivial per-IP bucket would be consistent. |
| W5 | **MCP endpoint has no audit of per-token tool calls** (`ops_log` records events but not which token made them). | Low | Thread `role`/token id into `logOp` detail. |
| W6 | **KV is the only content store** — eventual consistency already bit us twice (fixed with retries). | Accepted | Documented; retries in place; R2 remains the better store if it's ever enabled on the account. |
| W7 | `/s/` misses return 404 (was 200 landing) — fixed 2026-10-11. | Fixed | Done. |
| W8 | **`audit_leaks` anyone-check is naive** (looks for `email: "*"` / `anyone: true` / `everyone: true` — not all CF "everyone" shapes). | Low | Compare against real policy shapes from the API once one exists in the account. |

**Overall security verdict:** solid for the threat model (friend + a few
collaborators + the public internet). W3 is the one real issue to fix before
sharing private pages between different groups on the same host.

---

## 4. Cleanliness / maintainability review

### Good

- **Small, single-purpose modules** with clear seams:
  `cf.ts` (all Cloudflare API I/O), `util.ts` (pure helpers),
  `static.ts` (serving), `mcp.ts` (tool registration), `access.ts` /
  `email.ts` / `subdomain.ts` / `status.ts` / `admin.ts` (domains),
  `adminsite.ts` (UI). A new contributor can find things.
- **One consistent pattern everywhere:** every tool validates → does work →
  `logOp` → `jsonText`/`errText`. Every CF mutation goes through `CfClient`.
  Errors are strings with codes, not swallowed.
- **The acceptance suite is the real documentation** of behavior — 26 checks
  covering publishing, privacy, groups, status, audit, email guard, secrets.
  It runs against production, so it's never stale.
- **Schema is honest** — `ops_log`, `settings`, `mcp_tokens` give you
  operational introspection, not just app state.

### Debt (tracked, not urgent)

| Item | Note |
|---|---|
| No unit tests (only the live acceptance suite) | Fine at this size; `slugify`/`sha256Hex`/`assetKey` are the pure functions worth covering if the team grows. |
| `mcp.ts` is the largest file and `set_visibility` carries scar tissue (retry + cross-prefix recovery) | Extract the move into `visibility.ts` when next touched. |
| No CI | A GitHub Action running `tsc --noEmit` + the typecheck would be cheap and worthwhile; the acceptance suite needs live secrets, so CI should be typecheck-only. |
| `strict: false` in tsconfig | Deliberate (workers-types churn); revisit after upgrading `@cloudflare/workers-types` cleanly. |
| Two stray commits' worth of legacy KV keys (`private/pub-test/*`) | Harmless; clean with one `wrangler kv key delete` each. |

### Documentation

`README.md` (deploy/secrets/layout) and `friend-onboarding.md` (user-facing)
are current. This review is `REVIEW.md`.

---

## 5. Priority fixes (ranked)

1. **W3 — path-scoped Access apps** (private-sharing correctness). *
2. **W1 — token expiry** (security hygiene). *
3. **W2 — JWT `iss` check** (one line). *
4. CI: typecheck action (cheap, keeps collaborators honest).
5. Public DB API surface (`/api/db/:slug`) if data-backed demos are wanted. *
6. Public form-submission endpoint (with Turnstile) if forms are wanted.

\* small, well-scoped; can be done in one sitting.