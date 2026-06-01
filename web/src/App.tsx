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

export type RouteName =
  | "dashboard" | "services" | "host" | "wizard" | "certs"
  | "logs" | "security" | "useraccess" | "agents" | "settings";

export interface Route {
  name: RouteName;
  hostId?: string;
}

const ROUTE_NAMES: RouteName[] = [
  "dashboard", "services", "host", "wizard", "certs",
  "logs", "security", "useraccess", "agents", "settings",
];

// The current screen lives in the URL hash (e.g. #/services, #/host/<id>) so a
// refresh / back / forward keeps you where you were instead of resetting home.
function parseHash(): Route {
  const [name, hostId] = window.location.hash.replace(/^#\/?/, "").split("/");
  if ((ROUTE_NAMES as string[]).includes(name)) {
    return name === "host" && hostId ? { name: "host", hostId } : { name: name as RouteName };
  }
  return { name: "dashboard" };
}
function routeHash(r: Route): string {
  return `#/${r.name}${r.name === "host" && r.hostId ? `/${r.hostId}` : ""}`;
}

export function App() {
  const theme = useTheme();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [route, setRoute] = useState<Route>(() => parseHash());
  const [hosts, setHosts] = useState<ProxyHost[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  // Mobile drawer (no effect above the CSS breakpoint, where the sidebar is always shown).
  const [drawerOpen, setDrawerOpen] = useState(false);

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

  const reload = useCallback(async () => {
    // Don't let a transient backend hiccup throw an unhandled rejection that
    // leaves the UI on a stale/empty shell — fail soft and keep what we have.
    try {
      const [h, s] = await Promise.all([api.listHosts(), api.settings()]);
      setHosts(h);
      setSettings(s);
    } catch { /* keep previous state; individual pages surface their own errors */ }
  }, []);

  // Load app data once signed in.
  useEffect(() => {
    if (user) reload();
  }, [user, reload]);

  const navigate = useCallback((r: Route) => {
    window.location.hash = routeHash(r); // persists across refresh; hashchange syncs state too
    setRoute(r);
    setDrawerOpen(false); // close the mobile drawer after picking a destination
    window.scrollTo(0, 0);
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
      <Sidebar open={drawerOpen} hosts={hosts} route={route} navigate={navigate} theme={theme} user={user} onLogout={logout} />
      <div className="main">
        <Notifications />
        {route.name === "dashboard" && <Dashboard hosts={hosts} navigate={navigate} />}
        {route.name === "services" && <Services hosts={hosts} navigate={navigate} reload={reload} />}
        {route.name === "host" && route.hostId && <HostDetail hostId={route.hostId} navigate={navigate} reload={reload} />}
        {route.name === "wizard" && <Wizard settings={settings} navigate={navigate} reload={reload} />}
        {route.name === "settings" && <SettingsPage reload={reload} />}
        {route.name === "security" && <SecurityCenter />}
        {route.name === "useraccess" && <UsersAccess currentUser={user} refreshMe={refreshMe} />}
        {route.name === "certs" && <Certificates />}
        {route.name === "logs" && <Logs />}
        {route.name === "agents" && <AgentsApi />}
      </div>
    </div>
  );
}
