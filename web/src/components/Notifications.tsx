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

function persistIgnored(ids: Iterable<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    /* private browsing / quota */
  }
}

/** Top-right toast stack for actionable problems (proxy down, unreachable
 *  services, temporary certs, …). Polls the control plane.
 *  - Dismissible notices (`n.dismissible === true`) are suppressed permanently
 *    when dismissed, persisted BOTH per-user on the server (`/api/notifications/dismiss`)
 *    and per-browser in `localStorage` (until the underlying condition changes
 *    and produces a new notification id).
 *  - Critical, non-dismissible notices (`n.dismissible === false`) hide only for
 *    the current page view so an unresolved proxy outage still warns on reload. */
export function Notifications() {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [ignored, setIgnored] = useState<Set<string>>(loadIgnored);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  const load = useCallback(async () => {
    try {
      const list = await api.notifications();
      setItems(list);
      // Backfill: if this browser already ignored a dismissible notice in
      // localStorage before per-user server persistence existed, sync it up.
      const local = loadIgnored();
      const unsynced = list.filter((n) => n.dismissible && local.has(n.id)).map((n) => n.id);
      if (unsynced.length) {
        void Promise.resolve(api.dismissNotifications?.(unsynced)).catch(() => {});
      }
    } catch {
      /* a transient failure shouldn't blow up the shell; retry next tick */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const dismiss = (n: AppNotification) => {
    if (!n.dismissible) {
      setDismissed((prev) => new Set(prev).add(n.id));
      return;
    }
    setIgnored((prev) => {
      const next = new Set(prev).add(n.id);
      persistIgnored(next);
      return next;
    });
    void Promise.resolve(api.dismissNotifications?.([n.id])).catch(() => {});
  };

  const visible = items.filter((n) => !ignored.has(n.id) && !dismissed.has(n.id));

  // The live region is mounted permanently (even when empty) so a toast that
  // arrives from a later poll lands inside an already-observed region and is
  // announced. Returning null while empty meant screen readers never saw the
  // region get populated. aria-live="polite" for the container; critical toasts
  // additionally carry role="alert" (assertive) so they interrupt.
  return (
    <div className="toast-stack" role="region" aria-live="polite" aria-label="Notifications">
      {visible.map((n) => (
        <div key={n.id} className={`toast ${n.severity}`} role={n.severity === "critical" ? "alert" : "status"}>
          <span className="toast-icon">{n.severity === "info" ? <Icon.info /> : <Icon.alert />}</span>
          <div className="toast-body">
            <div className="toast-title">{n.title}</div>
            <div className="toast-msg">{n.message}</div>
            <div className="toast-actions">
              <button
                className="toast-btn"
                title={n.dismissible ? "Dismiss — won't show again" : "Hide for now - shows up again next time"}
                onClick={() => dismiss(n)}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
