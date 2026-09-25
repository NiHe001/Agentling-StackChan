# Agentling StackChan firmware

The current firmware reports **0.8.0** and includes the official-animation servo adapter. Automatic
home recovery is removed; cold rail startup waits 2 seconds before reads. See
[servo safety and validation](../docs/servo-safety.md).

Target: the official M5Stack StackChan K151 with CoreS3. The firmware uses the official
`StackChan-BSP` Arduino library, including its feedback-servo and 12-RGB-LED drivers. The firmware
renders the selected task, a 24 px lifecycle headline, readable quota details, and state-led character
micro-motion while keeping servo torque and power disabled at rest. The 1 Hz lightweight state heartbeat does
not request another redraw when its content is unchanged. Device diagnostics expose the current visual
offset, scale, and phase so animation progress can be checked without a camera. The six LEDs on each
side are updated as corresponding pairs and committed with one shared refresh, so breathe, pulse, and
chase effects stay synchronized.

It also provides on-demand battery, IMU, ambient/proximity and touch snapshots; emits
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
Quit the Agentling desktop app before flashing: it normally holds the same USB serial port. Select
the CoreS3 port explicitly with `--upload-port /dev/cu.usbmodemXXXX` when more than one port exists,
then restart the app and check device diagnostics after the flash completes.

A non-looping expression remains for 850 ms after its final timeline step, then the device restores
the latest aggregate task expression and the light for ongoing work, idle, or waiting states. This
covers overlapping tasks and quota alerts without changing the authoritative lifecycle state.

Character-pack updates prefer a mounted CoreS3 microSD/TF card and fall back to internal LittleFS
when no card is available. Files are written to `/agentling.staging` and SHA-256 verified. On microSD,
the active pack stays at `/agentling` and previous packs move to `/agentling.cache/<content-digest>`.
Selecting a cached pack sends only `pack.activate` and switches these directories; changed content is
transferred again. A pack already active is skipped even on LittleFS. An old pack without a digest is
kept at `/agentling.previous` during the first upgrade. A blank inserted card is used by the next pack
sync; until then an existing LittleFS pack remains active. If no valid pack exists, the compiled rescue
face remains usable. The cache is not evicted automatically; remove old cache directories from the
microSD card if it becomes full.
