import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_HOST_CONFIG } from "../src/main/config";
import { listPackOptions } from "../src/main/pack-library";
import { AgentlingRuntime } from "../src/main/runtime";
import { packContentDigest } from "../src/main/services/device";

const bundledDir = path.resolve("packs");
const otterDir = path.join(bundledDir, "byte-otter");
const defaultDir = path.join(bundledDir, "default");
const lumaDir = path.join(bundledDir, "luma");

describe("character pack switching", () => {
  it("uses file contents, not just the pack version, as the cache identity", () => {
    const oldFiles = [{ path: "assets/sprites/idle.png", size: 10, sha256: "a".repeat(64) },
      { path: "pack.runtime.json", size: 20, sha256: "b".repeat(64) }];
    const digest = packContentDigest(oldFiles);
    expect(packContentDigest([...oldFiles].reverse())).toBe(digest);
    expect(packContentDigest([{ ...oldFiles[0]!, sha256: "c".repeat(64) }, oldFiles[1]!])).not.toBe(digest);
  });

  it("lists bundled and saved packs without duplicates or missing directories", async () => {
    const options = await listPackOptions(bundledDir, [otterDir, "/missing/agentling-pack"]);
    expect(options.map((option) => option.sourceDir).sort()).toEqual([defaultDir, otterDir, lumaDir].sort());
    expect(options.find((option) => option.sourceDir === otterDir)?.name).toBeTruthy();
  });

  it("activates a pack only after the device accepts it", async () => {
    const runtime = new AgentlingRuntime(structuredClone(DEFAULT_HOST_CONFIG), otterDir);
    await runtime.loadPack(otterDir);
    const sync = vi.spyOn(runtime.device, "syncPack").mockRejectedValueOnce(new Error("device rejected pack"));

    await expect(runtime.applyPack(defaultDir)).rejects.toThrow("device rejected pack");
    expect(runtime.snapshot().pack?.sourceDir).toBe(otterDir);

    sync.mockResolvedValueOnce();
    await runtime.applyPack(defaultDir);
    expect(sync).toHaveBeenLastCalledWith(expect.objectContaining({ sourceDir: defaultDir }));
    expect(runtime.snapshot().pack?.sourceDir).toBe(defaultDir);
  });
});
