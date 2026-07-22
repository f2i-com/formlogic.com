# FormLogic Flows — Contract & MVP Design

**Status:** Phase 0 contract (frozen 2026-07-07) + Flows-v1 extensions (§8–§13: workspace flows, KV storage, queued/claim lifecycle, `ctx.flows.run`, `form.submitted` enqueue, API-key access) + Flows workspace UI (§15). Schemas: `docs/contracts/flow-binding.schema.json`, `flow-run-request.schema.json`, `flow-run-result.schema.json`.
**Engine lineage:** F2I (`f2i-com/f2i-web`, `ui/vendor/f2i-core`) is the flow engine/editor; FormLogic stores flow definitions and exposes them as the user-facing **FormLogic Flows** feature.

## 1. Product model

- Flows are stored **in FormLogic** (portable with app packages, permissioned by app context) with `engine: 'f2i'` and a graph JSON that is **WorkflowGraph-compatible** (`{nodes:[{id,type,data,position?}], edges:[{source,target,sourceHandle?,targetHandle?}]}`) so the full F2I editor/compiler can be adopted later without a data migration.
- MVP scope is **app-level flows**: a Flows panel in the app builder (library, bindings, test run, run history), a `flow.run` app-logic effect, and an event-driven runner.

## 2. Storage (backend tables)

Added via the standard `MySQLConnection` idempotent migration pattern. Key types mirror the live `apps`/`forms`/`users` key types.

- `flow_definitions` — `id, owner_user_id, app_id NULL, name, slug, description, engine('f2i'), flow_json JSON, input_schema JSON NULL, output_schema JSON NULL, node_capabilities JSON NULL, version INT, enabled, created_at, updated_at`, `UNIQUE(app_id, slug)`. **`app_id NULL` = a workspace flow** (§8); workspace slug uniqueness per owner is enforced in `FlowService` (MySQL UNIQUE ignores NULLs).
- `app_flow_bindings` — `id, app_id NULL, form_id NULL, connector_id NULL, flow_definition_id, event_name, mode('sync'|'async'|'background'|'manual'), condition_json, input_map_json, output_actions_json, timeout_ms, retry_policy_json, fallback_policy_json, enabled, sort_order, created_at, updated_at`. JSON columns follow `flow-binding.schema.json`. **`app_id NULL` + `form_id` set = a workspace binding on a standalone form** (§12), owned via the bound flow's `owner_user_id`.
- `flow_run_logs` — `id, app_id NULL, form_id NULL, response_id NULL, binding_id NULL, flow_definition_id, trigger_event, correlation_id, idempotency_key UNIQUE, status, runtime NULL, claimed_by NULL, input_snapshot_json, result_json, output_actions_json, error_json, started_at, finished_at, created_at`. The UNIQUE idempotency key is the cross-tab/browser/server dedupe gate: reserving the run row **before** execution means duplicate events run the flow at most once. `runtime`(`'browser'|'desktop'`)/`claimed_by` record who claimed a `queued` run (§10); `app_id NULL` = a workspace-flow run.
- `flow_kv` — `id, owner_user_id, app_id ('' = workspace, NOT NULL so the UNIQUE key dedupes), scope, k, v MEDIUMTEXT(JSON), created_at, updated_at`, `UNIQUE(owner_user_id, app_id, scope, k)` (§9).
- `desktop_connections` — `id, owner_user_id, device_name, desktop_instance_id, last_seen_at, capabilities_json, trusted_origins_json, created_at, updated_at` (registry of paired FormLogic Desktop installs; upserted on successful pairing).

## 3. API (owner-scoped under `/api/apps/{id}`, runtime under `/api/app/{slug}`)

- Owner CRUD: `GET/POST /api/apps/{id}/flows`, `GET/PUT/DELETE /api/apps/{id}/flows/{flowId}`, bindings CRUD `.../flow-bindings`, `GET .../flow-runs` (history), `POST .../flows/{flowId}/test-run` (records a run log).
- Runtime: `POST /api/app/{slug}/flow-runs` (reserve: `{flowSlug, bindingId?, triggerEvent, correlationId, idempotencyKey, inputSnapshot, queued?}` → 201 `{runId}` | 200 `{runId, idempotent:true}` when already reserved/complete; `queued:true` reserves without starting — see §10), `PATCH /api/app/{slug}/flow-runs/{runId}` (complete: status/result/error per `flow-run-result.schema.json`), `GET .../flow-runs/queued` + `POST .../flow-runs/{runId}/claim` (§10), `GET/PUT .../flow-kv` (§9). Permission-gated by app role; rate-limited like reports.
- Workspace scope (§8): `GET/POST /api/flows`, `GET/PUT/DELETE /api/flows/{flowId}`, `GET /api/flow-runs` (+ `/queued`, `/{runId}/claim`, `PATCH /{runId}`), `GET/PUT/DELETE /api/flow-kv`, `GET/POST/PUT/DELETE /api/forms/{id}/flow-bindings` (§12).
- External API mirrors under `/api/v1` with `flows:read`/`flows:write` API-key scopes (§13).
- Server-side sanitization mirrors the schema caps (binding JSON ≤ 16 KiB, flow_json ≤ 256 KiB, ≤ 50 flows/app or workspace, ≤ 100 bindings/app or form).

