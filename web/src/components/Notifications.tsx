import { useCallback, useEffect, useState } from "react";
import { api, type AppNotification } from "../api.ts";
import { Icon } from "../icons.tsx";

const STORAGE_KEY = "nginux_ignored_notifications";

function loadIgnored(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

/** Top-right toast stack for actionable problems (proxy down, unreachable
 *  services, temporary certs, …). Polls the control plane.
 *  - Dismiss  → hides until the next session (in-memory; shows up next time).
 *  - Ignore   → suppressed for good on this browser (persisted; until the
 *               underlying condition changes and the id changes).
 *  Critical, non-dismissible notices can only be dismissed, never ignored. */
export function Notifications() {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [ignored, setIgnored] = useState<Set<string>>(loadIgnored);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  const load = useCallback(async () => {
    try {
      setItems(await api.notifications());
    } catch {
      /* a transient failure shouldn't blow up the shell; retry next tick */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const dismiss = (id: string) => setDismissed((prev) => new Set(prev).add(id));

  const ignore = (id: string) => {
    setIgnored((prev) => {
      const next = new Set(prev).add(id);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };

  const visible = items.filter((n) => !ignored.has(n.id) && !dismissed.has(n.id));
  if (!visible.length) return null;

  return (
    <div className="toast-stack" role="region" aria-label="Notifications">
      {visible.map((n) => (
        <div key={n.id} className={`toast ${n.severity}`} role={n.severity === "critical" ? "alert" : "status"}>
          <span className="toast-icon">{n.severity === "info" ? <Icon.info /> : <Icon.alert />}</span>
          <div className="toast-body">
            <div className="toast-title">{n.title}</div>
            <div className="toast-msg">{n.message}</div>
            <div className="toast-actions">
              <button className="toast-btn" title="Hide for now - shows up again next time" onClick={() => dismiss(n.id)}>
                Dismiss
              </button>
              {n.dismissible && (
                <button className="toast-btn subtle" title="Don't show this again" onClick={() => ignore(n.id)}>
                  Ignore
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
