import { useCallback, useEffect, useState } from "react";
import { api, type AuthUser } from "./api.ts";
import type { ProxyHost, Settings } from "./types.ts";
import { useTheme } from "./theme.ts";
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

  // Check session on load.
  useEffect(() => {
    api.me().then(setUser).catch(() => setUser(null)).finally(() => setAuthChecked(true));
  }, []);

  const reload = useCallback(async () => {
    const [h, s] = await Promise.all([api.listHosts(), api.settings()]);
    setHosts(h);
    setSettings(s);
  }, []);

  // Load app data once signed in.
  useEffect(() => {
    if (user) reload();
  }, [user, reload]);

  const navigate = useCallback((r: Route) => {
    setRoute(r);
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

  if (!authChecked) return null;
  if (!user) return <Login onSignedIn={setUser} />;
  if (user.mustChangePassword) return <ChangePassword user={user} onChanged={setUser} />;

  return (
    <div className="app">
      <Sidebar hosts={hosts} route={route} navigate={navigate} theme={theme} user={user} onLogout={logout} />
      <div className="main">
        {route.name === "dashboard" && <Dashboard hosts={hosts} navigate={navigate} />}
        {route.name === "services" && <Services hosts={hosts} navigate={navigate} reload={reload} />}
        {route.name === "host" && route.hostId && <HostDetail hostId={route.hostId} navigate={navigate} reload={reload} />}
        {route.name === "wizard" && <Wizard settings={settings} navigate={navigate} reload={reload} />}
        {route.name === "settings" && <SettingsPage theme={theme} reload={reload} />}
        {route.name === "security" && <SecurityCenter />}
        {route.name === "useraccess" && <UsersAccess currentUser={user} refreshMe={refreshMe} />}
        {route.name === "certs" && <Certificates />}
        {route.name === "logs" && <Logs />}
        {route.name === "agents" && <AgentsApi />}
      </div>
    </div>
  );
}
