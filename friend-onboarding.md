# paginate-pub — Claude Code onboarding

You (Claude) have access to the **paginate-pub** MCP server. It publishes web
pages to paginate.dev. Everything below is what you need — call
`get_asset` on any page mentioned here to study working examples.

## The 30-second version

The human asks for a page/site/demo. You write self-contained HTML and call
`publish_page`. You get two URLs:

- **`url`** — permanent, content-addressed (`/s/<slug>/<hash>/`), immutable
- **`latest_url`** — always the current version (`/s/<slug>/`)

**Always share `latest_url`.** Republishing with the same slug updates it;
old links never break.

## Publishing

```
publish_page(html, title?, slug?, visibility="public"|"private",
             files?, template?)
```

- Self-contained HTML preferred: inline CSS/JS, no external CDNs (CSP blocks
  external origins). Web fonts/images: use data URIs or publish them via
  `files`.
- `files: {"style.css": "...", "app.js": "..."}` — side files; the page
  references them RELATIVELY (`<link href="style.css">`) and they resolve
  under the version hash automatically.
- `template` presets:
  - `"slides"` — injects a 5s auto-refresh shim: viewers on the latest URL
    see the presenter's next publish within 5 seconds
  - `"game"` / `"board"` / `"app"` — injects `window.pp.api()` (same-origin
    JSON client); game/board presets also ship an `api-notes.md` with the
    API contract

## Data-backed pages

Every published page has a same-origin JSON API backed by D1:

```
GET    /api/<slug>          list records (newest first, ?limit= up to 500)
GET    /api/<slug>/<id>     one record
GET    /api/<slug>/_count   {"count": N}
POST   /api/<slug>          create (16 KB max) -> {id}
PUT    /api/<slug>/<id>     replace
DELETE /api/<slug>/<id>     remove
```

Records are arbitrary JSON. Writes: 60 per 5 min per IP (rate-limited, 429
with a hint). Use `window.pp.api(path, opts)` in game/board/app pages.
Examples to study: `get_asset("paginate-game")` (leaderboard),
`get_asset("paginate-board")` (kanban with 5s polling sync).

## Private pages, groups, and share links

- `visibility: "private"` → the page moves to `private.paginate.dev/s/<slug>/`,
  behind Cloudflare Access.
- `create_group` + `grant_access(slug, group, emails)` → those emails sign in
  with a one-time PIN; everything else is gated.
- **`create_share_link(slug, {hours, max_uses, note})`** — the friendly way to
  share a private page: a long unguessable link
  (`private.paginate.dev/x/<token>/`) that anyone can open, no login. Default
  48h expiry. `max_uses: 1` = one-time. Show the link once, tell the human to
  copy it. `list_share_links` + `revoke_share_link` manage them. A leaked
  link = access until it expires or is revoked — say this out loud when
  sharing sensitive content.

## Sites on their own subdomain

`provision_subdomain(name, {security, owner_email?, asset_slug?})` →
`<name>.paginate.dev`:

- `security: "open"` — anyone with the URL (default)
- `security: "access"` — owner signs in via email one-time PIN
  (`owner_email`); share links still work through the `/x/` bypass
- `security: "private"` — group-only

With `asset_slug`, the host's root `/` serves that page's latest version
(e.g. `toolbox.paginate.dev` → the electrical toolbox).

## What you can't do (and what to say)

- Email to anyone who hasn't verified their address — the tool refuses with
  the exact next step; relay it, don't work around it.
- Anything needing the owner's Cloudflare account (DNS changes, secret
  rotation, DB provisioning, token rotation) — those tools refuse your
  user token. Tell the human which dashboard action is needed, or have them
  run it from an owner session.
- Real-time collaboration features (WebSockets, push) — not built. The
  slides preset's 5-second refresh is the current "live" story.

## Browser vs terminal

The setup command in TESTING.md is for Claude Code (terminal/desktop). If you
only have claude.ai in a browser, the admin site also shows a connector URL
(`https://mcp.paginate.dev/mcp?tk=<token>`) for Settings → Connectors → Add
custom connector. Same token, same user role — but it rides in the URL, so
treat it like a password: revoke and re-issue if it leaks. Browser support is
experimental: verify it on your account before relying on it.

## House rules

- Verify before claiming: after publishing, fetch the URL and check the
  body (the platform serves exactly what was stored).
- `get_status` shows spend, seats, and usage vs free limits — mention costs
  only if something is near a limit (it's $0/mo by design).
- `audit_leaks` checks platform hygiene; run it if anything about visibility
  seems off.
- Slugs are forever-URLs: pick descriptive ones (`electrical-toolbox`, not
  `page-2`). Don't rename unprompted.