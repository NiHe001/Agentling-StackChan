import path from "node:path";
import { describe, expect, it } from "vitest";
import { compilePack } from "../src/core/pack";
import { resolveLayout } from "../src/core/layout";

describe("default character pack", () => {
  it("compiles, resolves inheritance, and keeps widgets inside the canvas", async () => {
    const pack = await compilePack(path.resolve("packs/default"));
    expect(pack.manifest.id).toBe("agentling.default");
    const critical = resolveLayout(pack.ui, "critical");
    expect(critical.find((widget) => widget.id === "quota_5h")?.visible).toBe(false);
    for (const widget of resolveLayout(pack.ui, "base")) {
      expect(widget.rect.x + widget.rect.width).toBeLessThanOrEqual(320);
      expect(widget.rect.y + widget.rect.height).toBeLessThanOrEqual(240);
      expect(widget.zIndex ?? 0).toBeLessThan(900);
    }
  });
});

describe("Byte Otter character pack", () => {
  it("compiles state-led micro motion and a readable small-screen layout", async () => {
    const pack = await compilePack(path.resolve("packs/byte-otter"));
    expect(pack.manifest.id).toBe("agentling.byte_otter");
    expect(pack.files.filter((file) => file.path.startsWith("assets/sprites/")).length).toBe(12);
    expect(pack.visuals.working).toMatchObject({ renderer: "png", animation: "focus" });
    expect(pack.visuals.waiting_approval).toMatchObject({ renderer: "png", animation: "attention" });
    expect(pack.visuals.blink).toMatchObject({ renderer: "png", animation: "ambient" });
    expect(pack.behaviors.focus?.steps.every((step) => step.expression === "working")).toBe(true);
    const base = resolveLayout(pack.ui, "base");
    expect(base.find((widget) => widget.id === "status")).toMatchObject({
      props: { mode: "headline" },
      style: { fontSize: 24 },
    });
    expect(base.find((widget) => widget.id === "quota_5h")?.style?.fontSize).toBeGreaterThanOrEqual(14);
    expect(pack.behaviors.focus?.loop).toBe(true);
    expect(Object.values(pack.behaviors).flatMap((behavior) => behavior.steps).every((step) => !step.motion)).toBe(true);
    expect(pack.events["approval.requested"]).toBe("attention");
    expect(pack.events["tool.completed"]).toBe("focus");
    expect(pack.events["approval.resolved"]).toBe("focus");
  });
});

describe("Luma virtual character pack", () => {
  it("compiles distinct task states for the device screen", async () => {
    const pack = await compilePack(path.resolve("packs/luma"));
    expect(pack.manifest.id).toBe("agentling.luma");
    expect(pack.files.filter((file) => file.path.startsWith("assets/sprites/"))).toHaveLength(9);
    expect(pack.visuals.working?.asset).toBe("assets/sprites/working.png");
    expect(pack.visuals.waiting_approval?.asset).toBe("assets/sprites/approval.png");
    expect(pack.visuals.waiting?.asset).toBe("assets/sprites/needs-input.png");
    expect(pack.events["input.requested"]).toBe("input_attention");
    expect(pack.behaviors.input_attention?.steps[0]?.expression).toBe("needs_input");
    expect(pack.visuals.failed?.asset).toBe("assets/sprites/failed.png");
    expect(pack.visuals.offline?.asset).toBe("assets/sprites/offline.png");
    expect(Object.values(pack.behaviors).flatMap((behavior) => behavior.steps).every((step) => !step.motion)).toBe(true);
  });
});
