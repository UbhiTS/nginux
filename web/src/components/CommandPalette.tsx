import { useEffect, useMemo, useRef, useState } from "react";
import type { Route, RouteName } from "../App.tsx";
import type { ProxyHost } from "../types.ts";
import { Icon } from "../icons.tsx";
import { Modal } from "./Modal.tsx";

interface Props {
  open: boolean;
  onClose: () => void;
  hosts: ProxyHost[];
  navigate: (r: Route) => void;
}

interface Command {
  key: string;
  label: string;
  hint?: string;
  route: Route;
}

// The reachable pages (the RouteName union minus "host", which is represented by the
// individual services below). Order here is the default order in the palette.
const PAGES: { name: Exclude<RouteName, "host">; label: string; hint: string }[] = [
  { name: "dashboard", label: "Dashboard", hint: "Overview & traffic" },
  { name: "services", label: "Services", hint: "All proxy hosts" },
  { name: "wizard", label: "Expose a service", hint: "New reverse proxy" },
  { name: "certs", label: "Certificates", hint: "TLS certificates" },
  { name: "logs", label: "Logs", hint: "Access & error logs" },
  { name: "security", label: "Security Center", hint: "Exposure & policies" },
  { name: "useraccess", label: "Users & Access", hint: "Accounts & roles" },
  { name: "agents", label: "Agents & API", hint: "Tokens & agents" },
  { name: "settings", label: "Settings", hint: "System settings" },
];

// Case-insensitive subsequence match ("grf" matches "Grafana"). Returns true when every
// character of `q` appears in `text` in order — the classic fuzzy-finder behavior.
function fuzzy(text: string, q: string): boolean {
  if (!q) return true;
  const t = text.toLowerCase();
  let i = 0;
  for (const ch of q.toLowerCase()) {
    i = t.indexOf(ch, i);
    if (i === -1) return false;
    i += 1;
  }
  return true;
}

export function CommandPalette({ open, onClose, hosts, navigate }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);

  // Fresh query + selection every time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const pages: Command[] = PAGES.map((p) => ({
      key: `page:${p.name}`,
      label: p.label,
      hint: p.hint,
      route: { name: p.name },
    }));
    const services: Command[] = hosts.map((h) => ({
      key: `host:${h.id}`,
      label: h.name,
      hint: h.domain,
      route: { name: "host", hostId: h.id },
    }));
    return [...pages, ...services];
  }, [hosts]);

  const results = useMemo(
    () => commands.filter((c) => fuzzy(c.label, query) || (c.hint ? fuzzy(c.hint, query) : false)),
    [commands, query],
  );

  // Keep the highlighted row in range as the result set shrinks/grows.
  useEffect(() => {
    setActive((a) => (results.length === 0 ? 0 : Math.min(a, results.length - 1)));
  }, [results.length]);

  // Scroll the active row into view when navigating with the keyboard.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const run = (cmd: Command | undefined) => {
    if (!cmd) return;
    onClose();
    navigate(cmd.route);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (results.length ? (a + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (results.length ? (a - 1 + results.length) % results.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(results[active]);
    }
    // Escape is handled by the Modal's focus trap (closes + restores focus).
  };

  return (
    <Modal open={open} onClose={onClose} labelledBy="cmdk-title" className="cmdk-card">
      <h2 id="cmdk-title" className="sr-only">
        Command palette
      </h2>
      <div className="search" style={{ maxWidth: "none", marginBottom: 10 }}>
        <Icon.search />
        <input
          type="text"
          autoFocus
          aria-label="Search pages and services"
          aria-controls="cmdk-list"
          placeholder="Jump to a page or service…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <span className="kbd">Esc</span>
      </div>
      {results.length === 0 ? (
        <div className="state-note">No matches for “{query}”.</div>
      ) : (
        <ul
          id="cmdk-list"
          ref={listRef}
          role="listbox"
          aria-label="Results"
          style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 320, overflowY: "auto" }}
        >
          {results.map((c, i) => (
            <li key={c.key} role="presentation">
              <button
                type="button"
                role="option"
                data-idx={i}
                aria-selected={i === active}
                className={`cmdk-item${i === active ? " active" : ""}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  textAlign: "left",
                  background: i === active ? "var(--bg-elev)" : "transparent",
                  border: "none",
                  borderRadius: 8,
                  padding: "9px 11px",
                  color: "var(--text)",
                  cursor: "pointer",
                  font: "inherit",
                }}
                onMouseMove={() => setActive(i)}
                onClick={() => run(c)}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {c.label}
                </span>
                {c.hint && (
                  <span className="caption" style={{ flexShrink: 0 }}>
                    {c.hint}
                  </span>
                )}
                <Icon.arrowRight className="cmdk-go" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