## 4. Execution (MVP: browser runner; Desktop runner post-MVP)

Selection order (from the plan): Desktop runner for flows needing local models/hardware → **browser for pure/browser-safe flows** → server/headless later. The MVP implements the **browser runner** inside the app runtime; Desktop `/api/flows/run` stays reserved (501) until the Desktop-side runner lands.

**v0 executor** (`formlogic/ui/src/client-runtime/flows/`): a small, well-tested interpreter over the WorkflowGraph JSON supporting a restricted node set:

```
input, output, condition, template, logic_block (QuickJS-sandboxed expression),
llm_chat            (OpenAI-compatible endpoint via FormLogic Desktop services or configured AI provider),
http_request        (allow-listed: Desktop base URL + FormLogic API only),
formlogic_list_responses, formlogic_submit_response, formlogic_update_response,
connector_request   (e.g. aokie.* via the connector client — full permission gating applies),
storage_get {scope?, key}                 (read a Flow KV value — docs §9),
storage_set {scope?, key, value|valueFrom} (write a Flow KV value — requires the 'formlogic.kv.write' capability),
aokie_speak {text|textFrom}               (sugar for connector_request aokie call.operatorSpeak),
browser_action      (drive the local Playwright Browser service — goto/click/type/extract/screenshot/evaluate),
image_gen           (text-to-image via the local Krea-2 service, or a configured OpenAI-compatible images endpoint),
stt_transcribe      (speech → text via a configured OpenAI-compatible transcription endpoint),
tts_speak           (text → speech via a configured OpenAI-compatible speech endpoint),
desktop_services    (read-only list of FormLogic Desktop's managed services — id/status/port + loopback url while running)
```

The last four are **desktop-service-backed** (docs §4.3): they drive a LOCAL FormLogic Desktop service over its loopback HTTP API. Both the browser runner AND the desktop Rust runner implement them identically; when the local service can't be reached the node fails with an ACTIONABLE `node_failed` ("install & start the service in FormLogic Desktop → Services") — never "coming soon".

Unsupported node types fail the run with `invalid_flow` naming the node — flows authored in the full F2I editor degrade loudly, never silently. The executor enforces the binding's `timeoutMs`, per-node timeouts, and total-node budget; **sync** bindings (live-call decisions) should use 2–4 s timeouts with `fallbackPolicy.fallbackReply`.

**All user-authored code is QuickJS-sandboxed — no exceptions.** The only node types that evaluate author-supplied *code* are `condition` and `logic_block`, and BOTH run in the `lib/formlogic` QuickJS engine (real JS on a locked-down interpreter; `eval`/`new Function` appear nowhere in `client-runtime/flows/*` — a vitest static scan asserts this). `template`/`selectors` are pure string/path operations, never a code path. A `logic_block` receives a **frozen, JSON-only** `ctx` exposing exactly `{inputs, event, kv, app}` (plus `nodes`/`upstream` for graph plumbing): `kv` is a **read-only snapshot** of the node's KV scope (`data.scope`, else `flow:<slug>`), so a logic block can *read* KV inline but can only *write* via a capability-gated `storage_set`/`formlogic.store`. It runs under a **2 s default wall-clock timeout** (`data.timeoutMs` overrides within 100 ms…30 s) so a wedged evaluation can never stall the run budget.

**Flow KV nodes (docs §9):** `storage_get`/`storage_set` and the `formlogic.store` output action read/write the owner's Flow KV — the app store while an app runtime is active, else the workspace store. Writes are gated: the flow must declare `formlogic.kv.write` in `nodeCapabilities` (the same declare-then-grant model as connector/response capabilities). `formlogic.store {scope?, key, value}` is a binding output action that persists part of `$result` after a successful run.

**Trust model:** flows execute with the *viewer's* session and the app's granted permissions. Every `formlogic.*` write goes through the normal authenticated API (validation, permissions, onSubmit scripts, idempotency all run server-side) — flow outputs are untrusted until validated. `connector_request` nodes pass through the standard connector permission gate (`connector.<id>.<command>` grants).

**llm_chat endpoint resolution** (in order): (1) the node's own `data.endpoint` (allow-listed to the Desktop base URL / FormLogic API); (2) a running **FormLogic Desktop** local AI service — the paired Desktop's `GET /api/services` is queried for the first running OpenAI-compatible service and its loopback endpoint is used; (3) the app's configured AI base URL (`<base>/chat/completions`). No candidate → `node_failed` naming all three options.

### 4.1 Node reference (how each executable node works)

#### How a flow works (read this first)

A flow is a short chain of steps, read left to right:

```
  Trigger ──▶ steps that act on the data ──▶ Output
 (provides            (Find records,          (returns
  $inputs)          Condition, Template,      the result)
                      AI, …)
```

