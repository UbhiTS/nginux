import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./Sidebar.tsx";
import type { ProxyHost } from "../types.ts";
import type { AuthUser } from "../api.ts";

// Sidebar itself calls no API, but its footer <Avatar> reads api.avatarUrl on
// mount and its admin-only <UpdateButton> calls api.updateStatus. Mock just those.
vi.mock("../api.ts", () => ({
  api: {
    avatarUrl: vi.fn(() => "/api/users/u1/avatar"),
    updateStatus: vi.fn(() => Promise.resolve({ available: false })),
  },
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
  mkHost({ id: "h-grafana", name: "Grafana", health: "online", enabled: true }),
  mkHost({ id: "h-paused", name: "Vaultwarden", health: "unknown", enabled: false }),
];

const user: AuthUser = {
  id: "u1",
  username: "tarun",
  email: "tarun@example.com",
  role: "admin",
  scope: "",
  twofaEnabled: true,
  mustChangePassword: false,
  createdAt: "2026-01-01T00:00:00Z",
  lastLoginAt: null,
};

function renderSidebar(over: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  const props = {
    hosts,
    route: { name: "dashboard" } as React.ComponentProps<typeof Sidebar>["route"],
    navigate: vi.fn(),
    theme: { theme: "dark" as const, cycleTheme: vi.fn() },
    user,
    onLogout: vi.fn(),
    ...over,
  };
  return { ...render(<Sidebar {...props} />), props };
}

beforeEach(() => vi.clearAllMocks());

// Some tests drive the mobile (off-canvas drawer) behavior, which the Sidebar detects
// via matchMedia. Default (from setup.ts) reports desktop (matches:false); these helpers
// flip it and restore afterward so tests stay isolated.
const realMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = realMatchMedia;
});
function setViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: mobile,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

