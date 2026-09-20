import { describe, expect, it } from "vitest";
import {
  lightSetRequestSchema,
  servoMoveRequestSchema,
  soundPlayRequestSchema,
} from "../src/core/schemas";

describe("hardware command safety schemas", () => {
  it("applies bounded light defaults", () => {
    expect(lightSetRequestSchema.parse({ color: "#49BFFF" })).toEqual({
      color: "#49BFFF",
      brightness: 40,
      mode: "solid",
      periodMs: 1_200,
      ttlMs: 10_000,
    });
    expect(() => lightSetRequestSchema.parse({ color: "red" })).toThrow();
    expect(() => lightSetRequestSchema.parse({ color: "#ffffff", brightness: 81 })).toThrow();
  });

  it("limits sound volume and duration", () => {
    expect(soundPlayRequestSchema.parse({ preset: "complete" })).toMatchObject({
      volumePercent: 25,
      maxDurationMs: 1_500,
    });
    expect(() => soundPlayRequestSchema.parse({ preset: "../tone" })).toThrow();
    expect(() => soundPlayRequestSchema.parse({ preset: "complete", volumePercent: 51 })).toThrow();
  });

  it("keeps servo commands inside the reduced operating envelope", () => {
    expect(servoMoveRequestSchema.parse({ yawDegrees: -15, pitchDegrees: 8 })).toMatchObject({
      speedPercent: 25,
      holdMs: 700,
    });
    expect(() => servoMoveRequestSchema.parse({ yawDegrees: 31, pitchDegrees: 8 })).toThrow();
    expect(() => servoMoveRequestSchema.parse({ yawDegrees: 0, pitchDegrees: -1 })).toThrow();
    expect(() => servoMoveRequestSchema.parse({ yawDegrees: 0, pitchDegrees: 10, speedPercent: 60 })).toThrow();
  });
});
