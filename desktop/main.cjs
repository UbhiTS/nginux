// NginUX desktop shell (phase 1).
//
// Electron wraps the existing control plane: it spawns the Node server (which
// serves the REST/MCP API *and* the built React UI on 127.0.0.1:4600), waits for
// it to come up, then shows that UI in a window. State lives under the OS's
// per-user app-data dir. The nginx data plane (actual proxying) is phase 2 - the
// control plane runs fine without it (config generation degrades gracefully).
const { app, BrowserWindow, shell, dialog, Menu } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");

const PORT = 4600;
let serverProc = null;
let win = null;

// In a packaged app the payload (server + web/dist + node_modules) and the Node
// runtime are unpacked under resourcesPath; in `electron .` dev they're the repo.
const packaged = app.isPackaged;
const payloadDir = packaged ? path.join(process.resourcesPath, "payload") : path.join(__dirname, "..");
const nodeBin = packaged
  ? path.join(process.resourcesPath, "runtime", process.platform === "win32" ? "node.exe" : "node")
  : process.execPath;

const dataDir = path.join(app.getPath("userData"), "data");

function startServer() {
  fs.mkdirSync(dataDir, { recursive: true });
  const entry = path.join(payloadDir, "server", "src", "index.ts");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(PORT),
    HOST: "127.0.0.1", // desktop UI is local-only; never bind the control plane wide
    NGINUX_DATA_DIR: dataDir,
    NGINX_CONF_DIR: path.join(dataDir, "nginx", "conf.d"),
    NGINX_STREAM_DIR: path.join(dataDir, "nginx", "stream.d"),
    NGINX_BANNED_FILE: path.join(dataDir, "nginx", "banned.conf"),
    NGINX_ACCESS_LOG: path.join(dataDir, "logs", "access.log"),
    NGINX_DEFAULT_CERT: path.join(dataDir, "nginx", "selfsigned.crt"),
    NGINX_DEFAULT_KEY: path.join(dataDir, "nginx", "selfsigned.key"),
    CERT_DIR: path.join(dataDir, "certs"),
  };
  serverProc = spawn(nodeBin, ["--experimental-sqlite", "--disable-warning=ExperimentalWarning", entry], {
    cwd: payloadDir,
    env,
    stdio: "inherit",
  });
  serverProc.on("exit", () => { serverProc = null; });
  serverProc.on("error", (e) => dialog.showErrorBox("NginUX", `Couldn't start the control plane:\n${e.message}`));
}

function waitForServer(cb, tries = 0) {
  const req = http.get({ host: "127.0.0.1", port: PORT, path: "/api/health", timeout: 1000 }, (res) => {
    res.resume();
    cb(null);
  });
  req.on("error", () => {
    if (tries > 80) return cb(new Error("control plane did not become ready"));
    setTimeout(() => waitForServer(cb, tries + 1), 500);
  });
  req.on("timeout", () => req.destroy());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    title: "NginUX",
    backgroundColor: "#0b0f17",
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.once("ready-to-show", () => win.show());
  win.loadURL(`http://127.0.0.1:${PORT}/`);
  // External links open in the real browser, not inside the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  startServer();
  waitForServer((err) => {
    if (err) dialog.showErrorBox("NginUX", "The control plane didn't start. See logs in the terminal.");
    createWindow();
  });
});

app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { if (serverProc) { try { serverProc.kill(); } catch { /* already gone */ } } });
