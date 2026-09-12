import { useMemo, useRef } from "react";
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
        {layoutName === "critical" && (
          <div className="critical-overlay">
            <span>{snapshot.agent.aggregateState === "waiting_approval" ? "等待批准" : "需要注意"}</span>
          </div>
        )}
      </div>
      <div className="device-base">
        <div className="servo-neck" />
        <div className="base-leds">{Array.from({ length: 12 }, (_, index) => <i key={index} />)}</div>
      </div>
    </div>
  );
}

function Widget({ widget, snapshot }: { widget: WidgetConfig; snapshot: DesktopSnapshot }) {
  if (widget.widget === "sprite") {
    return <Face state={snapshot.agent.aggregateState} scene={snapshot.overlay?.scene} />;
  }
  if (widget.widget === "clock") {
    return <strong>{new Date(snapshot.clock.iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</strong>;
  }
  if (widget.widget === "weather") {
    return <span>{snapshot.weather.temperatureC === null ? "天气 --" : `${Math.round(snapshot.weather.temperatureC)}° ${snapshot.weather.label}`}</span>;
  }
  if (widget.widget === "status_text") {
    const task = snapshot.agent.tasks.find((entry) => entry.id === snapshot.agent.activeTaskId);
    return <span className="ellipsis">{snapshot.overlay?.text || task?.message || stateLabel(snapshot.agent.aggregateState)}</span>;
  }
  if (widget.widget === "task_count") {
    return <span>{snapshot.agent.tasks.length} TASKS</span>;
  }
  if (widget.widget === "agent_badge") {
    return <span className="agent-badge">CODEX</span>;
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
