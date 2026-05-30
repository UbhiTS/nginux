import type {
  ApplyResult,
  Preset,
  ProxyHost,
  Settings,
  Topology,
  Traffic,
} from "./types.ts";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  // Only declare a JSON body when we're actually sending one. Otherwise Fastify
  // rejects bodyless requests (every DELETE, and action POSTs like logout/renew)
  // with 400 "Body cannot be empty when content-type is set to 'application/json'".
  if (init?.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`/api${path}`, { ...init, headers });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.error ? JSON.stringify(body.error) : detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  health: () => req<{ status: string; version: string }>("/health"),
  listHosts: () => req<ProxyHost[]>("/hosts"),
  getHost: (id: string) => req<ProxyHost>(`/hosts/${id}`),
  createHost: (body: Partial<ProxyHost>) =>
    req<{ host: ProxyHost; apply: ApplyResult }>("/hosts", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateHost: (id: string, body: Partial<ProxyHost>) =>
    req<{ host: ProxyHost; apply: ApplyResult }>(`/hosts/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteHost: (id: string) =>
    req<{ ok: boolean; apply: ApplyResult }>(`/hosts/${id}`, { method: "DELETE" }),
  hostConfig: (id: string) =>
    fetch(`/api/hosts/${id}/config`).then((r) => r.text()),
  testConnection: (host: string, port: number) =>
    req<{ reachable: boolean; message: string }>("/test-connection", {
      method: "POST",
      body: JSON.stringify({ host, port }),
    }),
  presets: () => req<Preset[]>("/presets"),
  settings: () => req<Settings>("/settings"),
  saveSettings: (patch: Partial<Settings>) =>
    req<Settings>("/settings", { method: "PUT", body: JSON.stringify(patch) }),
  topology: () => req<Topology>("/topology"),
  traffic: (range: string, metric: string = "requests", host?: string) =>
    req<Traffic>(`/traffic?range=${range}&metric=${metric}${host ? `&host=${encodeURIComponent(host)}` : ""}`),

  // ---- auth ----
  me: () => req<AuthUser>("/auth/me"),
  login: (username: string, password: string, token?: string) =>
    req<{ user?: AuthUser; twofaRequired?: boolean }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password, token }),
    }),
  logout: () => req<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  changePassword: (currentPassword: string, newPassword: string) =>
    req<{ ok: boolean; user: AuthUser }>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  twofaSetup: () => req<{ secret: string; otpauth: string }>("/auth/2fa/setup", { method: "POST" }),
  twofaVerify: (token: string) =>
    req<{ ok: boolean; backupCodes: string[] }>("/auth/2fa/verify", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),

  // ---- users / security ----
  users: () => req<AuthUser[]>("/users"),
  createUser: (body: { username: string; password: string; role: string; email?: string; scope?: string }) =>
    req<AuthUser>("/users", { method: "POST", body: JSON.stringify(body) }),
  deleteUser: (id: string) => req<{ ok: boolean }>(`/users/${id}`, { method: "DELETE" }),
  adminSetUserPassword: (id: string, newPassword: string) =>
    req<{ ok: boolean }>(`/users/${id}/password`, { method: "POST", body: JSON.stringify({ newPassword }) }),
  sessions: () => req<Session[]>("/sessions"),
  audit: (type?: string, limit = 50) =>
    req<AuditEvent[]>(`/audit?${type ? `type=${type}&` : ""}limit=${limit}`),
  securityOverview: () => req<SecurityOverview>("/security/overview"),
  exposure: () => req<Exposure[]>("/security/exposure"),
  bans: () => req<Ban[]>("/bans"),
  addBan: (ip: string, reason?: string) => req<Ban>("/bans", { method: "POST", body: JSON.stringify({ ip, reason }) }),
  removeBan: (ip: string) => req<{ ok: boolean }>(`/bans/${encodeURIComponent(ip)}`, { method: "DELETE" }),

  // ---- certificates ----
  certificates: () => req<Certificate[]>("/certificates"),
  issueCert: (domain: string, method: string) =>
    req<Certificate>(`/certificates/${encodeURIComponent(domain)}/issue`, {
      method: "POST",
      body: JSON.stringify({ method }),
    }),
  renewCert: (domain: string) =>
    req<Certificate>(`/certificates/${encodeURIComponent(domain)}/renew`, { method: "POST" }),
  setCertAutoRenew: (domain: string, on: boolean) =>
    req<Certificate>(`/certificates/${encodeURIComponent(domain)}/autorenew`, {
      method: "PUT",
      body: JSON.stringify({ on }),
    }),

  // ---- agents / MCP ----
  agentsOverview: () => req<AgentsOverview>("/agents/overview"),
  tools: () => req<ToolDef[]>("/agents/tools"),
  approvals: (status?: string) => req<Approval[]>(`/agents/approvals${status ? `?status=${status}` : ""}`),
  approve: (id: string) => req<Approval>(`/agents/approvals/${id}/approve`, { method: "POST" }),
  deny: (id: string) => req<Approval>(`/agents/approvals/${id}/deny`, { method: "POST" }),
  tokens: () => req<ApiToken[]>("/tokens"),
  createToken: (name: string, scopes: string[], trust: string) =>
    req<{ token: string; record: ApiToken }>("/tokens", {
      method: "POST",
      body: JSON.stringify({ name, scopes, trust }),
    }),
  revokeToken: (id: string) => req<{ ok: boolean }>(`/tokens/${id}`, { method: "DELETE" }),
  webhooks: () => req<Webhook[]>("/webhooks"),
  createWebhook: (url: string, events: string[]) =>
    req<{ webhook: Webhook; secret: string }>("/webhooks", {
      method: "POST",
      body: JSON.stringify({ url, events }),
    }),
  deleteWebhook: (id: string) => req<{ ok: boolean }>(`/webhooks/${id}`, { method: "DELETE" }),

  // ---- logs / metrics ----
  metricsSummary: () => req<MetricsSummary>("/metrics/summary"),
  hostTraffic: (range: string, metric: string = "requests") => req<{ key: string; count: number }[]>(`/metrics/hosts?range=${range}&metric=${metric}`),
  recentLogs: (filter?: string, limit = 200) =>
    req<LogEntry[]>(`/logs/recent?${filter ? `filter=${encodeURIComponent(filter)}&` : ""}limit=${limit}`),

  // ---- uptime ----
  uptime: (hostId: string) => req<Uptime>(`/hosts/${hostId}/uptime`),

  // ---- mTLS client certs ----
  clientCerts: (hostId: string) => req<ClientCert[]>(`/hosts/${hostId}/client-certs`),
  issueClientCert: (hostId: string, name: string) =>
    req<{ cert: string; key: string; record: ClientCert }>(`/hosts/${hostId}/client-certs`, { method: "POST", body: JSON.stringify({ name }) }),
  revokeClientCert: (hostId: string, certId: string) =>
    req<{ ok: boolean }>(`/hosts/${hostId}/client-certs/${certId}`, { method: "DELETE" }),

  // ---- config versioning / gitops / export ----
  configVersions: () => req<ConfigVersion[]>("/config/versions"),
  snapshotConfig: (label: string) => req<ConfigVersion>("/config/versions", { method: "POST", body: JSON.stringify({ label }) }),
  restoreVersion: (id: string) => req<{ restored: number }>(`/config/versions/${id}/restore`, { method: "POST" }),
  exportConfig: () => req<unknown>("/config/export"),
  importConfig: (conf: string) => req<{ imported: string[]; skipped: string[] }>("/config/import", { method: "POST", body: JSON.stringify({ conf }) }),
  gitLog: () => req<{ hash: string; date: string; message: string }[]>("/gitops/log"),

  // ---- notification channels ----
  channels: () => req<Channel[]>("/channels"),
  createChannel: (type: string, name: string, config: Record<string, string>, events: string[] = ["*"]) =>
    req<Channel>("/channels", { method: "POST", body: JSON.stringify({ type, name, config, events }) }),
  setChannelEnabled: (id: string, enabled: boolean) =>
    req<{ ok: boolean }>(`/channels/${id}/enabled`, { method: "PUT", body: JSON.stringify({ enabled }) }),
  deleteChannel: (id: string) => req<{ ok: boolean }>(`/channels/${id}`, { method: "DELETE" }),
  testChannel: (id: string) => req<{ ok: boolean; status: string }>(`/channels/${id}/test`, { method: "POST" }),
};

export interface ConfigVersion {
  id: string;
  ts: string;
  label: string;
  actor: string;
  hostCount: number;
}

export interface ClientCert {
  id: string;
  hostId: string;
  name: string;
  serial: string;
  fingerprint: string;
  notAfter: string;
  createdAt: string;
}

export interface Uptime {
  hostId: string;
  uptimePct: number;
  avgMs: number;
  lastCheck: string | null;
  bars: number[];
  incidents: { id: string; startedAt: string; endedAt: string | null }[];
}

export interface Channel {
  id: string;
  type: "ntfy" | "gotify" | "pushover" | "discord" | "slack" | "telegram" | "webhook";
  name: string;
  config: Record<string, string>;
  events: string[];
  enabled: boolean;
  lastStatus: string | null;
  createdAt: string;
}

export interface LogEntry {
  ts: string;
  host: string;
  method: string;
  path: string;
  status: number;
  bytes: number;
  ip: string;
  country: string;
  ua: string;
  ms: number;
}

export interface MetricsSummary {
  totalRequests: number;
  totalBytes: number;
  statusClass: { "2xx": number; "3xx": number; "4xx": number; "5xx": number };
  errorRate: number;
  p50: number;
  p95: number;
  topHosts: { key: string; count: number }[];
  topIps: { key: string; count: number }[];
  topPaths: { key: string; count: number }[];
  topCountries: { key: string; count: number }[];
}

export interface AgentsOverview {
  agents: number;
  tools: number;
  pendingApprovals: number;
  webhooks: number;
}
export interface ToolDef {
  name: string;
  title: string;
  description: string;
  scope: string;
  tier: "read" | "low" | "medium" | "high";
  inputSchema: unknown;
}
export interface Approval {
  id: string;
  ts: string;
  agent: string;
  tool: string;
  args: Record<string, unknown>;
  tier: "read" | "low" | "medium" | "high";
  summary: string;
  status: "pending" | "executed" | "denied";
  result: unknown;
  decidedBy: string | null;
  decidedAt: string | null;
}
export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  trust: "trusted" | "untrusted";
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}
export interface Webhook {
  id: string;
  url: string;
  events: string[];
  lastStatus: string | null;
  lastDeliveryAt: string | null;
  createdAt: string;
}

export interface Certificate {
  domain: string;
  status: "valid" | "expiring" | "expired" | "pending" | "error" | "none";
  issuer: string;
  method: "selfsigned" | "http-01" | "dns-01";
  notBefore: string | null;
  notAfter: string | null;
  sans: string[];
  wildcard: boolean;
  autoRenew: boolean;
  lastError: string | null;
  daysRemaining: number | null;
  updatedAt: string;
}

export interface AuthUser {
  id: string;
  username: string;
  email: string;
  role: "admin" | "editor" | "readonly" | "scoped";
  scope: string;
  twofaEnabled: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface Session {
  token: string;
  userId: string;
  username: string;
  device: string;
  ip: string;
  lastActive: string;
}

export interface AuditEvent {
  id: number;
  ts: string;
  type: string;
  severity: "info" | "notice" | "warn" | "danger";
  actor: string;
  summary: string;
  ip: string;
  meta: Record<string, unknown>;
}

export interface SecurityOverview {
  score: number;
  rating: string;
  exposed: number;
  unprotected: number;
  failedLogins24h: number;
  activeSessions: number;
}

export interface Ban {
  ip: string;
  reason: string;
  source: "manual" | "auto" | "geoip";
  createdAt: string;
  expiresAt: string | null;
}

export interface Exposure {
  id: string;
  name: string;
  emoji: string;
  domain: string;
  https: boolean;
  login: boolean;
  twofa: boolean;
  countryLock: boolean;
  wellProtected: boolean;
}
