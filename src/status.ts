// src/status.ts — high-level status: charges, pending, history, usage, seats,
// plus the leak audit. Powers get_status, audit_leaks, fix_leak, and the
// watch_costs cron.

import { CfClient } from "./cf";
import { assetKey, logOp, jsonText, errText } from "./util";

export interface StatusEnv {
  DB: D1Database;
  CACHE: KVNamespace;
  CF_API_TOKEN: string;
  ACCOUNT_ID: string;
  ZONE_ID: string;
  DOMAIN: string;
  PRIVATE_BASE: string;
  ANALYTICS_ENGINE?: AnalyticsEngineDataset;
  EMAIL?: SendEmail;
}

// ---- usage counters (self-metered; updated on each request via waitUntil) ----
export async function bumpCounter(db: D1Database, key: string, by = 1) {
  try {
    await db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + ?",
    ).bind(key, String(by), String(by)).run();
  } catch { /* counters must never break requests */ }
}

async function getCounter(db: D1Database, key: string): Promise<number> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return r ? parseInt(r.value, 10) || 0 : 0;
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---- get_status ----
export async function getStatus(env: StatusEnv) {
  const cf = new CfClient(env);
  const today = todayUTC();

  // billing history + subscriptions (real charges; verified working with this token)
  const [history, subs] = await Promise.all([
    cf.billingHistory().catch(() => []),
    cf.listSubscriptions().catch(() => []),
  ]);
  const invoices = (history as any[])
    .filter((h) => h.type === "invoice")
    .map((h) => ({
      occurred_at: h.occurred_at,
      amount: h.amount ?? h.amount_to_pay ?? 0,
      currency: (h.currency ?? "usd").toUpperCase(),
      paid: (h.amount_remaining ?? 0) === 0,
      description: h.description ?? "",
    }));
  const thisMonth = invoices.filter((i) => i.occurred_at.slice(0, 7) === today.slice(0, 7));
  const thisMonthSpend = thisMonth.reduce((s, i) => s + (i.amount || 0), 0);
  const pending = invoices.filter((i) => !i.paid);

  const subscriptions = (subs as any[]).map((s) => ({
    plan: s.rate_plan?.public_name ?? s.rate_plan?.id,
    price: s.price ?? 0,
    currency: s.rate_plan?.currency ?? "USD",
    state: s.state,
    users: (s.component_values ?? []).find((c: any) => c.name === "users")?.value,
  }));

  // self-metered usage for today
  const reqToday = await getCounter(env.DB, `req:${today}`);
  // (AE writes / emails are not self-metered — Workers usage comes from the CF API)

  // D1 row counts are the storage proxy (KV has no cheap size API; keys aren't counted)
  // D1 tables/pages count
  const pageCount = (await env.DB.prepare("SELECT COUNT(*) AS n FROM pages").first<{ n: number }>())?.n ?? 0;
  const groupCount = (await env.DB.prepare("SELECT COUNT(*) AS n FROM groups_t").first<{ n: number }>())?.n ?? 0;
  const subCount = (await env.DB.prepare("SELECT COUNT(*) AS n FROM subdomains").first<{ n: number }>())?.n ?? 0;

  // seats (Zero Trust; free tier 50)
  const ztUsers = await cf.listZtUsers().catch(() => [] as any[]);
  const seatsUsed = (ztUsers as any[]).filter((u) => u.seat === true || u.seat === "active").length;

  // alerts: anything over 80% of a free tier
  const alerts: string[] = [];
  if (reqToday > 80_000) alerts.push(`Workers requests today ${reqToday} approaching the 100k/day free limit.`);
  if (seatsUsed >= 40) alerts.push(`Zero Trust seats ${seatsUsed}/50 — past 50 becomes pay-as-you-go (~$7/user/mo).`);
  if (pending.length) alerts.push(`${pending.length} unpaid invoice(s) pending.`);
  if (thisMonthSpend > 0) alerts.push(`This month's spend so far: $${thisMonthSpend.toFixed(2)} (domain renewal is the expected item).`);

  return {
    domain: env.DOMAIN,
    plan: "Workers Free + Zero Trust Free (50 users)", // assumed free-tier plan; thresholds below are free-tier limits
    spend: {
      this_month_usd: Number(thisMonthSpend.toFixed(2)),
      pending_invoices: pending.length,
      history: invoices.slice(0, 12),
    },
    subscriptions,
    usage: {
      workers_requests_today: reqToday,
      workers_free_limit_per_day: 100_000,
      // AE writes / emails sent: not self-metered; see the CF API usage below
      email_note: "Free only to verified destination addresses; arbitrary recipients require Workers Paid ($5/mo).",
      pages_published: pageCount,
      groups: groupCount,
      subdomains: subCount,
    },
    seats: { used: seatsUsed, free_tier: 50 },
    alerts,
  };
}

