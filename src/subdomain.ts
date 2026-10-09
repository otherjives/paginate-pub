// src/subdomain.ts — one-shot subdomain provisioning + group launcher.
//
// provision_subdomain:
//   1. create proxied DNS A record (Workers-managed record is AAAA-only; the
//      dashboard/API refuses a duplicate A on a Workers-managed host — so we
//      attach the Worker custom domain FIRST, which creates the managed
//      record, and skip creating our own A)
//   2. attach the hostname as a Worker custom domain (exact hostnames only —
//      no wildcards)
//   3. optionally create an Access app protecting the host for a group
//   4. track everything in D1 `subdomains`
//
// launch_group: create group + provision N subdomains + publish N pages +
// wire access — the friend's "one-shot an idea".

import { CfClient } from "./cf";
import { ensureGroup, grantAccess, assetAppDomain } from "./access";
import { slugify, sha256Hex16, assetKey, logOp, jsonText, errText, type PageRow } from "./util";

export interface SubEnv {
  DB: D1Database;
  CACHE: KVNamespace;
  CF_API_TOKEN: string;
  ACCOUNT_ID: string;
  ZONE_ID: string;
  DOMAIN: string;
  PUBLIC_BASE: string;
  PRIVATE_BASE: string;
  WORKER_NAME: string;
}

// Attach a hostname to this Worker (exact custom domain). Idempotent.
export async function attachWorkerDomain(env: SubEnv, host: string) {
  const cf = new CfClient(env);
  const domains = await cf.listWorkerDomains();
  const existing = (domains as any[]).find((d) => d.hostname === host && d.service === env.WORKER_NAME);
  if (existing) return { id: existing.id, created: false };
  const d = await cf.putWorkerDomain(host, env.WORKER_NAME);
  return { id: d.id, created: true };
}

export async function provisionSubdomain(
  env: SubEnv,
  name: string,
  opts: { purpose?: "asset" | "group" | "email"; asset_slug?: string; group?: string; protect?: boolean } = {},
) {
  const cf = new CfClient(env);
  const host = `${name}.${env.DOMAIN}`.toLowerCase();

  // 1. attach as Worker custom domain (this creates the Workers-managed DNS)
  const dom = await attachWorkerDomain(env, host);

  // 2. optional Access protection for the whole host
  let cfAppId: string | null = null;
  if (opts.protect && opts.group) {
    const group = await ensureGroup(env as any, opts.group, []);
    if (!group.cf_group_id) throw new Error(`group '${opts.group}' has no Cloudflare id`);
    const app = await cf.createAccessApp({
      name: `paginate-pub [${host}]${opts.group ? ` ${opts.group}` : ""}`,
      domain: host,
      type: "self_hosted",
      session_duration: "24h",
      auto_redirect_to_identity: false,
    });
    await cf.createAccessPolicy(app.id, {
      name: "paginate-pub-grant",
      decision: "allow",
      include: [{ group: { id: group.cf_group_id } }],
      precedence: 1,
    });
    cfAppId = app.id;
  }

  // 3. record in D1
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO subdomains (host, purpose, asset_slug, group_id, cf_app_id, dns_ok, ssl, created_at)
     VALUES (?, ?, ?, ?, ?, 1, 'provisioning', ?)
     ON CONFLICT(host) DO UPDATE SET purpose=excluded.purpose, asset_slug=excluded.asset_slug,
       group_id=excluded.group_id, cf_app_id=excluded.cf_app_id`,
  ).bind(
    host,
    opts.purpose ?? "asset",
    opts.asset_slug ?? null,
    opts.group ? (await env.DB.prepare("SELECT id FROM groups_t WHERE name = ?").bind(opts.group).first<{ id: number }>())?.id ?? null : null,
    cfAppId,
    now,
  ).run();

  return { host, url: `https://${host}/`, worker_domain: dom, access_app_id: cfAppId };
}

export interface LaunchSpec {
  group_name: string;
  emails: string[];
  subdomains?: Array<{ name: string; purpose?: "asset" | "group" | "email"; asset_slug?: string }>;
  pages?: Array<{ title: string; slug?: string; html: string; visibility?: "public" | "private" }>;
}

