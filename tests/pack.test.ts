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
  it("compiles original PNG sequences and motion-free Codex behaviors", async () => {
    const pack = await compilePack(path.resolve("packs/byte-otter"));
    expect(pack.manifest.id).toBe("agentling.byte_otter");
    expect(pack.files.filter((file) => file.path.startsWith("assets/sprites/")).length).toBe(12);
    expect(pack.visuals.working).toMatchObject({ renderer: "png_sequence", frameMs: 360 });
    expect(pack.visuals.working?.frames).toHaveLength(4);
    expect(pack.behaviors.focus?.loop).toBe(true);
    expect(Object.values(pack.behaviors).flatMap((behavior) => behavior.steps).every((step) => !step.motion)).toBe(true);
    expect(pack.events["approval.requested"]).toBe("attention");
    expect(pack.events["tool.completed"]).toBe("focus");
    expect(pack.events["approval.resolved"]).toBe("focus");
  });
});
