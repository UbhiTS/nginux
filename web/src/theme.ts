import { useCallback, useEffect, useLayoutEffect, useState } from "react";

export type Theme = "dark" | "less-dark" | "medium" | "less-light" | "light";
const ORDER: Theme[] = ["dark", "less-dark", "medium", "less-light", "light"];
const KEY = "nginux-theme";

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem(KEY) as Theme) || "dark",
  );

  // useLayoutEffect (not useEffect) so data-theme is applied synchronously before
  // the browser paints — this removes the one-frame flash of the default (dark) theme
  // that non-dark users saw on every mount. (A full pre-hydration fix would need an
  // inline <head> script, which the CSP blocks — deferred.)
  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(KEY, theme);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => setThemeState(t), []);
  const cycleTheme = useCallback(
    () => setThemeState((t) => ORDER[(ORDER.indexOf(t) + 1) % ORDER.length]),
    [],
  );

  return { theme, setTheme, cycleTheme };
}
