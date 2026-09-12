import { EventEmitter } from "node:events";
import type { ClockSnapshot, DataProvider } from "../../core/types";

export class ClockProvider extends EventEmitter implements DataProvider<ClockSnapshot> {
  readonly id = "clock";
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.emit("value", this.value()), 1_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<ClockSnapshot> {
    return this.value();
  }

  subscribe(handler: (value: ClockSnapshot) => void): () => void {
    this.on("value", handler);
    return () => this.off("value", handler);
  }

  private value(): ClockSnapshot {
    const now = new Date();
    return {
      iso: now.toISOString(),
      unixSeconds: Math.floor(now.getTime() / 1_000),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      displayTime: now.toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
      displayDate: now.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }),
    };
  }
}
