# Agentling StackChan

Agentling StackChan 是一个面向 M5Stack StackChan K151/CoreS3 的可配置桌面 Agent
伙伴。它把 Codex 的权威生命周期、5 小时/每周用量、时间和天气汇总在 macOS
常驻程序中，再通过 USB Serial 驱动屏幕、扬声器和左右各 6 颗 RGB 灯。本版为避免桌面
干扰和机械磨损，云台明确保持断电不动。

项目不使用 Codex 桌面宠物或其他现有 IP 的内部素材；默认角色 `Byte Otter` 是为本项目
生成的原创程序员水獭，包含 12 种状态图。角色不再用不同姿态快速轮播来假装动画，而是让
固定、易识别的状态姿态叠加呼吸、专注、思考、提醒、庆祝和错误缓停等连续微动作。

## 已实现

- Electron + React + TypeScript 菜单栏程序和 320×240 硬件模拟器；控制台和真机布局均采用
  更大的正文，真机用 24 px 状态标题、14 px 任务/额度信息建立清晰层级。
- 本机 Codex 会话状态适配器会自动跟踪任务开始、完成、中断和等待输入；可选的 Codex Hooks
  继续补充工具、审批和子任务进度。两路事件统一做多任务隔离、乱序/重复保护和注意力仲裁。
- 类似 Codex 桌面端的任务动态：按任务显示最新安全报告、当前工具、子任务、审批/失败提醒和
  最近事件时间线；桌面端可点击切换，真机可滑动或触摸底部切换。
- Codex App Server `account/rateLimits/read` 与 `account/rateLimits/updated`，按窗口时长识别
  `5H`/`7D`，稀疏更新合并、工作时 15 秒校准、空闲时 1 分钟校准、过期和不可用显示。
- 可拖动布局编辑、角色包导入/校验、资源清单、SHA-256 校验和原子同步。
- STDIO MCP：`agentling_show`、`agentling_progress`、`agentling_clear`。表达必须带 TTL，
  Agent 真实事件会立即清除表达，失败和等待批准始终优先。
- 硬件 MCP：可读取电池、IMU、环境光/接近、屏幕和头部触摸快照，等待触摸/摇晃事件；
  单次拍照必须在真机 15 秒确认界面点击“允许”，JPEG 仅保存到本机私有临时文件。
- 直接硬件 MCP：限时设置 12 颗 RGB 灯的颜色/亮度/呼吸/追逐，限音量和时长播放
  角色包预设音；云台使用官方动画执行有界单次动作，到达目标后释放扭矩并断电，不自动回中。
- Open-Meteo 天气 Provider，仅使用用户填写的城市经纬度，不做 IP 定位。
- CoreS3 固件：CBOR + COBS + CRC32、序号/累计 ACK、断线标记、触摸切任务、序列帧/声音/
  同步灯光调度、传感器快照、物理事件、授权后单次拍照、云台断电、microSD 优先的事务更新
  及内置救援界面。
- 固件诊断会返回当前微动画偏移、缩放和相位，便于在没有摄像头时确认真机动画引擎持续运行。
- 状态事件立即推送，内部裁决周期 250 ms、设备心跳 1 秒；额度工作时最多每 15 秒、
  空闲时默认每分钟主动校准，同时接收 App Server 的即时更新。这些读取不调用模型、不消耗 token。
- 为后续 Claude Code 等适配器保留稳定的 `AgentAdapter`、`DataProvider` 和标准事件接口。

## 快速开始

要求 Node.js 22+。固件构建另外需要 PlatformIO。

```bash
npm install
npm run typecheck
npm test
npm run dev
```

首次启动会在 Electron 的用户数据目录生成 `config.yaml`。macOS 默认位置为：

```text
~/Library/Application Support/Agentling StackChan/config.yaml
```

可参考 [`config/agentling.example.yaml`](config/agentling.example.yaml)。天气默认关闭；启用时必须
手动填写经纬度。HTTP 服务只监听 `127.0.0.1:17321`，如配置 `server.token`，Hooks 和 MCP
进程需要同时设置同值的 `AGENTLING_TOKEN`。

### Codex 状态与 Hooks

桌面程序默认只读监听 `~/.codex/sessions` 中最近活跃的 JSONL，会话开始、完成、中断及
`request_user_input` 可直接反映到桌面和真机，不需要先安装 Hook。解析器只保留任务 ID、工作
目录和生命周期元数据，不转发或持久化提示词、回答、工具参数及工具输出；状态源暂时不可用时
会明确显示离线，并自动重连。

如需显示当前工具、审批和子任务等更细的进度，先启动桌面程序，再执行：

```bash
npm run hooks:install
```

