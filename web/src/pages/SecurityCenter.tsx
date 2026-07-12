import { useEffect, useState, type ReactNode } from "react";
import { api, type AuditEvent, type Ban, type Exposure } from "../api.ts";
import type { SecurityProfile } from "../types.ts";
import { useAsyncData, type AsyncData } from "../hooks.ts";
import { days, plural } from "../format.ts";
import { Icon } from "../icons.tsx";
import { ServiceIcon } from "../components/ServiceIcon.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";

type Tab = "overview" | "exposure" | "logins" | "failures" | "denylist" | "profiles";

const sevPill: Record<AuditEvent["severity"], string> = {
  info: "g",
  notice: "y",
  warn: "y",
  danger: "r",
};

const TABS: Tab[] = ["overview", "denylist", "exposure", "logins", "failures", "profiles"];

// Deny-list entries come from three sources; the old code only knew "auto" vs
// "manual" and mislabelled every geoip entry as "manual".
const BAN_SOURCE: Record<Ban["source"], { label: string; cls: string }> = {
  manual: { label: "manual", cls: "n" },
  auto: { label: "auto-ban", cls: "r" },
  geoip: { label: "geo-block", cls: "y" },
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Request failed");

/** Classify a deny-list target: is it a syntactically valid IP or CIDR, is it a
 *  range, and does it overlap a private/LAN subnet (so we can warn before a
 *  fat-fingered mask bans the whole house). */
export function classifyBanTarget(raw: string): { valid: boolean; isCidr: boolean; isPrivate: boolean } {
  const s = raw.trim();
  if (!s) return { valid: false, isCidr: false, isPrivate: false };
  const parts = s.split("/");
  if (parts.length > 2) return { valid: false, isCidr: true, isPrivate: false };
  const addr = parts[0];
  const prefixStr = parts[1];
  const isCidr = prefixStr !== undefined;

  const v4 = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return { valid: false, isCidr, isPrivate: false };
    if (isCidr) {
      if (!/^\d+$/.test(prefixStr) || Number(prefixStr) > 32) return { valid: false, isCidr: true, isPrivate: false };
    }
    const [a, b] = octets;
    const isPrivate =
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 127 ||
      (a === 169 && b === 254);
    return { valid: true, isCidr, isPrivate };
  }

  // Loose IPv6: hex groups + at least one colon (full RFC parsing is overkill here).
  if (addr.includes(":") && /^[0-9a-fA-F:]+$/.test(addr)) {
    if (isCidr) {
      if (!/^\d+$/.test(prefixStr) || Number(prefixStr) > 128) return { valid: false, isCidr: true, isPrivate: false };
    }
    const low = addr.toLowerCase();
    const isPrivate = low === "::1" || low.startsWith("fe80") || low.startsWith("fc") || low.startsWith("fd");
    return { valid: true, isCidr, isPrivate };
  }
  return { valid: false, isCidr, isPrivate: false };
}

/** "permanent" for open-ended bans, else a short countdown to expiry. */
function expiryText(b: Ban): string {
  if (!b.expiresAt) return "permanent";
  const ms = new Date(b.expiresAt).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs} hr`;
  return days(Math.round(hrs / 24));
}

/** Send the app to a host's detail page. SecurityCenter only gets tab/setTab as
 *  props (App owns navigation), so we drive the URL hash and let App's hashchange
 *  listener sync the route. */
function goToHost(id: string) {
  window.location.hash = `#/host/${id}`;
}

interface ConfirmState {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger: boolean;
  onConfirm: () => Promise<void>;
}

/** Render a list's loading / error state, or hand its data to `children`. */
function Loadable<T>({ q, children, skeletonRows = 4 }: { q: AsyncData<T>; children: (data: T) => ReactNode; skeletonRows?: number }) {
  if (q.status === "loading") {
    return (
      <div className="atable">
        {Array.from({ length: skeletonRows }, (_, i) => (
          <div key={i} className="skeleton skeleton-row" style={{ margin: "8px 16px" }} />
        ))}
      </div>
    );
  }
  if (q.status === "error") {
    return (
      <div className="state-note error">
        <Icon.alert />
        <div>Couldn’t load this list.</div>
        {q.error && <div className="caption">{q.error}</div>}
        <button className="btn btn-ghost btn-sm" onClick={q.reload}>Retry</button>
      </div>
    );
  }
  return <>{children(q.data as T)}</>;
}

