import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dashboard } from "./Dashboard.tsx";
import type { ProxyHost } from "../types.ts";

// Dashboard pulls health/topology/metrics/certs on mount; resolve them to harmless
// values so the component settles. certForHost is a pure helper — a simple stub.
vi.mock("../api.ts", () => ({
  api: {
    health: vi.fn(() => Promise.resolve({ version: "1.2.3" })),
    topology: vi.fn(() => Promise.resolve(null)),
    metricsSummary: vi.fn(() => Promise.resolve(null)),
    certificates: vi.fn(() => Promise.resolve([])),
  },
  certForHost: vi.fn(() => null),
}));

// Isolate the Dashboard from the animated traffic panel (SSE / SVG measuring).
vi.mock("../components/NetworkTraffic.tsx", () => ({
  NetworkTraffic: () => <div data-testid="network-traffic" />,
}));

function mkHost(over: Partial<ProxyHost>): ProxyHost {
  return {
    id: "h1",
    name: "Service",
    iconUrl: "",
    domain: "svc.example.com",
    forwardScheme: "http",
    forwardHost: "10.0.0.5",
    forwardPort: 3000,
    preset: "",
    websockets: false,
    http2: false,
    ssl: true,
    requireLogin: true,
    require2fa: false,
    countryLock: false,
    serverGroup: "",
    serverIp: "10.0.0.5",
    enabled: true,
    health: "online",
    certExpiresAt: null,
    certDomain: "",
    maintenanceMode: false,
    securityHeaders: false,
    hsts: false,
    rateLimit: false,
    rateLimitRps: 0,
    rateLimitBurst: 0,
    blockExploits: false,
    ipAllow: "",
    ipDeny: "",
    customHeaders: "",
    customNginx: "",
    upstreams: "",
    lbMethod: "round_robin",
    protocol: "http",
    listenPort: 443,
    pathRules: "",
    mtls: false,
    rateLimitKbps: 0,
    maxConns: 0,
    healthCheckType: "tcp",
    healthCheckPath: "",
    healthCheckStatus: 200,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function renderDash(over: Partial<React.ComponentProps<typeof Dashboard>> = {}) {
  const props = {
    hosts: [] as ProxyHost[],
    navigate: vi.fn(),
    hostsLoaded: true,
    ...over,
  };
  return { ...render(<Dashboard {...props} />), props };
}

beforeEach(() => vi.clearAllMocks());

describe("Dashboard", () => {
  it("shows a loading skeleton (not the hero) while hosts have not loaded yet", () => {
    renderDash({ hosts: [], hostsLoaded: false });
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
    // The 'expose your first service' hero must NOT flash before the load settles.
    expect(screen.queryByText(/Welcome to NginUX/i)).not.toBeInTheDocument();
  });

  it("shows the welcome hero only once loaded with zero hosts", () => {
    renderDash({ hosts: [], hostsLoaded: true });
    expect(screen.getByText(/Welcome to NginUX/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Expose your first service/i })).toBeInTheDocument();
  });

  it("shows the reach-the-server error state on a load failure", () => {
    const onRetry = vi.fn();
    renderDash({ hosts: [], hostsLoaded: true, loadError: true, onRetry });
    expect(screen.getByText(/Couldn't reach the server/i)).toBeInTheDocument();
  });

  it("renders the 'unprotected' drill-down as a keyboard-operable link to the exposure view", async () => {
    const { props } = renderDash({
      hosts: [mkHost({ id: "h-open", ssl: true, requireLogin: false })],
    });
    const link = screen.getByRole("link", { name: /1 service unprotected/i });
    expect(link).toHaveAttribute("href", "#/security/exposure");
    await userEvent.click(link);
    expect(props.navigate).toHaveBeenCalledWith({ name: "security", tab: "exposure" });
  });

  it("renders the 'need attention' count as a link to the services view", async () => {
    const { props } = renderDash({
      hosts: [mkHost({ id: "h-sick", enabled: true, health: "down" })],
    });
    const link = screen.getByRole("link", { name: /1 need attention/i });
    expect(link).toHaveAttribute("href", "#/services");
    await userEvent.click(link);
    expect(props.navigate).toHaveBeenCalledWith({ name: "services" });
  });

  it("does not intercept a modified click on a drill-down link", () => {
    const { props } = renderDash({
      hosts: [mkHost({ id: "h-open", ssl: true, requireLogin: false })],
    });
    fireEvent.click(screen.getByRole("link", { name: /unprotected/i }), { metaKey: true });
    expect(props.navigate).not.toHaveBeenCalled();
  });
});
