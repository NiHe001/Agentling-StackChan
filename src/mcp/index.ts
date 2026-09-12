#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const endpoint = process.env.AGENTLING_ENDPOINT || "http://127.0.0.1:17321";
const token = process.env.AGENTLING_TOKEN;

async function call(path: string, body: Record<string, unknown> = {}): Promise<unknown> {
  const response = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2_000),
  });
  const result = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(result.error || `Agentling HTTP ${response.status}`);
  return result;
}

const server = new McpServer({ name: "agentling-stackchan", version: "0.1.0" });

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
    return { content: [{ type: "text", text: `StackChan scene '${scene}' is visible temporarily.` }] };
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
    await call("/v1/clear");
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
