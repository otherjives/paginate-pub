// src/api.ts — per-page data API: /api/<slug>/... backed by D1.
//
// Design (KISS):
//   One table, `page_data`, stores JSON records per slug. No per-page schema
//   management: a record IS a JSON object the page owns. This is the
//   stream-of-consciousness-friendly surface — Claude invents the record
//   shape, the platform enforces safety (slug must be published, size caps,
//   rate limits, visibility match).
//
// Endpoints (all same-origin; CSP connect-src 'self' allows them):
//   GET    /api/<slug>            -> newest-to-oldest records, default limit 100
//   GET    /api/<slug>?limit=N    -> N <= 500
//   GET    /api/<slug>/<id>       -> one record
//   POST   /api/<slug>            -> create {id, slug, data, created_at}
//   PUT    /api/<slug>/<id>       -> replace data (404 if id unknown)
//   DELETE /api/<slug>/<id>       -> remove
//   GET    /api/<slug>/_count     -> {"count": N} (cheap polls)
//
// Auth: public slugs get a per-IP write rate limit (60 writes / 5 min).
// Private slugs: Cloudflare Access already fronts the whole private host;
//   the worker additionally verifies the Access JWT in-Worker (verifyAccessJwt).
// Reads on private are same — Access-gated at the edge.

import { verifyAccessJwt } from "./adminsite";

export interface ApiEnv {
  DB: D1Database;
  CACHE: KVNamespace;
  DOMAIN: string;
  PRIVATE_BASE: string;
  ACCESS_TEAM: string;
  ADMIN_AUD: string;
}

const MAX_RECORD_BYTES = 16 * 1024; // 16 KB per record
const LIST_DEFAULT = 100;
const LIST_MAX = 500;

// Write rate limit: 60 writes / 5 min per slug+IP, counted in D1.
// (In-memory Maps are per-isolate in Workers and reset constantly — the
// counter table is the honest, free way to do this: D1 free tier has
// 100k writes/day and rate-limit rows are tiny and self-pruning.)
async function writeLimited(env: ApiEnv, slug: string, ip: string): Promise<boolean> {
  const now = Date.now();
  const window = Math.floor(now / (5 * 60_000)); // 5-min window number
  const r = await env.DB.prepare(
    `INSERT INTO rate_limit (k, window, n) VALUES (?, ?, 1)
     ON CONFLICT(k, window) DO UPDATE SET n = n + 1 RETURNING n`,
  ).bind(`${slug}:${ip}`, window).first<{ n: number }>();
  // lazy prune: drop windows older than the current one for this key
  if ((r?.n ?? 0) === 1) {
    env.DB.prepare("DELETE FROM rate_limit WHERE k = ? AND window < ?")
      .bind(`${slug}:${ip}`, window)
      .run()
      .catch(() => {});
  }
  return (r?.n ?? 1) > 60;
}

const j = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });

export function isApiRequest(pathname: string): boolean {
  return /^\/api\/[a-z0-9][a-z0-9-]*\//.test(pathname) || /^\/api\/[a-z0-9][a-z0-9-]*$/.test(pathname);
}

/**
 * Handle /api/<slug>... Returns null when the path isn't an API path so the
 * caller falls through. All errors are self-explaining JSON.
 */