安装器会备份并合并 `~/.codex/hooks.json`，不会覆盖已有 Hook。请在 Codex 中检查并信任新增
命令。Hook 只转发事件名称、任务 ID、时间、工具名称和最多 96 字的一行用户可见报告；不会
转发提示词、工具输入输出、代码或 transcript 路径。桌面端保留最近 40 条报告，串口只发送
每个任务的最新一条，避免 1 秒心跳重复传输历史。

### 接入 MCP 表达工具

先构建，再把本项目的 MCP 进程加入 Codex：

```bash
npm run build
codex mcp add agentling -- node /absolute/path/to/Agentling-StackChan/dist/mcp/index.js
```

MCP 只是临时表现层，不能把真实状态改成完成、失败或等待批准。

完成和失败会分别短暂显示 4 秒和 8 秒，随后让仍在执行的任务重新成为主状态；
真机的一次性庆祝、额度提醒等动作会在最后一帧停留约 0.85 秒，再按当前主状态恢复。
等待批准和离线状态持续显示，直到对应状态变化。

### 构建和烧录固件

```bash
npm run firmware:build
npm run firmware:upload
platformio device monitor -d firmware -b 921600
```

烧录会替换原厂固件。首次建议先用 M5Burner 保存恢复路径。角色包优先存储到 CoreS3 的
microSD/TF 卡；未检测到卡时自动回退到内置 LittleFS。详细说明见
[`firmware/README.md`](firmware/README.md)。
烧录只更新真机程序；额度刷新、任务裁决和角色包选择属于桌面程序，修改后还需重新构建并
运行或安装桌面应用。烧录前请先退出占用串口的 Agentling 桌面程序，完成后再启动。

### macOS 打包

```bash
npm run package:dir
CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:mac
```

输出在 `release/`。未配置 Apple Developer 证书时只能生成未签名测试包；正式分发还需要签名和
公证。

## 角色包

完整格式见 [`docs/CHARACTER_PACK.md`](docs/CHARACTER_PACK.md)。默认包位于
[`packs/byte-otter`](packs/byte-otter)，程序化救援包仍保留在 [`packs/default`](packs/default)。
桌面控制台左侧的“角色包”下拉框会列出内置包和已添加的本地包。可用“添加本地包”选择
角色包目录，再从下拉框选择并点击“应用到屏幕”。设备同步和校验成功后，桌面预览也会切换，
下次启动继续使用该包。修改当前包文件或保存布局后，可点“重新同步当前包”。
首次应用或文件内容变化时，桌面端会分块传输并校验；有 microSD 卡时，已传过的角色包按
内容指纹缓存在设备上，再次选择只发送切换指令。同一角色包未变化时也会直接跳过传输。
没有 microSD 卡时只能保留当前包，切换到其他包仍需传输。
主要入口如下：

- `events.yaml`：标准事件到行为的映射。
- `behaviors.yaml`：表情、动作、声音、灯光和文字的声明式时间线。
- `motions.yaml`：0.1 度单位的目标角度、速度和回中/释放策略。
- `sounds.yaml`、`lights.yaml`、`visuals.yaml`：硬件和视觉资源定义。
- `ui.yaml`：320×240 逻辑画布、场景继承、额度别名和组件布局。

桌面端在同步前拒绝路径穿越、符号链接、越界组件、重复 ID、未知资源引用、单文件超过
8 MiB 或整包超过 48 MiB。固件在 `/agentling.staging` 完整接收并校验后才切换；失败时保留
当前包和 `/agentling.previous`。大包应使用 microSD，内部 LittleFS 会按实际容量拒绝写入。

## 架构与协议

```text
Codex session logs ─┐
Codex Hooks ────────┤
Codex App Server ───┼──> desktop runtime ──USB Serial──> StackChan firmware
Clock / Weather ────┘          │                            │
MCP temporary cues ────────────┘                            ├─ display/touch
                                                            ├─ sensors/camera
                                                            ├─ bounded servos
                                                            ├─ speaker
                                                            └─ 12 RGB LEDs
```

- 主进程拥有持久状态、优先级、重连、Provider 和设备连接；渲染器不直接访问账户或串口。
- 第三方 Agent 可通过标准事件接入；独立适配器建议使用 NDJSON/JSON-RPC stdio，避免把依赖
  放进主进程。
- 设备只收到显示所需的标签、百分比、重置时间和新鲜度，不接收账户令牌或身份信息。
- 协议字段与重连规则见 [`docs/PROTOCOL.md`](docs/PROTOCOL.md)。

## 本地验证

```bash
npm run typecheck
npm test
npm run build
npm run firmware:build
```

这些命令只能证明本机构建和静态/单元测试通过。真机触摸、舵机方向、扬声器音量、拔线回滚和
24 小时稳定运行必须连接 K151 后另行验收。

## 许可证

MIT，见 [`LICENSE`](LICENSE)。第三方依赖按各自许可证分发。
