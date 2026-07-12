import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StatusCodeBars, TopSourceIps, CountryBars } from "./AnalyticsPanels.tsx";

describe("StatusCodeBars", () => {
  it("renders a row per status class with its count", () => {
    render(<StatusCodeBars statusClass={{ "2xx": 100, "3xx": 5, "4xx": 20, "5xx": 3 }} />);
    for (const cls of ["2xx", "3xx", "4xx", "5xx"]) {
      expect(screen.getByText(cls)).toBeInTheDocument();
    }
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("20")).toBeInTheDocument();
  });
});

describe("TopSourceIps", () => {
  const ips = [
    { key: "1.2.3.4", count: 9, country: "US" },
    { key: "5.6.7.8", count: 4, country: "" },
  ];

  it("lists each IP with its count and country", () => {
    render(<TopSourceIps ips={ips} blocked={{}} onPick={() => {}} onBlock={() => {}} />);
    expect(screen.getByText("1.2.3.4")).toBeInTheDocument();
    expect(screen.getByText("5.6.7.8")).toBeInTheDocument();
    expect(screen.getByText(/United States/)).toBeInTheDocument();
  });

  it("calls onPick with the IP when its button is clicked", async () => {
    const onPick = vi.fn();
    render(<TopSourceIps ips={ips} blocked={{}} onPick={onPick} onBlock={() => {}} />);
    await userEvent.click(screen.getByText("1.2.3.4"));
    expect(onPick).toHaveBeenCalledWith("1.2.3.4");
  });

  it("calls onBlock from the shield button", async () => {
    const onBlock = vi.fn();
    render(<TopSourceIps ips={ips} blocked={{}} onPick={() => {}} onBlock={onBlock} />);
    await userEvent.click(screen.getAllByTitle("Block this IP on all services")[0]);
    expect(onBlock).toHaveBeenCalledWith("1.2.3.4");
  });

  it("honours the custom pickTitle and emptyText props (used by HostAnalytics)", () => {
    const { rerender } = render(
      <TopSourceIps ips={ips} blocked={{}} onPick={() => {}} onBlock={() => {}} pickTitle="Show this IP in the live log" />,
    );
    expect(screen.getAllByTitle("Show this IP in the live log").length).toBe(2);
    rerender(<TopSourceIps ips={[]} blocked={{}} onPick={() => {}} onBlock={() => {}} emptyText="No traffic in this window." />);
    expect(screen.getByText("No traffic in this window.")).toBeInTheDocument();
  });

  it("marks a blocked IP's shield as done and disabled", () => {
    render(<TopSourceIps ips={ips} blocked={{ "1.2.3.4": "done" }} onPick={() => {}} onBlock={() => {}} />);
    expect(screen.getByTitle("Blocked on all services")).toBeDisabled();
  });
});

describe("CountryBars", () => {
  const countries = [
    { key: "US", count: 20, topIps: [] },
    { key: "DE", count: 8, topIps: [] },
  ];

  it("renders a bar per country with name and count", () => {
    render(<CountryBars countries={countries} />);
    expect(screen.getByText(/United States/)).toBeInTheDocument();
    expect(screen.getByText(/Germany/)).toBeInTheDocument();
    expect(screen.getByText("20")).toBeInTheDocument();
  });

  it("shows emptyHint when empty and a hint is provided", () => {
    render(<CountryBars countries={[]} emptyHint="No located visitors yet." />);
    expect(screen.getByText("No located visitors yet.")).toBeInTheDocument();
  });

  it("renders nothing when empty and no hint is given", () => {
    const { container } = render(<CountryBars countries={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
