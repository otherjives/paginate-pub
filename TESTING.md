# Test-friend trial instructions

You're testing **paginate-pub** before it goes to its real home. Everything
happens inside Claude Code — you never need a browser dashboard. 10 minutes.

## Step 1 — Install Claude Code (once)

Install from https://claude.com/claude-code if you don't have it, then run
`claude` in any folder. (Needs Node 18+.)

## Step 2 — Get your MCP command

Sign in at **admin.paginate.dev** (email one-time PIN), click "Generate token
& setup command", and copy the command it shows:

```
claude mcp add --transport http paginate-pub https://mcp.paginate.dev/mcp \
  --header "Authorization: Bearer pp_...."
```

Paste it into your terminal. Done — Claude Code now has the publishing tools.

**No terminal? Claude in a browser only?** The admin site also shows a
connector URL (`...mcp?tk=...`) for claude.ai → Settings → Connectors → Add
custom connector. It's experimental — if the connector setup rejects it, note
that in your report; the terminal path is the supported one.

## First-run note (one-time permission approval)

The first time Claude tries to use the paginate-pub tools it will ask to
approve them. In an interactive session, pick "always allow" for the server —
once. If you run Claude headless (non-interactive), tools can't be approved
mid-run; either approve once interactively first, or create
`.claude/settings.local.json` in the project folder containing:

```json
{ "permissions": { "allow": ["mcp__paginate-pub"] } }
```

## Step 3 — Do the thing (copy/paste any of these into Claude)

Say things like:

- "Publish a page: a neon retro landing page for a fake coffee shop called
  Quantum Beans. Publish it and give me the link."
- "Make a playable reaction game with a leaderboard and publish it."
- "Make a page with a to-do list where I can add and check off items, publish
  it, and tell me the link."
- "Publish a private page with my secret chili recipe, then give me a link
  I can send my brother that works until tomorrow."

What should happen every time: Claude writes the page, publishes it with one
tool call, and hands you a `...paginate.dev/s/<name>/` link that just works.

## Step 4 — Change things (this is the important test)

- "Add a menu section to the coffee shop page." — the SAME link should show
  the new version (that's the whole point of latest URLs).
- "Make the game page private." — then "give me a share link for my friend
  that expires in 2 days."
- "What have I published? What's this costing the owner?" — Claude should
  answer both with the platform's own status tools.

## What to report back

1. Did every one-shot work, or did Claude ever ask you a question it
   shouldn't have needed to ask?
2. Was any link confusing (two different URLs for the same page, etc.)?
3. Was anything slower than you expected?
4. Did Claude ever mention needing a dashboard/login/password? (It never
  should.)

## Known limits (so you're not surprised)

- Links to private pages require a one-time email PIN the FIRST time a given
  browser visits. After that, it remembers you for a day.
- Share links are just long URLs: anyone who has the link can view until it
  expires or is revoked. That's the design — it's how "share with my brother
  for a day" works.
- Email only goes to addresses that were verified with the owner beforehand.

If something breaks, screenshot what you told Claude and what it said — that's
the most useful bug report.