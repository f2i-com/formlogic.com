# OpenAI services in FormLogic Desktop

Status: first implementation slice (2026-07-20)

FormLogic exposes two deliberately separate OpenAI service definitions.

## OpenAI API

Use this connection for generic chat inference through Desktop, the paired
website bridge, and optionally Aokie calls.

1. Open **Service Center** in FormLogic Desktop.
2. Add an AI provider and choose **OpenAI API**.
3. Enter an OpenAI Platform API key. Desktop stores it in the operating-system
   credential store; the key is never returned to a website, flow, plugin, log,
   export, or service catalog response.
4. Select capabilities, a category, tags, an optional default model, and test
   the endpoint.

OpenAI API usage is billed through the customer's OpenAI Platform account and
is separate from a ChatGPT subscription. Compatible and custom endpoints can
use a different base URL, chat path, restricted JSON request template, response
path, and custom headers. Credential placeholders are allowed only in headers
(`{{apiKey}}`), never in a request body.

A paired same-machine FormLogic website can call Desktop's normalized
`/api/ai/v1/chat/completions` route, including bounded SSE streaming. Every
model-list or inference request needs both the exact-origin Desktop pairing and
a short-lived server-minted capability containing only the exact
`service.openai-api.*` actions used by the current pilot. Desktop then chooses
the configured provider and injects its credential after authorization. These
pilot grants are action-exact but not yet bound to one persisted provider
connection, so access is owner-only until `ServiceBinding` policy lands.

## OpenAI Codex Agent — Sign in with ChatGPT

Use this connection for delegated FormLogic assistant work, such as discussing
forms, apps, and flows. It can also be selected as an explicitly experimental,
text-only LLM for Aokie calls. It is not an OpenAI API key or an OpenAI
Realtime voice connection.

1. Install the compatible Codex runtime (the pilot accepts exactly the tested
   `codex-cli 0.124.0` executable).
2. Open the Codex card in **Service Center** and choose **Sign in with ChatGPT**.
3. Finish the browser or device-code ceremony. Login, cancel, and logout are
   Desktop-owner operations and are not exposed to paired websites.
4. After connection, **Try assistant** loads the account's current models and
   reasoning options dynamically. A returned thread can be continued or reset.
   On the live-tested `gpt-5.5` route, **Off (fastest)** requests no extended
   reasoning; Low and the model's other advertised levels remain optional.

Desktop runs `codex app-server` as a managed child with a dedicated
`CODEX_HOME`, ChatGPT-only authentication, no inherited API/access tokens or
endpoint overrides, no filesystem access, no approvals, and no agent/tool
network access. On Windows, Desktop uses a fresh, versioned profile directory,
atomically applies a protected DACL granting full control only to its owner,
SYSTEM, and local Administrators, and enables and verifies EFS before Codex can
create `auth.json`. The prior profile is left untouched. The OAuth file remains
logically plaintext to those authorized processes but is encrypted on disk;
Desktop reports this as **OAuth file encrypted by Windows EFS** and blocks
startup or account use if the protection cannot be verified. Non-Windows builds
retain Codex's operating-system keyring mode. The prompt and response
still travel to OpenAI; thread history remains in the dedicated local Codex
profile. Raw OAuth tokens and raw App Server events never cross the Desktop API.
The child receives a minimal OS-only environment and an absolute executable
from the recognized Codex package (or an explicitly trusted operator path).
The pilot permits one live turn at a time, at most 6 starts/minute, 60/hour, and 200/day
per Desktop process; disconnected or incomplete turns are interrupted, with a
managed-child restart as the fail-closed fallback.

Paired website reads and agent turns require both the exact-origin Desktop
pairing token and a short-lived server-minted FormLogic owner capability. The
capability contains only the exact Codex status, model-list, and assistant-turn
grants; neither those grants nor the OpenAI API grants authorize connectors,
flows, another service, or an owner wildcard. Turn interruption remains
Desktop/server-only until invocation ownership is bound to a principal.

