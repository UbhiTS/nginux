import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AuditEvent, Ban, BlockedAttempts, Exposure, SecurityOverview } from "../api.ts";
import type { SecurityProfile } from "../types.ts";

// The page fetches everything through `api`; stub only the methods it calls.
vi.mock("../api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.ts")>();
  return {
    ...actual,
    api: {
      securityOverview: vi.fn(),
      exposure: vi.fn(),
      audit: vi.fn(),
      blockedAttempts: vi.fn(),
      bans: vi.fn(),
      addBan: vi.fn(),
      removeBan: vi.fn(),
      securityProfiles: vi.fn(),
      createSecurityProfile: vi.fn(),
      deleteSecurityProfile: vi.fn(),
    },
  };
});

import { SecurityCenter, classifyBanTarget } from "./SecurityCenter.tsx";
import { api } from "../api.ts";

function makeOverview(over: Partial<SecurityOverview> = {}): SecurityOverview {
  return { score: 90, rating: "Strong", exposed: 3, unprotected: 0, failedLogins24h: 0, activeSessions: 2, ...over };
}
function makeExposure(over: Partial<Exposure> = {}): Exposure {
  return { id: "h1", name: "Jellyfin", iconUrl: "", domain: "media.example.com", https: true, login: true, twofa: false, countryLock: false, wellProtected: true, ...over };
}
function makeEvent(over: Partial<AuditEvent> = {}): AuditEvent {
  return { id: 1, ts: "2026-07-01T10:00:00Z", type: "login.success", severity: "info", actor: "admin", summary: "signed in", ip: "1.2.3.4", meta: {}, ...over };
}
function makeBan(over: Partial<Ban> = {}): Ban {
  return { ip: "5.6.7.8", reason: "manual block", source: "manual", createdAt: "2026-07-01T10:00:00Z", expiresAt: null, ...over };
}
function makeBlocked(over: Partial<BlockedAttempts> = {}): BlockedAttempts {
  return { total: 0, byCountry: [], topIps: [], allowedCountries: [], ...over };
}
function makeProfile(over: Partial<SecurityProfile> = {}): SecurityProfile {
  return { id: "p1", name: "Locked down", description: "2FA everywhere", fields: {}, builtin: false, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...over };
}

function renderSC(tab: string) {
  const setTab = vi.fn();
  render(<SecurityCenter tab={tab} setTab={setTab} />);
  return { setTab };
}

beforeEach(() => {
  window.location.hash = "";
  vi.mocked(api.securityOverview).mockResolvedValue(makeOverview());
  vi.mocked(api.exposure).mockResolvedValue([]);
  vi.mocked(api.audit).mockResolvedValue([]);
  vi.mocked(api.blockedAttempts).mockResolvedValue(makeBlocked());
  vi.mocked(api.bans).mockResolvedValue([]);
  vi.mocked(api.addBan).mockResolvedValue(makeBan());
  vi.mocked(api.removeBan).mockResolvedValue({ ok: true });
  vi.mocked(api.securityProfiles).mockResolvedValue([]);
  vi.mocked(api.createSecurityProfile).mockResolvedValue(makeProfile());
  vi.mocked(api.deleteSecurityProfile).mockResolvedValue({ ok: true });
});

describe("classifyBanTarget", () => {
  it("accepts plain IPv4 and rejects garbage / out-of-range octets", () => {
    expect(classifyBanTarget("1.2.3.4")).toMatchObject({ valid: true, isCidr: false });
    expect(classifyBanTarget("999.1.1.1").valid).toBe(false);
    expect(classifyBanTarget("not-an-ip").valid).toBe(false);
    expect(classifyBanTarget("").valid).toBe(false);
  });

  it("accepts CIDR ranges and flags private/LAN subnets", () => {
    expect(classifyBanTarget("203.0.113.0/24")).toMatchObject({ valid: true, isCidr: true, isPrivate: false });
    expect(classifyBanTarget("10.0.0.0/8")).toMatchObject({ valid: true, isCidr: true, isPrivate: true });
    expect(classifyBanTarget("192.168.1.0/24").isPrivate).toBe(true);
    expect(classifyBanTarget("1.2.3.4/33").valid).toBe(false);
  });
});

