import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

describe("ConfirmDialog", () => {
  it("renders the title, message and default confirm/cancel labels", () => {
    render(
      <ConfirmDialog
        title="Delete host?"
        message="This removes the reverse-proxy entry."
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText("Delete host?")).toBeInTheDocument();
    expect(screen.getByText("This removes the reverse-proxy entry.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("exposes the dialog role labelled by the title", () => {
    render(<ConfirmDialog title="Are you sure?" message="msg" onConfirm={() => {}} onCancel={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-label", "Are you sure?");
  });

  it("honours custom confirm/cancel labels", () => {
    render(
      <ConfirmDialog
        title="Restart"
        message="msg"
        confirmLabel="Restart now"
        cancelLabel="Keep running"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Restart now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep running" })).toBeInTheDocument();
  });

  it("calls onConfirm when the confirm button is clicked", async () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog title="t" message="m" onConfirm={onConfirm} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when the cancel button is clicked", async () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog title="t" message="m" onConfirm={() => {}} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when the backdrop is clicked", async () => {
    const onCancel = vi.fn();
    const { container } = render(
      <ConfirmDialog title="t" message="m" onConfirm={() => {}} onCancel={onCancel} />,
    );
    const backdrop = container.querySelector(".modal-backdrop") as HTMLElement;
    expect(backdrop).toBeTruthy();
    await userEvent.click(backdrop);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not cancel when clicking inside the dialog card", async () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog title="Title here" message="m" onConfirm={() => {}} onCancel={onCancel} />);
    await userEvent.click(screen.getByText("Title here"));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("closes on Escape and confirms on Enter", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog title="t" message="m" onConfirm={onConfirm} onCancel={onCancel} />);
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Enter}");
    expect(onConfirm).toHaveBeenCalled();
  });

  it("renders danger styling on the confirm button and icon when danger is set", () => {
    const { container } = render(
      <ConfirmDialog title="Delete" message="m" danger onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveClass("btn-danger");
    expect(container.querySelector(".confirm-icon.danger")).toBeTruthy();
  });

  it("uses the neutral primary button when danger is not set", () => {
    render(<ConfirmDialog title="Save" message="m" onConfirm={() => {}} onCancel={() => {}} />);
    const confirm = screen.getByRole("button", { name: "Confirm" });
    expect(confirm).toHaveClass("btn-primary");
    expect(confirm).not.toHaveClass("btn-danger");
  });

  it("disables both buttons and blocks Escape/Enter while busy", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog title="t" message="m" busy onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{Enter}");
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
