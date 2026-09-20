import { describe, expect, it } from "vitest";
import { DeviceEventQueue } from "../src/core/device-events";

describe("device event queue", () => {
  it("assigns monotonic ids and filters after a cursor", () => {
    const queue = new DeviceEventQueue();
    const tap = queue.push({ type: "tap", source: "screen", at: 10 }, 100);
    const shake = queue.push({ type: "shake", source: "imu", at: 20 }, 200);

    expect(tap.id).toBe(1);
    expect(shake.id).toBe(2);
    expect(queue.findAfter(tap.id, ["shake"])).toEqual(shake);
    expect(queue.findAfter(shake.id)).toBeUndefined();
    expect(queue.latestId()).toBe(2);
  });

  it("bounds retained history without reusing ids", () => {
    const queue = new DeviceEventQueue(2);
    queue.push({ type: "first" });
    queue.push({ type: "second" });
    queue.push({ type: "third" });

    expect(queue.findAfter(0)?.type).toBe("second");
    expect(queue.latestId()).toBe(3);
  });
});
