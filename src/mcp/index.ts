#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const endpoint = process.env.AGENTLING_ENDPOINT || "http://127.0.0.1:17321";
const token = process.env.AGENTLING_TOKEN;

async function call(path: string, body?: Record<string, unknown>, timeoutMs = 120_000): Promise<unknown> {
  const response = await fetch(`${endpoint}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
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

server.registerTool("agentling_sensor_snapshot", {
  title: "Read StackChan sensors",
  description: "Read one live, read-only snapshot of battery, IMU, ambient/proximity and touch sensors. Does not enable the camera or microphone.",
  inputSchema: {},
}, async () => ({ content: [{ type: "text", text: JSON.stringify(await call("/v1/device/sensors")) }] }));

server.registerTool("agentling_wait_for_event", {
  title: "Wait for a physical StackChan event",
  description: "Wait for a new physical screen/head-touch or shake event. Omit after_id to wait only for events that occur after this call starts.",
  inputSchema: {
    types: z.array(z.string().min(1).max(48)).max(16).optional(),
    after_id: z.number().int().nonnegative().optional(),
    timeout_ms: z.number().int().min(0).max(30_000).default(15_000),
  },
}, async ({ types, after_id, timeout_ms }) => ({ content: [{
  type: "text",
  text: JSON.stringify(await call("/v1/device/events/wait", { types, afterId: after_id, timeoutMs: timeout_ms })),
}] }));

server.registerTool("agentling_camera_capture", {
  title: "Request a confirmed StackChan photo",
  description: "Ask the user to confirm a one-shot photo on the StackChan screen. The camera remains off unless the user taps the explicit confirm button; the JPEG is saved to a private temporary local file.",
  inputSchema: {},
}, async () => ({ content: [{
  type: "text",
  text: JSON.stringify(await call("/v1/device/camera/capture", {})),
}] }));

server.registerTool("agentling_light_set", {
  title: "Set StackChan RGB lights",
  description: "Temporarily set all 12 RGB LEDs. A real lifecycle behavior may take priority, and the previous light state is restored when TTL expires.",
  inputSchema: {
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    brightness: z.number().int().min(0).max(80).default(40),
    mode: z.enum(["solid", "breathe", "pulse", "chase"]).default("solid"),
    period_ms: z.number().int().min(300).max(5_000).default(1_200),
    ttl_ms: z.number().int().min(1_000).max(30_000).default(10_000),
  },
}, async ({ color, brightness, mode, period_ms, ttl_ms }) => ({ content: [{
  type: "text",
  text: JSON.stringify(await call("/v1/device/light", {
    color, brightness, mode, periodMs: period_ms, ttlMs: ttl_ms,
  })),
}] }));

server.registerTool("agentling_sound_play", {
  title: "Play a StackChan sound preset",
  description: "Play one preset from the active character pack. Volume is capped at 50% and total playback at 3 seconds.",
  inputSchema: {
    preset: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/).max(48),
    volume_percent: z.number().int().min(0).max(50).default(25),
    max_duration_ms: z.number().int().min(100).max(3_000).default(1_500),
  },
}, async ({ preset, volume_percent, max_duration_ms }) => ({ content: [{
  type: "text",
  text: JSON.stringify(await call("/v1/device/sound", {
    preset, volumePercent: volume_percent, maxDurationMs: max_duration_ms,
  })),
}] }));

server.registerTool("agentling_servo_move", {
  title: "Move the StackChan head",
  description: "Move once using the official spring animation. Yaw -30..30 degrees, pitch 0..20, speed 10..50 percent. Waits for valid feedback and animation/servo stop, holds briefly, then releases torque and power. Returns measuredBeforeRelease; completion does not guarantee exact target angles. No automatic return home. Use yaw=0 pitch=0 explicitly for the default pose. Failed feedback aborts movement.",
  inputSchema: {
    yaw_degrees: z.number().min(-30).max(30),
    pitch_degrees: z.number().min(0).max(20),
    speed_percent: z.number().int().min(10).max(50).default(25),
    hold_ms: z.number().int().min(300).max(2_000).default(700),
  },
}, async ({ yaw_degrees, pitch_degrees, speed_percent, hold_ms }) => ({ content: [{
  type: "text",
  text: JSON.stringify(await call("/v1/device/servo", {
    yawDegrees: yaw_degrees, pitchDegrees: pitch_degrees, speedPercent: speed_percent, holdMs: hold_ms,
  })),
}] }));

server.registerTool("agentling_servo_recover_home", {
  title: "Legacy servo recovery (removed)",
  description: "Deprecated compatibility endpoint; always rejects. Automatic recovery was removed. After hardware validation, use a normal movement to yaw=0 and pitch=0 for the default pose.",
  inputSchema: {},
}, async () => ({ content: [{
  type: "text",
  text: JSON.stringify(await call("/v1/device/servo/home", {})),
}] }));

server.registerTool("agentling_servo_inspect", {
  title: "Inspect the StackChan servo bus without moving",
  description: "Maintenance-only diagnostic. Powers the servo rail briefly, forces torque off, reads communication and device status, then cuts servo power. It never enables torque or commands movement.",
  inputSchema: {},
}, async () => ({ content: [{
  type: "text",
  text: JSON.stringify(await call("/v1/device/servo/inspect", {})),
}] }));

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
