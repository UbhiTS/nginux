import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal } from "./Modal.tsx";

describe("Modal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <Modal open={false} onClose={() => {}}>
        <p>hi</p>
      </Modal>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a labelled dialog when open", () => {
    render(
      <Modal open onClose={() => {}} labelledBy="t">
        <h2 id="t" className="modal-title">Delete host</h2>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "t");
  });

  it("moves focus into the dialog on open", () => {
    render(
      <Modal open onClose={() => {}}>
        <button>Confirm</button>
      </Modal>,
    );
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveFocus();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose}>
        <button>Confirm</button>
      </Modal>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on backdrop click but not on content click", async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose}>
        <button>Confirm</button>
      </Modal>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onClose).not.toHaveBeenCalled();
    // backdrop is the dialog's parent
    await userEvent.click(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the previously focused element on close", () => {
    const { rerender } = render(
      <>
        <button data-testid="trigger">Open</button>
        <Modal open={false} onClose={() => {}}>
          <button>Confirm</button>
        </Modal>
      </>,
    );
    const trigger = screen.getByTestId("trigger");
    trigger.focus();
    expect(trigger).toHaveFocus();
    rerender(
      <>
        <button data-testid="trigger">Open</button>
        <Modal open onClose={() => {}}>
          <button>Confirm</button>
        </Modal>
      </>,
    );
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveFocus();
    rerender(
      <>
        <button data-testid="trigger">Open</button>
        <Modal open={false} onClose={() => {}}>
          <button>Confirm</button>
        </Modal>
      </>,
    );
    expect(screen.getByTestId("trigger")).toHaveFocus();
  });
});
