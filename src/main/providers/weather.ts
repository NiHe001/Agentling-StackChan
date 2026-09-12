import { EventEmitter } from "node:events";
import type { DataProvider, WeatherSnapshot } from "../../core/types";
import type { HostConfig } from "../config";

const WEATHER_LABELS: Record<number, string> = {
  0: "晴",
  1: "大致晴朗",
  2: "多云",
  3: "阴",
  45: "雾",
  48: "雾凇",
  51: "毛毛雨",
  53: "毛毛雨",
  55: "毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  80: "阵雨",
  81: "阵雨",
  82: "强阵雨",
  95: "雷雨",
};

export class WeatherProvider extends EventEmitter implements DataProvider<WeatherSnapshot> {
  readonly id = "weather";
  private timer: NodeJS.Timeout | null = null;
  private last: WeatherSnapshot = unavailable("尚未配置天气");

  constructor(private readonly config: HostConfig["weather"]) {
    super();
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.config.refreshMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<WeatherSnapshot> {
    if (!this.config.enabled || this.config.latitude === undefined || this.config.longitude === undefined) {
      this.last = unavailable("请在配置中填写经纬度");
      this.emit("value", this.last);
      return this.last;
    }
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(this.config.latitude));
    url.searchParams.set("longitude", String(this.config.longitude));
    url.searchParams.set("current", "temperature_2m,weather_code");
    url.searchParams.set("timezone", this.config.timezone);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`weather HTTP ${response.status}`);
      const body = (await response.json()) as {
        current?: { temperature_2m?: number; weather_code?: number };
      };
      const temperatureC = body.current?.temperature_2m;
      const weatherCode = body.current?.weather_code;
      if (temperatureC === undefined || weatherCode === undefined) throw new Error("weather response missing current data");
      this.last = {
        status: "fresh",
        temperatureC,
        weatherCode,
        label: WEATHER_LABELS[weatherCode] || `天气 ${weatherCode}`,
        fetchedAt: Date.now(),
      };
    } catch (error) {
      this.last = {
        ...this.last,
        status: this.last.fetchedAt > 0 ? "stale" : "unavailable",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.emit("value", this.last);
    return this.last;
  }

  subscribe(handler: (value: WeatherSnapshot) => void): () => void {
    this.on("value", handler);
    return () => this.off("value", handler);
  }
}

function unavailable(error: string): WeatherSnapshot {
  return {
    status: "unavailable",
    temperatureC: null,
    weatherCode: null,
    label: "--",
    fetchedAt: 0,
    error,
  };
}
