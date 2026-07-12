import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Topology as TopologyData, HealthStatus } from "../types.ts";
import type { Reachability } from "../api.ts";

// Topology polls api.reachability() + api.hostStats() on mount; stub both.
vi.mock("../api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.ts")>();
  return {
    ...actual,
    api: {
      reachability: vi.fn().mockResolvedValue({
        nginxUp: true, local80: true, local443: true,
        detectedPublicIp: "1.2.3.4", configuredPublicIp: "1.2.3.4",
        ipMismatch: false, ext80: true, ext443: true,
      } satisfies Reachability),
      hostStats: vi.fn().mockResolvedValue([]),
    },
  };
});

import { Topology } from "./Topology.tsx";
import { api } from "../api.ts";

function makeTopo(over: Partial<TopologyData> = {}): TopologyData {
  return {
    internet: { label: "Internet" },
    gateway: { publicIp: "1.2.3.4", gatewayIp: "192.168.1.1" },
    servers: [
      {
        name: "nas", ip: "192.168.1.21", status: "online",
        services: [
          { id: "h1", name: "Media", iconUrl: "", domain: "media.example.com", port: 8096, health: "online", requireLogin: false, enabled: true, ssl: true },
          { id: "h2", name: "Books", iconUrl: "", domain: "books.example.com", port: 8083, health: "down", requireLogin: false, enabled: true, ssl: false },
          { id: "h3", name: "Grafana", iconUrl: "", domain: "grafana.example.com", port: 9000, health: "online", requireLogin: false, enabled: false, ssl: false },
        ],
      },
    ],
    ...over,
  };
}

function setReducedMotion(on: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: on, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const props = (over: Partial<Parameters<typeof Topology>[0]> = {}): Parameters<typeof Topology>[0] => ({
  data: makeTopo(),
  navigate: vi.fn(),
  range: "live",
  scoped: null,
  onScope: vi.fn(),
  ...over,
});

afterEach(() => setReducedMotion(false));

describe("Topology — click-to-pin scoping", () => {
  it("toggles scope via onScope when a service tile is clicked", () => {
    const onScope = vi.fn();
    render(<Topology {...props({ onScope })} />);
    fireEvent.click(screen.getByRole("button", { name: /Filter traffic to Media/ }));
    expect(onScope).toHaveBeenCalledWith("media.example.com");
  });

  it("toggles scope from the keyboard (Enter / Space) on the tile", () => {
    const onScope = vi.fn();
    render(<Topology {...props({ onScope })} />);
    const tile = screen.getByRole("button", { name: /Filter traffic to Books/ });
    fireEvent.keyDown(tile, { key: "Enter" });
    fireEvent.keyDown(tile, { key: " " });
    expect(onScope).toHaveBeenCalledTimes(2);
    expect(onScope).toHaveBeenCalledWith("books.example.com");
  });

  it("marks the pinned tile with aria-pressed and reflects the clear label", () => {
    render(<Topology {...props({ scoped: "media.example.com" })} />);
    const tile = screen.getByRole("button", { name: /Stop filtering traffic to Media/ });
    expect(tile).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps host-detail navigation on the service name without toggling scope", () => {
    const navigate = vi.fn();
    const onScope = vi.fn();
    render(<Topology {...props({ navigate, onScope })} />);
    fireEvent.click(screen.getByRole("button", { name: "Media" }));
    expect(navigate).toHaveBeenCalledWith({ name: "host", hostId: "h1" });
    expect(onScope).not.toHaveBeenCalled();
  });
});

describe("Topology — status accessibility", () => {
  it("renders sr-only health labels for each service dot", () => {
    render(<Topology {...props()} />);
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getByText("Unreachable")).toBeInTheDocument(); // the 'down' service
    expect(screen.getByText("Paused")).toBeInTheDocument();      // the disabled service
  });

  it("marks the decorative flow SVG as aria-hidden", () => {
    const { container } = render(<Topology {...props()} />);
    expect(container.querySelector(".topo-lines")).toHaveAttribute("aria-hidden", "true");
  });

  it("shows the gateway problem explanation visibly in an aria-live region", async () => {
    (api.reachability as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      nginxUp: false, local80: false, local443: false,
      detectedPublicIp: null, configuredPublicIp: "1.2.3.4",
      ipMismatch: false, ext80: null, ext443: null,
    });
    render(<Topology {...props()} />);
    expect(await screen.findByText("nginx down on 80 / 443")).toBeInTheDocument();
    // The explanation used to live only in a hover title; now it's visible text.
    expect(screen.getByText(/proxy data plane may be down/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});

describe("Topology — reduced motion", () => {
  it("renders animated dots (animateMotion) when motion is allowed", async () => {
    setReducedMotion(false);
    const { container } = render(<Topology {...props()} />);
    await waitFor(() => expect(container.querySelector(".topo-lines path")).toBeTruthy());
    await waitFor(() => expect(container.querySelector("animateMotion")).toBeTruthy());
  });

  it("renders static beads and no SMIL animation when reduced motion is set", async () => {
    setReducedMotion(true);
    const { container } = render(<Topology {...props()} />);
    await waitFor(() => expect(container.querySelector(".topo-lines path")).toBeTruthy());
    expect(container.querySelector("animateMotion")).toBeNull();
    expect(container.querySelector(".topo-lines animate")).toBeNull();
  });
});
