import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { compilePack, saveUiConfig } from "../core/pack";
import { StateArbiter } from "../core/state-arbiter";
import type {
  CanonicalEvent,
  CompiledPack,
  DesktopSnapshot,
  ExpressionOverlay,
  UiConfig,
  UsageSnapshot,
  WeatherSnapshot,
  ClockSnapshot,
} from "../core/types";
import { CodexHookAdapter } from "./adapters/codex-hooks";
import type { HostConfig } from "./config";
import { ClockProvider } from "./providers/clock";
import { CodexUsageProvider } from "./providers/codex-usage";
import { WeatherProvider } from "./providers/weather";
import { DeviceService } from "./services/device";
import { LocalApiServer } from "./services/http-api";
import { CodexSessionEventAdapter } from "./adapters/codex-session-events";

const AGENT_HEARTBEAT_MS = 1_000;

export class AgentlingRuntime extends EventEmitter {
  readonly hooks = new CodexHookAdapter();
  readonly sessionEvents = new CodexSessionEventAdapter();
  readonly arbiter = new StateArbiter();
  readonly usageProvider: CodexUsageProvider;
  readonly clockProvider = new ClockProvider();
  readonly weatherProvider: WeatherProvider;
  readonly device: DeviceService;
  readonly api: LocalApiServer;

