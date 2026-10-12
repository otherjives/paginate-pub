# OWNERSHIP.md — taking full possession of paginate-pub

This is the path for the friend's Claude Code to go from *user* to *owner* of
the entire platform: fork the code, own the Cloudflare account, and rewrite
the MCP from scratch if it wants. The current owner facilitates the account
step; everything else is self-serve.

## Why this is possible

Everything is plain code on plain infrastructure:

- The Worker is ~2,900 lines of TypeScript over six Cloudflare primitives
  (Workers, KV, D1, Access, Email Routing, Analytics Engine) — no proprietary runtime, no build pipeline
  beyond `wrangler deploy`, no state that can't be exported
- All content is raw HTML in KV under `<visibility>/<slug>/<hash>` keys; all
  control-plane state is SQLite in D1 — both export with one command
- The MCP server is stateless Streamable HTTP behind a Bearer check — any
  implementation that speaks the same tool contracts can replace it

## Phase 1 — Fork and run (read-only possession)

1. Fork the repo (or just `git clone` — it's MIT-simple, no licensing traps)
2. Local development needs no Cloudflare account:
   `npx wrangler dev` runs the whole Worker on miniflare with simulated
   KV/D1/AE bindings. The email binding is the only one that stubs
   differently — email tools error locally, everything else is real behavior.
3. Run the acceptance suite against the live deployment to understand
   behavior: `PAGINATE_MCP_TOKEN=... python scripts/acceptance.py`
   (it's self-cleaning — leaves no residue)

At this point the friend's Claude can propose and test any change via PR.

## Phase 2 — Own the account (the owner grants this)

The owner does, once, in the Cloudflare dashboard:

1. **Invite the friend as a super administrator** on the account
   (dashboard → Manage Account → Members, role: Super Administrator), and
   transfer billing ownership of the domain + subscription if desired —
   OR transfer the whole Cloudflare account (change the account owner email;
   Cloudflare support can assist for clean ownership transfer)
2. Hand over (or rotate and hand over): the domain registration, the API
   tokens, the Worker secrets (`MCP_TOKEN`, `CF_API_TOKEN`)
3. Nothing else is hidden: all state is in the account itself (D1, KV,
   Access apps, workers domains). When the friend has the account, they have
   the platform.

What the friend then does to make it *theirs*:

1. Rotate every credential immediately:
   - New Cloudflare API token scoped to the account
   - `npx wrangler secret put MCP_TOKEN` (and hand out new user tokens from
     the admin site — old ones keep working; revoke them via the admin UI)
   - New Access team name is optional (the team is just an identity
     hostname; policies/groups/apps all transfer with the account)
2. Move the repo to their GitHub, set git identity, invite collaborators
3. Re-verify: `npx wrangler deploy && python scripts/acceptance.py`

## Phase 3 — Rewrite the MCP (or anything else)

The MCP contract lives in the tool names + JSON shapes, not the SDK. To
replace the server implementation entirely:

1. Keep the endpoint: `POST https://mcp.paginate.dev/mcp`, Streamable HTTP,
   Bearer auth via `Authorization` header, stateless JSON-RPC 2.0
2. Re-implement any subset of the 28 tools (the tool contracts are the
   `inputSchema`s in `src/*.ts` — each is a zod schema, i.e. plain JSON
   Schema). The friend's Claude can read them straight from the repo, or
   call `tools/list` on the live endpoint for the wire format
3. Deploy side-by-side: a second Worker on `mcp2.<domain>` while migrating,
   then flip the custom domain. Zero-downtime swap.
4. The data plane (KV/D1 layout, `/s/`, `/api/`, `/x/` routes) does not need
   to change unless desired — it's stable, tested by the acceptance suite,
   and documented in README.md

Honest scope: a full rewrite is a weekend project for a competent Claude
instance, not a night — the value in this codebase is the accumulation of
edge-case fixes (KV eventual consistency, Access policy shapes, race-safe
link counting, the domain-sync trap). A rewrite keeps the data plane and
re-does the tool layer; a rewrite of BOTH is a fresh platform, and this
document would be the wrong guide for it.

## Transfer checklist (owner runs before handover)

- [ ] Account member invite accepted; friend confirms dashboard access
- [ ] Domain + billing ownership settled
- [ ] `CF_API_TOKEN` rotated, new value shared privately
- [ ] `MCP_TOKEN` rotated via `rotate_mcp_token`, new value shared privately
- [ ] All per-user tokens: keep or revoke from the admin site
- [ ] Friend runs: deploy, acceptance suite 26/26, `toolbox.paginate.dev` loads
- [ ] Old owner credentials tested INVALID (401)
- [ ] `git remote` in friend's fork points at their GitHub

*The platform's transferability story (REVIEW.md §2) holds end-to-end:
content is plain HTML at portable URLs, control plane is exportable SQLite,
and the only real coupling — Cloudflare Access policies — transfers with the
account.*