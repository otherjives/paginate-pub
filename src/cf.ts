// src/cf.ts — typed Cloudflare API v4 client.
// All platform mutations in paginate-pub go through this module so that
// every call is logged to D1 (ops_log) and errors are normalized.

export interface CfEnv {
  CF_API_TOKEN: string;
  ACCOUNT_ID: string;
  ZONE_ID: string;
}

export class CfError extends Error {
  code: number;
  httpStatus: number;
  errors: Array<{ code: number; message: string }>;
  constructor(httpStatus: number, body: unknown) {
    const errs = (body as any)?.errors ?? [];
    const first = errs[0];
    super(`Cloudflare API ${httpStatus}${first ? ` [${first.code}] ${first.message}` : ""}`);
    this.name = "CfError";
    this.code = first?.code ?? httpStatus;
    this.httpStatus = httpStatus;
    this.errors = errs;
  }
}

const BASE = "https://api.cloudflare.com/client/v4";

export class CfClient {
  constructor(private env: CfEnv) {}

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
    contentType = "application/json",
  ): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.env.CF_API_TOKEN}`,
        ...(body !== undefined ? { "Content-Type": contentType } : {}),
      },
      body: body !== undefined ? (contentType === "application/json" ? JSON.stringify(body) : (body as BodyInit)) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
    if (!res.ok || (json && json.success === false)) {
      throw new CfError(res.status, json ?? { errors: [{ code: res.status, message: text || res.statusText }] });
    }
    return json?.result as T;
  }

  get<T>(path: string): Promise<T> { return this.req<T>("GET", path); }
  post<T>(path: string, body?: unknown): Promise<T> { return this.req<T>("POST", path, body); }
  put<T>(path: string, body?: unknown): Promise<T> { return this.req<T>("PUT", path, body); }
  patch<T>(path: string, body?: unknown): Promise<T> { return this.req<T>("PATCH", path, body); }
  delete<T>(path: string): Promise<T> { return this.req<T>("DELETE", path); }

  // ---- convenience wrappers (account-scoped) ----
  readonly account = (p: string) => `/accounts/${this.env.ACCOUNT_ID}${p}`;
  readonly zone = (p: string) => `/zones/${this.env.ZONE_ID}${p}`;

  // Access
  listAccessApps() { return this.get<any[]>(this.account("/access/apps")); }
  createAccessApp(app: Record<string, unknown>) { return this.post<any>(this.account("/access/apps"), app); }
  updateAccessApp(id: string, app: Record<string, unknown>) { return this.put<any>(this.account(`/access/apps/${id}`), app); }
  deleteAccessApp(id: string) { return this.delete<any>(this.account(`/access/apps/${id}`)); }

  listAccessGroups() { return this.get<any[]>(this.account("/access/groups")); }
  createAccessGroup(group: Record<string, unknown>) { return this.post<any>(this.account("/access/groups"), group); }
  updateAccessGroup(id: string, group: Record<string, unknown>) { return this.put<any>(this.account(`/access/groups/${id}`), group); }
  deleteAccessGroup(id: string) { return this.delete<any>(this.account(`/access/groups/${id}`)); }

  listAccessPolicies(appId: string) { return this.get<any[]>(this.account(`/access/apps/${appId}/policies`)); }
  createAccessPolicy(appId: string, policy: Record<string, unknown>) { return this.post<any>(this.account(`/access/apps/${appId}/policies`), policy); }
  putAccessPolicy(appId: string, policyId: string, policy: Record<string, unknown>) { return this.put<any>(this.account(`/access/apps/${appId}/policies/${policyId}`), policy); }
  deleteAccessPolicy(appId: string, policyId: string) { return this.delete<any>(this.account(`/access/apps/${appId}/policies/${policyId}`)); }

  // Zero Trust users / seats
  listZtUsers() { return this.get<any[]>(this.account("/access/users")); }

  // DNS
  listDnsRecords() { return this.get<any[]>(this.zone("/dns_records")); }
  createDnsRecord(record: Record<string, unknown>) { return this.post<any>(this.zone("/dns_records"), record); }
  deleteDnsRecord(id: string) { return this.delete<any>(this.zone(`/dns_records/${id}`)); }

  // Workers domains (custom domains for a Worker script)
  listWorkerDomains() { return this.get<any[]>(this.account("/workers/domains")); }
  putWorkerDomain(hostname: string, service: string, zoneId?: string) {
    return this.put<any>(this.account("/workers/domains"), { hostname, service, zone_id: zoneId ?? this.env.ZONE_ID });
  }
  deleteWorkerDomain(id: string) { return this.delete<any>(this.account(`/workers/domains/${id}`)); }

  // Worker secrets
  listWorkerSecrets(script: string) { return this.get<any[]>(this.account(`/workers/scripts/${script}/secrets`)); }
  putWorkerSecret(script: string, name: string, text: string) {
    return this.put<any>(this.account(`/workers/scripts/${script}/secrets`), { name, text, type: "secret_text" });
  }
  deleteWorkerSecret(script: string, name: string) {
    return this.delete<any>(this.account(`/workers/scripts/${script}/secrets/${name}`));
  }

  // Billing / subscriptions
  billingHistory() { return this.get<any[]>(this.account("/billing/history")); }
  listSubscriptions() { return this.get<any[]>(this.account("/subscriptions")); }

  // Email routing / sending
  listEmailAddresses() { return this.get<any[]>(this.account("/email/routing/addresses")); }
  createEmailAddress(email: string) { return this.post<any>(this.account("/email/routing/addresses"), { email }); }
  deleteEmailAddress(id: string) { return this.delete<any>(this.account(`/email/routing/addresses/${id}`)); }
  listEmailRules() { return this.get<any[]>(this.account("/email/routing/rules")); }
  createEmailRule(rule: Record<string, unknown>) { return this.post<any>(this.account("/email/routing/rules"), rule); }
  deleteEmailRule(id: string) { return this.delete<any>(this.account(`/email/routing/rules/${id}`)); }

  // D1 provisioning
  createD1(name: string) { return this.post<any>(this.account("/d1/database"), { name }); }
  listD1() { return this.get<any[]>(this.account("/d1/database")); }

  // Analytics Engine SQL
  aeQuery(sql: string) {
    return this.req<any>("POST", this.account("/analytics_engine/sql"), JSON.stringify(sql), "text/plain");
  }
}
