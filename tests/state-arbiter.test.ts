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
    expect(arbiter.tick(11_001).tasks[0]?.state).toBe("idle");
  });
});
