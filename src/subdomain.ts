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
  opts: {
    purpose?: "asset" | "group" | "email";
    asset_slug?: string;
    group?: string;
    protect?: boolean;
    security?: "open" | "access" | "private";
    owner_email?: string;
    visibility?: "public" | "private";
  } = {},
) {
  const cf = new CfClient(env);
  const host = `${name}.${env.DOMAIN}`.toLowerCase();
  const security = opts.security ?? (opts.protect ? "access" : "open");

  // 1. attach as Worker custom domain (this creates the Workers-managed DNS)
  const dom = await attachWorkerDomain(env, host);

  // 2. Access protection (security='access'): owner email (+group) allow
  //    policy, plus a /x/* BYPASS policy so capability share links reach the
  //    Worker (the Worker validates the token itself).
  let cfAppId: string | null = null;
  if (security === "access") {
    const group = opts.group ? await ensureGroup(env as any, opts.group, []) : null;
    if (!opts.owner_email && !group) {
      throw new Error("security='access' needs owner_email and/or group");
    }
    const app = await cf.createAccessApp({
      name: `paginate-pub [${host}]`,
      domain: host,
      type: "self_hosted",
      session_duration: "24h",
      auto_redirect_to_identity: false,
    });
    const include: any[] = [];
    if (opts.owner_email) include.push({ email: { email: opts.owner_email } });
    if (group?.cf_group_id) include.push({ group: { id: group.cf_group_id } });
    await cf.createAccessPolicy(app.id, {
      name: "site-owner",
      decision: "allow",
      include,
      precedence: 1,
    });
    // share-link bypass: a SECOND app scoped to <host>/x with a bypass policy
    // (ip 0.0.0.0/0 + ::/0) lets token URLs reach the Worker, which validates
    // the token itself. ('everyone' is not a valid bypass include; ip ranges
    // are the canonical everyone-shape.)
    try {
      const xapp = await cf.createAccessApp({
        name: `paginate-pub [${host}] share links`,
        domain: `${host}/x`,
        type: "self_hosted",
        session_duration: "24h",
      });
      await cf.createAccessPolicy(xapp.id, {
        name: "share-links-bypass",
        decision: "bypass",
        include: [{ ip: { ip: "0.0.0.0/0" } }, { ip: { ip: "::/0" } }],
        precedence: 1,
      });
    } catch { /* non-fatal: share links also always work via private.<domain>/x/ */ }
    cfAppId = app.id;
  }

  // 3. record in D1
  const now = new Date().toISOString();
  const gid = opts.group
    ? (await env.DB.prepare("SELECT id FROM groups_t WHERE name = ?").bind(opts.group).first<{ id: number }>())?.id ?? null
    : null;
  await env.DB.prepare(
    `INSERT INTO subdomains (host, purpose, asset_slug, group_id, cf_app_id, dns_ok, ssl, security, owner_email, visibility, created_at)
     VALUES (?, ?, ?, ?, ?, 1, 'provisioning', ?, ?, ?, ?)
     ON CONFLICT(host) DO UPDATE SET purpose=excluded.purpose, asset_slug=excluded.asset_slug,
       group_id=excluded.group_id, cf_app_id=excluded.cf_app_id, security=excluded.security,
       owner_email=excluded.owner_email, visibility=excluded.visibility`,
  ).bind(
    host,
    opts.purpose ?? "asset",
    opts.asset_slug ?? null,
    gid,
    cfAppId,
    security,
    opts.owner_email ?? null,
    opts.visibility ?? (security === "open" ? "public" : "private"),
    now,
  ).run();

  return {
    host,
    url: `https://${host}/`,
    security,
    worker_domain: dom,
    access_app_id: cfAppId,
    note: security === "open"
      ? "This host is publicly reachable — anyone with the URL can view it."
      : `Owner signs in via email one-time PIN. Capability share links live on private.${env.DOMAIN}/x/<token>/ — they also pass this gate via the /x/* bypass policy.`,
  };
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
        security: z.enum(["open", "access", "private"]).optional().describe(
          "'open' = anyone can reach this host (no gate at all). " +
          "'access' = owner signs in with an email one-time PIN; share links still work via the /x/ bypass. " +
          "'private' = like access but group-only. Default 'open'. ('password' mode is planned.)"
        ),
        owner_email: z.string().optional().describe("Site owner's email — they sign in with an email PIN (security='access')."),
        group: z.string().optional().describe("Group to also allow (optional, with security='access'/'private')."),
        protect: z.boolean().optional().describe("Legacy flag — same as security='access'."),
        asset_slug: z.string().optional().describe("If this host serves one published page, its slug."),
      },
    },
    async ({ name, purpose, protect, group, asset_slug, security, owner_email }: any) => {
      try {
        const clean = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
        if (!clean) return errText("invalid subdomain name");
        const r = await provisionSubdomain(env, clean, {
          purpose, protect, group, asset_slug,
          security: security ?? (protect ? "access" : undefined),
          owner_email,
        });
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