export async function handleApi(
  request: Request,
  env: ApiEnv,
  visibility: "public" | "private",
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isApiRequest(url.pathname)) return null;

  const m = /^\/api\/([a-z0-9][a-z0-9-]*)(\/.*)?$/.exec(url.pathname);
  if (!m) return null;
  const slug = m[1];
  const rest = m[2] ?? "";

  // The slug must exist (any visibility) and match the host's visibility —
  // this also means private slugs are unreachable on the public host.
  const page = await env.DB.prepare(
    "SELECT visibility FROM pages WHERE slug = ? ORDER BY created_at DESC LIMIT 1",
  ).bind(slug).first<{ visibility: string }>();
  if (!page) {
    return j({ error: "unknown slug", slug, hint: "Publish a page with this slug first; the API serves data for published pages only." }, 404);
  }
  if (page.visibility !== visibility) {
    return j({ error: "visibility mismatch", slug, host_visibility: visibility, page_visibility: page.visibility, hint: `This API is on the ${visibility} host; the page '${slug}' lives on the ${page.visibility} host. ${page.visibility === "private" ? "Private page data must be accessed via the private host behind Cloudflare Access." : "Public page data is served from the public host."}` }, 404);
  }

  // Private host: Access must have authenticated (edge) — verify the JWT too.
  if (visibility === "private") {
    // Access already gated this request at the edge (blanket app or per-slug
    // app); the JWT may carry either app's AUD, so enforce signature/iss/exp
    // only, not a specific AUD.
    const identity = await verifyAccessJwt(request, env as any, "any");
    if (!identity) {
      return j({ error: "authentication required", hint: "This is a private page API. Sign in via the Cloudflare Access prompt (your email must be in a granted group)." }, 401);
  }
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";

  // ---- GET /api/<slug>/_count
  let mm = /^\/_count\/?$/.exec(rest);
  if (request.method === "GET" && mm) {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM page_data WHERE slug = ?").bind(slug).first<{ n: number }>();
    return j({ count: r?.n ?? 0 });
  }

  // ---- GET list / single
  if (request.method === "GET") {
    mm = /^\/([0-9]+)\/?$/.exec(rest);
    if (mm) {
      const row = await env.DB.prepare(
        "SELECT id, data, created_at FROM page_data WHERE slug = ? AND id = ?",
      ).bind(slug, Number(mm[1])).first<{ id: number; data: string; created_at: string }>();
      if (!row) return j({ error: "no such record", slug, id: Number(mm[1]) }, 404);
      return j({ id: row.id, slug, data: JSON.parse(row.data), created_at: row.created_at });
    }
    if (rest === "" || rest === "/") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? LIST_DEFAULT) || LIST_DEFAULT, LIST_MAX);
      const rows = await env.DB.prepare(
        "SELECT id, data, created_at FROM page_data WHERE slug = ? ORDER BY id DESC LIMIT ?",
      ).bind(slug, limit).all<{ id: number; data: string; created_at: string }>();
      return j({ slug, count: rows.results.length, records: rows.results.map((r) => ({ id: r.id, data: JSON.parse(r.data), created_at: r.created_at })) });
    }
    return j({ error: "not found", hint: "Valid API paths: GET /api/<slug> (list), GET /api/<slug>/<id>, GET /api/<slug>/_count" }, 404);
  }

  // ---- POST create
  if (request.method === "POST" && (rest === "" || rest === "/")) {
    if (await writeLimited(env, slug, ip)) {
      return j({ error: "rate limited", hint: "Max 60 writes per 5 minutes per IP. Retry shortly." }, 429);
    }
    const bodyText = await request.text();
    if (bodyText.length > MAX_RECORD_BYTES) {
      return j({ error: "record too large", limit_bytes: MAX_RECORD_BYTES, got_bytes: bodyText.length, hint: "Split the data or store a summary; the demo pattern is small records." }, 413);
    }
    let data: unknown;
    try { data = JSON.parse(bodyText); } catch {
      return j({ error: "invalid JSON body" }, 400);
    }
    const now = new Date().toISOString();
    const r = await env.DB.prepare(
      "INSERT INTO page_data (slug, data, created_at) VALUES (?, ?, ?)",
    ).bind(slug, JSON.stringify(data), now).run();
    return j({ ok: true, id: r.meta.last_row_id, slug, created_at: now }, 201);
  }

  // ---- PUT replace
  mm = /^\/([0-9]+)\/?$/.exec(rest);
  if (request.method === "PUT" && mm) {
    if (await writeLimited(env, slug, ip)) return j({ error: "rate limited" }, 429);
    const bodyText = await request.text();
    if (bodyText.length > MAX_RECORD_BYTES) return j({ error: "record too large", limit_bytes: MAX_RECORD_BYTES }, 413);
    let data: unknown;
    try { data = JSON.parse(bodyText); } catch { return j({ error: "invalid JSON body" }, 400); }
    const r = await env.DB.prepare(
      "UPDATE page_data SET data = ? WHERE slug = ? AND id = ?",
    ).bind(JSON.stringify(data), slug, Number(mm[1])).run();
    if (!r.meta.changes) return j({ error: "no such record", slug, id: Number(mm[1]) }, 404);
    return j({ ok: true, id: Number(mm[1]), slug });
  }

  // ---- DELETE
  if (request.method === "DELETE" && mm) {
    if (await writeLimited(env, slug, ip)) return j({ error: "rate limited" }, 429);
    const r = await env.DB.prepare("DELETE FROM page_data WHERE slug = ? AND id = ?")
      .bind(slug, Number(mm[1])).run();
    if (!r.meta.changes) return j({ error: "no such record" }, 404);
    return j({ ok: true, id: Number(mm[1]), slug });
  }

  return j({ error: "method not allowed", method: request.method, hint: "GET, POST, PUT, DELETE only." }, 405);
}