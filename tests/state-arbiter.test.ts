import { describe, expect, it } from "vitest";
import { StateArbiter } from "../src/core/state-arbiter";
import type { CanonicalEvent, CanonicalEventType } from "../src/core/types";

function event(type: CanonicalEventType, sessionId: string, at: number, sequence = 1): CanonicalEvent {
  return { id: `${sessionId}-${type}-${sequence}`, source: "codex", type, sessionId, occurredAt: at, sequence };
}

describe("StateArbiter", () => {
  it("prioritizes failures and approvals over ordinary work", () => {
    const arbiter = new StateArbiter();
    arbiter.apply(event("turn.started", "working", 1_000));
    arbiter.apply(event("approval.requested", "approval", 1_100));
    expect(arbiter.snapshot().aggregateState).toBe("waiting_approval");
    expect(arbiter.snapshot().activeTaskId).toBe("approval");
    arbiter.apply(event("turn.failed", "failed", 1_200, 2));
    expect(arbiter.snapshot().aggregateState).toBe("failed");
    expect(arbiter.snapshot().activeTaskId).toBe("failed");
  });

  it("ignores duplicate and stale sequenced events", () => {
    const arbiter = new StateArbiter();
    arbiter.apply(event("turn.completed", "task", 2_000, 5));
    arbiter.apply(event("turn.started", "task", 3_000, 4));
    expect(arbiter.snapshot().tasks[0]?.state).toBe("completed");
  });

  it("never exposes an MCP overlay over a critical state", () => {
    const arbiter = new StateArbiter();
    arbiter.setOverlay({ scene: "celebrating", createdAt: 1_000, expiresAt: 20_000 });
    arbiter.apply(event("approval.requested", "task", 2_000));
    expect(arbiter.getOverlay(3_000)).toBeNull();
    arbiter.apply(event("approval.resolved", "task", 4_000, 2));
    expect(arbiter.getOverlay(4_001)).toBeNull();
  });

  it("expires completed state and overlays deterministically", () => {
    const arbiter = new StateArbiter();
    arbiter.apply(event("turn.completed", "task", 1_000));
    arbiter.setOverlay({ scene: "happy", createdAt: 1_000, expiresAt: 2_000 });
    expect(arbiter.getOverlay(2_001)).toBeNull();
    expect(arbiter.tick(5_001).tasks[0]?.state).toBe("idle");
  });

  it("returns to another working task after a completion or failure is shown", () => {
    const arbiter = new StateArbiter();
    arbiter.apply(event("turn.started", "long-running", 1_000));
    arbiter.apply(event("turn.completed", "short", 2_000));
    expect(arbiter.snapshot(2_001).aggregateState).toBe("working");
    arbiter.apply(event("turn.failed", "failed", 3_000));
    expect(arbiter.snapshot(3_001)).toMatchObject({ aggregateState: "failed", activeTaskId: "failed" });
    expect(arbiter.tick(11_001)).toMatchObject({ aggregateState: "working", activeTaskId: "long-running" });
    expect(arbiter.snapshot(11_001).reports[0]?.state).toBe("failed");
  });

  it("keeps a newest-first task report timeline with useful tool labels", () => {
    const arbiter = new StateArbiter();
    arbiter.apply({ ...event("turn.started", "task", 1_000), title: "角色包升级" });
    arbiter.apply({ ...event("tool.started", "task", 2_000, 2), title: "角色包升级", tool: "exec_command" });
    const snapshot = arbiter.snapshot(2_001);
    expect(snapshot.tasks[0]).toMatchObject({ title: "角色包升级", message: "终端命令进行中", currentTool: "exec_command" });
    expect(snapshot.reports.slice(0, 2).map((report) => report.message)).toEqual(["终端命令进行中", "开始处理"]);
  });

  it("shows an unavailable status source as offline until it reconnects", () => {
    const arbiter = new StateArbiter();
    arbiter.apply(event("turn.started", "task", 1_000));
    arbiter.apply({ ...event("source.disconnected", "source", 2_000), source: "codex-session-log" });
    expect(arbiter.snapshot().aggregateState).toBe("offline");
    arbiter.apply({ ...event("source.connected", "source", 3_000, 2), source: "codex-session-log" });
    expect(arbiter.snapshot().aggregateState).toBe("working");
  });

  it("distinguishes waiting for input from waiting for approval", () => {
    const arbiter = new StateArbiter();
    arbiter.apply(event("turn.started", "task", 1_000));
    arbiter.apply(event("input.requested", "task", 2_000, 2));
    expect(arbiter.snapshot().tasks[0]).toMatchObject({ state: "needs_input", message: "等待你的输入" });
    arbiter.apply(event("input.resolved", "task", 3_000, 3));
    expect(arbiter.snapshot().tasks[0]?.state).toBe("working");
  });
});
