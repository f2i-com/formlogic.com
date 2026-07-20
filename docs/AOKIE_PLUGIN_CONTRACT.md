# Aokie Desktop Plugin — Contract

**Status:** Phase 0 contract (frozen 2026-07-07). Builds on `docs/DESKTOP_PLUGIN_SDK.md`; schemas in `docs/contracts/`.
**Implementation:** `f2i-com/aokie.com` → `crates/aokie-core` (Tauri-free native logic) + `crates/aokie-plugin` (the JSON-RPC process). The legacy Aokie Tauri app keeps building against `aokie-core` during migration.

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
phone.removePaired     phone.confirmPairing   phone.disconnect      phone.connect
call.current           call.answer            call.reject           call.hangup
call.operatorSpeak     call.configureAgent    call.dial
call.switchboard       call.activate
sms.threads            sms.thread             sms.send
settings.get           settings.set
```

Post-MVP (declared in the manifest only when implemented): `phone.syncContacts`, `call.takeOver`, `call.resumeBot`, `call.getTranscript`, `call.getRecordingInfo`, `sms.approveDraft`, `sms.rejectDraft`, `retention.get/set`.

Payload/response shapes follow the legacy Tauri commands they wrap (e.g. `sms.send {to, body}` → `{messageId, status:"queued"}`); each command handler validates its payload and rejects unknown fields.

**Truthful health + safety gates (audit INT-006/PRIV-001):**

- `plugin.health` is COMPUTED, never a constant ok: `{status: ok|degraded, detail?, components: {voice, devMode, radio: {present, initialized, phoneConnected, callActive, staleSttResults, error}, outbox: {pending, failed, dead}, config: {version, quarantined}}}`. No voice output compiled, radio down in real mode, dead outbox rows, or a quarantined settings file ⇒ `degraded` with the reasons in `detail`.
- `autoAnswer` defaults **OFF** — only an explicit `autoAnswer: true` setting arms the receptionist, and a build without the voice feature can never auto-answer (it would answer into silence) or return `spoken: true` from `call.operatorSpeak`.
- `settings.set` classifies `aiEndpoint`/`sttEndpoint`/`ttsEndpoint` BEFORE persisting (`aokie_core::url_classification`): loopback ok; private-LAN ok with a disclosure log; cloud-metadata, link-local and unparseable hosts are refused; a public endpoint must be `https://`.
- **Endpoint protocol shapes (SRC-203, 2026-07-17):** all three lanes speak the OpenAI spec. `aiEndpoint` is a full `/v1/chat/completions` URL — the plugin's `LlmClient` POSTs it directly and derives the model listing by replacing `/chat/completions` with `/models`, so any base it points at must serve BOTH routes. `sttEndpoint` is an OpenAI-transcriptions URL (`…/v1/audio/transcriptions` by convention): `multipart/form-data` with the audio in the **`file`** field (WAV) plus optional `model`/`language`; response `{text}`. `ttsEndpoint` is an OpenAI-speech URL (`…/v1/audio/speech`): JSON `{input, voice?, response_format: "wav"|"pcm", speed?}`; `response_format:"pcm"` streams raw PCM frames as they synthesize (the plugin's streaming path), `"wav"` returns a whole file. The dedicated `aokie-stt` (:17921) / `aokie-tts` (:17922) desktop services and the retired combined `aokie-voice` (:17920) all serve exactly these shapes, so lane URLs are interchangeable with any OpenAI-compatible server.
- **Lane sources (Receptionist Settings `llm_source`/`stt_source`/`tts_source`):** the Configure Receptionist flow (and the console's byte-identical `buildAgentPayload` mirror) resolves each lane pick into the endpoint settings above, per call. `service:<id>` → the desktop service's live loopback URL + the lane path ('' while stopped = plugin default). `provider:<id>` (**LLM lane only**) → the desktop AI gateway's per-provider OpenAI base at its FIXED port: `http://127.0.0.1:17872/api/ai/providers/<id>/v1/chat/completions` (the gateway also serves `…/v1/models`, and streams SSE for OpenAI-protocol providers — so a configured ChatGPT/custom provider can be the reply model with zero plugin change). `provider:` picks on the STT/TTS lanes resolve to '' (plugin default) until the gateway grows audio routes. A blank LLM source still uses the legacy `llm_endpoint` when that field is set; when source, endpoint **and model are all blank, the flow/console omit `aiEndpoint` and `aiModel` entirely**, preserving an explicit LLM selected directly in Desktop instead of clearing it on every call. An explicit `custom`/`service:`/`provider:` selection remains authoritative (including an intentionally blank custom URL), and a legacy nonblank model remains authoritative without taking endpoint ownership. Blank STT/TTS sources keep their existing plugin-default semantics; the console defaults NEW/blank STT/TTS records to `service:aokie-stt`/`service:aokie-tts` when those services exist — written into the record explicitly. The correction lane (`correction_source`/`correction_endpoint`, 2026-07-17) resolves the same way with the CHAT path into `audioTranscriptEndpoint` (blank resolves `''` = corrections use the main reply model, and no model key is ever pushed).
- **ChatGPT/Codex call routes (2026-07-20):** the four exact Desktop-owned provider ids are `openai-codex-agent-luna-low` (the first/default choice), `openai-codex-agent-luna-low-fast`, `openai-codex-agent-none`, and `openai-codex-agent-low`. The Luna routes pin `gpt-5.6-luna` with CLI/App Server effort `low`; Fast additionally requests service tier `priority`. The legacy routes pin `gpt-5.5` with `none`/`low`. All four are transcript-text only (`sendAudio=false`), reuse the persistent managed Codex App Server, and forward terminally confirmed SSE text deltas into Aokie's clause/sentence TTS path. Interim-STT speculative generation is disabled only for these serialized Codex routes, preventing a cancelled hypothesis from racing the final turn into `codex_busy`; other providers retain speculation.
- `settings.set` is TYPED and atomic (audit AK-006): known keys validate type/range/enum (`autoAnswer`/`aiReceptionist`/`bargeIn`/`reenumerateHwid`/`mockCalls` bool; `bargeSensitivity` 50–5000; `sttEndpointMs` 100–5000; `hfpCodec` `auto|cvsd|wbs`; `persona` ≤4000, `greeting` ≤1000, `ttsVoice`/`aiModel`/`replyMode` ≤200 chars); unknown keys must be scalar and ≤4000 chars; one bad key rejects the whole batch, nothing persists. The response carries `configVersion` (bumped per successful write) plus per-key `appliedLive` / `appliesAtReconnect`. `settings.get` (no key) returns `configVersion` and `configQuarantined`; a corrupt `settings.json` is quarantined to `settings.json.corrupt` at load and safe defaults apply (auto-answer OFF), reported degraded via the health `config` component.
- Selectable in-process TTS engine (2026-07-17): `ttsEngine` (`"" | pocket | sherpa`, applies live) picks which engine the plugin's synth worker loads — blank/`pocket` = Pocket-TTS (streaming chunks, voices `alba…marius` via `ttsVoice`), `sherpa` = sherpa-onnx (Piper/VITS or Kokoro voice bundles; one-shot per span, RTF ≪ realtime; the in-process engine reads `ttsVoice` as a numeric speaker id, anything else = the bundle default). NOTE the per-call voice rule (2026-07-17): when the TTS lane points at the `aokie-tts` SERVICE (the console's default), the AUDIBLE voice is whatever rides the per-call `ttsVoice` push into the OpenAI `voice` field — the service accepts a sherpa bundle folder NAME (e.g. `vits-piper-en_GB-jenny_dioco-medium`), `bundle:speaker`, or a bare numeric speaker id. The console's sherpa bundle picker therefore writes the bundle's folder NAME into the record's `voice` (pushed per call) AND the bundle folder into `ttsModelDir` — the latter only sets the in-process FALLBACK engine's voice for when the service isn't running. `ttsModelDir` (string ≤400, applies live) points at the sherpa voice-bundle folder (`<name>.onnx` + `tokens.txt`, `espeak-ng-data/` inside the bundle or its parent, `voices.bin` marks Kokoro); blank = first usable bundle under `<app_data>/models/tts` (alphabetical). A change reloads the engine immediately (bad config logs and retries on the next span); the `ttsEndpoint` HTTP path still takes precedence over ANY in-process engine, with the same sticky per-call fallback.
- `ttsVoiceCatalog` (2026-07-17): the WHOLE-OBJECT `settings.get` response (no `key` in the payload) MAY carry a `ttsVoiceCatalog` side key — a sibling of `settings`/`configVersion`/`managerPinSet`, never inside the settings map and never on single-key gets. Shape: `{engines: [{id:"pocket", label, voices:[…]}, {id:"sherpa", label, bundles:[{dir, name, kind:"vits"|"kokoro"}], scanRoot}]}`. `pocket.voices` = sorted, deduped basenames of `<app_data com.aokie.app>/models/pocket_tts_onnx/voices/*.{safetensors,wav}`; `sherpa.bundles` = subfolders of `scanRoot` (`<app_data>/models/tts`) passing the bundle test (`tokens.txt` + exactly ONE `.onnx`; `voices.bin` present ⇒ `kind:"kokoro"`, else `"vits"`), plus the currently-configured `ttsModelDir` when it is a valid bundle OUTSIDE the scan root; `bundle.dir` is the exact absolute path to store back into `ttsModelDir`. This is a best-effort disk inventory for pickers (the console's engine-first Voice card), NOT a validation gate — `settings.set` still accepts any folder. Older plugins do not return the key at all: consumers MUST degrade gracefully (fall back to their built-in voice lists / free-text folder input).
- Conversation content (caller transcripts, agent replies) appears in stderr logs only as lengths unless `AOKIE_LOG_CONTENT=1` is set explicitly.

**Canonical call-control shapes** (single source: `crates/aokie-plugin/src/contract.rs` in the aokie repo; test-locked against the manifest and both mocks):

- `call.answer` / `call.reject` / `call.hangup` accept `{callId?}`; `call.operatorSpeak` accepts `{text, callId?, inResponseTo?}`. When `callId` is present it MUST equal the plugin's current call id, else the typed **`stale_call`** error is returned and the phone is NOT touched (a stale browser tab can never control a newer call). An omitted `callId` acts on the current call (compatibility for flow/desktop callers).
- `inResponseTo` (§9.2 within-call staleness): the `turn` NUMBER of the caller turn the speech answers (from `aokie.call.turn.final`). When a NEWER caller turn already exists the command is refused with typed **`stale_turn`** and nothing is spoken. Callers MUST treat `stale_turn` (and `stale_call`) as a benign skip — never as a failure that triggers fallback speech (that would speak another stale answer into the newer turn). Both runners' `aokie_speak` node defaults it from the flow's `turn` input and resolves stale refusals as `{skipped: true}`.
- `call.configureAgent {callId, persona?, greeting?}` (§9.3 call-scoped agent config): a caller-specific persona/greeting overlay bound to ONE call. `callId` is **REQUIRED** — no legacy-compat window on this newer surface (missing ⇒ `command_failed`, mismatched ⇒ `stale_call`); at least one of `persona`/`greeting` must be non-empty. The plugin wipes the overlay at the call boundary, so a failed or raced next-call setup can never leak the previous caller's personalization; `settings.set` remains the path for durable, caller-independent config.
- `call.dial {number, openingLine, purpose?}` (Phase 2 outbound): places an OUTBOUND call. `openingLine` (1–500 chars, REQUIRED) is spoken VERBATIM when the remote party answers (records-compose pattern — the first words are never model prose); `purpose` (≤1000 chars) grounds the agent's conversation. Guardrails, all typed refusals BEFORE the radio: the `outboundEnabled` kill switch (**default OFF**), local quiet hours (`quietHoursStart`/`quietHoursEnd`, default 21→8, equal values disable), and the persisted `maxDailyDials` cap (default 20; counted per operator-LOCAL day, attempt counted before it reaches the radio). Result reports acceptance: `{accepted, queued, operationId, callId, to, dialsToday, maxDailyDials, via: "radio"}`. Lifecycle: `aokie.call.outbound.dialing {callId, to, purpose?, at}` then the NORMAL family with the same callId (`call.ringing` = remote alerting, `call.answered` = remote pickup, `call.ended` with `direction: "outbound"` and outcome `completed|no_answer|failed`). A handset-originated outbound call (the owner dialing) is observed silently — session tracked, no greeting/transcription. A dedicated `outbound` consent scope + wizard checkbox is a documented follow-up; until then the default-off kill switch is the explicit operator opt-in.
- Manager line (Phase 3, call-policy spec): inbound callers whose id digit-matches the `managerNumbers` setting bypass screening, get the manager greeting/persona, and their `[[LOOKUP]]`s run name-inclusive (the plugin sets `manager: true` in its `flow.run` input — the flag is caller-id truth, never model output). WRITES need more: a change request (`[[MANAGER: …]]` from the agent) is executed only after the spoken PIN verifies against the `managerPin` setting — deterministic digit comparison in the plugin (words or digits; the model never sees or judges a PIN), 2 attempts, and the PIN utterance is recorded/captioned only as `[manager PIN redacted]`. A verified change runs the `manager-action-plan` flow (LLM structures, the flow validates against records and composes the spoken outcome) and emits **`aokie.manager.action {callId, summary, hasUpdate, updateId, update, at}`** — the `manager-action-apply` binding performs the single record write on the durable plane. Blank `managerPin` = the manager line stays read-only. `managerPin` is WRITE-ONLY (AOK-304A): `settings.set` seals it at rest (DPAPI on Windows) and `settings.get` NEVER returns it — the whole-object read exposes `managerPinSet: bool` instead (a single-key get of `managerPin` returns `value: null` + `set: bool`), so a settings snapshot can't leak the PIN; the plugin verifies it in constant time. Console rule: send `managerPin` on `settings.set` ONLY when the operator typed a new one — an ever-included blank would silently clear the stored PIN (clearing is an explicit action). `[[MANAGER]]` markers are never spoken; on a non-manager call they get an honest refusal.
- `call.current` → `{call: null | {callId, from?, callerName?, state, startedAt?, …}}` with `state ∈ ringing|active|ended`. The real radio, the plugin's dev mock and the browser mock all return exactly this shape. It stays FOREGROUND-only — multi-call state lives in `call.switchboard`.
- `call.switchboard` (Phase 4) → `{foreground: null | <call.current shape>, waiting: null | {callId, from, since}, parked: null | {callId, from, since}, revision, switchInProgress, callHeldState}` — the authoritative multi-call snapshot. `waiting.callId` is the STABLE identity minted at the knock (also on the `aokie.call.waiting` event as `waitingCallId`); `revision` bumps on every topology change and is `call.activate`'s optimistic-concurrency token.
- `call.activate {callId, expectedRevision?}` (Phase 4, operator-driven — nothing switches automatically): make the WAITING or PARKED caller the foreground. Accepting a waiting caller parks the current call (their whole conversation context — history, PIN gate, pacing — travels with them) and sends ONE `AT+CHLD=2`; activating the parked caller swaps back the same way, with their context restored and a FRESH internal focus epoch so pre-hold speech work can never leak into the resumed conversation. Refusals are typed and the phone is untouched: `stale_call` (callId is neither leg), `command_failed` with a clear message for a stale `expectedRevision`, a switch already in flight, no active foreground to hold, a second parked caller (max ONE parked in this release), or a swap-back attempted while a NEW caller is knocking (plain CHLD=2 would accept the knock instead — handle it first). Result reports acceptance (`{accepted, queued, operationId, via: "radio", revision}`); confirmation is the lifecycle events (the accepted caller gets `call.incoming` → `call.caller_id` → `call.answered` under their `waitingCallId`) + the next `call.switchboard` read. If the foreground call ends while someone is parked, the plugin AUTO-RETRIEVES them (one CHLD=2, context restored); a parked caller who hangs up gets an honest `call.ended`.
- `phone.status` → `{paired, connected, device: null | {address, name, …}, …}` — the paired device is always NESTED under `device`; there is no root-level `deviceName`.

## 3. Events (envelope per `desktop-event.schema.json`, `source:"aokie"`)

MVP set:

```
aokie.dongle.detected        aokie.dongle.driver_required   aokie.dongle.ready    aokie.dongle.error
aokie.phone.pairing_started  aokie.phone.paired             aokie.phone.connected aokie.phone.disconnected
aokie.call.incoming          aokie.call.ringing             aokie.call.answered   aokie.call.rejected
aokie.call.audio.connected   aokie.call.audio.disconnected
aokie.call.turn.partial      aokie.call.turn.final          aokie.call.turn.corrected
aokie.call.ended             aokie.call.waiting             aokie.call.outbound.dialing
aokie.sms.received           aokie.sms.sent                 aokie.sms.failed
aokie.manager.action
aokie.hardware.error
```

The list is generated from ONE source (`contract.rs::events::ALL` in the aokie repo): the plugin's `manifest.json`, the desktop's bundled manifest copy and the flow event catalog must all declare exactly this set — Desktop silently drops any event a plugin emits without declaring, so drift here is a release blocker, and `cargo test -p aokie-plugin` fails on it.

Conventions:
- `correlationId` = call id (`call_<uuid>`), SMS handle, or pairing session id. Call ids are
  NEVER reused; internally each call also has a monotonic generation stamped through the
  async STT/LLM/TTS pipeline so a slow result from call A is dropped, never attributed to
  call B (audit AK-002/C-05; drops are visible as `staleSttResults` in `dongle.diagnostics`).
- `aokie.call.turn.corrected` data: `{callId, turn, text, sttText, at}` — the OPTIONAL
  audio-transcript feature (`audioTranscript` setting on): a small detached
  request asks an audio-capable model to correct the on-device STT from the turn's actual audio.
  `sendAudio` and `audioTranscript` are INDEPENDENT settings (2026-07-17): `sendAudio` attaches
  the caller-turn audio to the REPLY request (needs an audio-capable reply model);
  `audioTranscript` side-runs the correction request against its own lane — so
  corrections-only works with a text-only reply model, and direct audio works without the side
  run. The console exposes them as one 4-way "Caller audio" mode (text only / direct /
  corrections / both) that always writes BOTH keys explicitly.
  `turn` names the `turn.final` it corrects. Consumers UPDATE that stored turn in place (the pack's
  app logic matches on the row's `turn_key` and keeps the raw recognizer text in `stt_text`) and
  must NEVER treat it as a fresh caller turn — no replies, no new rows. Best-effort by design: an
  unchanged/empty correction is not emitted, and a correction may land moments after `call.ended`.
  The attached WAVs are silence-trimmed (leading/trailing dropped, internal pauses capped) and the
  correction request is submitted a couple of seconds AFTER the reply request so it never contends
  for the model ahead of the caller's answer. The optional `audioTranscriptEndpoint` setting
  (endpoint-classified URL) routes corrections to a separate OpenAI-compatible server — a full
  `/v1/chat/completions` URL, same `LlmClient` shape as `aiEndpoint`; empty = the agent's own
  client. Since 2026-07-17 the console no longer edits it directly: the Receptionist Settings
  record's `correction_source` (`'' | service:<id> | custom` + `correction_endpoint` for the
  custom URL) is resolved per call by the Configure Receptionist flow — the SAME laneUrl rule as
  the `llm_source` lane, chat path — and pushed as `audioTranscriptEndpoint` (`''` = blank =
  corrections use the main reply model). `audioTranscriptModel` still exists as a plugin setting
  but is RETIRED from the console and never pushed by the flow — the chosen service owns its
  model (picked on the desktop's service card).
- `aokie.call.ended` data: `{callId, from, callerPhone, durationSeconds, durationMs, outcome,
  reason, direction, manager, at}`. `manager: true` marks an inbound call whose caller id
  digit-matched the `managerNumbers` setting — the after-call booking extractor skips those
  (manager changes write deterministically through `aokie.manager.action`; absent/false =
  ordinary caller, so older plugins keep working). `outcome ∈ completed|rejected|missed|terminated_abuse|abandoned_on_hold|abandoned_in_queue` (inbound) comes
  from the call-session state machine (audit AK-001): answered → `completed` (even a sub-second
  call), operator-rejected → `rejected`, never answered → `missed`, abuse-terminated (Phase 1) →
  `terminated_abuse`. Phase 4 hold queue: a PARKED caller who hangs up before the receptionist
  returns ends `abandoned_on_hold` when they had a real conversation first (follow-ups should
  apologise by SMS, never ring back someone who chose to leave) or `abandoned_in_queue` when
  they only ever heard the "please hold — you're next" line (follow-ups treat it like a missed
  call and ring back with a hold apology). OUTBOUND calls (`direction: "outbound"`, Phase 2) add
  `no_answer` (remote alerted, never picked up) and `failed` (never even alerted); `from` is the
  DIALED number. `durationSeconds`/`durationMs` count from ANSWER.
- `aokie.call.waiting` data: `{callId, from, at}` (Phase 4, observe-only slice): a SECOND caller
  rang while `callId` was active. `callId` is the ACTIVE call the knock happened during — the
  waiting caller has no session or call id of their own yet; `from` is their number, `""` when
  withheld. Emitted at most once per waiting episode, and only on connections that negotiated
  call waiting (`holdAndCallWaiting` setting on + the phone advertises HFP three-way calling +
  `AT+CHLD=?`/`AT+CCWA=1` accepted). By default Aokie does NOT answer, hold or switch — the
  waiting caller hears the network's tone until they give up (bind a flow here for follow-ups,
  e.g. a we-missed-you text); if the active call ends while they are still waiting AND nothing is
  held, their ring is promoted to a normal `aokie.call.incoming` with a FRESH call id and
  auto-answer picks it up. With a caller HELD, the promotion is suppressed (it would auto-answer
  the knocker AHEAD of the held caller — live 2026-07-15) and the FIFO cascade serves them
  instead. A knocker who gives up UNSERVED gets an honest `aokie.call.ended` under their
  `waitingCallId` — `{outcome: "missed", reason: "gave_up_waiting", durationSeconds: 0}` — so the
  missed-call flows ring them back like any other missed call (the Calls row is created by the
  ended upsert; there is no incoming/answered for it).
  With the `autoHoldQueue` setting on (bool, default OFF, applies at radio start; requires
  `holdAndCallWaiting`), the plugin instead JUGGLES automatically: it tells the active caller
  "another call came in, one moment", answers the knocking caller ("please hold — you're next in
  the queue"), parks them, and resumes the first caller; parked callers are retrieved FIFO as
  calls end (a caller parked mid-conversation hears "thanks for holding — where were we", one who
  never got past the hold line hears a fresh "thanks for holding, how can I help"). Every
  `AT+CHLD=2` outcome is VERIFIED against the phone's callheld indicator + an on-demand `AT+CLCC`
  before any session state moves; when the phone refuses to give the first caller back, the
  plugin degrades to single-swap (the newcomer becomes the conversation, the first caller stays
  parked for auto-retrieve) rather than retrying blindly. The knocking caller still gets the
  normal lifecycle events (`call.incoming` → `call.caller_id` → `call.answered`) under the
  `waitingCallId` the moment they are accepted. Consumers must never treat this event as a new
  call or a caller turn.
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
