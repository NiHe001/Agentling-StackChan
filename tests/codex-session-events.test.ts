import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexSessionEventAdapter,
  sessionRecordToEvents,
  type SessionRecordContext,
} from "../src/main/adapters/codex-session-events";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function context(): SessionRecordContext {
  return { pendingInputCalls: new Set<string>() };
}

describe("Codex session event stream", () => {
  it("maps task lifecycle records without forwarding conversation content", () => {
    const state = context();
    sessionRecordToEvents({
      type: "session_meta",
      payload: { id: "thread-1", cwd: "/tmp/robot", private_prompt: "do not forward" },
    }, state);
    const started = sessionRecordToEvents({
      timestamp: "2026-09-14T01:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-1", secret: "hidden" },
    }, state);
    const completed = sessionRecordToEvents({
      timestamp: "2026-09-14T01:00:02.000Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "private answer" },
    }, state);

    expect(started[0]).toMatchObject({ type: "turn.started", sessionId: "thread-1", title: "robot" });
    expect(completed[0]).toMatchObject({ type: "turn.completed", sessionId: "thread-1" });
    expect(JSON.stringify([...started, ...completed])).not.toContain("hidden");
    expect(JSON.stringify([...started, ...completed])).not.toContain("private");
  });

  it("maps request_user_input to needs-input lifecycle events", () => {
    const state = context();
    sessionRecordToEvents({ type: "session_meta", payload: { id: "thread-2", cwd: "/tmp/project" } }, state);
    const requested = sessionRecordToEvents({
      type: "response_item",
      payload: { type: "function_call", name: "request_user_input", call_id: "call-7", arguments: "private" },
    }, state, 1_000);
    const resolved = sessionRecordToEvents({
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call-7", output: "private" },
    }, state, 2_000);

    expect(requested[0]?.type).toBe("input.requested");
    expect(resolved[0]?.type).toBe("input.resolved");
    expect(JSON.stringify([...requested, ...resolved])).not.toContain("private");
  });

  it("maps an aborted turn to a visible failure", () => {
    const state = context();
    sessionRecordToEvents({ type: "session_meta", payload: { id: "thread-3" } }, state);
    expect(sessionRecordToEvents({
      type: "event_msg",
      payload: { type: "turn_aborted", turn_id: "turn-3" },
    }, state, 3_000)[0]).toMatchObject({ type: "turn.failed", message: "任务已中断" });
  });

  it("closes an aborted task after its failure cue unless a new turn begins", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    try {
      const adapter = new CodexSessionEventAdapter("/unused");
      const events: string[] = [];
      adapter.subscribe((event) => events.push(`${event.sessionId}:${event.type}`));
      adapter["forward"]({ id: "a-failed", source: "codex-session-log", type: "turn.failed", sessionId: "a", occurredAt: Date.now() });
      adapter["forward"]({ id: "b-failed", source: "codex-session-log", type: "turn.failed", sessionId: "b", occurredAt: Date.now() });
      await vi.advanceTimersByTimeAsync(4_000);
      adapter["forward"]({ id: "b-restarted", source: "codex-session-log", type: "turn.started", sessionId: "b", occurredAt: Date.now() });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(events).toContain("a:session.closed");
      expect(events).not.toContain("b:session.closed");
      await adapter.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores Codex internal guardian sessions", () => {
    const state = context();
    sessionRecordToEvents({
      type: "session_meta",
      payload: { id: "guardian-1", cwd: "/tmp/project", source: { subagent: { other: "guardian" } } },
    }, state);
    expect(sessionRecordToEvents({
      type: "event_msg",
      payload: { type: "task_started", turn_id: "internal-turn" },
    }, state, 4_000)).toEqual([]);
  });

  it("keeps an unfinished startup record until the writer appends its newline", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentling-session-events-"));
    temporaryDirectories.push(root);
    const day = path.join(root, "2026", "09", "14");
    await fs.mkdir(day, { recursive: true });
    const file = path.join(day, "rollout.jsonl");
    await fs.writeFile(file, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-partial", cwd: "/tmp/robot" } }),
      '{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-partial"}',
    ].join("\n"));

    const adapter = new CodexSessionEventAdapter(root, 20);
    const events: string[] = [];
    adapter.subscribe((event) => events.push(event.type));
    await adapter.start();
    await fs.appendFile(file, "}\n");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await adapter.stop();

    expect(events).toContain("turn.started");
  });
});
