import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProxyHost, SecurityProfile } from "../types.ts";

// Preserve the real, pure `certForHost` (used while rendering the cert badge);
// mock only the `api` methods the page calls. Services reads its hosts from a
// prop, and on mount fetches api.certificates() + api.securityProfiles().
vi.mock("../api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.ts")>();
  return {
    ...actual,
    api: {
      certificates: vi.fn(),
      securityProfiles: vi.fn(),
      updateHost: vi.fn(),
      batchHosts: vi.fn(),
      applySecurityProfile: vi.fn(),
    },
  };
});

import { Services } from "./Services.tsx";
import { api } from "../api.ts";

// A fully-populated ProxyHost so TypeScript is satisfied; override per-test.
function makeHost(over: Partial<ProxyHost> = {}): ProxyHost {
  return {
    id: "h1",
    name: "Jellyfin",
    iconUrl: "",
    domain: "media.example.com",
    forwardScheme: "http",
    forwardHost: "10.0.0.5",
    forwardPort: 8096,
    preset: "jellyfin",
    websockets: true,
    http2: true,
    ssl: false,
    requireLogin: false,
    require2fa: false,
    countryLock: false,
    serverGroup: "",
    serverIp: "",
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
    listenPort: 0,
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

const profile: SecurityProfile = {
  id: "p1",
  name: "Locked down",
  description: "2FA everywhere",
  fields: {},
  builtin: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function renderServices(hosts: ProxyHost[]) {
  const navigate = vi.fn();
  const reload = vi.fn().mockResolvedValue(undefined);
  render(<Services hosts={hosts} navigate={navigate} reload={reload} />);
  return { navigate, reload };
}

beforeEach(() => {
  vi.mocked(api.certificates).mockResolvedValue([]);
  vi.mocked(api.securityProfiles).mockResolvedValue([]);
  vi.mocked(api.updateHost).mockResolvedValue({} as never);
  vi.mocked(api.batchHosts).mockResolvedValue({ affected: 1 } as never);
  vi.mocked(api.applySecurityProfile).mockResolvedValue({ affected: 1 } as never);
});

describe("Services", () => {
  it("renders a row per host with its name, domain and address", async () => {
    const hosts = [
      makeHost({ id: "h1", name: "Jellyfin", domain: "media.example.com", forwardHost: "10.0.0.5", forwardPort: 8096 }),
      makeHost({ id: "h2", name: "Grafana", domain: "stats.example.com", forwardHost: "10.0.0.6", forwardPort: 3000 }),
    ];
    renderServices(hosts);
    // fetches its supporting data on mount
    await waitFor(() => expect(api.certificates).toHaveBeenCalled());
    expect(api.securityProfiles).toHaveBeenCalled();

    // one clickable row per host (the row is role=button, labelled "Open <name>")
    expect(screen.getByRole("button", { name: "Open Jellyfin" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Grafana" })).toBeInTheDocument();
    expect(screen.getByText("media.example.com")).toBeInTheDocument();
    expect(screen.getByText("stats.example.com")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.5:8096")).toBeInTheDocument();
  });

  it("navigates to the host detail when a row is clicked", async () => {
    const { navigate } = renderServices([makeHost({ id: "h1", name: "Jellyfin" })]);
    await waitFor(() => expect(api.certificates).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: "Open Jellyfin" }));
    expect(navigate).toHaveBeenCalledWith({ name: "host", hostId: "h1" });
  });

  it("shows an empty-state placeholder when there are no hosts", async () => {
    const { navigate } = renderServices([]);
    await waitFor(() => expect(api.certificates).toHaveBeenCalled());

    expect(screen.getByRole("heading", { name: "No services yet" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Open / })).not.toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("reveals the bulk-action bar only after a row is selected", async () => {
    renderServices([makeHost({ id: "h1", name: "Jellyfin" })]);
    await waitFor(() => expect(api.certificates).toHaveBeenCalled());

    // nothing selected yet -> no bulk bar
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("checkbox", { name: "Select Jellyfin" }));

    expect(screen.getByText("1 selected")).toBeInTheDocument();
    for (const label of ["Enable", "Pause", "Maintenance on", "Maintenance off", "Delete", "Clear"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("does not navigate when a row's own checkbox is toggled", async () => {
    const { navigate } = renderServices([makeHost({ id: "h1", name: "Jellyfin" })]);
    await waitFor(() => expect(api.certificates).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("checkbox", { name: "Select Jellyfin" }));
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });

  it("select-all selects every host", async () => {
    renderServices([
      makeHost({ id: "h1", name: "Jellyfin" }),
      makeHost({ id: "h2", name: "Grafana" }),
    ]);
    await waitFor(() => expect(api.certificates).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("checkbox", { name: "Select all services" }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
  });

  it("runs a bulk action against the selected ids and reloads", async () => {
    const { reload } = renderServices([
      makeHost({ id: "h1", name: "Jellyfin" }),
      makeHost({ id: "h2", name: "Grafana" }),
    ]);
    await waitFor(() => expect(api.certificates).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("checkbox", { name: "Select Jellyfin" }));
    await userEvent.click(screen.getByRole("button", { name: "Enable" }));

    expect(api.batchHosts).toHaveBeenCalledWith(["h1"], "enable");
    await waitFor(() => expect(reload).toHaveBeenCalled());
    // selection clears after the action completes
    await waitFor(() => expect(screen.queryByText("1 selected")).not.toBeInTheDocument());
  });

  it("pauses a served host from its switch without navigating", async () => {
    const { navigate } = renderServices([makeHost({ id: "h1", name: "Jellyfin", enabled: true })]);
    await waitFor(() => expect(api.certificates).toHaveBeenCalled());

    // an enabled host's switch is labelled "Pause <name>"
    await userEvent.click(screen.getByRole("button", { name: "Pause Jellyfin" }));
    expect(api.updateHost).toHaveBeenCalledWith("h1", { enabled: false });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("offers the security-profile picker in the bulk bar when profiles exist", async () => {
    vi.mocked(api.securityProfiles).mockResolvedValue([profile]);
    renderServices([makeHost({ id: "h1", name: "Jellyfin" })]);
    await waitFor(() => expect(api.securityProfiles).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("checkbox", { name: "Select Jellyfin" }));

    const picker = await screen.findByRole("combobox");
    expect(picker).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Locked down" })).toBeInTheDocument();
  });
});
