import { useEffect, useState } from "react";
import { routeHash, type Route } from "../App.tsx";
import type { ProxyHost } from "../types.ts";
import type { AuthUser } from "../api.ts";
import { healthClass } from "../types.ts";
import { useFocusTrap } from "../hooks.ts";
import { Icon } from "../icons.tsx";
import { Avatar } from "./Avatar.tsx";
import { BrandLogo } from "./BrandLogo.tsx";
import { ServiceIcon } from "./ServiceIcon.tsx";
import { UpdateButton } from "./UpdateButton.tsx";
import type { Theme } from "../theme.ts";

interface Props {
  hosts: ProxyHost[];
  route: Route;
  navigate: (r: Route) => void;
  theme: { theme: Theme; cycleTheme: () => void };
  user: AuthUser;
  onLogout: () => void;
  open?: boolean;
  /** Close the mobile drawer (Escape / after nav). No-op above the breakpoint. */
  onClose?: () => void;
  /** Open the ⌘K command palette from the sidebar search trigger. */
  onOpenPalette?: () => void;
}

// A plain left click on a nav link is intercepted for SPA navigation; Cmd/Ctrl/Shift
// clicks and non-primary buttons fall through so the browser opens a real new tab.
function isPlainClick(e: React.MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

const themeIcon: Record<Theme, (p: { className?: string }) => React.ReactNode> = {
  dark: Icon.moon,
  "less-dark": Icon.moonStar,
  medium: Icon.contrast,
  "less-light": Icon.sunDim,
  light: Icon.sun,
};
const themeLabel: Record<Theme, string> = {
  dark: "Dark", "less-dark": "Less dark", medium: "Medium", "less-light": "Less light", light: "Light",
};

export function Sidebar({ hosts, route, navigate, theme, user, onLogout, open = false, onClose, onOpenPalette }: Props) {
  const [svcOpen, setSvcOpen] = useState(true);
  const ThemeIcon = themeIcon[theme.theme];

  // Below the CSS breakpoint the sidebar is an off-canvas drawer: when it's closed its
  // ~15 controls must not be reachable by Tab (inert), and when it's open focus is
  // trapped inside it and Escape closes it, restoring focus to the toggle.
  const [isMobile, setIsMobile] = useState(
    () => typeof matchMedia === "function" && matchMedia("(max-width: 760px)").matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(max-width: 760px)");
    const on = () => setIsMobile(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);

  const asideRef = useFocusTrap<HTMLElement>(isMobile && open, onClose);
  // Off-canvas + closed → hide the whole panel from the tab order and a11y tree.
  useEffect(() => {
    asideRef.current?.toggleAttribute("inert", isMobile && !open);
  }, [asideRef, isMobile, open]);

  // A nav target rendered as a real <a href> so Cmd/middle-click open a new tab and the
  // status bar shows the destination; a plain left click is hijacked for SPA nav.
  const navLink = (r: Route, className: string, active: boolean, children: React.ReactNode, key?: string) => (
    <a
      key={key}
      href={routeHash(r)}
      className={className + (active ? " active" : "")}
      aria-current={active ? "page" : undefined}
      onClick={(e) => {
        if (!isPlainClick(e)) return; // let the browser handle modified / new-tab clicks
        e.preventDefault();
        navigate(r);
      }}
    >
      {children}
    </a>
  );

  const item = (name: Route["name"], label: string, IconC: (p: { className?: string }) => React.ReactNode) =>
    navLink({ name }, "nav-item", route.name === name, (
      <>
        <IconC />
        {label}
      </>
    ));

  return (
    <aside ref={asideRef} className={`sidebar${open ? " open" : ""}`}>
      <div className="brand">
        <BrandLogo className="brand-logo" />
        <div className="brand-name">
          NginUX<small>Secure ingress, simplified</small>
        </div>
      </div>

      {onOpenPalette && (
        <button type="button" className="search" style={{ maxWidth: "none", cursor: "pointer" }} onClick={onOpenPalette}>
          <Icon.search />
          <span style={{ flex: 1, textAlign: "left" }}>Search…</span>
          <span className="kbd">⌘K</span>
        </button>
      )}

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
          {hosts.map((h) =>
            navLink(
              { name: "host", hostId: h.id },
              `nav-child${h.enabled ? "" : " is-paused"}`,
              route.name === "host" && route.hostId === h.id,
              (
                <>
                  <span className="ce"><ServiceIcon iconUrl={h.iconUrl} size={16} /></span>
                  {h.name}
                  <span className={`dot ${h.enabled ? healthClass[h.health] : "n"}`} title={h.enabled ? undefined : "Paused"} />
                </>
              ),
              h.id,
            ),
          )}
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

      {user.role === "admin" && <UpdateButton />}
      <div className="sidebar-footer">
        <Avatar userId={user.id} name={user.username} editable />
        <div style={{ fontSize: 12.5, minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>{user.username}</div>
          <div style={{ color: "var(--text-faint)", fontSize: 11, textTransform: "capitalize" }}>{user.role}</div>
        </div>
        <button className="theme-toggle" title={`Theme: ${themeLabel[theme.theme]} — click to switch`} aria-label="Switch theme" onClick={theme.cycleTheme}>
          <ThemeIcon />
        </button>
        <button className="theme-toggle" title="Sign out" aria-label="Sign out" onClick={onLogout}>
          <Icon.logout />
        </button>
      </div>
    </aside>
  );
}
