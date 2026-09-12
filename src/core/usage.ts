import type { UsageAliasConfig, UsageSnapshot, UsageWindow } from "./types";

export interface RawRateLimitWindow {
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface RawRateLimitSnapshot {
  limitId: string | null;
  limitName?: string | null;
  primary: RawRateLimitWindow | null;
  secondary: RawRateLimitWindow | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
  [key: string]: unknown;
}

export interface RawRateLimitsResponse {
  rateLimits: RawRateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, RawRateLimitSnapshot> | null;
  [key: string]: unknown;
}

export interface RawRateLimitsUpdate {
  rateLimits: RawRateLimitSnapshot;
}

export const DEFAULT_USAGE_ALIASES: Record<string, UsageAliasConfig> = {
  five_hour: { source: "codex", match: { duration_mins: 300 } },
  weekly: { source: "codex", match: { duration_mins: 10_080 } },
};

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function mergeWindow(
  previous: RawRateLimitWindow | null,
  update: RawRateLimitWindow | null,
): RawRateLimitWindow | null {
  if (!update) return previous;
  return {
    usedPercent: update.usedPercent ?? previous?.usedPercent ?? 0,
    windowDurationMins: update.windowDurationMins ?? previous?.windowDurationMins ?? null,
    resetsAt: update.resetsAt ?? previous?.resetsAt ?? null,
  };
}

function mergeBucket(
  previous: RawRateLimitSnapshot | undefined,
  update: RawRateLimitSnapshot,
): RawRateLimitSnapshot {
  if (!previous) return update;
  return {
    ...previous,
    ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== null && value !== undefined)),
    limitId: update.limitId ?? previous.limitId,
    limitName: update.limitName ?? previous.limitName,
    primary: mergeWindow(previous.primary, update.primary),
    secondary: mergeWindow(previous.secondary, update.secondary),
    planType: update.planType ?? previous.planType,
    rateLimitReachedType: update.rateLimitReachedType ?? previous.rateLimitReachedType,
  };
}

export class UsageStore {
  private raw: RawRateLimitsResponse | null = null;
  private fetchedAt = 0;
  private error: string | undefined;

  replace(response: RawRateLimitsResponse, now = Date.now()): void {
    this.raw = structuredClone(response);
    this.fetchedAt = now;
    this.error = undefined;
  }

  merge(update: RawRateLimitsUpdate, now = Date.now()): void {
    if (!this.raw) {
      this.raw = { rateLimits: structuredClone(update.rateLimits), rateLimitsByLimitId: null };
    } else {
      const limitId = update.rateLimits.limitId || this.raw.rateLimits.limitId || "codex";
      if (!this.raw.rateLimits.limitId || this.raw.rateLimits.limitId === limitId) {
        this.raw.rateLimits = mergeBucket(this.raw.rateLimits, update.rateLimits);
      }
      if (this.raw.rateLimitsByLimitId) {
        this.raw.rateLimitsByLimitId[limitId] = mergeBucket(
          this.raw.rateLimitsByLimitId[limitId],
          update.rateLimits,
        );
      }
    }
    this.fetchedAt = now;
    this.error = undefined;
  }

  fail(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error);
  }

  snapshot(
    aliases: Record<string, UsageAliasConfig> = DEFAULT_USAGE_ALIASES,
    now = Date.now(),
    staleAfterMs = 10 * 60_000,
  ): UsageSnapshot {
    if (!this.raw) {
      return {
        source: "codex",
        windows: [],
        aliases: Object.fromEntries(Object.keys(aliases).map((alias) => [alias, null])),
        fetchedAt: this.fetchedAt,
        status: "unavailable",
        error: this.error,
      };
    }

    const stale = now - this.fetchedAt > staleAfterMs;
    const buckets = this.pickBuckets(this.raw);
    const windows: UsageWindow[] = [];
    for (const [fallbackId, bucket] of Object.entries(buckets)) {
      const limitId = bucket.limitId || fallbackId;
      for (const role of ["primary", "secondary"] as const) {
        const window = bucket[role];
        if (!window) continue;
        const duration = window.windowDurationMins;
        windows.push({
          id: `${limitId}:${role}`,
          limitId,
          role,
          label: bucket.limitName || durationLabel(duration) || `${limitId} ${role}`,
          remainingPercent: Number.isFinite(window.usedPercent)
            ? clampPercent(100 - (window.usedPercent as number))
            : null,
          resetsAt: window.resetsAt,
          windowDurationMins: duration,
          stale,
        });
      }
    }

    return {
      source: "codex",
      windows,
      aliases: resolveUsageAliases(windows, aliases),
      fetchedAt: this.fetchedAt,
      status: stale ? "stale" : "fresh",
      error: this.error,
    };
  }

  private pickBuckets(response: RawRateLimitsResponse): Record<string, RawRateLimitSnapshot> {
    if (response.rateLimitsByLimitId && Object.keys(response.rateLimitsByLimitId).length > 0) {
      return response.rateLimitsByLimitId;
    }
    return { [response.rateLimits.limitId || "codex"]: response.rateLimits };
  }
}

export function resolveUsageAliases(
  windows: UsageWindow[],
  aliases: Record<string, UsageAliasConfig>,
): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(aliases).map(([name, config]) => {
      const found = windows.find((window) => {
        if (config.source !== "codex") return false;
        if (config.match.limit_id && window.limitId !== config.match.limit_id) return false;
        if (
          config.match.duration_mins !== undefined &&
          window.windowDurationMins !== config.match.duration_mins
        ) {
          return false;
        }
        return true;
      });
      return [name, found?.id ?? null];
    }),
  );
}

export function durationLabel(duration: number | null): string | null {
  if (duration === null) return null;
  if (duration === 300) return "5H";
  if (duration === 10_080) return "7D";
  if (duration % 1_440 === 0) return `${duration / 1_440}D`;
  if (duration % 60 === 0) return `${duration / 60}H`;
  return `${duration}M`;
}

export type UsageAlertLevel = "normal" | "low" | "critical" | "exhausted";

export class UsageAlertTracker {
  private readonly levels = new Map<string, UsageAlertLevel>();

  update(window: UsageWindow): UsageAlertLevel | null {
    if (window.remainingPercent === null) return null;
    const previous = this.levels.get(window.id) ?? "normal";
    const remaining = window.remainingPercent;
    let next: UsageAlertLevel;
    if (remaining <= 0) next = "exhausted";
    else if (remaining <= 10) next = "critical";
    else if (remaining <= 30) next = "low";
    else next = "normal";

    // Five-point hysteresis when recovering prevents repeated boundary alerts.
    if (previous === "critical" && remaining <= 15 && next === "low") next = "critical";
    if (previous === "low" && remaining <= 35 && next === "normal") next = "low";
    this.levels.set(window.id, next);
    return next !== previous ? next : null;
  }
}
