import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Topology as TopologyData } from "../types.ts";

// NetworkTraffic renders Topology (polls reachability + hostStats) and
// TrafficChart (polls traffic) — stub all three.
vi.mock("../api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.ts")>();
  return {
    ...actual,
    api: {
      reachability: vi.fn().mockResolvedValue({
        nginxUp: true, local80: true, local443: true,
        detectedPublicIp: "1.2.3.4", configuredPublicIp: "1.2.3.4",
        ipMismatch: false, ext80: true, ext443: true,
      }),
      hostStats: vi.fn().mockResolvedValue([]),
      traffic: vi.fn().mockResolvedValue({ range: "live", data: [1, 2, 3], total: "6", peak: "3", unit: "", axis: ["a", "b"] }),
    },
  };
});

import { NetworkTraffic } from "./NetworkTraffic.tsx";

function makeTopo(): TopologyData {
  return {
    internet: { label: "Internet" },
    gateway: { publicIp: "1.2.3.4", gatewayIp: "192.168.1.1" },
    servers: [
      {
        name: "nas", ip: "192.168.1.21", status: "online",
        services: [
          { id: "h1", name: "Media", iconUrl: "", domain: "media.example.com", port: 8096, health: "online", requireLogin: false, enabled: true, ssl: true },
        ],
      },
    ],
  };
}

describe("NetworkTraffic — pinned scope chip", () => {
  it("shows a 'Showing:' chip after a tile is clicked and clears it on chip click", async () => {
    render(<NetworkTraffic data={makeTopo()} navigate={vi.fn()} />);

    // No chip before anything is pinned.
    expect(screen.queryByText("Showing:")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Filter traffic to Media/ }));

    // Chip names the pinned service.
    expect(screen.getByText("Showing:")).toBeInTheDocument();
    const chip = screen.getByRole("button", { name: /Clear filter/ });
    expect(chip).toHaveTextContent("Media");

    // Clicking the chip clears the pin.
    fireEvent.click(chip);
    await waitFor(() => expect(screen.queryByText("Showing:")).toBeNull());
  });

  it("unpins when the same tile is clicked twice", () => {
    render(<NetworkTraffic data={makeTopo()} navigate={vi.fn()} />);
    const tile = () => screen.getByRole("button", { name: /(Filter traffic to|Stop filtering traffic to) Media/ });
    fireEvent.click(tile());
    expect(screen.getByText("Showing:")).toBeInTheDocument();
    fireEvent.click(tile());
    expect(screen.queryByText("Showing:")).toBeNull();
  });

  it("shows the loading placeholder when topology data is null", () => {
    render(<NetworkTraffic data={null} navigate={vi.fn()} />);
    expect(screen.getByText(/Loading network map/)).toBeInTheDocument();
  });
});
