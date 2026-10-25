import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  shell,
  Tray,
  utilityProcess,
  type UtilityProcess,
} from "electron";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Storage } from "./storage";
import { syncSavedFlow } from "./flow-sync";
import {
  migrateFlow,
  parseFlowBundle,
  prepareFlowSave,
} from "../shared/flow-persistence";
import { setLinuxAutostart } from "./autostart";
import { validateFlow } from "../engine/validation";
import { nextRunAt } from "../engine/scheduler";
import {
  actionSchema,
  boundedJson,
  connectionSchema,
  flowSchema,
  flowSaveOptionsSchema,
  jsonSchema,
  scheduleSchema,
  settingsSchema,
  targetSchema,
  recordingStartSchema,
  recordingInsertSchema,
  recordedActionsSchema,
} from "../shared/validation";
import {
  recordingAnchor,
  recoverRecording,
  resolveRecordingAnchor,
} from "../shared/recording";
import { defaultCapabilities } from "../shared/seed";
import type {
  AIConnection,
  AppEvent,
  AppSettings,
  FlowDefinition,
  Json,
  PlatformCapabilities,
  RelayAPI,
  RunRecord,
  TargetDescriptor,
  RecordingInsertResult,
} from "../shared/types";
import type { RunnerInit, RunnerResponse, RunnerWorkspace } from "./protocol";

app.setName("Relay");
if (process.env.RELAY_DATA_DIR)
  app.setPath("userData", process.env.RELAY_DATA_DIR);
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: Storage;
let runner: UtilityProcess;
let runnerAlive = false;
let quitting = false;
let ready: Promise<unknown>;
let shortcutsAvailable = false;
let shortcutProblems: string[] = [];
let workspaceGeneration = 0;
const pending = new Map<
  string,
  {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }
