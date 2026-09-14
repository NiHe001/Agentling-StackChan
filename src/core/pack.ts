import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { behaviorSchema, motionSchema, packManifestSchema, uiConfigSchema } from "./schemas";
import { resolveLayout } from "./layout";
import type {
  BehaviorConfig,
  CompiledPack,
  MotionConfig,
  UiConfig,
} from "./types";

const REQUIRED_FILES = [
  "pack.yaml",
  "events.yaml",
  "behaviors.yaml",
  "motions.yaml",
  "sounds.yaml",
  "lights.yaml",
  "visuals.yaml",
  "ui.yaml",
] as const;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PACK_BYTES = 48 * 1024 * 1024;

export class PackValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Character pack is invalid:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
  }
}

async function readYaml(root: string, name: string): Promise<unknown> {
  return parse(await fs.readFile(path.join(root, name), "utf8"));
}

function namedMap(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const nested = record[key];
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : record;
}

function parseNamed<T>(
  value: unknown,
  key: string,
  parser: { safeParse(input: unknown): { success: boolean; data?: T; error?: { issues: Array<{ message: string; path: PropertyKey[] }> } } },
  issues: string[],
): Record<string, T> {
  const output: Record<string, T> = {};
  for (const [name, entry] of Object.entries(namedMap(value, key))) {
    const parsed = parser.safeParse(entry);
    if (!parsed.success || parsed.data === undefined) {
      for (const issue of parsed.error?.issues ?? []) {
        issues.push(`${key}.${name}.${issue.path.join(".")}: ${issue.message}`);
      }
    } else {
      output[name] = parsed.data;
    }
  }
  return output;
}

