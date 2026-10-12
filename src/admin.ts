// src/admin.ts — platform-admin tools so the friend never opens the dashboard:
// DNS, worker secrets (names only), MCP token rotation, ops log, DB provisioning.

import { CfClient } from "./cf";
import { logOp, jsonText, errText } from "./util";

export interface AdminEnv {
  DB: D1Database;
  CF_API_TOKEN: string;
  ACCOUNT_ID: string;
  ZONE_ID: string;
  DOMAIN: string;
  WORKER_NAME: string;
}

import { z } from "zod";
export function registerAdminTools(server: any, env: AdminEnv, role: "admin" | "user" = "admin", actor: string = "unknown") {
  const ownerOnly = () =>
    errText("This tool requires the owner token. Tokens issued from the admin site are user-scoped by design.");


  const cf = new CfClient(env);

  // ---- DNS ----
  server.registerTool(
    "list_dns",
    {
      title: "List DNS records",
      description: "List DNS records for the domain.",
      inputSchema: { name: z.string().optional() },
    },
    async ({ name }: any) => {
      try {
        const q = name ? `?name=${encodeURIComponent(name)}` : "";
        const records = await cf.get<any[]>(cf.zone(`/dns_records${q}`));
        return jsonText({
          count: records.length,
          records: records.map((r) => ({ id: r.id, name: r.name, type: r.type, content: r.content, proxied: r.proxied })),
        });
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  server.registerTool(
    "set_dns",
    {
      title: "Create or point a DNS record",
      description: "Create a DNS record. For Worker-served hosts, prefer provision_subdomain instead.",
      inputSchema: {
        name: z.string().describe("Full host, e.g. www.paginate.dev"),
        type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT"]),
        content: z.string(),
        proxied: z.boolean().optional().default(true),
      },
    },
    async ({ name, type, content, proxied }: any) => {
      if (role !== "admin") return ownerOnly();
      try {
        const r = await cf.createDnsRecord({ name, type, content, proxied: proxied ?? true, ttl: 1 });
        await logOp(env.DB, "set_dns", { name, type, content }, true, actor);
        return jsonText({ created: true, id: r.id, name: r.name });
      } catch (e) {
        await logOp(env.DB, "set_dns", { error: String(e) }, false, actor);
        return errText(String(e));
      }
    },
  );

  // ---- worker secrets (names only; values never returned) ----
  server.registerTool(
    "list_worker_secrets",
    {
      title: "List Worker secret names",
      description: "List the names of secrets configured on the Worker (values are never shown).",
      inputSchema: {},
    },
    async () => {
      if (role !== "admin") return ownerOnly();
      try {
        const secrets = await cf.listWorkerSecrets(env.WORKER_NAME);
        return jsonText({ secrets: secrets.map((s: any) => s.name) });
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  server.registerTool(
    "set_worker_secret",
    {
      title: "Set a Worker secret",
      description: "Set or update a secret on the Worker. The value is stored by Cloudflare and never echoed back.",
      inputSchema: { name: z.string(), value: z.string() },
    },
    async ({ name, value }: any) => {
      if (role !== "admin") return ownerOnly();
      try {
        await cf.putWorkerSecret(env.WORKER_NAME, name, value);
        await logOp(env.DB, "set_worker_secret", { name }, true, actor);
        return jsonText({ set: true, name });
      } catch (e) {
        await logOp(env.DB, "set_worker_secret", { error: String(e) }, false, actor);
        return errText(String(e));
      }
    },
  );

  // ---- rotate MCP token ----
  server.registerTool(
    "rotate_mcp_token",
    {
      title: "Rotate the MCP access token",
      description:
        "Generate a new MCP token, store it as the Worker secret, and invalidate " +
        "the old one. You must re-run `claude mcp add` with the new token afterwards.",
      inputSchema: {},
    },
    async () => {
      if (role !== "admin") return ownerOnly();
      try {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        const newToken = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
        await cf.putWorkerSecret(env.WORKER_NAME, "MCP_TOKEN", newToken);
        await logOp(env.DB, "rotate_mcp_token", { rotated: true }, true, actor);
        return jsonText({
          rotated: true,
          new_token: newToken,
          next_step:
            'Re-add the MCP server in Claude Code: claude mcp add --transport http paginate-pub https://mcp.paginate.dev/mcp --header "Authorization: Bearer ' +
            newToken +
            '"',
        });
      } catch (e) {
        await logOp(env.DB, "rotate_mcp_token", { error: String(e) }, false, actor);
        return errText(String(e));
      }
    },
  );

  // ---- ops log (audit trail) ----
  server.registerTool(
    "get_ops_log",
    {
      title: "Show the change history",
      description: "Every change the platform made, newest first (the audit trail).",
      inputSchema: { limit: z.number().optional().default(50) },
    },
    async ({ limit }: any) => {
      try {
        const rows = await env.DB.prepare(
          "SELECT op, detail, ok, at FROM ops_log ORDER BY id DESC LIMIT ?",
        ).bind(Math.min(limit ?? 50, 200)).all();
        return jsonText({ count: rows.results.length, entries: rows.results });
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  // ---- create_db ----
  server.registerTool(
    "create_db",
    {
      title: "Create a small database for a page",
      description:
        "Provision a D1 database tagged with a visibility. A page can only bind a " +
        "database of the SAME visibility — the platform warns you otherwise " +
        "(audit_leaks checks this).",
      inputSchema: {
        name: z.string().describe("Database name, e.g. 'comments-for-my-demo'"),
        visibility: z.enum(["public", "private"]),
        owner_slug: z.string().optional().describe("The page slug this db belongs to."),
      },
    },
    async ({ name, visibility, owner_slug }: any) => {
      if (role !== "admin") return ownerOnly();
      try {
        const clean = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
        const d = await cf.createD1(clean);
        const now = new Date().toISOString();
        await env.DB.prepare(
          "INSERT INTO dbs (name, owner_slug, visibility, cf_d1_id, created_at) VALUES (?, ?, ?, ?, ?)",
        ).bind(clean, owner_slug ?? null, visibility, d.uuid, now).run();
        await logOp(env.DB, "create_db", { name: clean, visibility }, true, actor);
        return jsonText({
          created: true,
          name: clean,
          d1_uuid: d.uuid,
          visibility,
          note: "Free tier: 5 GB, 5M reads/day, 100k writes/day.",
        });
      } catch (e) {
        await logOp(env.DB, "create_db", { error: String(e) }, false, actor);
        return errText(String(e));
      }
    },
  );
}
