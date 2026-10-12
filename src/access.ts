
// src/access.ts — Cloudflare Access (Zero Trust) management for paginate-pub.
//
// Model:
//   group  = an Access Group (emails list) mirrored in D1 `groups_t`
//   asset  = a published page; its privacy is enforced by a self-hosted Access
//            app on private.<domain> whose policy includes the granted groups
//
// The Worker host private.<domain> should ALSO have a blanket Access app in the
// dashboard or API as a backstop; these tools manage per-asset grants precisely.

import { CfClient } from "./cf";
import { logOp, jsonText, errText } from "./util";

export interface AccessEnv {
  DB: D1Database;
  CF_API_TOKEN: string;
  ACCOUNT_ID: string;
  ZONE_ID: string;
  DOMAIN: string;
  PRIVATE_BASE: string;
}

export interface GroupRow {
  id: number;
  name: string;
  cf_group_id: string | null;
  created_at: string;
}

// Create an Access Group with an email list and mirror it in D1.
export async function createGroup(env: AccessEnv, name: string, emails: string[]) {
  const cf = new CfClient(env);
  const clean = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!clean.length) throw new Error("at least one email required");

  const g = await cf.createAccessGroup({
    name,
    include: clean.map((email) => ({ email: { email } })),
  });

  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    "INSERT INTO groups_t (name, cf_group_id, created_at) VALUES (?, ?, ?)",
  ).bind(name, g.id, now).run();
  const id = res.meta.last_row_id as number;

  const stmt = env.DB.prepare("INSERT OR IGNORE INTO group_members (group_id, email) VALUES (?, ?)");
  for (const email of clean) await stmt.bind(id, email).run();

  return { id, name, cf_group_id: g.id, emails: clean };
}

// Get a group from D1 by name (or null).
export async function getGroup(env: AccessEnv, name: string): Promise<GroupRow | null> {
  return env.DB.prepare("SELECT * FROM groups_t WHERE name = ?").bind(name).first<GroupRow>();
}

// Ensure a group exists (create if missing) — used by grant_access / launch_group.
export async function ensureGroup(env: AccessEnv, name: string, emails: string[]) {
  const existing = await getGroup(env, name);
  if (existing) {
    if (emails.length) {
      // add any new emails to the existing group (both CF and D1)
      const cf = new CfClient(env);
      const current = (await env.DB.prepare(
        "SELECT email FROM group_members WHERE group_id = ?",
      ).bind(existing.id).all<{ email: string }>()).results.map((r) => r.email);
      const toAdd = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))]
        .filter((e) => !current.includes(e));
      if (toAdd.length && existing.cf_group_id) {
        await cf.updateAccessGroup(existing.cf_group_id, {
          name: existing.name,
          include: [...current, ...toAdd].map((email) => ({ email: { email } })),
        });
        const stmt = env.DB.prepare("INSERT OR IGNORE INTO group_members (group_id, email) VALUES (?, ?)");
        for (const email of toAdd) await stmt.bind(existing.id, email).run();
      }
    }
    return { ...existing, emails: emails.length ? emails : [] };
  }
  return createGroup(env, name, emails);
}

// The Access app that gates an asset. One app per slug, PATH-SCOPED:
// "<private host>/s/<slug>" — one app per hostname would share policy across
// slugs (granting slug A would expose slug B); path scoping fixes that.
export function assetAppDomain(env: AccessEnv, slug: string): string {
  return `${new URL(env.PRIVATE_BASE).host}/s/${slug}`;
}

export async function findOrCreateAssetApp(
  cf: CfClient,
  env: AccessEnv,
  slug: string,
  title: string,
): Promise<{ id: string; created: boolean }> {
  const domain = assetAppDomain(env, slug);
  const match = (list: any[]) =>
    list.find(
      (a: any) =>
        a.domain === domain &&
        (a.name ?? "").includes(`[paginate-pub:${slug}]`),
    );
  let apps: any[];
  try {
    apps = await cf.listAccessApps();
  } catch {
    apps = [];
  }
  const existing = match(apps);
  if (existing) return { id: existing.id, created: false };
  try {
    const app = await cf.createAccessApp({
      name: `paginate-pub [${slug}] ${title ?? slug}`,
      domain,
      type: "self_hosted",
      session_duration: "24h",
      auto_redirect_to_identity: false,
    });
    return { id: app.id, created: true };
  } catch (e: any) {
    // 409 application_already_exists: a previous run created it but the D1
    // record was lost, or a name collision — re-list and adopt the match.
    if (e?.code === 11010 || String(e?.message ?? e).includes("already_exists")) {
      // The app already exists on the DOMAIN but under a different name (from
      // an earlier run). Adopt the first app on this domain — Access allows
      // only one app per hostname per type, so there is exactly one candidate.
      let again: any[] = [];
      try { again = await cf.listAccessApps(); } catch { again = []; }
      const onDomain = (again as any[]).filter((a: any) => a.domain === domain);
      if (onDomain.length) return { id: onDomain[0].id, created: false };
      const found = match(again);
      if (found) return { id: found.id, created: false };
    }
    throw e;
  }
}

