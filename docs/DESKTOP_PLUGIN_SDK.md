> **RETIRED (2026-09-02).** FormLogic Desktop has been removed from this
> repository; its role — local models, services, hardware and headless flows
> paired to a FormLogic account — is filled by [OAIY](https://oaiy.com), which
> speaks the same pairing, relay and event contracts the web app and backend
> still serve. This document is kept as the record of how that side of the
> contract was designed; nothing below describes code that ships from here.

# FormLogic Desktop — Plugin SDK Contract

**Status:** Phase 0 contract (frozen 2026-07-07). Schemas: `docs/contracts/plugin-manifest.schema.json`, `desktop-event.schema.json`, `connector-request.schema.json`, `connector-response.schema.json`.
**Host implementation:** this repo → `formlogic/desktop/src-tauri/src/plugins/`. **Reference plugin:** `f2i-com/aokie.com` → `crates/aokie-plugin`.

## 1. Layout

```
<desktop-data>/plugins/<plugin-id>/
  manifest.json          # plugin-manifest.schema.json
  <entry.command>        # executable, path relative to this dir
  ...                    # any plugin-private files (its own DB, logs, models)
```

Desktop discovers plugins by scanning that directory at startup and on `GET /api/plugins`. Built-in plugin *templates* may be bundled with the installer and materialised on first enable.

## 2. Lifecycle

States: `installed → stopped → starting → running → (unhealthy | crashed) → stopped`, plus `disabled` (user opt-out; never auto-started).

- **Start:** Desktop spawns `entry.command entry.args...` with cwd = plugin dir, stdio piped. Env: `FORMLOGIC_PLUGIN_ID`, `FORMLOGIC_PLUGIN_DATA_DIR` (a per-plugin writable dir), `FORMLOGIC_DESKTOP_VERSION`, `FORMLOGIC_PLUGIN_API_VERSION`, `FORMLOGIC_DEV_MODE=1` (when dev). No other env inherited beyond a minimal allow-list (PATH, SystemRoot, TEMP on Windows).
- **Handshake:** Desktop sends `plugin.init`; the plugin must respond within 10 s or it is killed and marked `crashed`.
- **Health:** Desktop calls `plugin.health` every 10 s; 3 consecutive misses → `unhealthy` (process kept, surfaced in UI). Process exit → `crashed`; auto-restart with exponential backoff, max 3 attempts, then stays `crashed` until manual start.
- **Stop:** `plugin.shutdown`, 5 s grace, then kill.
- **Logs:** stdout lines that are not valid JSON-RPC and all stderr lines are captured to a ring buffer (`GET /api/plugins/{id}/logs`).

## 3. Wire protocol — JSON-RPC 2.0, newline-delimited, over stdio

One JSON object per line (`\n`-terminated, UTF-8, no Content-Length framing). Max line 1 MiB.

### Desktop → plugin (requests)

| Method | Params | Result |
|---|---|---|
| `plugin.init` | `{desktopVersion, pluginApiVersion, dataDir, devMode, features?}` — `features` is a string array of host capabilities the plugin may opt into; currently `"eventAck"` (durable event delivery, below). Absent/empty = a legacy host. | `{ok: true, manifest?}` |
| `plugin.health` | `{}` | `{status: "ok"\|"degraded"\|"error", detail?}` |
| `plugin.shutdown` | `{}` | `{ok: true}` |
| `connector.request` | `connector-request.schema.json` (`{connectorId, command, payload?, timeoutMs?, requestId?}`) | `connector-response.schema.json` success body (`{ok:true, data?}`) — command errors are returned as JSON-RPC errors with `error.data = {code, message}` using the typed connector codes |

### Plugin → desktop (notifications, no id)

| Method | Params |
|---|---|
| `event.emit` | `{event: <desktop-event envelope>}` — envelope per `desktop-event.schema.json`. Desktop validates: `source`/`pluginId` must match the plugin, `name` must be declared in manifest `events`, size ≤ 64 KiB. Invalid events are dropped + logged, never forwarded. |
| `log.emit` | `{level: "debug"\|"info"\|"warning"\|"error", message}` (≤ 2 KiB, redacted by the plugin) |

### Desktop → plugin (notifications, no id) — durable delivery (`eventAck`)

When the host advertised `eventAck` in `plugin.init`, it journals every `event.emit`
envelope carrying an `idempotencyKey` to a durable per-plugin receipt log
(`<plugin-data>/host-event-receipts.jsonl`, fsynced) BEFORE acknowledging:

| Method | Params |
|---|---|
| `event.ack` | `{idempotencyKey}` — the envelope with this key is durably journaled; the plugin may stop re-delivering it. |

Contract: delivery is **at-least-once** — a plugin that never receives the ack (host
crash, lost write) re-emits the SAME envelope with the SAME `idempotencyKey` on a
backoff schedule; the host dedupes on the key (re-acks, does not re-publish to the
event bus). Plugins that ignore `event.ack` (or hosts that never send it) keep the
legacy fire-and-forget semantics unchanged.

### Plugin → desktop (requests, WITH id)

| Method | Params → Result |
|---|---|
| `flow.run` | `{flowSlug?, flowJson?, appSlug?, input?, correlationId?, idempotencyKey?, timeoutMs?}` → `{runId, status}`. Runs a FormLogic Flow through the desktop's headless flow runtime (slug resolved via the linked account, or an inline `flowJson`). **Gated:** the manifest must declare the `flow.run` capability (else JSON-RPC error with `error.data.code = "capability_denied"`); with no FormLogic account linked, `error.data.code = "runner_unavailable"`. |

A plugin makes a request by sending a JSON-RPC object **with an `id`** (numeric); Desktop replies with a correlated `{jsonrpc, id, result}` or `{jsonrpc, id, error}` over the plugin's stdin. Only `flow.run` is supported today — any other method → `-32601`.

### Rules

- The plugin must never write non-protocol output to stdout (use stderr or `log.emit`).
- `connector.request` commands not declared in the manifest's `connectors[].commands` are rejected by Desktop **before** reaching the plugin (`capability_denied`); the plugin must still validate defensively.
- Events must carry stable `idempotencyKey`s — consumers dedupe; duplicates are expected under crash/retry.
- Unknown methods → JSON-RPC error `-32601`; the plugin must not crash on them (forward compatibility).

## 4. Capability model

`manifest.capabilities` is the full permission surface of the plugin, expressed as FormLogic permission strings (`connector.<connectorId>.<command-prefix>`; wildcards `connector.aokie.*` allowed). The bare `flow.run` capability (or `flow.*`) additionally gates the plugin→desktop `flow.run` RPC — a plugin that does not declare it gets `capability_denied` when it asks Desktop to run a flow. Desktop's gateway (`POST /api/connectors/{id}/request`) checks, in order:

1. valid pairing token bound to the calling origin (`auth_required` / `origin_denied`);
2. connector exists and its plugin is `running` (`connector_missing` / `connector_unavailable`);
3. command declared in the manifest (`capability_denied`);
4. forwards to the plugin; plugin errors surface as `command_failed` (or the plugin's own typed code).

FormLogic app-level role grants (`connector.aokie.call.answer` etc.) are enforced **in FormLogic** (app-logic permission model) before the browser ever calls Desktop — the two layers are independent and both mandatory.

## 5. Versioning & compatibility

- `pluginApiVersion` — integer protocol version (currently 1). Desktop supports a declared range and refuses others with state `disabled` + reason.
- `minDesktopVersion` — semver check against the Desktop version.
- The manifest is validated against `plugin-manifest.schema.json`; invalid manifests surface as an errored install, never a silent skip.

## 6. Dev template

`f2i-web/desktop/plugin-template/` ships a minimal Node/Rust example implementing init/health/shutdown, one connector command (`echo.ping`), and a periodic mock `event.emit` — used by the host's integration tests and as a starting point for new plugins.
