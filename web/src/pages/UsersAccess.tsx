import { useEffect, useState } from "react";
import { api, type AuthUser, type Session } from "../api.ts";
import { Icon } from "../icons.tsx";

type Tab = "users" | "sessions";
const avatarColor = ["var(--purple)", "var(--accent)", "var(--green)", "var(--text-faint)"];

export function UsersAccess({
  currentUser,
  refreshMe,
}: {
  currentUser: AuthUser;
  refreshMe: () => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>("users");
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [enroll, setEnroll] = useState<{ secret: string; otpauth: string } | null>(null);
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState<string[] | null>(null);
  const [err, setErr] = useState("");

  // change-password (self-service)
  const [pwOpen, setPwOpen] = useState(false);
  const [pwCur, setPwCur] = useState("");
  const [pwNext, setPwNext] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwErr, setPwErr] = useState("");
  const [pwOk, setPwOk] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);

  const resetPw = () => { setPwCur(""); setPwNext(""); setPwConfirm(""); setPwErr(""); };
  const submitPw = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwErr(""); setPwOk(false);
    if (pwNext.length < 8) return setPwErr("Use at least 8 characters.");
    if (pwNext !== pwConfirm) return setPwErr("The two new passwords don't match.");
    setPwBusy(true);
    try {
      await api.changePassword(pwCur, pwNext);
      setPwOk(true); setPwOpen(false); resetPw();
      await refreshMe();
    } catch (e2) {
      setPwErr(e2 instanceof Error ? e2.message : "Couldn't change the password.");
    } finally {
      setPwBusy(false);
    }
  };

  const load = () => {
    api.users().then(setUsers).catch(() => {});
    api.sessions().then(setSessions).catch(() => {});
  };
  useEffect(load, []);

  const startEnroll = async () => {
    setBackup(null);
    setErr("");
    setEnroll(await api.twofaSetup());
  };
  const verifyEnroll = async () => {
    setErr("");
    try {
      const r = await api.twofaVerify(code);
      setBackup(r.backupCodes);
      setEnroll(null);
      setCode("");
      await refreshMe();
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Verification failed.");
    }
  };

  return (
    <>
      <div className="topbar">
        <h1>Users &amp; Access</h1>
      </div>
      <div className="content">
        <div className="sectabs">
          <div className={`sectab${tab === "users" ? " active" : ""}`} onClick={() => setTab("users")}>Users &amp; roles</div>
          <div className={`sectab${tab === "sessions" ? " active" : ""}`} onClick={() => setTab("sessions")}>Active sessions</div>
        </div>

        {tab === "users" && (
          <>
            <div className="card card-pad" style={{ marginBottom: 18 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <Icon.lock className="acct-ic" />
                <div style={{ flex: 1 }}>
                  <div className="nt">Password</div>
                  <div className="nd">Change the password for your account ({currentUser.username}).</div>
                </div>
                {!pwOpen && (
                  <button className="btn btn-sm" style={{ alignSelf: "center" }} onClick={() => { setPwOpen(true); setPwOk(false); }}>
                    Change password
                  </button>
                )}
              </div>
              {pwOk && !pwOpen && (
                <div className="test-result ok" style={{ marginTop: 12 }}><Icon.check /><div>Password changed.</div></div>
              )}
              {pwOpen && (
                <form onSubmit={submitPw} style={{ marginTop: 14, maxWidth: 360 }}>
                  <div className="field"><label>Current password</label>
                    <input className="input" type="password" value={pwCur} onChange={(e) => setPwCur(e.target.value)} autoFocus /></div>
                  <div className="field"><label>New password</label>
                    <input className="input" type="password" value={pwNext} onChange={(e) => setPwNext(e.target.value)} /></div>
                  <div className="field"><label>Confirm new password</label>
                    <input className="input" type="password" value={pwConfirm} onChange={(e) => setPwConfirm(e.target.value)} /></div>
                  {pwErr && <div className="test-result bad" style={{ marginTop: 0, marginBottom: 12 }}><Icon.x /><div>{pwErr}</div></div>}
                  <div style={{ display: "flex", gap: 10 }}>
                    <button className="btn btn-primary" disabled={pwBusy}>{pwBusy ? <span className="spinner" /> : null}Save</button>
                    <button type="button" className="btn btn-ghost" onClick={() => { setPwOpen(false); resetPw(); }}>Cancel</button>
                  </div>
                </form>
              )}
            </div>

            {!currentUser.twofaEnabled && (
              <div className="nudge" style={{ marginBottom: 18 }}>
                <Icon.lock />
                <div style={{ flex: 1 }}>
                  <div className="nt">Protect your account with 2FA</div>
                  <div className="nd">Add a one-time code on top of your password. Strongly recommended for admins.</div>
                </div>
                {!enroll && (
                  <button className="btn btn-primary btn-sm" style={{ alignSelf: "center" }} onClick={startEnroll}>
                    Enable 2FA
                  </button>
                )}
              </div>
            )}

            {enroll && (
              <div className="card card-pad" style={{ marginBottom: 18 }}>
                <div style={{ fontWeight: 650, marginBottom: 8 }}>Set up two-factor authentication</div>
                <p className="muted" style={{ fontSize: 13 }}>
                  Add this key to your authenticator app, then enter the 6-digit code to confirm.
                </p>
                <div className="code" style={{ margin: "12px 0", whiteSpace: "normal", wordBreak: "break-all" }}>
                  {enroll.secret}
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <input className="input mono" style={{ maxWidth: 160, letterSpacing: 4, textAlign: "center" }} maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="123456" />
                  <button className="btn btn-primary" onClick={verifyEnroll}>Verify &amp; enable</button>
                  <button className="btn btn-ghost" onClick={() => setEnroll(null)}>Cancel</button>
                </div>
                {err && <div className="test-result bad"><Icon.x /><div>{err}</div></div>}
              </div>
            )}

            {backup && (
              <div className="card card-pad" style={{ marginBottom: 18 }}>
                <div style={{ fontWeight: 650, marginBottom: 6, color: "var(--green)" }}>2FA enabled ✓ — save your backup codes</div>
                <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>Each code works once if you lose your authenticator.</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {backup.map((c) => (
                    <span key={c} className="pill n mono">{c}</span>
                  ))}
                </div>
              </div>
            )}

            <div className="card atable">
              <div className="ahead" style={{ gridTemplateColumns: "1.4fr 1fr 1fr 1.1fr auto" }}>
                <div>User</div>
                <div>Role</div>
                <div>2FA</div>
                <div>Last login</div>
                <div />
              </div>
              {users.map((u, i) => (
                <div key={u.id} className="arow" style={{ gridTemplateColumns: "1.4fr 1fr 1fr 1.1fr auto" }}>
                  <div className="who">
                    <span className="av" style={{ background: avatarColor[i % avatarColor.length] }}>
                      {u.username[0].toUpperCase()}
                    </span>
                    <div>
                      {u.username}
                      <div className="muted" style={{ fontSize: 11 }}>{u.email || "—"}</div>
                    </div>
                  </div>
                  <div>
                    <span className={`pill ${u.role === "admin" ? "b" : "n"}`}>
                      {u.role === "scoped" ? u.scope || "scoped" : u.role}
                    </span>
                  </div>
                  <div>
                    <span className={`pill ${u.twofaEnabled ? "g" : "r"}`}>{u.twofaEnabled ? "On" : "Not set up"}</span>
                  </div>
                  <div className="muted">{u.lastLoginAt ? fmt(u.lastLoginAt) : "never"}</div>
                  <div>
                    {currentUser.role === "admin" && u.id !== currentUser.id && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={async () => {
                          if (confirm(`Delete ${u.username}?`)) {
                            await api.deleteUser(u.id);
                            load();
                          }
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === "sessions" && (
          <div className="card atable">
            <div className="ahead" style={{ gridTemplateColumns: "1fr 2fr 1.1fr 1fr" }}>
              <div>User</div>
              <div>Device</div>
              <div>Source IP</div>
              <div>Signed in</div>
            </div>
            {sessions.map((s) => (
              <div key={s.token} className="arow" style={{ gridTemplateColumns: "1fr 2fr 1.1fr 1fr" }}>
                <div>{s.username}</div>
                <div className="muted">{s.device}</div>
                <div className="mono">{s.ip || "—"}</div>
                <div className="muted">{fmt(s.lastActive)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
