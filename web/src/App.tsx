import { useCallback, useEffect, useState } from "react";
import { api, type AuthUser } from "./api.ts";
import type { ProxyHost, Settings } from "./types.ts";
import { useTheme } from "./theme.ts";
import { Icon } from "./icons.tsx";
import { BrandLogo } from "./components/BrandLogo.tsx";
import { Notifications } from "./components/Notifications.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Services } from "./pages/Services.tsx";
import { HostDetail } from "./pages/HostDetail.tsx";
import { Wizard } from "./pages/Wizard.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { SecurityCenter } from "./pages/SecurityCenter.tsx";
import { UsersAccess } from "./pages/UsersAccess.tsx";
import { Certificates } from "./pages/Certificates.tsx";
import { AgentsApi } from "./pages/AgentsApi.tsx";
import { Logs } from "./pages/Logs.tsx";
import { Login } from "./pages/Login.tsx";
import { ChangePassword } from "./pages/ChangePassword.tsx";
import { Enable2fa } from "./pages/Enable2fa.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";

export type RouteName =
  | "dashboard" | "services" | "host" | "wizard" | "certs"
  | "logs" | "security" | "useraccess" | "agents" | "settings";

export interface Route {
  name: RouteName;
  hostId?: string;
  tab?: string; // optional sub-tab, e.g. #/security/exposure
}

const ROUTE_NAMES: RouteName[] = [
  "dashboard", "services", "host", "wizard", "certs",
  "logs", "security", "useraccess", "agents", "settings",
];

