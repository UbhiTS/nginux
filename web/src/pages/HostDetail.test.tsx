import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProxyHost, Preset } from "../types.ts";
import type { Certificate, Uptime } from "../api.ts";

// HostDetail fetches its host/config/uptime/certs on mount, plus presets and
// settings; mock every api method it can reach so no call is left undefined.
vi.mock("../api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.ts")>();
  return {
    ...actual,
    api: {
      getHost: vi.fn(),
      hostConfig: vi.fn(),
      uptime: vi.fn(),
      certificates: vi.fn(),
      presets: vi.fn(),
      settings: vi.fn(),
      updateHost: vi.fn(),
      deleteHost: vi.fn(),
      searchIcons: vi.fn(),
      issueCert: vi.fn(),
      importCerts: vi.fn(),
      clientCerts: vi.fn(),
      issueClientCert: vi.fn(),
      revokeClientCert: vi.fn(),
    },
  };
});

import { HostDetail } from "./HostDetail.tsx";
import { api } from "../api.ts";

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

function makeCert(over: Partial<Certificate> = {}): Certificate {
  return {
    domain: "media.example.com",
    status: "valid",
    issuer: "Let's Encrypt",
    method: "http-01",
    notBefore: "2026-05-01T00:00:00Z",
    notAfter: "2026-09-01T00:00:00Z",
    sans: [],
    wildcard: false,
    autoRenew: true,
    lastError: null,
    daysRemaining: 42,
    updatedAt: "2026-07-01T00:00:00Z",
    ...over,
  };
}

function renderDetail(host: ProxyHost, opts: { tab?: string } = {}) {
  const navigate = vi.fn();
  const reload = vi.fn().mockResolvedValue(undefined);
  render(<HostDetail hostId={host.id} navigate={navigate} reload={reload} tab={opts.tab} />);
  return { navigate, reload };
}