// ---- leak audit ----
// Rules:
//  1. db_bindings visibility mismatch: a public asset bound to a private DB or vice versa.
//  2. private asset missing an Access app (private page with no grant = locked out
//     for everyone except via the private host's blanket policy).
//  3. Access app on the private host with an "allow anyone" (email OTP) policy —
//     that makes a private prefix effectively public.
//  4. same slug+hash present in BOTH public/ and private/ KV prefixes (content
//     divergence / accidental double-publish).
export interface LeakFinding {
  id: string;
  kind: "db_visibility_mismatch" | "private_without_access" | "anyone_on_private" | "dual_prefix";
  severity: "high" | "medium" | "low";
  detail: any;
  auto_fixable: boolean;
}

export async function auditLeaks(env: StatusEnv): Promise<LeakFinding[]> {
  const cf = new CfClient(env);
  const findings: LeakFinding[] = [];

  // 1. db_bindings mismatch
  const mismatches = (await env.DB.prepare(
    `SELECT b.slug AS slug, b.hash AS hash, b.db_id AS db_id,
            p.visibility AS asset_vis, d.visibility AS db_vis, d.name AS db_name
     FROM db_bindings b
     JOIN pages p ON p.slug = b.slug AND p.hash = b.hash
     JOIN dbs d ON d.id = b.db_id
     WHERE p.visibility != d.visibility`,
  ).all()).results;
  for (const m of mismatches as any[]) {
    findings.push({
      id: `dbmm:${m.db_id}:${m.slug}:${m.hash}`,
      kind: "db_visibility_mismatch",
      severity: m.asset_vis === "public" && m.db_vis === "private" ? "high" : "medium",
      detail: m,
      auto_fixable: true,
    });
  }

  // 2. private pages with no Access grant and no Access app on the private host
  const privatePages = (await env.DB.prepare(
    "SELECT p.slug AS slug, p.hash AS hash, COUNT(ag.group_id) AS grants FROM pages p LEFT JOIN assets_groups ag ON ag.slug = p.slug AND ag.hash = p.hash WHERE p.visibility = 'private' GROUP BY p.slug, p.hash",
  ).all()).results as any[];
  const apps = await cf.listAccessApps().catch(() => [] as any[]);
  const privateHost = new URL(env.PRIVATE_BASE).host;
  for (const p of privatePages) {
    const hasApp = (apps as any[]).some((a) => a.domain === `${privateHost}/s/${p.slug}` || (a.name ?? "").includes(`[${p.slug}]`));
    if (!hasApp && !p.grants) {
      findings.push({
        id: `noaccess:${p.slug}:${p.hash}`,
        kind: "private_without_access",
        severity: "medium",
        detail: { slug: p.slug, hash: p.hash, note: "private page with no Access app and no group grants" },
        auto_fixable: false, // needs to know WHO should have access
      });
    }
  }

  // 3. anyone-allowed / bypass policies on private-host apps. Matches ALL
  // platform-managed apps on the private host (blanket + per-slug), and
  // recognizes every "anyone" shape: wildcard email, anyone/everyone flags,
  // and ip-range includes (0.0.0.0/0 or ::/0 = all IPv4/IPv6). The share-link
  // bypass app on privateHost/x is EXPECTED and allowlisted by domain.
  const shareBypassDomain = `${privateHost}/x`;
  for (const app of apps as any[]) {
    if (!String(app.domain ?? "").startsWith(privateHost)) continue;
    if (app.domain === shareBypassDomain) continue; // expected bypass (Worker validates tokens)
    const policies = await cf.listAccessPolicies(app.id).catch(() => [] as any[]);
    for (const p of policies as any[]) {
      const includes = (p.include ?? []) as any[];
      const isAnyone = includes.some((i: any) =>
        i.email?.email === "*" || i.anyone === true || i.everyone === true ||
        i.ip?.ip === "0.0.0.0/0" || i.ip?.ip === "::/0");
      const isBypass = p.decision === "bypass";
      if (isAnyone || isBypass) {
        findings.push({
          id: `anyone:${app.id}:${p.id ?? p.uid ?? "policy"}`,
          kind: "anyone_on_private",
          severity: "high",
          detail: { app: app.name, policy: p.name, decision: p.decision, includes },
          auto_fixable: true,
        });
      }
    }
  }

  // 4. dual-prefix: same slug+hash in both KV prefixes
  const pages = (await env.DB.prepare("SELECT slug, hash, visibility FROM pages").all()).results as any[];
  for (const p of pages) {
    const pub = await env.CACHE.get(assetKey("public", p.slug, p.hash));
    const priv = await env.CACHE.get(assetKey("private", p.slug, p.hash));
    if (pub !== null && priv !== null) {
      findings.push({
        id: `dual:${p.slug}:${p.hash}`,
        kind: "dual_prefix",
        severity: p.visibility === "public" ? "medium" : "low",
        detail: { slug: p.slug, hash: p.hash, recorded_visibility: p.visibility },
        auto_fixable: true,
      });
    }
  }

  return findings;
}

