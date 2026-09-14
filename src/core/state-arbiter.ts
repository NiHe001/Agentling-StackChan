import { EventEmitter } from "node:events";
import type {
  AgentSnapshot,
  AgentState,
  CanonicalEvent,
  ExpressionOverlay,
  TaskReport,
  TaskSnapshot,
} from "./types";

const STATE_PRIORITY: Record<AgentState, number> = {
  offline: 0,
  idle: 10,
  completed: 40,
  working: 60,
  needs_input: 70,
  waiting_approval: 80,
  failed: 90,
};

const EVENT_STATE: Partial<Record<CanonicalEvent["type"], AgentState>> = {
  "session.started": "idle",
  "session.idle": "idle",
  "turn.started": "working",
  "turn.progress": "working",
  "tool.started": "working",
  "tool.completed": "working",
  "approval.requested": "waiting_approval",
  "approval.resolved": "working",
  "input.requested": "needs_input",
  "input.resolved": "working",
  "turn.completed": "completed",
  "turn.failed": "failed",
  "tool.failed": "failed",
};

export class StateArbiter extends EventEmitter {
  private readonly tasks = new Map<string, TaskSnapshot>();
  private readonly reports: TaskReport[] = [];
  private readonly seenEventIds = new Set<string>();
  private preferredTaskId: string | null = null;
  private overlay: ExpressionOverlay | null = null;
  private readonly disconnectedSources = new Set<string>();
  private sourceUpdatedAt = 0;

  apply(event: CanonicalEvent): AgentSnapshot {
    if (this.seenEventIds.has(event.id)) return this.snapshot();
    this.seenEventIds.add(event.id);
    if (this.seenEventIds.size > 2_000) {
      const oldest = this.seenEventIds.values().next().value as string | undefined;
      if (oldest) this.seenEventIds.delete(oldest);
    }
    if (this.overlay) {
      this.overlay = null;
      this.emit("overlay", null);
    }

    if (event.type === "source.disconnected") {
      this.disconnectedSources.add(event.source);
      this.sourceUpdatedAt = event.occurredAt;
      return this.emitSnapshot();
    }
    if (event.type === "source.connected") {
      this.disconnectedSources.delete(event.source);
      this.sourceUpdatedAt = event.occurredAt;
      return this.emitSnapshot();
    }

    if (event.type === "session.closed") {
      this.tasks.delete(event.sessionId);
      if (this.preferredTaskId === event.sessionId) this.preferredTaskId = null;
      return this.emitSnapshot();
    }

    const previous = this.tasks.get(event.sessionId);
    if (previous && this.isStale(previous, event)) return this.snapshot();

    const now = event.occurredAt;
    const task: TaskSnapshot = previous ?? {
      id: event.sessionId,
      source: event.source,
      title: event.title || this.defaultTitle(event.cwd, event.sessionId),
      cwd: event.cwd,
      state: "idle",
      subagents: 0,
      startedAt: now,
      updatedAt: now,
    };

    const nextState = EVENT_STATE[event.type];
    if (nextState) task.state = nextState;
    task.updatedAt = now;
    task.sequence = event.sequence ?? task.sequence;
    task.title = event.title || task.title;
    task.cwd = event.cwd || task.cwd;
    task.message = reportMessage(event);
    task.lastEvent = event.type;

    if (event.type === "tool.started") task.currentTool = event.tool || "tool";
    if (event.type === "tool.completed" || event.type === "tool.failed") task.currentTool = undefined;
    if (
      event.type === "turn.completed" ||
      event.type === "turn.failed" ||
      event.type === "session.idle" ||
      event.type === "input.requested"
    ) task.currentTool = undefined;
    if (event.type === "subagent.started") task.subagents += 1;
    if (event.type === "subagent.completed") task.subagents = Math.max(0, task.subagents - 1);

    this.tasks.set(task.id, task);
    this.reports.unshift({
      id: event.id,
      taskId: task.id,
      taskTitle: task.title,
      source: task.source,
      type: event.type,
      state: task.state,
      message: task.message,
      tool: event.tool,
      occurredAt: event.occurredAt,
    });
    if (this.reports.length > 40) this.reports.length = 40;
    if (task.state === "failed" || task.state === "waiting_approval") {
      this.preferredTaskId = task.id;
    }
    return this.emitSnapshot();
  }

  selectNext(): AgentSnapshot {
    const ordered = this.orderedTasks();
    if (ordered.length === 0) return this.snapshot();
    const current = ordered.findIndex((task) => task.id === this.activeTaskId(ordered));
    this.preferredTaskId = ordered[(current + 1) % ordered.length]?.id ?? null;
    return this.emitSnapshot();
  }

