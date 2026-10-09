# paginate-pub

A no-GUI publishing platform on Cloudflare. Publish Claude-made HTML demos to
the web by asking. Public demos, private pages, groups, users, subdomains,
email, cost/status — all via one MCP server in Claude Code.

**Account: paginate.dev (its own Cloudflare account).** Nothing in this
project touches any other account or domain.

## Stack

- One Worker `paginate-pub`: KV asset serving (immutable, content-addressed),
  D1 control plane, Analytics Engine traffic, Email Service binding, MCP
  endpoint (Streamable HTTP, Bearer).
- Hosts: `pub.paginate.dev` (public), `private.paginate.dev` (private, behind
  Cloudflare Access), `mcp.paginate.dev/mcp` (MCP only).
- Verified-destination email only (free). Arbitrary-recipient sending requires
  Workers Paid and is disabled by default.

## Develop

```bash
npm i
npm run d1:migrate:remote   # once
npm run dev                 # local
npm run deploy              # prod
```

Secrets (Worker secrets, never in git):

```bash
wrangler secret put MCP_TOKEN      # random hex; gates MCP
wrangler secret put CF_API_TOKEN   # paginate.dev API token (scoped, see README)
```

## Tests

```bash
npm test          # unit: util/static/cf with mocked fetch (coming)
```

Acceptance tests are driven from a real Claude Code session using the MCP
tools; see the plan's acceptance section.
