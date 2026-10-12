# FUTURE.md — deferred design decisions (the project's only tracker)

Deliberate parking lot for things we chose NOT to build yet. Each entry says
what it is, why it was deferred, and what would trigger building it. Nothing
here is dead weight — these are recorded so a new owner can decide knowingly.

## 1. "Door-open" extension mechanisms — DEFERRED 2026-10-10 by owner decision

Design (agreed, never implemented): make the platform explain itself and
escalate gracefully to any AI that connects:

- `get_playbook` — serve the friend-onboarding manual as an MCP tool, so an
  agent can self-onboard by calling one tool
- `get_capabilities` — machine-readable feature/cost matrix (free limits,
  what's possible, what needs upgrades)
- Cost-ladder refusals — tools that hit a paid wall refuse with the exact
  price and the next step ("Workers Paid $5/mo unlocks this"), not a bare error
- Owner-consent switches — D1 `settings` rows like `allow_workers_paid=false`
  that tools check before offering paid actions
- `EXTENDING.md` — contributor guide in the repo
- `propose_feature` — optional tool that logs structured feature requests
  into ops_log for the owner

Why deferred: Phase H (latest URLs, per-page API, templates) was ranked more
valuable first; the user chose "most helpful list first, then circle back."
Trigger: handover complete + real usage feedback. Implementation is
self-contained — none of it blocks anything else.

## 2. Password security mode for vanity subdomains — DEFERRED

`security: "password"` is reserved in the enum and documented as planned.
Design: in-Worker HTTP Basic auth over the vanity host with a per-site
password (D1 `settings`-style storage), for sites too casual for email OTP
but too shared for a single owner email. Trigger: a friend actually asks for
"just a password on this page."

## 3. True-live presentation mode (Durable Objects + WebSockets) — DEFERRED

The slides template's 5s auto-refresh shim is the current "live" story.
Real-time would need a DO + WebSocket per deck. Deferred because DO free-tier
numbers were never verified (dashboard-gated docs) and the shim is good
enough for demos. Trigger: someone presents to a live audience and the 5s lag
matters. Verify DO limits BEFORE building (see niagara-style lesson:
verify entitlements first).

## 4. Turnstile on public per-page APIs — DEFERRED (hardening)

`/api/<slug>` is rate-limited (60 writes/5min/IP) but not bot-checked, so a
determined client can seed a leaderboard. Accepted tradeoff for demo-grade
games/boards; the api-notes.md shipped with templates says scores are
client-side and cheatable. Trigger: someone runs a real contest with prizes.

## 5. R2 as content store — BLOCKED (dashboard-only, error 10042)

KV's 1k writes/day is the tightest free limit. R2 would lift it, but the
enable is dashboard-only — the owner must click it. Not a code decision;
revisit when write volume actually hurts.

## 6. claude.ai browser connector (?tk= URLs) — EXPERIMENTAL, UNVERIFIED

Implemented and token-flow-verified server-side, but whether claude.ai's
custom-connector UI accepts query-param URLs has never been tested by a
human. TESTING.md asks the test friend to report. Trigger: that report.

## 7. Owner-consent "blanket Access app" + Email Routing — USER DASHBOARD ONE-TIMES

Two dashboard actions that remain owner-only by platform design:
- Enable Email Routing on paginate.dev (arbitrary-recipient email would then
  need Workers Paid anyway — verify before promising anything)
- Nothing else currently; the blanket private-host Access app was created
  via API as `paginate-pub private host`

## 8. CI typecheck action — DEFERRED (REVIEW §5 #1)

A GitHub Actions workflow running `tsc --noEmit` (or wrangler's build) on
PRs. Cheap and keeps collaborators honest; skipped because this repo has no
CI at all yet. Trigger: first outside contributor's first PR.

## 9. Unit tests for util/static path logic — DEFERRED (REVIEW §5 #3)

The 26-check live acceptance suite is the real gate; unit tests for
slugify/key-building/path regexes would be nice polish. Trigger: a refactor
touching util.ts or static.ts.

## 10. Form-submission endpoint (with Turnstile) — DEFERRED (REVIEW §5 #2)

`POST /api/<slug>/submit` for contact forms on published pages, gated by
Turnstile. Would pair with item 4 (Turnstile for APIs). Trigger: a friend
publishes a page that needs a form.

## 11. Legacy tokens with NULL expires_at — MIGRATION NOTE

Tokens issued before the 90-day-expiry fix have NULL `expires_at` and are
treated as non-expiring by bearerRole. Only new tokens get 90 days. If any
legacy token matters, revoke it from the admin site and re-issue. Trigger:
any suspicion of an old token in the wild — check
`SELECT id, email FROM mcp_tokens WHERE expires_at IS NULL AND revoked = 0`.

---

*This file is the tracker. When something here gets built or explicitly
killed, move it to a commit message and delete the entry. Don't leave
decisions living only in conversation memory.*