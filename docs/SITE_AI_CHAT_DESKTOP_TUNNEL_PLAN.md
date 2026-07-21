# Site AI + Desktop Tunnel + Global Chat — Implementation Plan

Status: **DRAFT v6 for review — no code yet** · 2026-07-21
(v6: correctness review pass — crypto construction fixed, wire format + nonce/replay specified, route access control, legacy flk_ scope migration, SSE/Apache notes, cloud credit lifecycle, error taxonomy, phase dependency graph, cross-implementation test vectors)
Scope repos: `formlogic-app` (backend PHP + web UI + desktop). No aokie-repo changes required.

## Changes from v5 (review findings)

- **Crypto fix (was a real bug)**: NaCl `crypto_box` is X25519 ECDH → HSalsa20 → **XSalsa20-Poly1305**, NOT XChaCha20-Poly1305. v5 conflated them; browser (tweetnacl) and desktop (existing XChaCha20 journal code) would never have interoperated. §5.1 now specifies the exact construction both sides implement, plus wire format, nonce scheme, and replay protection.
- **Transport decision simplified**: chat uses the tunnel **always** (even when the desktop is local) — one code path; the loopback fast path stays only for the pre-existing `form.create.text` feature.
- **Access control** on request-scoped routes: only the **requesting user** may poll/stream/input a tunnel request.
- **Legacy flk_ keys** (already-linked desktops) don't carry the new `ai:relay`/`flows:relay` scopes — the scope check grandfather-accepts `connector:relay`; new links request the full set. No forced re-link.
- **Cloud credit lifecycle** made exact: preflight → decrement → run; a started run consumes the credit even on failure (honest copy). Cloud `llm_chat` double-meters `ai_messages` — documented.
- **Condition nodes on Cloud**: v1 baseline stays "typed refusal"; added a scoped v1.5 stretch (safe expression-subset evaluator in PHP).
- Added: error-code taxonomy (§5.8), phase dependency graph (§9 intro), shared cross-implementation crypto test vectors, SSE-over-Apache gotchas.

(v5: flow execution location Auto/Desktop/Cloud + unified credits. v4: flows Default AI alias. v3: model selection, queueing, E2E design.)

## 1. What was asked

1. Use the **ChatGPT/Codex subscription in FormLogic Desktop** from the site — tunneled, **E2E encrypted**, **model selection**, **request queueing**.
2. Offer **Site AI** (hosted, included in the $5/mo plan, admin-configurable allowance).
3. Easy **Settings UI** — one place that sets the default for site and flows.
4. Global **"Desktop Connection" header popover**: toggle Services, pick AI source, **restart plugins remotely**.
5. **Floating chat widget** that **creates forms/apps from chat**.
6. **Flows use the same AI sources** (incl. tunneled Codex/ChatGPT) with a switchable default.
7. **Flows choose where they execute**: tunneled to the Desktop, or in the **Cloud** against plan credits.

## 2. What already exists (do NOT rebuild)