>();
const dataDir = process.env.RELAY_DATA_DIR ?? app.getPath("userData");
const encryptedKeys = new Map<string, string>();
function rpc<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!runnerAlive) {
      reject(
        new Error(
          "The automation service is unavailable. Restart Relay to continue.",
        ),
      );
      return;
    }
    const id = randomUUID();
    const timer = setTimeout(
      () => {
        pending.delete(id);
        reject(
          new Error(
            "The automation service did not respond. Check permissions and try again.",
          ),
        );
      },
      method === "testDetector" ? 120000 : 45000,
    );
    pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
    runner.postMessage({ id, method, args });
  });
}
function broadcast(event: AppEvent) {
  if (win && !win.isDestroyed()) win.webContents.send("relay:event", event);
}
function keyFor(id: string): string | undefined {
  if (encryptedKeys.has(id)) return encryptedKeys.get(id);
  const encrypted = store.credential(id);
  if (!encrypted) return undefined;
  try {
    const key = safeStorage.decryptString(Buffer.from(encrypted, "base64"));
    encryptedKeys.set(id, key);
    return key;
  } catch {
    return undefined;
  }
}
function workspace(): RunnerWorkspace {
  const connections = store
    .list("connections")
    .map((c) => ({ ...c, hasKey: Boolean(store.credential(c.id)) }));
  return {
    generation: workspaceGeneration,
    flows: store.list("flows"),
    targets: store.list("targets"),
    schedules: store.list("schedules"),
    connections,
    settings: store.settings(),
    keys: Object.fromEntries(
      connections.flatMap((c) => {
        const key = keyFor(c.id);
        return key ? [[c.id, key]] : [];
      }),
    ),
  };
}
async function sync() {
  workspaceGeneration++;
  await rpc("sync", workspace());
  broadcast({ type: "workspace" });
}
async function capabilities(): Promise<PlatformCapabilities> {
  try {
    const value = await rpc<PlatformCapabilities>("capabilities");
    return {
      ...value,
      globalShortcuts: shortcutsAvailable,
      reasons: [...value.reasons, ...shortcutProblems],
    };
  } catch (error) {
    return {
      ...defaultCapabilities,
      platform: process.platform,
      session: process.env.XDG_SESSION_TYPE ?? process.platform,
      reasons: [String((error as Error).message)],
    };
  }
}
function registerShortcuts(
  settings: AppSettings = store.settings(),
  flows: FlowDefinition[] = store.list("flows"),
  strict = false,
) {
  globalShortcut.unregisterAll();
  shortcutProblems = [];
  const register = (
    accelerator: string,
    name: string,
    callback: () => void,
  ) => {
    let registered = false;
    try {
      registered = globalShortcut.register(accelerator, callback);
    } catch {
      /* reported below */
    }
    if (!registered)
      shortcutProblems.push(
        `${name} shortcut “${accelerator}” is invalid, already in use, or unavailable in this desktop session.`,
      );
    return registered;
  };
  shortcutsAvailable = register(settings.stopHotkey, "Stop", () => {
    void rpc("stopAll").catch(() => {});
  });
  register(settings.pauseHotkey, "Pause", () => {
    void rpc("pauseAll").catch(() => {});
  });
  for (const flow of flows)
    if (flow.hotkey)
      register(flow.hotkey, flow.name, () => {
        void rpc("trigger", flow.id, "hotkey").catch(() => {});
      });
  if (strict && shortcutProblems.length) {
    const message = shortcutProblems.join(" ");
    registerShortcuts();
    throw new Error(message);
  }
}
function assertNoRuns() {
  if (
    store
      .list("runs")
      .some((r) => ["running", "queued", "paused"].includes(r.status))
  )
    throw new Error(
      "Stop active workflows before changing execution settings.",
    );
}
async function importBundle(): Promise<FlowDefinition | null> {
  const choice = await dialog.showOpenDialog(win!, {
    title: "Import a Relay workflow",
    filters: [{ name: "Relay workflow", extensions: ["relay", "json"] }],
    properties: ["openFile"],
  });
  if (choice.canceled || !choice.filePaths[0]) return null;
  const raw = await readFile(choice.filePaths[0], "utf8");
  if (raw.length > 12_000_000)
    throw new Error("Workflow bundle exceeds 12 MB.");
  const { flows: parsed, targets, rootId } = parseFlowBundle(JSON.parse(raw));
  const mapping = new Map(
    parsed.map((f) => [f.id, store.get("flows", f.id) ? randomUUID() : f.id]),
  );
  const targetMap = new Map(
    targets.map((t) => [
      t.id,
      store.get("targets", t.id) ? randomUUID() : t.id,
    ]),
  );
  function remap(value: Json, key?: string): Json {
    if (typeof value === "string")
      return key === "flowId"
        ? (mapping.get(value) ?? value)
        : key === "targetId"
          ? (targetMap.get(value) ?? value)
          : value;
    if (Array.isArray(value))
      return value.map((item) =>
        remap(item, key === "flowIds" ? "flowId" : undefined),
      );
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, remap(v, k)]),
      );
    return value;
  }
  const flows = parsed.map((f) => ({
    ...f,
    id: mapping.get(f.id)!,
    name: mapping.get(f.id) !== f.id ? `${f.name} (imported)` : f.name,
    nodes: f.nodes.map((n) => ({
      ...n,
      config: remap(n.config) as Record<string, Json>,
    })),
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  store.transaction(() => {
    targets.forEach((t) =>
      store.put("targets", { ...t, id: targetMap.get(t.id)! }),
    );
    flows.forEach((f) => store.put("flows", f));
  });
  await sync();
  return flows.find((f) => f.id === mapping.get(rootId))!;
}
async function exportBundle(id: string): Promise<boolean> {
  const flows: FlowDefinition[] = [];
  const seen = new Set<string>();
  function visit(flowId: string) {
    if (seen.has(flowId)) return;
    seen.add(flowId);
    const flow = store.get("flows", flowId);
    if (!flow) throw new Error(`Referenced workflow ${flowId} is missing.`);
    flows.push(flow);
    for (const node of flow.nodes) {
      if (typeof node.config.flowId === "string") visit(node.config.flowId);
      if (Array.isArray(node.config.flowIds))
        node.config.flowIds.forEach((f) => visit(String(f)));
      if (Array.isArray(node.config.children))
        for (const child of node.config.children)
          if (
            child &&
            typeof child === "object" &&
            !Array.isArray(child) &&
            typeof child.flowId === "string"
          )
            visit(child.flowId);
    }
  }
  visit(id);
  const targetIds = new Set(
    flows.flatMap((f) => f.nodes.map((n) => n.config.targetId)),
  );
  const choice = await dialog.showSaveDialog(win!, {
    title: "Export workflow and dependencies",
    defaultPath: `${flows[0].name.replace(/[^\w -]/g, "")}.relay`,
    filters: [{ name: "Relay workflow", extensions: ["relay"] }],
  });
  if (choice.canceled || !choice.filePath) return false;
  await writeFile(
    choice.filePath,
    JSON.stringify(
      {
        format: "relay",
        version: 2,
        rootId: id,
        flows,
        targets: store.list("targets").filter((t) => targetIds.has(t.id)),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return true;
}

async function request(
  method: keyof RelayAPI,
  args: unknown[],
): Promise<unknown> {
  await ready;
  boundedJson(args);
  const id = () => z.string().min(1).max(200).parse(args[0]);
  switch (method) {
    case "bootstrap": {
      const state = workspace();
      return {
        ...state,
        keys: undefined,
        runs: store
          .list("runs")
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 500),
        capabilities: await capabilities(),
        recording: runnerAlive ? await rpc("recording") : store.recording(),
        desktop: true,
      };
    }
    case "saveFlow": {
      const flow = migrateFlow(args[0]);
      const options = flowSaveOptionsSchema.parse(args[1]);
      const previous = store.get("flows", flow.id);
      const preliminary = prepareFlowSave(
        flow,
        previous,
        options.expectedRevision,
      );
      if (preliminary.status === "conflict") return preliminary;
      if (
        flow.hotkey &&
        (flow.hotkey === store.settings().stopHotkey ||
          flow.hotkey === store.settings().pauseHotkey ||
          store
            .list("flows")
            .some((f) => f.id !== flow.id && f.hotkey === flow.hotkey))
      )
        throw new Error("That shortcut is already assigned.");
      if (flow.hotkey !== previous?.hotkey)
        registerShortcuts(
          store.settings(),
          [...store.list("flows").filter((f) => f.id !== flow.id), flow],
          true,
        );
      try {
        const result = store.saveFlow(flow, options);
        registerShortcuts();
        return await syncSavedFlow(result, sync);
      } catch (error) {
        registerShortcuts();
        throw error;
      }
    }
    case "deleteFlow": {
      const flowId = id();
      if (
        store
          .list("flows")
          .some(
            (f) =>
              f.id !== flowId &&
              f.nodes.some((n) =>
                JSON.stringify(n.config).includes(`"${flowId}"`),
              ),
          )
      )
        throw new Error(
          "Another workflow calls this workflow. Remove that reference first.",
        );
      store.delete("flows", flowId);
      store
        .list("schedules")
        .filter((s) => s.flowId === flowId)
        .forEach((s) => store.delete("schedules", s.id));
      registerShortcuts();
      await sync();
      return;
    }
    case "validateFlow":
      return validateFlow(flowSchema.parse(args[0]), store.list("flows"), {
        targets: store.list("targets"),
        connections: store.list("connections"),
        settings: store.settings(),
      });
    case "runFlow": {
      // A prior save may have committed while the runner was unavailable.
      await sync();
      return rpc(
        "runFlow",
        id(),
        z.record(z.string(), jsonSchema).parse(args[1] ?? {}),
      );
    }
    case "controlRun":
      return rpc(
        "controlRun",
        id(),
        z.enum(["pause", "resume", "step", "stop"]).parse(args[1]),
      );
    case "saveSettings": {
      const settings = settingsSchema.parse(args[0]);
      const previous = store.settings();
      if (settings.stopHotkey === settings.pauseHotkey)
        throw new Error("Pause and Stop need different shortcuts.");
      assertNoRuns();
      if (
        settings.stopHotkey !== previous.stopHotkey ||
        settings.pauseHotkey !== previous.pauseHotkey
      )
        registerShortcuts(settings, store.list("flows"), true);
      try {
        if (settings.launchAtLogin !== previous.launchAtLogin) {
          if (process.platform === "linux")
            await setLinuxAutostart(
              app.getPath("appData"),
              settings.launchAtLogin,
              process.execPath,
              app.isPackaged ? undefined : app.getAppPath(),
            );
          else
            app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
        }
        store.setMeta("settings", settings);
      } catch (error) {
        registerShortcuts();
        throw error;
      }
      registerShortcuts();
      store.pruneHistory(settings.historyRetentionDays);
      await sync();
      return settings;
    }
    case "saveConnection": {
      const connection = connectionSchema.parse(args[0]);
      const previous = store.get("connections", connection.id);
      const providerChanged =
        previous && previous.provider !== connection.provider;
      const key =
        args[1] === undefined ? undefined : z.string().max(8192).parse(args[1]);
      if (key?.trim()) {
        if (
          !safeStorage.isEncryptionAvailable() ||
          (process.platform === "linux" &&
            safeStorage.getSelectedStorageBackend() === "basic_text")
        )
          throw new Error(
            "An OS keyring is required to save API keys. Unlock or install Secret Service/KWallet, then restart Relay.",
          );
        store.setCredential(
          connection.id,
          safeStorage.encryptString(key.trim()).toString("base64"),
        );
        encryptedKeys.set(connection.id, key.trim());
      } else if (providerChanged) {
        store.deleteCredential(connection.id);
        encryptedKeys.delete(connection.id);
      }
      const result = store.put("connections", {
        ...connection,
        lastTest: providerChanged ? undefined : connection.lastTest,
        hasKey: Boolean(store.credential(connection.id)),
      });
      await sync();
      return result;
    }
    case "deleteConnection": {
      const key = id();
      store.delete("connections", key);
      store.deleteCredential(key);
      encryptedKeys.delete(key);
      await sync();
      return;
    }
    case "testConnection": {
      const key = id();
      const result = await rpc<{ ok: boolean; message: string }>(
        "testConnection",
        key,
      );
      const connection = store.get("connections", key);
      if (connection)
        store.put("connections", {
          ...connection,
          lastTest: { ...result, at: new Date().toISOString() },
        });
      await sync();
      return result;
    }
    case "saveTarget": {
      const target = targetSchema.parse(args[0]);
      const result = store.put("targets", target);
      await sync();
      return result;
    }
    case "deleteTarget": {
      store.delete("targets", id());
      await sync();
      return;
    }
    case "saveSchedule": {
      const schedule = scheduleSchema.parse(args[0]);
      if (!store.get("flows", schedule.flowId))
        throw new Error("Choose an existing workflow.");
      const next = nextRunAt(schedule, new Date());
      if (schedule.enabled && !next)
        throw new Error("Choose a future date and time for this schedule.");
      const result = store.put("schedules", {
        ...schedule,
        nextRunAt: next?.toISOString(),
      });
      await sync();
      return result;
    }
    case "deleteSchedule": {
      store.delete("schedules", id());
      await sync();
      return;
    }
    case "getCapabilities":
      return capabilities();
    case "browserBridge":
      return rpc("browserBridge");
    case "capture":
      return rpc("capture", id());
    case "testDetector":
      return rpc(
        "testDetector",
        z.record(z.string(), jsonSchema).parse(args[0]),
      );
    case "startRecording": {
      const options = recordingStartSchema.parse(args[0]);
      const flow = store.get("flows", options.flowId);
      if (!flow || flow.revision !== options.flowRevision)
        throw new Error(
          "Save and reload the workflow before starting a recording.",
        );
      if (
        options.anchorNodeId &&
        recordingAnchor(flow, options.anchorNodeId) !== options.anchorNodeId
      )
        throw new Error(
          "Select a free next port before starting, or record into a new workflow.",
        );
      if (options.anchor) resolveRecordingAnchor(flow, options.anchor);
      return rpc("startRecording", options);
    }
    case "recordAction":
      return rpc(
        "recordAction",
        id(),
        actionSchema.parse(args[1]),
        z.boolean().parse(args[2]),
      );
    case "pauseRecording":
    case "resumeRecording":
    case "stopRecording":
      return rpc(method, id());
    case "setRecordingTarget":
      return rpc(method, id(), z.string().min(1).max(200).parse(args[1]));
    case "updateRecording":
      return rpc(
        method,
        id(),
        z.number().int().positive().parse(args[1]),
        recordedActionsSchema.parse(args[2]),
      );
    case "discardRecording":
      return rpc(method, id(), z.number().int().positive().parse(args[1]));
    case "insertRecording": {
      const result = await rpc<RecordingInsertResult>(
        method,
        id(),
        z.number().int().positive().parse(args[1]),
        recordingInsertSchema.parse(args[2]),
      );
      try {
        await sync();
      } catch {
        result.warning =
          "The recording was inserted, but the automation service could not refresh. Restart Relay before running the workflow.";
      }
      return result;
    }
    case "importFlow":
      return importBundle();
    case "exportFlow":
      return exportBundle(id());
    case "openExternal": {
      const url = new URL(z.string().parse(args[0]));
      if (!["https:", "http:"].includes(url.protocol))
        throw new Error("Only web links can be opened.");
      await shell.openExternal(url.toString());
      return;
    }
    default:
      throw new Error("Unknown application command.");
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: "#14151A",
    title: "Relay",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== win?.webContents.getURL()) event.preventDefault();
  });
  if (process.env.RELAY_DEV_URL) void win.loadURL(process.env.RELAY_DEV_URL);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
  win.on("close", (event) => {
    if (
      !quitting &&
      tray &&
      store.settings().minimizeToTray &&
      !process.env.RELAY_TEST_MODE
    ) {
      event.preventDefault();
      win?.hide();
    }
  });
  win.on("closed", () => {
    win = null;
  });
}
if (!app.requestSingleInstanceLock() && !process.env.RELAY_TEST_MODE)
  app.quit();
else {
  app.on("second-instance", () => {
    win?.show();
    win?.focus();
  });
  void app
    .whenReady()
    .then(async () => {
      store = new Storage(join(dataDir, "relay.sqlite"));
      setInterval(
        () => store.pruneHistory(store.settings().historyRetentionDays),
        3600000,
      ).unref();
      runner = utilityProcess.fork(join(__dirname, "runner.cjs"), [], {
        serviceName: "Relay automation",
        stdio: "pipe",
      });
      runnerAlive = true;
      runner.on("message", (message: RunnerResponse) => {
        if ("recordingRequest" in message) {
          const request = message.recordingRequest;
          try {
            const result =
              request.operation === "save"
                ? store.saveRecording(request.state)
                : store.insertRecording(
                    request.state,
                    recordingInsertSchema.parse(request.options),
                  );
            runner.postMessage({
              id: request.id,
              method: "recordingStoreResult",
              args: [{ result }],
            });
          } catch (error) {
            runner.postMessage({
              id: request.id,
              method: "recordingStoreResult",
              args: [
                {
                  error: error instanceof Error ? error.message : String(error),
                },
              ],
            });
          }
        } else if ("id" in message) {
          const item = pending.get(message.id);
          if (!item) return;
          clearTimeout(item.timer);
          pending.delete(message.id);
          if (message.error) item.reject(new Error(message.error));
          else item.resolve(message.result);
        } else if ("event" in message) {
          if (message.event.type === "run")
            store.put("runs", message.event.run);
          broadcast(message.event);
        } else if (
          "scheduleUpdates" in message &&
          message.generation === workspaceGeneration
        ) {
          for (const cursor of message.scheduleUpdates) {
            const saved = store.get("schedules", cursor.id);
            if (saved) store.put("schedules", { ...saved, ...cursor });
          }
          broadcast({ type: "workspace" });
        }
      });
      runner.on("exit", () => {
        runnerAlive = false;
        for (const p of pending.values()) {
          clearTimeout(p.timer);
          p.reject(
            new Error(
              "The automation service stopped. Restart Relay to continue.",
            ),
          );
        }
        pending.clear();
        let recoveryFailed = false;
        try {
          const draft = store.recording();
          if (draft.phase !== "idle") {
            const recording = store.saveRecording(recoverRecording(draft));
            broadcast({ type: "recording", recording });
          }
        } catch {
          // Disk errors or an already-closed database must not escape the exit
          // callback or publish an unsaved recovery state as if it were durable.
          recoveryFailed = true;
        }
        try {
          for (const run of store.list("runs"))
            if (["queued", "running", "paused"].includes(run.status)) {
              const interrupted: RunRecord = {
                ...run,
                status: "interrupted",
                error: "Automation service stopped.",
                finishedAt: new Date().toISOString(),
              };
              store.put("runs", interrupted);
              broadcast({ type: "run", run: interrupted });
            }
        } catch {
          recoveryFailed = true;
        }
        if (recoveryFailed && !quitting) {
          const message =
            "The automation service stopped, but Relay could not save its recovery status. The last saved draft and history remain on disk. Restart Relay to recover them.";
          if (process.env.RELAY_TEST_MODE) console.error(message);
          else
            dialog.showErrorBox("Recovery status could not be saved", message);
        }
      });
      runner.stderr?.on("data", (data) => {
        if (process.env.RELAY_TEST_MODE) process.stderr.write(data);
      });
      const binaryPath = app.isPackaged
        ? join(
            process.resourcesPath,
            "native",
            process.platform === "win32" ? "relay-native.exe" : "relay-native",
          )
        : join(
            app.getAppPath(),
            "native/target/release",
            process.platform === "win32" ? "relay-native.exe" : "relay-native",
          );
      ready = rpc("init", {
        dataDir,
        binaryPath,
        workspace: workspace(),
        recording: store.recording(),
      } satisfies RunnerInit);
      ready.catch((error) => {
        if (process.env.RELAY_TEST_MODE) {
          console.error("Automation service failed:", error);
          return;
        }
        void dialog.showErrorBox(
          "Automation service failed",
          String(error.message),
        );
      });
      ipcMain.handle(
        "relay:request",
        async (event, method: keyof RelayAPI, args: unknown[]) => {
          if (
            !win ||
            event.sender !== win.webContents ||
            event.senderFrame !== win.webContents.mainFrame
          )
            throw new Error("Untrusted request.");
          return request(method, args);
        },
      );
      registerShortcuts();
      createWindow();
      if (!process.env.RELAY_TEST_MODE) {
        const icon = nativeImage
          .createFromDataURL(
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
          )
          .resize({ width: 20, height: 20 });
        try {
          tray = new Tray(icon);
          tray.setToolTip("Relay — Desktop automation");
          tray.setContextMenu(
            Menu.buildFromTemplate([
              { label: "Open Relay", click: () => win?.show() },
              {
                label: "Stop all workflows",
                click: () => {
                  void rpc("stopAll").catch(() => {});
                },
              },
              { type: "separator" },
              { label: "Quit Relay", click: () => app.quit() },
            ]),
          );
          tray.on("click", () => win?.show());
        } catch {
          tray = null;
        }
      }
      app.on("activate", () => {
        if (!win) createWindow();
        else win.show();
      });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (process.env.RELAY_TEST_MODE) console.error(message);
      else dialog.showErrorBox("Relay could not open this workspace", message);
      // Do not reset an incompatible or damaged database to make startup succeed.
      quitting = true;
      runner?.kill();
      store?.close();
      app.exit(1);
    });
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    globalShortcut.unregisterAll();
    if (!runner) {
      app.quit();
      return;
    }
    void rpc("dispose")
      .catch(() => {})
      .finally(() => {
        runner.kill();
        tray?.destroy();
        app.quit();
      });
  });
  app.on("window-all-closed", () => {
    if (!tray) app.quit();
  });
}
