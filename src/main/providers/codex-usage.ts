import { EventEmitter } from "node:events";
import { access } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import {
  DEFAULT_USAGE_ALIASES,
  UsageAlertTracker,
  UsageStore,
  type RawRateLimitsResponse,
  type RawRateLimitsUpdate,
} from "../../core/usage";
import type { DataProvider, UsageAliasConfig, UsageSnapshot, UsageWindow } from "../../core/types";
import type { HostConfig } from "../config";

type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

class JsonRpcLineClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();

  constructor(private readonly binary: string) {
    super();
  }

  async start(): Promise<void> {
    this.child = spawn(this.binary, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child.once("error", (error) => this.handleClose(error));
    this.child.once("exit", (code, signal) =>
      this.handleClose(new Error(`Codex App Server exited (${code ?? signal ?? "unknown"})`)),
    );
    this.child.stderr.on("data", (chunk) => this.emit("log", String(chunk).trim()));
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));

    await this.request("initialize", {
      clientInfo: { name: "agentling-stackchan", title: "Agentling StackChan", version: "0.1.0" },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: [
          "item/agentMessage/delta",
          "item/reasoning/summaryTextDelta",
          "command/exec/outputDelta",
        ],
      },
    });
    this.notify("initialized");
  }

  request(method: string, params?: unknown, timeoutMs = 10_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.write(params === undefined ? { id, method } : { id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  stop(): void {
    this.child?.kill("SIGTERM");
    this.child = null;
    this.handleClose(new Error("Codex App Server stopped"));
  }

  private write(message: JsonRpcMessage): void {
    if (!this.child?.stdin.writable) throw new Error("Codex App Server is not connected");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.emit("log", `Ignored non-JSON app-server output: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof message.id === "number" && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method && message.id === undefined) {
      this.emit("notification", message.method, message.params);
      return;
    }
    if (message.method && message.id !== undefined) {
      this.write({
        id: message.id,
        error: { code: -32601, message: `Agentling does not implement ${message.method}` },
      });
    }
  }

  private handleClose(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.emit("closed", error);
  }
}

export class CodexUsageProvider extends EventEmitter implements DataProvider<UsageSnapshot> {
  readonly id = "codex-usage";
  private readonly store = new UsageStore();
  private readonly alertTracker = new UsageAlertTracker();
  private readonly alertCooldown = new Map<string, number>();
  private aliases: Record<string, UsageAliasConfig> = DEFAULT_USAGE_ALIASES;
  private client: JsonRpcLineClient | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private reconnectDelay = 1_000;
  private previousWindows = new Map<string, UsageWindow>();

  constructor(private readonly config: HostConfig["codex"]) {
    super();
  }

  setAliases(aliases: Record<string, UsageAliasConfig>): void {
    this.aliases = Object.keys(aliases).length > 0 ? aliases : DEFAULT_USAGE_ALIASES;
    this.publish();
  }

  async start(): Promise<void> {
    this.stopping = false;
    if (!this.config.enabled) {
      this.store.fail("Codex usage provider is disabled");
      this.publish();
      return;
    }
    await this.connect().catch((error) => {
      this.store.fail(error);
      this.publish();
      this.scheduleReconnect();
    });
    this.pollTimer = setInterval(() => void this.refresh(), this.config.refreshMs);
    this.pollTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pollTimer = null;
    this.reconnectTimer = null;
    this.client?.stop();
    this.client = null;
  }

  async refresh(): Promise<UsageSnapshot> {
    try {
      if (!this.client) await this.connect();
      const result = (await this.client?.request("account/rateLimits/read")) as RawRateLimitsResponse;
      if (!result?.rateLimits) throw new Error("rate limit response is missing rateLimits");
      this.store.replace(result);
    } catch (error) {
      this.store.fail(error);
      if (!this.client) this.scheduleReconnect();
    }
    return this.publish();
  }

  subscribe(handler: (value: UsageSnapshot) => void): () => void {
    this.on("value", handler);
    return () => this.off("value", handler);
  }

  current(): UsageSnapshot {
    return this.store.snapshot(this.aliases);
  }

  private async connect(): Promise<void> {
    if (this.client || this.stopping) return;
    const binary = await findCodexBinary(this.config.binary);
    const client = new JsonRpcLineClient(binary);
    client.on("notification", (method: string, params: unknown) => {
      if (method !== "account/rateLimits/updated") return;
      const update = params as RawRateLimitsUpdate;
      if (!update?.rateLimits) return;
      this.store.merge(update);
      this.publish();
    });
    client.on("closed", (error: Error) => {
      if (this.client !== client) return;
      this.client = null;
      this.store.fail(error);
      this.publish();
      this.scheduleReconnect();
    });
    client.on("log", (message: string) => this.emit("log", message));
    await client.start();
    this.client = client;
    this.reconnectDelay = 1_000;
    await this.refresh();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((error) => {
        this.store.fail(error);
        this.publish();
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
        this.scheduleReconnect();
      });
    }, this.reconnectDelay);
    this.reconnectTimer.unref();
  }

  private publish(): UsageSnapshot {
    const snapshot = this.store.snapshot(this.aliases);
    const now = Date.now();
    for (const window of snapshot.windows) {
      const previousWindow = this.previousWindows.get(window.id);
      if (
        previousWindow?.resetsAt &&
        window.resetsAt &&
        window.resetsAt > previousWindow.resetsAt &&
        window.remainingPercent !== null &&
        previousWindow.remainingPercent !== null &&
        window.remainingPercent > previousWindow.remainingPercent
      ) {
        this.emit("alert", "reset", window);
      }
      const level = this.alertTracker.update(window);
      if (!level || level === "normal") continue;
      const key = `${window.id}:${level}`;
      if ((this.alertCooldown.get(key) ?? 0) > now - 60_000) continue;
      this.alertCooldown.set(key, now);
      this.emit("alert", level, window as UsageWindow);
    }
    this.previousWindows = new Map(snapshot.windows.map((window) => [window.id, window]));
    this.emit("value", snapshot);
    return snapshot;
  }
}

async function findCodexBinary(configured?: string): Promise<string> {
  const candidates = [
    configured,
    process.env.AGENTLING_CODEX_BIN,
    process.platform === "darwin" ? "/Applications/ChatGPT.app/Contents/Resources/codex" : undefined,
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next explicit path.
    }
  }
  return "codex";
}
