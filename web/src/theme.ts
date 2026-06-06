import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "less-dark" | "medium" | "less-light" | "light";
const ORDER: Theme[] = ["dark", "less-dark", "medium", "less-light", "light"];
const KEY = "nginux-theme";

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem(KEY) as Theme) || "dark",
  );

  useEffect(() => {
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
