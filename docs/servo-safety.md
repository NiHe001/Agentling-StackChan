# Servo control and validation (0.7.0)

The motion path reuses StackChan-BSP 1.1.0's spring animation, speed mapping,
tenth-degree units, default zeros (yaw 460 / pitch 620) and
`WritePos(id, raw, 20, 0)`. Upstream:
https://github.com/m5stack/StackChan-BSP/tree/1.1.0

## Observed cause of failed feedback

On this device, cycling the servo rail and waiting 500 ms repeatedly produced
no-reply errors. The independent, unpatched vendor transport baseline started
receiving valid replies late in the sequence. With a 2000 ms startup delay,
all ten samples on EACH axis passed: yaw raw 486, pitch raw 617, torque 0.
The integrated firmware then read both axes successfully with the same delay.
This rules out a completely broken RX path; it does not prove the root cause of
every earlier fast movement. The old upstream angle conversion can transform a
failed raw read (-1) into a valid-looking endpoint, which remains guarded.

## Behavior

- No boot movement, automatic return home, raw-count recovery loop or automatic
  calibration. The old recovery endpoint explicitly rejects requests.
- Use a normal move with yaw=0/pitch=0 for the default pose.
- One target per command; official spring speed parameter = percentage × 10.
  This is an animation parameter, not a constant physical angular velocity.
- Yaw ±30°, pitch 0–20°, speed 10–50%, hold 300–2000 ms, cooldown 1 second.
- Wait 2 seconds after rail power-up; read position with torque off, synchronize
  the retained raw target and verify its readback, then enable both axes.
- Failed reads never enter angle conversion or become an animation endpoint.
  Valid readings have a 1.5° mechanical boundary tolerance (e.g. pitch raw 617
  versus nominal zero 620); only this small valid boundary offset is clamped.
- Use the official animation/movement-stopped completion criterion before the
  hold timer starts. Return measuredBeforeRelease: completion is not a promise
  of exact angular accuracy. Then release torque and rail power at the endpoint.
  Position after release is unknown (`null`), not assumed centered or held.
- Feedback failure, 20-second movement timeout or host heartbeat loss ends the
  operation and powers off. The desktop timeout includes the startup delay.
- Autonomous character-pack head motions remain disabled.
- Inspection queries both axes independently, reports raw/zero/goal/errors and
  target-write counters, never writes a goal, and powers off afterward.

## Build and diagnostics

The adapter patch is generated from the exact upstream Git revision
`f7ed40e6f5d9a1d08440cb926f3a0865b81882f8` in PlatformIO's dependency cache.
Only the managed dependency sources are regenerated. The application and
diagnostic environment use separate library directories. There is one UART
owner and all integrated servo operations use the existing Motion mutex.

```sh
npm run test:servo
npm run typecheck
npm test
platformio run -d firmware -e stackchan-cores3
# Independent unpatched vendor transport, no Motion or position writes:
platformio run -d firmware -e servo-baseline
```

The baseline source is `firmware/diagnostics/servo-baseline.cpp`. After flashing
it, send `r` at 921600 baud to repeat the diagnostic. Restore the
`stackchan-cores3` firmware afterward. The baseline sends torque-off and read
commands only, and never writes EEPROM or calibration.

Host tests cover invalid reads, boot inactivity, official position/time/speed
mapping, off-center initialization, default zero fallback, goal-readback
failure, no goal writes during inspection, feedback loss and angle rejection.
Host tests do not establish mechanical velocity or physical alignment.
