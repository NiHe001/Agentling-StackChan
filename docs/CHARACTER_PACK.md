# 角色包格式

角色包是纯 YAML 与媒体资源，不执行脚本。必需文件：

```text
my-character/
├── pack.yaml
├── events.yaml
├── behaviors.yaml
├── motions.yaml
├── sounds.yaml
├── lights.yaml
├── visuals.yaml
├── ui.yaml
└── assets/
    ├── sprites/
    ├── audio/
    └── icons/
```

## 清单

```yaml
id: example.robot
name: Example Robot
version: 1.0.0
protocol: 1
entryLayout: base
```

`id` 和版本参与事务提交。V1 只接受 `protocol: 1`。

## 事件与行为

`events.yaml` 把标准事件映射到行为名：

```yaml
events:
  turn.started: focus
  turn.completed: celebrate
  approval.requested: attention
  usage.critical: quota_critical
```

`behaviors.yaml` 是按毫秒排序的时间线：

```yaml
behaviors:
  celebrate:
    cooldownMs: 3000
    loop: false
    steps:
      - { at: 0, expression: delighted, sound: complete, light: rainbow, motion: happy_left }
      - { at: 450, motion: happy_right }
      - { at: 900, motion: home, light: mint }
```

行为只引用声明过的资源。真实 Agent 事件可以中断正在播放的空闲/MCP 行为。

## 动作安全

角度单位是 0.1 度；`yaw` 范围 -900..900，`pitch` 范围 -450..450，`speed` 范围
1..1000。桌面端和固件都会再次限幅。固件每次动作最多保持扭矩 3 秒，随后自动释放；角色包
不能绕过这个上限。

```yaml
motions:
  home: { yaw: 0, pitch: 0, speed: 350, holdMs: 250, releaseTorque: true }
```

## UI 布局

逻辑画布固定为 320×240，保证模拟器和屏幕使用相同整数坐标。`zIndex` 只能为 0..899；
900 及以上由固件保留给断线、故障和批准提示。

```yaml
canvas: { width: 320, height: 240 }
usage_aliases:
  five_hour: { source: codex, match: { duration_mins: 300 } }
  weekly: { source: codex, match: { duration_mins: 10080 } }
layouts:
  base:
    widgets:
      - id: quota_5h
        widget: usage_bar
        bind: usage.codex.five_hour
        visible: true
        rect: { x: 8, y: 218, width: 145, height: 18 }
        props: { label: "5H", value_mode: remaining, show_percent: true }
        style: { normal: "#59D185", low: "#FFB020", critical: "#FF4D4F" }
  critical:
    extends: base
    overrides:
      quota_5h: { visible: false }
```

支持的组件包括 `clock`、`weather`、`usage_bar`、`usage_text`、`agent_badge`、
`task_count`、`status_text`、`progress`、`sprite`、`text`、`icon`、`bar` 和 `badge`。
未找到额度窗口时必须显示 `--`，不能假定为 0% 或 100%。

## 限制与降级

- 单文件最大 2 MiB，角色包最大 12 MiB，最多 128 个文件。
- 不允许绝对路径、`..`、反斜杠或符号链接。
- 缺失硬件能力时跳过对应动作，其余时间线继续运行。
- V1 固件原生支持程序化 `face`、tone/melody 与 RGB 定义；同步的图片/WAV 资源格式已保留，
  后续渲染器可在不改变事件和传输协议的情况下扩展。
