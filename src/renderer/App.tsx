import { useEffect, useMemo, useState } from "react";
import { resolveLayout } from "../core/layout";
import type { DesktopSnapshot, Rect, UiConfig, WidgetConfig } from "../core/types";
import type { SerialPortInfo } from "../main/services/device";
import { DevicePreview } from "./components/DevicePreview";

export function App() {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const [ui, setUi] = useState<UiConfig | null>(null);
  const [layoutName, setLayoutName] = useState("base");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [selectedPort, setSelectedPort] = useState("");
  const [message, setMessage] = useState("正在启动…");

  useEffect(() => {
    void window.agentling.getSnapshot().then((value) => {
      setSnapshot(value);
      setUi(value.pack?.ui ? structuredClone(value.pack.ui) : null);
      setMessage("就绪");
    });
    return window.agentling.onSnapshot((value) => {
      setSnapshot(value);
      setUi((previous) => previous || (value.pack?.ui ? structuredClone(value.pack.ui) : null));
    });
  }, []);

  const widgets = useMemo(() => (ui ? resolveLayout(ui, layoutName) : []), [ui, layoutName]);
  const selected = widgets.find((widget) => widget.id === selectedId) || null;

  if (!snapshot || !ui) return <main className="loading">{message}</main>;

  const updateWidget = (id: string, patch: Partial<WidgetConfig>) => {
    setUi((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      const layout = next.layouts[layoutName];
      if (!layout) return current;
      const direct = layout.widgets?.findIndex((widget) => widget.id === id) ?? -1;
      if (direct >= 0 && layout.widgets) {
        layout.widgets[direct] = mergeWidget(layout.widgets[direct]!, patch);
      } else {
        layout.overrides ||= {};
        layout.overrides[id] = mergeWidget(
          (layout.overrides[id] || {}) as WidgetConfig,
          patch,
        );
      }
      return next;
    });
  };

  const run = async (label: string, action: () => Promise<unknown>) => {
    try {
      setMessage(`${label}…`);
      await action();
      setMessage(`${label}完成`);
    } catch (error) {
      setMessage(`${label}失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <main className="app-shell">
      <header>
        <div>
          <p className="eyebrow">AGENTLING / STACKCHAN</p>
          <h1>桌面伙伴控制台</h1>
        </div>
        <div className="header-actions">
          <span className={`pill ${snapshot.device.connected ? "online" : ""}`}>{snapshot.device.connected ? "设备在线" : "模拟器"}</span>
          <button onClick={() => void run("导入角色包", async () => {
            const pack = await window.agentling.openPack();
            if (pack) { setUi(structuredClone(pack.ui)); setSelectedId(null); }
          })}>导入角色包</button>
          <button className="primary" onClick={() => void run("同步角色包", () => window.agentling.syncPack())}>同步到 StackChan</button>
        </div>
      </header>

      <section className="workspace">
        <aside className="left-panel">
          <PanelTitle title="实时状态" subtitle={snapshot.pack?.manifest.name || "未加载角色"} />
          <div className={`state-card state-${snapshot.agent.aggregateState}`}>
            <span className="state-dot" />
            <div><strong>{stateLabel(snapshot.agent.aggregateState)}</strong><small>{snapshot.agent.tasks.length} 个任务</small></div>
          </div>
          <QuotaCard alias="five_hour" label="5 小时额度" snapshot={snapshot} />
          <QuotaCard alias="weekly" label="每周额度" snapshot={snapshot} />

          <PanelTitle title="设备" subtitle={snapshot.device.firmwareVersion || "USB Serial"} />
          <button className="wide secondary" onClick={() => void run("扫描串口", async () => setPorts(await window.agentling.listPorts()))}>扫描串口</button>
          {ports.length > 0 && <select value={selectedPort} onChange={(event) => setSelectedPort(event.target.value)}><option value="">选择设备…</option>{ports.map((port) => <option key={port.path} value={port.path}>{port.path}</option>)}</select>}
          {selectedPort && <button className="wide" onClick={() => void run("连接设备", () => window.agentling.connectDevice(selectedPort))}>连接</button>}

          <PanelTitle title="快速预览" subtitle="MCP 表达层" />
          <div className="button-grid">
            {([["thinking", "思考"], ["coding", "编码"], ["celebrating", "庆祝"], ["resting", "休息"]] as const).map(([scene, label]) => <button key={scene} onClick={() => window.agentling.showExpression({ scene, text: label, ttlMs: 10_000 })}>{label}</button>)}
          </div>
        </aside>

        <section className="preview-panel">
          <div className="preview-toolbar">
            <div><h2>硬件模拟器</h2><p>拖动组件；预览坐标与 320×240 真机一致</p></div>
            <select value={layoutName} onChange={(event) => { setLayoutName(event.target.value); setSelectedId(null); }}>{Object.keys(ui.layouts).map((name) => <option key={name}>{name}</option>)}</select>
          </div>
          <DevicePreview snapshot={snapshot} ui={ui} layoutName={layoutName} selectedId={selectedId} onSelect={setSelectedId} onMove={(id, rect) => updateWidget(id, { rect })} />
          <div className="status-line"><span>{message}</span><span>{snapshot.usage.status === "fresh" ? "额度数据已同步" : `额度：${snapshot.usage.status}`}</span></div>
        </section>

        <aside className="right-panel">
          <PanelTitle title="布局组件" subtitle={layoutName} />
          <div className="widget-list">{widgets.map((widget) => <button key={widget.id} className={selectedId === widget.id ? "active" : ""} onClick={() => setSelectedId(widget.id)}><span>{widget.id}</span><small>{widget.widget}</small></button>)}</div>
          {selected && <WidgetInspector widget={selected} onChange={(patch) => updateWidget(selected.id, patch)} />}
          <div className="save-actions">
            <button className="primary wide" onClick={() => void run("保存布局", async () => {
              const pack = await window.agentling.saveUi(ui);
              setUi(structuredClone(pack.ui));
            })}>保存 ui.yaml</button>
            <button className="wide secondary" onClick={() => void run("刷新额度", () => window.agentling.refreshUsage())}>刷新 Codex 额度</button>
          </div>
        </aside>
      </section>
    </main>
  );
}

function WidgetInspector({ widget, onChange }: { widget: WidgetConfig; onChange(patch: Partial<WidgetConfig>): void }) {
  const field = (key: keyof Rect, label: string) => <label><span>{label}</span><input type="number" value={widget.rect[key]} onChange={(event) => onChange({ rect: { ...widget.rect, [key]: Number(event.target.value) } })} /></label>;
  return <div className="inspector"><div className="inspector-title"><strong>{widget.id}</strong><label className="toggle"><input type="checkbox" checked={widget.visible} onChange={(event) => onChange({ visible: event.target.checked })} /><span>显示</span></label></div><div className="field-grid">{field("x", "X")}{field("y", "Y")}{field("width", "宽")}{field("height", "高")}</div><label><span>层级</span><input type="number" min="0" max="899" value={widget.zIndex || 0} onChange={(event) => onChange({ zIndex: Number(event.target.value) })} /></label><label><span>字号</span><input type="number" min="6" max="96" value={widget.style?.fontSize || 10} onChange={(event) => onChange({ style: { ...widget.style, fontSize: Number(event.target.value) } })} /></label></div>;
}

function QuotaCard({ alias, label, snapshot }: { alias: string; label: string; snapshot: DesktopSnapshot }) {
  const id = snapshot.usage.aliases[alias];
  const window = snapshot.usage.windows.find((entry) => entry.id === id);
  const value = window?.remainingPercent;
  return <div className="quota-card"><div><span>{label}</span><strong>{value === null || value === undefined ? "--" : `${Math.round(value)}%`}</strong></div><div className="quota-track"><i className={(value ?? 100) <= 10 ? "critical" : (value ?? 100) <= 30 ? "low" : ""} style={{ width: `${value ?? 0}%` }} /></div><small>{window?.stale ? "数据可能已过期" : window?.resetsAt ? new Date(window.resetsAt * 1000).toLocaleString("zh-CN") + " 重置" : "等待 Codex 数据"}</small></div>;
}

function PanelTitle({ title, subtitle }: { title: string; subtitle: string }) { return <div className="panel-title"><h3>{title}</h3><span>{subtitle}</span></div>; }
function stateLabel(state: string) { return ({ idle: "空闲", working: "正在工作", waiting_approval: "等待批准", needs_input: "需要输入", completed: "已完成", failed: "失败", offline: "离线" } as Record<string, string>)[state] || state; }
function mergeWidget(widget: WidgetConfig, patch: Partial<WidgetConfig>): WidgetConfig { return { ...widget, ...patch, rect: patch.rect ? { ...widget.rect, ...patch.rect } : widget.rect, props: { ...widget.props, ...patch.props }, style: { ...widget.style, ...patch.style } }; }
