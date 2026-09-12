import { z } from "zod";

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected #RRGGBB color");
const rect = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const widgetSchema = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
  widget: z.enum([
    "clock",
    "weather",
    "usage_bar",
    "usage_text",
    "agent_badge",
    "task_count",
    "status_text",
    "progress",
    "sprite",
    "text",
    "icon",
    "bar",
    "badge",
  ]),
  bind: z.string().optional(),
  visible: z.boolean().default(true),
  rect,
  anchor: z
    .enum(["top_left", "top_right", "bottom_left", "bottom_right", "center"])
    .default("top_left"),
  zIndex: z.number().int().min(0).max(899).default(0),
  props: z.record(z.unknown()).default({}),
  style: z
    .object({
      normal: color.optional(),
      low: color.optional(),
      critical: color.optional(),
      foreground: color.optional(),
      background: color.optional(),
      border: color.optional(),
      fontSize: z.number().int().min(6).max(96).optional(),
      radius: z.number().int().min(0).max(40).optional(),
      align: z.enum(["left", "center", "right"]).optional(),
    })
    .default({}),
});

export const uiConfigSchema = z.object({
  canvas: z.object({
    width: z.literal(320),
    height: z.literal(240),
  }),
  usage_aliases: z
    .record(
      z.object({
        source: z.string().min(1),
        match: z
          .object({
            limit_id: z.string().min(1).optional(),
            duration_mins: z.number().int().positive().optional(),
          })
          .refine((value) => value.limit_id !== undefined || value.duration_mins !== undefined, {
            message: "usage alias requires limit_id or duration_mins",
          }),
      }),
    )
    .default({}),
  layouts: z.record(
    z.object({
      extends: z.string().optional(),
      widgets: z.array(widgetSchema).optional(),
      overrides: z.record(widgetSchema.partial()).optional(),
    }),
  ),
});

export const packManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  name: z.string().min(1).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/),
  protocol: z.literal(1),
  author: z.string().max(80).optional(),
  description: z.string().max(500).optional(),
  entryLayout: z.string().default("base"),
});

export const motionSchema = z.object({
  yaw: z.number().int().min(-900).max(900),
  pitch: z.number().int().min(-450).max(450),
  speed: z.number().int().min(1).max(1000),
  holdMs: z.number().int().min(0).max(30_000).optional(),
  releaseTorque: z.boolean().optional(),
});

export const behaviorSchema = z.object({
  loop: z.boolean().default(false),
  cooldownMs: z.number().int().min(0).max(3_600_000).default(0),
  steps: z
    .array(
      z.object({
        at: z.number().int().min(0).max(3_600_000),
        expression: z.string().optional(),
        motion: z.string().optional(),
        sound: z.string().optional(),
        light: z.string().optional(),
        text: z.string().max(80).optional(),
      }),
    )
    .min(1),
});

export const expressionRequestSchema = z.object({
  scene: z.string().min(1).max(40),
  text: z.string().max(80).optional(),
  ttlMs: z.number().int().min(5_000).max(30_000).default(10_000),
});

export const progressRequestSchema = z.object({
  stage: z.string().min(1).max(40),
  current: z.number().finite().nonnegative(),
  total: z.number().finite().positive(),
  ttlMs: z.number().int().min(5_000).max(30_000).default(10_000),
});
