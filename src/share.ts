// src/share.ts — capability share links for private slugs.
//
// Model:
//   create_share_link(slug, {expires, max_uses, note}) -> one long random
//   token (32 bytes, 64 hex chars) shown ONCE; stored SHA-256-hashed.
//   Recipients open https://private.<domain>/x/<token>/ — the path validates
//   the token, then the page's KV content is served UNDER THE TOKEN PREFIX,
//   so relative assets (css/js) and the slides auto-refresh both keep working.
//   Dead/expired/revoked tokens return an opaque 404 (no oracle).
//
// Canonical token URLs live on private.<domain>/x/<token>/; gated vanity
// hosts also resolve /x/ paths via their <host>/x bypass apps, so a link
// works regardless of the site's security mode (open/access/...).

import { sha256Hex } from "./util";

export interface ShareEnv {
  DB: D1Database;
  CACHE: KVNamespace;
  CF_API_TOKEN: string;
  ACCOUNT_ID: string;
  DOMAIN: string;
  PRIVATE_BASE: string;
}

export const SHARE_RE = /^\/x\/([0-9a-f]{64})(\/.*)?$/;

function randomToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function createShareLink(
  env: ShareEnv,
  slug: string,
  opts: { hours?: number; max_uses?: number; note?: string } = {},
): Promise<{ url: string; token: string; expires_at: string | null }> {
  // slug must exist and be private
  const page = await env.DB.prepare(
    "SELECT visibility FROM pages WHERE slug = ? ORDER BY created_at DESC LIMIT 1",
  ).bind(slug).first<{ visibility: string }>();
  if (!page) throw new Error(`no page with slug '${slug}'`);
  if (page.visibility !== "private") throw new Error(`'${slug}' is public — no share link needed, its URL is already open`);

  const token = randomToken();
  const hash = await sha256Hex(token);
  const now = new Date();
  const expires = opts.hours ? new Date(now.getTime() + opts.hours * 3600_000).toISOString() : null;
  await env.DB.prepare(
    "INSERT INTO share_links (slug, token_hash, expires_at, max_uses, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(slug, hash, expires, opts.max_uses ?? null, opts.note ?? null, now.toISOString()).run();
  return { url: `${env.PRIVATE_BASE}/x/${token}/`, token, expires_at: expires };
}

export async function listShareLinks(env: ShareEnv, slug?: string): Promise<any[]> {
  const res = slug
    ? await env.DB.prepare(
        "SELECT id, slug, expires_at, max_uses, uses, revoked, note, created_at FROM share_links WHERE slug = ? ORDER BY id DESC LIMIT 200",
      ).bind(slug).all()
    : await env.DB.prepare(
        "SELECT id, slug, expires_at, max_uses, uses, revoked, note, created_at FROM share_links ORDER BY id DESC LIMIT 200",
      ).all();
  return res.results as any[];
}

export async function revokeShareLink(env: ShareEnv, id: number): Promise<number> {
  const r = await env.DB.prepare("UPDATE share_links SET revoked = 1 WHERE id = ?").bind(id).run();
  return r.meta.changes ?? 0;
}

interface Validated { slug: string; hash: string }

// Validate a token from the URL. Returns the slug it unlocks, or null.
export async function validateShareToken(env: ShareEnv, token: string): Promise<Validated | null> {
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    "SELECT slug, expires_at, max_uses, uses, revoked FROM share_links WHERE token_hash = ?",
  ).bind(hash).first<{ slug: string; expires_at: string | null; max_uses: number | null; uses: number; revoked: number }>();
  if (!row || row.revoked) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
  if (row.max_uses !== null && row.uses >= row.max_uses) return null;
  return { slug: row.slug, hash };
}