| Capability | Where | Notes |
|---|---|---|
| Desktop AI gateway (`/api/ai/v1/*`, named `/api/ai/providers/:id/v1/*`) | `desktop/src-tauri/src/ai/gateway.rs`, routes `http.rs:4861-4928` | Credentials injected desktop-side only. |
| **ChatGPT/Codex OAuth provider** (`openai-codex-agent`) | `desktop/src-tauri/src/ai/codex.rs` | ChatGPT subscription; local model list; `assistant.chat` exists. |
| Website → Desktop AI over loopback | `ui/src/lib/websiteAiRouting.ts`, `desktopFormGeneration.ts`, `POST /api/service-capability` | Paired origin + capability; local-only today; **kept as-is for `form.create.text` only**. |
| **Two flow runners** | browser: `ui/src/client-runtime/flows/nodes.ts` + `flowDispatcher.ts`; desktop Rust: `desktop/src-tauri/src/flows/runner.rs` + `dispatcher.rs` | **No PHP flow runner exists** — cloud execution is new (§5.7). |
| Browser-local provider registry + `AiServicesDialog` | `ui/src/client-runtime/flows/aiProviders.ts`, `components/flows/AiServicesDialog.tsx` | The "custom AI" option. |
| Relay channel web → desktop | `backend/src/Services/DesktopCommandService.php`, `desktop_commands`, poller `flows/dispatcher.rs:2984` + `flows/relay.rs` | Exactly-once claim, targeting, idempotency. Limits: 16 KiB/64 KiB, 60 s TTL, plaintext at rest, connector-commands only. |
| Server-minted capability tokens | `ConnectorCommandController::mintCapability` ↔ desktop `resolve_capability_grants` | Pattern the chat-tool grant reuses. |
| Presence tri-state | `useFlowsDesktopPresence.ts`, `connector/runtimePresence.ts` | 90 s heartbeat via `desktop_connections`. |
| Hosted "Site AI" generators | `backend/src/Services/AIService.php` + `AIController.php` | Single env-configured upstream; no chat endpoint, no plan coupling yet. |
| Plans/billing | `PlanService.php`, `BillingController.php`, `pages/Billing.tsx` | `users.plan`, `cloud_until`, PayPal; enforcement config-gated (`planEnforced`). |
| **MCP tool catalog** (26 tools) | `backend/src/Controllers/McpController.php:1154-1184` | Becomes the shared `ChatToolsService`. |
| Services supervision | `desktop/src-tauri/src/services/`, `http.rs:4805+` | No web services panel yet. |
| Plugin lifecycle routes | `desktop/src-tauri/src/http.rs` `/api/plugins/:id/*` | No relay route for lifecycle; `desktopClient` lacks restart wrappers. |
| Crypto precedent | desktop `journal_crypto.rs` (XChaCha20-Poly1305, OS-credential keys), native-runtime TOFU pinning | Note: journal crypto is **not** wire-compatible with NaCl box — see §5.1. |
| UI primitives | `ui/src/components/ui/*` | No Popover/draggable; `framer-motion` 12 + `@dnd-kit/core` already in `package.json`. |

## 3. Decisions locked

1. **Multi-user, one desktop**: per-user AI source setting; every account member may use the tunnel. **Single-flight FIFO queue per desktop per lane** (AI lane: per-user ≤ 2, total ≤ 8; flow lane: per-user ≤ 2, total ≤ 4).
2. **Site AI**: included in the $5/mo cloud plan; allowance **seeded 500 messages/month**, admin-editable; over-allowance → typed refusal + upgrade copy. Enforcement rides the existing `planEnforced` config gate (self-hosted/off = unlimited).
3. **Chat tools**: additive/read execute **immediately** by default; per-user **Auto / Confirm** toggle; Confirm approves **per tool call**; destructive tools excluded v1.
4. **Desktop targeting**: connector-assignment pin → implicit single fresh desktop → 409 `ambiguous_desktop` (unchanged).
5. **E2E**: yes, via desktop-side tool execution (§5.4).
6. **Popover**: shown to **all** signed-in users; degrades gracefully.
7. **Model selection**: Settings → AI picks provider + model for the desktop source.
8. **Flow AI default**: nodes at "Default" follow Settings → AI; desktop-executed flows use the **account owner's** setting.
9. **Flow execution location**: per-flow **Auto / Desktop / Cloud**; cloud runs consume **plan credits** (seed 100/month, admin-editable); desktop/browser runs unmetered (recorded for visibility).
10. **Chat transport**: tunnel **always** (uniform path, even when local); loopback kept only for the pre-existing `form.create.text` feature.

## 4. Architecture (target state)

```
┌─ Browser (any device) ───────────────────────────────────────────┐
│ Header [Desktop Connection ●] popover   Floating chat widget      │
│ Flow editor: Run on [Auto|Desktop|Cloud]  AI node: [Default|…]    │
│  sealed envelope (X25519 + NaCl box) ─┐  ┌─ plain HTTPS ─┐        │
└──────────────────────────────────────┼──┼───────────────┼─────────┘
                                       ▼  ▼               ▼
┌─ FormLogic backend (PHP) ────────────────────────────────────────┐
│  /api/desktop/ai/*     E2E relay (AI): sealed envelopes, FIFO     │
│  /api/desktop/flows/*  E2E relay (flow runs): own queue lane      │
│  CloudFlowRunner       NEW bounded PHP flow runner — metered      │
│  /api/desktop/ops/*    service/plugin lifecycle (account-scoped)  │
│  /api/ai/chat-tools/*  tool catalog + execute (grant-token auth)  │
│  /api/ai/chat          hosted Site AI chat (also default flow LLM)│
│  ChatToolsService      shared tool handlers (extracted from MCP)  │
└────▲───────────────────────────────────────────┬─────────────────┘
     │ flk_ key (ai:relay / flows:relay,          │ flk_ key + per-user
     │  connector:relay grandfathered)            │ chat-tool grant
┌────┴───────────────────────────────────────────▼─────────────────┐
│ FormLogic Desktop                                                 │
│  AI relay poller → decrypt → local AI gateway → tool loop (chat)  │
│  flow-run poller → decrypt → flows/runner.rs → progress frames    │
│  ops poller → services/plugins managers                           │
│  ChatGPT OAuth + API keys + E2E private key never leave desktop   │
└───────────────────────────────────────────────────────────────────┘
```

