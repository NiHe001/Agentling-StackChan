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

Smoke test: `node scripts/mcp-smoke.mjs agentling_diagnostics`.
This uses the real MCP SDK client and stdio transport, not direct UI automation.

The HTTP API rejects browser-origin requests; tokenless access is intended only
for a trusted local machine. Configure a token on shared machines. No arbitrary
shell execution or firmware flashing tool is exposed through MCP.
