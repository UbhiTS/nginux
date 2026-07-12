// MCP prompts: named, reusable prompt templates an agent client can fetch and
// drop into a conversation. The server advertises the `prompts` capability, so it
// MUST answer both prompts/list (the catalog, with argument schemas) and
// prompts/get (the rendered messages). These are pure guidance text - no infra
// access, no RBAC gating needed.

export interface PromptArg {
  name: string;
  description: string;
  required?: boolean;
}
export interface PromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}
export interface PromptDef {
  name: string;
  description: string;
  arguments: PromptArg[];
  build: (args: Record<string, string>) => PromptMessage[];
}

const userMsg = (text: string): PromptMessage[] => [{ role: "user", content: { type: "text", text: text.trim() } }];

export const PROMPTS: PromptDef[] = [
  {
    name: "expose_service",
    description: "Expose a new internal service safely (secure defaults + a certificate).",
    arguments: [
      { name: "service", description: "What the service is (e.g. Grafana, Immich)", required: true },
      { name: "target", description: "Internal target as host:port (e.g. 192.168.1.70:3000)", required: false },
      { name: "domain", description: "Public domain to serve it on (e.g. grafana.example.com)", required: false },
    ],
    build: (a) => userMsg(`
Help me expose the internal service "${a.service}" through NginUX${a.target ? ` (internal target ${a.target})` : ""}${a.domain ? ` on ${a.domain}` : ""}.

Do it safely, step by step:
1. Confirm the target host:port is reachable (test_connection).
2. Create the proxy host over HTTPS with secure defaults (block common exploits, security headers on).
3. Ensure a certificate is issued (self-signed now, Let's Encrypt when DNS is ready).
4. Recommend whether it should sit behind the NginUX login gate, and why.
5. Show me the resulting config before anything is reloaded.
Explain each choice briefly as you go.`),
  },
  {
    name: "harden_host",
    description: "Review one host's security posture and propose specific tightening.",
    arguments: [
      { name: "host", description: "The host to review (name, id, or domain)", required: true },
    ],
    build: (a) => userMsg(`
Review the security posture of the host "${a.host}" and propose concrete hardening.

Check, and for each say whether it's on and whether it should be:
- HTTPS + HSTS, security headers, common-exploit blocking.
- The login gate (auth_request) and 2FA requirement.
- Rate limiting, bandwidth caps, and max connections.
- GeoIP country lock and IP allow/deny lists.
- mTLS client certificates (for machine-to-machine or admin surfaces).
List the exact changes you'd make, ordered by security impact, and flag anything that would break legitimate access.`),
  },
  {
    name: "incident_response",
    description: "Investigate a suspected security incident and recommend a response.",
    arguments: [
      { name: "indicator", description: "What triggered this (an IP, a host, an alert, or 'general sweep')", required: false },
    ],
    build: (a) => userMsg(`
Investigate a possible security incident${a.indicator ? ` around: ${a.indicator}` : ""}.

Work through it methodically:
1. Pull the recent audit events and access logs; look for brute-force, scanning, geo anomalies, and 4xx/5xx spikes.
2. Identify the offending IP(s) and which hosts were targeted.
3. Recommend an immediate containment action (ban the IP, tighten a host's country lock / rate limit, enable the login gate).
4. Note what to monitor next and whether any service shows signs of compromise.
Show the evidence behind each conclusion; do not ban or change anything without asking me first.`),
  },
  {
    name: "weekly_security_review",
    description: "Summarize the week's security posture and surface what needs attention.",
    arguments: [],
    build: () => userMsg(`
Give me a weekly security review of this NginUX instance.

Cover:
- Certificates expiring soon or in an error state.
- Auto-bans and repeated login failures this week (top source IPs / countries).
- Hosts that are down or flapping, and any that lack HTTPS, the login gate, or 2FA where it would be warranted.
- Notable audit events (settings changes, new users/tokens, config restores).
Finish with a short prioritized list of the top 3 things I should act on.`),
  },
];

/** The catalog for prompts/list: names + descriptions + argument schemas (no bodies). */
export function promptCatalog(): Array<{ name: string; description: string; arguments: PromptArg[] }> {
  return PROMPTS.map((p) => ({ name: p.name, description: p.description, arguments: p.arguments }));
}

/** Resolve a prompt by name and render its messages, validating required args.
 *  Returns null for an unknown name; throws Error(list) on missing required args. */
export function getPrompt(name: string, args: Record<string, string>): { description: string; messages: PromptMessage[] } | null {
  const def = PROMPTS.find((p) => p.name === name);
  if (!def) return null;
  const missing = def.arguments.filter((a) => a.required && !args[a.name]).map((a) => a.name);
  if (missing.length) throw new Error(`Missing required argument(s): ${missing.join(", ")}`);
  return { description: def.description, messages: def.build(args) };
}
