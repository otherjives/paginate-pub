// src/adminsite.ts — the Access-gated admin site on admin.<domain>.
//
// Security model:
//   - Cloudflare Access sits in front of admin.<domain> (email OTP for the
//     platform-admins group). The Worker verifies the Access JWT (Cf-Access-Jwt-Assertion)
//     against the team domain + application AUD before serving anything.
//   - The admin site can ISSUE per-user MCP tokens (stored hashed, shown once,
//     revocable). Owner-secret tools are role-gated in admin.ts.
//   - The HTML is a single self-contained page; no external assets.

import { sha256Hex, logOp } from "./util";

export interface AdminSiteEnv {
  DB: D1Database;
  CACHE: KVNamespace;
  CF_API_TOKEN: string;
  ACCOUNT_ID: string;
  ZONE_ID: string;
  DOMAIN: string;
  PUBLIC_BASE: string;
  PRIVATE_BASE: string;
  MCP_BASE: string;
  ACCESS_TEAM: string;   // <team>.cloudflareaccess.com
  ADMIN_AUD: string;     // Access application AUD for admin.<domain>
  MCP_TOKEN: string;     // owner secret (never exposed by the site)
}

interface AccessIdentity { email: string; name?: string }

// Verify the Cf-Access-Jwt-Assertion header. Returns the identity or null.
export async function verifyAccessJwt(
  request: Request,
  env: AdminSiteEnv,
  expectedAud?: string,
): Promise<AccessIdentity | null> {
  // expectedAud: the Access-app AUD the caller expects (default: this admin
  // site's). Pass "any" to accept any team-signed JWT (signature, iss and
  // exp are still enforced) — used by the private-page data API, where the
  // visitor's JWT may come from the blanket private-host app OR a
  // path-scoped per-slug app, which have different AUDs.
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  try {
    // fetch current public keys (cached by CF; small)
    const jwksUrl = `https://${env.ACCESS_TEAM}/cdn-cgi/access/certs`;
    const jwks = (await (await fetch(jwksUrl)).json()) as { keys?: { kid?: string }[] };
    // decode header to find kid
    const [h64] = token.split(".");
    const header = JSON.parse(atob(h64.replace(/-/g, "+").replace(/_/g, "/")));
    const jwk = (jwks.keys ?? []).find((k: any) => k.kid === header.kid) as JsonWebKey | undefined;
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      "jwk", jwk, { name: "RS256", hash: "SHA-256" }, false, ["verify"]);
    // verify signature over the ASCII bytes of "<header>.<payload>"
    const [hb, pb] = token.split(".");
    const signed = new TextEncoder().encode(`${hb}.${pb}`);
    const ok = await crypto.subtle.verify(
      "RS256", key,
      signed,
      base64UrlToBytes(token.split(".")[2]));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(pb)));
    // iss + aud + exp checks (iss = team domain, aud = this application)
    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== `https://${env.ACCESS_TEAM}`) return null;
    const want = expectedAud ?? env.ADMIN_AUD;
    if (want !== "any" && payload.aud !== want) return null;
    if (payload.exp && payload.exp < now) return null;
    return { email: payload.email, name: payload.name };
  } catch {
    return null;
  }
}

