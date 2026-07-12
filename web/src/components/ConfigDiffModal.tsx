import { useEffect, useId, useState } from "react";
import { api } from "../api.ts";
import type { ConfigPreview, ProxyHost } from "../types.ts";
import { Icon } from "../icons.tsx";
import { useFocusTrap } from "../hooks.ts";

const statusPill: Record<string, string> = { added: "g", modified: "y", removed: "r" };

/** "See exactly what changes" - dry-runs the nginx-config diff a pending
 *  create/update/delete would produce, WITHOUT writing or reloading. The real
 *  nginx -t + rollback still runs when the user actually applies. */
export function ConfigDiffModal({ mode, id, host, onClose, onConfirm, confirmLabel = "Apply changes" }: {
  mode: "create" | "update" | "delete";
  id?: string;
  host?: Partial<ProxyHost>;
  onClose: () => void;
  onConfirm?: () => void;
  confirmLabel?: string;
}) {
  const [preview, setPreview] = useState<ConfigPreview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const titleId = useId();
  // Focus moved in, trapped, restored on close; Escape closes (replaces the old
  // window keydown listener that left Tab walking the page behind the backdrop).
  const ref = useFocusTrap<HTMLDivElement>(true, onClose);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.previewConfig({ mode, id, host })
      .then((p) => { if (alive) { setPreview(p); setError(""); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : "Couldn't generate the preview."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [mode, id, host]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div ref={ref} className="card card-pad modal-card" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} style={{ width: 720, maxWidth: "100%" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <Icon.logs className="acct-ic" />
          <div id={titleId} className="modal-title">Configuration changes</div>
        </div>
        <p className="muted" style={{ fontSize: 12.5, marginBottom: 14 }}>
          Exactly what will be written to nginx. Nothing is applied yet - nginx validates and reloads only when you confirm, and an invalid config is rejected and rolled back automatically.
        </p>

        {loading ? (
          <div className="placeholder"><span className="spinner" /> Generating diff…</div>
        ) : error ? (
          <div className="test-result bad"><Icon.x /><div>{error}</div></div>
        ) : preview && !preview.changed ? (
          <div className="muted" style={{ fontSize: 13, padding: "18px 0" }}>No configuration change - this edit doesn't alter the generated nginx config.</div>
        ) : preview ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, maxHeight: "52vh", overflow: "auto" }}>
            {preview.files.map((f) => (
              <div key={f.name}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span className={`pill ${statusPill[f.status] ?? "n"}`}>{f.status}</span>
                  <span className="mono" style={{ fontSize: 12.5, wordBreak: "break-all" }}>{f.name}</span>
                  <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>
                    <span style={{ color: "var(--green)" }}>+{f.additions}</span>{" "}
                    <span style={{ color: "var(--red)" }}>−{f.deletions}</span>
                  </span>
                </div>
                <pre className="code" style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, maxHeight: 260, overflow: "auto", whiteSpace: "normal" }}>
                  {f.diff.split("\n").map((line, i) => {
                    const sign = line[0];
                    const color = sign === "+" ? "var(--green)" : sign === "-" ? "var(--red)" : "var(--text-dim)";
                    const bg = sign === "+" ? "var(--green-soft)" : sign === "-" ? "var(--red-soft)" : "transparent";
                    return <div key={i} style={{ color, background: bg, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{line || " "}</div>;
                  })}
                </pre>
              </div>
            ))}
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 10, marginTop: 18, alignItems: "center" }}>
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={onClose}>{onConfirm ? "Cancel" : "Close"}</button>
          {onConfirm && (
            <button className="btn btn-primary" onClick={onConfirm} disabled={loading || !!error}>{confirmLabel}</button>
          )}
        </div>
      </div>
    </div>
  );
}
