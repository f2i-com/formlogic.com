> **RETIRED (2026-09-02).** FormLogic Desktop has been removed from this
> repository; its role — local models, services, hardware and headless flows
> paired to a FormLogic account — is filled by [OAIY](https://oaiy.com), which
> speaks the same pairing, relay and event contracts the web app and backend
> still serve. This document is kept as the record of how that side of the
> contract was designed; nothing below describes code that ships from here.

# FormLogic Desktop — Local Companion Contract

**Status:** Phase 0 contract (frozen 2026-07-07). Canonical home of the cross-repo contracts: this repo, `docs/contracts/*.schema.json`.
**Repos:** the desktop implementation lives **in this repo** at `formlogic/desktop` (Tauri 2; relocated from `formlogic-com/formlogic-web` per the hybrid-layout decision in `docs/ADR_FORMLOGIC_DESKTOP.md`); the browser client lives at `formlogic/ui/src/client-runtime/desktop/`; plugins (e.g. Aokie) live in their own repos.

FormLogic Desktop is the rebranded/evolved FormLogic desktop companion. It is the **local capability layer**: model/service manager, plugin host, permission gateway, event bus, and (later) flow runner. The browser never gets raw hardware access — FormLogic Web talks to Desktop; Desktop talks to plugins.

## 1. Identity & transport

- Loopback only: binds `127.0.0.1:17872` (unchanged from FormLogic companion).
- `GET /api/health` (unauthenticated, CORS-open) returns:

```json
{
  "status": "ok",
  "companion": "formlogic-desktop",
  "legacyCompanion": "formlogic-desktop",
  "version": "<semver>",
  "apiVersion": 1,
  "pluginApiVersion": 1
}
```

- Detection (both the FormLogic flow-builder UI and FormLogic Web) accepts `companion === 'formlogic-desktop' || companion === 'formlogic-desktop'`. The legacy value is kept for one or two releases.
- Display name: **FormLogic Desktop** (tray, window title, installer). Bundle identifier stays `com.formlogic.desktop` so existing installs keep their data dir.

## 2. API groups

Management plane — `/api/config`, `/api/services*`, `/api/models*`, `/api/python*`,
`/api/desktop/info`, `/api/desktop/support-bundle` — sits behind the SAME auth as the
plugin API (LOCAL-SEC-001): the desktop's own webview, the headless server token, or an
exact-origin pairing token. `GET /api/health` is the only unauthenticated route (the
discovery probe; its body is secret-free by contract).

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/desktop/info` | token | name, versions, platform, pluginApiVersion |
| `POST /api/desktop/pairing-requests` | origin-gated | begin pairing: `{origin}` → `{requestId}` |
| `GET /api/desktop/pairing-requests/{id}` | origin-gated | poll: `{status: "pending"|"approved"|"denied", token?}` |
| `GET /api/origins` | token | list trusted origins |
| `DELETE /api/origins/{origin}` | token | revoke an origin's trust + tokens |
| `GET /api/plugins` | token | list plugins + lifecycle state |
| `GET /api/plugins/{id}` | token | manifest + state + versions |
| `POST /api/plugins/{id}/start\|stop\|restart` | token (privileged) | lifecycle control |
| `POST /api/plugins/{id}/install` | token (privileged) | materialise a bundled built-in template |
| `DELETE /api/plugins/{id}` | token (privileged) | uninstall: stop + remove the plugin folder (its `plugin-data/{id}` is kept) |
| `GET /api/plugins/{id}/health` | token | last health probe result |
| `GET /api/plugins/{id}/logs?tail=n` | token | captured stdout/stderr ring buffer |
| `POST /api/plugins/{id}/commands/{command}` | token (privileged) | admin/dev direct command |
| `GET /api/connectors` | token | connectors exposed by running plugins |
| `GET /api/connectors/{connectorId}/status` | token | connector status |
| `POST /api/connectors/{connectorId}/request` | token | **the gateway FormLogic Web uses** — body/response per `connector-request/response.schema.json` |
| `GET /api/events` | token (`Authorization` header via fetch-based SSE; the `?token=` query fallback was removed — audit FL-008) | SSE stream of desktop-event envelopes |
| `POST /api/flows/run` | token | **LIVE** — run a flow by slug (resolved via the linked account) or an inline `flowJson`; body per `flow-run-request.schema.json`, response `{runId, status, result?, error?}` per `flow-run-result.schema.json`. Reports `runner_unavailable` only when no flow runtime is wired. |
| `GET /api/flows/runs/{id}` | token | **LIVE** — status/result of a recent run this desktop executed (`flow-run-result.schema.json`); `404 invalid_flow` for an unknown id. |

`GET /api/desktop/info` additionally carries a `flowRuntime` object when a flow runtime is present: `{linked, baseUrl, lastOk, lastEventAt, lastClaimAt, runsExecuted, recordsWritten, errors, lastError}` — the web app's remote-viewer presence + the desktop window badge read it.

SSE format: `id:` = event `idempotencyKey`, `event:` = envelope `name`, `data:` = full envelope JSON (see `desktop-event.schema.json`). A `: ping` comment every 20 s keeps the stream alive.

## 3. Local auth (pairing tokens)

Loopback is not sufficient for privileged commands. Model:

1. Web probes `/api/health` unauthenticated.
2. User clicks "Connect FormLogic Desktop" → `POST /api/desktop/pairing-requests {origin}`.
3. Desktop shows a native confirmation (tray/dialog) naming the origin.
4. On approval, the poll returns a bearer token (random ≥32 bytes) **bound to that origin**; Desktop stores only a hash + origin + createdAt in its config dir.
5. Browser keeps the token in memory/sessionStorage (never localStorage, never cookies) and sends `Authorization: Bearer <token>` (or `?token=` for EventSource only).
6. Requests where the `Origin` header does not match the token's bound origin are rejected `origin_denied`.

Dev bypass: `FORMLOGIC_DESKTOP_DEV_ALLOW_ORIGIN=http://localhost:5173` auto-approves pairing for that origin (debug builds / env only).

Trust anchors (LOCAL-SEC-001), identical for the plugin API and the management plane:

- **The desktop's own webview** (`tauri://localhost` / `http(s)://tauri.localhost`; loopback ports in debug builds only) — the GUI needs no token. No hosted page can carry these origins.
- **The headless server token** (`FORMLOGIC_SERVER_TOKEN`) — the CLI/admin path; the only key on a headless server, and the only way for ANY caller to reach the exec surface (define/uninstall/delete services, model download/delete, python install, venv create/delete) without the Desktop window.
- **An exact-origin pairing token** — every browser origin, INCLUDING `https://formlogic.com` and its subdomains, must pair; there is no origin allow-list, so a compromised subdomain or site XSS cannot reach the local management plane.

Native callers without an `Origin` header (curl, scripts) may use non-exec routes on a GUI or token-less box — they already run as the user — but never the exec surface.

Error envelope everywhere: `{ok:false, error:{code, message}}` with codes from `connector-response.schema.json` (`origin_denied`, `capability_denied`, `connector_missing`, `connector_unavailable`, `command_failed`, `ipc_unavailable`, `auth_required`). These are intentionally the SAME codes FormLogic's `ConnectorError` already parses; only `ipc_unavailable`/`connector_missing` are fallbackable in the browser.

## 3b. Local operational data (DATA-PRIV-001)

Desktop keeps two small journals under `plugin-data/` so accepted events survive crashes. **The work ledger (`host-event-work.jsonl`) is the single source of durability truth for an accepted event**; per-plugin receipt journals (`host-event-receipts.jsonl`) exist only for ack-replay dedupe and to bridge the crash window between the plugin ack and the ledger's `recv` row (plus `host-event-processed.jsonl` markers for the pre-ledger import).

- **Encryption at rest:** envelope payloads (transcripts, caller numbers, SMS bodies) are sealed with XChaCha20-Poly1305 under a per-install data key held in the Windows Credential Manager (`journal-data-key`; key-file fallback beside the journals on other platforms). Legacy plaintext journals are re-sealed at first boot. A plaintext scan of the data dir yields keys, states and timestamps — never conversation content.
- **Minimisation:** a COMPLETED event's payload is dropped the moment it completes; the terminal record keeps only key, state, timestamps and a SHA-256 payload fingerprint. Dead-letter records keep their sealed payload so the operator redrive works.
- **Retention (time-based, volume-independent):** swept at open and by a periodic tick. Defaults / env overrides (clamped): receipts 14 d (`FORMLOGIC_JOURNAL_RECEIPTS_RETENTION_DAYS`, 1–90), completed work 24 h (`FORMLOGIC_JOURNAL_COMPLETED_RETENTION_HOURS`, 1–168), dead letters 14 d (`FORMLOGIC_JOURNAL_DEAD_RETENTION_DAYS`, 1–90). Pending (unfinished) work is NEVER age-discarded.
- **Clear history:** `GET /api/desktop/journals` previews counts; `POST /api/desktop/journals/clear` (Settings → Privacy in the Desktop window) removes terminal work records and receipts older than a one-hour dedupe guard. Pending work is kept; cloud records are governed by each form's retention settings in FormLogic, not by this.
- **Fail-closed durability (WORK-DUR-001):** every ledger transition is fsynced before the dispatcher acts on it, and a failed append is a failed CLAIM — the event is not processed, the ledger reports a `blocked` reason (surfaced in `flowRuntime.eventWorkBlocked` and `GET /api/desktop/journals`, alongside a live journal-dir writability probe), and the fsynced receipt remains the durable copy. Receipt rotation/retention/clear never drop an entry until the work ledger owns its event or a processed marker exists (the accountability guard), so a 20k+ backlog cannot rotate away acked work. A continuous reconciler (5-minute cadence) imports unaccounted receipts and re-drives stalled pending rows; corrupt journal content beyond a torn tail is quarantined to a `.corrupt-<ts>` copy and recovery resumes from the last verified record. The invariant: every acked event is terminal, visibly pending, or visibly dead — never absent.

## 3c. Model bundle integrity (MODEL-001)

Model downloads are verified cryptographically end-to-end:

- **Signed-catalogue trust anchor:** the curated quick-add catalogue is compiled into the (code-signed) binary; every bundled entry pins `sha256`, exact `sizeBytes`, `license` and `provenance`, and a test gate refuses new entries without them. The seeded on-disk copy stays user-editable, but any entry that no longer matches the compiled catalogue (id + url + digest) is visibly downgraded to `local` provenance.
- **Verify before install:** transfers are SHA-256-hashed in flight (a resume first re-hashes the `.part` prefix so the digest always covers every byte on disk). A pinned download checks exact size then digest **before** the atomic `.part` → final rename; on mismatch the `.part` is deleted and nothing is installed. Catalogue URLs get the catalogue's pin enforced server-side regardless of the request body; arbitrary URLs may carry an explicit `sha256` pin.
- **Reverify (Doctor/repair):** every completed download is recorded in `.models-manifest.json` (digest, size, source URL, pinned flag). `GET /api/models` reports a cheap per-file status (`verified`/`modified`/`unverified`); `POST /api/models/verify` re-hashes every tracked file, quarantines mismatches to `<name>.quarantine-<ts>` and drops their manifest rows. Deleting a model drops its row so a future file can't inherit a stale "verified".

## 4. Plugin host

See `docs/DESKTOP_PLUGIN_SDK.md`. Summary: plugins are directories under `<desktop-data>/plugins/<id>/` with a `manifest.json` (`plugin-manifest.schema.json`), run as supervised child processes speaking JSON-RPC 2.0 over stdio (newline-delimited). Lifecycle states: `installed, stopped, starting, running, unhealthy, crashed, disabled`. Desktop enforces: commands must be covered by manifest `capabilities`; events must be declared in manifest `events`; a crashing plugin never takes Desktop down.

### 4b. Plugin package trust (TRUST-001)

Release bundles ship a **first-party-signed `package-manifest.json`** (written by the aokie repo's `package-signer`): an Ed25519 signature by a publisher key — public half **pinned in the Desktop binary** (`plugins/package_trust.rs`, key id `fl-aokie-2026a`; private half only in the release pipeline's secret store) — over the SHA-256 + size of every bundle file. Desktop verifies **at scan ("before staging") and again at launch** (closing the scan→start TOCTOU window):

- signature by a pinned, non-revoked publisher key;
- every listed file present with the exact digest + size, `manifest.json` (the entry command) covered;
- **no unlisted executable/loadable file** (`.exe`/`.dll`/scripts) in the directory — a dropped extra binary beside a signed plugin is hijack surface, so it **quarantines** (Disabled, exact reason surfaced, start refused). Inert extras (deploy `.bak-*`, notes) don't fail a signed package.

Directories **without** a package manifest are "unsigned" sideloads: allowed for development (surfaced as `package: "unsigned"` in `GET /api/plugins`), refused outright under `FORMLOGIC_REQUIRE_SIGNED_PLUGINS=1` (the production posture). Key rotation = additional pinned entries; emergency revocation = `FORMLOGIC_REVOKED_PUBKEY_IDS`; lab/test keys = `FORMLOGIC_EXTRA_TRUSTED_PUBKEYS=id=b64,…`. Dev gotcha: after side-copying a new binary into a SIGNED plugin dir, delete `package-manifest.json` (or re-sign) — otherwise the next scan correctly quarantines the drift.

### 4c. Operator consent (CONSENT-001)

Desktop owns the **consent wizard** for sensitive plugin surfaces (the Aokie card → "Set up consent"): a versioned, scoped grant covering the Bluetooth link, contacts, SMS, live transcription, recording, record retention and every configured remote destination. Accepting issues a grant **signed by this install's per-install Ed25519 key** (`consent-signing.rs`; key in the credential store / key-file fallback; public half passed to every plugin via `FORMLOGIC_CONSENT_VERIFY_KEY`) via `POST /api/plugins/:id/consent` — GUI webview or server token only, **never a pairing token** — and flips `consentMode=enforce`.

Plugin-side (aokie `consent.rs`): production **default is enforce**; `warn` is the explicit developer/beta override. Grants are verified from disk on every gate check (signature, version, expiry — 12 months by default — and scope); a grant signed on another machine never verifies (the per-install key IS the device binding). Enforcement sits at the capture points: the radio won't start without `bluetooth`; denied `transcription` sets `AOKIE_STT_DISABLED` so no audio reaches any STT engine; `sms.*`/pairing commands check their scopes; under enforce, a non-loopback AI/speech endpoint must be in the grant's consented `destinations` or `settings.set` refuses it. `consent.revoke` stops the radio and disables auto-answer immediately, no restart. The wizard links the applicable privacy disclosure (formlogic.com/privacy) and reminds operators that caller disclosure (AI/recording/transcription notices) is their jurisdiction-specific responsibility.

## 5. Browser client (FormLogic Web)

`formlogic/ui/src/client-runtime/desktop/`:
- `desktopDetection.ts` — poll `/api/health`, accept both companion ids, pub/sub status (mirrors formlogic-web `companionDetection.ts`).
- `desktopPairing.ts` — pairing-request flow + token/session storage per origin.
- `desktopClient.ts` — typed fetch wrapper (`info`, `plugins`, `connectors.request`, …).
- `desktopEvents.ts` — `EventSource` subscription, envelope validation, dedupe on `idempotencyKey`, dispatch into the app-logic `onConnectorEvent` hook and flow bindings.
- `browserEventQueue.ts` — bounded per-correlation FIFO shared by those two browser-fallback consumers. When the headless Desktop heartbeat is absent, an earlier raw-record write (for example `aokie.call.turn.corrected`) completes before a later event's flow binding (`aokie.call.transcript.settled`) can read that correlation; listener registration order cannot invert them.
- Desktop-backed connectors register as browser connectors (`registerBrowserConnector`) so the existing routing (native bridge → browser connector → mock) and permission model (`connector.<id>.<command>` grants) apply unchanged.

## 6. Versioning

`apiVersion` (HTTP surface) and `pluginApiVersion` (stdio protocol) are integers; breaking changes bump them. Plugins declare `pluginApiVersion` + `minDesktopVersion` in the manifest; Desktop refuses incompatible plugins with a visible state, never silently.

## 8. Headless flow runtime (FormLogic Cloud link)

FormLogic Desktop is the **headless runtime for flows + the Aokie receptionist** — the receptionist runs *inside* the Desktop app; the web app only views state remotely (docs/FORMLOGIC_FLOWS.md §14). This is implemented in `formlogic/desktop/src-tauri/src/flows/` + `formlogic_client.rs`.

- **Account link.** The desktop stores `{formlogicBaseUrl, formlogicApiKey}` in its config dir (`companion-config.json`, alongside the pairing store — survives a data-folder move; **treat the file as a secret — key encryption-at-rest is out of scope**). The key is a scoped External-API key (`flk_…`) with `flows:read` + `flows:write` + `responses:read` + `responses:write` + `responses:manage` + `connector:relay`. All three `responses:*` scopes are required: the runtime LISTs (for `formlogic_list_responses` and match-based updates), submits, and updates an app's records when applying `onConnectorEvent` effects + flow output actions. The GUI exposes this under **Settings → FormLogic Cloud** (base URL + key inputs, "Test connection", live status); the headless `formlogic-server` reads `FORMLOGIC_BASE_URL` + `FORMLOGIC_API_KEY`.
  - **App-internal forms:** an app's forms (e.g. the Aokie "Calls" store) are `draft` at the form level — the owner's API key can still write to them because `authorizeForm` proved ownership; the external API only refuses an `archived` form. Public/anon endpoints still require `published`.

  **Running the headless runtime locally (verified reproducible recipe):**

  ```
  # build both binaries
  cd formlogic/desktop/src-tauri && cargo build --bin formlogic-server --no-default-features
  cd <aokie-repo>/crates && cargo build -p aokie-plugin
  # install the plugin into a data dir
  mkdir -p <DATA>/plugins/aokie
  cp <aokie-repo>/crates/aokie-plugin/manifest.json      <DATA>/plugins/aokie/
  cp <aokie-repo>/crates/target/debug/aokie-plugin.exe   <DATA>/plugins/aokie/
  # run it linked (mint an flk_ key with the six scopes above for your user)
  FORMLOGIC_DATA_DIR=<DATA> FORMLOGIC_SERVER_TOKEN=<tok> \
  FORMLOGIC_BASE_URL=http://api.formlogic.local FORMLOGIC_API_KEY=<flk_…> \
  FORMLOGIC_DEV_MODE=1 FORMLOGIC_DESKTOP_DEV_ALLOW_ORIGIN=http://formlogic.local \
    formlogic/desktop/src-tauri/target/debug/formlogic-server
  # drive it (bearer = FORMLOGIC_SERVER_TOKEN)
  curl 127.0.0.1:17872/api/health
  curl -H "Authorization: Bearer <tok>" 127.0.0.1:17872/api/desktop/info          # flowRuntime.linked:true
  curl -XPOST -H "Authorization: Bearer <tok>" 127.0.0.1:17872/api/plugins/aokie/start
  curl -XPOST -H "Authorization: Bearer <tok>" -H "Content-Type: application/json" \
       -d '{"command":"dongle.diagnostics","payload":{"simulate":"call"}}' \
       127.0.0.1:17872/api/connectors/aokie/request
  # → flowRuntime shows recordsWritten>0 + runsExecuted>0, and a complete Call record
  #   (status:completed, started/answered/ended, transcript turns, SMS) appears in FormLogic — no browser.
  ```
  - **OAuth device-link is the PRIMARY path** (replaces pasting a key). The desktop runs FormLogic's OAuth 2.1 authorization-code + PKCE S256 flow as the first-party PUBLIC client `formlogic-desktop`, binding a loopback callback `http://127.0.0.1:<ephemeral-port>/callback` (RFC 8252 §7.3, port-agnostic). The token exchange **mints the scoped `flk_…` key** above and returns it once in `formlogic_api_key` (== `access_token`), tied to a `desktop_connections` row named for the sanitized `?device=` label. The desktop stores that key exactly as if pasted. Manual key entry remains as a fallback for offline/air-gapped setups (a collapsible **Advanced** panel). Full flow + token shape: `docs/MCP.md` → *FormLogic Desktop device-link*.  Revoke from **Settings → API keys** or by deleting the connection (`DELETE /api/desktop-connections/{id}` cascades to revoke the key); **Unlink** clears the local key and best-effort DELETEs the connection.
    - **Implementation** (`src-tauri/src/oauth.rs` + the `formlogic_oauth_start`/`_cancel`/`_status` Tauri commands): a one-shot loopback listener (Tokio) binds `127.0.0.1:0`, generates the PKCE verifier/challenge + a random `state`, opens the system browser to `<base>/oauth/authorize?…&device=<hostname>`, then captures the redirect (validating `state`), exchanges the code at `<base>/api/oauth/token` (`formlogic_client::exchange_oauth_code`) and persists the key via the OS credential store (DESK-SECRET-001). The wait is bounded (5 min), cancellable, and every failure surfaces as a phase/message the Settings UI polls — it never panics. Manual paste uses the same store via `set_formlogic_config`.
    - **Secret storage (DESK-SECRET-001).** The long-lived `flk_…` API key and the HuggingFace token are stored in the **OS credential store** (Windows Credential Manager, via `src-tauri/src/secrets.rs`), NOT in plaintext config. `companion-config.json` keeps only non-secret references (base URL, connection id, device label). A legacy plaintext key/token is migrated into the credential store on first read (verify-before-delete: the plaintext is removed only after the keyring read-back is confirmed, so a keyring failure can never lock the operator out — it falls back to the local copy). **Unlink** deletes the credential-store entry AND any legacy plaintext. On non-Windows builds (no wired backend) the plaintext storage remains. Net: a filesystem-only copy of the config contains no usable token.
- **Local WAMP split host.** Use `http://api.formlogic.local` as Desktop's Base URL. `formlogic.local` is the static SPA vhost and intentionally returns 404 for `/api/*` when no bundled backend exists beneath its document root. Desktop canonicalizes the exact local aliases `formlogic.local` and `www.formlogic.local` to `api.formlogic.local` (preserving HTTP/HTTPS and an explicit port); production and custom hosts are unchanged. OAuth still works from the API host because its `/oauth/authorize` route redirects to the configured app URL.
- **Two loops** (active only while linked):
  - **event loop** — subscribes to the internal event bus; on each plugin event it (1) applies the linked apps' `onConnectorEvent` scripts headless (effect subset `formlogic.submitResponse`/`updateResponse` + in-process storage + `ui.toast`→log; for the script engine see the note under **Runner**) so raw records (Calls/Transcript/SMS) are written, and (2) fans out to matching flow bindings — evaluate condition, reserve with `idempotencyKey = flow:<binding>:<event key>` (the UNIQUE ledger makes desktop-vs-browser execution exactly-once), execute, apply outputActions, complete.
  - **claim loop** — every 20 s polls `GET /api/v1/flow-runs/queued`, claims `runtime='desktop'` exactly-once (409 → skip), executes from the stored snapshot, completes.
  - **command-relay loop** (remote call control, `src-tauri/src/flows/relay.rs`) — long-polls `GET /api/v1/connector-commands/pending?wait=25000` (needs `connector:relay`), claims each pending command exactly-once (`POST …/{id}/claim` `{instanceId}`; 409 → skip — the claim is the exactly-once gate), dispatches it through the **local connector gateway** (`connectors::dispatch` — the same manifest/capability-validated path the desktop uses for its own connector calls) to the named connector (e.g. `aokie`/`call`), and completes (`POST …/{id}/complete` `{status:'done'|'failed', result?, error?}`; the `complete` is retried on a transient network error so a run side-effect isn't stranded). The loop backs off on network/scope errors and exposes `relayPollOk` + `commandsHandled` + `lastCommandAt` in the `flowRuntime` status (`GET /api/desktop/info`). This is how a web member drives an Aokie call while the receptionist runs on another machine — see `docs/API.md` → *Remote command relay* and `docs/AOKIE_PLUGIN_CONTRACT.md`.
- **Runner.** A WorkflowGraph interpreter with the SAME node semantics as the browser executor (`input/output/condition/template/logic_block/llm_chat/http_request/formlogic_*|connector_request/storage_*/aokie_speak` + the desktop-service nodes `browser_action/image_gen/stt_transcribe/tts_speak`), a 50-node budget, per-run timeout, and a 50-node cap. User code (`condition`/`logic_block`) runs in the vendored static `qjs` binary (bundled as an embedded resource; 2 s / 64 MiB caps). `http_request`/`llm_chat` are allow-listed to the FormLogic base URL + local loopback services only.
  *Script engine today.* The `qjs` binary above is the design as frozen; before its retirement FormLogic Desktop replaced it with an embedded ZIPP sandbox. OAIY Desktop, which now fills this role, does not use ZIPP. It reserves runs on events and executes them only after claiming them; it hands claimed runs and each app's `onConnectorEvent` scripts (wrapped as `logic_block` nodes) to its bundled `oaiy` CLI, which runs the code on Node without the FormLogic prelude, and it evaluates binding conditions with its own restricted evaluator, which refuses — and never fires on — an expression outside its small supported subset.
- **Desktop-service nodes** (docs/FORMLOGIC_FLOWS.md §4.3). `browser_action`/`image_gen`/`stt_transcribe`/`tts_speak` drive a LOCAL managed service over its loopback HTTP API. The runner resolves the service base from `RunDeps.service_bases` (test/pre-resolution seam) or the **services registry** (`registry.service_port(id)` → `http://127.0.0.1:<port>`, with a best-effort `ensure_by_port` auto-start — mirroring `resolve_llm_endpoint`): `browser_action` → the `playwright-browser` service (`POST /session` → `goto`/`action`/`evaluate`/`html`/`screenshot`, per `resources/scripts/playwright_server.py`); `image_gen` → the `krea2` service (`POST /generate → {imageUrl}`) or a configured OpenAI-compatible images endpoint; `stt_transcribe`/`tts_speak` → a configured OpenAI-compatible `/v1/audio/*` endpoint (tts audio bytes → a `data:` URL). Unreachable → a typed `node_failed` whose message is actionable ("install & start the service in FormLogic Desktop → Services") — never "coming soon". The loopback HTTP allow-list applies throughout.
- **Presence heartbeat.** While linked, the desktop upserts the `desktop-connections` registry (~45 s) so the web app's remote viewer sees the runtime as `remote` (docs §14).
- **Logic languages (formlogic-python/1) — the contract a Desktop (OAIY) follows before it runs Python.** `condition` and `logic_block` nodes, and app-logic scripts, may be Python (`data.language` / a script's `language` is `'python'`; absent, `null` or `''` is JavaScript). A runtime built before Python ignores that field and would run Python as JavaScript — sometimes "successfully" (`result = inputs["n"] // 2` is `result = inputs["n"]` plus a comment) — so the server withholds Python work from any caller that does not say it runs Python, at every step. A Desktop that runs Python must do **all** of the following; one it skips keeps Python work from reaching it at that step (a relay run it cannot claim stays pending until it expires):
  1. **Heartbeat** — advertise the capability `logic-language:python` in the `capabilities` it upserts to `desktop-connections`. The browser defers a desktop-first binding (and app-logic script) to a fresh Desktop only when that Desktop advertises every non-JavaScript language the work is in — and, for a ZIPP-era Desktop, only while it also sends `logic-engine:zipp` (see *Desktop capability vocabulary* below); otherwise the browser runs it. The E2E relay (`POST /api/desktop/flows/run`) judges the target's stored heartbeat the same way, for every flow: a ZIPP-era target whose heartbeat lacks `logic-engine:zipp` gets nothing queued — not even a JavaScript or code-free flow — `409 engine_unavailable`; a flow with Python code is queued only for a target advertising it, else `409 language_unsupported` (with no online target, too).
  2. **Reserve and claim** — send `logicLanguages: ["javascript","python"]` on `POST /api/v1/flow-runs` (reserve) and `POST /api/v1/flow-runs/{id}/claim`, and `?logicLanguages=javascript,python` on `GET /api/v1/flow-runs/queued`. Without it a reserve that runs now, or a claim, of a Python flow is `409 {code:'language_unsupported', languages}` with nothing written, and the listing leaves such runs out (before its `LIMIT`). A `queued: true` reserve is not gated — it runs nothing; whoever claims it is. On these routes the server also knows *which* Desktop is calling (the API key's connection binding, FL-01) and reads the capabilities its last heartbeat stored: a ZIPP-era Desktop whose heartbeat lacks `logic-engine:zipp` is `409 {code:'engine_unavailable'}` on a reserve that runs now and on every claim (a queued reserve still goes through, so the event is not lost), and its queued listing is empty. Where the stored heartbeat and the body's `logicLanguages` disagree, the heartbeat alone decides whether the engine is up, and a language counts only when both name it (`FlowLogicLanguages::reconcile`); a legacy heartbeat (no tokens) leaves the body in charge, as before.
  3. **Relay claim** — send `logicLanguages` in the body of `POST /api/v1/desktop-flows/{id}/claim`; without it a relay run of a Python flow is `409 language_unsupported` and stays pending. The claimant's stored heartbeat is read as in item 2: `409 engine_unavailable` while its engine is not reporting healthy, and the run stays pending for a Desktop whose engine is up.
  4. **Graph fetch** — send `?logicLanguages=javascript,python` on `GET /api/v1/flows`. Without it the list leaves out every flow whose code needs a language other than JavaScript, so the fetch for one fails closed; a ZIPP-era Desktop whose engine is not reporting healthy receives no flows at all. Each listed flow carries `logicLanguages` (what it needs).
  5. **App-logic catalogue** — send `?languages=javascript,python` on `GET /api/v1/app-logic`. Without it Python scripts are left out of every bundle.
  6. **The leaf-script profile** — fetch `GET /api/v1/script-profile` (same `flows:read` gate) and run what it carries, rather than a copy compiled into the Desktop. See below.

  Language needs are computed from what a flow **executes**: a package core preset whose default lowers a contributed node to a Python `logic_block` counts as Python (the server reads the lowered graph and the revision's compiled IR). Having declared Python, the Desktop must run it as formlogic-python/1 on ZIPP web-python — the files, wrappers and line offsets in `ui/src/lib/formlogic/python/pythonContract.ts`, pinned by `docs/contracts/formlogic-python-logic-corpus.json` — and must fail a node whose language it does not know (`invalid_flow`), never run it as JavaScript. Binding conditions stay JavaScript.

- **The leaf-script profile (`GET /api/v1/script-profile`) — FormLogic's semantics as data, not as a second implementation.** Declaring `logic-language:python` says the Desktop *can* run Python; the profile is what tells it what a FormLogic expression **means**. It carries the standard library every expression sees (`prelude.js` — `validators.*`, `format.*`, `compliance.*`, `finance.*`, `safety.*`, `sum`, `avg`, `count`, …), its sha256, the instruction budget the browser host uses, and the `formlogic-python/1` contract's shared guest module. Without it a flow condition calling `validators.email(x)` throws "is not defined" on the Desktop and passes in the browser — the exact silent divergence the ecosystem exists to prevent. The route is documented in `docs/API.md`; in short:

  - **Body** — OAIY's `ScriptProfile` exactly: `{v: 1, preamble, preambleSha256, instructionSteps, python: {contract, files, entry, call}}`. That schema (`oaiy.com protocol/v1/script-profile.schema.json`) is `additionalProperties: false` at the top level *and* inside `python`, so there is no envelope and no room for one: the document's id is the path, its revision is the `ETag`, and budgets come from the Desktop's connector descriptor.
  - **Fetching** — send `If-None-Match` with the last `ETag`; a matching tag answers `304` with no body, so a five-minute poll transfers the ~30 KB once. `Cache-Control: private, max-age=300`. Verify `preambleSha256` before running anything, exactly as OAIY's own validator does, and refuse a profile that fails it rather than running the preamble unchecked. A `503 script_profile_unavailable` or a `404` means *no profile* — a state the Desktop already handles by running without a preamble.
  - **What it does NOT carry, and what that costs.** The `python` section is the shared contract only — `formlogic.py`, plus the entry module and function names. It does **not** carry `main.py`, the per-mode block wrappers or their line offsets (`pythonContract.ts` `ENTRIES`, `BLOCK_WRAPPERS`, `LINE_OFFSETS`), because the landed schema has no field for them. A consumer therefore cannot assemble a `python-project` job from this profile alone: it cannot wrap a `flow` block as a parenthesised expression and retry it as a module when that fails to compile, it cannot wrap a `condition` as `bool((…))`, and — because it does not know how many generated lines precede the author's first one — it cannot report `KeyError: 'missing' (line 1)` against the author's own numbering. Today FormLogic unfolds the modes itself and sends complete `files`; widening the schema with a per-mode list is an open ask on oaiy.com (O2-1).
  - **Only guest-side data crosses.** The driver stays in FormLogic: engine construction and `setInstructionBudget`, `initPythonProject`, the mode selection and source-error fallback, the reply channel, the output sanitiser and the author-message rewrite. A test asserts the served payload names none of them.

- **Desktop capability vocabulary — how the browser decides between a Desktop and itself.** For a desktop-first event (`aokie.*`) the browser hands a flow binding, a queued run or an app-logic script to a connected Desktop, or runs it itself (on ZIPP), by the `capabilities` each fresh (`lastSeenAt` < 90 s) `desktop-connections` row carries (`ui/src/client-runtime/flows/flowDispatcher.ts` `desktopTakesLanguages`; constants in `flows/nodes.ts`). Three tokens:

  | Token | Who sends it | Meaning |
  |---|---|---|
  | `logic-language:<id>` (`logic-language:javascript`, `logic-language:python`) | OAIY Desktop on ZIPP, for every language its `oaiy` CLI probe reports, on every heartbeat | Names a language the Desktop runs. Any such token marks a **ZIPP-era** Desktop (it emits `logic-language:javascript` at minimum). The server reads it with the engine token, by the same rule (`FlowLogicLanguages::desktopRuns`). |
  | `logic-engine:zipp` | OAIY Desktop on ZIPP, only while its ZIPP script host is healthy (its heartbeat drops the token when the engine is down) | The Desktop can run logic right now. Never sent by a legacy build; not itself a ZIPP-era marker. Required by the server too, from a ZIPP-era Desktop, before it queues or hands that Desktop any work. |
  | *(none)* | A Desktop built before this vocabulary | A **legacy** Desktop: runs JavaScript, and would run Python as JavaScript. |

  What the browser does, per fresh row (one row taking the work is enough):

  | Row's capabilities | JavaScript work | Python work |
  |---|---|---|
  | no `logic-language:*` token (legacy; also a heartbeat with no `capabilities` at all) | deferred to the Desktop, exactly as before | stays in the browser |
  | `logic-language:*` present, `logic-engine:zipp` absent (ZIPP-era, engine down) | stays in the browser | stays in the browser |
  | `logic-language:javascript` + `logic-engine:zipp` | deferred | stays in the browser |
  | `logic-language:python` + `logic-engine:zipp` | deferred | deferred |

  A stale row (older than 90 s) contributes nothing, whatever it carries; no fresh row at all, or an unreachable `GET /api/desktop-connections`, means the browser runs everything. The run drawer's relay-target picker (`ui/src/components/flows/remoteComputers.ts` `relayLanguageBlock`, via `capabilitiesRunLanguages` in `flows/nodes.ts`) predicts the server's answer per computer by the same table and says so before the click: for an engine-down computer, "its engine is not reporting healthy", never "does not run Python".

  **What the server does with the same tokens.** Every server gate reads a Desktop's *stored* heartbeat (`desktop_connections.capabilities_json`) through one function, `FlowLogicLanguages::desktopRuns`: no `logic-language:*` token → legacy, runs JavaScript (`null`, as a body with no `logicLanguages`); a language token without `logic-engine:zipp` → runs nothing (`[]`); both → the languages named. The relay enqueue (item 1) judges the resolved target for every flow, JavaScript-only and code-free ones included, and answers `409 {code:'engine_unavailable', message}` for a target that runs nothing — the code OAIY's own CLI uses for the same condition — and `409 language_unsupported` for a language gap as before; an untargeted run (no fresh Desktop) is judged at claim instead. The owner-surface reserve, claim, queued listing and flow list (items 2–4) and the relay claim (item 3) identify the calling Desktop by its API key's connection binding (FL-01) and judge it the same way: `409 engine_unavailable` on a reserve that runs now and on a claim (nothing written; a relay run stays pending), an empty `GET /api/v1/flow-runs/queued`, an empty `GET /api/v1/flows`. The heartbeat and the body's `logicLanguages` are reconciled as item 2 says. A session caller, a key bound to no connection, and a legacy Desktop are judged on the body alone, exactly as before this vocabulary. Not gated: a `queued: true` reserve (the event is kept; the claim is judged), and `GET /api/v1/desktop-flows/pending`, which is not filtered — an engine-down Desktop may see an untargeted relay run, its claim is refused and the run stays pending for a healthy Desktop.

## 7. Security requirements (normative)

- Privileged routes require a valid pairing token bound to the requesting origin; health/info are the only anonymous routes.
- Plugin processes get no inherited secrets; secrets live in the OS keyring or Desktop config, resolved server-side (desktop-side), never sent to the browser.
- Logs redact phone numbers/message bodies by default (plugins are responsible pre-emit; Desktop additionally truncates oversized events > 64 KiB).
- Event consumers must dedupe on `idempotencyKey`; producers must generate stable keys (`<source>:<correlationId>:<step>:v1`).
