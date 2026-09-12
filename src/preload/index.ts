import { contextBridge, ipcRenderer } from "electron";
import type { DesktopSnapshot, UiConfig } from "../core/types";
import type { SerialPortInfo } from "../main/services/device";

const api = {
  getSnapshot: (): Promise<DesktopSnapshot> => ipcRenderer.invoke("agentling:snapshot:get"),
  onSnapshot: (handler: (snapshot: DesktopSnapshot) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: DesktopSnapshot) => handler(snapshot);
    ipcRenderer.on("agentling:snapshot", listener);
    return () => ipcRenderer.off("agentling:snapshot", listener);
  },
  listPorts: (): Promise<SerialPortInfo[]> => ipcRenderer.invoke("agentling:ports:list"),
  connectDevice: (portPath: string) => ipcRenderer.invoke("agentling:device:connect", portPath),
  disconnectDevice: () => ipcRenderer.invoke("agentling:device:disconnect"),
  openPack: () => ipcRenderer.invoke("agentling:pack:open"),
  saveUi: (ui: UiConfig) => ipcRenderer.invoke("agentling:pack:save-ui", ui),
  syncPack: () => ipcRenderer.invoke("agentling:pack:sync"),
  refreshUsage: () => ipcRenderer.invoke("agentling:usage:refresh"),
  showExpression: (value: { scene: string; text?: string; ttlMs: number }) =>
    ipcRenderer.invoke("agentling:expression:show", value),
  clearExpression: () => ipcRenderer.invoke("agentling:expression:clear"),
};

contextBridge.exposeInMainWorld("agentling", api);

export type AgentlingPreloadApi = typeof api;
