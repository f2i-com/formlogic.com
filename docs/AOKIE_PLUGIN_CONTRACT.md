# Aokie Desktop Plugin — Contract

**Status:** Phase 0 contract (frozen 2026-07-07). Builds on `docs/DESKTOP_PLUGIN_SDK.md`; schemas in `docs/contracts/`.
**Implementation:** `izuc/aokie` → `crates/aokie-core` (Tauri-free native logic) + `crates/aokie-plugin` (the JSON-RPC process). The legacy Aokie Tauri app keeps building against `aokie-core` during migration.

Aokie is a **plugin, not a platform**: it owns the Bluetooth dongle/phone bridge (WinUSB, HFP/SCO, MAP SMS, PBAP contacts) and emits events / executes commands. Business records, dashboards, roles, and flows live in FormLogic (app package: "Aokie Receptionist for FormLogic").

## 1. Identity

- Plugin id / connector id: `aokie`
- Manifest: `plugins/aokie/manifest.json` per `plugin-manifest.schema.json`, `pluginApiVersion: 1`.

## 2. Connector commands (surface FormLogic may call)

MVP set (must exist; hardware-dependent ones may return `command_failed` with a clear message, or mock data in dev mode):

```
dongle.list            dongle.getPreferred    dongle.setPreferred
dongle.installDriver   dongle.diagnostics
phone.status           phone.startPairing     phone.stopPairing     phone.listPaired
call.current           call.answer            call.reject           call.hangup
call.operatorSpeak
sms.threads            sms.thread             sms.send
settings.get           settings.set
```

Post-MVP (declared in the manifest only when implemented): `phone.syncContacts`, `call.takeOver`, `call.resumeBot`, `call.getTranscript`, `call.getRecordingInfo`, `sms.approveDraft`, `sms.rejectDraft`, `retention.get/set`.

Payload/response shapes follow the legacy Tauri commands they wrap (e.g. `sms.send {to, body}` → `{messageId, status:"queued"}`); each command handler validates its payload and rejects unknown fields.

**Canonical call-control shapes** (single source: `crates/aokie-plugin/src/contract.rs` in the aokie repo; test-locked against the manifest and both mocks):

- `call.answer` / `call.reject` / `call.hangup` accept `{callId?}`; `call.operatorSpeak` accepts `{text, callId?}`. When `callId` is present it MUST equal the plugin's current call id, else the typed **`stale_call`** error is returned and the phone is NOT touched (a stale browser tab can never control a newer call). An omitted `callId` acts on the current call (compatibility for flow/desktop callers).
- `call.current` → `{call: null | {callId, from?, callerName?, state, startedAt?, …}}` with `state ∈ ringing|active|ended`. The real radio, the plugin's dev mock and the browser mock all return exactly this shape.
- `phone.status` → `{paired, connected, device: null | {address, name, …}, …}` — the paired device is always NESTED under `device`; there is no root-level `deviceName`.

## 3. Events (envelope per `desktop-event.schema.json`, `source:"aokie"`)

MVP set:

```
aokie.dongle.detected        aokie.dongle.driver_required   aokie.dongle.ready    aokie.dongle.error
aokie.phone.pairing_started  aokie.phone.paired             aokie.phone.connected aokie.phone.disconnected
aokie.call.incoming          aokie.call.ringing             aokie.call.answered   aokie.call.rejected
aokie.call.audio.connected   aokie.call.audio.disconnected
aokie.call.turn.partial      aokie.call.turn.final          aokie.call.ended
aokie.sms.received           aokie.sms.sent                 aokie.sms.failed
aokie.hardware.error
```

The list is generated from ONE source (`contract.rs::events::ALL` in the aokie repo): the plugin's `manifest.json`, the desktop's bundled manifest copy and the flow event catalog must all declare exactly this set — Desktop silently drops any event a plugin emits without declaring, so drift here is a release blocker, and `cargo test -p aokie-plugin` fails on it.

Conventions:
- `correlationId` = call id (`call_<uuid>`), SMS handle, or pairing session id. Call ids are
  NEVER reused; internally each call also has a monotonic generation stamped through the
  async STT/LLM/TTS pipeline so a slow result from call A is dropped, never attributed to
  call B (audit AK-002/C-05; drops are visible as `staleSttResults` in `dongle.diagnostics`).
- `aokie.call.ended` data: `{callId, from, callerPhone, durationSeconds, durationMs, outcome,
  reason, at}`. `outcome ∈ completed|rejected|missed` comes from the call-session state
  machine (audit AK-001): answered → `completed` (even a sub-second call), operator-rejected
  → `rejected`, never answered → `missed`. `durationSeconds`/`durationMs` count from ANSWER.
- `idempotencyKey` = `aokie:<correlationId>:<step>:v1` (e.g. `aokie:call_abc:incoming:v1`; turn events append the turn index: `aokie:call_abc:turn.4.final:v1`).
- `data` carries the minimum needed by FormLogic (caller phone/name, timestamps, durations, transcript text for turn events). No raw audio over the event bus.

Mapping from the legacy internal events: `bt-call-incoming → aokie.call.incoming`, `bt-call-answered → aokie.call.answered`, `bt-call-terminated → aokie.call.ended`, `transcript(final) → aokie.call.turn.final`, MAP inbound → `aokie.sms.received`, etc.