export async function launchGroup(env: SubEnv, spec: LaunchSpec) {
  const steps: any[] = [];

  // 1. group
  const group = await ensureGroup(env as any, spec.group_name, spec.emails);
  steps.push({ step: "group", group: group.name, emails: spec.emails });

  // 2. pages (publish each; private ones get granted to the group)
  const published: any[] = [];
  for (const p of spec.pages ?? []) {
    const s = slugify(p.slug ?? p.title);
    const hash = await sha256Hex16(p.html);
    const visibility = p.visibility ?? "private";
    const key = assetKey(visibility, s, hash);
    await env.CACHE.put(key, p.html, { contentType: "text/html; charset=utf-8" });
    if ((await env.CACHE.get(key)) === null) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const base = visibility === "public" ? env.PUBLIC_BASE : env.PRIVATE_BASE;
    const url = `${base}/s/${s}/${hash}/`;
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO pages (slug, title, visibility, hash, url, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(s, p.title, visibility, hash, url, new TextEncoder().encode(p.html).byteLength, now).run();
    if (visibility === "private") {
      await grantAccess(env as any, s, spec.group_name, []);
    }
    published.push({ slug: s, hash, url, visibility });
    steps.push({ step: "publish", slug: s, url });
  }

  // 3. subdomains
  const subs: any[] = [];
  for (const sd of spec.subdomains ?? []) {
    const r = await provisionSubdomain(env, sd.name, {
      purpose: sd.purpose ?? "group",
      asset_slug: sd.asset_slug,
      group: spec.group_name,
      protect: true,
    });
    subs.push(r);
    steps.push({ step: "subdomain", ...r });
  }

  await logOp(env.DB, "launch_group", { group: spec.group_name, pages: published.length, subdomains: subs.length }, true);
  return {
    group: group.name,
    emails: spec.emails,
    pages: published,
    subdomains: subs,
    steps,
    note: "Subdomain SSL certificates provision automatically (a few minutes). Private pages require each member to sign in with a one-time PIN sent to their email.",
  };
}

import { z } from "zod";
export function registerSubdomainTools(server: any, env: SubEnv) {

  server.registerTool(
    "provision_subdomain",
    {
      title: "Launch a subdomain",
      description:
        "Put a subdomain live on the Worker. Optionally protect the whole host so " +
        "only a group can reach it. Returns the https URL (SSL provisions in a few minutes).",
      inputSchema: {
        name: z.string().describe("Subdomain label, e.g. 'demo' for demo.paginate.dev"),
        purpose: z.enum(["asset", "group", "email"]).optional(),
        protect: z.boolean().optional().describe("Require group sign-in to reach this host."),
        group: z.string().optional().describe("Group to protect with (required if protect=true)."),
        asset_slug: z.string().optional().describe("If this host serves one published page, its slug."),
      },
    },
    async ({ name, purpose, protect, group, asset_slug }: any) => {
      try {
        const clean = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
        if (!clean) return errText("invalid subdomain name");
        const r = await provisionSubdomain(env, clean, { purpose, protect, group, asset_slug });
        await logOp(env.DB, "provision_subdomain", r, true);
        return jsonText(r);
      } catch (e) {
        await logOp(env.DB, "provision_subdomain", { error: String(e) }, false);
        return errText(String(e));
      }
    },
  );

  server.registerTool(
    "launch_group",
    {
      title: "One-shot launch a group's pages and subdomains",
      description:
        "The big red button. Creates a group of people, publishes a set of pages " +
        "(private by default, granted to the group), and stands up protected " +
        "subdomains for them. Pass emails, pages (with html), and subdomain names; " +
        "get back a manifest with every URL.",
      inputSchema: {
        group_name: z.string(),
        emails: z.array(z.string()),
        pages: z.array(z.object({
          title: z.string(),
          slug: z.string().optional(),
          html: z.string(),
          visibility: z.enum(["public", "private"]).optional(),
        })).optional(),
        subdomains: z.array(z.object({
          name: z.string(),
          purpose: z.enum(["asset", "group", "email"]).optional(),
          asset_slug: z.string().optional(),
        })).optional(),
      },
    },
    async (spec: LaunchSpec) => {
      try {
        return jsonText(await launchGroup(env, spec));
      } catch (e) {
        await logOp(env.DB, "launch_group", { error: String(e) }, false);
        return errText(String(e));
      }
    },
  );
}
