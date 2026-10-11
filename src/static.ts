// src/static.ts — serve content-addressed assets from KV with immutable caching.
//
// URL shape: /s/<slug>/<hash16>/  ->  KV key <visibility>/<slug>/<hash16>/index.html
// Everything under a /<hash16>/ segment is immutable by construction, so we
// serve it with `Cache-Control: public, max-age=31536000, immutable` — the
// browser cache and Cloudflare edge do all the heavy lifting.

export const HASH_RE = /^\/s\/([a-z0-9][a-z0-9-]*)\/([0-9a-f]{16})(\/[^?]*)?$/;

export function isImmutablePath(pathname: string): boolean {
  return HASH_RE.test(pathname);
}

export function cacheHeaders(pathname: string): Record<string, string> {
  return isImmutablePath(pathname)
    ? { "Cache-Control": "public, max-age=31536000, immutable" }
    : { "Cache-Control": "no-store" };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
};

export function contentTypeFor(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  // MIME is keyed WITH the leading dot (".css"); m[1] is the bare ext ("css").
  return MIME["." + (m?.[1] ?? "").toLowerCase()] ?? "application/octet-stream";
}

// Minimum CSP for published demo pages: no external fetches by default,
// inline styles allowed (demos love them), scripts only from self.
export const ASSET_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

export interface ServeEnv {
  CACHE: KVNamespace;
  ANALYTICS_ENGINE?: AnalyticsEngineDataset;
}

/**
 * Serve a request from KV. `visibility` is derived from the hostname by the
 * caller ('public' on pub.<domain>, 'private' on private.<domain> and any
 * group subdomain). Returns null on miss so the caller can 404.
 */
export async function serveAsset(
  env: ServeEnv,
  request: Request,
  visibility: "public" | "private",
  ctx?: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  const m = HASH_RE.exec(url.pathname);
  if (!m) return null;
  let [, slug, hash, suffix] = m;
  // Published objects are stored at "<visibility>/<slug>/<hash>" (no file
  // suffix): the whole asset IS the index. Sub-paths under the hash are
  // separate objects ("<visibility>/<slug>/<hash><suffix>"). Directory-style
  // URLs ("/s/<slug>/<hash>/" or "/s/<slug>/<hash>") map to the index object.
  let key: string;
  if (suffix === undefined || suffix === "/" || suffix === "") {
    // The canonical object is "<visibility>/<slug>/<hash>" (the asset IS the
    // index). Very old publishes used "...<hash>/index.html" — fall back to it.
    key = `${visibility}/${slug}/${hash}`;
    const primary = await env.CACHE.getWithMetadata(key, "arrayBuffer");
    if (primary.value !== null) {
      return respondWith(primary.value, (primary.metadata ?? {}) as { contentType?: string }, key, slug, hash, visibility, request, env, ctx, url);
    }
    key = `${visibility}/${slug}/${hash}/index.html`;
  } else {
    key = `${visibility}/${slug}/${hash}${suffix}`;
  }

  const res = await env.CACHE.getWithMetadata(key, "arrayBuffer");
  if (res.value === null) return null;
  return respondWith(res.value, (res.metadata ?? {}) as { contentType?: string }, key, slug, hash, visibility, request, env, ctx, url);
}

function respondWith(
  value: ArrayBuffer,
  objMetadata: { contentType?: string },
  key: string,
  slug: string,
  hash: string,
  visibility: "public" | "private",
  request: Request,
  env: ServeEnv,
  ctx?: ExecutionContext,
  url?: URL,
): Response {
  // fire-and-forget analytics data point (per-asset hit + bytes)
  const writePoint = () => {
    try {
      env.ANALYTICS_ENGINE?.writeDataPoint({
        blobs: [slug, hash, visibility, new URL(request.url).pathname],
        doubles: [value.byteLength],
        indexes: [slug],
      });
    } catch { /* analytics must never break serving */ }
  };
  if (ctx) ctx.waitUntil(Promise.resolve().then(writePoint));
  else writePoint();

  const headers: Record<string, string> = {
    // KV-stored assets were written with an explicit contentType; honor it.
    // Fall back to extension-based detection for anything without metadata.
    // Canonical new objects carry no file extension, so prefer the stored
    // KV contentType; for extension-less legacy keys default to text/html
    // (published assets are HTML pages); otherwise use the extension map.
    "Content-Type":
      objMetadata.contentType ??
      (/\.[a-z0-9]+$/i.test(key) ? contentTypeFor(key) : "text/html; charset=utf-8"),
    ...cacheHeaders((url ?? new URL(request.url)).pathname),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": ASSET_CSP,
    "Referrer-Policy": "no-referrer",
  };
  return new Response(value, { status: 200, headers });
}
