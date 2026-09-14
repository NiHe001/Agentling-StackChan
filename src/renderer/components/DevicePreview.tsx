import { useEffect, useMemo, useRef, useState } from "react";
import { resolveLayout } from "../../core/layout";
import type {
  DesktopSnapshot,
  Rect,
  UiConfig,
  UsageWindow,
  WidgetConfig,
} from "../../core/types";

interface Props {
  snapshot: DesktopSnapshot;
  ui: UiConfig;
  layoutName: string;
  selectedId: string | null;
  onSelect(id: string): void;
  onMove(id: string, rect: Rect): void;
}

const SCALE = 1.75;

export function DevicePreview({ snapshot, ui, layoutName, selectedId, onSelect, onMove }: Props) {
  const widgets = useMemo(() => resolveLayout(ui, layoutName), [ui, layoutName]);
  const drag = useRef<{ id: string; startX: number; startY: number; rect: Rect } | null>(null);

  return (
    <div className="device-shell">
      <div
        className="device-screen"
        style={{ width: ui.canvas.width * SCALE, height: ui.canvas.height * SCALE }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          const dx = Math.round((event.clientX - drag.current.startX) / SCALE);
          const dy = Math.round((event.clientY - drag.current.startY) / SCALE);
          onMove(drag.current.id, {
            ...drag.current.rect,
            x: clamp(drag.current.rect.x + dx, 0, ui.canvas.width - drag.current.rect.width),
            y: clamp(drag.current.rect.y + dy, 0, ui.canvas.height - drag.current.rect.height),
          });
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerLeave={() => (drag.current = null)}
      >
        {widgets.map((widget) =>
          widget.visible ? (
            <div
              key={widget.id}
              className={`screen-widget ${selectedId === widget.id ? "selected" : ""}`}
              style={{
                left: widget.rect.x * SCALE,
                top: widget.rect.y * SCALE,
                width: widget.rect.width * SCALE,
                height: widget.rect.height * SCALE,
                zIndex: widget.zIndex,
                fontSize: (widget.style?.fontSize || 10) * SCALE,
                color: widget.style?.foreground || "#f5f7fb",
                background: widget.style?.background || "transparent",
                borderColor: widget.style?.border || "transparent",
                borderRadius: (widget.style?.radius || 0) * SCALE,
                justifyContent: align(widget.style?.align),
              }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = {
                  id: widget.id,
                  startX: event.clientX,
                  startY: event.clientY,
                  rect: widget.rect,
                };
                onSelect(widget.id);
              }}
            >
              <Widget widget={widget} snapshot={snapshot} />
            </div>
          ) : null,
        )}
        {layoutName === "critical" && <div className="critical-frame" />}
      </div>
      <div className={`device-base lights-${snapshot.agent.aggregateState.replaceAll("_", "-")}`}>
        <div className="servo-neck" />
        <div className="base-leds">{Array.from({ length: 12 }, (_, index) => <i key={index} />)}</div>
      </div>
    </div>
  );
}