export function SecurityCenter({ tab: tabProp, setTab }: { tab?: string; setTab: (t: string) => void }) {
  // Active tab lives in the URL (#/security/<tab>) so refresh / deep links keep it.
  const tab: Tab = TABS.includes(tabProp as Tab) ? (tabProp as Tab) : "overview";

  const overviewQ = useAsyncData(() => api.securityOverview(), []);
  const exposureQ = useAsyncData(() => api.exposure(), []);
  const eventsQ = useAsyncData(() => api.audit(undefined, 50), []);
  const blockedQ = useAsyncData(() => api.blockedAttempts(), []);
  const bansQ = useAsyncData(() => api.bans(), []);

  const [banIp, setBanIp] = useState("");
  const [toast, setToast] = useState<{ kind: "info" | "critical"; msg: string } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const showToast = (kind: "info" | "critical", msg: string) => setToast({ kind, msg });

  const events = eventsQ.data ?? [];
  const exposure = exposureQ.data ?? [];
  const bans = bansQ.data ?? [];
  const logins = events.filter((e) => e.type === "login.success");
  const failures = events.filter((e) => e.type === "login.failed");
  const unprotected = exposure.filter((e) => !e.wellProtected).length;

  const C = 251.2;
  const score = overviewQ.data?.score ?? 0;
  // Three real tiers - the old code returned green for both branches so the ring
  // could never signal a problem.
  const ringColor = score >= 80 ? "var(--green)" : score >= 50 ? "var(--yellow)" : "var(--red)";
  const rating = score >= 80 ? "Strong" : score >= 50 ? "Fair" : "At risk";

  const banTarget = classifyBanTarget(banIp);

  async function doBlock(ip: string) {
    await api.addBan(ip, "Blocked from Security Center");
    setBanIp("");
    bansQ.reload();
    showToast("info", `Blocked ${ip}.`);
  }

  async function blockSafe(ip: string) {
    try {
      await doBlock(ip);
    } catch (e) {
      showToast("critical", `Couldn’t block ${ip}: ${errMsg(e)}`);
    }
  }

  function submitBlock(e: React.FormEvent) {
    e.preventDefault();
    const ip = banIp.trim();
    const t = classifyBanTarget(ip);
    if (!t.valid) {
      showToast("critical", "Enter a valid IP address or CIDR range.");
      return;
    }
    if (t.isCidr) {
      // A range ban is high-blast-radius - confirm, and shout if it overlaps a LAN.
      setConfirm({
        title: "Block an entire range?",
        message: (
          <>
            Blocking <b>{ip}</b> denies every address in that range across all services.
            {t.isPrivate && " This range overlaps a private / LAN subnet — you may lock out internal clients."}
          </>
        ),
        confirmLabel: "Block range",
        danger: true,
        onConfirm: () => doBlock(ip),
      });
    } else {
      void blockSafe(ip);
    }
  }

  function askUnblock(b: Ban) {
    setConfirm({
      title: "Remove from deny list?",
      message: (
        <>
          <b>{b.ip}</b> will be able to reach your services again.
        </>
      ),
      confirmLabel: "Unblock",
      danger: false,
      onConfirm: async () => {
        await api.removeBan(b.ip);
        bansQ.reload();
        showToast("info", `Unblocked ${b.ip}.`);
      },
    });
  }

  async function runConfirm() {
    if (!confirm) return;
    setConfirmBusy(true);
    try {
      await confirm.onConfirm();
      setConfirm(null);
    } catch (e) {
      showToast("critical", errMsg(e));
    } finally {
      setConfirmBusy(false);
    }
  }

  return (
    <>
      <div className="topbar">
        <h1>Security Center</h1>
      </div>
      <div className="content">
        <div className="sectabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "overview"} className={`sectab${tab === "overview" ? " active" : ""}`} onClick={() => setTab("overview")}>Overview</button>
          <button type="button" role="tab" aria-selected={tab === "denylist"} className={`sectab${tab === "denylist" ? " active" : ""}`} onClick={() => setTab("denylist")}>
            Deny list {bans.length > 0 && <span className="badge">{bans.length}</span>}
          </button>
          <button type="button" role="tab" aria-selected={tab === "exposure"} className={`sectab${tab === "exposure" ? " active" : ""}`} onClick={() => setTab("exposure")}>
            What's exposed {unprotected > 0 && <span className="badge">{unprotected}</span>}
          </button>
          <button type="button" role="tab" aria-selected={tab === "logins"} className={`sectab${tab === "logins" ? " active" : ""}`} onClick={() => setTab("logins")}>Login activity</button>
          <button type="button" role="tab" aria-selected={tab === "failures"} className={`sectab${tab === "failures" ? " active" : ""}`} onClick={() => setTab("failures")}>
            Login failures {failures.length > 0 && <span className="badge">{failures.length}</span>}
          </button>
          <button type="button" role="tab" aria-selected={tab === "profiles"} className={`sectab${tab === "profiles" ? " active" : ""}`} onClick={() => setTab("profiles")}>Profiles</button>
        </div>

        {tab === "profiles" && <ProfilesPanel />}

        {tab === "overview" && (
          <Loadable q={overviewQ} skeletonRows={3}>
            {(overview) => (
              <>
                <div className="grid-2" style={{ marginBottom: 18 }}>
                  <div className="card score-card">
                    <div className="ring">
                      <svg width="96" height="96">
                        <circle cx="48" cy="48" r="40" fill="none" stroke="var(--border)" strokeWidth="9" />
                        <circle cx="48" cy="48" r="40" fill="none" stroke={ringColor} strokeWidth="9" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - score / 100)} />
                      </svg>
                      <div className="num">{score}</div>
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 15 }}>Security score: {rating}</div>
                      <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
                        {unprotected > 0 ? (
                          <>
                            <button
                              type="button"
                              onClick={() => setTab("exposure")}
                              style={{ background: "none", border: "none", padding: 0, font: "inherit", color: "var(--accent)", cursor: "pointer", textDecoration: "underline" }}
                            >
                              {unprotected} {plural("service", unprotected)} reachable without a login
                            </button>
                            . Adding one raises your score.
                          </>
                        ) : (
                          "Everything exposed is behind a login."
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="stats grid-3" style={{ marginBottom: 0 }}>
                    <Stat label="Failed logins (24h)" value={overview.failedLogins24h} color={overview.failedLogins24h ? "var(--yellow)" : undefined} />
                    <Stat label="Exposed services" value={overview.exposed} />
                    <Stat label="Active sessions" value={overview.activeSessions} />
                  </div>
                </div>

                <div className="card">
                  <div className="card-head">Recent security events</div>
                  <Loadable q={eventsQ} skeletonRows={5}>
                    {(evs) => (
                      <div className="atable">
                        {evs.slice(0, 8).map((e) => (
                          <div key={e.id} className="arow" style={{ gridTemplateColumns: "150px 1fr 90px" }}>
                            <div className="muted mono">{fmt(e.ts)}</div>
                            <div>
                              <b>{e.actor}</b> · {e.summary}
                            </div>
                            <span className={`pill ${sevPill[e.severity]}`} style={{ justifySelf: "center" }}>{e.type.split(".")[0]}</span>
                          </div>
                        ))}
                        {evs.length === 0 && (
                          <div className="state-note">
                            <Icon.info />
                            <div>No security events recorded yet.</div>
                          </div>
                        )}
                      </div>
                    )}
                  </Loadable>
                </div>

                {blockedQ.status === "ready" && blockedQ.data && blockedQ.data.total > 0 && (
                  <div className="grid-2" style={{ marginTop: 18 }}>
                    <div className="card">
                      <div className="card-head">Blocked attempts by country <span className="muted" style={{ fontWeight: 400 }}>· {blockedQ.data.total} denied recently</span></div>
                      <div className="atable">
                        {blockedQ.data.byCountry.map((c) => (
                          <div key={c.country} className="arow" style={{ gridTemplateColumns: "1fr auto" }}>
                            <div>
                              {c.country || "—"}
                              {blockedQ.data!.allowedCountries.length > 0 && !blockedQ.data!.allowedCountries.includes(c.country) && (
                                <span className="pill r" style={{ marginLeft: 8 }}>geo-blocked</span>
                              )}
                            </div>
                            <div className="mono">{c.count}</div>
                          </div>
                        ))}
                        {blockedQ.data.byCountry.length === 0 && <div className="state-note"><Icon.info /><div>No country data for blocked requests.</div></div>}
                      </div>
                    </div>
                    <div className="card">
                      <div className="card-head">Top blocked IPs</div>
                      <div className="atable">
                        {blockedQ.data.topIps.map((t) => (
                          <div key={t.ip} className="arow" style={{ gridTemplateColumns: "1fr auto auto", gap: 12 }}>
                            <div className="mono">{t.ip}</div>
                            <div className="muted">{t.country || "—"}</div>
                            <button className="btn btn-ghost btn-sm" title="Ban this IP" onClick={() => blockSafe(t.ip)}>Ban</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </Loadable>
        )}

        {tab === "exposure" && (
          <div className="card">
            <div className="ahead" style={{ gridTemplateColumns: "1.4fr 1fr 130px", gap: 16 }}>
              <div>Service</div>
              <div>Protection</div>
              <div style={{ textAlign: "center" }}>Status</div>
            </div>
            <Loadable q={exposureQ} skeletonRows={4}>
              {(rows) => (
                <>
                  {rows.map((e) => (
                    <div
                      key={e.id}
                      className="audit-row"
                      role="button"
                      tabIndex={0}
                      aria-label={`Open ${e.name}`}
                      style={{ cursor: "pointer" }}
                      onClick={() => goToHost(e.id)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          goToHost(e.id);
                        }
                      }}
                    >
                      <div className="host-main">
                        <div className="host-icon"><ServiceIcon iconUrl={e.iconUrl} size={22} /></div>
                        <div>
                          <div className="host-name">{e.name}</div>
                          <div className="host-url">{e.domain}</div>
                        </div>
                      </div>
                      <div>
                        <div className={`check-line ${e.https ? "ok" : "bad"}`}>{e.https ? <Icon.check /> : <Icon.x />}HTTPS</div>
                        <div className={`check-line ${e.login ? "ok" : "bad"}`}>
                          {e.login ? <Icon.check /> : <Icon.x />}
                          {e.login ? (e.twofa ? "Login + 2FA" : "Login required") : "No login required"}
                        </div>
                      </div>
                      <span style={{ justifySelf: "center" }}>
                        {e.wellProtected ? <span className="pill g">Well protected</span> : <span className="pill r">Needs login</span>}
                      </span>
                    </div>
                  ))}
                  {rows.length === 0 && (
                    <div className="state-note">
                      <Icon.shield />
                      <div>No services are exposed yet. Publish a service and it shows up here with its protection status.</div>
                    </div>
                  )}
                </>
              )}
            </Loadable>
          </div>
        )}

        {tab === "logins" && (
          <Loadable q={eventsQ} skeletonRows={5}>
            {(evs) => <EventTable rows={evs.filter((e) => e.type === "login.success")} kind="login" />}
          </Loadable>
        )}
        {tab === "failures" && (
          <Loadable q={eventsQ} skeletonRows={5}>
            {(evs) => <EventTable rows={evs.filter((e) => e.type === "login.failed")} kind="failure" />}
          </Loadable>
        )}

        {tab === "denylist" && (
          <div className="card" style={{ marginBottom: 18 }}>
            <div className="card-head">
              Global deny list <span className="pill r">{bans.length}</span>
              <form className="search" style={{ maxWidth: 280, marginLeft: "auto" }} onSubmit={submitBlock}>
                <input aria-label="IP address or CIDR range to block" placeholder="Block an IP / CIDR…" value={banIp} onChange={(e) => setBanIp(e.target.value)} />
                <button type="submit" className="btn btn-sm btn-danger" disabled={!banTarget.valid}>Block</button>
              </form>
            </div>
            <div className="info-line" style={{ margin: "0 16px 4px" }}>
              <Icon.shield />
              <span>IPs blocked across <strong>every</strong> service (the shared nginx deny list). Includes manual blocks, ones you blocked from the traffic map, and auto-bans from repeated auth failures. Unblock anything added by mistake.</span>
            </div>
            <Loadable q={bansQ} skeletonRows={4}>
              {(rows) => (
                <div className="atable">
                  {rows.length > 0 && (
                    <div className="ahead" style={{ gridTemplateColumns: "1fr 1.4fr 0.9fr 0.9fr 90px" }}>
                      <div>IP / range</div>
                      <div>Reason</div>
                      <div style={{ textAlign: "center" }}>Source</div>
                      <div>Added · expires</div>
                      <div />
                    </div>
                  )}
                  {rows.map((b) => {
                    const src = BAN_SOURCE[b.source] ?? BAN_SOURCE.manual;
                    return (
                      <div key={b.ip} className="arow" style={{ gridTemplateColumns: "1fr 1.4fr 0.9fr 0.9fr 90px" }}>
                        <div className="mono">{b.ip}</div>
                        <div className="muted">{b.reason}</div>
                        <div style={{ textAlign: "center" }}><span className={`pill ${src.cls}`}>{src.label}</span></div>
                        <div className="caption">{fmt(b.createdAt)} · {expiryText(b)}</div>
                        <button className="btn btn-ghost btn-sm" style={{ justifySelf: "end" }} onClick={() => askUnblock(b)}>Unblock</button>
                      </div>
                    );
                  })}
                  {rows.length === 0 && (
                    <div className="state-note">
                      <Icon.shield />
                      <div>Deny list is empty. Block an IP above, from the traffic map, or let auto-ban handle brute-force (5 fails in 5 min).</div>
                    </div>
                  )}
                </div>
              )}
            </Loadable>
          </div>
        )}
      </div>

      {toast && (
        <div className="toast-stack" role="region" aria-label="Security notifications">
          <div className={`toast ${toast.kind}`} role={toast.kind === "critical" ? "alert" : "status"}>
            <span className="toast-icon">{toast.kind === "critical" ? <Icon.alert /> : <Icon.check />}</span>
            <div className="toast-body"><div className="toast-msg">{toast.msg}</div></div>
          </div>
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          busy={confirmBusy}
          onConfirm={runConfirm}
          onCancel={() => !confirmBusy && setConfirm(null)}
        />
      )}
    </>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value" style={{ color }}>{value}</div>
    </div>
  );
}

function EventTable({ rows, kind }: { rows: AuditEvent[]; kind: "login" | "failure" }) {
  return (
    <div className="card">
      <div className="ahead" style={{ gridTemplateColumns: "150px 1fr 1.2fr 1fr" }}>
        <div>Time</div>
        <div>User</div>
        <div>Detail</div>
        <div>Source IP</div>
      </div>
      {rows.map((e) => (
        <div key={e.id} className="arow" style={{ gridTemplateColumns: "150px 1fr 1.2fr 1fr" }}>
          <div className="muted mono">{fmt(e.ts)}</div>
          <div>{e.actor}</div>
          <div className="muted">{e.summary}{(e.meta as { location?: string }).location ? ` · ${(e.meta as { location?: string }).location}` : ""}</div>
          <div className="mono">{e.ip || "-"}</div>
        </div>
      ))}
      {rows.length === 0 && (
        <div className="state-note">
          <Icon.info />
          <div>No {kind === "failure" ? "failed logins" : "sign-ins"} recorded yet.</div>
        </div>
      )}
    </div>
  );
}

function fmt(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const PROFILE_TOGGLES: { key: string; label: string }[] = [
  { key: "requireLogin", label: "Require login" },
  { key: "require2fa", label: "Require 2FA" },
  { key: "securityHeaders", label: "Security headers" },
  { key: "hsts", label: "HSTS" },
  { key: "blockExploits", label: "Block exploits" },
  { key: "rateLimit", label: "Rate limit" },
];

/** Manage reusable security profiles. Apply them to services from the Services
 *  page (select rows -> "Apply profile"). */
function ProfilesPanel() {
  const profilesQ = useAsyncData(() => api.securityProfiles(), []);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [fields, setFields] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState("");
  const [pending, setPending] = useState<SecurityProfile | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(""), 4000);
    return () => clearTimeout(t);
  }, [msg]);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await api.createSecurityProfile(trimmed, desc.trim(), fields);
    setName(""); setDesc(""); setFields({});
    setMsg(`Profile “${trimmed}” created.`);
    profilesQ.reload();
  };

  const doDelete = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await api.deleteSecurityProfile(pending.id);
      setPending(null);
      profilesQ.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="card card-pad" style={{ marginBottom: 12 }}>
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
          A security profile is a reusable bundle of security settings. Create one here, then apply it to services from the Services page (select rows → “Apply profile”).
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
          <input className="input" style={{ maxWidth: 180 }} aria-label="Profile name" placeholder="Profile name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input" style={{ maxWidth: 280 }} aria-label="Profile description" placeholder="Description (optional)" value={desc} onChange={(e) => setDesc(e.target.value)} />
        </div>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 12 }}>
          {PROFILE_TOGGLES.map((t) => (
            <label key={t.key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
              <input type="checkbox" checked={!!fields[t.key]} onChange={(e) => setFields((f) => ({ ...f, [t.key]: e.target.checked }))} />
              {t.label}
            </label>
          ))}
        </div>
        <button className="btn btn-primary btn-sm" onClick={create}>Create profile</button>
        {msg && <div className="info-line" style={{ marginTop: 10 }}><Icon.check />{msg}</div>}
      </div>
      <div className="card atable">
        <Loadable q={profilesQ} skeletonRows={3}>
          {(profiles) => (
            <>
              {profiles.map((p) => (
                <div key={p.id} className="arow" style={{ gridTemplateColumns: "1fr 1.4fr auto auto", gap: 12 }}>
                  <div><b>{p.name}</b> {p.builtin && <span className="pill n" style={{ marginLeft: 6 }}>built-in</span>}</div>
                  <div className="muted" style={{ fontSize: 12.5 }}>{p.description || Object.keys(p.fields).filter((k) => p.fields[k]).join(", ") || "—"}</div>
                  <div className="muted mono" style={{ fontSize: 11 }}>{Object.keys(p.fields).length} field{Object.keys(p.fields).length === 1 ? "" : "s"}</div>
                  <button className="btn btn-ghost btn-sm" disabled={p.builtin} title={p.builtin ? "Built-in profiles can't be deleted" : ""}
                    onClick={() => setPending(p)}>Delete</button>
                </div>
              ))}
              {profiles.length === 0 && (
                <div className="state-note">
                  <Icon.shield />
                  <div>No security profiles yet.</div>
                </div>
              )}
            </>
          )}
        </Loadable>
      </div>

      {pending && (
        <ConfirmDialog
          title="Delete profile?"
          message={<>Delete <b>{pending.name}</b>? Services already using it keep their current settings.</>}
          confirmLabel="Delete"
          danger
          busy={busy}
          onConfirm={doDelete}
          onCancel={() => !busy && setPending(null)}
        />
      )}
    </>
  );
}