  private usage: UsageSnapshot = {
    source: "codex",
    windows: [],
    aliases: { five_hour: null, weekly: null },
    fetchedAt: 0,
    status: "unavailable",
  };
  private clock: ClockSnapshot = {
    iso: new Date().toISOString(),
    unixSeconds: Math.floor(Date.now() / 1_000),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    displayTime: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }),
    displayDate: new Date().toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }),
  };
  private weather: WeatherSnapshot = {
    status: "unavailable",
    temperatureC: null,
    weatherCode: null,
    label: "--",
    fetchedAt: 0,
  };
  private pack: CompiledPack | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private lastAgentSignature = "";
  private lastAgentSentAt = 0;

  constructor(
    readonly config: HostConfig,
    private readonly defaultPackDir: string,
  ) {
    super();
    this.usageProvider = new CodexUsageProvider(config.codex);
    this.weatherProvider = new WeatherProvider(config.weather);
    this.device = new DeviceService(config.device);
    this.api = new LocalApiServer(config.server, this);
  }

  async start(): Promise<void> {
    const requestedPack = this.config.packDir || this.defaultPackDir;
    try {
      await this.loadPack(requestedPack);
    } catch (error) {
      if (path.resolve(requestedPack) === path.resolve(this.defaultPackDir)) throw error;
      await this.loadPack(this.defaultPackDir);
      this.config.packDir = this.defaultPackDir;
      this.emit("log", `Configured character pack could not be loaded; using Byte Otter: ${String(error)}`);
    }
    this.hooks.subscribe((event) => this.handleCanonicalEvent(event));
    this.sessionEvents.subscribe((event) => this.handleCanonicalEvent(event));
    this.usageProvider.subscribe((value) => {
      this.usage = value;
      this.publishWidgets();
      this.publish();
    });
    this.usageProvider.on("alert", (level: string, window: { id: string }) => {
      const event = `usage.${level}`;
      this.sendBehavior(event, { windowId: window.id });
    });
    this.clockProvider.subscribe((value) => {
      this.clock = value;
      this.publishWidgets();
      this.publish();
    });
    this.weatherProvider.subscribe((value) => {
      this.weather = value;
      this.publishWidgets();
      this.publish();
    });
    this.device.on("status", () => this.publish());
    this.device.on("ready", () => this.sendFullSnapshot());
    this.device.on("input", (input: { type?: string }) => {
      if (input.type === "swipe_left" || input.type === "swipe_right" || input.type === "task_next") {
        this.arbiter.selectNext();
        this.publishAgent();
      }
    });
    this.arbiter.on("snapshot", () => this.publish());
    this.arbiter.on("overlay", () => this.publish());

    this.clockProvider.start();
    this.weatherProvider.start();
    await Promise.allSettled([
      this.hooks.start(),
      this.sessionEvents.start(),
      this.usageProvider.start(),
      this.device.start(),
      this.api.start(),
    ]);
    this.tickTimer = setInterval(() => {
      const previousState = this.arbiter.snapshot().aggregateState;
      const next = this.arbiter.tick();
      this.publishAgent();
      if (previousState !== next.aggregateState && next.aggregateState === "idle") {
        this.sendBehavior("session.idle");
      }
      this.publishOverlay();
    }, 250);
    this.tickTimer.unref();
    this.sendFullSnapshot();
  }

  async stop(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.clockProvider.stop();
    this.weatherProvider.stop();
    await Promise.allSettled([
      this.hooks.stop(),
      this.sessionEvents.stop(),
      this.usageProvider.stop(),
      this.device.stop(),
      this.api.stop(),
    ]);
  }

  snapshot(): DesktopSnapshot {
    return {
      agent: this.arbiter.snapshot(),
      usage: this.usage,
      clock: this.clock,
      weather: this.weather,
      overlay: this.arbiter.getOverlay(),
      device: this.device.current(),
      pack: this.pack,
    };
  }

  handleHook(raw: Record<string, unknown>): CanonicalEvent | null {
    return this.hooks.handleRaw(raw);
  }

  showExpression(input: { scene: string; text?: string; ttlMs: number }): void {
    const now = Date.now();
    this.arbiter.setOverlay({
      scene: input.scene,
      text: input.text,
      createdAt: now,
      expiresAt: now + input.ttlMs,
    });
    this.publishOverlay();
  }

  showProgress(input: { stage: string; current: number; total: number; ttlMs: number }): void {
    const now = Date.now();
    this.arbiter.setOverlay({
      scene: "progress",
      text: input.stage,
      progress: { stage: input.stage, current: input.current, total: input.total },
      createdAt: now,
      expiresAt: now + input.ttlMs,
    });
    this.publishOverlay();
  }

  clearExpression(): void {
    this.arbiter.setOverlay(null);
    this.publishOverlay();
  }

  selectTask(id: string): void {
    this.arbiter.selectTask(id);
    this.publishAgent();
  }

  async loadPack(directory: string): Promise<CompiledPack> {
    const pack = await compilePack(directory);
    this.pack = pack;
    this.usageProvider.setAliases(pack.ui.usage_aliases);
    this.publish();
    return pack;
  }

  async saveUi(ui: UiConfig): Promise<CompiledPack> {
    if (!this.pack) throw new Error("no character pack is loaded");
    await saveUiConfig(this.pack.sourceDir, ui);
    return this.loadPack(this.pack.sourceDir);
  }

  async syncPack(): Promise<void> {
    if (this.syncingPack) throw new Error("A character pack sync is already running");
    if (!this.pack) throw new Error("no character pack is loaded");
    this.syncingPack = true;
    try { await this.device.syncPack(this.pack); } finally { this.syncingPack = false; }
  }

  private syncingPack = false;

  async readPackAsset(relativePath: string): Promise<string | null> {
    if (!this.pack || !this.pack.files.some((file) => file.path === relativePath)) return null;
    if (!relativePath.startsWith("assets/sprites/")) return null;
    const extension = path.extname(relativePath).toLowerCase();
    const mime = extension === ".png" ? "image/png" : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : null;
    if (!mime) return null;
    const bytes = await fs.readFile(path.join(this.pack.sourceDir, relativePath));
    return `data:${mime};base64,${bytes.toString("base64")}`;
  }

  private handleCanonicalEvent(event: CanonicalEvent): void {
    const snapshot = this.arbiter.apply(event);
    if (event.type === "session.closed") {
      // Closing one task is not a desktop disconnect. If no other task needs
      // attention, return to the ordinary idle character; otherwise preserve
      // the currently authoritative task state.
      if (snapshot.aggregateState === "idle") this.sendBehavior("session.idle", event.payload);
    } else {
      this.sendBehavior(event.type, event.payload);
    }
    this.publishAgent();
    this.publishOverlay();
  }

  private sendBehavior(event: string, payload?: Record<string, unknown>): void {
    const behavior = this.pack?.events[event];
    this.device.sendActionCue({ behavior, event, ...(payload ? { payload } : {}) });
  }

  private publishAgent(): void {
    const snapshot = this.arbiter.snapshot();
    const signature = JSON.stringify({
      tasks: snapshot.tasks,
      activeTaskId: snapshot.activeTaskId,
      aggregateState: snapshot.aggregateState,
    });
    const now = Date.now();
    if (signature === this.lastAgentSignature && now - this.lastAgentSentAt < AGENT_HEARTBEAT_MS) return;
    this.lastAgentSignature = signature;
    this.lastAgentSentAt = now;
    this.device.sendAgentSnapshot(snapshot);
  }

  private publishWidgets(): void {
    this.device.sendWidgetSnapshot({ usage: this.usage, clock: this.clock, weather: this.weather });
  }

  private sendFullSnapshot(): void {
    const agent = this.arbiter.snapshot();
    this.lastAgentSignature = "";
    this.device.sendAgentSnapshot(agent);
    this.lastAgentSentAt = Date.now();
    this.publishWidgets();
    this.device.sendActionCue({ overlay: this.arbiter.getOverlay() });
    if (agent.aggregateState === "idle") this.sendBehavior("session.idle");
  }

  private lastOverlaySignature = "unset";

  private publishOverlay(): void {
    const overlay = this.arbiter.getOverlay();
    const signature = JSON.stringify(overlay);
    if (signature === this.lastOverlaySignature) return;
    this.lastOverlaySignature = signature;
    this.device.sendActionCue({ overlay });
  }

  private publish(): void {
    this.emit("snapshot", this.snapshot());
  }
}
