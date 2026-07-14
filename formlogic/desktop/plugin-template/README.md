# FormLogic Desktop — plugin template

A minimal, protocol-complete FormLogic Desktop plugin in Node. Use it as the
starting point for new plugins; the host's integration tests exercise the same
protocol via the Rust `mock-plugin` binary (`src-tauri/src/bin/mock-plugin.rs`).

**Normative contract:** `formlogic-app/docs/DESKTOP_PLUGIN_SDK.md` — plus the
schemas in `docs/contracts/` of this repo:
`plugin-manifest.schema.json`, `desktop-event.schema.json`,
`connector-request.schema.json`, `connector-response.schema.json`.

## Install it

Copy this folder into the FormLogic Desktop data dir, named after the plugin
id (the folder name MUST equal `manifest.json`'s `id`):

```
<desktop-data>/plugins/hello-node/
  manifest.json
  index.mjs
```

(The data dir is shown at the top of the Services tab; plugins live in its
`plugins/` subfolder — the Plugins tab has an "open" button.) The plugin
appears in the Plugins tab on the next poll — click **Start**. Requires
`node` on PATH (the manifest's `entry.command` is the bare name `node`,
which resolves via PATH; a path with a separator like `bin/tool.exe`
resolves inside the plugin folder instead).

## What the host guarantees / enforces

- **Spawn:** cwd = the plugin folder; stdio piped; minimal env only
  (`PATH`, plus `SystemRoot`/`TEMP`/`TMP` on Windows) + `FORMLOGIC_PLUGIN_ID`,
  `FORMLOGIC_PLUGIN_DATA_DIR` (your writable dir), `FORMLOGIC_DESKTOP_VERSION`,
  `FORMLOGIC_PLUGIN_API_VERSION`, and `FORMLOGIC_DEV_MODE=1` in dev.
  No secrets are inherited.
- **Handshake:** answer `plugin.init` within 10 s or be killed (`crashed`).
- **Health:** `plugin.health` every 10 s; 3 consecutive misses → `unhealthy`
  (process kept). Process exit → `crashed` + auto-restart with exponential
  backoff, max 3 attempts.
- **Stop:** `plugin.shutdown`, 5 s grace, then kill.
- **Commands:** `connector.request` only ever arrives for commands declared in
  `manifest.connectors[].commands` AND covered by `manifest.capabilities`
  (undeclared → `capability_denied` before reaching you). Validate
  defensively anyway.
- **Events:** `event.emit` envelopes are validated — `source`/`pluginId` must
  be YOUR plugin id, `name` must be declared in `manifest.events`, size
  ≤ 64 KiB. Invalid events are dropped and logged, never forwarded. Use
  stable `idempotencyKey`s (`<source>:<correlationId>:<step>:v1`) — consumers
  dedupe; duplicates are expected under crash/retry.
- **Logs:** non-protocol stdout + all stderr land in a per-plugin ring buffer
  (`GET /api/plugins/hello-node/logs`, or the Logs button in the Plugins
  tab). Keep `log.emit` messages ≤ 2 KiB and redact PII before emitting.

## Try it from the API

The plugin API needs auth: from a paired web origin use its bearer token; the
Desktop window's own UI is trusted automatically. For quick dev-mode poking,
launch Desktop with `FORMLOGIC_DESKTOP_DEV_ALLOW_ORIGIN=http://localhost:5173`
and pair from that origin, then:

```
POST http://127.0.0.1:17872/api/connectors/hello-node/request
{ "connectorId": "hello-node", "command": "echo.ping", "payload": { "hi": 1 } }
→ { "ok": true, "data": { "echo": { "hi": 1 } } }
```

Subscribe to events (SSE; `id:` = idempotencyKey, `event:` = name):

```
GET http://127.0.0.1:17872/api/events?token=<pairing token>
```

## Checklist for a real plugin

1. Pick a stable `id` (lowercase, `[a-z][a-z0-9-]{1,63}`); folder name = id.
2. Declare EVERY command under a connector and cover it with a capability;
   declare every event name you emit.
3. `entry.command` must be relative (no absolute paths, drive letters or
   `..`) — ship your binary inside the plugin folder, or rely on PATH.
4. Keep stdout protocol-clean; one JSON object per line, ≤ 1 MiB.
5. Respond to unknown methods with `-32601` — never crash on them.
6. Store your private state under `FORMLOGIC_PLUGIN_DATA_DIR`, not the
   plugin folder (reinstalls replace the plugin folder).
