import { useCallback, useEffect, useState } from "react";
import { api, type AuthUser } from "./api.ts";
import type { ProxyHost, Settings } from "./types.ts";
import { useTheme } from "./theme.ts";
import { Icon } from "./icons.tsx";
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

export function App() {
  const theme = useTheme();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [route, setRoute] = useState<Route>({ name: "dashboard" });
  const [hosts, setHosts] = useState<ProxyHost[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  // Mobile drawer (no effect above the CSS breakpoint, where the sidebar is always shown).
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Check session on load.
  useEffect(() => {
    api.me().then(setUser).catch(() => setUser(null)).finally(() => setAuthChecked(true));
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
    setRoute(r);
    setDrawerOpen(false); // close the mobile drawer after picking a destination
    window.scrollTo(0, 0);
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
    setRoute({ name: "dashboard" });
  }, []);

  const refreshMe = useCallback(async () => {
    setUser(await api.me());
  }, []);

  if (!authChecked) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100vh", gap: 14, color: "var(--text-dim)" }}>
        <img src="/favicon.svg" alt="" width={44} height={44} style={{ borderRadius: 10 }} />
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
