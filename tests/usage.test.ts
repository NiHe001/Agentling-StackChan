import { describe, expect, it } from "vitest";
import { UsageAlertTracker, UsageStore } from "../src/core/usage";
import type { UsageWindow } from "../src/core/types";

describe("UsageStore", () => {
  it("derives remaining values and resolves windows by duration, not array order", () => {
    const store = new UsageStore();
    store.replace(
      {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 78, windowDurationMins: 10_080, resetsAt: 9_000 },
          secondary: { usedPercent: 21, windowDurationMins: 300, resetsAt: 3_000 },
        },
      },
      1_000,
    );
    const snapshot = store.snapshot(undefined, 1_001);
    const fiveHour = snapshot.windows.find((window) => window.id === snapshot.aliases.five_hour);
    const weekly = snapshot.windows.find((window) => window.id === snapshot.aliases.weekly);
    expect(fiveHour?.remainingPercent).toBe(79);
    expect(weekly?.remainingPercent).toBe(22);
  });

  it("merges sparse notifications without clearing known duration and reset", () => {
    const store = new UsageStore();
    store.replace({ rateLimits: { limitId: "codex", limitName: "Codex", primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 9_999 }, secondary: null } }, 1_000);
    store.merge({ rateLimits: { limitId: "codex", limitName: null, primary: { usedPercent: 25, windowDurationMins: null, resetsAt: null }, secondary: null } }, 2_000);
    const window = store.snapshot(undefined, 2_001).windows[0];
    expect(window).toMatchObject({ label: "Codex", remainingPercent: 75, windowDurationMins: 300, resetsAt: 9_999 });
  });

  it("clamps bad backend percentages and marks old snapshots stale", () => {
    const store = new UsageStore();
    store.replace({ rateLimits: { limitId: "codex", primary: { usedPercent: 140, windowDurationMins: 300, resetsAt: null }, secondary: null } }, 1_000);
    const snapshot = store.snapshot(undefined, 700_001);
    expect(snapshot.windows[0]?.remainingPercent).toBe(0);
    expect(snapshot.status).toBe("stale");
  });

  it("merges sparse updates into the addressed limit without corrupting other buckets", () => {
    const store = new UsageStore();
    store.replace({
      rateLimits: { limitId: "legacy", primary: null, secondary: null },
      rateLimitsByLimitId: {
        codex: { limitId: "codex", primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 100 }, secondary: null },
        review: { limitId: "review", primary: { usedPercent: 30, windowDurationMins: 1440, resetsAt: 200 }, secondary: null },
      },
    }, 1_000);
    store.merge({ rateLimits: { limitId: "review", primary: { usedPercent: 35, windowDurationMins: null, resetsAt: null }, secondary: null } }, 2_000);
    const snapshot = store.snapshot(undefined, 2_001);
    expect(snapshot.windows.find((window) => window.limitId === "codex")?.remainingPercent).toBe(90);
    expect(snapshot.windows.find((window) => window.limitId === "review")).toMatchObject({
      remainingPercent: 65,
      windowDurationMins: 1440,
      resetsAt: 200,
    });
  });
});

describe("UsageAlertTracker", () => {
  const window = (remaining: number): UsageWindow => ({ id: "codex:primary", limitId: "codex", role: "primary", label: "5H", remainingPercent: remaining, resetsAt: null, windowDurationMins: 300, stale: false });

  it("uses threshold crossings and recovery hysteresis", () => {
    const tracker = new UsageAlertTracker();
    expect(tracker.update(window(29))).toBe("low");
    expect(tracker.update(window(28))).toBeNull();
    expect(tracker.update(window(9))).toBe("critical");
    expect(tracker.update(window(12))).toBeNull();
    expect(tracker.update(window(16))).toBe("low");
    expect(tracker.update(window(36))).toBe("normal");
  });
});
