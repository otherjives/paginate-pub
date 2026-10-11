// src/index.ts — paginate-pub Worker entrypoint.
//
// Host routing:
//   mcp.paginate.dev/mcp        -> MCP endpoint (Bearer MCP_TOKEN)
//   pub.paginate.dev/s/...      -> public assets (no auth)
//   private.paginate.dev/s/...  -> private assets (Cloudflare Access sits in
//                                  front in the dashboard; the Worker also
//                                  only serves from the private/ KV prefix)
//   <anything else>.paginate.dev/s/... -> resolved by hostname label:
//                                  'pub' => public, otherwise private.
//   catch-all                   -> tiny landing JSON so the origin is never bare.

import { createMcpHandler } from "agents/mcp/server";
import { createServer } from "./mcp";
import { serveAsset } from "./static";
import { bearerRole } from "./util";
import { bumpCounter } from "./status";
import { watchCosts } from "./status";
import { handleAdminSite } from "./adminsite";

const MCP_ROUTE = "/mcp";

// simple in-memory token-bucket rate limit for the MCP endpoint (60/min)
const buckets = new Map<string, { ts: number; n: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now - b.ts > 60_000) {
    buckets.set(ip, { ts: now, n: 1 });
    return false;
  }
  b.n += 1;
  if (b.n > 60) return true;
  return false;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const host = url.hostname;
    const domain = env.DOMAIN;

    // ---- MCP endpoint (mcp.<domain>/mcp) ----
    if (host === `mcp.${domain}`) {
      if (url.pathname !== MCP_ROUTE && !(url.pathname + "/").startsWith(MCP_ROUTE)) {
        return new Response("not found", { status: 404 });
      }
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      if (rateLimited(ip)) {
        return new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }
      const role = await bearerRole(request, env.MCP_TOKEN, env.DB);
      if (!role) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" },
        });
      }
      const handler = createMcpHandler(() => createServer(env, role), {
        route: MCP_ROUTE,
        corsOptions: false,
        allowedHostnames: [`mcp.${domain}`],
      });
      return handler(request, env, ctx);
    }

    // ---- admin site (admin.<domain>, Access-gated) ----
    if (host === `admin.${domain}`) {
      return handleAdminSite(request, env, ctx);
    }

    // ---- asset serving (runs for every non-MCP request, before landing) ----
    // visibility from hostname: pub.<domain> => public,
    // private.<domain> and any other custom host => private.
    {
      let visibility: "public" | "private";
      if (host === `pub.${domain}`) visibility = "public";
      else if (host === `private.${domain}`) visibility = "private";
      else if (host.endsWith(`.${domain}`)) {
        const label = host.slice(0, -(domain.length + 1));
        visibility = label === "pub" ? "public" : "private";
      } else {
        visibility = "public"; // workers.dev fallback
      }
      const asset = await serveAsset(env, request, visibility, ctx);
      // self-metered usage counters (fire-and-forget; never blocks the response)
      ctx.waitUntil(bumpCounter(env.DB, `req:${new Date().toISOString().slice(0, 10)}`, 1));
      if (asset) return asset;
    }

    // ---- landing (only reached when no asset matched) ----
    // A /s/... path that misses is a 404 (never the landing JSON: a 200 landing
    // on an asset URL can confuse both humans and caches).
    if (url.pathname.startsWith("/s/")) {
      return new Response("not found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    return new Response(
      JSON.stringify({
        service: "paginate-pub",
        domain,
        hosts: {
          public: env.PUBLIC_BASE,
          private: env.PRIVATE_BASE,
          mcp: `${env.MCP_BASE}${MCP_ROUTE}`,
        },
        note: "Publish pages via the paginate-pub MCP tools in Claude Code.",
      }),
      { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
    );
  },

  // cron: watch_costs — alert when any usage approaches a free-tier limit
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(watchCosts(env));
  },
} satisfies ExportedHandler<Env>;
