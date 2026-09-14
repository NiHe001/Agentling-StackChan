#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const endpoint = process.env.AGENTLING_ENDPOINT || "http://127.0.0.1:17321";
const token = process.env.AGENTLING_TOKEN;

async function call(path: string, body?: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${endpoint}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const result = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(result.error || `Agentling HTTP ${response.status}`);
  return result;
}

const server = new McpServer({ name: "agentling-stackchan", version: "0.1.0" });
server.registerTool("agentling_layout_save", { description: "Validate and save the selected pack's complete ui.yaml layout. Read its current ui via agentling_status first; hardware changes require pack_sync.", inputSchema: { ui: z.record(z.unknown()) } }, async ({ ui }) => ({ content: [{ type: "text", text: JSON.stringify(await call("/v1/layout/save", { ui })) }] }));

for (const [name, route, description] of [
  ["status", "/v1/snapshot", "Read desktop state, selected pack, agent and usage information."],
  ["list_ports", "/v1/device/ports", "List available serial devices."],
  ["diagnostics", "/v1/device/diagnostics", "Read live firmware, active pack, storage and PNG rendering diagnostics."],
] as const) server.registerTool(`agentling_${name}`, { description, inputSchema: {} }, async () => ({ content: [{ type: "text", text: JSON.stringify(await call(route)) }] }));

for (const action of ["validate", "load"] as const) server.registerTool(`agentling_pack_${action}`, {
  description: action === "validate" ? "Validate a local character directory without changing the app." : "Select a local character pack in the running desktop app; does not sync hardware.",
  inputSchema: { directory: z.string().min(1) },
}, async ({ directory }) => ({ content: [{ type: "text", text: JSON.stringify(await call(`/v1/pack/${action}`, { directory })) }] }));

server.registerTool("agentling_connect", { description: "Connect to an available serial port.", inputSchema: { path: z.string().min(1) } }, async ({ path }) => ({ content: [{ type: "text", text: JSON.stringify(await call("/v1/device/connect", { path })) }] }));
for (const [name, route] of [["disconnect", "/v1/device/disconnect"], ["pack_sync", "/v1/pack/sync"]] as const) server.registerTool(`agentling_${name}`, { description: name === "disconnect" ? "Disconnect the robot." : "Atomically sync the selected pack to internal flash and return device diagnostics. May take up to two minutes.", inputSchema: {} }, async () => ({ content: [{ type: "text", text: JSON.stringify(await call(route, {})) }] }));

server.registerTool(
  "agentling_show",
  {
    title: "Show a temporary StackChan expression",
    description:
      "Shows a short-lived expression and optional short text. It cannot override offline, failure, or approval states.",
    inputSchema: {
      scene: z.string().min(1).max(40),
      text: z.string().max(80).optional(),
      ttl_ms: z.number().int().min(5_000).max(30_000).default(10_000),
    },
  },
  async ({ scene, text, ttl_ms }) => {
    await call("/v1/expression", { scene, text, ttlMs: ttl_ms });
    return { content: [{ type: "text", text: `Temporary scene '${scene}' requested; real lifecycle priority still applies.` }] };
  },
);

server.registerTool(
  "agentling_progress",
  {
    title: "Show temporary task progress",
    description: "Shows a non-authoritative progress overlay while the real lifecycle state remains visible.",
    inputSchema: {
      stage: z.string().min(1).max(40),
      current: z.number().nonnegative(),
      total: z.number().positive(),
      ttl_ms: z.number().int().min(5_000).max(30_000).default(10_000),
    },
  },
  async ({ stage, current, total, ttl_ms }) => {
    await call("/v1/progress", { stage, current, total, ttlMs: ttl_ms });
    return { content: [{ type: "text", text: `StackChan progress '${stage}' was updated.` }] };
  },
);

server.registerTool(
  "agentling_clear",
  {
    title: "Clear the temporary StackChan expression",
    description: "Clears only the MCP expression layer; authoritative Agent status is unchanged.",
    inputSchema: {},
  },
  async () => {
    await call("/v1/clear", {});
    return { content: [{ type: "text", text: "Temporary StackChan expression cleared." }] };
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main().catch((error) => {
  process.stderr.write(`Agentling MCP failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
