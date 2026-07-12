import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HostAnalytics } from "./HostAnalytics.tsx";
import { api, type LogEntry, type MetricsSummary } from "../api.ts";
import type { Traffic } from "../types.ts";

// HostAnalytics + the panels it mounts (TrafficChart / TrafficMap / AnalyticsPanels)
// reach the backend only through these api methods; stub them all so nothing hits
// the network. The live log opens an EventSource, which the test setup stubs.
vi.mock("../api.ts", () => ({
  api: {
    hostMetrics: vi.fn(),
    traffic: vi.fn(),
    recentLogs: vi.fn(),
    geoipStatus: vi.fn(),
    settings: vi.fn(),
    addBan: vi.fn(),
  },
}));

const DOMAIN = "app.example.com";

const summary: MetricsSummary = {
  totalRequests: 1234,
  totalBytes: 5_000_000,
  statusClass: { "2xx": 100, "3xx": 5, "4xx": 20, "5xx": 3 },
  errorRate: 2,
  p50: 4,
  p95: 12,
  topHosts: [],
  topIps: [{ key: "1.2.3.4", count: 9, country: "US" }],
  topPaths: [{ key: "/api", count: 7 }],
  topCountries: [],
};

const traffic: Traffic = {
  range: "1d",
  data: [1, 2, 3],
  total: "1.2k",
  peak: "3",
  unit: "req",
  axis: ["a", "b", "c"],
};

function logLine(over: Partial<LogEntry>): LogEntry {
  return {
    ts: "2026-07-12T00:00:00Z",
    host: DOMAIN,
    method: "GET",
    path: "/",
    status: 200,
    bytes: 100,
    ip: "1.2.3.4",
    country: "US",
    ua: "test",
    ms: 5,
    ...over,
  };
}

/** The controllable EventSource the test setup installs. */
type MockES = { emit: (type: string, data: unknown) => void; closed: boolean };
const esInstances = () => (EventSource as unknown as { instances: MockES[] }).instances;

beforeEach(() => {
  vi.clearAllMocks();
  esInstances().length = 0;
  vi.mocked(api.hostMetrics).mockResolvedValue(summary);
  vi.mocked(api.traffic).mockResolvedValue(traffic);
  vi.mocked(api.recentLogs).mockResolvedValue([]);
  vi.mocked(api.geoipStatus).mockResolvedValue({ present: true, active: true, sizeBytes: 1, updatedAt: null, countries: [] });
  vi.mocked(api.settings).mockResolvedValue({ homeCountry: "US" } as never);
  vi.mocked(api.addBan).mockResolvedValue({} as never);
});

afterEach(() => {
  // Some tests flip document.hidden; always restore the default (visible).
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});

describe("HostAnalytics range tabs", () => {
  it("exposes the range toggle as a tablist with the active range aria-selected", () => {
    render(<HostAnalytics domain={DOMAIN} />);
    const tablist = screen.getByRole("tablist", { name: "Time range" });
    expect(tablist).toBeInTheDocument();
    // Default range is 1d.
    expect(screen.getByRole("tab", { name: "1d" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "4h" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "live" })).toBeInTheDocument();
  });

  it("moves aria-selected when a different range is clicked", async () => {
    render(<HostAnalytics domain={DOMAIN} />);
    await userEvent.click(screen.getByRole("tab", { name: "7d" }));
    expect(screen.getByRole("tab", { name: "7d" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "1d" })).toHaveAttribute("aria-selected", "false");
  });
});

describe("HostAnalytics metric tabs", () => {
  it("exposes the requests/bandwidth toggle as a tablist once the traffic section opens", async () => {
    render(<HostAnalytics domain={DOMAIN} />);
    await userEvent.click(screen.getByText("Traffic & errors"));
    const tablist = await screen.findByRole("tablist", { name: "Chart metric" });
    expect(tablist).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Requests" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Bandwidth" })).toHaveAttribute("aria-selected", "false");

    await userEvent.click(screen.getByRole("tab", { name: "Bandwidth" }));
    expect(screen.getByRole("tab", { name: "Bandwidth" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Requests" })).toHaveAttribute("aria-selected", "false");
  });
});

describe("HostAnalytics traffic-chart gating", () => {
  it("does not mount (poll) the TrafficChart while the section is collapsed", () => {
    render(<HostAnalytics domain={DOMAIN} />);
    expect(api.traffic).not.toHaveBeenCalled();
  });

  it("mounts the chart on expand and unmounts it (stops the poll) when the tab is hidden", async () => {
    render(<HostAnalytics domain={DOMAIN} />);
    await userEvent.click(screen.getByText("Traffic & errors"));
    // Chart mounted → traffic pulled → its "Peak" metric renders.
    expect(await screen.findByText("Peak")).toBeInTheDocument();
    await waitFor(() => expect(api.traffic).toHaveBeenCalled());

    // Background the tab: the hidden chart unmounts, tearing down its interval.
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(screen.queryByText("Peak")).not.toBeInTheDocument());
  });
});

describe("HostAnalytics live log", () => {
  it("keeps an existing row's DOM node when a new line is prepended (stable keys)", async () => {
    vi.mocked(api.recentLogs).mockResolvedValue([logLine({ path: "/first", ip: "10.0.0.1" })]);
    render(<HostAnalytics domain={DOMAIN} />);
    await userEvent.click(screen.getByText("Live access log"));

    const firstRow = (await screen.findByText("/first")).parentElement;
    expect(firstRow).toBeTruthy();

    // Push a newer line at the top of the stream.
    const es = esInstances()[esInstances().length - 1];
    es.emit("log", logLine({ path: "/second", ip: "10.0.0.2" }));

    await screen.findByText("/second");
    // Index keys would repurpose the first node for "/second" and shift "/first"
    // to a different node; a stable id keeps "/first" on its original node.
    expect(screen.getByText("/first").parentElement).toBe(firstRow);
  });

  it("closes the stream when the live-log section is collapsed", async () => {
    render(<HostAnalytics domain={DOMAIN} />);
    await userEvent.click(screen.getByText("Live access log"));
    await waitFor(() => expect(esInstances().length).toBe(1));
    const es = esInstances()[0];
    await userEvent.click(screen.getByText("Live access log"));
    await waitFor(() => expect(es.closed).toBe(true));
  });
});