// Grant a group (and/or raw emails) access to an asset: creates the scoped
// Access app if needed and adds/replaces its allow policy.
export async function grantAccess(
  env: AccessEnv,
  slug: string,
  groupName: string,
  emails: string[] = [],
) {
  const cf = new CfClient(env);
  const group = await getGroup(env, groupName);
  if (!group || !group.cf_group_id) throw new Error(`group '${groupName}' not found`);

  // Repair a group whose Cloudflare id was lost (e.g. app adopted mid-flight):
  // look it up by name and persist.
  if (!group.cf_group_id) {
    const cfGroups = await cf.listAccessGroups();
    const found = (cfGroups as any[]).find((g: any) => g.name === group.name);
    if (found) {
      await env.DB.prepare("UPDATE groups_t SET cf_group_id = ? WHERE id = ?").bind(found.id, group.id).run();
      group.cf_group_id = found.id;
    }
  }

  const page = await env.DB.prepare(
    "SELECT * FROM pages WHERE slug = ? ORDER BY created_at DESC, id DESC LIMIT 1",
  ).bind(slug).first<{ title: string | null }>();

  const { id: appId } = await findOrCreateAssetApp(cf, env, slug, page?.title ?? slug);

  // policy: allow the group (+ any extra raw emails)
  const include: any[] = [{ group: { id: group.cf_group_id } }];
  for (const email of emails) include.push({ email: { email: email.trim().toLowerCase() } });

  const policies = await cf.listAccessPolicies(appId);
  const existing = policies.find((p: any) => p.name === "paginate-pub-grant");
  if (existing) {
    await cf.putAccessPolicy(appId, existing.id, {
      name: "paginate-pub-grant",
      decision: "allow",
      include,
      precedence: 1,
    });
  } else {
    await cf.createAccessPolicy(appId, {
      name: "paginate-pub-grant",
      decision: "allow",
      include,
      precedence: 1,
    });
  }

  await env.DB.prepare(
    "INSERT OR IGNORE INTO assets_groups (slug, hash, group_id) SELECT p.slug, p.hash, ? FROM pages p WHERE p.slug = ? LIMIT 1",
  ).bind(group.id, slug).run();

  return { appId, group: group.name };
}

// Revoke a group from an asset: removes the policy; deletes the Access app if
// it was the last grant.
export async function revokeAccess(env: AccessEnv, slug: string, groupName: string) {
  const cf = new CfClient(env);
  const group = await getGroup(env, groupName);
  if (!group) throw new Error(`group '${groupName}' not found`);

  const domain = assetAppDomain(env, slug);
  const apps = await cf.listAccessApps();
  const app = apps.find(
    (a: any) => a.domain === domain && (a.name ?? "").includes(`[paginate-pub:${slug}]`),
  );
  if (!app) return { removed: false, note: "no access app for this asset" };

  const policies = await cf.listAccessPolicies(app.id);
  const grant = policies.find((p: any) => p.name === "paginate-pub-grant");
  if (grant) {
    const remaining = (grant.include ?? []).filter(
      (i: any) => !(i.group && i.group.id === group.cf_group_id),
    );
    if (remaining.length) {
      await cf.putAccessPolicy(app.id, grant.id, {
        name: "paginate-pub-grant",
        decision: "allow",
        include: remaining,
        precedence: 1,
      });
    } else {
      await cf.deleteAccessPolicy(app.id, grant.id);
    }
  }

  await env.DB.prepare("DELETE FROM assets_groups WHERE group_id = ? AND slug = ?").bind(group.id, slug).run();

  // if no allow policies remain, delete the app entirely
  const after = await cf.listAccessPolicies(app.id);
  if (!after.length) {
    await cf.deleteAccessApp(app.id);
    return { removed: true, appDeleted: true };
  }
  return { removed: true, appDeleted: false };
}

