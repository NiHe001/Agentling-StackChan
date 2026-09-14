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

  it("keeps ordinal sequence numbers separate from second-based timestamps", () => {
    const adapter = new CodexHookAdapter();
    const event = adapter.handleRaw({ hook_event_name: "UserPromptSubmit", session_id: "abc", sequence: 7, timestamp: 1_700_000_000 }, 10_000);
    expect(event).toMatchObject({ sequence: 7, occurredAt: 1_700_000_000_000 });
  });

  it("accepts a short one-line completion report without forwarding the transcript", () => {
    const adapter = new CodexHookAdapter();
    const event = adapter.handleRaw({
      hook_event_name: "Stop",
      session_id: "abc",
      last_assistant_message: "测试通过。\n已同步到机器人。",
      transcript_path: "/private/full-history.jsonl",
    }, 10_000);
    expect(event?.message).toBe("测试通过。 已同步到机器人。");
    expect(JSON.stringify(event)).not.toContain("full-history");
  });
});
