// worker-configuration.d.ts — Env bindings for the paginate-pub Worker.
/// <reference types="@cloudflare/workers-types" />

interface Env {
  // vars (wrangler.toml [vars])
  ZONE_ID: string;
  ACCOUNT_ID: string;
  DOMAIN: string;
  PUBLIC_BASE: string;
  PRIVATE_BASE: string;
  MCP_BASE: string;
  ACCESS_TEAM: string;   // e.g. 'otherjives.cloudflareaccess.com'
  ADMIN_AUD: string;     // Access application AUD for admin.<domain>

  // secrets (wrangler secret put)
  MCP_TOKEN: string;     // gates the MCP endpoint (Bearer)
  CF_API_TOKEN: string;  // Cloudflare API token used by tools (least privilege)

  // bindings
  DB: D1Database;
  CACHE: KVNamespace;
  ANALYTICS_ENGINE?: AnalyticsEngineDataset;
  EMAIL: SendEmail;
}
