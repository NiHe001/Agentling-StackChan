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
