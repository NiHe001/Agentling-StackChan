# Agentling StackChan firmware

Target: the official M5Stack StackChan K151 with CoreS3. The firmware uses the official
`StackChan-BSP` Arduino library, including its feedback-servo and 12-RGB-LED drivers. Firmware 0.4.1
renders the selected task, a 24 px lifecycle headline, readable quota details, and state-led character
micro-motion while keeping servo torque and power disabled. The 1 Hz lightweight state heartbeat does
not request another redraw when its content is unchanged. Device diagnostics expose the current visual
offset, scale, and phase so animation progress can be checked without a camera. The six LEDs on each
side are updated as corresponding pairs and committed with one shared refresh, so breathe, pulse, and
chase effects stay synchronized.

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