Standing principles: credentials never cross the backend; explicit source/location, terminal failure (no silent fallback); demo stays read-only.

## 5. Design

### 5.1 E2E envelope — exact construction

- **Construction**: NaCl-compatible `crypto_box` — X25519 ECDH → HSalsa20 key derivation → **XSalsa20-Poly1305** authenticated encryption. Browser: `tweetnacl.box` (pure JS, works on the non-secure dev origin where WebCrypto is unavailable). Desktop: the Rust **`crypto_box` crate** (guaranteed tweetnacl-interop; the existing `journal_crypto.rs` XChaCha20 code is at-rest-only and stays untouched). Interop is locked by **shared test vectors** (`docs/contracts/e2e-envelope-vectors.json`): one browser-side vitest and one Rust test each seal/open the same plaintext with the same keys/nonces and must match byte-for-byte.
- **Keys**: desktop long-term X25519 identity, private key in the OS credential store (`secrets.rs`), public key published via flk_-authed `POST /api/v1/desktop-ai/pubkey` on boot when absent. Browser: **per-thread ephemeral** X25519 keypair (never persisted).
- **TOFU pinning**: browser pins `desktop_instance_id → pubkey` in localStorage (`formlogic-desktop-e2e-pins`); first trust shows the desktop device name + key fingerprint; a changed key → explicit re-trust prompt, never silent.
- **Wire format** (what the backend stores/relays):
  - Request row plaintext fields: `request_id, target_instance_id, requesting_user_id, kind, provider_id, eph_pub (32B, b64)` — routing needs them; everything sensitive is in the sealed body.
  - Sealed body (JSON before sealing): `{v:1, model?, threadId?, messages[]?, flowId?, inputs?, toolMode?, toolGrant?, clientSeq}`.
  - Frame blob: `{nonce (24B b64), ct}`.
- **Nonce scheme**: 24-byte nonces; byte 0 = direction (`0x00` browser→desktop, `0x01` desktop→browser), bytes 1..23 = big-endian counter. Request envelope uses counter 0; each subsequent frame increments. Desktop rejects a counter ≤ last-seen per thread (replay protection); counters live only in memory, thread lifetime ≤ TTL.

### 5.2 Queueing

- Two **independent single-flight lanes** per desktop: `ai` and `flow` — a long flow run never blocks chat.
- Status: `pending → claimed|streaming → done|failed|expired`.
- **Single-flight per lane**: atomic claim `UPDATE … oldest pending for target+lane … AND NOT EXISTS (claimed/streaming sibling in lane)`; desktop also only polls a lane when idle.
- **Caps** — AI lane: per-user ≤ 2 (`queue_full_user`), per-desktop ≤ 8 (`queue_full_desktop`), TTL 5 min, envelope ≤ 256 KiB, frames ≤ 4 MiB. Flow lane: per-user ≤ 2, per-desktop ≤ 4, TTL 15 min, envelope ≤ 256 KiB, result ≤ 1 MiB.
- **Position**: computed at read time (count of pending ahead for the same target+lane), never stored.

### 5.3 Ops relay (services/plugins lifecycle)

- Account-scoped `POST /api/desktop/ops` + `GET /api/desktop/ops/{id}` inserting into `desktop_commands` with reserved `connector_id='desktop'`. List: any member. Lifecycle: connector-assignment permission.
- Desktop `flows/relay.rs::process_one` intercepts `connector_id=='desktop'` before `connectors::dispatch` → shared handlers extracted from `http.rs` into `desktop_ops.rs`.

### 5.4 Chat with E2E tool use

