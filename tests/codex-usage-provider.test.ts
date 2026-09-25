import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexUsageProvider } from "../src/main/providers/codex-usage";

afterEach(() => vi.useRealTimers());

describe("CodexUsageProvider", () => {
  it("refreshes more often during work and returns to the idle interval", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null },
        secondary: null,
      },
    }));
    const provider = new CodexUsageProvider({ enabled: true, refreshMs: 60_000 });
    provider["client"] = { request, stop: vi.fn() } as unknown as NonNullable<typeof provider["client"]>;
    await provider.start();
    expect(request).toHaveBeenCalledTimes(1);

    provider.setWorking(true);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(request).toHaveBeenCalledTimes(3);

    provider.setWorking(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(request).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(request).toHaveBeenCalledTimes(4);
    await provider.stop();
  });
});
