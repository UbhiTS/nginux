// Domain model for NginUX. Kept framework-agnostic so it can be reused by the
// nginx generator, the API layer, and (mirrored) the web client.

export type HealthStatus = "online" | "degraded" | "down" | "unknown";
export type ForwardScheme = "http" | "https";

export interface ProxyHost {
  id: string;
  name: string;
  /** Dashboard-icons logo URL. Empty shows a neutral placeholder. */
  iconUrl: string;
  /** Public domain, e.g. "plex.ubhi.io" */
  domain: string;
  forwardScheme: ForwardScheme;
  /** Internal host/IP, e.g. "192.168.1.50" */
  forwardHost: string;
  forwardPort: number;
  preset: string;
  websockets: boolean;
  http2: boolean;
  ssl: boolean;
  requireLogin: boolean;
  require2fa: boolean;
  /** GeoIP: only allow the configured home country. */
  countryLock: boolean;
  /** Physical/logical server this service runs on (for the topology map). */
  serverGroup: string;
  serverIp: string;
  enabled: boolean;
  health: HealthStatus;
  /** ISO date the cert expires, or null when no cert yet. */
  certExpiresAt: string | null;
  /** Which certificate this host serves. Empty = use/manage one for its own
   *  domain; otherwise the domain key of an existing cert (e.g. a wildcard). */
  certDomain: string;
  // --- proxy behaviour & protections ---
  /** Serve a friendly "be right back" page instead of proxying. */
  maintenanceMode: boolean;
  /** Add X-Frame-Options, X-Content-Type-Options, Referrer-Policy, etc. */
  securityHeaders: boolean;
  /** Strict-Transport-Security. */
  hsts: boolean;
  /** Per-IP request rate limiting. */
  rateLimit: boolean;
  /** Requests/sec per client IP when rateLimit is on (the limit_req zone rate). */
  rateLimitRps: number;
  /** Burst allowance above the rate, served immediately (limit_req burst). */
  rateLimitBurst: number;
  /** Block common exploit paths / patterns (.env, .git, sqlmap, etc.). */
  blockExploits: boolean;
  /** Newline/comma-separated IPs or CIDRs to allow (empty = all). */
  ipAllow: string;
  /** Newline/comma-separated IPs or CIDRs to deny. */
  ipDeny: string;
  /** Extra response headers, one "Name: value" per line. */
  customHeaders: string;
  /** Raw nginx directives appended to the location block (advanced). */
  customNginx: string;
  /** Extra upstream targets ("host:port" per line) for load balancing. */
  upstreams: string;
  lbMethod: "round_robin" | "least_conn" | "ip_hash";
  /** Proxy protocol. http = L7; tcp/udp = L4 stream; grpc = gRPC; sni = TLS passthrough. */
  protocol: "http" | "tcp" | "udp" | "grpc" | "sni";
  /** Public listen port for tcp/udp/sni streams (ignored for http/grpc). */
  listenPort: number;
  /** Per-path routing: lines "/path host:port" sent to different backends. */
  pathRules: string;
  /** Require a client certificate (mTLS) signed by this host's managed CA. */
  mtls: boolean;
  /** Cap per-connection download speed in KB/s (0 = unlimited). */
  rateLimitKbps: number;
  /** Max concurrent connections per client IP (0 = unlimited). */
  maxConns: number;
  createdAt: string;
  updatedAt: string;
}

type ManagedFields = "id" | "createdAt" | "updatedAt";
type OptionalOnCreate =
  | "health" | "certExpiresAt" | "certDomain" | "maintenanceMode" | "securityHeaders" | "hsts"
  | "rateLimit" | "blockExploits" | "ipAllow" | "ipDeny" | "customHeaders" | "customNginx"
  | "upstreams" | "lbMethod" | "protocol" | "listenPort" | "pathRules" | "mtls"
  | "rateLimitKbps" | "maxConns" | "rateLimitRps" | "rateLimitBurst" | "iconUrl";

export type NewProxyHost = Omit<ProxyHost, ManagedFields | OptionalOnCreate> &
  Partial<Pick<ProxyHost, OptionalOnCreate>>;

export interface Settings {
  instanceName: string;
  baseDomain: string;
  publicUrl: string;
  theme: "dark" | "medium" | "light";
  letsEncryptEmail: string;
  homeCountry: string;
  /** Public IP of the gateway (for the topology map). */
  publicIp: string;
  /** LAN IP of the gateway/router. */
  gatewayIp: string;
  /** DNS provider for record automation + DNS-01 challenges. */
  dnsProvider: "none" | "godaddy" | "cloudflare";
  godaddyApiKey: string;
  godaddySecret: string;
  cloudflareApiToken: string;
  /** MaxMind license key for downloading the GeoLite2 country database (geo lock). */
  maxmindLicenseKey: string;
  /** Use Let's Encrypt staging (avoids rate limits while testing). */
  acmeStaging: boolean;
  /** Allow trusted agents to auto-run low/medium-risk tools without approval. */
  agentAutoApprove: boolean;
  /** Commit generated config + state to a local git repo on every apply. */
  gitOpsEnabled: boolean;
  /** Public HTTPS URL where NginUX's own login is reachable (e.g.
   *  https://nginux.example.com). Login-gated services redirect unauthenticated
   *  visitors here. Empty = login-gating can't redirect (just denies). */
  ssoLoginUrl: string;
  /** Cookie Domain so one sign-in covers every subdomain (e.g. .example.com).
   *  Empty = derived from ssoLoginUrl, or a host-only cookie if that's unset. */
  ssoCookieDomain: string;
  /** Shared secret nginx sends with each forward-auth subrequest so the login
   *  check can't be called directly and bypassed. Auto-generated on first boot;
   *  rotatable from Settings → Login gate. Empty only if an admin cleared it. */
  ssoForwardSecret: string;
  /** Rotate an on-disk nginx log once it exceeds this many MB (0 = never). */
  logMaxMb: number;
  /** How many rotated log copies to keep before deleting the oldest (0 = none). */
  logKeepFiles: number;
}

/** A server node grouping its services, for the dashboard topology tree. */
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
  }>;
}

export interface Topology {
  internet: { label: string };
  gateway: { publicIp: string; gatewayIp: string };
  servers: TopologyServer[];
}