1. **Trigger** (the `input` node, shown as **"When this runs"**) is where the flow starts. It **declares the named inputs the flow receives** — e.g. `callerPhone`, `callId`, `transcript` — and shows them as chips on its card. Those values come from the flow **binding**, which maps the trigger event onto them (`inputMap: { callerPhone: "$event.data.callerPhone" }`). The Trigger is the **single, visible source** of the flow's inputs; everything downstream reads them as **`$inputs.<name>`** (never `$event.data.…` directly — the binding already did that mapping).
2. **Steps** in the middle act on the data: **Find records** looks something up, **Condition** branches True/False, **Template**/**AI** build text, and so on. Each step's output is referenced by the next as **`$nodes.<id>`** (e.g. `$nodes.lookup.first.answers.name`).
3. **Output** returns the flow's result. The binding's `outputActions` then decide what to do with it (write a record, toast, speak…).

**Worked example — caller lookup:** `Trigger(callerPhone)` → **Find records**: first `Customers` where `phone` = `$inputs.callerPhone` → **Condition** on `$nodes.lookup.found` → on **True**, a **Template** greeting `Welcome back, {{nodes.lookup.first.answers.name}}!` → **Output**. Read aloud it is a plain rule: *"when a call comes in, find the customer with that phone; if we know them, greet them by name."*

Every node reads the **run scope** (`$inputs.*`, `$event.*`, `$app.*`, and prior node outputs `$nodes.<id>.*`) and writes ONE output value, exposed to downstream nodes as `$nodes.<thisNodeId>`. Selector strings in a node's data (`$event.data.x`, `$nodes.lookup.first.answers.name`) are resolved against that scope; `{{path}}` templates interpolate the same roots without the `$`. The catalog (`nodeCatalog.ts`) carries an `output` descriptor per node that the properties panel surfaces as an **"Output:"** hint and this table mirrors.

| Node | Inputs (data) | Does | Output → reference as |
| --- | --- | --- | --- |
| `input` (**Trigger** — "When this runs") | `inputs[]` = `{name, example?}` (declared, presentation-only) | Starts the flow; declares + displays the named inputs it receives from the binding. | the flow inputs → `$inputs.<name>` |
| `output` | `value?` (selector/JSON) | The flow result; `value` wins, else the upstream value passes through. | terminal (the flow result) |
| `condition` | `expr` (QuickJS bool), `timeoutMs?` | Branches on a sandboxed boolean. Errors (incl. a budget overrun) fail the run. Wall clock capped (1s default; `timeoutMs` 100ms–30s overrides — same bounds as `logic_block`). | routes the **True**/**False** handle |
| `template` | `template` | Interpolates `{{path}}` into a string. | string → `$nodes.<id>` |
| `logic_block` | `expr` (QuickJS), `timeoutMs?`, `scope?` | Runs JS in the sandbox over a frozen `{inputs,event,app,nodes,upstream,kv}`. Errors (incl. a budget overrun) fail the run — same as `condition`. Wall clock capped (2s default; `timeoutMs` 100ms–30s overrides). | your return value → `$nodes.<id>` |
| `llm_chat` | `system?`, `prompt`, `model?`, `maxTokens?`, `temperature?`, `endpoint?` | Calls an OpenAI-compatible chat endpoint (§4). | `{content,raw}` → `$nodes.<id>.content` |
| `http_request` | `url`, `method`, `body?` | Fetches an allow-listed URL (Desktop base / FormLogic API only). | `{status,ok,body}` → `$nodes.<id>.body` |
| `formlogic_list_responses` (**Find records**) | `form`, `filters[]`, `return?` (`first`\|`all`, presentation-only), `limit` | Finds records in a form, with an optional filter (see the frozen contract below). | `{responses,count,first,found}` |
| `formlogic_submit_response` | `form`, `answers` | Submits through the authenticated pipeline (validation + onSubmit + idempotency). | created response → `$nodes.<id>.id` |
| `formlogic_update_response` | `form`, `responseId`, `answers` | Patches a response through the pipeline. | updated response → `$nodes.<id>` |
| `connector_request` | `connectorId`, `command`, `payload?` | Calls a connector command through the permission-gated client. | command result → `$nodes.<id>` |
| `storage_get` | `key`, `scope?` | Reads a Flow KV value (§9). | value (or undefined) → `$nodes.<id>` |
| `storage_set` | `key`, `value`/`valueFrom`, `scope?` | Writes Flow KV (needs `formlogic.kv.write`). | `{stored,scope,key}` |
| `aokie_speak` | `text`/`textFrom` | Sugar for `connector_request aokie call.operatorSpeak`. | connector result → `$nodes.<id>` |
| `browser_action` **(Desktop)** | `action` (`goto`\|`click`\|`type`\|`extract_text`\|`extract_html`\|`screenshot`\|`evaluate`), `url?`, `selector?`, `text?`, `script?`, `waitFor?`, `sessionId?`, `closeSession?`, `endpoint?` | Drives the local **Playwright Browser** service (default :17880). | `{sessionId, status?, url?, title?, text?, html?, dataUrl?, result?}` |
| `image_gen` **(Desktop)** | `prompt`, `width?`, `height?`, `steps?`, `model?`, `service?`, `endpoint?` | Text-to-image via the local **Krea-2** service (`/generate`) or a configured OpenAI-compatible images endpoint. | `{imageUrl}` or `{dataUrl}` → `$nodes.<id>.imageUrl` |
| `stt_transcribe` **(Desktop)** | `endpoint`, `model?`, `audio` (selector → data URL/URL/base64), `service?` | Speech → text via a configured OpenAI-compatible `/v1/audio/transcriptions`. | `{text}` → `$nodes.<id>.text` |
| `tts_speak` **(Desktop)** | `endpoint`, `model?`, `voice?`, `text`, `service?` | Text → speech via a configured OpenAI-compatible `/v1/audio/speech` (audio bytes → data URL). | `{audioUrl}` or `{dataUrl}` → `$nodes.<id>.audioUrl` |
| `desktop_services` **(Desktop)** | — | Read-only listing of Desktop's managed services, so a logic block can resolve a picked `service:<id>` to a live loopback endpoint at run time. No Desktop → `{services: []}`, never an error. | `{services: [{id, name, category, status, port, url}]}` → `$nodes.<id>.services` (`url` set only while running) |
| `service_action` **(Desktop)** | `definitionId`, `actionId`, `connection` (Desktop AI provider profile id — opaque, never a URL/key), `input?` (object; `$` selectors resolve), `timeoutMs?` | **Generic ServiceDefinition action** (extensible-flows plan §7, v1): Desktop's ServiceActionHost (`services/invocation.rs`) resolves the action from the v3 Services catalog, validates `input` against the action's declared `inputSchema` (the §6.5 JSON-Schema subset), executes the transport through the credential-holding provider gateway (loopback + internal token — credentials never reach the flow), and validates the output. v1 executes only `openai-compatible` `/v1/*` request/response transports; event-stream lanes and other transports refuse `action_unavailable`. **Browser** (§7.6 paired same-machine leg): a browser-executed flow invokes the SAME ServiceActionHost through `POST /api/services/actions/{definitionId}/{actionId}/invoke` on the Desktop's token-gated loopback gateway — `management_auth_guard` derives the required exact owner-minted `service.{definition}.{action}` capability from the path (fail-closed like the AI inference lanes; the browser mints it via the backend's `/service-capability` allow-list), and aborting the browser request cancels the in-flight Desktop-side gateway call. Without a reachable paired Desktop the node keeps its typed, actionable Desktop-only refusal (remote users route the whole flow through the Desktop relay instead — the §7.6 matrix). Cloud refuses typed. Failures carry the §6.7 taxonomy (`service_unavailable` / `action_unavailable` / `input_invalid` / `output_invalid` / `transport_failed`) as `code: detail` — identical from both the desktop runner and the browser leg. Authoring: the property panel's definition/action pickers read the paired Desktop's v3 catalog (`servicePlatform.catalog()`, session-cached; free text without a Desktop), the picked action's description surfaces under the field, and the input mapping gets §6.4 lattice advice against the action's declared `inputSchema` (the same conservative machinery as flow_call's checks — §6.4 consumer #2). | The action's `outputSchema`-validated result object → `$nodes.<id>.<field>` |
| `flow_call` | `flowId` (the target flow's STABLE id — never a slug), `input?` (object; `$` selectors resolve), `failureMode?` (`fail-parent` default \| `route`), `timeoutMs?` | **Awaited flow-to-flow composition** (extensible-flows plan §8, browser v1): the dispatcher's FlowInvoker resolves the child by id within the SAME app runtime (the runtime list is the allowlist — cross-app calls are structurally impossible), guards recursion (a flow already in the awaited chain refuses `recursion_detected`) and depth (max 8, `root_budget_exceeded`), reserves a child run log (`trigger_event` `flow.call`, its own pinned revision), executes inline with the ancestry extended, and completes the run. The node routes its **Success**/**Failure** handles by child outcome; `fail-parent` (default) fails the parent `child_flow_failed` instead of routing, so an unwired failure is loud. Works in BOTH browser scopes through one shared guard core (`childFlowInvoker.ts`) — app runtime and workspace (Test Run included), each resolving children only from its own flow list — AND on FormLogic Desktop (§15.6): the dispatcher's FlowInvoker (`run_child_flow`) resolves within the owner's flow snapshot, reserves a lineage-linked owner run, and executes the child INLINE on the same worker — never re-enqueued behind its parent on the single-flight relay lane. AND in FormLogic Cloud: the child runs in the caller's scope, is metered like any started cloud run, inherits the parent's REMAINING wall-clock, and must itself be cloud-eligible (an ineligible child is a routeable child failure). Inline `flowJson` runs (no stable flow identity) refuse typed. Authoring: the property panel picks the child from the SAME sibling flow list the runtimes resolve against (`FlowEditorContext.flows`), warns on self-recursion, and statically advises on the input mapping through the §6.4 assignability lattice (`flowCallChecks.ts`: required/declared-input presence, typo detection, and per-key type levels against the child's `inputSchema` — literal mismatches at conversion-required/incompatible read as errors; `$` selectors always defer to run time). | `{ status: 'succeeded'\|'failed', result?, error?, runId }` → `$nodes.<id>.result` / `.error` / `.runId` |

**`formlogic_list_responses` (Find records) — FROZEN CONTRACT** (the browser executor and the desktop Rust runner behave identically). The 2026-07 clarity redesign renamed the node to **Find records** and reworked its editor UI, but the node **type, data shape and output are unchanged**:

- **`form`** — the form to search in. The editor's **form picker** avoids the "too many forms" dropdown: an **app-scoped** flow offers ONLY that app's forms (a short labelled list); a **workspace** flow (or an app with many forms) gets a **searchable typeahead**. A "dynamic value" escape hatch still accepts a literal id or a selector (e.g. `$inputs.formId`). A missing/unresolvable form fails the run `invalid_flow`.
- **`filters`** — an array of `{ field, op, value }` rows, **ANDed** ("only keep records where every rule matches"). `field` is a form field id; `op` ∈ `eq` (equals), `neq` (not equals), `contains` (case-insensitive substring on `String(value)`), `gt`/`lt` (numeric, string-locale fallback), `in` (one of — `value` is an array or comma list, membership tested), `phone_eq` (phone-normalized equality: both sides reduced to digits and compared on their last-9-digit suffix, so `+61 400 000 000` matches `0400000000`; fewer than 6 digits never matches); `value` is a literal or a selector resolved against the run scope (e.g. `$inputs.callerPhone`). `eq`/`neq` are loose (`String()`-compare) to match stored field values.
- **`return`** — an editor-only hint (`first` \| `all`) that tells the author which output to read and adjusts the "Output" hint. It does **not** change execution — the node always returns the full structured result.
- **`limit`** — max rows to **fetch** (default `200`, hard cap `500`). `eq` and `phone_eq` filters with string values are ALSO **pushed down to the database** (`answers.<field>` / `answersPhone.<field>` query params), so an exact or phone lookup is answered by the server and never silently missed beyond the fetch window; the other ops filter client-side over the fetched page.
- **Output** (structured): `{ responses: row[], count: number, first: row|null, found: boolean }`, where each `row` = `{ id: string, answers: object, submittedAt?: string, status?: string }`. Reference the first match as `$nodes.<id>.first.answers.<field>`, all matches as `$nodes.<id>.responses`, the total as `$nodes.<id>.count`, or whether any matched as `$nodes.<id>.found`.

**Worked example — caller lookup** (the `caller-lookup` starter template): `Trigger(callerPhone)` → **Find records** first `Customers` where `phone eq $inputs.callerPhone` → a `condition` on `$nodes.lookup.found` → a `template` greeting `Welcome back, {{nodes.lookup.first.answers.name}}!` on the **True** branch → `output`. Note the filter reads **`$inputs.callerPhone`**, not `$event.data.callerPhone`: the Trigger declares `callerPhone` and the binding's `inputMap` maps the event onto it, so the flow has one visible source of inputs. This is the canonical "find a record and branch on it" shape.

### 4.2 Context-aware palette (app/connector availability)

The node palette is **context-aware** (`isNodeAvailableInContext` in `nodeCatalog.ts`, fed a `FlowEditorContext` from the workspace): generic nodes (`input`/`output`/`condition`/`template`/`logic_block`/`llm_chat`/`http_request`/`storage_*`/`formlogic_*`) always show; connector-sugar nodes declare `requiresConnector` and appear ONLY when an installed app provides that connector. Availability is derived from the installed apps' declared `connector.<id>.<command>` grants (e.g. the Aokie Receptionist app grants `connector.aokie.*`, so `aokie_speak` shows only in a flow scoped to an app that grants the `aokie` connector — a workspace flow with no app context hides it). `connector_request` stays available everywhere, but its **Connector** / **Command** pickers become selects/datalists populated from the available connectors when known, rather than free text. The four **desktop-service** nodes (`browser_action`, `image_gen`, `stt_transcribe`, `tts_speak`) declare `requiresDesktopService` and render a functional **"Runs on FormLogic Desktop"** badge in the palette + on the canvas node (they are fully insertable, not previews).

### 4.3 Desktop-service-backed nodes (real, executable)

`browser_action` / `image_gen` / `stt_transcribe` / `tts_speak` drive a **local FormLogic Desktop service** over its loopback HTTP API. They are implemented **identically** in the browser executor (`client-runtime/flows/nodes.ts`) and the desktop Rust runner (`desktop/src-tauri/src/flows/runner.rs`); the `nodeCatalog.ts` ↔ executor parity test keeps the executable set in lock-step across both.

**Service resolution** (in order): (1) the node's own `endpoint` — a full URL for `image_gen`/`stt`/`tts`, or the service base for `browser_action` — allow-listed to a local loopback service / the FormLogic API; (2) the running Desktop service by id — the **browser** asks the paired Desktop's `GET /api/services` (`resolveDesktopServiceBase`), the **desktop runner** resolves the port from its services registry and **best-effort auto-starts** it (`ensure_by_port`). No candidate, or the service unreachable (Desktop absent/unpaired, service stopped, CORS, connection refused) → an **actionable** `node_failed`: *"This step runs on FormLogic Desktop. Install and start the &lt;service&gt; service in FormLogic Desktop → Services, then run the flow there."* — never "coming soon".

- **`browser_action`** → the bundled `playwright-browser` service (default :17880). One node runs a full step: (re)use a session (thread `$nodes.<id>.sessionId` into a later browser action to reuse the same page), optionally navigate (`url`) + wait (`waitFor`), then perform the `action`. `extract_text` runs `innerText` (of `selector`, else the body); `evaluate` runs `script` in the page.
- **`image_gen`** → the bundled `krea2` text-to-image service (`POST /generate → {imageUrl}`). A superset request body also drives an **OpenAI-compatible** images endpoint (`POST /v1/images/generations → {data:[{url|b64_json}]}`) when `endpoint` overrides it; the response is parsed tolerantly (`imageUrl`, else `data[].url`, else `data[].b64_json` → a `data:` URL).
- **`stt_transcribe` / `tts_speak`** → a **configured** OpenAI-compatible endpoint (no bundled service ships). stt POSTs JSON `{model?, audio}` and reads `{text}`; tts POSTs `{model?, voice?, input}` and turns the returned audio **bytes** (or a JSON `{audioUrl|b64_json}`) into a `data:` URL. The endpoint is allow-listed to loopback / the FormLogic base.

**Trust model:** the loopback HTTP allow-list applies (a local `127.0.0.1`/`localhost` service or the FormLogic base only) — a node can never point these at an arbitrary external host from the viewer's browser. Non-loopback, non-FormLogic endpoints are `capability_denied`.

## 5. Triggering

- **Event bindings:** `desktopEvents.ts` receives desktop-event envelopes (SSE) and, for each enabled binding matching `event_name` (+ sandbox-evaluated `condition`), reserves a run (`idempotencyKey = flow:<binding>:<event idempotencyKey>`), builds inputs via `inputMap` selectors (`$event.data.x`, `$app`), executes, applies `outputActions`, completes the run log. Form events (`form.submitted`) hook the same dispatcher from `onAfterSubmit`.
- **Manual:** binding `mode:'manual'` renders a button in the app runtime; the Flows panel offers "Test run" with a sample event payload.
- **Outcome triggers ("Another Flow", extensible-flows plan §9):** the four canonical terminal events `flow.succeeded` / `flow.failed` / `flow.timed_out` / `flow.cancelled` are emitted exactly-once per terminal run (the `flow_outcome_events` outbox) and dispatch as **independent queued runs** (§10) to enabled non-manual bindings — the source app's bindings plus the owner's workspace bindings. The trigger editor (§9.1) offers a **source-flow picker** that filters to one source flow by managing the binding condition `event.data.flowId === '<flow id>'` (kept in the ordinary condition field; hand-edited conditions read as "Custom" and are never rewritten). Conditions never run server-side — the claiming runtime evaluates them fail-safe at claim time (false/error cancels the handler run). Loop guards (§9.2): a run never re-triggers the binding that produced it, each (root, binding, event) pair fires at most once per run tree, and lineage depth caps at 16; the editor warns on self-handling bindings and on `manual` mode (which never receives outcome events).
- **`flow.run` app-logic effect:** `{type:'flow.run', flow, mode:'sync'|'async', timeoutMs?, input}` added to `CustomAppLogicEffect`; required permission `flow.run` / `flow.<slug>.run` / `flow.*.run` via the standard grant model. Sync returns the flow result into the `onConnectorEvent`-style chained hook; async just reserves+queues.

## 6. Packaging

App packages (`PackData`) gain optional `flows?: PackFlowDefinition[]` and `flowBindings?: PackFlowBinding[]` (with `@pack:` form references), imported atomically by `PackService::importPack` and exported by the signed application-package path. Starter flows ship with the Aokie Receptionist package.

## 7. Upgrade path to the full F2I engine

The stored graph is F2I-compatible by construction. Later phases can (a) vendor `f2i-core` (compiler+runtime, host-agnostic via the `tauriInvoke` broker) for full-fidelity browser execution, (b) embed the React-Flow editor (`F2IBuilder`), and (c) implement the Desktop flow runner endpoints — all without changing storage, bindings, run logs, or permissions.

## 8. Workspace flows (app-independent)

Flows are first-class per USER, not only per app: a **workspace flow** is a `flow_definitions` row with `app_id NULL`, owned by `owner_user_id`. It can be bound to standalone (non-app) forms (§12), triggered from form scripts (§11), and executed by any of the owner's runtimes (browser session or FormLogic Desktop).

- Endpoints (session auth, same gate as `/api/forms`): `GET/POST /api/flows`, `GET/PUT/DELETE /api/flows/{flowId}`. App-level endpoints under `/api/apps/{id}` are unchanged.
- **Slug uniqueness**: MySQL's `UNIQUE(app_id, slug)` ignores `NULL` app_ids, so per-owner workspace slug uniqueness is enforced in `FlowService::createWorkspaceFlow`/`updateWorkspaceFlow` (`assertWorkspaceSlugFree`). All workspace writes must go through those methods.
- Caps: ≤ 50 workspace flows per owner (same constant as per-app).
- Owner-wide run history: `GET /api/flow-runs` (paginated, newest first; filters `flowId`, `status`, `appId` — pass `appId=workspace` for workspace-only runs) spans every flow the user owns, app and workspace alike.

## 9. Flow KV storage

Small persistent key/value state for flows (counters, cursors, dedupe markers, connector state) in the `flow_kv` table, keyed by `(owner, app, scope, key)`. Scopes are free-form labels, by convention `flow:<slug>` for per-flow state and `app` for app-wide state.

- **Caps** (enforced in `FlowKvService`, every write path): encoded value ≤ **64 KiB**, ≤ **500 keys per (owner, app, scope)**. Scope `^[a-z][a-z0-9:_.-]{0,63}$`; key ≤ 190 chars of `[A-Za-z0-9:_./-]`.
- **Owner surface** (session auth): `GET /api/flow-kv?scope=&k=&appId=` (one entry with `k`, else the list), `PUT /api/flow-kv {scope, k, v, appId?}`, `DELETE /api/flow-kv?scope=&k=&appId=`. `appId` must be an app the caller owns; omitted = the caller's workspace store.
- **Runtime surface** (member-gated + `flow_run` rate limit, like flow-runs): `GET/PUT /api/app/{slug}/flow-kv`. Rows are keyed by the APP OWNER + app id, so all members share one app-wide store.
- Storage note: `app_id` is `''` (empty string, NOT NULL) for the workspace store so the UNIQUE key actually dedupes; the API maps `appId: null ↔ ''`.

## 10. Queued runs + claiming (queued → running → terminal)

Runs can be **enqueued server-side** (`status 'queued'`, `started_at NULL`) and claimed later by exactly one runtime — a browser app session or FormLogic Desktop.

```
                       reserve (default)                   PATCH complete
  event ──────────────────────────────────────► running ─────────────────► done | error | timeout | cancelled
    │                                             ▲
    │  reserve {queued:true} / server enqueue     │  POST …/claim {runtime, instanceId?}
    └───────────────────────────────► queued ─────┘  (atomic UPDATE … WHERE status='queued';
                                                      the loser of a race gets 409)
```

- **Enqueue**: `POST /api/app/{slug}/flow-runs` with `queued: true` (reserve-without-execution), or server-initiated via §11/§12. The UNIQUE idempotency key still dedupes.
- **List claimable**: `GET /api/app/{slug}/flow-runs/queued` (app runtime) / `GET /api/flow-runs/queued` (owner-wide), oldest first.
- **Claim**: `POST /api/app/{slug}/flow-runs/{runId}/claim` / `POST /api/flow-runs/{runId}/claim` with `{runtime: 'browser'|'desktop', instanceId?}`. Transitions queued→running **exactly once** — the atomic `UPDATE … WHERE status='queued'` is the gate; a second claimer gets **409**. Stamps `runtime`, `claimed_by`, `started_at`.
- **Complete**: the existing `PATCH` (app runtime or owner scope) transitions running/queued → a terminal status; double-finalize is 409. Terminal states are immutable.

## 11. `ctx.flows.run` in form scripts

`onSubmit(ctx)` scripts can trigger flows: `ctx.flows.run(slug, input?)` **records an intent** (it never executes a flow inside the sandbox) and returns `{queued: boolean, error?}` to the script. The qjs harness exposes `ctx.flows` as a host-RPC module; the PHP side (`FormLogicRuntime` → `DbContextCapture::addFlowRun`) validates and caps the intents, and `ScriptResult.flowRuns` carries them out of the sandbox.

- After the response persists, `ResponseService` calls `FlowService::enqueueScriptFlowRuns` (best-effort — a flow failure never fails a saved submission): the slug resolves **within the form's app scope first** (an enabled flow in any app containing the form), else the form owner's **workspace scope**; unknown slugs are dropped.
- Idempotency key: `script:<responseId>:<slug>` — replays AND repeated `run()` calls for the same slug dedupe to one queued run. `trigger_event` is `script.run`.
- Caps: **max 3 intents per submission** (one per slug), intent input ≤ 16 KiB.
- Editor "Test" runs (`testScript`) capture intents into the result but never enqueue; client-side previews don't execute `onSubmit` at all, so the API is safely absent there.

## 12. `form.submitted` bindings (app + standalone forms)

`app_flow_bindings` rows with `event_name 'form.submitted'` + `form_id` fire on every successful submission of that form:

- **App forms**: existing app bindings (`app_id` set) keep working; manage them under `/api/apps/{id}/flow-bindings`.
- **Standalone forms**: bindings with `app_id NULL` + `form_id` set, managed via `GET/POST /api/forms/{id}/flow-bindings` + `PUT/DELETE .../{bindingId}` (form owner only). The bound flow must be one of the owner's **workspace** flows.
- **On submission** (the real pipeline — `ResponseService::createResponse`, which the public form, app runtime, and External API all funnel through): after the response persists, every ENABLED matching binding (enabled flow too) enqueues a **queued** run. `input_snapshot` stores the raw event `{event: {name: 'form.submitted', data: {formId, responseId, answers}}}` — **inputMap selectors are resolved lazily by the executor; no user expression runs server-side**. Oversized answer sets are dropped from the snapshot (`answersTruncated: true`) to respect the 64 KiB cap.
- Idempotency key `binding:<bindingId>:<responseId>`; **max 5 bindings enqueued per submission**; best-effort (never turns a saved submission into a 500).

## 13. API-key access (FormLogic Desktop, headless)

The External API (`/api/v1`, Bearer `flk_…` keys — see `docs/API.md`) mirrors the owner-scoped surface with two new scopes:

- `flows:read` — `GET /api/v1/flows` (`?appId=`/`?workspace=1`), `GET /api/v1/flow-bindings` (`?formId=`), `GET /api/v1/flow-runs` (+ filters), `GET /api/v1/flow-runs/queued`, `GET /api/v1/flow-kv`.
- `flows:write` — `POST /api/v1/flow-runs/{runId}/claim`, `PATCH /api/v1/flow-runs/{runId}` (complete), `PUT/DELETE /api/v1/flow-kv`.

These reuse the same owner-scoped `FlowController` methods as the session routes (`ApiKeyMiddleware` sets the `userId` attribute), so a key sees exactly its owner's flows — nothing cross-tenant. FormLogic Desktop's headless loop is: poll `flow-runs/queued` → `claim {runtime:'desktop', instanceId}` → execute locally → `PATCH` the result, using `flow-kv` for durable state between runs.

## 14. Remote viewer (web as a monitor of a desktop runtime)

When the receptionist (or any desktop-resident automation) runs headless in FormLogic Desktop on a DIFFERENT machine, the web app becomes a read-only remote viewer. The Aokie SDK screens (`ui/src/components/custom-screen/aokie/`) resolve a three-state **runtime presence** (`aokiePresence.ts` + `useAokiePresence.ts`):

- **`local`** — this browser is paired to a Desktop on this machine (existing detection + pairing). Wins over everything; the live hub-event path is unchanged.
- **`remote`** — no local bridge, but the runtime is alive elsewhere. Two signals, probed in order:
  1. **Registry** (owner-visible): `GET /api/desktop-connections` has a row with `last_seen_at` fresher than **90s** (`CONNECTION_FRESH_MS`). Desktop keeps this fresh by re-upserting (POST is an upsert on `desktop_instance_id` and stamps `last_seen_at = NOW()`), so the registry doubles as a heartbeat.
  2. **Run-recency fallback** (works for the owner even when the registry is stale; degrades silently for members without run visibility): `GET /api/flow-runs?appId=…` contains a run claimed with `runtime='desktop'` within **5 min** (`RUN_SIGNAL_FRESH_MS`); `claimed_by` doubles as the device label.
- **`none`** — neither signal: the install/demo state. This is the ONLY state that shows the "Install FormLogic Desktop / Simulate incoming call" setup card (`showSimulateSetup`).

Remote-mode behaviour: the Live Call screen renders the current call + transcript from **stored records** (newest Calls row auto-selected; its Transcript Turns rows in `turn_index` order) and re-fetches them every **10s** while the tab is visible (`REMOTE_RECORDS_POLL_MS`); presence itself re-probes every **30s** (`PRESENCE_POLL_MS`). Operator controls are hidden — remote command relay is a separate roadmap item, and the connector in that browser is only the mock. All presence probes are best-effort: 401/403/404/network failures read as "no remote runtime", never as errors. Flow **bindings stay runtime-agnostic** — exactly-once execution is owned by the reserve ledger + atomic claim (§10), not by any per-binding runtime preference. Timestamps are compared with the same local-time convention the Flows panel uses for MySQL `DATETIME` strings, so presence freshness assumes web and server clocks/timezones are aligned (true for the single-server deploys this targets).

## 15. Flows workspace (first-class editor UI)

Flow authoring is a first-class console section at **`/flows`** (`ui/src/pages/flows/FlowsWorkspace.tsx`), replacing the old in-panel JSON editor. The main-shell nav swaps its "Settings" item for **Flows** (Settings moves into the header profile menu / `UserMenu`); the app-level `FlowsPanel` (`components/apps/FlowsPanel.tsx`) is slimmed to event **bindings + run history** with an "Open in Flows workspace" deep link per flow (`/flows?flow=<id>`).

- **Library** (left): workspace flows (`/api/flows`) plus app-scoped flows grouped by app (`/api/apps/{id}/flows`), with search, create (starter templates), duplicate, rename, enable/disable, delete. "New flow" creates a **workspace** flow.
- **Editor** (`components/flows/editor/`): a real React Flow graph editor (`@xyflow/react`) — `FlowCanvas` (Background/Controls/MiniMap, drag-from-palette, condition true/false handles), `NodePalette` (grouped + searchable, drag-to-add), `NodeProperties` (per-node field forms; code fields flagged "QuickJS sandboxed"), with coarse undo/redo, debounced autosave + explicit Save (dirty indicator), serializing to/from the stored `WorkflowGraph` (`flowGraph.ts`). Capabilities are auto-declared on save (a `storage_set`/`formlogic_*` node adds its required capability to `nodeCapabilities`).
- **Node catalog** (`components/flows/editor/nodeCatalog.ts`): the single typed registry driving palette + properties + validation. Its executable set is kept identical to the executor's `EXECUTABLE_NODE_TYPES` (`client-runtime/flows/nodes.ts`) by the `nodeCatalog.test.ts` parity test. The "Requires FormLogic Desktop" category (`browser_action`, `image_gen`, `stt_transcribe`, `tts_speak`) is **real + insertable** — those nodes declare `requiresDesktopService`, render a functional "Runs on FormLogic Desktop" badge, and drive a local Desktop service at run time (docs §4.3).
- **Run history + Test run** (right, lg+): per-flow history from `GET /api/flow-runs?flowId=` with status filter; the Test Run drawer executes the flow through the real v0 browser executor (`flowExecutor` + `buildWorkspaceExecutorDeps` — QuickJS sandbox, FormLogic API, connector client) on an author-supplied JSON `inputs`, and (app flows) can additionally trigger a server test-run that writes a history row.
- **Starter templates** (`components/flows/starterTemplates.ts`): blank / caller lookup / call summary / SMS auto-draft, ported from the Aokie Receptionist pack as placed canvases.
