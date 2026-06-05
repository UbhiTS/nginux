import { useEffect, useState } from "react";
import { api, type AuditEvent, type Ban, type Exposure, type SecurityOverview } from "../api.ts";
import { Icon } from "../icons.tsx";
import { ServiceIcon } from "../components/ServiceIcon.tsx";

type Tab = "overview" | "exposure" | "logins" | "failures" | "denylist";

const sevPill: Record<AuditEvent["severity"], string> = {
  info: "g",
  notice: "y",
  warn: "y",
  danger: "r",
};

const TABS: Tab[] = ["overview", "denylist", "exposure", "logins", "failures"];

export function SecurityCenter({ tab: tabProp, setTab }: { tab?: string; setTab: (t: string) => void }) {
  // Active tab lives in the URL (#/security/<tab>) so refresh / deep links keep it.
  const tab: Tab = TABS.includes(tabProp as Tab) ? (tabProp as Tab) : "overview";
  const [overview, setOverview] = useState<SecurityOverview | null>(null);
  const [exposure, setExposure] = useState<Exposure[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [bans, setBans] = useState<Ban[]>([]);
  const [banIp, setBanIp] = useState("");

  const loadBans = () => api.bans().then(setBans).catch(() => {});
  useEffect(() => {
    api.securityOverview().then(setOverview).catch(() => {});
    api.exposure().then(setExposure).catch(() => {});
    api.audit(undefined, 50).then(setEvents).catch(() => {});
    loadBans();
  }, []);

  const logins = events.filter((e) => e.type === "login.success");
  const failures = events.filter((e) => e.type === "login.failed");
  const unprotected = exposure.filter((e) => !e.wellProtected).length;

  const C = 251.2;
  const score = overview?.score ?? 0;
  const ringColor = score >= 90 ? "var(--green)" : score >= 70 ? "var(--green)" : "var(--yellow)";

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
        </div>

        {tab === "overview" && overview && (
          <>
            <div className="grid" style={{ gridTemplateColumns: "320px 1fr", marginBottom: 18 }}>
              <div className="card score-card">
                <div className="ring">
                  <svg width="96" height="96">
                    <circle cx="48" cy="48" r="40" fill="none" stroke="var(--border)" strokeWidth="9" />
                    <circle cx="48" cy="48" r="40" fill="none" stroke={ringColor} strokeWidth="9" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - score / 100)} />
                  </svg>
                  <div className="num">{score}</div>
                </div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>Security score: {overview.rating}</div>
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
                    {unprotected > 0
                      ? `${unprotected} service${unprotected > 1 ? "s" : ""} reachable without a login. Adding one raises your score.`
                      : "Everything exposed is behind a login."}
                  </div>
                </div>
              </div>
              <div className="stats" style={{ gridTemplateColumns: "repeat(3,1fr)", marginBottom: 0 }}>
                <Stat label="Failed logins (24h)" value={overview.failedLogins24h} color={overview.failedLogins24h ? "var(--yellow)" : undefined} />
                <Stat label="Exposed services" value={overview.exposed} />
                <Stat label="Active sessions" value={overview.activeSessions} />
              </div>
            </div>

            <div className="card">
              <div className="card-head">Recent security events</div>
              <div className="atable">
                <div className="ahead" style={{ gridTemplateColumns: "150px 1fr 90px" }}>
                  <div>Time</div>
                  <div>Event</div>
                  <div style={{ textAlign: "center" }}>Type</div>
                </div>
                {events.slice(0, 8).map((e) => (
                  <div key={e.id} className="arow" style={{ gridTemplateColumns: "150px 1fr 90px" }}>
                    <div className="muted mono">{fmt(e.ts)}</div>
                    <div>
                      <b>{e.actor}</b> · {e.summary}
                    </div>
                    <span className={`pill ${sevPill[e.severity]}`} style={{ justifySelf: "center" }}>{e.type.split(".")[0]}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {tab === "exposure" && (
          <div className="card">
            <div className="ahead" style={{ gridTemplateColumns: "1.4fr 1fr 130px", gap: 16 }}>
              <div>Service</div>
              <div>Protection</div>
              <div style={{ textAlign: "center" }}>Status</div>
            </div>
            {exposure.map((e) => (
              <div key={e.id} className="audit-row">
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
          </div>
        )}

        {tab === "logins" && <EventTable rows={logins} kind="login" />}
        {tab === "failures" && <EventTable rows={failures} kind="failure" />}
        {tab === "denylist" && (
          <div className="card" style={{ marginBottom: 18 }}>
            <div className="card-head">
              Global deny list <span className="pill r">{bans.length}</span>
              <div className="search" style={{ maxWidth: 280, marginLeft: "auto" }}>
                <input placeholder="Block an IP / CIDR…" value={banIp} onChange={(e) => setBanIp(e.target.value)} />
                <button className="btn btn-sm btn-danger" onClick={async () => { if (banIp.trim()) { await api.addBan(banIp.trim(), "Blocked from Security Center"); setBanIp(""); loadBans(); } }}>Block</button>
              </div>
            </div>
            <div className="info-line" style={{ margin: "0 16px 4px" }}>
              <Icon.shield />
              <span>IPs blocked across <strong>every</strong> service (the shared nginx deny-list). Includes manual blocks, ones you blocked from the traffic map, and auto-bans from repeated auth failures. Unblock anything added by mistake.</span>
            </div>
            <div className="atable">
              {bans.map((b) => (
                <div key={b.ip} className="arow" style={{ gridTemplateColumns: "1fr 1.4fr 0.8fr 90px" }}>
                  <div className="mono">{b.ip}</div>
                  <div className="muted">{b.reason}</div>
                  <div style={{ textAlign: "center" }}><span className={`pill ${b.source === "auto" ? "r" : "n"}`}>{b.source === "auto" ? "auto-ban" : "manual"}</span></div>
                  <button className="btn btn-ghost btn-sm" style={{ justifySelf: "end" }} onClick={async () => { await api.removeBan(b.ip); loadBans(); }}>Unblock</button>
                </div>
              ))}
              {bans.length === 0 && <div className="placeholder"><p>Deny list is empty. Block an IP above, from the traffic map, or let auto-ban handle brute-force (5 fails in 5 min).</p></div>}
            </div>
          </div>
        )}
      </div>
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
        <div className="placeholder">
          <p>No {kind === "failure" ? "failed logins" : "sign-ins"} recorded yet.</p>
        </div>
      )}
    </div>
  );
}

function fmt(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
