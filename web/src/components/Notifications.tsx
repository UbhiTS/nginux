import { useCallback, useEffect, useState } from "react";
import { api, type AppNotification } from "../api.ts";
import { Icon } from "../icons.tsx";

const STORAGE_KEY = "nginux_dismissed_notifications";

function loadDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

/** App-wide banner stack for actionable problems (proxy down, unreachable
 *  services, temporary certs, …). Polls the control plane; dismissals persist
 *  per-browser and only clear when the underlying condition changes (new id). */
export function Notifications() {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed);

  const load = useCallback(async () => {
    try {
      setItems(await api.notifications());
    } catch {
      /* a transient failure shouldn't blow up the shell; try again next tick */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const dismiss = (id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev).add(id);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };

  const visible = items.filter((n) => !dismissed.has(n.id));
  if (!visible.length) return null;

  return (
    <div className="notif-stack" role="region" aria-label="Notifications">
      {visible.map((n) => (
        <div key={n.id} className={`notif-banner ${n.severity}`} role={n.severity === "critical" ? "alert" : "status"}>
          <span className="notif-icon">{n.severity === "info" ? <Icon.info /> : <Icon.alert />}</span>
          <div className="notif-body">
            <div className="notif-title">{n.title}</div>
            <div className="notif-msg">{n.message}</div>
          </div>
          {n.dismissible && (
            <button className="notif-x" aria-label="Dismiss notification" onClick={() => dismiss(n.id)}>
              <Icon.x />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
