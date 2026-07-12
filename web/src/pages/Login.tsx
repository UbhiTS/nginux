import { useState } from "react";
import { api, type AuthUser } from "../api.ts";
import { Icon } from "../icons.tsx";
import { BrandLogo } from "../components/BrandLogo.tsx";
import { Field } from "../components/Field.tsx";

// A login-gated service redirects unauthenticated visitors here with the original
// URL as ?rd=. After sign-in we bounce back to it - but only if it's on this same
// domain family (this host or a sibling subdomain), to avoid an open redirect.
// Common multi-part public suffixes. If stripping the leftmost label of the
// current host lands on one of these (e.g. nginux.co.uk -> co.uk), we must NOT
// treat it as a registrable base, or `rd=https://evil.co.uk` would be accepted.
const PUBLIC_SUFFIX_2LD = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gob", "gouv"]);

function safeReturnUrl(): string | null {
  const m = window.location.search.match(/[?&]rd=(.*)$/);
  if (!m) return null;
  let target: URL;
  try { target = new URL(decodeURIComponent(m[1])); } catch { try { target = new URL(m[1]); } catch { return null; } }
  if (target.protocol !== "https:" && target.protocol !== "http:") return null;
  const here = window.location.hostname.toLowerCase();
  const h = target.hostname.toLowerCase();
  if (h === here) return target.href; // same host is always safe
  // Sibling-subdomain bounce (login at nginux.example.com -> back to plex.example.com):
  // strip the leftmost label to get the registrable base, but refuse if that base is
  // itself a public suffix (co.uk, com.au) - which would otherwise allow *any* sibling.
  const parts = here.split(".");
  if (parts.length < 3) return null; // not on a subdomain -> only exact same-host
  const base = parts.slice(1).join(".");
  const baseParts = base.split(".");
  if (baseParts.length === 2 && PUBLIC_SUFFIX_2LD.has(baseParts[0])) return null; // base collapsed to a public suffix
  return h === base || h.endsWith("." + base) ? target.href : null;
}

export function Login({ onSignedIn }: { onSignedIn: (u: AuthUser) => void }) {
  const returnUrl = safeReturnUrl();
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
        setError(needs2fa ? "That 2FA code didn't match - try the current one." : "");
      } else if (res.user) {
        // Bounce back to the gated service that sent us here, else into the app.
        if (returnUrl) { window.location.href = returnUrl; return; }
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
              ? `Sign in to continue to ${new URL(returnUrl).host}.`
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