The website client obtains an app-scoped capability for an active app owner, or
an account/workspace capability when no app exists yet. Cold concurrent calls
share one mint request, cached authority is cleared on every session/context
assignment, and a response crossing a logout/login epoch is discarded.

The Form Builder's **Create with AI** prompt tab can explicitly select one
enabled Desktop OpenAI-compatible provider for a new, standalone form. The
provider id and model are pinned for the request, output is parsed through a
strict fields-only schema, and there is no default-provider fallback. Existing
form editing, document/photo input, App generation, and executable logic or
script generation remain on the hosted path. The Codex/ChatGPT subscription
service is not exposed as this generic form-generation provider.

## Aokie behavior

Aokie continues to use the existing OpenAI-compatible Desktop gateway. For
public providers, Desktop strips local llama.cpp-only request fields before
egress. Aokie's exact one-token prefix warm-up is answered locally and never
sent to a billable cloud provider. API keys remain Desktop-held.

When ChatGPT sign-in is connected, the Aokie **Reply model (LLM)** picker also
offers two experimental delegated-agent sources:

- **ChatGPT/Codex — reasoning off (fastest)**
- **ChatGPT/Codex — low reasoning**

Both use the live-tested `gpt-5.5` route. Each call turn is text-only,
ephemeral, bounded, and runs with files, tools, approvals, and agent network
access disabled. Aokie's existing STT and TTS lanes still hear and speak. Raw
caller audio is refused on the Codex lane, the warm-up request is answered
locally, and a saved local-model name is replaced with `gpt-5.5` when the
source is selected. The call adapter is turn-based and may be slower or busier
than a production inference or Realtime service, so Aokie labels it
experimental and preserves its normal failure handling. A call turn is stopped
after nine seconds so Aokie can fail over before its ten-second first-response
watchdog expires.

The two gateway paths are reserved for the delegated service and cannot be
shadowed by a user-created API provider. A paired website's OpenAI API grant
does not authorize them; Aokie's per-install inference credential and renewed
destination consent are required.

## Not in this slice

- A hosted remote service-job relay for a website that is not on the Desktop's
  machine.
- Delegation of service actions to non-owner app roles, plus durable
  `ServiceBinding` selection and policy. The pilot issuer is intentionally
  owner-only and uses an immutable service/action allow-list.
- A fully persisted `ServiceConnection`/`ServiceBinding` migration and binding
  picker; existing service/provider stores remain compatible projections.
- Desktop-provider editing of existing forms, document/photo input, App
  generation, and executable form-logic generation. Only a new standalone
  fields-only Form can currently use the explicit Desktop provider picker;
  these richer operations remain on their existing hosted generation APIs.
- Migration of Flow `llm_chat` nodes from their existing local-service,
  browser-profile, or app-AI URL choices to stable `ServiceBinding` records.
- A generic multi-action visual mapping runtime. The v3 definition contract can
  describe multiple actions, while the editable custom provider runtime is
  currently limited to its chat action.
- Bundling/pinning Codex in the Desktop installer or cross-platform credential
  storage GA claims.

Architecture and trust decisions are recorded in
[`ADR-009`](../adr/ADR-009-service-platform.md). The machine-readable catalog
contract is [`service-definition.v3.schema.json`](../contracts/service-definition.v3.schema.json).

Official references:

- [Codex App Server](https://developers.openai.com/codex/app-server)
- [Codex authentication](https://developers.openai.com/codex/auth)
- [OpenAI voice agents](https://developers.openai.com/api/docs/guides/voice-agents)
- [OpenAI Realtime API](https://developers.openai.com/api/docs/guides/realtime)
- [ChatGPT and API billing are separate](https://help.openai.com/en/articles/8156019-how-can-i-move-my-chatgpt-subscription-to-the-api)
