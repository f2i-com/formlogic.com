# FormLogic Desktop — Local Companion Contract

**Status:** Phase 0 contract (frozen 2026-07-07). Canonical home of the cross-repo contracts: this repo, `docs/contracts/*.schema.json`.
**Repos:** the desktop implementation lives **in this repo** at `form-builder/desktop` (Tauri 2; relocated from `formlogic-com/formlogic-web` per the hybrid-layout decision in `docs/ADR_FORMLOGIC_DESKTOP.md`); the browser client lives at `form-builder/ui/src/client-runtime/desktop/`; plugins (e.g. Aokie) live in their own repos.

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

## 4. Plugin host

See `docs/DESKTOP_PLUGIN_SDK.md`. Summary: plugins are directories under `<desktop-data>/plugins/<id>/` with a `manifest.json` (`plugin-manifest.schema.json`), run as supervised child processes speaking JSON-RPC 2.0 over stdio (newline-delimited). Lifecycle states: `installed, stopped, starting, running, unhealthy, crashed, disabled`. Desktop enforces: commands must be covered by manifest `capabilities`; events must be declared in manifest `events`; a crashing plugin never takes Desktop down.

## 5. Browser client (FormLogic Web)

`form-builder/ui/src/client-runtime/desktop/`:
- `desktopDetection.ts` — poll `/api/health`, accept both companion ids, pub/sub status (mirrors formlogic-web `companionDetection.ts`).
- `desktopPairing.ts` — pairing-request flow + token/session storage per origin.
- `desktopClient.ts` — typed fetch wrapper (`info`, `plugins`, `connectors.request`, …).
- `desktopEvents.ts` — `EventSource` subscription, envelope validation, dedupe on `idempotencyKey`, dispatch into the app-logic `onConnectorEvent` hook and flow bindings.
- Desktop-backed connectors register as browser connectors (`registerBrowserConnector`) so the existing routing (native bridge → browser connector → mock) and permission model (`connector.<id>.<command>` grants) apply unchanged.

## 6. Versioning

`apiVersion` (HTTP surface) and `pluginApiVersion` (stdio protocol) are integers; breaking changes bump them. Plugins declare `pluginApiVersion` + `minDesktopVersion` in the manifest; Desktop refuses incompatible plugins with a visible state, never silently.

## 8. Headless flow runtime (FormLogic Cloud link)

FormLogic Desktop is the **headless runtime for flows + the Aokie receptionist** — the receptionist runs *inside* the Desktop app; the web app only views state remotely (docs/FORMLOGIC_FLOWS.md §14). This is implemented in `form-builder/desktop/src-tauri/src/flows/` + `formlogic_client.rs`.

