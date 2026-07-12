import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Switch } from "./Switch.tsx";

describe("Switch", () => {
  it("exposes role=switch with an accessible name and checked state", () => {
    render(<Switch checked label="Require 2FA" onChange={() => {}} />);
    const sw = screen.getByRole("switch", { name: "Require 2FA" });
    expect(sw).toHaveAttribute("aria-checked", "true");
  });

  it("reflects the unchecked state", () => {
    render(<Switch checked={false} label="Require 2FA" onChange={() => {}} />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it("calls onChange with the toggled value on click", async () => {
    const onChange = vi.fn();
    render(<Switch checked={false} label="Auto-renew" onChange={onChange} />);
    await userEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("is operable by keyboard (Space/Enter activate a button)", async () => {
    const onChange = vi.fn();
    render(<Switch checked label="Auto-renew" onChange={onChange} />);
    screen.getByRole("switch").focus();
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("does not fire when disabled", async () => {
    const onChange = vi.fn();
    render(<Switch checked={false} label="X" disabled onChange={onChange} />);
    await userEvent.click(screen.getByRole("switch"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("supports labelledBy for a visible external label", () => {
    render(
      <>
        <span id="lbl">Rate limiting</span>
        <Switch checked labelledBy="lbl" onChange={() => {}} />
      </>,
    );
    expect(screen.getByRole("switch", { name: "Rate limiting" })).toBeInTheDocument();
  });
});
