const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("fixture", {
  report: (value) => ipcRenderer.send("fixture-state", value),
});