- **Account link.** The desktop stores `{formlogicBaseUrl, formlogicApiKey}` in its config dir (`companion-config.json`, alongside the pairing store — survives a data-folder move; **treat the file as a secret — key encryption-at-rest is out of scope**). The key is a scoped External-API key (`flk_…`) with `flows:read` + `flows:write` + `responses:read` + `responses:write` + `responses:manage` + `connector:relay`. All three `responses:*` scopes are required: the runtime LISTs (for `formlogic_list_responses` and match-based updates), submits, and updates an app's records when applying `onConnectorEvent` effects + flow output actions. The GUI exposes this under **Settings → FormLogic Cloud** (base URL + key inputs, "Test connection", live status); the headless `formlogic-server` reads `FORMLOGIC_BASE_URL` + `FORMLOGIC_API_KEY`.
  - **App-internal forms:** an app's forms (e.g. the Aokie "Calls" store) are `draft` at the form level — the owner's API key can still write to them because `authorizeForm` proved ownership; the external API only refuses an `archived` form. Public/anon endpoints still require `published`.

  **Running the headless runtime locally (verified reproducible recipe):**

  ```
  # build both binaries
  cd form-builder/desktop/src-tauri && cargo build --bin formlogic-server --no-default-features
  cd <aokie-repo>/crates && cargo build -p aokie-plugin
  # install the plugin into a data dir
  mkdir -p <DATA>/plugins/aokie
  cp <aokie-repo>/crates/aokie-plugin/manifest.json      <DATA>/plugins/aokie/
  cp <aokie-repo>/crates/target/debug/aokie-plugin.exe   <DATA>/plugins/aokie/
  # run it linked (mint an flk_ key with the six scopes above for your user)
  FORMLOGIC_DATA_DIR=<DATA> FORMLOGIC_SERVER_TOKEN=<tok> \
  FORMLOGIC_BASE_URL=http://api.formlogic.local FORMLOGIC_API_KEY=<flk_…> \
  FORMLOGIC_DEV_MODE=1 FORMLOGIC_DESKTOP_DEV_ALLOW_ORIGIN=http://formlogic.local \
    form-builder/desktop/src-tauri/target/debug/formlogic-server
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
- **Two loops** (active only while linked):
  - **event loop** — subscribes to the internal event bus; on each plugin event it (1) applies the linked apps' `onConnectorEvent` scripts headless (QuickJS, effect subset `formlogic.submitResponse`/`updateResponse` + in-process storage + `ui.toast`→log) so raw records (Calls/Transcript/SMS) are written, and (2) fans out to matching flow bindings — evaluate condition in QuickJS, reserve with `idempotencyKey = flow:<binding>:<event key>` (the UNIQUE ledger makes desktop-vs-browser execution exactly-once), execute, apply outputActions, complete.
  - **claim loop** — every 20 s polls `GET /api/v1/flow-runs/queued`, claims `runtime='desktop'` exactly-once (409 → skip), executes from the stored snapshot, completes.
  - **command-relay loop** (remote call control, `src-tauri/src/flows/relay.rs`) — long-polls `GET /api/v1/connector-commands/pending?wait=25000` (needs `connector:relay`), claims each pending command exactly-once (`POST …/{id}/claim` `{instanceId}`; 409 → skip — the claim is the exactly-once gate), dispatches it through the **local connector gateway** (`connectors::dispatch` — the same manifest/capability-validated path the desktop uses for its own connector calls) to the named connector (e.g. `aokie`/`call`), and completes (`POST …/{id}/complete` `{status:'done'|'failed', result?, error?}`; the `complete` is retried on a transient network error so a run side-effect isn't stranded). The loop backs off on network/scope errors and exposes `relayPollOk` + `commandsHandled` + `lastCommandAt` in the `flowRuntime` status (`GET /api/desktop/info`). This is how a web member drives an Aokie call while the receptionist runs on another machine — see `docs/API.md` → *Remote command relay* and `docs/AOKIE_PLUGIN_CONTRACT.md`.
- **Runner.** A WorkflowGraph interpreter with the SAME node semantics as the browser executor (`input/output/condition/template/logic_block/llm_chat/http_request/formlogic_*|connector_request/storage_*/aokie_speak` + the desktop-service nodes `browser_action/image_gen/stt_transcribe/tts_speak`), a 50-node budget, per-run timeout, and a 50-node cap. User code (`condition`/`logic_block`) runs in the vendored static `qjs` binary (bundled as an embedded resource; 2 s / 64 MiB caps). `http_request`/`llm_chat` are allow-listed to the FormLogic base URL + local loopback services only.
- **Desktop-service nodes** (docs/FORMLOGIC_FLOWS.md §4.3). `browser_action`/`image_gen`/`stt_transcribe`/`tts_speak` drive a LOCAL managed service over its loopback HTTP API. The runner resolves the service base from `RunDeps.service_bases` (test/pre-resolution seam) or the **services registry** (`registry.service_port(id)` → `http://127.0.0.1:<port>`, with a best-effort `ensure_by_port` auto-start — mirroring `resolve_llm_endpoint`): `browser_action` → the `playwright-browser` service (`POST /session` → `goto`/`action`/`evaluate`/`html`/`screenshot`, per `resources/scripts/playwright_server.py`); `image_gen` → the `krea2` service (`POST /generate → {imageUrl}`) or a configured OpenAI-compatible images endpoint; `stt_transcribe`/`tts_speak` → a configured OpenAI-compatible `/v1/audio/*` endpoint (tts audio bytes → a `data:` URL). Unreachable → a typed `node_failed` whose message is actionable ("install & start the service in FormLogic Desktop → Services") — never "coming soon". The loopback HTTP allow-list applies throughout.
- **Presence heartbeat.** While linked, the desktop upserts the `desktop-connections` registry (~45 s) so the web app's remote viewer sees the runtime as `remote` (docs §14).

## 7. Security requirements (normative)

- Privileged routes require a valid pairing token bound to the requesting origin; health/info are the only anonymous routes.
- Plugin processes get no inherited secrets; secrets live in the OS keyring or Desktop config, resolved server-side (desktop-side), never sent to the browser.
- Logs redact phone numbers/message bodies by default (plugins are responsible pre-emit; Desktop additionally truncates oversized events > 64 KiB).
- Event consumers must dedupe on `idempotencyKey`; producers must generate stable keys (`<source>:<correlationId>:<step>:v1`).
