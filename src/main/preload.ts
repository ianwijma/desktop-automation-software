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
  "requestFlowProposal",
  "cancelFlowProposal",
  "importAuthoringImage",
  "captureAuthoringImage",
  "listAuthoringImages",
  "previewAuthoringImage",
  "reuseAuthoringImage",
  "deleteAuthoringImage",
  "closeAuthoringSession",
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
// Binary imports never enter the generic JSON request path.
let imageUploads = 0;
api.importAuthoringImage = async (
  upload: import("../shared/chat-attachments").AttachmentUpload,
) => {
  if (
    !(upload?.bytes instanceof Uint8Array) ||
    !upload.bytes.byteLength ||
    upload.bytes.byteLength > 8 * 1024 * 1024
  )
    return Promise.reject(
      new Error("Images must be binary data of at most 8 MiB."),
    );
  if (imageUploads >= 2)
    throw new Error(
      "Image preparation is busy. Wait for the current import to finish.",
    );
  imageUploads++;
  try {
    return await ipcRenderer.invoke("relay:request", "importAuthoringImage", [
      upload,
    ]);
  } finally {
    imageUploads--;
  }
};
contextBridge.exposeInMainWorld("relay", Object.freeze(api));
