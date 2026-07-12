import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Traffic } from "../types.ts";

vi.mock("../api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.ts")>();
  return { ...actual, api: { traffic: vi.fn() } };
});

import { TrafficChart } from "./TrafficChart.tsx";
import { api } from "../api.ts";

const trafficMock = api.traffic as ReturnType<typeof vi.fn>;

function makeTraffic(over: Partial<Traffic> = {}): Traffic {
  return {
    range: "1h",
    data: [0, 5, 10, 20, 10],
    total: "45",
    peak: "20",
    unit: "",
    axis: ["12:00", "12:30", "13:00"],
    ...over,
  };
}

/** Give the crosshair math a real width to map the pointer against (jsdom
 *  reports 0 for every getBoundingClientRect). */
function stubWidth(el: HTMLElement, left = 0, width = 600) {
  el.getBoundingClientRect = () => ({ left, width, top: 0, height: 170, right: left + width, bottom: 170, x: left, y: 0, toJSON() {} }) as DOMRect;
}

describe("TrafficChart", () => {
  it("shows a skeleton placeholder before data lands (reserving height)", () => {
    trafficMock.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = render(<TrafficChart range="1h" metric="requests" />);
    expect(container.querySelector(".skeleton")).toBeTruthy();
  });

  it("labels the chart svg as an image with a summary (total / peak / range)", async () => {
    trafficMock.mockResolvedValue(makeTraffic());
    render(<TrafficChart range="1h" metric="requests" />);
    const img = await screen.findByRole("img");
    const label = img.getAttribute("aria-label") ?? "";
    expect(label).toMatch(/Requests/);
    expect(label).toMatch(/over 1h/);
    expect(label).toMatch(/Total 45/);
    expect(label).toMatch(/peak 20/);
  });

  it("folds the scoped host into the aria-label", async () => {
    trafficMock.mockResolvedValue(makeTraffic());
    render(<TrafficChart range="1h" metric="requests" host="media.example.com" />);
    const img = await screen.findByRole("img");
    expect(img.getAttribute("aria-label")).toMatch(/for media\.example\.com/);
  });

  it("shows a crosshair tooltip with the nearest sample's value + timestamp on hover", async () => {
    trafficMock.mockResolvedValue(makeTraffic());
    const { container } = render(<TrafficChart range="1h" metric="requests" />);
    await screen.findByRole("img");
    const wrap = container.querySelector("svg[role='img']")!.parentElement as HTMLElement;
    stubWidth(wrap);
    fireEvent.mouseMove(wrap, { clientX: 300 }); // middle → sample index 2 (value 10)
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("10");
    expect(tip).toHaveTextContent("12:30"); // timestamp derived from the axis at the nearest sample
  });

  it("hides the tooltip when the pointer leaves", async () => {
    trafficMock.mockResolvedValue(makeTraffic());
    const { container } = render(<TrafficChart range="1h" metric="requests" />);
    await screen.findByRole("img");
    const wrap = container.querySelector("svg[role='img']")!.parentElement as HTMLElement;
    stubWidth(wrap);
    fireEvent.mouseMove(wrap, { clientX: 300 });
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    fireEvent.mouseLeave(wrap);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("draws two lines for bandwidth so the smaller series isn't occluded", async () => {
    trafficMock.mockResolvedValue(makeTraffic({ dataIn: [0, 2, 4, 3, 2], unit: "" }));
    const { container } = render(<TrafficChart range="1h" metric="bandwidth" />);
    await screen.findByRole("img");
    // One stroked line path per series (2), on top of the area fills.
    const lines = Array.from(container.querySelectorAll("svg path[stroke]"))
      .filter((p) => p.getAttribute("fill") === "none");
    expect(lines.length).toBe(2);
  });
});