describe("Sidebar", () => {
  it("renders the group labels and every nav item", () => {
    renderSidebar();
    for (const label of ["Manage", "Security", "System"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    for (const item of [
      "Dashboard", "Services", "Certificates", "Logs",
      "Agents & API", "Security Center", "Users & Access", "Settings",
    ]) {
      expect(screen.getByText(item)).toBeInTheDocument();
    }
    // The signed-in user is shown in the footer.
    expect(screen.getByText("tarun")).toBeInTheDocument();
    expect(screen.getByText("admin")).toBeInTheDocument();
  });

  it("marks the active route with the active class and aria-current", () => {
    renderSidebar({ route: { name: "certs" } });
    const active = screen.getByRole("link", { name: "Certificates" });
    expect(active).toHaveClass("active");
    expect(active).toHaveAttribute("aria-current", "page");
    // A non-active item carries neither.
    const inactive = screen.getByRole("link", { name: "Logs" });
    expect(inactive).not.toHaveClass("active");
    expect(inactive).not.toHaveAttribute("aria-current");
  });

  it("renders nav targets as real links with an href (so Cmd/middle-click opens a new tab)", () => {
    renderSidebar();
    expect(screen.getByRole("link", { name: "Certificates" })).toHaveAttribute("href", "#/certs");
    expect(screen.getByRole("link", { name: "Grafana" })).toHaveAttribute("href", "#/host/h-grafana");
  });

  it("navigates when a nav item is clicked", async () => {
    const { props } = renderSidebar();
    await userEvent.click(screen.getByRole("link", { name: "Settings" }));
    expect(props.navigate).toHaveBeenCalledWith({ name: "settings" });
  });

  it("does not intercept a modified (new-tab) click — lets the browser open a real tab", () => {
    const { props } = renderSidebar();
    fireEvent.click(screen.getByRole("link", { name: "Settings" }), { metaKey: true });
    fireEvent.click(screen.getByRole("link", { name: "Settings" }), { ctrlKey: true });
    expect(props.navigate).not.toHaveBeenCalled();
  });

  it("lists the service children under Services with a count", () => {
    renderSidebar();
    expect(screen.getByText("2")).toBeInTheDocument(); // svc-count
    expect(screen.getByRole("link", { name: "Grafana" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Vaultwarden" })).toBeInTheDocument();
  });

  it("shows a zero count and no children when there are no services", () => {
    renderSidebar({ hosts: [] });
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Grafana" })).not.toBeInTheDocument();
  });

  it("navigates to a host when its child row is clicked", async () => {
    const { props } = renderSidebar();
    await userEvent.click(screen.getByRole("link", { name: "Grafana" }));
    expect(props.navigate).toHaveBeenCalledWith({ name: "host", hostId: "h-grafana" });
  });

  it("marks the active host child", () => {
    renderSidebar({ route: { name: "host", hostId: "h-grafana" } });
    const child = screen.getByRole("link", { name: "Grafana" });
    expect(child).toHaveClass("active");
    expect(child).toHaveAttribute("aria-current", "page");
  });

  it("fires the wizard route from the 'Expose a service' add control", async () => {
    const { props } = renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Expose a service" }));
    expect(props.navigate).toHaveBeenCalledWith({ name: "wizard" });
    // The add button must not also trigger the parent's own services navigation.
    expect(props.navigate).toHaveBeenCalledTimes(1);
  });

  it("navigates to the services page when the Services parent is clicked", async () => {
    const { props } = renderSidebar();
    await userEvent.click(screen.getByText("Services"));
    expect(props.navigate).toHaveBeenCalledWith({ name: "services" });
  });

  it("collapses and expands the services group via the caret", async () => {
    renderSidebar();
    const child = screen.getByRole("link", { name: "Grafana" });
    const childrenBox = child.closest(".nav-children")!;
    expect(childrenBox).not.toHaveClass("collapsed");

    // Starts expanded: the caret offers to collapse.
    const caret = screen.getByRole("button", { name: "Collapse services" });
    expect(caret).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(caret);

    expect(childrenBox).toHaveClass("collapsed");
    const reopened = screen.getByRole("button", { name: "Expand services" });
    expect(reopened).toHaveAttribute("aria-expanded", "false");

    // Toggling the caret must not navigate anywhere.
    await userEvent.click(reopened);
    expect(childrenBox).not.toHaveClass("collapsed");
  });

  it("fires onLogout from the sign-out control", async () => {
    const { props } = renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(props.onLogout).toHaveBeenCalledTimes(1);
  });

  it("fires cycleTheme from the theme toggle", async () => {
    const cycleTheme = vi.fn();
    renderSidebar({ theme: { theme: "medium", cycleTheme } });
    await userEvent.click(screen.getByRole("button", { name: "Switch theme" }));
    expect(cycleTheme).toHaveBeenCalledTimes(1);
  });

  it("collapsing the group leaves the children in the DOM but hidden (regression on class-toggle behavior)", async () => {
    renderSidebar();
    // Both children remain queryable; collapse is a CSS concern via the class.
    const box = screen.getByRole("link", { name: "Grafana" }).closest(".nav-children")!;
    await userEvent.click(screen.getByRole("button", { name: "Collapse services" }));
    expect(within(box as HTMLElement).getByRole("link", { name: "Grafana" })).toBeInTheDocument();
    expect(within(box as HTMLElement).getByRole("link", { name: "Vaultwarden" })).toBeInTheDocument();
  });

  it("opens the command palette from the sidebar search trigger", async () => {
    const onOpenPalette = vi.fn();
    renderSidebar({ onOpenPalette });
    await userEvent.click(screen.getByRole("button", { name: /search/i }));
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
  });

  it("omits the search trigger when no palette handler is supplied", () => {
    renderSidebar();
    expect(screen.queryByRole("button", { name: /search/i })).not.toBeInTheDocument();
  });

  it("marks the off-canvas drawer inert when closed on mobile", () => {
    setViewport(true);
    const { container } = renderSidebar({ open: false });
    expect(container.querySelector("aside")).toHaveAttribute("inert");
  });

  it("is not inert when the drawer is open on mobile", () => {
    setViewport(true);
    const { container } = renderSidebar({ open: true });
    expect(container.querySelector("aside")).not.toHaveAttribute("inert");
  });

  it("never marks the sidebar inert on desktop", () => {
    setViewport(false);
    const { container } = renderSidebar({ open: false });
    expect(container.querySelector("aside")).not.toHaveAttribute("inert");
  });

  it("closes the open mobile drawer on Escape", async () => {
    setViewport(true);
    const onClose = vi.fn();
    renderSidebar({ open: true, onClose });
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
