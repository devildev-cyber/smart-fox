// Electron main process for the Interview Coach desktop overlay.
// Wraps the existing Next.js app in an always-on-top floating window with
// global hotkeys and system-audio capture, so it can sit on top of a live
// Zoom/Meet/Teams call.
const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  session,
  desktopCapturer,
} = require("electron");
const path = require("path");
const net = require("net");
const fs = require("fs");
const { spawn, fork } = require("child_process");

// Optional: present only in packaged builds. Guarded so dev/source runs don't
// fail if it isn't installed.
let autoUpdater = null;
try {
  ({ autoUpdater } = require("electron-updater"));
} catch {
  autoUpdater = null;
}

const isDev = process.env.ELECTRON_DEV === "1";
const PORT = Number(process.env.PORT || 3000);
const APP_URL = `http://localhost:${PORT}/session`;

/** @type {import("electron").BrowserWindow | null} */
let mainWindow = null;
/** @type {import("child_process").ChildProcess | null} */
let serverProcess = null;
let pinned = true;

function waitForPort(port, host = "127.0.0.1", timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const attempt = () => {
      const socket = net.connect(port, host);
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timed out waiting for http://${host}:${port}`));
        } else {
          setTimeout(attempt, 400);
        }
      });
    };
    attempt();
  });
}

// In a packaged build the SQLite file must live somewhere writable (the app
// directory is read-only). Seed it from the bundled template on first launch.
function resolvePackagedDatabaseUrl() {
  const userDb = path.join(app.getPath("userData"), "interview-coach.db");
  if (!fs.existsSync(userDb)) {
    const seed = path.join(process.resourcesPath, "seed.db");
    if (fs.existsSync(seed)) fs.copyFileSync(seed, userDb);
  }
  return `file:${userDb}`;
}

async function ensureServer() {
  // 1. Dev: the Next dev server is started separately (npm run electron:dev).
  if (isDev) {
    await waitForPort(PORT);
    return;
  }

  // 2. Packaged installer: run the bundled standalone server with Electron's
  //    own Node (no npm/node_modules on the user's machine).
  if (app.isPackaged) {
    const serverJs = path.join(process.resourcesPath, "app", "server.js");
    serverProcess = fork(serverJs, [], {
      cwd: path.join(process.resourcesPath, "app"),
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(PORT),
        HOSTNAME: "127.0.0.1",
        DATABASE_URL: resolvePackagedDatabaseUrl(),
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: "inherit",
    });
    await waitForPort(PORT);
    return;
  }

  // 3. Unpackaged production (npm run electron:start) - run from source.
  const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
  serverProcess = spawn(cmd, ["run", "start"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(PORT) },
    stdio: "inherit",
  });
  await waitForPort(PORT);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 760,
    minWidth: 360,
    minHeight: 480,
    frame: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: "#0b0b0f",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, "screen-saver");
  if (process.platform !== "win32") {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  // Auto-grant getDisplayMedia so capturing the meeting / system audio does not
  // prompt a picker every time. Falls back gracefully to mic-only if loopback
  // audio is unsupported on the platform.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => {
          callback({ video: sources[0], audio: "loopback" });
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false }
  );

  mainWindow.loadURL(APP_URL);
  mainWindow.once("ready-to-show", () => mainWindow?.show());
}

function registerShortcuts() {
  // Generate an answer from anywhere, even when the call window is focused.
  globalShortcut.register("CommandOrControl+Shift+Enter", () => {
    mainWindow?.webContents.send("global-generate");
  });

  // Show / hide the overlay quickly.
  globalShortcut.register("CommandOrControl+Shift+Backslash", () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else mainWindow.show();
  });
}

ipcMain.on("win:minimize", () => mainWindow?.minimize());
ipcMain.on("win:close", () => mainWindow?.close());
ipcMain.handle("win:toggle-pin", () => {
  pinned = !pinned;
  mainWindow?.setAlwaysOnTop(pinned, "screen-saver");
  return pinned;
});

/* --------------------- Windows Live Captions bridge --------------------- */
// Reads the on-device Live Captions text via a PowerShell + UI Automation
// sidecar and streams new caption strings to the renderer.
/** @type {import("child_process").ChildProcess | null} */
let captionProc = null;

function stopCaptions() {
  if (captionProc && !captionProc.killed) captionProc.kill();
  captionProc = null;
}

ipcMain.on("livecaptions:start", (event) => {
  if (process.platform !== "win32") {
    event.sender.send("live-caption-error", "Live Captions capture is Windows-only.");
    return;
  }
  if (captionProc) return;

  // The script is read by an external process (powershell.exe), which cannot
  // see inside app.asar — resolve to the unpacked copy.
  const script = path
    .join(__dirname, "livecaptions.ps1")
    .replace("app.asar", "app.asar.unpacked");
  captionProc = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
    { windowsHide: true }
  );

  let buffer = "";
  captionProc.stdout?.on("data", (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj.text === "string") {
          event.sender.send("live-caption-text", obj.text);
        }
      } catch {
        // Ignore non-JSON noise.
      }
    }
  });
  captionProc.stderr?.on("data", (d) => console.error("[livecaptions]", d.toString()));
  captionProc.on("error", (err) => {
    event.sender.send("live-caption-error", err.message);
    captionProc = null;
  });
  captionProc.on("exit", () => {
    captionProc = null;
  });
});

ipcMain.on("livecaptions:stop", () => stopCaptions());

app.whenReady().then(async () => {
  try {
    await ensureServer();
  } catch (err) {
    console.error(err);
  }
  createWindow();
  registerShortcuts();

  // Check GitHub Releases for a newer version and install it in the background.
  if (app.isPackaged && autoUpdater) {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error("[updater]", err);
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  stopCaptions();
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});
