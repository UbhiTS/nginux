import type { ReactNode } from "react";
import { useFocusTrap } from "../hooks.ts";

// Shared modal shell: role=dialog + aria-modal, focus trapped inside, focus restored
// on close, Escape + backdrop-click to close. Modals previously declared the ARIA but
// implemented no focus management (Tab walked the page behind the backdrop). Use this
// (or the useFocusTrap hook directly) so every dialog behaves consistently.
export function Modal({
  open,
  onClose,
  labelledBy,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** id of the element that names the dialog (e.g. the .modal-title). */
  labelledBy?: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useFocusTrap<HTMLDivElement>(open, onClose);
  if (!open) return null;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`card modal-card${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
