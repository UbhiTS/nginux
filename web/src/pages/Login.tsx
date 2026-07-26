import { useState } from "react";
import { api, type AuthUser } from "../api.ts";
import { Icon } from "../icons.tsx";
import { BrandLogo } from "../components/BrandLogo.tsx";
import { Field } from "../components/Field.tsx";

function requestedReturnUrl(): string | undefined {
  const value = new URLSearchParams(window.location.search).get("rd");
  return value && value.length <= 2048 ? value : undefined;
}

export function Login({ onSignedIn }: { onSignedIn: (u: AuthUser) => void }) {
  const returnUrl = requestedReturnUrl();
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
      const res = await api.login(username, password, needs2fa ? token : undefined, returnUrl);
      if (res.twofaRequired) {
        setNeeds2fa(true);
        setError(needs2fa ? "That 2FA code didn't match - try the current one." : "");
      } else if (res.user) {
        // Only follow a destination that the server matched to an enabled,
        // configured NginUX service.
        if (res.redirectTo) { window.location.href = res.redirectTo; return; }
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
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
      <div className="card" style={{ width: 380, padding: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 22 }}>
          <BrandLogo className="brand-logo" />
          <div className="brand-name">
            NginUX<small>Secure ingress, simplified</small>
          </div>
        </div>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>
          {needs2fa ? "Enter your 2FA code" : "Sign in"}
        </h2>
        <p className="muted" style={{ fontSize: 13, marginBottom: 20 }}>
          {needs2fa
            ? "Open your authenticator app for the 6-digit code."
            : returnUrl
              ? "Sign in to continue to the requested service."
              : "Use your NginUX account."}
        </p>

        <form onSubmit={submit}>
          {!needs2fa ? (
            <>
              <Field label="Username">
                <input
                  className="input"
                  id="username"
                  name="username"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoFocus
                />
              </Field>
              <Field label="Password">
                <input
                  className="input"
                  id="current-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
            </>
          ) : (
            <Field label="6-digit code">
              <input
                className="input mono"
                id="one-time-code"
                name="one-time-code"
                autoComplete="one-time-code"
                value={token}
                inputMode="numeric"
                maxLength={6}
                onChange={(e) => setToken(e.target.value.replace(/\D/g, ""))}
                autoFocus
                style={{ fontSize: 20, letterSpacing: 6, textAlign: "center" }}
              />
            </Field>
          )}

          {error && (
            <div className="test-result bad" role="alert" style={{ marginTop: 0, marginBottom: 14 }}>
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
      <div className="muted" style={{ fontSize: 12, textAlign: "center" }}>
        Built with ❤️ by <a href="https://github.com/UbhiTS" target="_blank" rel="noreferrer noopener">Tarunpreet Singh Ubhi</a>
        {" · "}
        <a href="https://github.com/UbhiTS/nginux" target="_blank" rel="noreferrer noopener">open source</a>, MIT licensed
      </div>
      </div>
    </div>
  );
}
