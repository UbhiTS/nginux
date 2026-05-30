import { useState } from "react";
import { api, type AuthUser } from "../api.ts";
import { Icon } from "../icons.tsx";

/** Forced on first login when the account still has the default password. */
export function ChangePassword({ user, onChanged }: { user: AuthUser; onChanged: (u: AuthUser) => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (next.length < 8) return setError("Use at least 8 characters.");
    if (next !== confirm) return setError("The two new passwords don't match.");
    setBusy(true);
    try {
      const res = await api.changePassword(current, next);
      onChanged(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change the password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 20 }}>
      <div className="card" style={{ width: 380, padding: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 22 }}>
          <img className="brand-logo" src="/favicon.svg" alt="NginUX" />
          <div className="brand-name">
            NginUX<small>reverse proxy, simplified</small>
          </div>
        </div>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Set a new password</h2>
        <p className="muted" style={{ fontSize: 13, marginBottom: 20 }}>
          Welcome, {user.username}. For security, choose your own password before continuing.
        </p>

        <form onSubmit={submit}>
          <div className="field">
            <label>Current password</label>
            <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
          </div>
          <div className="field">
            <label>New password</label>
            <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} />
          </div>
          <div className="field">
            <label>Confirm new password</label>
            <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>

          {error && (
            <div className="test-result bad" style={{ marginTop: 0, marginBottom: 14 }}>
              <Icon.x />
              <div>{error}</div>
            </div>
          )}

          <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center" }} disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            Save and continue
          </button>
        </form>
      </div>
    </div>
  );
}
