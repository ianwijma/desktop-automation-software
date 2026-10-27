import { contextBridge, ipcRenderer } from "electron";
import type { AppEvent, RelayAPI } from "../shared/types";
const methods: (keyof Omit<RelayAPI, "onEvent">)[] = [
  "bootstrap",
  "saveFlow",
  "deleteFlow",
  "validateFlow",
  "runFlow",
  "controlRun",
  "saveSettings",
  "saveConnection",
  "deleteConnection",
  "testConnection",
  "cancelAIDiagnostic",
  "searchOpenRouterModels",
  "exportConnectionDiagnostics",
  "saveTarget",
  "deleteTarget",
  "saveSchedule",
  "deleteSchedule",
  "getCapabilities",
  "browserBridge",
  "capture",
  "testDetector",
  "inspectBrowserLocator",
  "inspectNativeLocator",
  "startRecording",
  "recordAction",
  "stopRecording",
  "pauseRecording",
  "resumeRecording",
  "setRecordingTarget",
  "updateRecording",
  "discardRecording",
  "insertRecording",
  "importFlow",
  "exportFlow",
  "openExternal",
];
const api: Record<string, unknown> = Object.fromEntries(
  methods.map((method) => [
    method,
    (...args: unknown[]) => ipcRenderer.invoke("relay:request", method, args),
  ]),
);
api.onEvent = (listener: (event: AppEvent) => void) => {
  const receive = (_: unknown, event: AppEvent) => listener(event);
  ipcRenderer.on("relay:event", receive);
  return () => ipcRenderer.removeListener("relay:event", receive);
};
contextBridge.exposeInMainWorld("relay", Object.freeze(api));
