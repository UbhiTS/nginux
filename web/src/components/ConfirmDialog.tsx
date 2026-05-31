import { useEffect } from "react";
import { Icon } from "../icons.tsx";

/** A styled in-app replacement for window.confirm — matches the app's modals
 *  (Esc cancels, Enter confirms, click-outside cancels). */
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
      if (e.key === "Enter" && !busy) onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onConfirm, onCancel, busy]);

  return (
    <div className="modal-backdrop" onClick={() => !busy && onCancel()}>
      <div className="card card-pad modal-card confirm-card" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className={`confirm-icon${danger ? " danger" : ""}`}>
          {danger ? <Icon.alert /> : <Icon.info />}
        </div>
        <div style={{ fontWeight: 650, fontSize: 15, marginBottom: 5 }}>{title}</div>
        <p className="muted" style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 20 }}>{message}</p>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
          <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm} disabled={busy} autoFocus>
            {busy ? <span className="spinner" /> : null}{confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
