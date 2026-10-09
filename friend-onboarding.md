# Friend onboarding — paginate-pub

You never need to open the Cloudflare dashboard. Everything happens by talking
to Claude.

## One-time setup (2 minutes)

Run this once on your machine:

```bash
claude mcp add --transport http paginate-pub https://mcp.paginate.dev/mcp \
  --header "Authorization: Bearer PASTE_YOUR_TOKEN_HERE"
```

Verify it worked:

```bash
claude mcp list        # should show "paginate-pub"
```

## The only file you need: CLAUDE.md

Put this in any folder where you want Claude to be able to publish from:

```md
## Publishing pages
When the user asks to publish, share, post, or "put online" a page or demo:
1. Write the complete page as one self-contained HTML file (inline CSS/JS).
2. Call the `publish_page` tool with { "html": <the html>, "title": <short title>,
   "slug": <short-kebab-name> }.
3. Reply with the returned URL — that's the deliverable.

For something only specific people should see, add "visibility": "private"
and tell the user it's private. To share it with a group, use `create_group`
then `grant_access`. To move a page between public and private, use
`set_visibility`. To see everything you've published, use `list_assets`.
To see who has access and what things cost, use `list_users` and `get_status`.
If a page might share a database with the wrong visibility, run
`audit_leaks` first. To spin up a whole set of subdomains at once, use
`launch_group`.
```

## What you can just say

- "make a page that shows X and publish it"
- "make that private"
- "share it with bob@example.com" / "create a group called 'team' with alice@ and carol@ and share it"
- "move it back to public"
- "list everything I've published"
- "who has access to what?"
- "what is this costing me?" / "any charges pending?" / "what's my usage?"
- "check for leaks" / "is anything shared that shouldn't be?"
- "send an email to myself from hello@paginate.dev" (to verified addresses only)
- "spin up alpha.paginate.dev and beta.paginate.dev for the team"
- "rotate my MCP token" (you'll get a new token to paste into the setup command)

## Pricing reality (so you're never surprised)

- Publishing, private pages, groups, users (up to 50), subdomains, inbound
  email: **free**.
- Outbound email: **free to verified destination addresses** (addresses you've
  added with `add_email_address`). Email to anyone else requires a paid plan
  ($5/mo) — the tool will tell you instead of sending if that's the case.
- If a demo goes viral past 100k requests/day, Workers goes paid at $5/mo —
  `get_status` will warn you well before that.
