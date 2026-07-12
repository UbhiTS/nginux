import { useState, useEffect, useMemo } from "react";
import type { Route } from "../App.tsx";
import { api, certForHost, type Certificate } from "../api.ts";
import type { ProxyHost, SecurityProfile } from "../types.ts";
import { healthClass } from "../types.ts";
import { Icon } from "../icons.tsx";
import { ServiceIcon } from "../components/ServiceIcon.tsx";
import { Switch } from "../components/Switch.tsx";
import { Field } from "../components/Field.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { days, plural } from "../format.ts";

const statusText = (h: ProxyHost) => {
  if (h.health === "down") return "Can't reach service";
  const bits = ["Online"];
  if (h.ssl) bits.push("Secured");
  if (h.require2fa) bits.push("2FA");
  else if (h.requireLogin) bits.push("Login");
  else bits.push("No login");
  return bits.join(" · ");
};

// The cert badge, read from the cert store (the source of truth) - not the stale
// host.certExpiresAt - so it matches the host detail + Certificates page exactly.
function certBadge(h: ProxyHost, certs: Certificate[]): { label: string; detail: string } {
  if (!h.ssl) return { label: "No HTTPS", detail: "not encrypted" };
  const c = certForHost(h, certs);
  if (!c) return { label: "Self-signed", detail: "untrusted" };
  const trusted = c.method !== "selfsigned";
  const detail = c.daysRemaining != null
    ? (c.daysRemaining < 0 ? "expired" : `${days(c.daysRemaining)} left`)
    : trusted ? "-" : "untrusted";
  const label = c.status === "valid" ? (trusted ? "Valid" : "Self-signed")
    : c.status === "expiring" ? "Expiring"
    : c.status === "expired" ? "Expired"
    : c.status === "error" ? "Failed"
    : c.status === "pending" ? "Pending"
    : "Self-signed";
  return { label, detail: c.status === "error" ? "issuance failed" : detail };
}

// Days-until-expiry for a host's cert, for the cert-expiry sort. null (no cert /
// no HTTPS) sorts last; expired (negative) sorts first.
function certDays(h: ProxyHost, certs: Certificate[]): number | null {
  if (!h.ssl) return null;
  const c = certForHost(h, certs);
  return c?.daysRemaining ?? null;
}

