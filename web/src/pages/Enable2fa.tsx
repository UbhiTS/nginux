import { useState } from "react";
import { api, type AuthUser } from "../api.ts";
import { Icon } from "../icons.tsx";
import { BrandLogo } from "../components/BrandLogo.tsx";
import { QrCode } from "../components/QrCode.tsx";

/** Forced enrollment screen: shown when the require-2FA-for-managers policy is on
 *  and this admin/editor has no 2FA yet. Mirrors the ChangePassword gate - the
 *  server confines the account to the enrollment endpoints until it's done. */
export function Enable2fa({ user, onEnabled, onLogout }: {
  user: AuthUser;
  onEnabled: () => void;
  onLogout: () => void;
}) {
  const [phase, setPhase] = useState<"password" | "verify" | "backup">("password");
  const [pw, setPw] = useState("");
  const [enroll, setEnroll] = useState<{ secret: string; otpauth: string } | null>(null);
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      setEnroll(await api.twofaSetup(pw));
      setPw("");
      setPhase("verify");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start 2FA setup.");
    } finally { setBusy(false); }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      const r = await api.twofaVerify(code);
      setBackup(r.backupCodes);
      setCode("");
      setPhase("backup");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code didn't match - try the current one.");
    } finally { setBusy(false); }
  };

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 20 }}>
      <div className="card" style={{ width: 420, padding: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 22 }}>
          <BrandLogo className="brand-logo" />
          <div className="brand-name">NginUX<small>Secure ingress, simplified</small></div>
        </div>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Two-factor required</h2>
        <p className="muted" style={{ fontSize: 13, marginBottom: 20 }}>
          {user.username}, your role requires two-factor authentication. Set it up to continue.
        </p>

        {phase === "password" && (
          <form onSubmit={start}>
            <div className="field">
              <label>Confirm your password</label>
              <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
            </div>
            {error && <div className="test-result bad" style={{ marginTop: 0, marginBottom: 14 }}><Icon.x /><div>{error}</div></div>}
            <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center" }} disabled={busy}>
              {busy ? <span className="spinner" /> : null}Continue
            </button>
          </form>
        )}

        {phase === "verify" && enroll && (
          <form onSubmit={verify}>
            <p className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
              Scan this with your authenticator app, then enter the 6-digit code.
            </p>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
              <QrCode value={enroll.otpauth} />
            </div>
            <div className="field">
              <label>Secret (manual entry)</label>
              <input className="input mono" readOnly value={enroll.secret} onFocus={(e) => e.target.select()} style={{ fontSize: 12 }} />
            </div>
            <div className="field">
              <label>6-digit code</label>
              <input
                className="input mono" value={code} inputMode="numeric" maxLength={6} autoFocus
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                style={{ fontSize: 20, letterSpacing: 6, textAlign: "center" }}
              />
            </div>
            {error && <div className="test-result bad" style={{ marginTop: 0, marginBottom: 14 }}><Icon.x /><div>{error}</div></div>}
            <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center" }} disabled={busy}>
              {busy ? <span className="spinner" /> : null}Verify &amp; enable
            </button>
          </form>
        )}

        {phase === "backup" && backup && (
          <>
            <div className="test-result" style={{ marginBottom: 14 }}><Icon.check /><div>Two-factor is on.</div></div>
            <p className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
              Save these one-time backup codes somewhere safe - each works once if you lose your authenticator.
            </p>
            <div className="code" style={{ marginBottom: 16 }}>{backup.join("\n")}</div>
            <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center" }} onClick={onEnabled}>
              I've saved them - continue
            </button>
          </>
        )}

        <button className="btn btn-ghost btn-sm" style={{ width: "100%", justifyContent: "center", marginTop: 12 }} onClick={onLogout}>
          Sign out
        </button>
      </div>
    </div>
  );
}