describe("SecurityCenter — security score ring", () => {
  it("turns the ring red and rates 'At risk' for a low score", async () => {
    vi.mocked(api.securityOverview).mockResolvedValue(makeOverview({ score: 40 }));
    const { container } = render(<SecurityCenter tab="overview" setTab={vi.fn()} />);
    expect(await screen.findByText(/Security score: At risk/)).toBeInTheDocument();
    const arc = container.querySelector(".ring")!.querySelectorAll("circle")[1];
    expect(arc.getAttribute("stroke")).toBe("var(--red)");
  });

  it("uses yellow / 'Fair' for a middling score", async () => {
    vi.mocked(api.securityOverview).mockResolvedValue(makeOverview({ score: 60 }));
    const { container } = render(<SecurityCenter tab="overview" setTab={vi.fn()} />);
    expect(await screen.findByText(/Security score: Fair/)).toBeInTheDocument();
    expect(container.querySelector(".ring")!.querySelectorAll("circle")[1].getAttribute("stroke")).toBe("var(--yellow)");
  });

  it("uses green / 'Strong' for a high score", async () => {
    vi.mocked(api.securityOverview).mockResolvedValue(makeOverview({ score: 92 }));
    const { container } = render(<SecurityCenter tab="overview" setTab={vi.fn()} />);
    expect(await screen.findByText(/Security score: Strong/)).toBeInTheDocument();
    expect(container.querySelector(".ring")!.querySelectorAll("circle")[1].getAttribute("stroke")).toBe("var(--green)");
  });

  it("turns the 'reachable without a login' advice into a link to the exposure tab", async () => {
    vi.mocked(api.securityOverview).mockResolvedValue(makeOverview({ unprotected: 2 }));
    vi.mocked(api.exposure).mockResolvedValue([makeExposure({ wellProtected: false }), makeExposure({ id: "h2", wellProtected: false })]);
    const { setTab } = renderSC("overview");
    const link = await screen.findByRole("button", { name: /2 services reachable without a login/ });
    await userEvent.click(link);
    expect(setTab).toHaveBeenCalledWith("exposure");
  });
});

describe("SecurityCenter — exposure list", () => {
  it("navigates to a service's host page when its row is activated", async () => {
    vi.mocked(api.exposure).mockResolvedValue([makeExposure({ id: "h7", name: "Grafana", wellProtected: false })]);
    renderSC("exposure");
    const row = await screen.findByRole("button", { name: "Open Grafana" });
    await userEvent.click(row);
    expect(window.location.hash).toBe("#/host/h7");
  });

  it("shows a zero-state instead of a bare header when nothing is exposed", async () => {
    vi.mocked(api.exposure).mockResolvedValue([]);
    renderSC("exposure");
    expect(await screen.findByText(/No services are exposed yet/)).toBeInTheDocument();
  });

  it("shows an error state (not a false empty state) when the fetch drops", async () => {
    vi.mocked(api.exposure).mockRejectedValue(new Error("network down"));
    renderSC("exposure");
    expect(await screen.findByText(/Couldn’t load this list/)).toBeInTheDocument();
    expect(screen.queryByText(/No services are exposed yet/)).not.toBeInTheDocument();
  });
});

