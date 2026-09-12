import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray } from "electron";
import path from "node:path";
import { AgentlingRuntime } from "./runtime";
import { loadHostConfig } from "./config";
import type { DesktopSnapshot, UiConfig } from "../core/types";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let runtime: AgentlingRuntime | null = null;
let quitting = false;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 920,
    minHeight: 640,
    title: "Agentling StackChan",
    backgroundColor: "#10151f",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.once("ready-to-show", () => window.show());
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  if (app.isPackaged) void window.loadFile(path.join(__dirname, "../renderer/index.html"));
  else void window.loadURL(process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173");
  return window;
}

function trayImage() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="7" fill="none" stroke="black" stroke-width="2"/><circle cx="6.5" cy="8" r="1"/><circle cx="11.5" cy="8" r="1"/><path d="M5.5 11c1.6 1.6 5.4 1.6 7 0" fill="none" stroke="black" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  const image = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
  );
  image.setTemplateImage(true);
  return image;
}

function quotaLabel(snapshot: DesktopSnapshot, alias: string, label: string): string {
  const id = snapshot.usage.aliases[alias];
  const window = snapshot.usage.windows.find((entry) => entry.id === id);
  return `${label}: ${window?.remainingPercent === null || !window ? "--" : `${Math.round(window.remainingPercent)}%`}`;
}

function updateTray(snapshot: DesktopSnapshot): void {
  if (!tray) return;
  tray.setToolTip(`Agentling · ${snapshot.agent.aggregateState}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `状态: ${snapshot.agent.aggregateState}`, enabled: false },
      { label: quotaLabel(snapshot, "five_hour", "5H 剩余"), enabled: false },
      { label: quotaLabel(snapshot, "weekly", "每周剩余"), enabled: false },
      { type: "separator" },
      { label: "打开控制台", click: () => mainWindow?.show() },
      { label: "刷新额度", click: () => void runtime?.usageProvider.refresh() },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

async function bootstrap(): Promise<void> {
  const configFile = path.join(app.getPath("userData"), "config.yaml");
  const config = await loadHostConfig(configFile);
  const defaultPackDir = path.join(app.getAppPath(), "packs", "default");
  runtime = new AgentlingRuntime(config, defaultPackDir);
  runtime.on("snapshot", (snapshot: DesktopSnapshot) => {
    updateTray(snapshot);
    mainWindow?.webContents.send("agentling:snapshot", snapshot);
  });

  ipcMain.handle("agentling:snapshot:get", () => runtime?.snapshot());
  ipcMain.handle("agentling:ports:list", () => runtime?.device.listPorts());
  ipcMain.handle("agentling:device:connect", (_event, portPath: string) =>
    runtime?.device.connect(portPath),
  );
  ipcMain.handle("agentling:device:disconnect", () => runtime?.device.disconnect());
  ipcMain.handle("agentling:pack:open", async () => {
    const selected = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    return runtime?.loadPack(selected.filePaths[0]);
  });
  ipcMain.handle("agentling:pack:save-ui", (_event, ui: UiConfig) => runtime?.saveUi(ui));
  ipcMain.handle("agentling:pack:sync", () => runtime?.syncPack());
  ipcMain.handle("agentling:usage:refresh", () => runtime?.usageProvider.refresh());
  ipcMain.handle("agentling:expression:show", (_event, value) => runtime?.showExpression(value));
  ipcMain.handle("agentling:expression:clear", () => runtime?.clearExpression());

  mainWindow = createWindow();
  tray = new Tray(trayImage());
  tray.on("click", () => (mainWindow?.isVisible() ? mainWindow.hide() : mainWindow?.show()));
  await runtime.start();
  updateTray(runtime.snapshot());
  if (process.platform === "darwin" && app.isPackaged && config.desktop.openAtLogin) {
    app.setLoginItemSettings({ openAtLogin: true });
  }
}

app.whenReady().then(() => void bootstrap());
app.on("before-quit", () => {
  quitting = true;
  void runtime?.stop();
});
app.on("activate", () => {
  if (!mainWindow) mainWindow = createWindow();
  mainWindow.show();
});
