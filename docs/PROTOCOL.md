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
- `ack` 是对端已完整接收的累计序号。角色包事务逐帧等待 ACK，超时 5 秒即停止。
- 固件丢弃同一 host epoch 内的重复或倒退序号；host 重连后先发送完整快照。
- 断线时固件保留最后状态并显示离线标记，不重放上一个 epoch 的 `ActionCue`。
- 单个固件接收帧上限 24 KiB；桌面端角色包块固定为 16 KiB。

## 消息类型

| 类型 | 方向 | 用途 |
|---|---|---|
| `device.hello` | 双向 | 协议版本、固件版本、屏幕和执行器能力 |
| `agent.snapshot` | host → device | 多任务、选中任务与聚合状态 |
| `widget.snapshot` | host → device | 时间、天气、额度与别名 |
| `action.cue` | host → device | 一次性行为和带 TTL 的临时表达结果 |
| `pack.manifest` | host → device | 文件大小与 SHA-256 清单，开始事务 |
| `pack.chunk` | host → device | 路径、偏移、二进制块 |
| `pack.commit` | host → device | 校验全部文件并原子切换 |
| `input.event` | device → host | 点击、滑动和任务切换 |
| `ack` | device → host | 显式确认；envelope 同时携带累计 ACK |
| `error` | device → host | 协议、存储或角色包错误 |

## 隐私边界

设备协议不传输 Codex access token、账户 ID、提示词、工具输入输出、源代码或完整日志。额度
数据只包含 `limitId`、标签、剩余百分比、窗口时长、重置时间和 stale 状态。

## 扩展规则

新增 Agent 不增加设备消息类型，而是在 `agent.snapshot` 中使用新的 `source` 并输出同一套标准
状态。新增信息 Provider 优先映射为通用 widget 数据；无法识别的 CBOR 字段必须跳过，以保持
向前兼容。
