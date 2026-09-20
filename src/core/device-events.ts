import type { DeviceInputEvent } from "./types";

export class DeviceEventQueue {
  private readonly events: DeviceInputEvent[] = [];
  private nextId = 1;

  constructor(private readonly capacity = 64) {}

  push(payload: { type?: unknown; source?: unknown; at?: unknown }, receivedAt = Date.now()): DeviceInputEvent {
    const event: DeviceInputEvent = {
      id: this.nextId++,
      type: typeof payload.type === "string" && payload.type ? payload.type : "unknown",
      source: typeof payload.source === "string" && payload.source ? payload.source : "screen",
      deviceUptimeMs: typeof payload.at === "number" && Number.isFinite(payload.at) ? payload.at : 0,
      receivedAt,
    };
    this.events.push(event);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    return structuredClone(event);
  }

  findAfter(afterId = 0, types?: readonly string[]): DeviceInputEvent | undefined {
    const allowed = types?.length ? new Set(types) : undefined;
    const event = this.events.find((candidate) => candidate.id > afterId && (!allowed || allowed.has(candidate.type)));
    return event ? structuredClone(event) : undefined;
  }

  latestId(): number {
    return this.nextId - 1;
  }
}
