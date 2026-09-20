# Desktop management MCP

The desktop app owns the serial connection. MCP is a stdio bridge to its
loopback HTTP API; keep the desktop app running. No computer-use UI is required.

Configure an MCP client with command `node` and argument
`/Users/zhaolq/develop_zlq/AIRobot/Agentling-StackChan/dist/mcp/index.js`.
Build it with `npm run build` after source changes.

Optional environment variables: `AGENTLING_ENDPOINT` (default
`http://127.0.0.1:17321`) and `AGENTLING_TOKEN` (must match the host config token).

Tools:

- `agentling_status`: desktop snapshot, selected pack and its layout.
- `agentling_list_ports`, `agentling_connect(path)`, `agentling_disconnect`.
- `agentling_diagnostics`: live firmware version, active pack, internal storage,
  current expression, last successfully drawn PNG and rendering errors.
- `agentling_sensor_snapshot`: one live read-only snapshot of body battery,
  accelerometer/gyroscope/magnetometer, ambient/proximity raw channels, screen touch
  and the three head-touch zones.
- `agentling_wait_for_event(types?, after_id?, timeout_ms?)`: wait up to 30 seconds
  for a new screen gesture, head touch/swipe, or shake event. Omit `after_id` to
  ignore retained history and wait for the next physical event. Current event types
  are `tap`, `swipe_left`, `swipe_right`, `task_next`, `head_touch`,
  `head_swipe_forward`, `head_swipe_backward`, and `shake`.
- `agentling_camera_capture`: display an explicit Reject/Allow prompt on the robot,
  capture one QVGA frame only after the user taps Allow, and return a private local
  JPEG path. A timeout or rejection returns an error and the camera remains off.
- `agentling_light_set(color, brightness?, mode?, period_ms?, ttl_ms?)`: temporarily
  drive all 12 RGB LEDs using `solid`, `breathe`, `pulse`, or `chase`; brightness is
  capped at 80% and TTL at 30 seconds.
- `agentling_sound_play(preset, volume_percent?, max_duration_ms?)`: play a sound
  declared by the active character pack, capped at 50% volume and 3 seconds.
- `agentling_servo_move(yaw_degrees, pitch_degrees, speed_percent?, hold_ms?)`:
  official spring animation, yaw ±30°, pitch 0–20°, speed 10–50%. Waits for
  feedback and arrival, holds 300–2000 ms, then releases at the destination.
  No automatic home. Explicit yaw=0/pitch=0 requests the default pose.
- `agentling_servo_recover_home()`: removed; compatibility endpoint rejects.
- `agentling_servo_inspect()`: waits 2 seconds after rail power-up, queries
  both servo IDs, then powers off. Does not write any target position.
- `agentling_pack_validate(directory)`: read-only validation.
- `agentling_pack_load(directory)`: select a pack for the current desktop session.
- `agentling_layout_save(ui)`: validate and save the complete layout to ui.yaml.
- `agentling_pack_sync`: upload the selected pack; allow a 120-second tool timeout.
- `agentling_show`, `agentling_progress`, `agentling_clear`: temporary expressions;
  they do not forge real lifecycle events.

Typical workflow: status → edit pack files → validate → load → sync → diagnostics.
After synchronization, query diagnostics again to check `renderedAsset` and
`renderError`; a transport acknowledgement alone does not prove successful drawing.
Pack selection through MCP is session-only; the existing desktop directory picker
persists the selection across restarts.

Registration-only smoke test: `node scripts/mcp-smoke.mjs --list-only`.
Connected-device smoke test: `node scripts/mcp-smoke.mjs agentling_diagnostics`.
This uses the real MCP SDK client and stdio transport, not direct UI automation.

Camera JPEGs are written under the operating system temporary directory with
owner-only permissions. They are not uploaded or passed to a model automatically.

The HTTP API rejects browser-origin requests; tokenless access is intended only
for a trusted local machine. Configure a token on shared machines. No arbitrary
shell execution or firmware flashing tool is exposed through MCP.
