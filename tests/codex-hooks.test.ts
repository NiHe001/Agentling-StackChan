import { describe, expect, it } from "vitest";
import { CodexHookAdapter } from "../src/main/adapters/codex-hooks";

describe("CodexHookAdapter", () => {
  it("maps official hook names without forwarding prompt or tool payloads", () => {
    const adapter = new CodexHookAdapter();
    const event = adapter.handleRaw({ hook_event_name: "PreToolUse", session_id: "abc", cwd: "/tmp/project", tool_name: "Bash", tool_input: { command: "secret" }, prompt: "private" }, 10_000);
    expect(event).toMatchObject({ type: "tool.started", sessionId: "abc", tool: "Bash" });
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(JSON.stringify(event)).not.toContain("private");
  });

  it("ignores unknown hook events for forward compatibility", () => {
    const adapter = new CodexHookAdapter();
    expect(adapter.handleRaw({ hook_event_name: "FutureEvent" })).toBeNull();
  });

  it("generates a stable id when Codex retries the same timestamped hook", () => {
    const adapter = new CodexHookAdapter();
    const raw = { hook_event_name: "PreToolUse", session_id: "abc", tool_use_id: "tool-7", timestamp: 1_700_000_000 };
    expect(adapter.handleRaw(raw, 10_000)?.id).toBe(adapter.handleRaw(raw, 20_000)?.id);
  });
});
