import { promises as fs } from "node:fs";
import path from "node:path";
import { compilePack } from "../core/pack";

export interface PackOption {
  sourceDir: string;
  id: string;
  name: string;
  version: string;
}

export async function listPackOptions(bundledPacksDir: string, savedDirs: string[]): Promise<PackOption[]> {
  const bundled = await fs.readdir(bundledPacksDir, { withFileTypes: true });
  const candidates = [
    ...bundled.filter((entry) => entry.isDirectory()).map((entry) => path.join(bundledPacksDir, entry.name)),
    ...savedDirs,
  ];
  const options = await Promise.all(candidates.map(async (directory) => {
    try {
      const pack = await compilePack(directory);
      return {
        sourceDir: pack.sourceDir,
        id: pack.manifest.id,
        name: pack.manifest.name,
        version: pack.manifest.version,
      };
    } catch {
      // A removed or broken saved pack should not block the picker itself.
      return null;
    }
  }));
  return [...new Map(options.filter((option): option is PackOption => option !== null)
    .map((option) => [option.sourceDir, option])).values()];
}
