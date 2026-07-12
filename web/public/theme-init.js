// Applies the persisted theme before first paint, so light/medium users don't see a
// flash of the default dark theme while the React bundle loads and mounts. Kept as a
// separate same-origin file (not inline) because the app's CSP is `script-src 'self'`
// with no 'unsafe-inline'. Render-blocking by design (no defer) — it must run before
// the body paints. Mirrors the storage key + values in web/src/theme.ts.
(function () {
  try {
    var t = localStorage.getItem("nginux-theme");
    if (t && ["dark", "less-dark", "medium", "less-light", "light"].indexOf(t) !== -1) {
      document.documentElement.setAttribute("data-theme", t);
    }
  } catch (e) {
    /* localStorage blocked (private mode / disabled) — keep the default dark theme */
  }
})();
