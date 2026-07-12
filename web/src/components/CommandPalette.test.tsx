import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "./CommandPalette.tsx";
import type { ProxyHost } from "../types.ts";

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
    requireLogin: false,
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

const hosts: ProxyHost[] = [
  mkHost({ id: "h-grafana", name: "Grafana", domain: "grafana.example.com" }),
  mkHost({ id: "h-vault", name: "Vaultwarden", domain: "vault.example.com" }),
];

function renderPalette(over: Partial<React.ComponentProps<typeof CommandPalette>> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    hosts,
    navigate: vi.fn(),
    ...over,
  };
  return { ...render(<CommandPalette {...props} />), props };
}

beforeEach(() => vi.clearAllMocks());

describe("CommandPalette", () => {
  it("renders nothing when closed", () => {
    renderPalette({ open: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("lists both pages and services when open", () => {
    renderPalette();
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Grafana")).toBeInTheDocument();
    expect(screen.getByText("Vaultwarden")).toBeInTheDocument();
  });

  it("fuzzy-filters the options by the query", async () => {
    renderPalette();
    await userEvent.type(screen.getByRole("textbox"), "grf");
    expect(screen.getByText("Grafana")).toBeInTheDocument();
    // A non-matching page is filtered out.
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
    expect(screen.queryByText("Vaultwarden")).not.toBeInTheDocument();
  });

  it("matches services by their domain too", async () => {
    renderPalette();
    await userEvent.type(screen.getByRole("textbox"), "vault.example");
    expect(screen.getByText("Vaultwarden")).toBeInTheDocument();
    expect(screen.queryByText("Grafana")).not.toBeInTheDocument();
  });

  it("navigates to a service on click and closes", async () => {
    const { props } = renderPalette();
    await userEvent.click(screen.getByText("Grafana"));
    expect(props.navigate).toHaveBeenCalledWith({ name: "host", hostId: "h-grafana" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("navigates to a page on click", async () => {
    const { props } = renderPalette();
    await userEvent.click(screen.getByText("Certificates"));
    expect(props.navigate).toHaveBeenCalledWith({ name: "certs" });
  });

  it("supports arrow-key + Enter selection", async () => {
    const { props } = renderPalette();
    const input = screen.getByRole("textbox");
    input.focus();
    // First result (Dashboard) is active; arrow down moves to Services and Enter runs it.
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(props.navigate).toHaveBeenCalledWith({ name: "services" });
  });

  it("shows an empty state when nothing matches", async () => {
    renderPalette();
    await userEvent.type(screen.getByRole("textbox"), "zzzznope");
    expect(screen.getByText(/No matches/i)).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const { props } = renderPalette();
    await userEvent.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