describe("SecurityCenter — deny list", () => {
  it("labels each ban source correctly, including geoip", async () => {
    vi.mocked(api.bans).mockResolvedValue([
      makeBan({ ip: "1.1.1.1", source: "manual" }),
      makeBan({ ip: "2.2.2.2", source: "auto" }),
      makeBan({ ip: "3.3.3.3", source: "geoip" }),
    ]);
    renderSC("denylist");
    expect(await screen.findByText("manual")).toBeInTheDocument();
    expect(screen.getByText("auto-ban")).toBeInTheDocument();
    expect(screen.getByText("geo-block")).toBeInTheDocument();
  });

  it("shows 'permanent' for open-ended bans and a countdown for expiring ones", async () => {
    const soon = new Date(Date.now() + 26 * 3600 * 1000).toISOString();
    vi.mocked(api.bans).mockResolvedValue([
      makeBan({ ip: "1.1.1.1", expiresAt: null }),
      makeBan({ ip: "2.2.2.2", expiresAt: soon }),
    ]);
    renderSC("denylist");
    expect(await screen.findByText(/permanent/)).toBeInTheDocument();
    expect(screen.getByText(/26 hr/)).toBeInTheDocument();
  });

  it("keeps the roster intact (no false empty-state) when the bans fetch fails", async () => {
    vi.mocked(api.bans).mockRejectedValue(new Error("boom"));
    renderSC("denylist");
    expect(await screen.findByText(/Couldn’t load this list/)).toBeInTheDocument();
    expect(screen.queryByText(/Deny list is empty/)).not.toBeInTheDocument();
  });

  it("disables Block for an invalid target and enables it for a valid IP", async () => {
    renderSC("denylist");
    const input = await screen.findByLabelText(/IP address or CIDR range to block/);
    const block = screen.getByRole("button", { name: "Block" });
    expect(block).toBeDisabled();
    await userEvent.type(input, "203.0.113.5");
    expect(block).toBeEnabled();
  });

  it("blocks a single IP directly (Enter submits the form) and toasts success", async () => {
    renderSC("denylist");
    const input = await screen.findByLabelText(/IP address or CIDR range to block/);
    await userEvent.type(input, "203.0.113.5{Enter}");
    await waitFor(() => expect(api.addBan).toHaveBeenCalledWith("203.0.113.5", "Blocked from Security Center"));
    expect(await screen.findByText(/Blocked 203\.0\.113\.5/)).toBeInTheDocument();
  });

  it("confirms a CIDR block through a dialog before banning, warning about LAN ranges", async () => {
    renderSC("denylist");
    const input = await screen.findByLabelText(/IP address or CIDR range to block/);
    await userEvent.type(input, "10.0.0.0/8");
    await userEvent.click(screen.getByRole("button", { name: "Block" }));

    const dialog = await screen.findByRole("dialog", { name: /Block an entire range/ });
    expect(within(dialog).getByText(/private \/ LAN subnet/)).toBeInTheDocument();
    expect(api.addBan).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Block range" }));
    await waitFor(() => expect(api.addBan).toHaveBeenCalledWith("10.0.0.0/8", "Blocked from Security Center"));
  });

  it("confirms an unblock through a dialog before removing", async () => {
    vi.mocked(api.bans).mockResolvedValue([makeBan({ ip: "9.9.9.9" })]);
    renderSC("denylist");
    await userEvent.click(await screen.findByRole("button", { name: "Unblock" }));

    const dialog = await screen.findByRole("dialog", { name: /Remove from deny list/ });
    expect(api.removeBan).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Unblock" }));
    await waitFor(() => expect(api.removeBan).toHaveBeenCalledWith("9.9.9.9"));
    expect(await screen.findByText(/Unblocked 9\.9\.9\.9/)).toBeInTheDocument();
  });
});

describe("SecurityCenter — profiles", () => {
  it("confirms a create and surfaces a 'created' confirmation", async () => {
    renderSC("profiles");
    await waitFor(() => expect(api.securityProfiles).toHaveBeenCalled());
    await userEvent.type(screen.getByLabelText("Profile name"), "Hardened");
    await userEvent.click(screen.getByRole("button", { name: "Create profile" }));
    await waitFor(() => expect(api.createSecurityProfile).toHaveBeenCalledWith("Hardened", "", {}));
    expect(await screen.findByText(/Profile “Hardened” created/)).toBeInTheDocument();
  });

  it("routes a profile delete through a confirm dialog", async () => {
    vi.mocked(api.securityProfiles).mockResolvedValue([makeProfile({ id: "p9", name: "Old" })]);
    renderSC("profiles");
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog", { name: /Delete profile/ });
    expect(api.deleteSecurityProfile).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteSecurityProfile).toHaveBeenCalledWith("p9"));
  });
});
