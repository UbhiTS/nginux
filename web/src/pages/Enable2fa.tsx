import { useState } from "react";
import { api, type AuthUser } from "../api.ts";
import { Icon } from "../icons.tsx";
import { BrandLogo } from "../components/BrandLogo.tsx";
import { QrCode } from "../components/QrCode.tsx";
import { Field } from "../components/Field.tsx";
import { copyText } from "../format.ts";

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
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const copyBackup = async () => {
    if (!backup) return;
    setCopied(await copyText(backup.join("\n")));
  };

  const downloadBackup = () => {
    if (!backup) return;
    const blob = new Blob([backup.join("\n") + "\n"], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "nginux-backup-codes.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

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
            <Field label="Confirm your password">
              <input
                className="input"
                id="current-password"
                name="current-password"
                type="password"
                autoComplete="current-password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                autoFocus
              />
            </Field>
            {error && <div className="test-result bad" role="alert" style={{ marginTop: 0, marginBottom: 14 }}><Icon.x /><div>{error}</div></div>}
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
            <Field label="Secret (manual entry)">
              <input className="input mono" id="totp-secret" name="totp-secret" readOnly value={enroll.secret} onFocus={(e) => e.target.select()} style={{ fontSize: 12 }} />
            </Field>
            <Field label="6-digit code">
              <input
                className="input mono" id="one-time-code" name="one-time-code" autoComplete="one-time-code"
                value={code} inputMode="numeric" maxLength={6} autoFocus
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                style={{ fontSize: 20, letterSpacing: 6, textAlign: "center" }}
              />
            </Field>
            {error && <div className="test-result bad" role="alert" style={{ marginTop: 0, marginBottom: 14 }}><Icon.x /><div>{error}</div></div>}
            <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center" }} disabled={busy}>
              {busy ? <span className="spinner" /> : null}Verify &amp; enable
            </button>
          </form>
        )}

        {phase === "backup" && backup && (
          <>
            <div className="test-result" role="status" style={{ marginBottom: 14 }}><Icon.check /><div>Two-factor is on.</div></div>
            <p className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
              Save these one-time backup codes somewhere safe - each works once if you lose your authenticator.
            </p>
            <div className="code" style={{ marginBottom: 12 }}>{backup.join("\n")}</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              <button type="button" className="btn btn-ghost btn-sm" style={{ flex: 1, justifyContent: "center" }} onClick={copyBackup}>
                {copied ? "Copied" : "Copy"}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" style={{ flex: 1, justifyContent: "center" }} onClick={downloadBackup}>
                Download .txt
              </button>
            </div>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12.5, marginBottom: 14, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                style={{ marginTop: 2 }}
              />
              <span>I've saved my backup codes somewhere safe.</span>
            </label>
            <button
              className="btn btn-primary"
              style={{ width: "100%", justifyContent: "center" }}
              onClick={onEnabled}
              disabled={!acknowledged}
            >
              Continue
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
