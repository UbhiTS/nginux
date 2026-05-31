import { useEffect, useState } from "react";
import { api, type AuthUser, type Session } from "../api.ts";
import { Icon } from "../icons.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { QrCode } from "../components/QrCode.tsx";

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
  const [pwPrompt, setPwPrompt] = useState(false); // confirm-password gate before 2FA setup
  const [pw, setPw] = useState("");
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

  // admin: delete a user
  const [delUser, setDelUser] = useState<AuthUser | null>(null);
  const [delBusy, setDelBusy] = useState(false);

  // admin: add a new user
  const [addOpen, setAddOpen] = useState(false);
  const [auName, setAuName] = useState("");
  const [auEmail, setAuEmail] = useState("");
  const [auPass, setAuPass] = useState("");
  const [auRole, setAuRole] = useState<AuthUser["role"]>("readonly");
  const [auScope, setAuScope] = useState("");
  const [auErr, setAuErr] = useState("");
  const [auBusy, setAuBusy] = useState(false);

  const openAdd = () => { setAddOpen(true); setAuName(""); setAuEmail(""); setAuPass(""); setAuRole("readonly"); setAuScope(""); setAuErr(""); };
  const submitAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuErr("");
    if (!auName.trim()) return setAuErr("Username is required.");
    if (auPass.length < 8) return setAuErr("Password must be at least 8 characters.");
    setAuBusy(true);
    try {
      await api.createUser({ username: auName.trim(), password: auPass, email: auEmail.trim() || undefined, role: auRole, scope: auRole === "scoped" ? auScope.trim() : undefined });
      setAddOpen(false);
      load();
    } catch (e2) {
      setAuErr(e2 instanceof Error ? e2.message : "Couldn't create the user.");
    } finally {
      setAuBusy(false);
    }
  };

  // admin reset of another user's password
  const [resetUser, setResetUser] = useState<AuthUser | null>(null);
  const [rpNew, setRpNew] = useState("");
  const [rpConfirm, setRpConfirm] = useState("");
  const [rpErr, setRpErr] = useState("");
  const [rpBusy, setRpBusy] = useState(false);
  const [rpDone, setRpDone] = useState("");

  const openReset = (u: AuthUser) => { setResetUser(u); setRpNew(""); setRpConfirm(""); setRpErr(""); setRpDone(""); };
  const submitReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setRpErr("");
    if (rpNew.length < 8) return setRpErr("Use at least 8 characters.");
    if (rpNew !== rpConfirm) return setRpErr("The two passwords don't match.");
    if (!resetUser) return;
    setRpBusy(true);
    try {
      await api.adminSetUserPassword(resetUser.id, rpNew);
      setRpDone(`Password reset for ${resetUser.username}. They'll be asked to change it on next sign-in.`);
      setResetUser(null);
      load();
    } catch (e2) {
      setRpErr(e2 instanceof Error ? e2.message : "Couldn't reset the password.");
    } finally {
      setRpBusy(false);
    }
  };

  const resetPw = () => { setPwCur(""); setPwNext(""); setPwConfirm(""); setPwErr(""); };
  const openPw = () => { resetPw(); setPwOk(false); setPwOpen(true); };
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
    try {
      setEnroll(await api.twofaSetup(pw));
      setPwPrompt(false);
      setPw("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't start 2FA setup.");
    }
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
        <div style={{ flex: 1 }} />
        {currentUser.role === "admin" && tab === "users" && (
          <button className="btn btn-primary btn-sm" onClick={openAdd}><Icon.plus />Add user</button>
        )}
      </div>
      <div className="content">
        <div className="sectabs">
          <div className={`sectab${tab === "users" ? " active" : ""}`} onClick={() => setTab("users")}>Users &amp; roles</div>
          <div className={`sectab${tab === "sessions" ? " active" : ""}`} onClick={() => setTab("sessions")}>Active sessions</div>
        </div>

        {tab === "users" && (
          <>
            {pwOk && (
              <div className="test-result ok" style={{ marginBottom: 18 }}><Icon.check /><div>Your password was changed.</div></div>
            )}

            {!currentUser.twofaEnabled && (
              <div className="nudge" style={{ marginBottom: 18 }}>
                <Icon.lock />
                <div style={{ flex: 1 }}>
                  <div className="nt">Protect your account with 2FA</div>
                  <div className="nd">Add a one-time code on top of your password. Strongly recommended for admins.</div>
                </div>
                {!enroll && !pwPrompt && (
                  <button className="btn btn-primary btn-sm" style={{ alignSelf: "center" }} onClick={() => { setErr(""); setPwPrompt(true); }}>
                    Enable 2FA
                  </button>
                )}
                {!enroll && pwPrompt && (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", alignSelf: "center", flexWrap: "wrap" }}>
                    <input className="input" type="password" placeholder="Confirm password" style={{ maxWidth: 180 }} value={pw}
                      onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void startEnroll(); }} />
                    <button className="btn btn-primary btn-sm" onClick={() => void startEnroll()}>Continue</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => { setPwPrompt(false); setPw(""); setErr(""); }}>Cancel</button>
                  </div>
                )}
              </div>
            )}
            {pwPrompt && err && (
              <div className="test-result bad" style={{ marginBottom: 18 }}><Icon.x /><div>{err}</div></div>
            )}

            {enroll && (
              <div className="card card-pad" style={{ marginBottom: 18 }}>
                <div style={{ fontWeight: 650, marginBottom: 8 }}>Set up two-factor authentication</div>
                <p className="muted" style={{ fontSize: 13 }}>
                  Scan this QR code with your authenticator app — or enter the key manually — then enter the 6-digit code to confirm.
                </p>
                <div style={{ display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap", margin: "14px 0" }}>
                  <div style={{ background: "#fff", padding: 10, borderRadius: 10, flexShrink: 0, lineHeight: 0 }}>
                    <QrCode value={enroll.otpauth} />
                  </div>
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Or enter this key manually:</div>
                    <div className="code" style={{ whiteSpace: "normal", wordBreak: "break-all", marginBottom: 14 }}>
                      {enroll.secret}
                    </div>
                    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <input className="input mono" style={{ maxWidth: 160, letterSpacing: 4, textAlign: "center" }} maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="123456" />
                      <button className="btn btn-primary" onClick={verifyEnroll}>Verify &amp; enable</button>
                      <button className="btn btn-ghost" onClick={() => setEnroll(null)}>Cancel</button>
                    </div>
                  </div>
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

            {rpDone && (
              <div className="test-result ok" style={{ marginBottom: 18 }}><Icon.check /><div>{rpDone}</div></div>
            )}

            <div className="card atable">
              <div className="ahead" style={{ gridTemplateColumns: "1.4fr 1fr 1fr 1.1fr 210px" }}>
                <div>User</div>
                <div style={{ textAlign: "center" }}>Role</div>
                <div style={{ textAlign: "center" }}>2FA</div>
                <div>Last login</div>
                <div />
              </div>
              {(users.some((u) => u.id === currentUser.id) ? users : [currentUser, ...users]).map((u, i) => (
                <div key={u.id} className="arow" style={{ gridTemplateColumns: "1.4fr 1fr 1fr 1.1fr 210px" }}>
                  <div className="who">
                    <span className="av" style={{ background: avatarColor[i % avatarColor.length] }}>
                      {u.username[0].toUpperCase()}
                    </span>
                    <div>
                      {u.username}
                      <div className="muted" style={{ fontSize: 11 }}>{u.email || "—"}</div>
                    </div>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <span className={`pill ${u.role === "admin" ? "b" : "n"}`}>
                      {u.role === "scoped" ? u.scope || "scoped" : u.role}
                    </span>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <span className={`pill ${u.twofaEnabled ? "g" : "r"}`}>{u.twofaEnabled ? "On" : "Not set up"}</span>
                  </div>
                  <div className="muted">{u.lastLoginAt ? fmt(u.lastLoginAt) : "never"}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 64px", gap: 10, alignItems: "center" }}>
                    {/* password action — shares one centred slot so Change/Reset line up across rows */}
                    <span style={{ justifySelf: "center" }}>
                      {u.id === currentUser.id ? (
                        <button className="btn btn-ghost btn-sm" onClick={openPw}>Change password</button>
                      ) : currentUser.role === "admin" ? (
                        <button className="btn btn-ghost btn-sm" onClick={() => openReset(u)}>Reset password</button>
                      ) : null}
                    </span>
                    <span style={{ justifySelf: "center" }}>
                      {currentUser.role === "admin" && u.id !== currentUser.id && (
                        <button className="btn btn-ghost btn-sm" onClick={() => setDelUser(u)}>
                          Delete
                        </button>
                      )}
                    </span>
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

      {delUser && (
        <ConfirmDialog
          danger
          title={`Delete ${delUser.username}?`}
          message={<>This permanently removes the <b>{delUser.username}</b> account and signs out any active sessions. This can't be undone.</>}
          confirmLabel="Delete user"
          busy={delBusy}
          onConfirm={async () => {
            setDelBusy(true);
            try {
              await api.deleteUser(delUser.id);
              setDelUser(null);
              load();
            } finally {
              setDelBusy(false);
            }
          }}
          onCancel={() => setDelUser(null)}
        />
      )}

      {pwOpen && (
        <div className="modal-backdrop" onClick={() => setPwOpen(false)}>
          <div className="card card-pad modal-card" onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 650, marginBottom: 4 }}>Change your password</div>
            <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>Update the password for your account ({currentUser.username}).</p>
            <form onSubmit={submitPw}>
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
          </div>
        </div>
      )}

      {addOpen && (
        <div className="modal-backdrop" onClick={() => setAddOpen(false)}>
          <div className="card card-pad modal-card" onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 650, marginBottom: 4 }}>Add a user</div>
            <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
              They'll be asked to change this password on first sign-in.
            </p>
            <form onSubmit={submitAdd}>
              <div className="field"><label>Username</label>
                <input className="input" value={auName} onChange={(e) => setAuName(e.target.value)} autoFocus /></div>
              <div className="field"><label>Email (optional)</label>
                <input className="input" value={auEmail} onChange={(e) => setAuEmail(e.target.value)} /></div>
              <div className="field"><label>Temporary password</label>
                <input className="input" type="password" value={auPass} onChange={(e) => setAuPass(e.target.value)} /></div>
              <div className="field"><label>Role</label>
                <select className="input" value={auRole} onChange={(e) => setAuRole(e.target.value as AuthUser["role"])}>
                  <option value="readonly">Read-only — can view everything</option>
                  <option value="editor">Editor — manage services &amp; certs</option>
                  <option value="scoped">Scoped — only specific services</option>
                  <option value="admin">Admin — full control</option>
                </select></div>
              {auRole === "scoped" && (
                <div className="field"><label>Allowed services (comma-separated ids, names, or domains)</label>
                  <input className="input" value={auScope} onChange={(e) => setAuScope(e.target.value)} placeholder="plex, ha" /></div>
              )}
              {auErr && <div className="test-result bad" style={{ marginTop: 0, marginBottom: 12 }}><Icon.x /><div>{auErr}</div></div>}
              <div style={{ display: "flex", gap: 10 }}>
                <button className="btn btn-primary" disabled={auBusy}>{auBusy ? <span className="spinner" /> : null}Create user</button>
                <button type="button" className="btn btn-ghost" onClick={() => setAddOpen(false)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {resetUser && (
        <div className="modal-backdrop" onClick={() => setResetUser(null)}>
          <div className="card card-pad modal-card" onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 650, marginBottom: 4 }}>Reset password — {resetUser.username}</div>
            <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
              Set a temporary password. {resetUser.username} will be required to choose a new one at next sign-in, and any active sessions will be signed out.
            </p>
            <form onSubmit={submitReset}>
              <div className="field"><label>New password</label>
                <input className="input" type="password" value={rpNew} onChange={(e) => setRpNew(e.target.value)} autoFocus /></div>
              <div className="field"><label>Confirm new password</label>
                <input className="input" type="password" value={rpConfirm} onChange={(e) => setRpConfirm(e.target.value)} /></div>
              {rpErr && <div className="test-result bad" style={{ marginTop: 0, marginBottom: 12 }}><Icon.x /><div>{rpErr}</div></div>}
              <div style={{ display: "flex", gap: 10 }}>
                <button className="btn btn-primary" disabled={rpBusy}>{rpBusy ? <span className="spinner" /> : null}Reset password</button>
                <button type="button" className="btn btn-ghost" onClick={() => setResetUser(null)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
