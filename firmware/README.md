# Agentling StackChan firmware

The source includes the **0.7.0** official-animation servo adapter. Automatic
home recovery is removed; cold rail startup waits 2 seconds before reads. See
[servo safety and validation](../docs/servo-safety.md).

Target: the official M5Stack StackChan K151 with CoreS3. The firmware uses the official
`StackChan-BSP` Arduino library, including its feedback-servo and 12-RGB-LED drivers. Firmware 0.6.2
renders the selected task, a 24 px lifecycle headline, readable quota details, and state-led character
micro-motion while keeping servo torque and power disabled at rest. The 1 Hz lightweight state heartbeat does
not request another redraw when its content is unchanged. Device diagnostics expose the current visual
offset, scale, and phase so animation progress can be checked without a camera. The six LEDs on each
side are updated as corresponding pairs and committed with one shared refresh, so breathe, pulse, and
chase effects stay synchronized.

Firmware 0.6.2 also provides on-demand battery, IMU, ambient/proximity and touch snapshots; emits
screen/head-touch and shake events; and supports one-shot QVGA camera capture. Camera access always
shows a 15-second on-device Reject/Allow prompt, initializes the camera only after Allow is tapped,
then deinitializes it after the JPEG has been sent over USB. Direct commands can temporarily control
the LEDs or play a bounded character-pack sound preset. Remote servo movement
uses the official animation after valid feedback and target synchronization.
It releases at the requested destination without returning home. Invalid reads
never become endpoint angles. Autonomous pack-driven motion remains disabled.
Microphones remain unavailable to MCP.

## Build and flash

Install PlatformIO, then run from the repository root:

```bash
platformio run -d firmware
platformio run -d firmware -t upload
platformio device monitor -d firmware -b 921600
```

Flashing replaces the factory firmware. Keep M5Burner available if you need to restore the factory
image. Do not turn the head by hand while servo torque is enabled.

Character-pack updates prefer a mounted CoreS3 microSD/TF card and fall back to internal LittleFS
when no card is available. Updates are written to `/agentling.staging`, SHA-256 verified, and renamed
atomically; `/agentling.previous` is retained as the recovery copy. A blank inserted card is used by
the next pack sync; until then an existing LittleFS pack remains active. If no valid pack exists, the
compiled rescue face remains usable.