- **Tool loop in the Desktop** (`ai/chat_agent.rs`): model → tool_call → execute → feed back; ≤ 6 rounds, bounded.
- **Transport: tunnel always** (decision 10) — uniform code path; no special local chat route.
- **ChatToolsService** (backend): MCP implementations extracted from `McpController.php`; handlers take an explicit user-context + permission check so both MCP (OAuth scopes) and chat (session user / grant user) enforce correctly. MCP routes re-pointed, behavior unchanged. v1 chat subset (additive/read): `list_apps`, `list_forms`, `get_form`, `create_app`, `create_app_form`, `create_form`, `update_form` (non-destructive), `add_form_to_app`, `create_flow`, `list_responses`.
- **Grant**: browser mints a 10-min token via `POST /api/ai/chat-tool-grant` (bound to user + desktop instance + `ai:chat-tools` scope), sent **inside the sealed envelope**, one per turn. Desktop presents it to `POST /api/ai/chat-tools/execute`; backend verifies (mint/introspect pair) **and** that the grant's bound instance matches the flk_ key's desktop connection; executes **as the granting user**; audit-logged.
- **Catalog**: `GET /api/ai/chat-tools/catalog`; desktop fetches+caches.
- **Confirm mode**: sealed `tool_proposal` frame → browser approve/deny card → sealed inbound frame `POST /api/desktop/ai/requests/{id}/input`; desktop polls `GET /api/v1/desktop-ai/{id}/input?since=` while paused (120 s → auto-deny).
- **Hosted path**: `POST /api/ai/chat` runs the same loop server-side as the session user (non-E2E, badged).

### 5.5 Model selection

- Settings → AI: provider + **model** dropdowns. Catalog: local `/api/ai/v1/models` when loopback-present; remote via tunnel `kind=models`; 5-min cache; **free-text fallback** (desktop validates anyway).
- `user_ai_settings.desktop_model` (nullable = provider default). Unknown model → typed `model_unavailable`, never substituted.

### 5.6 Flows integration ("Default" AI alias)

Node picker gains **"Default (from Settings)"** (top option, shows resolved source). `node.data.provider`: absent/`'default'` → resolve; `'provider:<id>'` → explicit desktop provider (fail closed); `'local:<id>'` → browser-local registry.

| Runner | Resolution of `default` |
|---|---|
| Browser (`nodes.ts`/`flowDispatcher.ts`) | Acting user's cached `user_ai_settings`: `site` → `POST /api/ai/chat` (allowance-metered); `desktop` → tunnel `kind:'chat'` (settings provider+model, no tools); `custom` → browser-local registry. |
| Desktop (`flows/runner.rs`) | **Account owner's** settings from `GET /api/v1/ai/preferences` (flk_), disk-cached (offline last-known; missing → typed `ai_default_unresolved`). `site`/`custom` → backend `/api/ai/chat` over flk_ (metered to owner); `desktop` → local gateway with owner provider+model. |

- **Metering**: default-source flow LLM calls recorded in `usage_meter`; `site` decrements the allowance; explicit-provider calls recorded, not allowance-limited v1.
- **No silent fallback**: unresolvable source → typed node error, never a source hop.
- v1 scope: `llm_chat` only. Custom source caveat: custom provider definitions live in one browser's localStorage — on another browser the custom source is unresolvable → typed error + prompt to reconfigure (honest, not silently hosted).

### 5.7 Flow execution location (Auto / Desktop / Cloud)

**Per-flow setting** `flow_definitions.execution_location ENUM('auto','desktop','cloud') DEFAULT 'auto'` in the flow editor header ("Run on: Auto / Desktop / Cloud"). Every `flow_run_logs` row records the as-executed location (`browser|desktop|cloud`).