## 4. Dev/mock mode

With `FORMLOGIC_DEV_MODE=1` (or command `settings.set {mockCalls:true}`), the plugin emits a scripted call lifecycle on demand (`dongle.diagnostics {simulate:"call"}` or automatically every N minutes when configured): `dongle.detected → dongle.ready → call.incoming → call.answered → 2× call.turn.final → call.ended → sms.received`. This drives FormLogic integration tests without hardware.

## 5. Local outbox (reliability)

The plugin maintains its own SQLite outbox (table `aokie_outbox`: `id, event_name, correlation_id, idempotency_key UNIQUE, target, payload_json, status pending|sent|failed|dead, attempts, last_error, created_at, updated_at`).

- Every **essential raw record** event (`call.incoming`, `call.answered`, `call.turn.final`, `call.ended`, `sms.received`, `sms.sent`, `hardware.error`) is written to the outbox before emission.
- **Ack-capable hosts** (Desktop advertising `features: ["eventAck"]` at `plugin.init` — audit INT-003): a written event stays `pending` until the host's `event.ack` notification confirms it was DURABLY journaled; a replay thread re-emits unacknowledged rows on exponential backoff (same `idempotencyKey`, host dedupes), dead-letters after max attempts, prunes acknowledged rows after 7 days (bounded PII retention), and on startup re-delivers anything a crash stranded. Legacy hosts keep the old write-marks-`sent` behaviour.
- The outbox runs in WAL mode with a busy timeout — the RPC, radio and replay threads each hold their own connection to the same file.
- Post-MVP, the outbox gains a second target: direct FormLogic API submission (so raw call records survive even with no browser open). The plugin never submits complex business decisions directly — those go through flows.

## 7. Triggering flows (plugin → desktop `flow.run`)

The plugin can trigger a FormLogic Flow directly through the desktop's headless flow runtime — the fast lane for on-device decisions during a live call, with no browser in the loop. This is the plugin→desktop `flow.run` RPC (see `docs/DESKTOP_PLUGIN_SDK.md` §3):

- The manifest MUST declare the `flow.run` capability (it does — added alongside the connector capabilities). Without it Desktop answers `capability_denied`.
- Request: a JSON-RPC object **with an `id`**, method `flow.run`, params `{flowSlug, appSlug?, input?, correlationId?, idempotencyKey?, timeoutMs?}`. Result: `{runId, status}`.
- With no FormLogic account linked to the desktop, Desktop answers `runner_unavailable` — the plugin should fall back to emitting events (its normal path) and the outbox.
- Exactly-once is the reserve ledger's job: pass a stable `idempotencyKey` (e.g. `aokie-flow:<flowSlug>:<callId>`) so a retried request dedupes to one run.

Note: the *normal* path stays event-driven — Aokie emits `call.*`/`sms.*` events and FormLogic Desktop's event loop runs the app's `onConnectorEvent` scripts (raw record writes) + the app's flow bindings headless. `flow.run` is the explicit, plugin-initiated trigger for cases where the plugin itself needs a flow result mid-call.

## 8. Remote command control (web viewer → desktop → plugin)

The reverse direction: a FormLogic **web member** manages an Aokie call remotely while the receptionist
runs on another machine. FormLogic's remote command relay (`docs/API.md` → *Remote command relay*)
carries a connector command from the browser to the paired desktop runtime:

1. The web member calls `POST /api/app/{slug}/connector-commands {connectorId:"aokie", command:"call.hangup", payload?, idempotencyKey?}`. The member must hold the `connector.aokie.<command>` role grant (the SAME grant the in-app connector client checks) — the app owner always passes.
2. The desktop's **command-relay loop** long-polls `GET /api/v1/connector-commands/pending` (scope `connector:relay`, minted into the desktop's `flk_…` key by the OAuth device-link), claims the command exactly-once, and dispatches it to the Aokie plugin as the normal §2 connector command (e.g. `call.hangup`).
3. The desktop completes the command (`POST …/{id}/complete {status:'done'|'failed', result?, error?}`) with the plugin's response; the web member reads it back via `GET /api/app/{slug}/connector-commands/{id}`.

Pending commands **expire after 60 s** — a stale/offline desktop can never execute an old call action.
`connectorId`/`command` map directly onto the §2 command surface, so any command a flow's
`connector.request` outputAction can invoke is also remotely invokable subject to the member's grant.

## 6. Extraction rules (aokie repo)

- `crates/aokie-core`: Tauri-free modules only (radio stack, dongle, msbc, db, ai traits/adapters, redact, retention, …). No `tauri::` imports allowed (enforced by a CI grep or unit test).
- `crates/aokie-plugin`: depends on `aokie-core` only; owns JSON-RPC framing (`rpc.rs`), command dispatch (`connector.rs`), event bridge (`event_bridge.rs`), outbox (`outbox.rs`), config (`config.rs`).
- `aokie-desktop/src-tauri` re-exports moved items from `aokie-core` so the legacy app compiles unchanged; it is a temporary developer/admin fallback until the plugin + FormLogic app reach parity.
