import { useState } from "react";
import { api, type AuthUser } from "../api.ts";
import { Icon } from "../icons.tsx";
import { BrandLogo } from "../components/BrandLogo.tsx";

export function Login({ onSignedIn }: { onSignedIn: (u: AuthUser) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [needs2fa, setNeeds2fa] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api.login(username, password, needs2fa ? token : undefined);
      if (res.twofaRequired) {
        setNeeds2fa(true);
        setError(needs2fa ? "That 2FA code didn't match — try the current one." : "");
      } else if (res.user) {
        onSignedIn(res.user);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 20 }}>
      <div className="card" style={{ width: 380, padding: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 22 }}>
          <BrandLogo className="brand-logo" />
          <div className="brand-name">
            NginUX<small>your homelab's front door</small>
          </div>
        </div>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>
          {needs2fa ? "Enter your 2FA code" : "Sign in"}
        </h2>
        <p className="muted" style={{ fontSize: 13, marginBottom: 20 }}>
          {needs2fa ? "Open your authenticator app for the 6-digit code." : "Use your NginUX account."}
        </p>

        <form onSubmit={submit}>
          {!needs2fa ? (
            <>
              <div className="field">
                <label>Username</label>
                <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
              </div>
              <div className="field">
                <label>Password</label>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
            </>
          ) : (
            <div className="field">
              <label>6-digit code</label>
              <input
                className="input mono"
                value={token}
                inputMode="numeric"
                maxLength={6}
                onChange={(e) => setToken(e.target.value.replace(/\D/g, ""))}
                autoFocus
                style={{ fontSize: 20, letterSpacing: 6, textAlign: "center" }}
              />
            </div>
          )}

          {error && (
            <div className="test-result bad" style={{ marginTop: 0, marginBottom: 14 }}>
              <Icon.x />
              <div>{error}</div>
            </div>
          )}

          <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center" }} disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            {needs2fa ? "Verify" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
