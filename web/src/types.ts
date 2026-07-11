// Mirror of server/src/types.ts (the API contract).
export type HealthStatus = "online" | "degraded" | "down" | "unknown";
export type ForwardScheme = "http" | "https";

export interface ProxyHost {
  id: string;
  name: string;
  /** Dashboard-icons logo URL. Empty shows a neutral placeholder. */
  iconUrl: string;
  domain: string;
  forwardScheme: ForwardScheme;
  forwardHost: string;
  forwardPort: number;
  preset: string;
  websockets: boolean;
  http2: boolean;
  ssl: boolean;
  requireLogin: boolean;
  require2fa: boolean;
  countryLock: boolean;
  serverGroup: string;
  serverIp: string;
  enabled: boolean;
  health: HealthStatus;
  certExpiresAt: string | null;
  /** Which certificate this host serves. Empty = use/manage one for its own
   *  domain; otherwise the domain key of an existing cert (e.g. a wildcard). */
  certDomain: string;
  maintenanceMode: boolean;
  securityHeaders: boolean;
  hsts: boolean;
  rateLimit: boolean;
  rateLimitRps: number;
  rateLimitBurst: number;
  blockExploits: boolean;
  ipAllow: string;
  ipDeny: string;
  customHeaders: string;
  customNginx: string;
  upstreams: string;
  lbMethod: "round_robin" | "least_conn" | "ip_hash";
  protocol: "http" | "tcp" | "udp" | "grpc" | "sni";
  listenPort: number;
  pathRules: string;
  mtls: boolean;
  rateLimitKbps: number;
  maxConns: number;
  createdAt: string;
  updatedAt: string;
}

export interface Settings {
  instanceName: string;
  baseDomain: string;
  theme: "dark" | "less-dark" | "medium" | "less-light" | "light";
  letsEncryptEmail: string;
  homeCountry: string;
  allowedCountries: string;
  publicIp: string;
  gatewayIp: string;
  dnsProvider: "none" | "godaddy" | "cloudflare";
  godaddyApiKey: string;
  godaddySecret: string;
  cloudflareApiToken: string;
  maxmindLicenseKey: string;
  acmeStaging: boolean;
  agentAutoApprove: boolean;
  gitOpsEnabled: boolean;
  ssoLoginUrl: string;
  ssoCookieDomain: string;
  ssoForwardSecret: string;
  logMaxMb: number;
  logKeepFiles: number;
}

export interface Preset {
  id: string;
  label: string;
  icon: string;
  category: string;
  /** Plain-language one-liner: what the app is. */
  desc: string;
  /** The app's usual internal port, prefilled on the wizard's "Where" step. */
  defaultPort: number;
  /** Scheme to reach the backend (https for appliances like Proxmox/UniFi). */
  forwardScheme?: "http" | "https";
  websockets: boolean;
  http2: boolean;
  extraDirectives: string[];
  notes: string;
}

export interface TopologyServer {
  name: string;
  ip: string;
  status: HealthStatus;
  services: Array<{
    id: string;
    name: string;
    iconUrl: string;
    domain: string;
    port: number;
    health: HealthStatus;
    requireLogin: boolean;
    enabled: boolean;
    ssl: boolean;
  }>;
}

export interface Topology {
  internet: { label: string };
  gateway: { publicIp: string; gatewayIp: string };
  servers: TopologyServer[];
}

export interface Traffic {
  range: string;
  data: number[];
  dataIn?: number[]; // bandwidth mode: request (ingress) bytes; `data` is response (egress)
  total: string;
  peak: string;
  unit: string;
  axis: string[];
}

export interface ApplyResult {
  ok: boolean;
  message: string;
  nginxAvailable: boolean;
}

/** Map a health status to the dot/pill colour class used in the design system. */
export const healthClass: Record<HealthStatus, "g" | "y" | "r" | "n"> = {
  online: "g",
  degraded: "y",
  down: "r",
  unknown: "n",
};
