# USB 设备协议 v1

每条消息先编码为 CBOR map，尾部追加大端 CRC32，再经过 COBS 编码并以 `0x00` 分帧。默认
串口速率为 921600。

```ts
interface Envelope<T> {
  protocol: 1;
  epoch: number;
  sequence: number;
  ack?: number;
  type: string;
  sentAt: number;
  payload: T;
}
```

- 每次连接/启动生成新 `epoch`，同一 epoch 内 `sequence` 单调递增。
- `ack` 是对端已完整接收的累计序号。角色包事务逐帧等待 ACK；清单和 2 KiB 分片超时后最多重试 2 次，提交帧保持单次发送，随后回读设备端包 ID、版本和校验错误。
- 固件丢弃同一 host epoch 内的重复或倒退序号；host 重连后先发送完整快照。
- 断线时固件保留最后状态并显示离线标记，不重放上一个 epoch 的 `ActionCue`。
- 设备诊断请求在本地 USB 链路上最多尝试 3 次，避免角色已提交但末次 `device.hello` 丢失时误报同步失败。
- 单个固件接收帧上限 24 KiB；桌面端角色包块固定为 2 KiB，避免图片解码或存储写入期间
  撑满 USB CDC 接收队列。

## 消息类型

| 类型 | 方向 | 用途 |
|---|---|---|
| `device.hello` | 双向 | 协议版本、固件版本、屏幕和执行器能力 |
| `agent.snapshot` | host → device | 多任务、选中任务、每任务最新安全报告与聚合状态；空闲时 1 Hz 心跳 |
| `widget.snapshot` | host → device | 时间、天气、额度与别名 |
| `action.cue` | host → device | 一次性行为和带 TTL 的临时表达结果 |
| `pack.manifest` | host → device | 文件大小与 SHA-256 清单，开始事务 |
| `pack.chunk` | host → device | 路径、偏移、二进制块 |
| `pack.commit` | host → device | 校验全部文件并原子切换 |
| `input.event` | device → host | 点击、滑动和任务切换 |
| `sensor.request` | host → device | 请求一次只读传感器快照 |
| `sensor.snapshot` | device → host | 电池、IMU、环境光/接近和触摸快照，带设备运行时间 |
| `camera.request` | host → device | 请求显示一次拍照授权界面，不会直接打开摄像头 |
| `camera.chunk` | device → host | 用户允许后，以 2 KiB 分片回传 JPEG |
| `camera.result` | device → host | 拒绝、超时、失败或 JPEG 完成元数据 |
| `hardware.light` | host → device | 限时灯光参数，到期恢复之前状态 |
| `hardware.sound` | host → device | 受限音量/时长的角色包预设音 |
| `hardware.servo` | host → device | 官方弹簧动画单次运动；位置反馈有效才允许启动，到达目标后释放，不自动回中 |
| `hardware.servo.home` | host → device | 已移除自动恢复；旧接口返回明确错误，默认姿态使用普通运动 yaw=0、pitch=0 |
| `hardware.servo.inspect` | host → device | 上电等待 2 秒，分别查询两个舵机，关闭电源；不写目标位置 |
| `hardware.result` | device → host | 硬件命令接受或拒绝原因 |
| `ack` | device → host | 显式确认；envelope 同时携带累计 ACK |
| `error` | device → host | 协议、存储或角色包错误 |

## 隐私边界

设备协议不传输 Codex access token、账户 ID、提示词、工具输入输出、源代码或完整日志。任务
只包含标题、状态、工具名、子任务数和最多 96 字的一行报告；桌面端的 40 条事件历史不会通过
串口重复下发。额度数据只包含 `limitId`、标签、剩余百分比、窗口时长、重置时间和 stale 状态。

真实事件会立即发送；无新事件时每秒发送一次小型 `agent.snapshot` 作为在线心跳。该心跳不调用
模型且不消耗 token。固件比较状态、选中任务和报告，内容不变时不触发额外界面重绘。

摄像头默认关闭。`camera.request` 只创建 15 秒的真机确认窗口；必须点击屏幕中明确标注的
“允许”按钮才会初始化摄像头。照片只经 USB 回传并由桌面端写入仅当前用户可读的临时文件，
协议不会自动上传图片。麦克风未通过 MCP 暴露。

直接灯光命令最长 30 秒，真实生命周期灯效可提前覆盖它。直接声音仅能引用当前角色包
预设，音量不超过 50%，播放不超过 3 秒。云台硬件侧再次限制水平 ±30°、俯仰 0–20°、
速度 10–50%、保持 0.3–2 秒；速度映射到官方 BSP 的 100–500 动画参数，并非恒定角速度。运动期间拒绝并发，
使用官方的动画结束、舵机停止判定后开始保持计时，然后释放扭矩并切断舵机电源，不自动回中。
结果 measuredBeforeRelease 返回断电前实测角度；ok 表示动作完成，不保证目标角度的精确度。
上电后等待 2 秒再初始化位置。失去反馈、超时或主机离线会结束动作并断电。
断电后 motion.yawDegrees/pitchDegrees 为 null（位置未知），不会伪报为 0°。
完成后还有 1 秒硬件侧冷却时间，防止高频重复启动。

## 扩展规则

新增 Agent 不增加设备消息类型，而是在 `agent.snapshot` 中使用新的 `source` 并输出同一套标准
状态。新增信息 Provider 优先映射为通用 widget 数据；无法识别的 CBOR 字段必须跳过，以保持
向前兼容。
