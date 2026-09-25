import { contextBridge, ipcRenderer } from "electron";
import type { DesktopSnapshot, UiConfig } from "../core/types";
import type { SerialPortInfo } from "../main/services/device";
import type { PackOption } from "../main/pack-library";

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
  listPacks: (): Promise<PackOption[]> => ipcRenderer.invoke("agentling:pack:list"),
  addPack: (): Promise<PackOption | null> => ipcRenderer.invoke("agentling:pack:add"),
  applyPack: (directory: string): Promise<DesktopSnapshot["pack"]> => ipcRenderer.invoke("agentling:pack:apply", directory),
  saveUi: (ui: UiConfig) => ipcRenderer.invoke("agentling:pack:save-ui", ui),
  syncPack: () => ipcRenderer.invoke("agentling:pack:sync"),
  getPackAsset: (relativePath: string): Promise<string | null> => ipcRenderer.invoke("agentling:pack:asset", relativePath),
  refreshUsage: () => ipcRenderer.invoke("agentling:usage:refresh"),
  selectTask: (id: string) => ipcRenderer.invoke("agentling:task:select", id),
  showExpression: (value: { scene: string; text?: string; ttlMs: number }) =>
    ipcRenderer.invoke("agentling:expression:show", value),
  clearExpression: () => ipcRenderer.invoke("agentling:expression:clear"),
};

contextBridge.exposeInMainWorld("agentling", api);

export type AgentlingPreloadApi = typeof api;
