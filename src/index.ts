// src/index.ts — paginate-pub Worker entrypoint.
//
// Host routing:
//   mcp.paginate.dev/mcp        -> MCP endpoint (Bearer MCP_TOKEN)
//   pub.paginate.dev/s/...      -> public assets (no auth)
//   private.paginate.dev/s/...  -> private assets (Cloudflare Access sits in
//                                  front (API- or dashboard-configured); the Worker also
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
import { handleShareRequest, SHARE_RE } from "./share";
import { handleApi } from "./api";

const MCP_ROUTE = "/mcp";

// best-effort in-memory token-bucket rate limit for the MCP endpoint (60/min).
// ADVISORY ONLY: in-memory buckets are per-isolate in Workers and reset on
// every isolate recycle (see api.ts for the D1-counter pattern we use where
// the limit is a real guarantee). Good enough to stop a runaway agent loop;
// not a security control.
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
      const auth = await bearerRole(request, env.MCP_TOKEN, env.DB);
      if (!auth) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" },
        });
      }
      const handler = createMcpHandler(() => createServer(env, auth.role, auth.actor), {
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
      // Vanity hosts route by D1 lookup (security/visibility per site).
      // Fixed hosts are hardcoded; unknown .<domain> hosts default PRIVATE
      // (fail closed) — provision_subdomain must register a host before it
      // serves publicly.
      let visibility: "public" | "private";
      if (host === `pub.${domain}`) visibility = "public";
      else if (host === `private.${domain}`) visibility = "private";
      else if (host.endsWith(`.${domain}`) && host !== domain) {
        const sub = await env.DB.prepare(
          "SELECT visibility, security FROM subdomains WHERE host = ?",
        ).bind(host).first<{ visibility: string; security: string }>();
        if (!sub) visibility = "private";                    // unregistered: serve nothing public
        else if (sub.security === "open") visibility = "public";
        else visibility = (sub.visibility as "public" | "private") ?? "private";
      } else {
        visibility = "public"; // workers.dev fallback
      }
      // ---- vanity-host root: / serves the host's asset slug (latest) ----
      if (host.endsWith(`.${domain}`) && host !== domain &&
          host !== `pub.${domain}` && host !== `private.${domain}` &&
          (url.pathname === "/" || url.pathname === "")) {
        const sub = await env.DB.prepare(
          "SELECT asset_slug FROM subdomains WHERE host = ? AND asset_slug IS NOT NULL",
        ).bind(host).first<{ asset_slug: string }>();
        if (sub) {
          const latest = await env.DB.prepare(
            "SELECT hash, visibility FROM pages WHERE slug = ? ORDER BY created_at DESC, id DESC LIMIT 1",
          ).bind(sub.asset_slug).first<{ hash: string; visibility: string }>();
          if (latest && latest.visibility === visibility) {
            const root = new URL(request.url);
            root.pathname = `/s/${sub.asset_slug}/${latest.hash}/`;
            return new Response(null, { status: 302, headers: { Location: root.pathname, "Cache-Control": "no-store" } });
          }
        }
      }

      // ---- capability share links (/x/<token>/...) ----
      // Token links live on private.<domain> and serve the page's content
      // under the token prefix. They bypass nothing — the Worker validates
      // the token itself; Access never fronts private.<domain>/x/* (the
      // blanket private-host app, if any, must not cover /x/).
      if (visibility === "private" && SHARE_RE.test(url.pathname)) {
        const share = await handleShareRequest(env, request);
        if (share) return share;
        return new Response("not found", {
          status: 404,
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
        });
      }

      // ---- per-page data API (/api/<slug>/...) ----
      const api = await handleApi(request, env, visibility);
      if (api) return api;

      // ---- latest-version redirect (/s/<slug>/ -> newest hash) ----
      // The shareable "always current" URL: 302 to the newest published
      // version. No hash means 'latest'; browsers follow transparently.
      let lm = /^\/s\/([a-z0-9][a-z0-9-]*)\/?(\?|$)/.exec(url.pathname);
      if (lm && request.method === "GET") {
        const latest = await env.DB.prepare(
          "SELECT visibility, hash FROM pages WHERE slug = ? ORDER BY created_at DESC, id DESC LIMIT 1",
        ).bind(lm[1]).first<{ visibility: string; hash: string }>();
        if (latest && latest.visibility === visibility) {
          return new Response(null, {
            status: 302,
            headers: {
              Location: `/s/${lm[1]}/${latest.hash}/`,
              "Cache-Control": "no-store",
            },
          });
        }
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
