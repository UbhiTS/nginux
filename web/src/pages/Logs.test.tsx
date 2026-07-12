import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MetricsSummary, GeoipStatus, LogEntry } from "../api.ts";

// Logs pulls a range-scoped metrics summary + geoip status + settings + recent
// logs on mount, streams live lines over EventSource (stubbed in setup.ts), and
// renders the shared analytics panels + traffic chart/map. Mock only the `api`
// methods it (and its children) call.
vi.mock("../api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.ts")>();
  return {
    ...actual,
    api: {
      metricsSummary: vi.fn(),
      geoipStatus: vi.fn(),
      settings: vi.fn(),
      recentLogs: vi.fn(),
      addBan: vi.fn(),
      traffic: vi.fn(),
    },
  };
});

import { Logs } from "./Logs.tsx";
import { api } from "../api.ts";

function makeSummary(over: Partial<MetricsSummary> = {}): MetricsSummary {
  return {
    totalRequests: 1234,
    totalBytes: 5_000_000,
    statusClass: { "2xx": 10, "3xx": 2, "4xx": 1, "5xx": 0 },
    errorRate: 1.2,
    p50: 12,
    p95: 48,
    topHosts: [],
    topIps: [{ key: "203.0.113.7", count: 9, country: "US" }],
    topPaths: [],
    topCountries: [{ key: "US", count: 9, topIps: [{ ip: "203.0.113.7", count: 9 }] }],
    ...over,
  };
}

const geoip: GeoipStatus = { present: true, active: true, sizeBytes: 1, updatedAt: null, countries: ["US"] };

function makeLine(over: Partial<LogEntry> = {}): LogEntry {
  return {
    ts: "2026-07-12T00:00:00Z",
    host: "media.example.com",
    method: "GET",
    path: "/stream",
    status: 200,
    bytes: 100,
    ip: "203.0.113.7",
    country: "US",
    ua: "curl",
    ms: 12,
    ...over,
  };
}

/** Grab the most-recently-constructed stubbed EventSource (see test/setup.ts). */
function lastStream() {
  const instances = (EventSource as unknown as { instances: Array<{ emit: (t: string, d: unknown) => void; closed: boolean }> }).instances;
  return instances[instances.length - 1];
}

beforeEach(() => {
  // Land on the logs route so the hash-persistence code is active (writeView is a
  // no-op off the /logs route, exactly like it is in the running app).
  window.location.hash = "#/logs";
  vi.mocked(api.metricsSummary).mockResolvedValue(makeSummary());
  vi.mocked(api.geoipStatus).mockResolvedValue(geoip);
  vi.mocked(api.settings).mockResolvedValue({ homeCountry: "" } as never);
  vi.mocked(api.recentLogs).mockResolvedValue([]);
  vi.mocked(api.addBan).mockResolvedValue({} as never);
  vi.mocked(api.traffic).mockResolvedValue({
    range: "1h", data: [1, 2, 3], total: "6", peak: "3", unit: "req", axis: ["a", "b", "c"],
  });
});

describe("Logs", () => {
  it("renders the analytics summary once metrics load", async () => {
    render(<Logs />);
    await waitFor(() => expect(api.metricsSummary).toHaveBeenCalledWith("1h"));
    // The stat cards reflect the summary.
    expect(await screen.findByText("1,234")).toBeInTheDocument();
    expect(screen.getByText("Response p95")).toBeInTheDocument();
    // The status-codes + top-IPs panels are present.
    expect(screen.getByText("Status codes")).toBeInTheDocument();
    expect(screen.getByText("203.0.113.7")).toBeInTheDocument();
  });

  it("surfaces an inline note + Retry when metrics fail, instead of erasing analytics", async () => {
    vi.mocked(api.metricsSummary).mockRejectedValueOnce(new Error("403"));
    render(<Logs />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Metrics aren't available.");
    // Analytics didn't just silently vanish — the failure is announced.
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeInTheDocument();

    // Retry pulls again; this time it succeeds and the summary renders.
    vi.mocked(api.metricsSummary).mockResolvedValue(makeSummary());
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("1,234")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("gives the range/metric toggles tab semantics inside labelled groups", async () => {
    render(<Logs />);
    await waitFor(() => expect(api.metricsSummary).toHaveBeenCalled());

    const rangeGroup = screen.getByRole("tablist", { name: "Time range" });
    const metricGroup = screen.getByRole("tablist", { name: "Metric" });
    // Default selections.
    expect(within(rangeGroup).getByRole("tab", { name: "1h" })).toHaveAttribute("aria-selected", "true");
    expect(within(metricGroup).getByRole("tab", { name: "Requests" })).toHaveAttribute("aria-selected", "true");
    expect(within(rangeGroup).getByRole("tab", { name: "7d" })).toHaveAttribute("aria-selected", "false");
  });

  it("persists the picked range to the URL hash and refetches for it", async () => {
    render(<Logs />);
    await waitFor(() => expect(api.metricsSummary).toHaveBeenCalledWith("1h"));

    await userEvent.click(screen.getByRole("tab", { name: "7d" }));

    expect(window.location.hash).toBe("#/logs/range=7d");
    await waitFor(() => expect(api.metricsSummary).toHaveBeenCalledWith("7d"));
    expect(screen.getByRole("tab", { name: "7d" })).toHaveAttribute("aria-selected", "true");
  });

  it("persists the picked metric to the URL hash", async () => {
    render(<Logs />);
    await waitFor(() => expect(api.metricsSummary).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("tab", { name: "Bandwidth" }));

    expect(window.location.hash).toBe("#/logs/metric=bandwidth");
    expect(screen.getByRole("tab", { name: "Bandwidth" })).toHaveAttribute("aria-selected", "true");
  });

  it("hydrates range + metric + filter from a shared deep link", async () => {
    window.location.hash = "#/logs/range=1d&metric=bandwidth&filter=203.0.113.7";
    render(<Logs />);

    // Metrics are pulled for the linked range, not the default.
    await waitFor(() => expect(api.metricsSummary).toHaveBeenCalledWith("1d"));
    expect(screen.getByRole("tab", { name: "1d" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Bandwidth" })).toHaveAttribute("aria-selected", "true");
    // The filter box is pre-populated from the link.
    expect(screen.getByPlaceholderText(/Filter host, IP, status, path/)).toHaveValue("203.0.113.7");
  });

  it("mirrors the live-log filter into the hash and keeps the tail streaming", async () => {
    render(<Logs />);
    await waitFor(() => expect(api.metricsSummary).toHaveBeenCalled());

    // A live line arrives over the stream and renders.
    lastStream().emit("log", makeLine({ path: "/first" }));
    expect(await screen.findByText("/first")).toBeInTheDocument();

    // Typing a filter narrows the view and is reflected in the URL.
    await userEvent.type(screen.getByPlaceholderText(/Filter host, IP, status, path/), "media");
    await waitFor(() => expect(window.location.hash).toBe("#/logs/filter=media"));
  });
});
