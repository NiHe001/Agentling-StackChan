import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray } from "electron";
import path from "node:path";
import { AgentlingRuntime } from "./runtime";
import { loadHostConfig, saveHostConfig } from "./config";
import { listPackOptions, type PackOption } from "./pack-library";
import { compilePack } from "../core/pack";
import type { DesktopSnapshot, UiConfig } from "../core/types";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let runtime: AgentlingRuntime | null = null;
let quitting = false;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 980,
    minHeight: 660,
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
  const image = nativeImage.createFromPath(
    path.join(app.getAppPath(), "packs", "byte-otter", "assets", "tray-iconTemplate@2x.png"),
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
  const defaultPackDir = path.join(app.getAppPath(), "packs", "byte-otter");
  const bundledPacksDir = path.join(app.getAppPath(), "packs");
  runtime = new AgentlingRuntime(config, defaultPackDir);
  const packOptions = () => {
    const activeDir = runtime?.snapshot().pack?.sourceDir;
    return listPackOptions(bundledPacksDir, [
      ...(config.packDirs ?? []),
      ...(config.packDir ? [config.packDir] : []),
      ...(activeDir ? [activeDir] : []),
    ]);
  };
  const rememberPack = async (directory: string) => {
    config.packDirs = [...new Set([...(config.packDirs ?? []), directory])];
    await saveHostConfig(configFile, config);
  };
  runtime.on("snapshot", (snapshot: DesktopSnapshot) => {
    updateTray(snapshot);
    mainWindow?.webContents.send("agentling:snapshot", snapshot);
  });

  ipcMain.handle("agentling:snapshot:get", () => runtime?.snapshot());
  ipcMain.handle("agentling:ports:list", () => runtime?.device.listPorts());
  ipcMain.handle("agentling:device:connect", async (_event, portPath: string) => {
    const status = await runtime?.device.connect(portPath);
    if (runtime) {
      runtime.config.device.preferredPath = portPath;
      await saveHostConfig(configFile, runtime.config);
    }
    return status;
  });
  ipcMain.handle("agentling:device:disconnect", () => runtime?.device.disconnect());
  ipcMain.handle("agentling:pack:list", packOptions);
  ipcMain.handle("agentling:pack:add", async () => {
    const selected = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const pack = await compilePack(selected.filePaths[0]);
    await rememberPack(pack.sourceDir);
    return { sourceDir: pack.sourceDir, id: pack.manifest.id, name: pack.manifest.name, version: pack.manifest.version } satisfies PackOption;
  });
  ipcMain.handle("agentling:pack:apply", async (_event, directory: string) => {
    if (!(await packOptions()).some((option) => option.sourceDir === directory)) {
      throw new Error("所选角色包已不可用，请重新添加");
    }
    if (!runtime) throw new Error("桌面服务尚未就绪");
    const pack = await runtime.applyPack(directory);
    config.packDir = pack.sourceDir;
    try {
      await rememberPack(pack.sourceDir);
    } catch (error) {
      throw new Error(`角色包已应用到屏幕，但保存下次启动的选择失败：${String(error)}`);
    }
    return pack;
  });
  ipcMain.handle("agentling:pack:open", async () => {
    const selected = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const pack = await runtime?.loadPack(selected.filePaths[0]);
    if (runtime && pack) {
      runtime.config.packDir = pack.sourceDir;
      await rememberPack(pack.sourceDir);
    }
    return pack;
  });
  ipcMain.handle("agentling:pack:save-ui", (_event, ui: UiConfig) => runtime?.saveUi(ui));
  ipcMain.handle("agentling:pack:sync", () => runtime?.syncPack());
  ipcMain.handle("agentling:pack:asset", (_event, relativePath: string) => runtime?.readPackAsset(relativePath));
  ipcMain.handle("agentling:usage:refresh", () => runtime?.usageProvider.refresh());
  ipcMain.handle("agentling:task:select", (_event, id: string) => runtime?.selectTask(id));
  ipcMain.handle("agentling:expression:show", (_event, value) => runtime?.showExpression(value));
  ipcMain.handle("agentling:expression:clear", () => runtime?.clearExpression());

  mainWindow = createWindow();
  tray = new Tray(trayImage());
  tray.on("click", () => (mainWindow?.isVisible() ? mainWindow.hide() : mainWindow?.show()));
  await runtime.start();
  const activePackDir = runtime.snapshot().pack?.sourceDir;
  if (activePackDir && config.packDir !== activePackDir) {
    config.packDir = activePackDir;
    await saveHostConfig(configFile, config);
  }
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
