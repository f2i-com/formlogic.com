# Aokie Receptionist — Operations Runbook

Operating the AI phone receptionist: the desktop stack, deploy/restart
recipes, and how to diagnose a live problem. The plugin's own architecture is
in the aokie repo's `docs/ARCHITECTURE.md`; this is the FormLogic-side operator
view.

## The stack

FormLogic Desktop spawns and supervises everything:

| Process | Port | Role |
|---|---|---|
| `formlogic-desktop.exe` | 17872 (loopback API) | The Tauri host + flow runtime |
| `aokie-plugin.exe` | — (stdio) | The phone bridge + voice agent |
| `aokie-voice-server.exe` | 17920 (loopback) | STT/TTS service |
| `llama-server.exe` | 8080 (loopback) | Local LLM the agent reuses |

## Restart recipe (the important gotcha)

Services spawned by the desktop **inherit its `127.0.0.1:17872` listener
handle**, so killing only the desktop leaves the port wedged by a dead PID's
children and a relaunched instance serves nothing ("Loading services…"). The
holders are `llama-server.exe` + `aokie-voice-server.exe`. Always kill all four
together:

```powershell
Stop-Process -Name formlogic-desktop,aokie-plugin,llama-server,aokie-voice-server -Force
# verify the port is free before relaunching:
Get-NetTCPConnection -LocalPort 17872   # must return nothing
# relaunch the desktop; it respawns the plugin + services itself:
Start-Process formlogic-desktop.exe
# services do NOT auto-restart with the desktop — start them explicitly:
Invoke-WebRequest -Uri http://127.0.0.1:17872/api/services/llama-cpp/start -Method POST
Invoke-WebRequest -Uri http://127.0.0.1:17872/api/services/aokie-voice/start -Method POST
```

`llama-server` answers 503 on :8080 while the model loads, then 200 after ~30 s.

## Deploying a new plugin build

The plugin exe is **locked while Aokie is connected**, so it must be replaced
while the stack is down (the four-process kill above frees it). Build with the
helper hash pinned (release-signing gate), then copy into the plugins dir:

```bash
export AOKIE_EXPECTED_HELPER_SHA256=<sha256 of the deployed aokie-driver-helper.exe>
cargo build -p aokie-plugin --features voice --release   # in the aokie repo
cp target/release/aokie-plugin.exe \
   "$APPDATA/com.formlogic.desktop/plugins/aokie/aokie-plugin.exe"
```

The flow runtime caches app bindings with a ~60 s TTL, so a DB-added binding is
picked up within a minute — no reconnect needed.

## Diagnosis — one endpoint

`GET http://127.0.0.1:17872/api/desktop/support-bundle` is the privacy-safe
diagnostics document (no tokens, no conversation content). It answers, in one
call:

- **flowRuntime** — `linked`, `errors`, `lastError` (the first place a flow or
  record-write failure surfaces).
- **plugins[].health.components** — the plugin's computed readiness:
  - `build{version, ref}` — exactly which build answered.
  - `radio{initialized, phoneConnected, callActive, staleSttResults, error}`.
  - `outbox{pending, failed, dead}` — dead > 0 means events need a redrive.
  - `config{version, quarantined}` — which settings revision, and whether the
    settings file was corrupt.
- **journals** — per-plugin `receipts` vs `processedMarkers`. A mismatch is the
  crash-recovery signal (events journaled but not yet processed).

## Recovering dead events

Dead-lettered outbox rows are shown in the support bundle. Redrive them through
the connector:

- One event: `outbox.redrive {idempotencyKey: "…"}`
- The whole dead set: `outbox.redrive {all: true}`

The receipts journal dedupes anything that actually made it through before
dead-lettering, so a redrive can never double-publish.

## Records retention

Caller-PII forms (Calls, Transcript Turns, SMS Threads/Messages, Hardware
Events) carry `retentionDays: 90`; expired responses are purged through the
full deletion path (SQLite + MySQL metadata + uploaded files) on an
hour-throttled sweep inside the response pipeline. Business records
(Customers, Appointments, Orders, Follow-ups) are deliberately permanent.

## Timezone

"Today" on the dashboard and relative date filters resolve in the **app's**
timezone (`app settings → timezone`), not the server's UTC. Set it, or a UTC+
business sees day boundaries hours off.
