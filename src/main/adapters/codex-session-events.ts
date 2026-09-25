import { watch, type FSWatcher } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { COMPLETED_VISIBLE_MS, FAILED_VISIBLE_MS, StateArbiter } from "../../core/state-arbiter";
import type { AgentAdapter, AgentSnapshot, CanonicalEvent } from "../../core/types";

type JsonObject = Record<string, unknown>;

export interface SessionRecordContext {
  sessionId?: string;
  cwd?: string;
  ignored?: boolean;
  pendingInputCalls: Set<string>;
}

interface FileCursor {
  offset: number;
  pending: Buffer;
  context: SessionRecordContext;
}

const SOURCE_ID = "codex-session-log";
const SOURCE_SESSION_ID = "codex-status-source";
const STARTUP_ACTIVE_WINDOW_MS = 15 * 60_000;

export class CodexSessionEventAdapter extends EventEmitter implements AgentAdapter {
  readonly id = SOURCE_ID;
  private readonly arbiter = new StateArbiter();
  private readonly cursors = new Map<string, FileCursor>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly closeTimers = new Map<string, NodeJS.Timeout>();
  private watcher: FSWatcher | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;
  private healthy: boolean | null = null;

  constructor(
    private readonly sessionsRoot = path.join(os.homedir(), ".codex", "sessions"),
    private readonly rescanMs = 2_000,
  ) {
    super();
  }

  async start(): Promise<void> {
    await this.connect();
    this.rescanTimer = setInterval(() => void this.rescan(), this.rescanMs);
    this.rescanTimer.unref();
  }

  async stop(): Promise<void> {
    this.watcher?.close();
    this.watcher = null;
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.rescanTimer = null;
    for (const timer of this.closeTimers.values()) clearTimeout(timer);
    this.closeTimers.clear();
    await Promise.allSettled(this.queues.values());
  }

  async getSnapshot(): Promise<AgentSnapshot> {
    return this.arbiter.snapshot();
  }

  subscribe(handler: (event: CanonicalEvent) => void): () => void {
    this.on("event", handler);
    return () => this.off("event", handler);
  }

  private async connect(): Promise<void> {
    try {
      await fs.access(this.sessionsRoot);
      this.armWatcher();
      await this.scanRecentFiles();
      this.setHealth(true);
    } catch (error) {
      this.setHealth(false, error);
    }
  }

  private armWatcher(): void {
    if (this.watcher) return;
    this.watcher = watch(this.sessionsRoot, { recursive: true }, (_event, filename) => {
      if (!filename || !filename.endsWith(".jsonl")) return;
      this.queueFile(path.join(this.sessionsRoot, filename));
    });
    this.watcher.on("error", (error) => {
      this.watcher?.close();
      this.watcher = null;
      this.setHealth(false, error);
    });
  }

  private async rescan(): Promise<void> {
    if (!this.healthy || !this.watcher) {
      await this.connect();
      return;
    }
    try {
      await fs.access(this.sessionsRoot);
      for (const file of this.cursors.keys()) this.queueFile(file);
    } catch (error) {
      this.watcher?.close();
      this.watcher = null;
      this.setHealth(false, error);
    }
  }

  private async scanRecentFiles(): Promise<void> {
    const cutoff = Date.now() - STARTUP_ACTIVE_WINDOW_MS;
    for (const file of await sessionFiles(this.sessionsRoot)) {
      try {
        const stat = await fs.stat(file);
        if (stat.mtimeMs >= cutoff) await this.primeFile(file);
      } catch {
        // Files may rotate while Codex is writing. The watcher will retry them.
      }
    }
  }

