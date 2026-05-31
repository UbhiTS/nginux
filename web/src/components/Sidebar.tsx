import { useState } from "react";
import type { Route } from "../App.tsx";
import type { ProxyHost } from "../types.ts";
import type { AuthUser } from "../api.ts";
import { healthClass } from "../types.ts";
import { Icon } from "../icons.tsx";
import type { Theme } from "../theme.ts";

interface Props {
  hosts: ProxyHost[];
  route: Route;
  navigate: (r: Route) => void;
  theme: { theme: Theme; cycleTheme: () => void };
  user: AuthUser;
  onLogout: () => void;
  open?: boolean;
}

const themeIcon = { dark: Icon.moon, medium: Icon.contrast, light: Icon.sun };

export function Sidebar({ hosts, route, navigate, theme, user, onLogout, open = false }: Props) {
  const [svcOpen, setSvcOpen] = useState(true);
  const ThemeIcon = themeIcon[theme.theme];

  const item = (name: Route["name"], label: string, IconC: (p: { className?: string }) => React.ReactNode) => (
    <button
      type="button"
      className={`nav-item${route.name === name ? " active" : ""}`}
      aria-current={route.name === name ? "page" : undefined}
      onClick={() => navigate({ name })}
    >
      <IconC />
      {label}
    </button>
  );

  return (
    <aside className={`sidebar${open ? " open" : ""}`}>
      <div className="brand">
        <img className="brand-logo" src="/favicon.svg" alt="NginUX" />
        <div className="brand-name">
          NginUX<small>reverse proxy, simplified</small>
        </div>
      </div>

      <nav className="nav">
        <div className="nav-label">Manage</div>
        {item("dashboard", "Dashboard", Icon.dashboard)}

        <div
          className={`nav-parent${svcOpen ? " open" : ""}${route.name === "services" ? " active" : ""}`}
          role="button"
          tabIndex={0}
          aria-current={route.name === "services" ? "page" : undefined}
          onClick={() => navigate({ name: "services" })}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigate({ name: "services" }); } }}
        >
          <button
            type="button"
            className="nav-add-btn"
            title="Expose a service"
            aria-label="Expose a service"
            onClick={(e) => {
              e.stopPropagation();
              navigate({ name: "wizard" });
            }}
          >
            <Icon.plus />
          </button>
          Services
          <span className="svc-count">{hosts.length}</span>
          <button
            type="button"
            className="nav-caret-btn"
            title={svcOpen ? "Collapse" : "Expand"}
            aria-label={svcOpen ? "Collapse services" : "Expand services"}
            aria-expanded={svcOpen}
            onClick={(e) => { e.stopPropagation(); setSvcOpen((o) => !o); }}
          >
            <Icon.chevron className="nav-caret" />
          </button>
        </div>
        <div className={`nav-children${svcOpen ? "" : " collapsed"}`}>
          {hosts.map((h) => (
            <button
              type="button"
              key={h.id}
              className={`nav-child${route.name === "host" && route.hostId === h.id ? " active" : ""}${h.enabled ? "" : " is-paused"}`}
              aria-current={route.name === "host" && route.hostId === h.id ? "page" : undefined}
              onClick={() => navigate({ name: "host", hostId: h.id })}
            >
              <span className="ce">{h.emoji}</span>
              {h.name}
              <span className={`dot ${h.enabled ? healthClass[h.health] : "n"}`} title={h.enabled ? undefined : "Paused"} />
            </button>
          ))}
        </div>

        {item("certs", "Certificates", Icon.cert)}
        {item("logs", "Logs", Icon.logs)}
        {item("agents", "Agents & API", Icon.bot)}

        <div className="nav-label">Security</div>
        {item("security", "Security Center", Icon.shield)}
        {item("useraccess", "Users & Access", Icon.users)}

        <div className="nav-label">System</div>
        {item("settings", "Settings", Icon.gear)}
      </nav>

      <div className="sidebar-footer">
        <div className="avatar">{user.username[0].toUpperCase()}</div>
        <div style={{ fontSize: 12.5, minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>{user.username}</div>
          <div style={{ color: "var(--text-faint)", fontSize: 11, textTransform: "capitalize" }}>{user.role}</div>
        </div>
        <button className="theme-toggle" title="Switch theme (dark / medium / light)" aria-label="Switch theme" onClick={theme.cycleTheme}>
          <ThemeIcon />
        </button>
        <button className="theme-toggle" title="Sign out" aria-label="Sign out" onClick={onLogout}>
          <Icon.arrowRight />
        </button>
      </div>
    </aside>
  );
}