// Full user summary: Zero Trust users + D1 group memberships + seat math.
export async function listUsers(env: AccessEnv) {
  const cf = new CfClient(env);
  const ztUsers = await cf.listZtUsers();
  const memberships = (await env.DB.prepare(
    "SELECT g.name AS group_name, m.email FROM group_members m JOIN groups_t g ON g.id = m.group_id ORDER BY g.name, m.email",
  ).all<{ group_name: string; email: string }>()).results;

  const byEmail = new Map<string, string[]>();
  for (const m of memberships) {
    const arr = byEmail.get(m.email) ?? [];
    arr.push(m.group_name);
    byEmail.set(m.email, arr);
  }

  const users = ztUsers.map((u: any) => ({
    id: u.id,
    email: u.email,
    active: u.active,
    seat: u.seat ?? null,
    last_seen: u.last_seen ?? null,
    groups: byEmail.get(u.email) ?? [],
  }));

  return {
    seats_used: users.filter((u) => u.seat && (u.seat === true || u.seat === "active")).length,
    seats_total_free_tier: 50,
    zt_users: users.length,
    users,
    d1_groups: (await env.DB.prepare("SELECT * FROM groups_t ORDER BY name").all<GroupRow>()).results,
  };
}

// Register the access tools on an MCP server. Called from mcp.ts.
import { z } from "zod";
export function registerAccessTools(server: any, env: AccessEnv, actor: string = "unknown") {

  server.registerTool(
    "create_group",
    {
      title: "Create an access group",
      description:
        "Create a named group of people (by email) that can be granted access to private pages. " +
        "Up to 50 users are free. Returns the group name and members.",
      inputSchema: {
        name: z.string().describe("Group name, e.g. 'team' or 'family'."),
        emails: z.array(z.string()).describe("Email addresses of the members."),
      },
    },
    async ({ name, emails }: { name: string; emails: string[] }) => {
      try {
        const g = await ensureGroup(env, name.toLowerCase().replace(/[^a-z0-9-]+/g, "-"), emails);
        await logOp(env.DB, "create_group", { name: g.name, emails }, true, actor);
        return jsonText(g);
      } catch (e) {
        await logOp(env.DB, "create_group", { error: String(e) }, false, actor);
        return errText(String(e));
      }
    },
  );

  server.registerTool(
    "grant_access",
    {
      title: "Share a private page with a group",
      description:
        "Grant a group (and optionally extra emails) access to a published page. " +
        "The page must be private (use set_visibility first). The members will be able to " +
        "open it after signing in with their email (one-time PIN).",
      inputSchema: {
        slug: z.string().describe("The page slug."),
        group: z.string().describe("Group name to grant."),
        emails: z.array(z.string()).optional().describe("Extra individual emails to also allow."),
      },
    },
    async ({ slug, group, emails }: { slug: string; group: string; emails?: string[] }) => {
      try {
        const r = await grantAccess(env, slug, group, emails ?? []);
        await logOp(env.DB, "grant_access", { slug, group, emails: emails ?? [] }, true, actor);
        return jsonText({ granted: true, slug, ...r });
      } catch (e) {
        await logOp(env.DB, "grant_access", { error: String(e) }, false, actor);
        return errText(String(e));
      }
    },
  );

  server.registerTool(
    "revoke_access",
    {
      title: "Remove a group's access to a page",
      description: "Remove a group from a private page's access policy.",
      inputSchema: {
        slug: z.string(),
        group: z.string(),
      },
    },
    async ({ slug, group }: { slug: string; group: string }) => {
      try {
        const r = await revokeAccess(env, slug, group);
        await logOp(env.DB, "revoke_access", { slug, group }, true, actor);
        return jsonText({ revoked: true, slug, ...r });
      } catch (e) {
        await logOp(env.DB, "revoke_access", { error: String(e) }, false, actor);
        return errText(String(e));
      }
    },
  );

  server.registerTool(
    "list_users",
    {
      title: "List users, groups, and seats",
      description:
        "Full summary of who can access private pages: every user, their groups, " +
        "and how many of the 50 free Zero Trust seats are used.",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonText(await listUsers(env));
      } catch (e) {
        return errText(String(e));
      }
    },
  );
}
