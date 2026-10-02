import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Notifications } from "./Notifications.tsx";
import { api } from "../api.ts";

// The toast stack reaches the backend via api.notifications() (mount + 60s poll)
// and persists dismissible notice dismissals per-user via api.dismissNotifications()
// in addition to localStorage.
vi.mock("../api.ts", () => ({
  api: {
    notifications: vi.fn(),
    dismissNotifications: vi.fn().mockResolvedValue({ ok: true, dismissed: [] }),
  },
}));

type Notif = {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  message: string;
  dismissible: boolean;
};

const critical: Notif = {
  id: "n-critical",
  severity: "critical",
  title: "Proxy is down",
  message: "nginx failed to reload after the last change.",
  dismissible: false,
};

const warning: Notif = {
  id: "n-warning",
  severity: "warning",
  title: "Certificate expiring soon",
  message: "example.com renews in 5 days.",
  dismissible: true,
};

const info: Notif = {
  id: "n-info",
  severity: "info",
  title: "New version available",
  message: "NginUX v0.3.0 is ready to install.",
  dismissible: true,
};

function mockNotifications(list: Notif[]) {
  vi.mocked(api.notifications).mockResolvedValue(list);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Ignore persists ids here; wipe so tests don't filter each other's toasts.
  localStorage.clear();
});

describe("Notifications", () => {
  it("renders one toast per notification with its title and message", async () => {
    mockNotifications([warning, info]);
    render(<Notifications />);

    // Content arrives after the mount fetch resolves, so wait for it.
    expect(await screen.findByText("Certificate expiring soon")).toBeInTheDocument();
    expect(screen.getByText("example.com renews in 5 days.")).toBeInTheDocument();
    expect(screen.getByText("New version available")).toBeInTheDocument();
    expect(screen.getByText("NginUX v0.3.0 is ready to install.")).toBeInTheDocument();

    // Two toasts inside the labelled region.
    const region = screen.getByRole("region", { name: "Notifications" });
    expect(within(region).getAllByText("Dismiss")).toHaveLength(2);
  });

  it("applies the severity as a class and picks the matching a11y role", async () => {
    mockNotifications([critical, warning, info]);
    render(<Notifications />);

    const criticalToast = (await screen.findByText("Proxy is down")).closest(".toast")!;
    expect(criticalToast).toHaveClass("critical");
    // Critical is urgent -> assertive "alert".
    expect(criticalToast).toHaveAttribute("role", "alert");

    const warningToast = screen.getByText("Certificate expiring soon").closest(".toast")!;
    expect(warningToast).toHaveClass("warning");
    expect(warningToast).toHaveAttribute("role", "status");

    const infoToast = screen.getByText("New version available").closest(".toast")!;
    expect(infoToast).toHaveClass("info");
    expect(infoToast).toHaveAttribute("role", "status");
  });

  it("persists a dismissible toast both in localStorage and per-user via the API when Dismiss is clicked", async () => {
    mockNotifications([info]);
    render(<Notifications />);

    const dismiss = await screen.findByRole("button", { name: "Dismiss" });
    expect(dismiss).toHaveAttribute("title", "Dismiss — won't show again");

    await userEvent.click(dismiss);

    await waitFor(() =>
      expect(screen.queryByText("New version available")).not.toBeInTheDocument(),
    );
    expect(
      JSON.parse(localStorage.getItem("nginux_ignored_notifications") ?? "[]"),
    ).toContain("n-info");
    expect(api.dismissNotifications).toHaveBeenCalledWith(["n-info"]);
  });

  it("hides a non-dismissible critical notification only for the current view without persisting", async () => {
    mockNotifications([critical]);
    render(<Notifications />);

    const dismiss = await screen.findByRole("button", { name: "Dismiss" });
    expect(dismiss).toHaveAttribute("title", "Hide for now - shows up again next time");

    await userEvent.click(dismiss);

    await waitFor(() =>
      expect(screen.queryByText("Proxy is down")).not.toBeInTheDocument(),
    );
    expect(localStorage.getItem("nginux_ignored_notifications")).toBeNull();
    expect(api.dismissNotifications).not.toHaveBeenCalled();
  });

  it("filters out notifications whose id was previously ignored and syncs them to the server", async () => {
    localStorage.setItem("nginux_ignored_notifications", JSON.stringify(["n-info"]));
    mockNotifications([info, warning]);
    render(<Notifications />);

    // The still-active warning shows; the persisted-ignored info never does.
    expect(await screen.findByText("Certificate expiring soon")).toBeInTheDocument();
    expect(screen.queryByText("New version available")).not.toBeInTheDocument();
    expect(api.dismissNotifications).toHaveBeenCalledWith(["n-info"]);
  });

  it("keeps a persistent, empty polite live region mounted when there are no notifications", async () => {
    mockNotifications([]);
    render(<Notifications />);

    await waitFor(() => expect(api.notifications).toHaveBeenCalled());
    // The region stays mounted (so a later poll's toast lands in an already-observed
    // live region and gets announced) - it's just empty.
    const region = screen.getByRole("region", { name: "Notifications" });
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(within(region).queryByText("Dismiss")).not.toBeInTheDocument();
  });

  it("marks the live region polite so poll-driven toasts are announced", async () => {
    mockNotifications([warning]);
    render(<Notifications />);

    await screen.findByText("Certificate expiring soon");
    const region = screen.getByRole("region", { name: "Notifications" });
    expect(region).toHaveAttribute("aria-live", "polite");
    // Critical toasts still carry their own assertive alert role.
    expect(within(region).queryByRole("alert")).not.toBeInTheDocument();
  });
});
