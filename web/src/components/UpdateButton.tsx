import { useEffect, useRef, useState } from "react";
import { api, type UpdateStatus } from "../api.ts";
import { Icon } from "../icons.tsx";

/** Sidebar "Update" button: invisible until the release checker finds a newer
 *  version (or a newer build of the same version). Clicking opens a modal with
 *  the release notes and either a one-click self-update (Docker socket mounted)
 *  or copy-paste instructions. */
export function UpdateButton() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const pull = () => api.updateStatus().then((s) => { if (alive) setStatus(s); }).catch(() => {});
    pull();
    const t = setInterval(pull, 30 * 60_000); // the server checks every 6h; this just picks it up
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!status?.available) return null;
  const label = status.latestVersion && status.latestVersion !== status.current
    ? `Update to v${status.latestVersion}`
    : "Update available";

  return (
    <>
      <div style={{ padding: "0 14px 10px" }}>
        <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", gap: 8 }} onClick={() => setOpen(true)}>
          <Icon.download /> {label}
        </button>
      </div>
      {open && <UpdateModal status={status} onClose={() => setOpen(false)} />}
    </>
  );
}

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
}

function UpdateModal({ status, onClose }: { status: UpdateStatus; onClose: () => void }) {
  // idle -> applying (pull runs server-side) -> restarting (poll /api/health) -> done | failed
  const [phase, setPhase] = useState<"idle" | "applying" | "restarting" | "failed">("idle");
  const [message, setMessage] = useState("");
  const pollRef = useRef<number | null>(null);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const sameVersion = !status.latestVersion || status.latestVersion === status.current;
  const title = sameVersion ? `A new v${status.current} build is available` : `NginUX v${status.latestVersion} is available`;

  const apply = async () => {
    setPhase("applying");
    setMessage("Pulling the new image… this can take a minute on a slow connection.");
    try {
      const res = await api.updateApply();
      if (!res.ok) { setPhase("failed"); setMessage(res.message); return; }
      // The updater is now replacing this container - wait through the blip.
      setPhase("restarting");
      setMessage("Image pulled. Restarting onto the new version…");
      let sawDown = false;
      const t0 = Date.now();
      pollRef.current = window.setInterval(async () => {
        try {
          const r = await fetch("/api/health", { signal: AbortSignal.timeout(1500) });
          if (!r.ok) { sawDown = true; return; }
          // Up again after the restart gap (or never visibly down on a fast box).
          if (sawDown || Date.now() - t0 > 12_000) {
            if (pollRef.current) clearInterval(pollRef.current);
            setMessage("Updated! Reloading…");
            setTimeout(() => window.location.reload(), 600);
          }
        } catch { sawDown = true; }
        if (Date.now() - t0 > 4 * 60_000 && pollRef.current) {
          clearInterval(pollRef.current);
          setPhase("failed");
          setMessage("This is taking longer than expected. If the UI doesn't come back, check `docker ps` and `docker logs nginux-updater-…` - a failed update rolls back to the previous version automatically.");
        }
      }, 2000);
    } catch (e) {
      setPhase("failed");
      setMessage(e instanceof Error ? e.message : "Update failed to start.");
    }
  };

  const busy = phase === "applying" || phase === "restarting";
  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="card card-pad modal-card" style={{ width: 560, maxWidth: "100%" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 2 }}>
          <Icon.download className="acct-ic" />
          <div style={{ fontWeight: 650, fontSize: 15 }}>{title}</div>
        </div>
        <p className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
          You're on v{status.current}{status.buildSha ? ` (build ${status.buildSha.slice(0, 7)})` : ""}.
          {status.publishedAt ? ` Released ${fmtDate(status.publishedAt)}.` : ""}
          {status.releaseUrl && <> <a href={status.releaseUrl} target="_blank" rel="noreferrer">Release page ↗</a></>}
        </p>

        {status.notes && (
          <div className="code" style={{ maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.6, marginBottom: 14 }}>
            {status.notes}
          </div>
        )}

        {busy || phase === "failed" ? (
          <div className={`test-result ${phase === "failed" ? "bad" : "ok"}`} style={{ display: "flex", marginBottom: 6 }}>
            {busy ? <span className="spinner" /> : <Icon.x />}
            <div style={{ whiteSpace: "pre-wrap" }}>{message}</div>
          </div>
        ) : status.canSelfUpdate ? (
          <p className="muted" style={{ fontSize: 12.5 }}>
            One click: NginUX pulls the new image, restarts onto it with the same settings, and rolls back
            automatically if the new version doesn't come up healthy. Expect a few seconds of downtime.
          </p>
        ) : (
          <div>
            <p className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
              Update from the machine running NginUX:
            </p>
            <div className="code" style={{ fontSize: 12.5, marginBottom: 10 }}>
              docker compose pull && docker compose up -d
            </div>
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
              Prefer one-click updates from this screen? Mount the Docker socket into the container (see the
              commented line in <span className="mono">docker-compose.yml</span>) - or run
              {" "}<a href="https://containrrr.dev/watchtower/" target="_blank" rel="noreferrer">Watchtower</a> to
              update every container automatically.
            </p>
          </div>
        )}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}>
          {status.canSelfUpdate && phase !== "restarting" && (
            <button className="btn btn-primary" onClick={apply} disabled={busy}>
              {busy ? <span className="spinner" /> : null}Update now
            </button>
          )}
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Close</button>
        </div>
      </div>
    </div>
  );
}
