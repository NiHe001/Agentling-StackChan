import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { StateArbiter } from "../../core/state-arbiter";
import type { AgentAdapter, AgentSnapshot, CanonicalEvent, CanonicalEventType } from "../../core/types";

type RawHook = Record<string, unknown>;

const EVENT_MAP: Record<string, CanonicalEventType | undefined> = {
  SessionStart: "session.started",
  SessionEnd: "session.closed",
  UserPromptSubmit: "turn.started",
  PreToolUse: "tool.started",
  PostToolUse: "tool.completed",
  PostToolUseFailure: "tool.failed",
  PermissionRequest: "approval.requested",
  Stop: "turn.completed",
  Interrupt: "turn.failed",
  SubagentStart: "subagent.started",
  SubagentStop: "subagent.completed",
  PreCompact: "turn.progress",
  PostCompact: "turn.progress",
};

export class CodexHookAdapter extends EventEmitter implements AgentAdapter {
  readonly id = "codex-hooks";
  private readonly arbiter = new StateArbiter();
  private readonly forwardedEventIds = new Set<string>();

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async getSnapshot(): Promise<AgentSnapshot> {
    return this.arbiter.snapshot();
  }

  subscribe(handler: (event: CanonicalEvent) => void): () => void {
    this.on("event", handler);
    return () => this.off("event", handler);
  }

  handleRaw(raw: RawHook, receivedAt = Date.now()): CanonicalEvent | null {
    const hookName = stringValue(raw.hook_event_name) || stringValue(raw.hookEventName);
    if (!hookName) return null;
    const type = EVENT_MAP[hookName];
    if (!type) return null;
    const sessionId =
      stringValue(raw.session_id) || stringValue(raw.sessionId) || this.fallbackSessionId(raw);
    const occurredAt = timestampValue(raw.timestamp) || receivedAt;
    const event: CanonicalEvent = {
      id:
        stringValue(raw.event_id) ||
        createHash("sha256")
          .update(
            `${sessionId}:${hookName}:${occurredAt}:${stringValue(raw.tool_use_id) || ""}:${sequenceValue(raw.sequence) ?? ""}`,
          )
          .digest("hex")
          .slice(0, 24),
      source: "codex",
      type,
      sessionId,
      occurredAt,
      sequence: sequenceValue(raw.sequence),
      title: stringValue(raw.title),
      cwd: stringValue(raw.cwd),
      tool: stringValue(raw.tool_name) || stringValue(raw.toolName),
      message: safeMessage(raw),
      payload: {
        hookEventName: hookName,
        source: stringValue(raw.source),
        permissionMode: stringValue(raw.permission_mode),
      },
    };
    if (!this.forwardedEventIds.has(event.id)) {
      this.forwardedEventIds.add(event.id);
      if (this.forwardedEventIds.size > 2_000) {
        const oldest = this.forwardedEventIds.values().next().value as string | undefined;
        if (oldest) this.forwardedEventIds.delete(oldest);
      }
      this.arbiter.apply(event);
      this.emit("event", event);
    }
    return event;
  }

  private fallbackSessionId(raw: RawHook): string {
    const cwd = stringValue(raw.cwd);
    if (cwd) return `codex-${createHash("sha1").update(cwd).digest("hex").slice(0, 12)}`;
    return `codex-${randomUUID()}`;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timestampValue(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  // Accept seconds as well as milliseconds.
  return value < 10_000_000_000 ? value * 1_000 : value;
}

function sequenceValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeMessage(raw: RawHook): string | undefined {
  // Forward only a short user-facing report. Never forward prompts, command
  // output, tool input, transcript paths, or arbitrary nested payloads.
  const candidate =
    stringValue(raw.status_message) ||
    stringValue(raw.message) ||
    stringValue(raw.last_assistant_message) ||
    stringValue(raw.notification_type);
  if (!candidate) return undefined;
  const oneLine = candidate.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return [...oneLine].slice(0, 96).join("");
}