// The current screen lives in the URL hash (e.g. #/services, #/host/<id>) so a
// refresh / back / forward keeps you where you were instead of resetting home.
function parseHash(): Route {
  // #/<name>[/<tab>]  ·  #/host/<id>[/<tab>] - the optional trailing segment is the
  // page's active sub-tab (or "edit" for a host), so a refresh / deep link keeps it.
  const parts = window.location.hash.replace(/^#\/?/, "").split("/");
  const name = parts[0];
  if ((ROUTE_NAMES as string[]).includes(name)) {
    if (name === "host") return parts[1] ? { name: "host", hostId: parts[1], tab: parts[2] || undefined } : { name: "host" };
    return parts[1] ? { name: name as RouteName, tab: parts[1] } : { name: name as RouteName };
  }
  return { name: "dashboard" };
}
export function routeHash(r: Route): string {
  if (r.name === "host") return r.hostId ? `#/host/${r.hostId}${r.tab ? `/${r.tab}` : ""}` : "#/host";
  return `#/${r.name}${r.tab ? `/${r.tab}` : ""}`;
}

// Per-route <title> so browser tabs / history / bookmarks are meaningful instead of a
// single static "NginUX" everywhere. Host routes resolve to the service's name.
function titleFor(r: Route, hosts: ProxyHost[]): string {
  switch (r.name) {
    case "services": return "Services · NginUX";
    case "wizard": return "New service · NginUX";
    case "certs": return "Certificates · NginUX";
    case "logs": return "Logs · NginUX";
    case "security": return "Security Center · NginUX";
    case "useraccess": return "Users & Access · NginUX";
    case "agents": return "Agents & API · NginUX";
    case "settings": return "Settings · NginUX";
    case "host": {
      const h = hosts.find((x) => x.id === r.hostId);
      return `${h?.name ?? "Service"} · NginUX`;
    }
    default: return "NginUX — reverse proxy";
  }
}

export function App() {
  const theme = useTheme();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [route, setRoute] = useState<Route>(() => parseHash());
  const [hosts, setHosts] = useState<ProxyHost[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  // true when the last data load failed - lets the Dashboard show a retry instead
  // of the "expose your first service" hero (which would be a lie on a fetch error).
  const [loadError, setLoadError] = useState(false);
  // Mobile drawer (no effect above the CSS breakpoint, where the sidebar is always shown).
  const [drawerOpen, setDrawerOpen] = useState(false);
  // ⌘K / Ctrl-K command palette.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // False until the first data load settles, so the Dashboard can show a skeleton
  // instead of flashing the "expose your first service" hero over the seed hosts=[].
  const [hostsLoaded, setHostsLoaded] = useState(false);

  // Check session on load.
  useEffect(() => {
    api.me().then(setUser).catch(() => setUser(null)).finally(() => setAuthChecked(true));
  }, []);

  // Keep the route in sync with the URL hash (browser back/forward, manual edits).
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Per-route document.title. Driven off `route` (not just navigate) so back/forward
  // and deep links update the tab too; re-runs when a host's name arrives.
  useEffect(() => {
    document.title = titleFor(route, hosts);
  }, [route, hosts]);

  // ⌘K / Ctrl-K toggles the command palette from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const reload = useCallback(async () => {
    // Don't let a transient backend hiccup throw an unhandled rejection that
    // leaves the UI on a stale/empty shell - fail soft and keep what we have.
    try {
      const [h, s] = await Promise.all([api.listHosts(), api.settings()]);
      setHosts(h);
      setSettings(s);
      setLoadError(false);
    } catch { setLoadError(true); /* keep previous state; the Dashboard surfaces a retry, not a false empty state */ }
    finally { setHostsLoaded(true); }
  }, []);

  // Load app data once signed in.
  useEffect(() => {
    if (user) reload();
  }, [user, reload]);

  const navigate = useCallback((r: Route, replace = false) => {
    const h = routeHash(r);
    // Page nav pushes a history entry; a tab switch (replace) updates the URL in
    // place so it survives refresh without spamming back/forward with every tab.
    if (replace) history.replaceState(null, "", h);
    else window.location.hash = h; // hashchange syncs state too
    setRoute(r);
    if (!replace) { setDrawerOpen(false); window.scrollTo(0, 0); }
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
    window.location.hash = routeHash({ name: "dashboard" });
    setRoute({ name: "dashboard" });
  }, []);

  const refreshMe = useCallback(async () => {
    setUser(await api.me());
  }, []);

  if (!authChecked) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100vh", gap: 14, color: "var(--text-dim)" }}>
        <BrandLogo size={44} className="brand-logo" />
        <span className="spinner" />
      </div>
    );
  }
  if (!user) return <Login onSignedIn={setUser} />;
  if (user.mustChangePassword) return <ChangePassword user={user} onChanged={setUser} />;
  // Policy: managers must have 2FA. The server also confines them to the enrollment
  // endpoints, so this gate can't be skipped by editing client state.
  if (user.mustEnable2fa) return <Enable2fa user={user} onEnabled={refreshMe} onLogout={logout} />;

  return (
    <div className="app">
      <button
        className="drawer-toggle"
        aria-label="Open navigation menu"
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen(true)}
      >
        <Icon.menu />
      </button>
      <button
        className={`drawer-backdrop${drawerOpen ? " open" : ""}`}
        aria-label="Close navigation menu"
        tabIndex={drawerOpen ? 0 : -1}
        onClick={() => setDrawerOpen(false)}
      />
      <Sidebar open={drawerOpen} hosts={hosts} route={route} navigate={navigate} theme={theme} user={user} onLogout={logout} onClose={() => setDrawerOpen(false)} onOpenPalette={() => setPaletteOpen(true)} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} hosts={hosts} navigate={navigate} />
      <div className="main">
        <Notifications />
        {route.name === "dashboard" && <Dashboard hosts={hosts} navigate={navigate} loadError={loadError} onRetry={reload} hostsLoaded={hostsLoaded} />}
        {route.name === "services" && <Services hosts={hosts} navigate={navigate} reload={reload} />}
        {route.name === "host" && route.hostId && <HostDetail hostId={route.hostId} navigate={navigate} reload={reload} tab={route.tab} />}
        {route.name === "wizard" && <Wizard settings={settings} navigate={navigate} reload={reload} />}
        {route.name === "settings" && <SettingsPage reload={reload} />}
        {route.name === "security" && <SecurityCenter tab={route.tab} setTab={(t) => navigate({ name: "security", tab: t }, true)} />}
        {route.name === "useraccess" && <UsersAccess currentUser={user} refreshMe={refreshMe} tab={route.tab} setTab={(t) => navigate({ name: "useraccess", tab: t }, true)} />}
        {route.name === "certs" && <Certificates />}
        {route.name === "logs" && <Logs />}
        {route.name === "agents" && <AgentsApi tab={route.tab} setTab={(t) => navigate({ name: "agents", tab: t }, true)} />}
      </div>
    </div>
  );
}
