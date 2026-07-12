import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { TrafficMap } from "./TrafficMap.tsx";
import type { MetricsSummary } from "../api.ts";

const countries: MetricsSummary["topCountries"] = [
  { key: "US", count: 120, topIps: [{ ip: "1.2.3.4", count: 40 }] },
  { key: "DE", count: 60, topIps: [] },
];

const noop = () => {};
const asyncNoop = async () => {};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TrafficMap", () => {
  it("renders the country bubbles and the map land", () => {
    const { container } = render(
      <TrafficMap countries={countries} homeCountry="US" onPickIp={noop} onBlockIp={asyncNoop} />,
    );
    // Land rings + bubbles all render as SVG paths/circles.
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(container.querySelectorAll("circle").length).toBeGreaterThan(0);
  });

  it("animates the arc dots when the user has no reduced-motion preference", () => {
    const { container } = render(
      <TrafficMap countries={countries} homeCountry="US" onPickIp={noop} onBlockIp={asyncNoop} />,
    );
    // DE -> US arc carries a travelling <animateMotion> dot.
    expect(container.querySelector("animateMotion")).toBeInTheDocument();
  });

  it("renders static arc dots (no animation) when reduced motion is preferred", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const { container } = render(
      <TrafficMap countries={countries} homeCountry="US" onPickIp={noop} onBlockIp={asyncNoop} />,
    );
    expect(container.querySelector("animateMotion")).not.toBeInTheDocument();
    // The map itself still renders.
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});
