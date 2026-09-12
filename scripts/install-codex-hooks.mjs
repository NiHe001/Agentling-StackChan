#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const hookScript = path.join(root, "scripts", "codex-hook.mjs");
const codexDir = path.join(os.homedir(), ".codex");
const target = path.join(codexDir, "hooks.json");
const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(hookScript)}`;
const events = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Stop",
  "Interrupt",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
];

await mkdir(codexDir, { recursive: true });
let document = { hooks: {} };
if (existsSync(target)) {
  document = JSON.parse(await readFile(target, "utf8"));
  await writeFile(`${target}.agentling-backup-${Date.now()}`, JSON.stringify(document, null, 2));
}
document.hooks ||= {};
for (const event of events) {
  const definitions = Array.isArray(document.hooks[event]) ? document.hooks[event] : [];
  const alreadyInstalled = definitions.some((definition) =>
    definition?.hooks?.some((hook) => String(hook.command || "").includes("codex-hook.mjs")),
  );
  if (!alreadyInstalled) {
    definitions.push({
      hooks: [
        {
          type: "command",
          command,
          timeout: event === "SessionEnd" ? 2 : 3,
          ...(event === "SessionEnd" ? {} : { async: true }),
        },
      ],
    });
  }
  document.hooks[event] = definitions;
}
const temporary = `${target}.tmp`;
await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
await rename(temporary, target);
process.stdout.write(
  `Installed Agentling observers in ${target}\nReview and trust the new hooks in Codex before use.\n`,
);
