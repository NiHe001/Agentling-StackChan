export type Unsubscribe = () => void;

export type AgentState =
  | "offline"
  | "idle"
  | "working"
  | "waiting_approval"
  | "needs_input"
  | "completed"
  | "failed";

export type CanonicalEventType =
  | "source.connected"
  | "source.disconnected"
  | "session.started"
  | "session.idle"
  | "session.closed"
  | "turn.started"
  | "turn.progress"
  | "turn.completed"
  | "turn.failed"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "approval.requested"
  | "approval.resolved"
  | "input.requested"
  | "input.resolved"
  | "subagent.started"
  | "subagent.completed"
  | "device.connected"
  | "device.disconnected"
  | "usage.updated"
  | "usage.low"
  | "usage.critical"
  | "usage.exhausted"
  | "usage.reset";

export interface CanonicalEvent {
  id: string;
  source: string;
  type: CanonicalEventType;
  sessionId: string;
  occurredAt: number;
  sequence?: number;
  title?: string;
  cwd?: string;
  tool?: string;
  message?: string;
  payload?: Record<string, unknown>;
}

export interface TaskSnapshot {
  id: string;
  source: string;
  title: string;
  cwd?: string;
  state: AgentState;
  currentTool?: string;
  message?: string;
  subagents: number;
  startedAt: number;
  updatedAt: number;
  sequence?: number;
  lastEvent?: CanonicalEventType;
}

export interface TaskReport {
  id: string;
  taskId: string;
  taskTitle: string;
  source: string;
  type: CanonicalEventType;
  state: AgentState;
  message: string;
  tool?: string;
  occurredAt: number;
}

export interface AgentSnapshot {
  tasks: TaskSnapshot[];
  reports: TaskReport[];
  activeTaskId: string | null;
  aggregateState: AgentState;
  updatedAt: number;
}

export interface AgentAdapter {
  id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  getSnapshot(): Promise<AgentSnapshot>;
  subscribe(handler: (event: CanonicalEvent) => void): Unsubscribe;
}

export interface DataProvider<T> {
  id: string;
  refresh(): Promise<T>;
  subscribe(handler: (value: T) => void): Unsubscribe;
}

export interface UsageWindow {
  id: string;
  limitId: string;
  role: "primary" | "secondary";
  label: string;
  remainingPercent: number | null;
  resetsAt: number | null;
  windowDurationMins: number | null;
  stale: boolean;
}

export interface UsageSnapshot {
  source: string;
  windows: UsageWindow[];
  aliases: Record<string, string | null>;
  fetchedAt: number;
  status: "fresh" | "stale" | "unavailable";
  error?: string;
}

export interface ClockSnapshot {
  iso: string;
  unixSeconds: number;
  timezone: string;
  displayTime: string;
  displayDate: string;
}

export interface WeatherSnapshot {
  status: "fresh" | "stale" | "unavailable";
  temperatureC: number | null;
  weatherCode: number | null;
  label: string;
  fetchedAt: number;
  error?: string;
}

export type SceneName = "working" | "idle" | "waiting" | "critical";
export type WidgetType =
  | "clock"
  | "weather"
  | "usage_bar"
  | "usage_text"
  | "agent_badge"
  | "task_count"
  | "status_text"
  | "progress"
  | "sprite"
  | "text"
  | "icon"
  | "bar"
  | "badge";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WidgetStyle {
  normal?: string;
  low?: string;
  critical?: string;
  foreground?: string;
  background?: string;
  border?: string;
  fontSize?: number;
  radius?: number;
  align?: "left" | "center" | "right";
}

export interface WidgetConfig {
  id: string;
  widget: WidgetType;
  bind?: string;
  visible: boolean;
  rect: Rect;
  anchor?: "top_left" | "top_right" | "bottom_left" | "bottom_right" | "center";
  zIndex?: number;
  props?: Record<string, unknown>;
  style?: WidgetStyle;
}

export interface UsageAliasConfig {
  source: string;
  match: {
    limit_id?: string;
    duration_mins?: number;
  };
}

export interface LayoutConfig {
  extends?: string;
  widgets?: WidgetConfig[];
  overrides?: Record<string, Partial<WidgetConfig>>;
}

export interface UiConfig {
  canvas: { width: number; height: number };
  usage_aliases: Record<string, UsageAliasConfig>;
  layouts: Record<string, LayoutConfig>;
}

export interface PackManifest {
  id: string;
  name: string;
  version: string;
  protocol: number;
  author?: string;
  description?: string;
  entryLayout: string;
}

export interface BehaviorStep {
  at: number;
  expression?: string;
  motion?: string;
  sound?: string;
  light?: string;
  text?: string;
}

export interface BehaviorConfig {
  loop?: boolean;
  cooldownMs?: number;
  steps: BehaviorStep[];
}

export interface MotionConfig {
  yaw: number;
  pitch: number;
  speed: number;
  holdMs?: number;
  releaseTorque?: boolean;
}

export interface CompiledPack {
  manifest: PackManifest;
  ui: UiConfig;
  events: Record<string, string>;
  behaviors: Record<string, BehaviorConfig>;
  motions: Record<string, MotionConfig>;
  sounds: Record<string, Record<string, unknown>>;
  lights: Record<string, Record<string, unknown>>;
  visuals: Record<string, Record<string, unknown>>;
  sourceDir: string;
  files: Array<{ path: string; size: number; sha256: string }>;
}

export interface ExpressionOverlay {
  scene: string;
  text?: string;
  progress?: { stage: string; current: number; total: number };
  createdAt: number;
  expiresAt: number;
}

export interface DeviceCapabilities {
  display: { width: number; height: number; touch: boolean };
  servo: { yaw: boolean; pitch: boolean };
  speaker: boolean;
  rgbCount: number;
  sdCard: boolean;
}

export interface DeviceStatus {
  diagnostics?: Record<string, unknown>;
  connected: boolean;
  path?: string;
  firmwareVersion?: string;
  protocolVersion?: number;
  capabilities?: DeviceCapabilities;
  error?: string;
}

export interface DesktopSnapshot {
  agent: AgentSnapshot;
  usage: UsageSnapshot;
  clock: ClockSnapshot;
  weather: WeatherSnapshot;
  overlay: ExpressionOverlay | null;
  device: DeviceStatus;
  pack: CompiledPack | null;
}

export type DeviceMessageType =
  | "device.hello"
  | "agent.snapshot"
  | "widget.snapshot"
  | "action.cue"
  | "pack.manifest"
  | "pack.chunk"
  | "pack.commit"
  | "input.event"
  | "ack"
  | "error";

export interface DeviceEnvelope<T = unknown> {
  protocol: 1;
  epoch: number;
  sequence: number;
  ack?: number;
  type: DeviceMessageType;
  sentAt: number;
  payload: T;
}