function Widget({ widget, snapshot }: { widget: WidgetConfig; snapshot: DesktopSnapshot }) {
  if (widget.widget === "sprite") {
    return <CharacterSprite snapshot={snapshot} />;
  }
  if (widget.widget === "clock") {
    return <strong>{new Date(snapshot.clock.iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</strong>;
  }
  if (widget.widget === "weather") {
    return <span>{snapshot.weather.temperatureC === null ? "天气 --" : `${Math.round(snapshot.weather.temperatureC)}° ${snapshot.weather.label}`}</span>;
  }
  if (widget.widget === "status_text") {
    const task = snapshot.agent.tasks.find((entry) => entry.id === snapshot.agent.activeTaskId);
    return <span className="ellipsis">{statusText(snapshot, task)}</span>;
  }
  if (widget.widget === "task_count") {
    const task = snapshot.agent.tasks.find((entry) => entry.id === snapshot.agent.activeTaskId);
    const index = task ? snapshot.agent.tasks.findIndex((entry) => entry.id === task.id) + 1 : 0;
    return <span className="ellipsis">{task?.title || "0 TASKS"}{snapshot.agent.tasks.length > 1 ? `  ${index}/${snapshot.agent.tasks.length}` : ""}</span>;
  }
  if (widget.widget === "agent_badge") {
    return <span className="agent-badge">{String(widget.props?.label || "CODEX")}</span>;
  }
  if (widget.widget === "usage_bar" || widget.widget === "usage_text") {
    const window = usageWindow(widget.bind, snapshot);
    const remaining = window?.remainingPercent;
    const valueMode = widget.props?.value_mode === "used" ? "used" : "remaining";
    const value = remaining === null || remaining === undefined ? null : valueMode === "used" ? 100 - remaining : remaining;
    const label = String(widget.props?.label || window?.label || "LIMIT");
    if (widget.widget === "usage_text") return <span>{label} {value === null ? "--" : `${Math.round(value)}%`}</span>;
    const color = value === null ? "#586174" : remaining! <= 10 ? widget.style?.critical : remaining! <= 30 ? widget.style?.low : widget.style?.normal;
    return (
      <div className="usage-widget">
        <div className="usage-row"><b>{label}</b><span>{value === null ? "--" : `${Math.round(value)}%`}</span></div>
        <div className="usage-track"><i style={{ width: `${value ?? 0}%`, background: color || "#59d185" }} /></div>
        {widget.props?.show_reset === true && <small>{formatReset(window?.resetsAt)}</small>}
      </div>
    );
  }
  if (widget.widget === "progress" && snapshot.overlay?.progress) {
    const progress = snapshot.overlay.progress;
    return <span>{progress.stage} {Math.round((progress.current / progress.total) * 100)}%</span>;
  }
  return <span>{String(widget.props?.text || widget.id)}</span>;
}

const assetCache = new Map<string, string>();

function CharacterSprite({ snapshot }: { snapshot: DesktopSnapshot }) {
  const scene = snapshot.overlay?.scene || stateVisual(snapshot.agent.aggregateState);
  const visual = snapshot.pack?.visuals[scene];
  const frames = visual?.renderer === "png_sequence" && Array.isArray(visual.frames)
    ? visual.frames.filter((entry): entry is string => typeof entry === "string")
    : visual?.renderer === "png" && typeof visual.asset === "string"
      ? [visual.asset]
      : [];
  const frameMs = typeof visual?.frameMs === "number" ? visual.frameMs : 1_000;
  const packIdentity = `${snapshot.pack?.manifest.id || "none"}@${snapshot.pack?.manifest.version || "0"}`;
  const frameSignature = frames.join("|");
  const [frameIndex, setFrameIndex] = useState(0);
  const [sources, setSources] = useState<string[]>([]);

  useEffect(() => {
    setFrameIndex(0);
    if (frames.length < 2) return;
    const timer = window.setInterval(() => setFrameIndex((current) => (current + 1) % frames.length), frameMs);
    return () => window.clearInterval(timer);
  }, [frameSignature, frameMs, frames.length]);

  useEffect(() => {
    let active = true;
    if (frames.length === 0) {
      setSources([]);
      return () => { active = false; };
    }
    void Promise.all(frames.map(async (asset) => {
      const cacheKey = `${packIdentity}:${asset}`;
      const cached = assetCache.get(cacheKey);
      if (cached) return cached;
      const value = await window.agentling.getPackAsset(asset);
      if (value) assetCache.set(cacheKey, value);
      return value;
    })).then((values) => {
      if (active) setSources(values.filter((value): value is string => Boolean(value)));
    });
    return () => { active = false; };
  }, [frameSignature, packIdentity]);
  const source = sources[frameIndex % Math.max(1, sources.length)];
  const animation = typeof visual?.animation === "string" ? visual.animation : "none";
  if (source) return <img className={`character-sprite visual-${animation}`} src={source} alt="Byte Otter character state" />;
  return <Face state={snapshot.agent.aggregateState} scene={snapshot.overlay?.scene} />;
}

function stateVisual(state: string): string {
  return ({ idle: "idle", working: "working", waiting_approval: "waiting_approval", needs_input: "waiting", completed: "completed", failed: "failed", offline: "offline" } as Record<string, string>)[state] || state;
}

function statusText(snapshot: DesktopSnapshot, task?: DesktopSnapshot["agent"]["tasks"][number]): string {
  if (snapshot.overlay?.text) return snapshot.overlay.text;
  if (!task || task.state === "idle" || snapshot.agent.aggregateState === "offline") return stateLabel(task?.state || snapshot.agent.aggregateState);
  const lifecycle = stateLabel(task.state);
  if (!task.message) return lifecycle;
  if (["waiting_approval", "needs_input", "failed"].includes(task.state) && !task.message.includes(lifecycle)) return `${lifecycle} · ${task.message}`;
  return task.message;
}

function Face({ state, scene }: { state: string; scene?: string }) {
  const mood = scene || state;
  return (
    <div className={`face mood-${mood.replaceAll("_", "-")}`}>
      <div className="eyes"><i /><i /></div>
      <div className="mouth" />
      <div className="cheek left" /><div className="cheek right" />
    </div>
  );
}

function usageWindow(bind: string | undefined, snapshot: DesktopSnapshot): UsageWindow | undefined {
  const alias = bind?.split(".").at(-1);
  const id = alias ? snapshot.usage.aliases[alias] : null;
  return snapshot.usage.windows.find((entry) => entry.id === id);
}

function stateLabel(state: string): string {
  return ({ idle: "空闲中", working: "正在工作", waiting_approval: "等待批准", needs_input: "需要输入", completed: "任务完成", failed: "任务失败", offline: "离线" } as Record<string, string>)[state] || state;
}

function formatReset(seconds: number | null | undefined): string {
  if (!seconds) return "";
  const delta = Math.max(0, seconds * 1_000 - Date.now());
  const hours = Math.floor(delta / 3_600_000);
  const minutes = Math.floor((delta % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m 后重置`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function align(value: string | undefined): string {
  if (value === "center") return "center";
  if (value === "right") return "flex-end";
  return "flex-start";
}
