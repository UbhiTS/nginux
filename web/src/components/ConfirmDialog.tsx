import { useId } from "react";
import { Icon } from "../icons.tsx";
import { useFocusTrap } from "../hooks.ts";

/** A styled in-app replacement for window.confirm - matches the app's modals
 *  (Esc cancels, Enter confirms, click-outside cancels). Focus is moved into the
 *  dialog, trapped, and restored on close via useFocusTrap; Enter-to-confirm is
 *  bound to the dialog element (not window) so pressing Enter elsewhere can't
 *  fire the confirm - which was dangerous for the destructive `danger` variant. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  // Escape closes only when not busy; pass undefined while busy so the trap's
  // Escape handler is a no-op mid-action.
  const ref = useFocusTrap<HTMLDivElement>(true, busy ? undefined : onCancel);

  return (
    <div className="modal-backdrop" onClick={() => !busy && onCancel()}>
      <div
        ref={ref}
        className="card card-pad modal-card confirm-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Scoped Enter-to-confirm: only fires while focus is inside the dialog.
          // preventDefault stops a focused Cancel button from also activating.
          if (e.key === "Enter" && !busy) {
            e.preventDefault();
            onConfirm();
          }
        }}
      >
        <div className={`confirm-icon${danger ? " danger" : ""}`}>
          {danger ? <Icon.alert /> : <Icon.info />}
        </div>
        <h2 id={titleId} className="modal-title" style={{ marginBottom: 5 }}>{title}</h2>
        <p className="muted" style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 20 }}>{message}</p>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
          <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm} disabled={busy}>
            {busy ? <span className="spinner" /> : null}{confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
