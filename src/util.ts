// Helpers shared by all MCP tools: slugify, hashing, KV keys, D1 ops logging.

export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || "page";
}

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex16(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// KV key for a published asset: <visibility>/<slug>/<hash>  (the asset IS the
// index; sub-resources live at <visibility>/<slug>/<hash><suffix>).
export function assetKey(visibility: "public" | "private", slug: string, hash: string, suffix = ""): string {
  return `${visibility}/${slug}/${hash}${suffix}`;
}

export interface PageRow {
  id: number;
  slug: string;
  title: string | null;
  visibility: "public" | "private";
  hash: string;
  url: string;
  size_bytes: number | null;
  created_at: string;
}

// Every MCP mutation lands in ops_log — the friend's audit trail.
export async function logOp(
  db: D1Database,
  op: string,
  detail: unknown,
  ok: boolean,
): Promise<void> {
  try {
    await db
      .prepare("INSERT INTO ops_log (op, detail, ok, at) VALUES (?, ?, ?, ?)")
      .bind(op, JSON.stringify(detail)?.slice(0, 4000) ?? null, ok ? 1 : 0, new Date().toISOString())
      .run();
  } catch {
    /* logging must never break a tool */
  }
}

export function jsonText(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

export function errText(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true as const };
}

// constant-time-ish bearer compare (owner secret)
export async function bearerOk(request: Request, expected: string): Promise<boolean> {
  const h = request.headers.get("Authorization") ?? "";
  if (!h.startsWith("Bearer ")) return false;
  const token = h.slice(7);
  if (token.length !== expected.length) return false;
  const a = new TextEncoder().encode(token);
  const b = new TextEncoder().encode(expected);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Bearer check for EITHER the owner secret OR a live (non-revoked) hashed
// per-user token from mcp_tokens. Returns the role: "admin" for the owner
// secret, "user" for per-user tokens, or null if unauthorized.
export async function bearerRole(
  request: Request,
  ownerSecret: string,
  db: D1Database,
): Promise<"admin" | "user" | null> {
  // Header auth (canonical): "Authorization: Bearer <token>". URL auth
  // (?tk=<token>) is a fallback for browser clients (e.g. the claude.ai web
  // connector) that cannot set custom headers. URL tokens are pp_ user
  // tokens only — the owner secret never rides in a URL.
  let token = "";
  const h = request.headers.get("Authorization") ?? "";
  if (h.startsWith("Bearer ")) token = h.slice(7);
  else {
    const u = new URL(request.url);
    const tk = u.searchParams.get("tk");
    if (tk) token = tk;
  }
  if (!token) return null;
  if (token.startsWith("pp_") && token.length >= 64) {
    const hash = await sha256Hex(token);
    const row = await db.prepare(
      "SELECT id, revoked, expires_at FROM mcp_tokens WHERE token_hash = ?",
    ).bind(hash).first<{ id: number; revoked: number; expires_at: string | null }>();
    const expired = row?.expires_at ? new Date(row.expires_at).getTime() < Date.now() : false;
    if (row && !row.revoked && !expired) {
      db.prepare("UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), row.id)
        .run()
        .catch(() => {});
      return "user";
    }
    return null;
  }
  if (await bearerOk(request, ownerSecret)) return "admin";
  return null;
}