  private queueFile(file: string): void {
    const previous = this.queues.get(file) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        if (this.cursors.has(file)) await this.readIncrement(file);
        else await this.primeFile(file);
      })
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          this.cursors.delete(file);
          return;
        }
        this.setHealth(false, error);
      })
      .finally(() => {
        if (this.queues.get(file) === next) this.queues.delete(file);
      });
    this.queues.set(file, next);
  }

  private async primeFile(file: string): Promise<void> {
    const bytes = await fs.readFile(file);
    const context: SessionRecordContext = { pendingInputCalls: new Set<string>() };
    const newline = bytes.lastIndexOf(0x0a);
    const complete = newline < 0 ? Buffer.alloc(0) : bytes.subarray(0, newline + 1);
    const pending = newline < 0 ? bytes : bytes.subarray(newline + 1);
    const cursor: FileCursor = { offset: bytes.length, pending, context };
    this.cursors.set(file, cursor);
    const events = parseLines(complete, context);
    const currentTurn = currentTurnEvents(events);
    const terminal = currentTurn.at(-1);
    const age = terminal ? Date.now() - terminal.occurredAt : Number.POSITIVE_INFINITY;
    if (
      terminal &&
      (terminal.type === "turn.started" ||
        terminal.type === "input.requested" ||
        terminal.type === "input.resolved" ||
        (terminal.type === "turn.completed" && age <= COMPLETED_VISIBLE_MS) ||
        (terminal.type === "turn.failed" && age <= FAILED_VISIBLE_MS))
    ) {
      for (const event of currentTurn) this.forward(event);
    }
  }

  private async readIncrement(file: string): Promise<void> {
    const cursor = this.cursors.get(file);
    if (!cursor) return this.primeFile(file);
    const handle = await fs.open(file, "r");
    try {
      const stat = await handle.stat();
      if (stat.size < cursor.offset) {
        this.cursors.delete(file);
        await this.primeFile(file);
        return;
      }
      if (stat.size === cursor.offset) return;
      const bytes = Buffer.alloc(stat.size - cursor.offset);
      await handle.read(bytes, 0, bytes.length, cursor.offset);
      cursor.offset = stat.size;
      const combined = cursor.pending.length > 0 ? Buffer.concat([cursor.pending, bytes]) : bytes;
      const newline = combined.lastIndexOf(0x0a);
      if (newline < 0) {
        cursor.pending = combined;
        return;
      }
      cursor.pending = combined.subarray(newline + 1);
      for (const event of parseLines(combined.subarray(0, newline + 1), cursor.context)) this.forward(event);
      this.setHealth(true);
    } finally {
      await handle.close();
    }
  }

  private forward(event: CanonicalEvent): void {
    if (event.type === "turn.started") this.cancelClose(event.sessionId);
    this.arbiter.apply(event);
    this.emit("event", event);
    if (event.type === "turn.completed" || event.type === "turn.failed") this.scheduleClose(event);
  }

  private scheduleClose(event: CanonicalEvent): void {
    this.cancelClose(event.sessionId);
    const visibleMs = event.type === "turn.failed" ? FAILED_VISIBLE_MS : COMPLETED_VISIBLE_MS;
    const delay = Math.max(0, event.occurredAt + visibleMs - Date.now());
    const timer = setTimeout(() => {
      this.closeTimers.delete(event.sessionId);
      this.forward({
        id: `${event.id}:closed`,
        source: event.source,
        type: "session.closed",
        sessionId: event.sessionId,
        occurredAt: Date.now(),
        title: event.title,
        cwd: event.cwd,
      });
    }, delay);
    timer.unref();
    this.closeTimers.set(event.sessionId, timer);
  }

  private cancelClose(sessionId: string): void {
    const timer = this.closeTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.closeTimers.delete(sessionId);
  }

  private setHealth(connected: boolean, error?: unknown): void {
    if (this.healthy === connected) return;
    this.healthy = connected;
    const event: CanonicalEvent = {
      id: `${SOURCE_ID}:${connected ? "connected" : "disconnected"}:${Date.now()}`,
      source: SOURCE_ID,
      type: connected ? "source.connected" : "source.disconnected",
      sessionId: SOURCE_SESSION_ID,
      occurredAt: Date.now(),
      title: "Codex",
      message: connected ? "Codex 状态源已连接" : "Codex 状态源未连接",
      payload: error ? { unavailable: true } : undefined,
    };
    this.arbiter.apply(event);
    this.emit("event", event);
  }
}

export function sessionRecordToEvents(
  record: JsonObject,
  context: SessionRecordContext,
  receivedAt = Date.now(),
): CanonicalEvent[] {
  const payload = objectValue(record.payload);
  if (record.type === "session_meta") {
    context.sessionId = stringValue(payload?.id) || context.sessionId;
    context.cwd = stringValue(payload?.cwd) || context.cwd;
    const source = objectValue(payload?.source);
    const subagent = objectValue(source?.subagent);
    context.ignored = stringValue(subagent?.other) === "guardian";
    return [];
  }
  if (!context.sessionId || !payload || context.ignored) return [];

  const occurredAt = timestampValue(record.timestamp) || receivedAt;
  const title = taskTitle(context.cwd, context.sessionId);
  const common = {
    source: SOURCE_ID,
    sessionId: context.sessionId,
    occurredAt,
    title,
    cwd: context.cwd,
  };

  if (record.type === "event_msg") {
    const sessionType = stringValue(payload.type);
    const turnId = stringValue(payload.turn_id) || "turn";
    if (sessionType === "task_started") {
      context.pendingInputCalls.clear();
      return [{ ...common, id: `${context.sessionId}:${turnId}:started`, type: "turn.started" }];
    }
    if (sessionType === "task_complete") {
      context.pendingInputCalls.clear();
      return [{ ...common, id: `${context.sessionId}:${turnId}:completed`, type: "turn.completed" }];
    }
    if (sessionType === "turn_aborted") {
      context.pendingInputCalls.clear();
      return [{ ...common, id: `${context.sessionId}:${turnId}:aborted`, type: "turn.failed", message: "任务已中断" }];
    }
  }

  if (record.type === "response_item" && payload.type === "function_call") {
    const name = stringValue(payload.name);
    const callId = stringValue(payload.call_id) || stringValue(payload.id);
    if (name === "request_user_input" && callId) {
      context.pendingInputCalls.add(callId);
      return [{ ...common, id: `${context.sessionId}:${callId}:input`, type: "input.requested" }];
    }
  }

  if (record.type === "response_item" && payload.type === "function_call_output") {
    const callId = stringValue(payload.call_id);
    if (callId && context.pendingInputCalls.delete(callId)) {
      return [{ ...common, id: `${context.sessionId}:${callId}:input-resolved`, type: "input.resolved" }];
    }
  }
  return [];
}

function parseLines(bytes: Buffer, context: SessionRecordContext): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  for (const line of bytes.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as JsonObject;
      events.push(...sessionRecordToEvents(record, context));
    } catch {
      // Ignore a malformed record; later complete JSONL records remain usable.
    }
  }
  return events;
}

function currentTurnEvents(events: CanonicalEvent[]): CanonicalEvent[] {
  let start = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === "turn.started") {
      start = index;
      break;
    }
  }
  return start < 0 ? [] : events.slice(start);
}

async function sessionFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await sessionFiles(target)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(target);
  }
  return files;
}

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function timestampValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1_000 : value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function taskTitle(cwd: string | undefined, sessionId: string): string {
  return cwd ? path.basename(cwd) : `Codex ${sessionId.slice(0, 6)}`;
}