// ---- fix_leak ----
export async function fixLeak(env: StatusEnv, findingId: string) {
  const [kind, ...rest] = findingId.split(":");
  switch (kind) {
    case "dual": {
      // remove the prefix that does NOT match the recorded visibility
      const [slug, hash] = rest;
      const row = await env.DB.prepare("SELECT visibility FROM pages WHERE slug = ? AND hash = ?").bind(slug, hash).first<{ visibility: string }>();
      if (!row) throw new Error("page row not found");
      const stale = row.visibility === "public" ? "private" : "public";
      await env.CACHE.delete(assetKey(stale as "public" | "private", slug, hash));
      return { fixed: true, removed: `${stale}/${slug}/${hash}` };
    }
    case "anyone": {
      const appId = rest[0];
      const cf = new CfClient(env);
      const policies = await cf.listAccessPolicies(appId);
      for (const p of policies as any[]) {
        const hasAnyone = (p.include ?? []).some((i: any) =>
          i.email?.email === "*" || i.anyone === true || i.everyone === true ||
          i.ip?.ip === "0.0.0.0/0" || i.ip?.ip === "::/0");
        if (hasAnyone || p.decision === "bypass") await cf.deleteAccessPolicy(appId, p.id);
      }
      return { fixed: true, removed_anyone_policies_from: appId };
    }
    case "dbmm": {
      // re-tag the binding's DB to match the asset visibility (safest auto-fix:
      // the DB follows the more restrictive of the two)
      const [dbId, slug, hash] = rest;
      const row = await env.DB.prepare(
        "SELECT p.visibility AS asset_vis, d.visibility AS db_vis FROM db_bindings b JOIN pages p ON p.slug=b.slug AND p.hash=b.hash JOIN dbs d ON d.id=b.db_id WHERE b.db_id = ? AND b.slug = ? AND b.hash = ?",
      ).bind(dbId, slug, hash).first<{ asset_vis: string; db_vis: string }>();
      if (!row) throw new Error("binding not found");
      const target = row.asset_vis === "private" || row.db_vis === "private" ? "private" : "public";
      await env.DB.prepare("UPDATE dbs SET visibility = ? WHERE id = ?").bind(target, dbId).run();
      return { fixed: true, db_id: dbId, new_visibility: target };
    }
    default:
      throw new Error(`unknown finding kind '${kind}'`);
  }
}

// ---- tools ----
import { z } from "zod";
export function registerStatusTools(server: any, env: StatusEnv, actor: string = "unknown") {

  server.registerTool(
    "get_status",
    {
      title: "Full platform status",
      description:
        "High-level status: what's this costing (this month, pending, history), " +
        "current subscriptions, usage vs free-tier limits, seat usage, and any " +
        "alerts. Call this when asked about charges, costs, usage, or 'how are we doing'.",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonText(await getStatus(env));
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  server.registerTool(
    "audit_leaks",
    {
      title: "Check for visibility leaks",
      description:
        "Audit for things shared that shouldn't be: a public page bound to a " +
        "private database (or vice versa), private pages with no access control, " +
        "anyone-allowed policies on private hosts, and content living in both the " +
        "public and private stores at once.",
      inputSchema: {},
    },
    async () => {
      try {
        const findings = await auditLeaks(env);
        return jsonText({ findings, count: findings.length, clean: findings.length === 0 });
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  server.registerTool(
    "fix_leak",
    {
      title: "Fix a leak finding",
      description: "Automatically remediate a finding returned by audit_leaks (pass its id).",
      inputSchema: { finding_id: z.string() },
    },
    async ({ finding_id }: any) => {
      try {
        const r = await fixLeak(env, finding_id);
        await logOp(env.DB, "fix_leak", { finding_id, ...r }, true, actor);
        return jsonText({ ...r, finding_id });
      } catch (e) {
        await logOp(env.DB, "fix_leak", { finding_id, error: String(e) }, false, actor);
        return errText(String(e));
      }
    },
  );
}

// ---- watch_costs cron body ----
export async function watchCosts(env: StatusEnv) {
  const status = await getStatus(env);
  const alerts = status.alerts;
  if (alerts.length) {
    await logOp(env.DB, "watch_costs:alert", { alerts }, true, "cron");
    // notify the owner via email if a verified destination exists (free)
    try {
      const cf = new CfClient(env);
      const dests = await cf.listEmailAddresses();
      const owner = (dests as any[]).find((d) => d.verified);
      if (owner && env.EMAIL) {
        const { sendMimeEmail } = await import("./email");
        await sendMimeEmail(
          env.EMAIL,
          `alerts@${env.DOMAIN}`,
          owner.email,
          `[paginate-pub] ${alerts.length} alert(s)`,
          alerts.join("\n"),
        );
      }
    } catch { /* notification is best-effort */ }
  }
  return { alerts };
}
