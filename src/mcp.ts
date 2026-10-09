// src/mcp.ts — stateless MCP server factory (Agents SDK v2 handler API).
// Tools registered here are Phase B core: publish/list/get/delete/set_visibility.

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CfClient } from "./cf";
import { serveAsset } from "./static"; // re-exported for tests
import { slugify, sha256Hex16, assetKey, logOp, jsonText, errText, type PageRow } from "./util";
import { registerAccessTools } from "./access";
import { registerEmailTools } from "./email";
import { registerSubdomainTools } from "./subdomain";
import { registerStatusTools } from "./status";
import { registerAdminTools } from "./admin";

export interface ToolEnv {
  DB: D1Database;
  CACHE: KVNamespace;
  ANALYTICS_ENGINE?: AnalyticsEngineDataset;
  CF_API_TOKEN: string;
  ACCOUNT_ID: string;
  ZONE_ID: string;
  DOMAIN: string;
  PUBLIC_BASE: string;
  PRIVATE_BASE: string;
  EMAIL?: SendEmail;
}

function baseFor(visibility: "public" | "private", env: ToolEnv): string {
  return visibility === "public" ? env.PUBLIC_BASE : env.PRIVATE_BASE;
}

export function createServer(env: ToolEnv) {
  const server = new McpServer({ name: "paginate-pub", version: "1.0.0" });
  const cf = new CfClient(env);

  // ---------- publish_page ----------
  server.registerTool(
    "publish_page",
    {
      title: "Publish an HTML page",
      description:
        "Publish a self-contained HTML page to the web and get back its permanent URL. " +
        "The page is stored content-addressed (its URL never changes for the same content), " +
        "so it is safe to share and cache forever. Use visibility 'public' for demos anyone can see, " +
        "or 'private' for pages only you (or a group you grant) can see.",
      inputSchema: {
        html: z.string().describe("Complete, self-contained HTML document (inline CSS/JS preferred)."),
        title: z.string().optional().describe("Short human title for the page."),
        slug: z.string().optional().describe("Short kebab-case URL name, e.g. 'my-demo'. Defaults to a slug from the title."),
        visibility: z.enum(["public", "private"]).default("public").describe("'public' = anyone with the link; 'private' = only you / granted groups."),
      },
    },
    async ({ html, title, slug, visibility }) => {
      try {
        const s = slugify(slug ?? title ?? "page");
        const hash = await sha256Hex16(html);
        // Canonical KV key for a published asset: <visibility>/<slug>/<hash>
        const key = assetKey(visibility, s, hash);
        const size = new TextEncoder().encode(html).byteLength;

        await env.CACHE.put(key, html, { contentType: "text/html; charset=utf-8" });
        // verify read-after-write (KV is occasionally briefly inconsistent)
        if ((await env.CACHE.get(key)) === null) {
          await new Promise((r) => setTimeout(r, 250));
          if ((await env.CACHE.get(key)) === null) throw new Error("KV write did not verify");
        }

        // Self-heal: if the same content was previously published under the
        // legacy key layout (<hash>/index.html), remove that stale copy so
        // every version of an asset lives at exactly one key. Safe: the
        // content is identical (same hash), and the canonical key now serves.
        const legacyKey = assetKey(visibility, s, hash, "/index.html");
        if (legacyKey !== key) {
          try { await env.CACHE.delete(legacyKey); } catch { /* best effort */ }
        }

        const url = `${baseFor(visibility, env)}/s/${s}/${hash}/`;
        const now = new Date().toISOString();
        await env.DB.prepare(
          "INSERT INTO pages (slug, title, visibility, hash, url, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).bind(s, title ?? null, visibility, hash, url, size, now).run();

        await logOp(env.DB, "publish_page", { slug: s, hash, visibility, url, size }, true);
        return jsonText({ url, slug: s, hash, visibility, size_bytes: size });
      } catch (e) {
        await logOp(env.DB, "publish_page", { error: String(e) }, false);
        return errText(String(e));
      }
    },
  );

  // ---------- list_assets ----------
  server.registerTool(
    "list_assets",
    {
      title: "List published assets",
      description: "Full summary of everything published: slug, title, visibility, URL, size, created date. Filter by visibility if you like.",
      inputSchema: {
        visibility: z.enum(["public", "private"]).optional(),
      },
    },
    async ({ visibility }) => {
      try {
        const q = visibility
          ? "SELECT * FROM pages WHERE visibility = ? ORDER BY created_at DESC LIMIT 200"
          : "SELECT * FROM pages ORDER BY created_at DESC LIMIT 200";
        const res = visibility
          ? await env.DB.prepare(q).bind(visibility).all<PageRow>()
          : await env.DB.prepare(q).all<PageRow>();
        return jsonText({ count: res.results.length, assets: res.results });
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  // ---------- get_asset ----------
  server.registerTool(
    "get_asset",
    {
      title: "Get one asset",
      description: "Metadata for a single published page by slug (latest version if hash not given).",
      inputSchema: {
        slug: z.string(),
        hash: z.string().optional(),
      },
    },
    async ({ slug, hash }) => {
      try {
        const res = hash
          ? await env.DB.prepare("SELECT * FROM pages WHERE slug = ? AND hash = ?").bind(slug, hash).all<PageRow>()
          : await env.DB.prepare("SELECT * FROM pages WHERE slug = ? ORDER BY created_at DESC LIMIT 1").bind(slug).all<PageRow>();
        if (!res.results.length) return errText(`No asset with slug '${slug}'`);
        return jsonText(res.results[0]);
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  // ---------- delete_page ----------
  server.registerTool(
    "delete_page",
    {
      title: "Delete a published page",
      description: "Delete a page (one version by hash, or all versions of a slug) from storage and records.",
      inputSchema: {
        slug: z.string(),
        hash: z.string().optional().describe("Delete only this version; omit to delete all versions of the slug."),
      },
    },
    async ({ slug, hash }) => {
      try {
        const rows = hash
          ? (await env.DB.prepare("SELECT * FROM pages WHERE slug = ? AND hash = ?").bind(slug, hash).all<PageRow>()).results
          : (await env.DB.prepare("SELECT * FROM pages WHERE slug = ?").bind(slug).all<PageRow>()).results;
        if (!rows.length) return errText(`No asset with slug '${slug}'`);
        for (const r of rows) {
          await env.CACHE.delete(assetKey(r.visibility, r.slug, r.hash));
        }
        if (hash) {
          await env.DB.prepare("DELETE FROM pages WHERE slug = ? AND hash = ?").bind(slug, hash).run();
        } else {
          await env.DB.prepare("DELETE FROM pages WHERE slug = ?").bind(slug).run();
          await env.DB.prepare("DELETE FROM assets_groups WHERE slug = ?").bind(slug).run();
        }
        await logOp(env.DB, "delete_page", { slug, hash: hash ?? "*", removed: rows.length }, true);
        return jsonText({ deleted: rows.length, slug, hash: hash ?? "*" });
      } catch (e) {
        await logOp(env.DB, "delete_page", { error: String(e) }, false);
        return errText(String(e));
      }
    },
  );

  // ---------- set_visibility (public <-> private move) ----------
  server.registerTool(
    "set_visibility",
    {
      title: "Make a page public or private",
      description:
        "Move a published page between public and private. Moving to private copies it under the private host " +
        "(the old public URL stops working immediately). Moving back to public copies it to the public host and " +
        "removes the private copy. Optionally grant a group when making private.",
      inputSchema: {
        slug: z.string(),
        hash: z.string().optional().describe("Which version; defaults to the latest."),
        to: z.enum(["public", "private"]),
        group: z.string().optional().describe("Group name to grant access to when making private."),
      },
    },
    async ({ slug, hash, to, group }) => {
      try {
        // Resolve the version: explicit hash wins; otherwise the most recent
        // version of the slug REGARDLESS of its current visibility (moving a
        // page public<->private must find it wherever it currently lives).
        const row = hash
          ? (await env.DB.prepare("SELECT * FROM pages WHERE slug = ? AND hash = ?").bind(slug, hash).first<PageRow>())
          : (await env.DB.prepare("SELECT * FROM pages WHERE slug = ? ORDER BY created_at DESC, id DESC LIMIT 1").bind(slug).first<PageRow>());
        if (!row) return errText(`No asset with slug '${slug}'`);
        // "already" only counts when EVERY version of the slug is at the target
        // visibility (a split slug must still move its stragglers).
        const notAtTarget = (await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM pages WHERE slug = ? AND visibility != ?",
        ).bind(slug, to).first<{ n: number }>())?.n ?? 0;
        if (notAtTarget === 0) return jsonText({ already: true, slug, hash: row.hash, visibility: to });

        const html = await env.CACHE.get(assetKey(row.visibility, row.slug, row.hash));
        if (html === null) return errText("Stored content missing; cannot move.");

        // copy to the new visibility prefix
        await env.CACHE.put(assetKey(to, row.slug, row.hash), html, { contentType: "text/html; charset=utf-8" });
        // remove the old copy (old URL stops working immediately)
        await env.CACHE.delete(assetKey(row.visibility, row.slug, row.hash));

        // Move every version of this slug so the slug always resolves to one
        // visibility (the friend thinks in slugs, not hashes). Only versions
        // whose current visibility differs from the target need moving.
        const versions = (await env.DB.prepare(
          "SELECT * FROM pages WHERE slug = ? AND visibility != ? ORDER BY created_at ASC, id ASC",
        ).bind(slug, to).all<PageRow>()).results;
        if (!versions.length) {
          return jsonText({ moved: false, slug, to, note: "all versions already at target visibility" });
        }

        const moved: Array<{ hash: string; url: string }> = [];
        for (const v of versions) {
          // KV reads can be briefly inconsistent across PoPs right after a
          // publish — retry once before deciding the content is missing.
          let html = await env.CACHE.get(assetKey(v.visibility, v.slug, v.hash));
          if (html === null) {
            await new Promise((r) => setTimeout(r, 300));
            html = await env.CACHE.get(assetKey(v.visibility, v.slug, v.hash));
          }
          if (html === null) continue; // content genuinely missing; skip but keep row
          await env.CACHE.put(assetKey(to, v.slug, v.hash), html, { contentType: "text/html; charset=utf-8" });
          await env.CACHE.delete(assetKey(v.visibility, v.slug, v.hash));
          const newUrl = `${baseFor(to, env)}/s/${v.slug}/${v.hash}/`;
          await env.DB.prepare("UPDATE pages SET visibility = ?, url = ? WHERE id = ?").bind(to, newUrl, v.id).run();
          moved.push({ hash: v.hash, url: newUrl });
        }
        const newUrl = `${baseFor(to, env)}/s/${row.slug}/${row.hash}/`;

        // If moving to private and a group is named, grant it real Access access.
        let groupGranted: string | null = null;
        if (to === "private" && group) {
          try {
            const { grantAccess } = await import("./access");
            await grantAccess(env as any, slug, group);
            groupGranted = group;
          } catch (e) {
            // non-fatal: the page is private; the grant can be retried with grant_access
            await logOp(env.DB, "set_visibility:grant_failed", { slug, group, error: String(e) }, false);
          }
        }

        await logOp(env.DB, "set_visibility", { slug, from: row.visibility, to, versions_moved: moved.length, group: group ?? null }, true);
        return jsonText({ moved: true, slug, from: row.visibility, to, versions_moved: moved.length, latest: { hash: row.hash, url: newUrl }, urls: moved, group_granted: groupGranted });
      } catch (e) {
        await logOp(env.DB, "set_visibility", { error: String(e) }, false);
        return errText(String(e));
      }
    },
  );

  // Phase C: access control tools (groups, grant/revoke, users)
  registerAccessTools(server, env);

  // Phase D: email tools (verified-destination-only sending by default)
  registerEmailTools(server, env);

  // Phase E: subdomain provisioning + launch_group
  (registerSubdomainTools as any)(server, { ...env, WORKER_NAME: "paginate-pub" });

  // Phase F: status / audit / leak tools
  registerStatusTools(server, env);

  // Phase F2: admin tools (DNS, secrets, token rotation, ops log, create_db)
  (registerAdminTools as any)(server, { ...env, WORKER_NAME: "paginate-pub" });

  return server;
}

// re-export for index router tests
export { serveAsset };