// Serving entry: called from index.ts for private host paths under /x/.
// Re-writes the request onto the real asset paths and serves with the token
// prefix intact so relative URLs keep working.
export async function handleShareRequest(
  env: ShareEnv,
  request: Request,
): Promise<Response | null> {
  const url = new URL(request.url);
  const m = SHARE_RE.exec(url.pathname);
  if (!m) return null;
  const token = m[1];
  const rest = m[2] ?? "/";

  const v = await validateShareToken(env, token);
  if (!v) {
    // opaque: same answer for nonexistent, expired, revoked, exhausted
    return new Response("not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  // resolve the slug's latest private version
  const page = await env.DB.prepare(
    "SELECT hash FROM pages WHERE slug = ? AND visibility = 'private' ORDER BY created_at DESC, id DESC LIMIT 1",
  ).bind(v.slug).first<{ hash: string }>();
  if (!page) {
    return new Response("not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  // rewrite rest onto /s/<slug>/<hash><rest>
  const target = new URL(request.url);
  target.pathname = `/s/${v.slug}/${page.hash}${rest === "/" ? "/" : rest}`;
  // serve via serveAsset with a synthetic request (same origin, token host)
  const { serveAsset } = await import("./static");
  const inner = new Request(target.toString(), request);
  const resp = await serveAsset({ CACHE: env.CACHE } as any, inner, "private");
  if (!resp) {
    return new Response("not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  // count the use BEFORE serving so max_uses is enforced even under racing
  // requests (D1 is single-writer: the counter is authoritative).
  const usedHash = v.hash; // already computed by validateShareToken
  const counted = await env.DB.prepare(
    `UPDATE share_links SET uses = uses + 1
     WHERE token_hash = ? AND (max_uses IS NULL OR uses < max_uses)`,
  ).bind(usedHash).run();
  if ((counted.meta.changes ?? 0) === 0) {
    // link exhausted between validation and here (race) — refuse
    return new Response("not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  // copy the response with token-safe cache headers (private content: never public-cacheable)
  const headers = new Headers(resp.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(resp.body, { status: resp.status, headers });
}
// ---- MCP tool registration (accessible to user tokens — sharing is a
// normal-user action, not owner-only) ----
import { z } from "zod";
import { logOp, jsonText, errText } from "./util";

export function registerShareTools(server: any, env: ShareEnv, actor: string = "unknown") {
  server.registerTool(
    "create_share_link",
    {
      title: "Create an expiring share link for a private page",
      description:
        "Give someone temporary access to a PRIVATE page with a long unguessable link " +
        "(capability URL). The token is shown once. Recipients open the link — no login. " +
        "Default: expires in 48 hours, unlimited uses. Use max_uses=1 for a one-time link.",
      inputSchema: {
        slug: z.string().describe("The private page's slug."),
        hours: z.number().int().positive().max(24 * 365).optional().describe(
          "Hours until the link dies. Default 48."),
        max_uses: z.number().int().positive().optional().describe(
          "Total opens allowed. 1 = one-time link. Default unlimited."),
        note: z.string().max(120).optional().describe("Why this link exists, e.g. 'for Dave'."),
      },
    },
    async ({ slug, hours, max_uses, note }: any) => {
      try {
        const r = await createShareLink(env, slug, { hours: hours ?? 48, max_uses, note });
        await logOp(env.DB, "create_share_link", { slug, hours, max_uses, note }, true, actor);
        return jsonText({
          ...r,
          warning: "Copy the token now — it is never shown again. Anyone with this URL can view the page until it expires.",
        });
      } catch (e) {
        await logOp(env.DB, "create_share_link", { error: String(e), slug }, false, actor);
        return errText(String(e));
      }
    },
  );

  server.registerTool(
    "list_share_links",
    {
      title: "List share links",
      description: "All share links (optionally for one slug), with expiry, uses, revoked state. Tokens are never shown — only metadata.",
      inputSchema: { slug: z.string().optional() },
    },
    async ({ slug }: any) => {
      try {
        const links = await listShareLinks(env, slug);
        return jsonText({ count: links.length, links });
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  server.registerTool(
    "revoke_share_link",
    {
      title: "Revoke a share link",
      description: "Kill a link immediately by its numeric id (from list_share_links). Recipients get a 404.",
      inputSchema: { id: z.number().int().positive() },
    },
    async ({ id }: any) => {
      try {
        const changes = await revokeShareLink(env, id);
        await logOp(env.DB, "revoke_share_link", { id, changes }, true, actor);
        return jsonText({ ok: changes > 0, id, changes });
      } catch (e) {
        return errText(String(e));
      }
    },
  );
}
