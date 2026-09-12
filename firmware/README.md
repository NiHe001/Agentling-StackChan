# Agentling StackChan firmware

Target: the official M5Stack StackChan K151 with CoreS3. The firmware uses the official
`StackChan-BSP` Arduino library, including its feedback-servo and 12-RGB-LED drivers. It does not
drive guessed PWM pins.

## Build and flash

Install PlatformIO, then run from the repository root:

```bash
platformio run -d firmware
platformio run -d firmware -t upload
platformio device monitor -d firmware -b 921600
```

Flashing replaces the factory firmware. Keep M5Burner available if you need to restore the factory
image. Do not turn the head by hand while servo torque is enabled.

Character-pack updates are stored in the CoreS3's internal LittleFS partition, so a microSD card is
not required. Updates are written to `/agentling.staging`, SHA-256 verified, and renamed atomically;
`/agentling.previous` is retained as the recovery copy. If no valid pack exists, the compiled rescue
face remains usable.
