const { contextBridge, ipcRenderer } = require("electron");

// Minimal, safe bridge exposed to the renderer (the Next.js app).
contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  platform: process.platform,
  minimize: () => ipcRenderer.send("win:minimize"),
  close: () => ipcRenderer.send("win:close"),
  togglePin: () => ipcRenderer.invoke("win:toggle-pin"),
  cycleOpacity: () => ipcRenderer.invoke("win:cycle-opacity"),
  // Subscribe to the global "generate" hotkey. Returns an unsubscribe fn.
  onGenerate: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("global-generate", handler);
    return () => ipcRenderer.removeListener("global-generate", handler);
  },
  // Windows Live Captions bridge.
  liveCaptions: {
    start: () => ipcRenderer.send("livecaptions:start"),
    stop: () => ipcRenderer.send("livecaptions:stop"),
    onText: (callback) => {
      const handler = (_e, text) => callback(text);
      ipcRenderer.on("live-caption-text", handler);
      return () => ipcRenderer.removeListener("live-caption-text", handler);
    },
    onError: (callback) => {
      const handler = (_e, message) => callback(message);
      ipcRenderer.on("live-caption-error", handler);
      return () => ipcRenderer.removeListener("live-caption-error", handler);
    },
  },
});
