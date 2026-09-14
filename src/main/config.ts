import { promises as fs } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";

export interface HostConfig {
  desktop: {
    openAtLogin: boolean;
  };
  server: {
    host: "127.0.0.1";
    port: number;
    token?: string;
  };
  codex: {
    enabled: boolean;
    binary?: string;
    refreshMs: number;
  };
  weather: {
    enabled: boolean;
    latitude?: number;
    longitude?: number;
    timezone: string;
    refreshMs: number;
  };
  device: {
    autoConnect: boolean;
    preferredPath?: string;
    baudRate: number;
  };
  packDir?: string;
}

export const DEFAULT_HOST_CONFIG: HostConfig = {
  desktop: { openAtLogin: false },
  server: { host: "127.0.0.1", port: 17_321 },
  codex: { enabled: true, refreshMs: 60_000 },
  weather: {
    enabled: false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    refreshMs: 30 * 60_000,
  },
  device: { autoConnect: true, baudRate: 921_600 },
};

export async function loadHostConfig(file: string): Promise<HostConfig> {
  try {
    const value = parse(await fs.readFile(file, "utf8")) as Partial<HostConfig>;
    const codex = { ...DEFAULT_HOST_CONFIG.codex, ...value.codex };
    // Migrate the original five-minute default while preserving deliberate custom values.
    if (codex.refreshMs === 5 * 60_000) codex.refreshMs = DEFAULT_HOST_CONFIG.codex.refreshMs;
    return {
      desktop: { ...DEFAULT_HOST_CONFIG.desktop, ...value.desktop },
      server: { ...DEFAULT_HOST_CONFIG.server, ...value.server, host: "127.0.0.1" },
      codex,
      weather: { ...DEFAULT_HOST_CONFIG.weather, ...value.weather },
      device: { ...DEFAULT_HOST_CONFIG.device, ...value.device },
      packDir: value.packDir,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, stringify(DEFAULT_HOST_CONFIG), "utf8");
    return structuredClone(DEFAULT_HOST_CONFIG);
  }
}

export async function saveHostConfig(file: string, config: HostConfig): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, stringify(config, { lineWidth: 100 }), "utf8");
  await fs.rename(temporary, file);
}
