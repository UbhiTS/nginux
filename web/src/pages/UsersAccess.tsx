import { useState } from "react";
import { api, type AuthUser, type Session } from "../api.ts";
import { Icon } from "../icons.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { Field } from "../components/Field.tsx";
import { QrCode } from "../components/QrCode.tsx";
import { useAsyncData } from "../hooks.ts";

type Tab = "users" | "sessions";
const avatarColor = ["var(--purple)", "var(--accent)", "var(--green)", "var(--text-faint)"];

export function UsersAccess({
  currentUser,
  refreshMe,
  tab: tabProp,
  setTab,
}: {
  currentUser: AuthUser;
  refreshMe: () => Promise<void>;
  tab?: string;
  setTab: (t: string) => void;
}) {
  // Active tab lives in the URL (#/useraccess/<tab>) so refresh keeps it.
  const tab: Tab = (["users", "sessions"] as Tab[]).includes(tabProp as Tab) ? (tabProp as Tab) : "users";
  // loading→ready→error machines so a dropped fetch is distinguishable from a
  // genuinely empty list (don't flash placeholder rows / zero-states during load).
  const usersState = useAsyncData(() => api.users(), []);
  const sessionsState = useAsyncData(() => api.sessions(), []);
  const users = usersState.data ?? [];
  const sessions = sessionsState.data ?? [];
  const load = () => { usersState.reload(); sessionsState.reload(); };

  // admin: change a user's role in place (server refuses demoting the last admin).
  const changeRole = async (u: AuthUser, role: AuthUser["role"]) => {
    if (role === u.role) return;
    setRoleBusyId(u.id);
    setRoleErr("");
    try {
      await api.updateUserRole(u.id, role, u.scope);
      if (u.id === currentUser.id) await refreshMe();
      load();
    } catch (e) {
      setRoleErr(e instanceof Error ? e.message : "Couldn't change the role.");
    } finally {
      setRoleBusyId("");
    }
  };

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

  // admin: revoke a session / change a role in place
  const [revokeS, setRevokeS] = useState<Session | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [roleBusyId, setRoleBusyId] = useState("");
  const [roleErr, setRoleErr] = useState("");

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
  // second step: confirm the (destructive) reset before it lands.
  const [rpConfirmOpen, setRpConfirmOpen] = useState(false);

  const openReset = (u: AuthUser) => { setResetUser(u); setRpNew(""); setRpConfirm(""); setRpErr(""); setRpDone(""); setRpConfirmOpen(false); };
  const submitReset = (e: React.FormEvent) => {
    e.preventDefault();
    setRpErr("");
    if (rpNew.length < 8) return setRpErr("Use at least 8 characters.");
    if (rpNew !== rpConfirm) return setRpErr("The two passwords don't match.");
    if (!resetUser) return;
    setRpConfirmOpen(true);
  };
  const confirmReset = async () => {
    if (!resetUser) return;
    setRpBusy(true);
    try {
      await api.adminSetUserPassword(resetUser.id, rpNew);
      setRpDone(`Password reset for ${resetUser.username}. They'll be asked to change it on next sign-in.`);
      setResetUser(null);
      setRpConfirmOpen(false);
      load();
    } catch (e2) {
      setRpErr(e2 instanceof Error ? e2.message : "Couldn't reset the password.");
      setRpConfirmOpen(false);
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

  // The current user is always shown (even if the fetched list hasn't caught up),
  // but only once the list has actually loaded — so we never flash false rows.
  const displayUsers = users.some((u) => u.id === currentUser.id) ? users : [currentUser, ...users];
  const adminCount = displayUsers.filter((u) => u.role === "admin").length;

  const cols = "1.4fr 1fr 1fr 1.1fr 210px";

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
        <div className="sectabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "users"} className={`sectab${tab === "users" ? " active" : ""}`} onClick={() => setTab("users")}>Users &amp; roles</button>
          <button type="button" role="tab" aria-selected={tab === "sessions"} className={`sectab${tab === "sessions" ? " active" : ""}`} onClick={() => setTab("sessions")}>Active sessions</button>
        </div>

        {tab === "users" && (
          <>
            {pwOk && (
              <div className="test-result ok" role="status" style={{ marginBottom: 18 }}><Icon.check /><div>Your password was changed.</div></div>
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
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-end", alignSelf: "center", flexWrap: "wrap" }}>
                    <Field label="Confirm password">
                      <input className="input" type="password" style={{ maxWidth: 180 }} value={pw}
                        onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void startEnroll(); }} autoFocus />
                    </Field>
                    <button className="btn btn-primary btn-sm" onClick={() => void startEnroll()}>Continue</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => { setPwPrompt(false); setPw(""); setErr(""); }}>Cancel</button>
                  </div>
                )}
              </div>
            )}
            {pwPrompt && err && (
              <div className="test-result bad" role="alert" style={{ marginBottom: 18 }}><Icon.x /><div>{err}</div></div>
            )}

            {enroll && (
              <div className="card card-pad" style={{ marginBottom: 18 }}>
                <div style={{ fontWeight: 650, marginBottom: 8 }}>Set up two-factor authentication</div>
                <p className="muted" style={{ fontSize: 13 }}>
                  Scan this QR code with your authenticator app - or enter the key manually - then enter the 6-digit code to confirm.
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
                    <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
                      <Field label="6-digit code">
                        <input className="input mono" style={{ maxWidth: 160, letterSpacing: 4, textAlign: "center" }} maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="123456" />
                      </Field>
                      <button className="btn btn-primary" onClick={verifyEnroll}>Verify &amp; enable</button>
                      <button className="btn btn-ghost" onClick={() => setEnroll(null)}>Cancel</button>
                    </div>
                  </div>
                </div>
                {err && <div className="test-result bad" role="alert"><Icon.x /><div>{err}</div></div>}
              </div>
            )}

            {backup && (
              <div className="card card-pad" role="status" style={{ marginBottom: 18 }}>
                <div style={{ fontWeight: 650, marginBottom: 6, color: "var(--green)" }}>2FA enabled ✓ - save your backup codes</div>
                <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>Each code works once if you lose your authenticator.</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {backup.map((c) => (
                    <span key={c} className="pill n mono">{c}</span>
                  ))}
                </div>
              </div>
            )}

            {rpDone && (
              <div className="test-result ok" role="status" style={{ marginBottom: 18 }}><Icon.check /><div>{rpDone}</div></div>
            )}

            {roleErr && (
              <div className="test-result bad" role="alert" style={{ marginBottom: 14 }}>
                <Icon.x /><div>{roleErr}</div>
              </div>
            )}
            <div className="card atable">
              <div className="ahead" style={{ gridTemplateColumns: cols }}>
                <div>User</div>
                <div style={{ textAlign: "center" }}>Role</div>
                <div style={{ textAlign: "center" }}>2FA</div>
                <div>Last login</div>
                <div />
              </div>
              {usersState.status === "loading" && (
                <div style={{ padding: "12px 16px" }}>
                  {[0, 1, 2].map((i) => <div key={i} className="skeleton skeleton-row" />)}
                </div>
              )}
              {usersState.status === "error" && (
                <div className="state-note error" role="alert">
                  <Icon.alert />
                  <div>Couldn't load users.{usersState.error ? ` ${usersState.error}` : ""}</div>
                  <button className="btn btn-ghost btn-sm" onClick={() => usersState.reload()}><Icon.refresh />Retry</button>
                </div>
              )}
              {usersState.status === "ready" && displayUsers.map((u, i) => {
                const lastAdmin = u.role === "admin" && adminCount <= 1;
                return (
                  <div key={u.id} className="arow" style={{ gridTemplateColumns: cols }}>
                    <div className="who">
                      <span className="av" style={{ background: avatarColor[i % avatarColor.length] }}>
                        {u.username[0].toUpperCase()}
                      </span>
                      <div>
                        {u.username}
                        <div className="muted" style={{ fontSize: 11 }}>{u.email || "-"}</div>
                      </div>
                    </div>
                    <div style={{ textAlign: "center" }}>
                      {currentUser.role === "admin" ? (
                        <select
                          className="input"
                          style={{ width: "auto", padding: "5px 8px", fontSize: 12.5 }}
                          value={u.role}
                          disabled={lastAdmin || roleBusyId === u.id}
                          aria-label={`Role for ${u.username}`}
                          title={lastAdmin ? "Can't demote the last admin - promote another user first." : undefined}
                          onChange={(e) => changeRole(u, e.target.value as AuthUser["role"])}
                        >
                          <option value="admin">admin</option>
                          <option value="editor">editor</option>
                          <option value="readonly">readonly</option>
                          {u.role === "scoped" && <option value="scoped">scoped: {u.scope || "-"}</option>}
                        </select>
                      ) : (
                        <span className={`pill ${u.role === "admin" ? "b" : "n"}`}>
                          {u.role === "scoped" ? `scoped: ${u.scope || "-"}` : u.role}
                        </span>
                      )}
                    </div>
                    <div style={{ textAlign: "center" }}>
                      <span className={`pill ${u.twofaEnabled ? "g" : "r"}`}>{u.twofaEnabled ? "On" : "Not set up"}</span>
                    </div>
                    <div className="muted">{u.lastLoginAt ? fmt(u.lastLoginAt) : "never"}</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 64px", gap: 10, alignItems: "center" }}>
                      {/* password action - shares one centred slot so Change/Reset line up across rows */}
                      <span style={{ justifySelf: "center" }}>
                        {u.id === currentUser.id ? (
                          <button className="btn btn-ghost btn-sm" onClick={openPw}>Change password</button>
                        ) : currentUser.role === "admin" ? (
                          <button className="btn btn-ghost btn-sm" onClick={() => openReset(u)}>Reset password</button>
                        ) : null}
                      </span>
                      <span style={{ justifySelf: "center" }}>
                        {currentUser.role === "admin" && u.id !== currentUser.id && (
                          <button
                            className="btn btn-ghost btn-sm"
                            disabled={lastAdmin}
                            title={lastAdmin ? "Can't delete the last admin - promote another user first." : undefined}
                            onClick={() => setDelUser(u)}
                          >
                            Delete
                          </button>
                        )}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="caption" style={{ marginTop: 12 }}>
              <div className="overline" style={{ marginBottom: 6 }}>What each role can do</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px" }}>
                <span><b>admin</b> - full control, incl. users</span>
                <span><b>editor</b> - manage services &amp; certs</span>
                <span><b>readonly</b> - view everything</span>
                <span><b>scoped:</b> only the listed services</span>
              </div>
            </div>
          </>
        )}

        {tab === "sessions" && (
          <div className="card atable">
            <div className="ahead" style={{ gridTemplateColumns: "1.2fr 2fr 1.1fr 1fr auto" }}>
              <div>User</div>
              <div>Device</div>
              <div>Source IP</div>
              <div>Signed in</div>
              <div />
            </div>
            {sessionsState.status === "loading" && (
              <div style={{ padding: "12px 16px" }}>
                {[0, 1, 2].map((i) => <div key={i} className="skeleton skeleton-row" />)}
              </div>
            )}
            {sessionsState.status === "error" && (
              <div className="state-note error" role="alert">
                <Icon.alert />
                <div>Couldn't load sessions.{sessionsState.error ? ` ${sessionsState.error}` : ""}</div>
                <button className="btn btn-ghost btn-sm" onClick={() => sessionsState.reload()}><Icon.refresh />Retry</button>
              </div>
            )}
            {sessionsState.status === "ready" && sessions.length === 0 && (
              <div className="state-note">
                <Icon.users />
                <div>No active sessions.</div>
              </div>
            )}
            {sessionsState.status === "ready" && sessions.map((s) => (
              <div key={s.sid} className="arow" style={{ gridTemplateColumns: "1.2fr 2fr 1.1fr 1fr auto" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{s.username}</span>
                  {s.current && <span className="pill g" style={{ flexShrink: 0 }}>This device</span>}
                </div>
                <div className="muted">{s.device}</div>
                <div className="mono">{s.ip || "-"}</div>
                <div className="muted">{fmt(s.lastActive)}</div>
                <div style={{ justifySelf: "end" }}>
                  {currentUser.role === "admin" && (
                    <button className="btn btn-ghost btn-sm" onClick={() => setRevokeS(s)}>Revoke</button>
                  )}
                </div>
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

      {revokeS && (
        <ConfirmDialog
          danger
          title={revokeS.current ? "Sign out your own session?" : "Revoke this session?"}
          message={revokeS.current
            ? <>This signs <b>you</b> out on this device right away.</>
            : <>This signs out <b>{revokeS.username}</b> on <b>{revokeS.device}</b> ({revokeS.ip || "unknown IP"}) right away.</>}
          confirmLabel="Revoke session"
          busy={revokeBusy}
          onConfirm={async () => {
            setRevokeBusy(true);
            try {
              await api.revokeSession(revokeS.sid);
              const wasCurrent = revokeS.current;
              setRevokeS(null);
              if (wasCurrent) await refreshMe(); // our cookie is gone -> App drops to the login screen
              else load();
            } finally {
              setRevokeBusy(false);
            }
          }}
          onCancel={() => setRevokeS(null)}
        />
      )}

      {rpConfirmOpen && resetUser && (
        <ConfirmDialog
          danger
          title={`Reset ${resetUser.username}'s password?`}
          message={<>This replaces <b>{resetUser.username}</b>'s password and signs out any active sessions. They'll be asked to choose a new one at next sign-in.</>}
          confirmLabel="Reset password"
          busy={rpBusy}
          onConfirm={confirmReset}
          onCancel={() => setRpConfirmOpen(false)}
        />
      )}

      {pwOpen && (
        <div className="modal-backdrop" onClick={() => setPwOpen(false)}>
          <div className="card card-pad modal-card" onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 650, marginBottom: 4 }}>Change your password</div>
            <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>Update the password for your account ({currentUser.username}).</p>
            <form onSubmit={submitPw}>
              <Field label="Current password">
                <input className="input" type="password" value={pwCur} onChange={(e) => setPwCur(e.target.value)} autoFocus />
              </Field>
              <Field label="New password">
                <input className="input" type="password" value={pwNext} onChange={(e) => setPwNext(e.target.value)} />
              </Field>
              <Field label="Confirm new password">
                <input className="input" type="password" value={pwConfirm} onChange={(e) => setPwConfirm(e.target.value)} />
              </Field>
              {pwErr && <div className="test-result bad" role="alert" style={{ marginTop: 0, marginBottom: 12 }}><Icon.x /><div>{pwErr}</div></div>}
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
              <Field label="Username">
                <input className="input" value={auName} onChange={(e) => setAuName(e.target.value)} autoFocus />
              </Field>
              <Field label="Email (optional)">
                <input className="input" value={auEmail} onChange={(e) => setAuEmail(e.target.value)} />
              </Field>
              <Field label="Temporary password">
                <input className="input" type="password" value={auPass} onChange={(e) => setAuPass(e.target.value)} />
              </Field>
              <Field label="Role">
                <select className="input" value={auRole} onChange={(e) => setAuRole(e.target.value as AuthUser["role"])}>
                  <option value="readonly">Read-only - can view everything</option>
                  <option value="editor">Editor - manage services &amp; certs</option>
                  <option value="scoped">Scoped - only specific services</option>
                  <option value="admin">Admin - full control</option>
                </select>
              </Field>
              {auRole === "scoped" && (
                <Field label="Allowed services (comma-separated ids, names, or domains)">
                  <input className="input" value={auScope} onChange={(e) => setAuScope(e.target.value)} placeholder="plex, ha" />
                </Field>
              )}
              {auErr && <div className="test-result bad" role="alert" style={{ marginTop: 0, marginBottom: 12 }}><Icon.x /><div>{auErr}</div></div>}
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
            <div style={{ fontWeight: 650, marginBottom: 4 }}>Reset password - {resetUser.username}</div>
            <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
              Set a temporary password. {resetUser.username} will be required to choose a new one at next sign-in, and any active sessions will be signed out.
            </p>
            <form onSubmit={submitReset}>
              <Field label="New password">
                <input className="input" type="password" value={rpNew} onChange={(e) => setRpNew(e.target.value)} autoFocus />
              </Field>
              <Field label="Confirm new password">
                <input className="input" type="password" value={rpConfirm} onChange={(e) => setRpConfirm(e.target.value)} />
              </Field>
              {rpErr && <div className="test-result bad" role="alert" style={{ marginTop: 0, marginBottom: 12 }}><Icon.x /><div>{rpErr}</div></div>}
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