beforeEach(() => {
  vi.mocked(api.getHost).mockResolvedValue(makeHost());
  vi.mocked(api.hostConfig).mockResolvedValue("server { listen 443; }");
  vi.mocked(api.uptime).mockResolvedValue(null as unknown as Uptime);
  vi.mocked(api.certificates).mockResolvedValue([]);
  vi.mocked(api.presets).mockResolvedValue([] as Preset[]);
  vi.mocked(api.settings).mockResolvedValue({} as never);
  vi.mocked(api.updateHost).mockResolvedValue({} as never);
  vi.mocked(api.deleteHost).mockResolvedValue(undefined as never);
  vi.mocked(api.searchIcons).mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HostDetail", () => {
  it("labels the pause/resume control by state and its back button as 'Back'", async () => {
    vi.mocked(api.getHost).mockResolvedValue(makeHost({ enabled: true }));
    renderDetail(makeHost({ enabled: true }));

    expect(await screen.findByRole("heading", { name: /Jellyfin/ })).toBeInTheDocument();
    // enabled -> "Pause" (matches the Services wording, not "Disable")
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disable" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
  });

  it("shows 'Resume' when the service is paused", async () => {
    vi.mocked(api.getHost).mockResolvedValue(makeHost({ enabled: false, health: "unknown" }));
    renderDetail(makeHost({ enabled: false }));

    expect(await screen.findByRole("button", { name: "Resume" })).toBeInTheDocument();
    // banner tells the user to Resume (not "Enable")
    expect(screen.getByText(/Click/)).toHaveTextContent("Resume");
  });

  it("Back falls through to the Services list when there is no history to pop", async () => {
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    Object.defineProperty(window.history, "length", { configurable: true, value: 1 });
    const { navigate } = renderDetail(makeHost());
    await screen.findByRole("heading", { name: /Jellyfin/ });

    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(backSpy).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({ name: "services" });
  });

  it("Back steps through browser history when there is some", async () => {
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    Object.defineProperty(window.history, "length", { configurable: true, value: 3 });
    const { navigate } = renderDetail(makeHost());
    await screen.findByRole("heading", { name: /Jellyfin/ });

    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(backSpy).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalledWith({ name: "services" });
  });

  it("pauses the service and surfaces an error if the call fails", async () => {
    const { reload } = renderDetail(makeHost({ enabled: true }));
    await screen.findByRole("heading", { name: /Jellyfin/ });

    vi.mocked(api.updateHost).mockRejectedValueOnce(new Error("nginx reload failed"));
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));

    expect(api.updateHost).toHaveBeenCalledWith("h1", { enabled: false });
    // the rejection is caught and shown, not swallowed
    expect(await screen.findByRole("alert")).toHaveTextContent("nginx reload failed");
    expect(reload).not.toHaveBeenCalled();
  });

  it("renders off protections as a neutral dash, never a red cross", async () => {
    // rate limiting off -> neutral (not an error); everything else default-off too
    renderDetail(makeHost({ rateLimit: false, ssl: true, hsts: false }));
    await screen.findByRole("heading", { name: /Jellyfin/ });

    const line = screen.getByText("Rate limiting").closest(".check-line")!;
    expect(line.className).toContain("off");
    expect(line.className).not.toContain("bad");
  });

  it("flags HSTS-without-HTTPS as a genuine error (red)", async () => {
    vi.mocked(api.getHost).mockResolvedValue(makeHost({ hsts: true, ssl: false }));
    renderDetail(makeHost({ hsts: true, ssl: false }));
    await screen.findByRole("heading", { name: /Jellyfin/ });

    const line = screen.getByText("HSTS").closest(".check-line")!;
    expect(line.className).toContain("bad");
  });

  it("pluralizes certificate lifetimes with days() ('1 day', not '1 days')", async () => {
    vi.mocked(api.getHost).mockResolvedValue(makeHost({ ssl: true }));
    vi.mocked(api.certificates).mockResolvedValue([makeCert({ daysRemaining: 1 })]);
    renderDetail(makeHost({ ssl: true }));
    await screen.findByRole("heading", { name: /Jellyfin/ });

    await waitFor(() => expect(screen.getByText(/Certificate valid for/)).toHaveTextContent("1 day"));
    expect(screen.queryByText(/1 days/)).not.toBeInTheDocument();
  });

  it("exposes the generated-config disclosure as a keyboard-operable button", async () => {
    renderDetail(makeHost());
    await screen.findByRole("heading", { name: /Jellyfin/ });

    const toggle = screen.getByRole("button", { name: /view generated Nginx config/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/server \{ listen 443/)).toBeInTheDocument();
  });

  it("renders edit-form toggles as accessible switches", async () => {
    renderDetail(makeHost(), { tab: "edit" });
    // the form seeds once the host loads
    expect(await screen.findByRole("heading", { name: /Edit Jellyfin/ })).toBeInTheDocument();

    const webSockets = screen.getByRole("switch", { name: "WebSockets" });
    expect(webSockets).toBeInTheDocument();
    expect(webSockets).toHaveAttribute("aria-checked", "true");
  });

  it("cancels a pristine edit immediately, without a discard prompt", async () => {
    const { navigate } = renderDetail(makeHost(), { tab: "edit" });
    await screen.findByRole("heading", { name: /Edit Jellyfin/ });

    // Two "Cancel" controls in edit mode (topbar toggle + sticky wnav); the
    // sticky one is last. Both route through the same guard.
    const cancels = screen.getAllByRole("button", { name: "Cancel" });
    await userEvent.click(cancels[cancels.length - 1]);
    expect(screen.queryByText("Discard unsaved changes?")).not.toBeInTheDocument();
    expect(navigate).toHaveBeenCalledWith({ name: "host", hostId: "h1" }, true);
  });

  it("prompts before discarding a dirty edit form", async () => {
    const { navigate } = renderDetail(makeHost(), { tab: "edit" });
    await screen.findByRole("heading", { name: /Edit Jellyfin/ });

    // dirty the form
    const nameInput = screen.getByPlaceholderText("Service name");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Jellyfin 2");

    const cancels = screen.getAllByRole("button", { name: "Cancel" });
    await userEvent.click(cancels[cancels.length - 1]);
    // the guard interposes rather than navigating away
    const dialog = await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    expect(navigate).not.toHaveBeenCalledWith({ name: "host", hostId: "h1" }, true);

    // keep editing -> dialog closes, still on the form
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByText("Discard unsaved changes?")).not.toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalledWith({ name: "host", hostId: "h1" }, true);
  });

  it("discards the dirty form once the user confirms", async () => {
    const { navigate } = renderDetail(makeHost(), { tab: "edit" });
    await screen.findByRole("heading", { name: /Edit Jellyfin/ });

    const nameInput = screen.getByPlaceholderText("Service name");
    await userEvent.type(nameInput, "!");
    const cancels = screen.getAllByRole("button", { name: "Cancel" });
    await userEvent.click(cancels[cancels.length - 1]);

    const dialog = await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Discard changes" }));
    expect(navigate).toHaveBeenCalledWith({ name: "host", hostId: "h1" }, true);
  });
});