  selectTask(id: string): AgentSnapshot {
    if (this.tasks.has(id)) this.preferredTaskId = id;
    return this.emitSnapshot();
  }

  setOverlay(overlay: ExpressionOverlay | null): void {
    this.overlay = overlay;
    this.emit("overlay", this.getOverlay());
  }

  getOverlay(now = Date.now()): ExpressionOverlay | null {
    if (this.overlay && this.overlay.expiresAt <= now) this.overlay = null;
    const state = this.snapshot(now).aggregateState;
    if (state === "failed" || state === "waiting_approval" || state === "offline") return null;
    return this.overlay;
  }

  tick(now = Date.now()): AgentSnapshot {
    let changed = false;
    for (const task of this.tasks.values()) {
      if (task.state === "completed" && now - task.updatedAt >= 4_000) {
        task.state = "idle";
        task.message = "空闲中";
        task.updatedAt = now;
        changed = true;
      }
    }
    if (this.overlay && this.overlay.expiresAt <= now) {
      this.overlay = null;
      changed = true;
      this.emit("overlay", null);
    }
    return changed ? this.emitSnapshot(now) : this.snapshot(now);
  }

  snapshot(now = Date.now()): AgentSnapshot {
    const tasks = this.orderedTasks();
    const activeTaskId = this.activeTaskId(tasks);
    return {
      tasks,
      reports: this.reports.map((report) => ({ ...report })),
      activeTaskId,
      aggregateState: this.disconnectedSources.size > 0 ? "offline" : tasks[0]?.state ?? "idle",
      updatedAt: Math.max(now, this.sourceUpdatedAt, ...tasks.map((task) => task.updatedAt)),
    };
  }

  private isStale(task: TaskSnapshot, event: CanonicalEvent): boolean {
    if (event.sequence !== undefined && task.sequence !== undefined) {
      return event.sequence < task.sequence;
    }
    return event.occurredAt < task.updatedAt - 1_000;
  }

  private orderedTasks(): TaskSnapshot[] {
    return [...this.tasks.values()]
      .map((task) => ({ ...task }))
      .sort((left, right) => {
        const priority = STATE_PRIORITY[right.state] - STATE_PRIORITY[left.state];
        return priority || right.updatedAt - left.updatedAt;
      });
  }

  private activeTaskId(tasks: TaskSnapshot[]): string | null {
    const critical = tasks.find((task) => STATE_PRIORITY[task.state] >= STATE_PRIORITY.waiting_approval);
    if (critical) return critical.id;
    if (this.preferredTaskId && tasks.some((task) => task.id === this.preferredTaskId)) {
      return this.preferredTaskId;
    }
    return tasks[0]?.id ?? null;
  }

  private defaultTitle(cwd: string | undefined, sessionId: string): string {
    const directory = cwd?.split(/[\\/]/).filter(Boolean).at(-1);
    return directory || `Task ${sessionId.slice(0, 6)}`;
  }

  private emitSnapshot(now = Date.now()): AgentSnapshot {
    const value = this.snapshot(now);
    this.emit("snapshot", value);
    return value;
  }
}

function reportMessage(event: CanonicalEvent): string {
  const supplied = event.message?.replace(/\s+/g, " ").trim();
  if (supplied) return supplied;
  const tool = friendlyToolName(event.tool);
  const fallback: Partial<Record<CanonicalEvent["type"], string>> = {
    "session.started": "任务已连接",
    "session.idle": "空闲中",
    "turn.started": "开始处理",
    "turn.progress": "正在整理上下文",
    "turn.completed": "已报告完成",
    "turn.failed": "任务执行失败",
    "tool.started": `${tool}进行中`,
    "tool.completed": `${tool}已完成`,
    "tool.failed": `${tool}失败`,
    "approval.requested": "等待你的批准",
    "approval.resolved": "已批准，继续执行",
    "input.requested": "等待你的输入",
    "input.resolved": "收到输入，继续执行",
    "subagent.started": "子任务已启动",
    "subagent.completed": "子任务已完成",
  };
  return fallback[event.type] || event.type;
}

function friendlyToolName(tool: string | undefined): string {
  if (!tool) return "工具";
  const normalized = tool.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("exec") || normalized.includes("terminal")) return "终端命令";
  if (normalized.includes("read") || normalized.includes("find") || normalized === "rg") return "文件读取";
  if (normalized.includes("write") || normalized.includes("edit") || normalized.includes("patch")) return "文件修改";
  if (normalized.includes("web") || normalized.includes("search")) return "网页查询";
  if (normalized.includes("image")) return "图片处理";
  if (normalized.includes("mcp")) return "MCP 工具";
  return tool.length > 18 ? `${tool.slice(0, 17)}…` : tool;
}