export async function compilePack(root: string): Promise<CompiledPack> {
  const absoluteRoot = await fs.realpath(root);
  const issues: string[] = [];
  const documents = new Map<string, unknown>();

  for (const file of REQUIRED_FILES) {
    try {
      documents.set(file, await readYaml(absoluteRoot, file));
    } catch (error) {
      issues.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (issues.length > 0) throw new PackValidationError(issues);

  const manifestResult = packManifestSchema.safeParse(documents.get("pack.yaml"));
  if (!manifestResult.success) {
    for (const issue of manifestResult.error.issues) {
      issues.push(`pack.yaml.${issue.path.join(".")}: ${issue.message}`);
    }
  }
  const uiResult = uiConfigSchema.safeParse(documents.get("ui.yaml"));
  if (!uiResult.success) {
    for (const issue of uiResult.error.issues) {
      issues.push(`ui.yaml.${issue.path.join(".")}: ${issue.message}`);
    }
  }

  const behaviors = parseNamed<BehaviorConfig>(
    documents.get("behaviors.yaml"),
    "behaviors",
    behaviorSchema,
    issues,
  );
  const motions = parseNamed<MotionConfig>(
    documents.get("motions.yaml"),
    "motions",
    motionSchema,
    issues,
  );
  const events = namedMap(documents.get("events.yaml"), "events") as Record<string, string>;
  const sounds = namedMap(documents.get("sounds.yaml"), "sounds") as Record<
    string,
    Record<string, unknown>
  >;
  const lights = namedMap(documents.get("lights.yaml"), "lights") as Record<
    string,
    Record<string, unknown>
  >;
  const visuals = namedMap(documents.get("visuals.yaml"), "visuals") as Record<
    string,
    Record<string, unknown>
  >;

  for (const [event, behavior] of Object.entries(events)) {
    if (typeof behavior !== "string" || !behaviors[behavior]) {
      issues.push(`events.${event}: unknown behavior '${String(behavior)}'`);
    }
  }
  for (const [name, behavior] of Object.entries(behaviors)) {
    let previousAt = -1;
    for (const step of behavior.steps) {
      if (step.at < previousAt) issues.push(`behaviors.${name}: steps must be ordered by 'at'`);
      if (step.motion && !motions[step.motion]) {
        issues.push(`behaviors.${name}: unknown motion '${step.motion}'`);
      }
      if (step.sound && !sounds[step.sound]) {
        issues.push(`behaviors.${name}: unknown sound '${step.sound}'`);
      }
      if (step.light && !lights[step.light]) {
        issues.push(`behaviors.${name}: unknown light '${step.light}'`);
      }
      if (step.expression && !visuals[step.expression]) {
        issues.push(`behaviors.${name}: unknown expression '${step.expression}'`);
      }
      previousAt = step.at;
    }
  }

  if (uiResult.success) validateLayouts(uiResult.data, issues);
  const files = await inventoryPackFiles(absoluteRoot, issues);
  const filePaths = new Set(files.map((file) => file.path));
  for (const [name, visual] of Object.entries(visuals)) {
    const renderer = visual.renderer;
    if (renderer === "png") {
      validateVisualAsset(name, "asset", visual.asset, filePaths, issues);
    } else if (renderer === "png_sequence") {
      if (!Array.isArray(visual.frames) || visual.frames.length < 2 || visual.frames.length > 16) {
        issues.push(`visuals.${name}.frames: PNG sequences require 2 to 16 frames`);
      } else {
        visual.frames.forEach((asset, index) =>
          validateVisualAsset(name, `frames.${index}`, asset, filePaths, issues),
        );
      }
      if (!Number.isInteger(visual.frameMs) || Number(visual.frameMs) < 120 || Number(visual.frameMs) > 10_000) {
        issues.push(`visuals.${name}.frameMs: expected an integer from 120 to 10000`);
      }
    }
  }
  if (issues.length > 0 || !manifestResult.success || !uiResult.success) {
    throw new PackValidationError(issues);
  }

  if (!uiResult.data.layouts[manifestResult.data.entryLayout]) {
    throw new PackValidationError([
      `pack.yaml.entryLayout: layout '${manifestResult.data.entryLayout}' does not exist`,
    ]);
  }

  return {
    manifest: manifestResult.data,
    ui: uiResult.data,
    events,
    behaviors,
    motions,
    sounds,
    lights,
    visuals,
    sourceDir: absoluteRoot,
    files,
  };
}

function validateVisualAsset(
  name: string,
  field: string,
  asset: unknown,
  filePaths: Set<string>,
  issues: string[],
): void {
  if (typeof asset !== "string" || !asset.startsWith("assets/sprites/")) {
    issues.push(`visuals.${name}.${field}: PNG visuals must reference assets/sprites`);
  } else if (!filePaths.has(asset)) {
    issues.push(`visuals.${name}.${field}: file '${asset}' does not exist`);
  }
}

function validateLayouts(ui: UiConfig, issues: string[]): void {
  for (const [layoutName, layout] of Object.entries(ui.layouts)) {
    const ids = new Set<string>();
    for (const widget of layout.widgets ?? []) {
      if (ids.has(widget.id)) issues.push(`ui.layouts.${layoutName}: duplicate widget '${widget.id}'`);
      ids.add(widget.id);
      if (widget.rect.x + widget.rect.width > ui.canvas.width) {
        issues.push(`ui.layouts.${layoutName}.${widget.id}: exceeds canvas width`);
      }
      if (widget.rect.y + widget.rect.height > ui.canvas.height) {
        issues.push(`ui.layouts.${layoutName}.${widget.id}: exceeds canvas height`);
      }
      if (widget.bind && !/^(usage|clock|weather|agent|overlay)\./.test(widget.bind)) {
        issues.push(`ui.layouts.${layoutName}.${widget.id}: unsupported binding '${widget.bind}'`);
      }
    }
    if (layout.extends && !ui.layouts[layout.extends]) {
      issues.push(`ui.layouts.${layoutName}: extends unknown layout '${layout.extends}'`);
    }
    try {
      resolveLayout(ui, layoutName);
    } catch (error) {
      issues.push(`ui.layouts.${layoutName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function inventoryPackFiles(
  root: string,
  issues: string[],
): Promise<Array<{ path: string; size: number; sha256: string }>> {
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  let total = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        issues.push(`${path.relative(root, absolute)}: symbolic links are not allowed`);
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const content = await fs.readFile(absolute);
      if (content.length > MAX_FILE_BYTES) issues.push(`${relative}: exceeds 8 MiB file limit`);
      total += content.length;
      files.push({
        path: relative,
        size: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
  };
  await visit(root);
  if (total > MAX_PACK_BYTES) issues.push("pack exceeds 48 MiB total size limit");
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function saveUiConfig(packDir: string, ui: UiConfig): Promise<void> {
  const parsed = uiConfigSchema.parse(ui);
  const temporary = path.join(packDir, ".ui.yaml.tmp");
  const target = path.join(packDir, "ui.yaml");
  await fs.writeFile(temporary, stringify(parsed, { lineWidth: 100 }), "utf8");
  await fs.rename(temporary, target);
}
