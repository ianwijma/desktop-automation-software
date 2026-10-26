const { app, BrowserWindow, ipcMain, screen } = require("electron");
const { createServer } = require("node:http");
const { readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const config = JSON.parse(readFileSync(process.argv.at(-1), "utf8"));
setTimeout(() => app.quit(), 600000).unref();
let window,
  duplicate,
  state = {},
  server;
app.setPath("userData", config.profile);
ipcMain.on("fixture-state", (event, value) => {
  if (event.sender === window?.webContents) state = value;
});
const createWindow = () =>
  new BrowserWindow({
    title: config.title,
    x: config.position?.x ?? 80,
    y: config.position?.y ?? 80,
    width: 700,
    height: 560,
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
      backgroundThrottling: false,
    },
  });
app.whenReady().then(async () => {
  window = createWindow();
  await window.loadFile(path.join(__dirname, "index.html"));
  window.setTitle(config.title);
  window.focus();
  server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${config.token}`) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/state") {
      res.end(
        JSON.stringify({
          ...state,
          bounds: window.getBounds(),
          contentBounds:
            process.platform === "win32"
              ? screen.dipToScreenRect(window, window.getContentBounds())
              : window.getContentBounds(),
          focused: window.isFocused(),
          minimized: window.isMinimized(),
          duplicate: Boolean(duplicate && !duplicate.isDestroyed()),
          displays: screen
            .getAllDisplays()
            .map(({ bounds, scaleFactor }) => ({ bounds, scaleFactor })),
          versions: {
            electron: process.versions.electron,
            chrome: process.versions.chrome,
          },
        }),
      );
    } else if (req.method === "POST" && req.url === "/minimize") {
      window.minimize();
      res.end("{}");
    } else if (req.method === "POST" && req.url === "/restore") {
      window.restore();
      window.focus();
      res.end("{}");
    } else if (req.method === "POST" && req.url === "/resize") {
      window.setSize(740, 580);
      res.end("{}");
    } else if (req.method === "POST" && req.url === "/duplicate") {
      duplicate = createWindow();
      duplicate.setPosition(120, 120);
      duplicate
        .loadFile(path.join(__dirname, "index.html"))
        .then(() => {
          duplicate?.setTitle(config.title);
          res.end("{}");
        })
        .catch(() => res.writeHead(500).end("{}"));
    } else if (req.method === "POST" && req.url === "/close-duplicate") {
      duplicate?.destroy();
      duplicate = undefined;
      window.focus();
      res.end("{}");
    } else if (req.method === "POST" && req.url === "/quit") {
      res.end("{}");
      setImmediate(() => app.quit());
    } else res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1", () =>
    writeFileSync(
      config.controlFile,
      JSON.stringify({ port: server.address().port }),
    ),
  );
});
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => server?.close());