function base64UrlToBytes(s: string): Uint8Array {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b.length % 4 ? "=".repeat(4 - (b.length % 4)) : "";
  const bin = atob(b + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- token issuing ----
function randomToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return "pp_" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function issueToken(env: AdminSiteEnv, email: string, name: string): Promise<{ token: string; id: number }> {
  const token = randomToken();
  const hash = await sha256Hex(token);
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
  const r = await env.DB.prepare(
    "INSERT INTO mcp_tokens (email, name, token_hash, role, created_at, expires_at) VALUES (?, ?, ?, 'user', ?, ?)",
  ).bind(email, name || null, hash, now, expires).run();
  await logOp(env.DB, "issue_token", { email, name, id: r.meta.last_row_id }, true);
  return { token, id: r.meta.last_row_id as number };
}

export async function revokeToken(env: AdminSiteEnv, id: number): Promise<number> {
  const r = await env.DB.prepare("UPDATE mcp_tokens SET revoked = 1 WHERE id = ?").bind(id).run();
  await logOp(env.DB, "revoke_token", { id }, true);
  return r.meta.changes ?? 0;
}

export async function listTokens(env: AdminSiteEnv): Promise<any[]> {
  const r = await env.DB.prepare(
    "SELECT id, email, name, role, revoked, created_at, last_used_at FROM mcp_tokens ORDER BY id DESC LIMIT 200",
  ).all();
  return r.results as any[];
}

// ---- the page ----
const PAGE = (email: string, tokens: any[], flash: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>paginate-pub admin</title><style>
:root{--bg:#0f0f17;--card:#1a1a2e;--accent:#7b68ee;--text:#e6e6f0;--dim:#8a8aa0;--ok:#4ade80;--bad:#f87171}
*{box-sizing:border-box}body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text);margin:0;padding:2rem 1rem;display:flex;justify-content:center;min-height:100vh}
.wrap{max-width:640px;width:100%}h1{font-size:1.4rem;margin:0 0 .25rem}p.sub{color:var(--dim);margin:0 0 1.5rem;font-size:.9rem}
.card{background:var(--card);border:1px solid #2a2a44;border-radius:12px;padding:1.25rem;margin-bottom:1rem}
label{display:block;font-size:.8rem;color:var(--dim);margin-bottom:.35rem}
input{width:100%;padding:.6rem .75rem;border-radius:8px;border:1px solid #33334f;background:#12121f;color:var(--text);font-size:.95rem}
button{margin-top:.75rem;background:var(--accent);border:none;color:#fff;padding:.6rem 1.1rem;border-radius:8px;font-weight:600;cursor:pointer;font-size:.95rem}
button:hover{filter:brightness(1.1)}.danger{background:#b3444d}
table{width:100%;border-collapse:collapse;font-size:.85rem}th,td{text-align:left;padding:.5rem .25rem;border-bottom:1px solid #2a2a44}
th{color:var(--dim);font-weight:500}.revoked{color:var(--bad)}.active{color:var(--ok)}
code{background:#12121f;padding:.15rem .4rem;border-radius:6px;font-size:.85rem}
.flash{background:#12321a;border:1px solid #1f5c33;color:var(--ok);padding:.75rem 1rem;border-radius:10px;margin-bottom:1rem;font-size:.9rem;white-space:pre-wrap;word-break:break-all}
h2{font-size:1rem;margin:0 0 .75rem;color:var(--dim)}
.copy{font-size:.8rem;color:var(--dim);margin-top:.5rem}
</style></head><body><div class="wrap">
<h1>paginate-pub admin</h1>
<p class="sub">signed in as ${esc(email)} — issue a token, paste the command into Claude Code</p>
${flash ? `<div class="flash">${esc(flash)}</div>` : ""}
<div class="card"><h2>Issue my Claude Code token</h2>
<form method="post" action="/issue">
<label for="name">Token label (optional, e.g. "laptop")</label>
<input id="name" name="name" maxlength="40" placeholder="my laptop">
<button type="submit">Generate token &amp; setup command</button>
</form>
<div class="copy">The token is shown once and stored only as a SHA-256 hash. You can revoke it below at any time.</div>
</div>
<div class="card"><h2>Your tokens</h2>
<table><tr><th>label</th><th>created</th><th>last used</th><th>status</th><th></th></tr>
${tokens.map((t) => `<tr>
<td>${esc(t.name || "(none)")}</td><td>${esc(t.created_at.slice(0, 10))}</td>
<td>${t.last_used_at ? esc(t.last_used_at.slice(0, 10)) : "—"}</td>
<td class="${t.revoked ? "revoked" : "active"}">${t.revoked ? "revoked" : "active"}</td>
<td>${t.revoked ? "" : `<form method="post" action="/revoke"><input type="hidden" name="id" value="${t.id}"><button class="danger" type="submit">revoke</button></form>`}</td>
</tr>`).join("") || `<tr><td colspan="5" style="color:var(--dim)">no tokens yet</td></tr>`}
</table></div>
</div></body></html>`;

function esc(s: any): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// ---- router for admin.<domain> ----
export async function handleAdminSite(request: Request, env: AdminSiteEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  // verify Access JWT on every request
  const identity = await verifyAccessJwt(request, env);
  if (!identity) {
    return new Response("admin: Cloudflare Access authentication required", { status: 401 });
  }
  const email = identity.email;

  // Rate limit mutating actions per identity (W4): 20 actions / 10 min.
  // Same D1-counter pattern as the per-page API (in-memory buckets are
  // per-isolate in Workers and never fire).
  if (request.method === "POST") {
    const window = Math.floor(Date.now() / (10 * 60_000)); // 10-min window number
    const r = await env.DB.prepare(
      `INSERT INTO rate_limit (k, window, n) VALUES (?, ?, 1)
       ON CONFLICT(k, window) DO UPDATE SET n = n + 1 RETURNING n`,
    ).bind(`admin:${email}`, window).first<{ n: number }>();
    if ((r?.n ?? 1) > 20) {
      return new Response("too many attempts — try again in a few minutes", { status: 429 });
    }
  }

  // GET: page
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
    const tokens = (await listTokens(env)).filter((t) => t.email === email);
    return new Response(PAGE(email, tokens, ""), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  }

  // POST /issue
  if (request.method === "POST" && url.pathname === "/issue") {
    const form = new URLSearchParams(await request.text());
    const name = (form.get("name") ?? "").slice(0, 40);
    const { token } = await issueToken(env, email, name);
    // CLI setup (header auth — canonical): Claude Code in a terminal or the
    // desktop app. The command embeds the real token (shown once, this page).
    const cmd = `claude mcp add --transport http paginate-pub ${env.MCP_BASE}/mcp --header "Authorization: Bearer ${token}"`;
    // Browser setup (claude.ai custom connector): browser connectors can't
    // send custom headers, so the user token rides in the URL. User-role only
    // — the owner secret never authenticates via URL (bearerOk reads headers).
    const webUrl = `${env.MCP_BASE}/mcp?tk=${token}`;
    const tokens = (await listTokens(env)).filter((t) => t.email === email);
    return new Response(PAGE(email, tokens,
      `Your token (shown once — copy it now):\n${token}\n\n` +
      `CLAUDE CODE (terminal or desktop app) — run this:\n${cmd}\n\n` +
      `CLAUDE IN A BROWSER (claude.ai, experimental) — Settings → Connectors → Add custom connector, and use this URL instead:\n${webUrl}\n\n` +
      `Same token, same access either way. Revoke it below if it leaks.`), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  }

  // POST /revoke
  if (request.method === "POST" && url.pathname === "/revoke") {
    const form = new URLSearchParams(await request.text());
    const id = parseInt(form.get("id") ?? "", 10);
    if (!Number.isFinite(id)) return new Response("bad id", { status: 400 });
    // only allow revoking your own tokens
    const row = await env.DB.prepare("SELECT email FROM mcp_tokens WHERE id = ?").bind(id).first<{ email: string }>();
    if (!row || row.email !== email) return new Response("not yours", { status: 403 });
    await revokeToken(env, id);
    return new Response(null, { status: 303, headers: { Location: "/" } });
  }

  return new Response("not found", { status: 404 });
}