- **Auto** — exactly today's behavior (manual runs in browser; event-bound runs on a fresh heartbeating desktop). Zero behavior change.
- **Desktop (tunneled)** — site-initiated runs via a **new E2E relay lane**:
  - `desktop_flow_runs` (routing plaintext: id, owner, requesting user, target, flow_id, status, expiry; sealed body: inputs + context; sealed result ≤ 1 MiB) + `desktop_flow_run_frames` (sealed progress).
  - Web routes mirror the AI relay: `POST /api/desktop/flows/run`, `GET …/{id}` (live `queue_pos`), `GET …/{id}/stream`.
  - Desktop v1 routes (flk_ + `flows:relay`): `GET /api/v1/desktop-flows/pending`, `POST …/{id}/claim|frames|complete`.
  - Executes in the **existing Rust runner** — full node support (connectors, JS logic, local AI). Desktop offline → queued until TTL; UI shows position; user-cancelable.
  - **Unmetered** (recorded for visibility). Event-driven desktop runs are unaffected (they don't ride this lane).
- **Cloud** — new bounded PHP runner (`CloudFlowRunner.php`):
  - **v1 node subset**: trigger/input mapping, record nodes (list/get/create/update via `ResponseService` — structured filters incl. `phone_eq` are server-side already), loop/join, output, `llm_chat` (Site AI, **also decrements `ai_messages`** — double-metering is deliberate and shown in copy), HTTP/webhook (egress-allow-listed), `connector_request` only via the desktop command relay (typed failure if no desktop linked).
  - **JS logic blocks / JS condition nodes: NOT cloud-executable in v1.** Preflight validator `validateCloudEligible(flow)` returns typed `cloud_unsupported_node[]` naming offenders; runs at **save time** (editor warning + Cloud option disabled with reason) and again at **run time before any credit is touched**.
  - **v1.5 stretch**: safe expression-subset evaluator in PHP for emitted condition expressions (literals, `$inputs`/`$nodes` paths, comparisons, `&&`/`||`/`!`, ternary — a small recursive-descent evaluator, no functions/assignments). Only if Phase 5 lands early; otherwise v2.
  - **Credit lifecycle**: preflight → check allowance → decrement → run. A started run consumes the credit even on failure (copy says so); preflight failures never consume. Sub-flow runs count once per started run. Bound: 60 s wall clock, node/iteration caps.
  - `flow_run_logs.execution_location='cloud'`; same row shape as desktop runs.
- **Browser** stays the implicit free location under Auto (not a selectable option).

**UI**: editor header dropdown; run dialog shows queue position (desktop) / credit deduction (cloud); run history shows location; Settings → Flows note (per-flow wins); popover shows both queue lanes' depth.

### 5.8 Error taxonomy (typed codes the UI renders honestly)

`queue_full_user`, `queue_full_desktop`, `desktop_offline`, `ambiguous_desktop`, `e2e_key_unknown`, `e2e_key_rotated` (triggers re-trust prompt), `sealed_envelope_invalid`, `provider_unavailable`, `model_unavailable`, `grant_expired`, `grant_instance_mismatch`, `ai_allowance_exceeded`, `flow_credits_exceeded`, `cloud_unsupported_node`, `ai_default_unresolved`, `uncertain` (claimed-but-unreported relay outcome). Each maps to a specific UI string + recovery action (retry, re-trust, reconfigure, upgrade).

## 6. Data model (new/changed)

| Table | Phase | Key columns |
|---|---|---|
| `desktop_ai_requests` | 1 | id, owner_user_id, requesting_user_id, target_instance_id, provider_id, kind, eph_pub, envelope BLOB, status, idempotency_key UNIQUE, expires_at, claimed_by, timestamps |
| `desktop_ai_frames` | 1 | request_id, seq, direction(out\|in), envelope BLOB, created |
| `desktop_connections` | 1 | + `e2e_public_key` |
| `plan_allowances` | 2/5 | plan, metric(`ai_messages`\|`cloud_flow_runs`), monthly_value, enabled |
| `usage_meter` | 2/5 | user_id, metric, count, tokens_in/out (AI only), period (`YYYY-MM`, UTC) |
| `user_ai_settings` | 2 | user_id, ai_source(site\|desktop\|custom), desktop_provider_id, desktop_model, custom_provider_id, chat_tool_mode(auto\|confirm) |
| `flow_definitions` | 5 | + `execution_location` ENUM('auto','desktop','cloud') DEFAULT 'auto' |
| `flow_run_logs` | 5 | + `execution_location` (as-executed: browser\|desktop\|cloud) |
| `desktop_flow_runs` + `desktop_flow_run_frames` | 5 | flow-run relay lane (§5.7) |
| `chat_tool_grants` | 6 | hash, user_id, desktop_instance_id, scope, expires_at |

## 7. Security & privacy model

- **E2E (desktop source / desktop flow runs)**: per §5.1. Backend stores/relays only sealed bodies + routing metadata, **purged at completion**. TOFU + rotation prompt. Replay protection via per-thread monotonic nonces.
- **Backend can see (deliberately)**: routing metadata (user, instance, kind, sizes, timing, queue depth), **cloud-run flow content** (server-executed by definition), and **tool effects** (audited writes). Chat/desktop-run content: never.
- **Hosted Site AI / Cloud runs** are server-processed; UI badges the difference ("Private — end-to-end encrypted to your Desktop" vs "Hosted — processed by FormLogic Cloud"; cloud flow runs show "Runs on FormLogic Cloud — uses plan credits").
- **In transit**: HTTPS in production; dev box plain HTTP (E2E still protects desktop-bound content; documented).
- **Authorization**: web enqueue/poll/stream/input = session + **requesting-user match** + rate limit (AI: 30/min/user; cloud runs: 10/min/user) + entitlement/credits; desktop polling = flk_ + `ai:relay`/`flows:relay` (**or grandfathered `connector:relay`** — existing linked desktops keep working; new links request the full scope set); provider/model validated desktop-side, fail-closed.
- **Chat history client-side only in v1** (IndexedDB `formlogic-chat:<userId>`; sealing on non-secure origins = hardening, not a boundary). No server-side transcripts.
- Grants TTL 10 min + instance binding; demo read-only; all tool executions audit-logged.

## 8. Rollout & compatibility

- Phases ship independently behind flags (`features.desktopAiTunnel`, `features.siteChat`, `features.cloudFlowRunner`).
- Loopback desktop-AI (`form.create.text`) and current flow execution keep working; `execution_location` defaults to `auto` = byte-for-byte current behavior; legacy flk_ keys keep working via scope grandfathering.
- v1 accepted limitations: chat history doesn't roam browsers; strict FIFO; Site AI quota = messages/month; `default` alias covers `llm_chat` only; cloud runner has no JS logic/conditions (typed refusal).
- Docs updated per phase: `WEBSITE_AI_DESKTOP_ROUTING.md`, `AI_GATEWAY.md`, `API.md`, `docs/MCP.md`, `docs/contracts/e2e-envelope-vectors.json` (new), `AGENTS.md` session notes.

## 9. Implementation steps (detailed)

**Dependency graph**: P1 (tunnel) → P2 (Site AI + settings) → {P3 (popover), P4 (flow default), P5 (execution location, needs P2's allowances + P1's relay pattern), P6 (chat, needs P1+P2)}. P3/P4/P5/P6 are mutually independent once P1+P2 land.

### Phase 1 — E2E tunnel + queue

Backend:
1. Migration: `desktop_ai_requests`, `desktop_ai_frames`; `ALTER desktop_connections ADD e2e_public_key VARCHAR(88) NULL` (schema.sql + UpgradeService).
2. `DesktopAiRelayService.php` — mirror `DesktopCommandService`: `enqueue()` (reserve-first, caps, typed `queue_full_user|queue_full_desktop`), `pollPending()`, `claim()` (atomic single-flight per §5.2), `appendFrame()`, `appendInput()`, `fetchInput(since)`, `complete()` (claimant-bound, purges envelope+frames), `expireStale()`, `queuePosition()` at read.
3. `DesktopAiRelayController.php` + routes (web side: session + throttle + **requesting-user match** on `{id}` routes): `POST /api/desktop/ai/requests`, `GET …/{id}`, `GET …/{id}/stream`, `POST …/{id}/input`, `GET /api/desktop/ai/pubkey?instanceId=`. Desktop side (flk_ + scope per §7): `POST /api/v1/desktop-ai/pubkey`, `GET …/pending?instanceId=&wait=25000`, `POST …/{id}/claim`, `POST …/{id}/frames`, `GET …/{id}/input?since=`, `POST …/{id}/complete`.
   - SSE-over-Apache notes (apply to all `/stream` routes): disable output buffering + gzip for the route, send `X-Accel-Buffering: no`, heartbeat comment every 15 s — reuse the `AokieCompanionRelayController` SSE pattern exactly.
4. `DesktopAiRelayTest.php`: claim race, FIFO, caps, TTL, purge, scope (new + grandfathered), requesting-user enforcement, SSE auth.

Desktop:
5. `ai/e2e.rs` — identity via `secrets.rs`; publish pubkey on boot; `crypto_box`-based `open_envelope()`/`seal_frame()`; per-thread session cache (peer eph pub → shared key, last-seen counters per direction).
6. `ai/relay_poller.rs` — poll-when-idle → claim → open → dispatch provider+model to in-process `ai/gateway.rs` → seal deltas → complete; `429 codex_busy` backoff reused; fail-closed validation.
7. Rust tests: vectors from `docs/contracts/e2e-envelope-vectors.json`, round-trip, wrong-key, replay (reused counter rejected), unknown model/provider, single in-flight.

Web:
8. `npm i tweetnacl @types/tweetnacl`.
9. `client-runtime/desktop/desktopTunnel.ts` — eph keys per thread, TOFU pins + rotation state, seal/open, enqueue + fetch-SSE reader; states `queued(pos) → streaming → done | failed(code) | uncertain`.
10. vitest: same shared vectors, state machine, TOFU rotation, queue rendering.
11. Docs: `WEBSITE_AI_DESKTOP_ROUTING.md`, `AI_GATEWAY.md`, `API.md`, vectors file.
12. **Gate**: suites green; live E2E with loopback desktop stopped: enqueue → queued → streamed Codex answer.

### Phase 2 — Site AI + Settings (incl. model selection)

Backend:
1. Migration: `plan_allowances` (seed `ai_messages`: cloud 500/mo enabled, free disabled, enterprise unlimited — verify plan slugs against `PlanService.php`), `usage_meter`, `user_ai_settings`.
2. `AIService::chat(messages, tools?, stream?)` + `POST /api/ai/chat` (allowance-checked, metered, SSE per the §9-P1 SSE notes).
3. `PlanService::allowance(plan, metric)`; typed `ai_allowance_exceeded`; monthly rollover = `usage_meter.period = UTC YYYY-MM` (new month = fresh counter, no reset job needed).
4. `GET/PUT /api/ai/preferences`; `GET /api/v1/ai/preferences` (flk_, owner settings).
5. Admin: `GET/PUT /api/admin/allowances` (audited).

Web:
6. `components/settings/AiSourceCard.tsx` + Settings section: source radio + live usage, provider + model dropdowns (5-min cache, free-text fallback), chat tool mode toggle, `AiServicesDialog` link, "Default flows use this too" copy. Demo: read-only.
7. `websiteAiRouting.ts` v2 + matrix test.
8. `pages/Billing.tsx`: usage rows per metric.
9. Admin `AdminPlatform` "AI & credits allowances" card.
10. **Gate**: PHPUnit (allowance math + rollover, admin audit, preferences, v1 prefs auth), vitest (routing v2, card), manual flip-and-verify.

### Phase 3 — Global Desktop Connection popover

1. `DesktopOpsController.php`: `POST /api/desktop/ops` + `GET …/{id}` (allow-listed ops; member vs lifecycle perm), via `DesktopCommandService::enqueue` with `connector_id='desktop'`.
2. Desktop: shared handlers extracted from `http.rs` → `desktop_ops.rs`; intercept in `flows/relay.rs::process_one`.
3. `desktopClient.ts`: `services.start/stop/restart/repair`, `plugins.restart/enable/disable`.
4. `components/ui/Popover.tsx`; `components/desktop/DesktopConnectionPopover.tsx` (presence, services toggles, plugin restart, AI-source quick-switch, both queue lanes' depth, deep links); trigger in `AppShell.tsx`; demo/no-desktop states.
5. **Gate**: vitest, Rust interception tests, live E2E service+plugin restart local & remote.

### Phase 4 — Flows "Default" AI alias + tunneled flow LLM

1. `client-runtime/flows/aiDefault.ts` — cached settings resolution per §5.6; typed failures into node error output.
2. `nodes.ts` `llm_chat` resolution order + editor picker "Default (from Settings)" with resolved-source label.
3. Metering hooks (chat route records site-source usage; tunnel route records desktop-source usage).
4. Desktop `ai/default_prefs.rs` (heartbeat-cadence fetch, disk cache, offline last-known) + `flows/runner.rs` `llm_chat` default resolution.
5. **Gate**: vitest resolution matrix, Rust cache/dispatch tests; live E2E: default flow on Site AI → flip to Codex → rerun via tunnel → flip back.

### Phase 5 — Flow execution location (Auto / Desktop / Cloud)

Backend:
1. Migration: `flow_definitions.execution_location`, `flow_run_logs.execution_location`, `desktop_flow_runs` + `desktop_flow_run_frames`, `plan_allowances` seed `cloud_flow_runs` (cloud 100/mo).
2. `DesktopFlowRelayService.php` + controller + routes (mirrors Phase 1; `flows:relay` scope).
3. `CloudFlowRunner.php`: v1 subset per §5.7; `validateCloudEligible(flow)` preflight (save-time + run-time); credit lifecycle per §5.7; 60 s bound; `flow_run_logs` rows.
4. Run dispatcher honors `execution_location`: auto → current; desktop → relay enqueue; cloud → CloudFlowRunner.

Desktop:
5. Flow-lane poller: claim → open → existing `flows/runner.rs` → sealed progress frames → sealed result.

Web:
6. Editor "Run on" dropdown (cloud option shows credit cost; disabled with offending-node list when preflight fails); run dialog queue position / credit deduction; run history location column.
7. **Gate**: PHPUnit (preflight per node type, credit lifecycle, lane single-flight), Rust (flow lane), vitest (editor states), live E2E: same flow Auto (browser) / Desktop (tunneled from a second device) / Cloud (credit decrements, log shows `cloud`).

### Phase 6 — Floating Site Chat (E2E tool use)

Backend:
1. Extract `ChatToolsService` from `McpController.php` (user-context + permission explicit; MCP tests must stay green).
2. `GET /api/ai/chat-tools/catalog`; `POST /api/ai/chat-tool-grant`; `POST /api/ai/chat-tools/execute` (grant + instance-binding verified, audited).
3. Hosted tool loop in `POST /api/ai/chat` (≤ 6 rounds, SSE, metered).

Desktop:
4. `ai/chat_agent.rs`: tool loop, catalog cache, confirm-mode pause/resume (120 s auto-deny), rounds cap 6.

Web:
5. `components/chat/SiteChatWidget.tsx` in `AppShell.tsx`: framer-motion drag (viewport-clamped), minimize, `uiStore` persistence, `generateId()`, mobile BottomSheet, z-index under banners.
6. IndexedDB chat store `formlogic-chat:<userId>`.
7. Rendering: streamed deltas, tool action cards with deep links, confirm-mode approve/deny cards, per-source privacy badge, Auto/Confirm toggle.
8. **Gate**: PHPUnit (grants, scopes, demo 403, audit, MCP regression), Rust (rounds cap, pause/resume, grant expiry), vitest (widget), live E2E: "create a contact form with name, email, message" on Codex → opens in builder; repeat in Confirm mode.

## 10. Self-review log — issues found & resolved (cumulative)

1. Confirm mode had no return channel → inbound frame channel (120 s auto-deny).
2. Grant expiry mid-conversation → one grant per turn.
3. Ops relay abused app scoping → account-scoped `/api/desktop/ops`.
4. Stored queue positions go stale → computed at read time.
5. Model substitution risk → typed `model_unavailable`.
6. Model catalog unreachable remotely → tunnel `kind=models` + cache + free-text fallback.
7. Non-secure dev origin → bundled tweetnacl; IndexedDB sealing = hardening-not-boundary.
8. Attestation over-engineering → dropped (flk_-authed publish + browser TOFU).
9. Desktop runner can't know a browser user's `default` → owner's settings, flk_-fetched, disk-cached.
10. Default-flip changing flows implicitly → editor shows resolved source; typed failures, no source hops.
11. Long flow runs blocking chat → two independent relay lanes.
12. Cloud runner vs JavaScript → bounded PHP-native subset + preflight validator (v1.5 stretch: expression-subset evaluator).
13. Two parallel metering systems → unified `plan_allowances`/`usage_meter` with a metric dimension.
14. **(v6) Crypto construction mismatch**: NaCl box = XSalsa20-Poly1305, not XChaCha20 — exact construction + shared cross-implementation test vectors now specified (§5.1).
15. **(v6) Envelope chicken-and-egg**: desktop needs the browser's ephemeral pubkey *outside* the sealed body to derive the shared key → plaintext `eph_pub` field in the wire format (§5.1); nonces directional + monotonic with replay rejection.
16. **(v6) Chat transport fork**: local-vs-remote chat would have been two code paths (and a second desktop chat surface) → tunnel always (decision 10).
17. **(v6) Legacy flk_ keys lack new scopes** → `connector:relay` grandfathered on the new relay endpoints; new links request the full set (§7). No forced re-link.
18. **(v6) Request-scoped route access**: poll/stream/input restricted to the requesting user (§7) — account members can't read each other's request metadata.
19. **(v6) Cloud credit ambiguity**: preflight → decrement → run; started = consumed; cloud `llm_chat` also decrements `ai_messages` (documented, shown in copy).
20. **(v6) SSE on Apache/PHP**: buffering/gzip must be disabled per route + heartbeat comments — reuse the companion-relay SSE pattern (§9-P1).

## 11. Remaining notes (no open blockers)

- Seed allowances: 500 AI messages/month + 100 cloud flow runs/month on the cloud plan (admin-editable).
- Popover for all users; graceful degradation (Phase 3 step 4).
- Confirm mode: per-tool-call approval; batch approval later.
- v2 candidates: site STT/TTS, roaming (user-key-sealed) chat history, sandboxed-JS cloud runner (or the v1.5 expression subset), priority queueing, batch tool approval.
