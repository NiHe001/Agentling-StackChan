# Agentling StackChan

Agentling StackChan 是一个面向 M5Stack StackChan K151/CoreS3 的可配置桌面 Agent
伙伴。它把 Codex 的权威生命周期、5 小时/每周用量、时间和天气汇总在 macOS
常驻程序中，再通过 USB Serial 驱动屏幕、双舵机、扬声器和 12 颗 RGB 灯。

项目不使用 Codex 桌面宠物的内部素材；默认角色 `Agentling Mint` 是程序化绘制的原创脸。

## 已实现

- Electron + React + TypeScript 菜单栏程序和 320×240 硬件模拟器。
- Codex Hooks 适配器，多任务独立状态、乱序/重复事件保护和注意力优先级。
- Codex App Server `account/rateLimits/read` 与 `account/rateLimits/updated`，按窗口时长识别
  `5H`/`7D`，稀疏更新合并、5 分钟校准、过期和不可用显示。
- 可拖动布局编辑、角色包导入/校验、资源清单、SHA-256 校验和原子同步。
- STDIO MCP：`agentling_show`、`agentling_progress`、`agentling_clear`。表达必须带 TTL，
  Agent 真实事件会立即清除表达，失败和等待批准始终优先。
- Open-Meteo 天气 Provider，仅使用用户填写的城市经纬度，不做 IP 定位。
- CoreS3 固件：CBOR + COBS + CRC32、序号/累计 ACK、断线标记、触摸切任务、动作/声音/
  灯光调度、舵机限位与强制释放、LittleFS 事务更新及内置救援界面。
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

### 接入 Codex Hooks

先启动桌面程序，再执行：

```bash
npm run hooks:install
```

安装器会备份并合并 `~/.codex/hooks.json`，不会覆盖已有 Hook。请在 Codex 中检查并信任新增
命令。Hook 只转发事件名称、任务 ID、时间、工具名称和最多 80 字的安全状态；不会转发提示词、
工具输入输出、代码或 transcript 路径。

### 接入 MCP 表达工具

先构建，再把本项目的 MCP 进程加入 Codex：

```bash
npm run build
codex mcp add agentling -- node /absolute/path/to/Agentling-StackChan/dist/mcp/index.js
```

MCP 只是临时表现层，不能把真实状态改成完成、失败或等待批准。

### 构建和烧录固件

```bash
npm run firmware:build
npm run firmware:upload
platformio device monitor -d firmware -b 921600
```

烧录会替换原厂固件。首次建议先用 M5Burner 保存恢复路径。角色包存储在 CoreS3 内置
LittleFS，不要求额外插入 microSD 卡。详细说明见 [`firmware/README.md`](firmware/README.md)。

### macOS 打包

```bash
npm run package:dir
CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:mac
```

输出在 `release/`。未配置 Apple Developer 证书时只能生成未签名测试包；正式分发还需要签名和
公证。

## 角色包

完整格式见 [`docs/CHARACTER_PACK.md`](docs/CHARACTER_PACK.md)。默认包位于
[`packs/default`](packs/default)，主要入口如下：

- `events.yaml`：标准事件到行为的映射。
- `behaviors.yaml`：表情、动作、声音、灯光和文字的声明式时间线。
- `motions.yaml`：0.1 度单位的目标角度、速度和回中/释放策略。
- `sounds.yaml`、`lights.yaml`、`visuals.yaml`：硬件和视觉资源定义。
- `ui.yaml`：320×240 逻辑画布、场景继承、额度别名和组件布局。

桌面端在同步前拒绝路径穿越、符号链接、越界组件、重复 ID、未知资源引用、单文件超过
2 MiB 或整包超过 12 MiB。固件在 `/agentling.staging` 完整接收并校验后才切换；失败时保留
当前包和 `/agentling.previous`。

## 架构与协议

```text
Codex Hooks ───────┐
Codex App Server ──┼──> desktop runtime ──USB Serial──> StackChan firmware
Clock / Weather ───┘          │                            │
MCP temporary cues ───────────┘                            ├─ display/touch
                                                          ├─ two servos
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
