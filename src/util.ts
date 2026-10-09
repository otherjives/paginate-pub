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

// constant-time-ish bearer compare
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