type StatusFilter = "all" | "online" | "down" | "paused";
type SortKey = "name" | "status" | "cert";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Services({
  hosts,
  navigate,
  reload,
}: {
  hosts: ProxyHost[];
  navigate: (r: Route) => void;
  reload: () => Promise<void>;
}) {
  const [toggling, setToggling] = useState<string | null>(null);
  const [certs, setCerts] = useState<Certificate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [profiles, setProfiles] = useState<SecurityProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Optimistic pause/resume: reflect the flip immediately, revert on failure.
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});

  // Search / filter / sort controls.
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortKey>("name");

  useEffect(() => { api.certificates().then(setCerts).catch(() => {}); }, []);
  useEffect(() => { api.securityProfiles().then(setProfiles).catch(() => {}); }, []);
  // Debounce the free-text query so we don't refilter on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  const isEnabled = (h: ProxyHost) => optimistic[h.id] ?? h.enabled;

  // The shown list: search + status filter + sort, all derived (never mutating hosts).
  const shown = useMemo(() => {
    const q = debounced.trim().toLowerCase();
    let list = hosts;
    if (q) {
      list = list.filter((h) =>
        h.name.toLowerCase().includes(q) ||
        h.domain.toLowerCase().includes(q) ||
        h.forwardHost.toLowerCase().includes(q));
    }
    if (status !== "all") {
      list = list.filter((h) => {
        const on = optimistic[h.id] ?? h.enabled;
        if (status === "paused") return !on;
        if (status === "online") return on && h.health !== "down";
        return on && h.health === "down"; // "down"
      });
    }
    const sorted = [...list];
    if (sort === "name") {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sort === "status") {
      // Trouble first: down, then online, then paused; tie-break by name.
      const rank = (h: ProxyHost) => {
        const on = optimistic[h.id] ?? h.enabled;
        if (!on) return 2;
        return h.health === "down" ? 0 : 1;
      };
      sorted.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    } else {
      // Soonest cert expiry first; hosts without a cert sort last.
      sorted.sort((a, b) => {
        const da = certDays(a, certs);
        const db = certDays(b, certs);
        if (da == null && db == null) return a.name.localeCompare(b.name);
        if (da == null) return 1;
        if (db == null) return -1;
        return da - db;
      });
    }
    return sorted;
  }, [hosts, debounced, status, sort, certs, optimistic]);

  // Flip a service between served (enabled) and paused (disabled). Disabling
  // removes its nginx server block so the site stops responding publicly.
  const toggle = async (h: ProxyHost) => {
    const next = !isEnabled(h);
    setToggling(h.id);
    setError(null);
    setOptimistic((o) => ({ ...o, [h.id]: next }));
    try {
      await api.updateHost(h.id, { enabled: next });
      await reload();
      setOptimistic((o) => { const n = { ...o }; delete n[h.id]; return n; });
    } catch (e) {
      // Revert the optimistic flip and surface why.
      setOptimistic((o) => { const n = { ...o }; delete n[h.id]; return n; });
      setError(`Couldn't ${next ? "resume" : "pause"} ${h.name}: ${errMsg(e)}`);
    } finally {
      setToggling(null);
    }
  };

  const toggleSel = (id: string) => setSelected((s) => {
    const next = new Set(s);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  // Select-all operates on the filtered subset, not the full host list.
  const shownIds = shown.map((h) => h.id);
  const allSelected = shownIds.length > 0 && shownIds.every((id) => selected.has(id));
  const toggleAll = () => setSelected((s) => {
    if (allSelected) {
      const next = new Set(s);
      shownIds.forEach((id) => next.delete(id));
      return next;
    }
    return new Set([...s, ...shownIds]);
  });

  const performBulk = async (action: "enable" | "disable" | "maintenance-on" | "maintenance-off" | "delete") => {
    const ids = [...selected];
    if (!ids.length) return;
    setBusy(true);
    setError(null);
    try {
      await api.batchHosts(ids, action);
      setSelected(new Set());
      await reload();
    } catch (e) {
      setError(`Bulk ${action} failed: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const runBulk = (action: "enable" | "disable" | "maintenance-on" | "maintenance-off" | "delete") => {
    if (!selected.size) return;
    if (action === "delete") { setConfirmDelete(true); return; }
    void performBulk(action);
  };

  return (
    <>
      <div className="topbar">
        <h1>Exposed services</h1>
        <div style={{ flex: 1 }} />
        <button className="btn btn-primary" onClick={() => navigate({ name: "wizard" })}>
          <Icon.plus />
          Expose a service
        </button>
      </div>
      <div className="content">
        {error && (
          <div className="state-note error" role="alert" style={{ flexDirection: "row", justifyContent: "flex-start", textAlign: "left", padding: "12px 16px", marginBottom: 12, gap: 10 }}>
            <Icon.alert />
            <div style={{ flex: 1 }}>{error}</div>
            <button className="btn btn-ghost btn-sm" onClick={() => setError(null)}>Dismiss</button>
          </div>
        )}

        {hosts.length > 0 && (
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
            <div style={{ flex: "1 1 220px", minWidth: 180 }}>
              <Field label={<span className="sr-only">Search services</span>}>
                <input
                  className="input"
                  type="search"
                  placeholder="Search name, domain or address…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </Field>
            </div>
            <div className="sectabs" role="group" aria-label="Filter by status" style={{ marginBottom: 0 }}>
              {([["all", "All", null], ["online", "Online", Icon.check], ["down", "Down", Icon.alert], ["paused", "Paused", null]] as const).map(([val, lbl, Ico]) => (
                <button
                  key={val}
                  type="button"
                  className={`sectab${status === val ? " active" : ""}`}
                  aria-pressed={status === val}
                  onClick={() => setStatus(val)}
                >
                  {Ico && <Ico />}
                  {lbl}
                </button>
              ))}
            </div>
            <Field label={<span className="sr-only">Sort services</span>}>
              <select className="input" style={{ width: "auto" }} value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                <option value="name">Sort: Name</option>
                <option value="status">Sort: Status</option>
                <option value="cert">Sort: Cert expiry</option>
              </select>
            </Field>
          </div>
        )}

        {selected.size > 0 && (
          <div className="card card-pad bulk-bar" style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <b style={{ fontSize: 13 }}>{selected.size} selected</b>
            <div style={{ flex: 1 }} />
            <button className="btn btn-sm" disabled={busy} onClick={() => runBulk("enable")}>Resume</button>
            <button className="btn btn-sm" disabled={busy} onClick={() => runBulk("disable")}>Pause</button>
            <button className="btn btn-sm" disabled={busy} onClick={() => runBulk("maintenance-on")}>Maintenance on</button>
            <button className="btn btn-sm" disabled={busy} onClick={() => runBulk("maintenance-off")}>Maintenance off</button>
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => runBulk("delete")}>Delete</button>
            {profiles.length > 0 && (
              <select className="input" style={{ maxWidth: 200, height: 30, padding: "0 8px", fontSize: 12 }} disabled={busy} value=""
                onChange={async (e) => {
                  const pid = e.target.value; if (!pid) return;
                  const ids = [...selected]; setBusy(true); setError(null);
                  try { await api.applySecurityProfile(pid, ids); setSelected(new Set()); await reload(); }
                  catch (err) { setError(`Couldn't apply profile: ${errMsg(err)}`); }
                  finally { setBusy(false); }
                }}>
                <option value="">Apply profile…</option>
                {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setSelected(new Set())}>Clear</button>
          </div>
        )}
        <div className="card animate-rise">
          <div className="col-head" style={{ gridTemplateColumns: "34px 1fr 1fr 1fr 1fr auto" }}>
            <div style={{ display: "flex", alignItems: "center" }}>
              <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all services" />
            </div>
            <div>Service</div>
            <div>Status</div>
            <div>Certificate</div>
            <div>Address</div>
            <div>Enabled</div>
          </div>
          {shown.map((h) => {
            const cb = certBadge(h, certs);
            const enabled = isEnabled(h);
            return (
              <div
                key={h.id}
                className={`host-row${enabled ? "" : " is-paused"}${selected.has(h.id) ? " is-selected" : ""}`}
                style={{ gridTemplateColumns: "34px 1fr 1fr 1fr 1fr auto" }}
                role="button"
                tabIndex={0}
                aria-label={`Open ${h.name}`}
                onClick={() => navigate({ name: "host", hostId: h.id })}
                onKeyDown={(e) => {
                  // Only navigate when the row itself is focused - not when the keypress
                  // came from the inner checkbox / switch (let those handle their own keys).
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigate({ name: "host", hostId: h.id }); }
                }}
              >
                <div
                  style={{ display: "flex", alignItems: "center" }}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <input type="checkbox" checked={selected.has(h.id)} onChange={() => toggleSel(h.id)} aria-label={`Select ${h.name}`} />
                </div>
                <div className="host-main">
                  <div className="host-icon"><ServiceIcon iconUrl={h.iconUrl} size={26} /></div>
                  <div>
                    <div className="host-name">{h.name}</div>
                    <div className="host-url">{h.domain}</div>
                  </div>
                </div>
                <div className="host-status-text">
                  <span className={`dot ${enabled ? healthClass[h.health] : "n"}`} />
                  <span style={{ color: !enabled ? "var(--text-faint)" : h.health === "down" ? "var(--red)" : undefined }}>
                    {enabled ? statusText(h) : "Paused · not served"}
                  </span>
                </div>
                <div className="host-meta">
                  <span className="strong">{cb.label}</span>
                  {cb.detail}
                </div>
                <div className="host-meta mono">
                  {h.forwardHost}:{h.forwardPort}
                </div>
                <div
                  style={{ display: "flex", alignItems: "center", justifyContent: "flex-end" }}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <Switch
                    checked={enabled}
                    onChange={() => void toggle(h)}
                    label={enabled ? `Pause ${h.name}` : `Resume ${h.name}`}
                    disabled={toggling === h.id}
                  />
                </div>
              </div>
            );
          })}
          {shown.length === 0 && (
            <div className="state-note">
              <Icon.search />
              {hosts.length === 0 ? (
                <>
                  <h2 style={{ margin: 0, fontSize: "var(--fs-lg)" }}>No services yet</h2>
                  <p style={{ margin: 0 }}>Expose your first internal service - it takes about a minute.</p>
                </>
              ) : (
                <>
                  <div className="strong">No matching services</div>
                  <div className="caption">Try a different search term or status filter.</div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          danger
          busy={busy}
          title={`Delete ${selected.size} ${plural("service", selected.size)}?`}
          message={<>This permanently removes {selected.size === 1 ? "the selected service" : `all ${selected.size} selected services`} and their nginx config. This cannot be undone.</>}
          confirmLabel="Delete"
          onConfirm={() => { void performBulk("delete").then(() => setConfirmDelete(false)); }}
          onCancel={() => { if (!busy) setConfirmDelete(false); }}
        />
      )}
    </>
  );
}
