import { describe, expect, it, vi } from "vitest";
import type { CanonicalEvent, CanonicalEventType, CompiledPack } from "../src/core/types";
import { DEFAULT_HOST_CONFIG } from "../src/main/config";
import { AgentlingRuntime } from "../src/main/runtime";

function event(type: CanonicalEventType, sessionId: string, sequence: number): CanonicalEvent {
  return { id: `${sessionId}-${sequence}`, source: "codex", type, sessionId, sequence, occurredAt: Date.now() + sequence };
}

describe("AgentlingRuntime cues", () => {
  it("shows a completion after publishing the still-working state, while keeping critical tasks in front", () => {
    const runtime = new AgentlingRuntime(DEFAULT_HOST_CONFIG, "");
    runtime["pack"] = {
      events: { "turn.started": "focus", "turn.completed": "celebrate", "approval.requested": "attention" },
    } as unknown as CompiledPack;
    const sent: string[] = [];
    vi.spyOn(runtime.device, "sendAgentSnapshot").mockImplementation(() => sent.push("snapshot"));
    vi.spyOn(runtime.device, "sendActionCue").mockImplementation((cue) => sent.push(cue.behavior || "other"));
    const working = vi.spyOn(runtime.usageProvider, "setWorking");

    runtime["handleCanonicalEvent"](event("turn.started", "first", 1));
    runtime["handleCanonicalEvent"](event("turn.started", "second", 2));
    sent.length = 0;
    runtime["handleCanonicalEvent"](event("turn.completed", "first", 3));
    expect(runtime.arbiter.snapshot().aggregateState).toBe("working");
    expect(sent).toEqual(["snapshot", "celebrate"]);
    expect(working).toHaveBeenLastCalledWith(true);

    runtime["handleCanonicalEvent"](event("turn.started", "third", 4));
    runtime["handleCanonicalEvent"](event("approval.requested", "second", 5));
    sent.length = 0;
    runtime["handleCanonicalEvent"](event("turn.completed", "third", 6));
    expect(runtime.arbiter.snapshot().aggregateState).toBe("waiting_approval");
    expect(sent).toEqual(["snapshot"]);

    runtime["handleCanonicalEvent"](event("approval.resolved", "second", 7));
    runtime.showExpression({ scene: "curious", ttlMs: 10_000 });
    sent.length = 0;
    runtime["handleCanonicalEvent"](event("turn.started", "fourth", 8));
    expect(sent).toEqual(["snapshot", "other", "focus"]);
  });
});
