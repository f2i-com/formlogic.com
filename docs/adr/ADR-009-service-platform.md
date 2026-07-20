# ADR-009 — One service contract, one credential boundary, many consumers

Status: accepted for the first implementation slice (20 July 2026)

## Context

FormLogic currently uses the word *service* for several different things:
managed local processes, Desktop AI provider profiles, browser-only AI
profiles, plugin-owned runtimes, pack feature flags, and flow nodes. The
overlap makes it difficult to add searchable actions, multiple customer
accounts, safe endpoint mappings, or a paired website invocation without
copying credentials and physical URLs between subsystems.

The OpenAI integration also has two materially different authorization and
billing boundaries:

- OpenAI Platform API credentials authorize API inference and are billed by
  the customer's OpenAI Platform account.
- `codex app-server` can own a managed ChatGPT login for subscription-backed
  Codex agent turns. That session is not a general OpenAI API bearer and is not
  suitable for Aokie's realtime caller loop.

Conflating those products would make the UI misleading and weaken the
credential boundary.

## Decision

FormLogic Desktop is the local credential and invocation authority. Consumers
refer to stable connection and action identifiers. They do not receive a
provider credential or persist a resolved loopback/provider URL.

The domain vocabulary is:

- **ServiceDefinition** — immutable, versioned, signed catalog metadata,
  settings/auth schemas, permissions, and declared actions.
- **ServiceConnection** — one customer-configured account or runtime instance,
  with non-secret settings and references to Desktop-held secrets.
- **ServiceRuntime** — an optional supervised local process used by a
  connection.
- **ServiceAction** — one typed operation with schemas, side-effect class,
  transport, mapping, timeout, and grants.
- **ServiceBinding** — an app/user/device lane mapped to a connection and
  action, with an epoch and ordered fallbacks.
- **ServiceInvocation** — a host-stamped execution and its ordered, redacted
  progress/terminal events.
- **AppFeature** — a pack feature toggle; it is not an executable service.

Existing records remain compatible:

- `ServiceTemplate` is treated as a `ServiceRuntime` definition. Its optional
  `node` becomes a generated `default` action.
- `ProviderProfile` is projected as a `ServiceConnection` until the persisted
  registry migration lands.
- `/api/ai/v1` remains the OpenAI-compatible compatibility facade.
- Browser-only provider profiles remain an explicitly labelled fallback; they
  are not silently copied into Desktop storage.

## Built-in OpenAI definitions

Two separate definitions are exposed:

1. **OpenAI API — separate API billing** (`openai-api`)
   - kind: `remote-provider`
   - connection auth: Desktop-keyring API key
   - capabilities in the first slice: only capabilities actually served by
     the Desktop gateway
   - may bind to Aokie's `receptionist-chat` lane

2. **OpenAI Codex Agent — Sign in with ChatGPT** (`openai-codex-agent`)
   - kind: `delegated-agent`
   - auth: managed by a supervised, stdio-only `codex app-server`
   - capabilities: `agent.codex`, `agent.assistant`, and an explicitly
     experimental text-only `llm.chat` Aokie adapter
   - exposes no model-visible file, command, browser, app, MCP, or network tools
     and permits no approvals; the managed process still reads its own private
     OAuth profile and the prompt/response travel to OpenAI through Codex
   - on Windows, uses Codex file-backed auth only inside a fresh versioned
     profile with a protected Owner Rights/SYSTEM/Administrators DACL and
     verified EFS; the OAuth `auth.json` file remains logically plaintext to
     those authorized processes but is encrypted on disk, and startup/account
     use fails closed without EFS
   - retains operating-system keyring auth on non-Windows builds
   - is never advertised as `voice.realtime`; the Aokie adapter is a bounded
     STT → text turn → TTS lane, not a raw-audio or Realtime voice provider
   - exposes GPT-5.6 Luna low-reasoning routes in default and priority Fast
     modes, plus the existing GPT-5.5 reasoning-off/low compatibility routes;
     every call turn is ephemeral and the exact reserved routes cannot be
     shadowed by provider profiles

Raw ChatGPT tokens and raw App Server JSON-RPC are never returned through the
Desktop HTTP API, plugin UI bridge, website relay, logs, or exports.

## Action and mapping rules

- Definitions may declare at most 64 actions in schema version 3.
- Mapping is data, not code. JavaScript, shell, `eval`, and arbitrary functions
  are forbidden.
- Request mappings may read only validated `input`, `settings`, and
  host-stamped `context`. Response mappings may additionally read `response`.
- Secrets are injected by a typed host auth operation and render as
  `[REDACTED]` in previews. Ordinary templates cannot read secret values.
- User-customized hosts remain inside the definition's declared egress
  permission envelope. Public HTTPS is the default; local/private/plaintext
  destinations require an explicit local policy.
- External communication, financial, and destructive actions require explicit
  approval unless a durable automation grant covers the exact binding.

## Website invocation

The first release supports a paired, same-machine website calling the Desktop
gateway with the exact-origin pairing token. Desktop injects the provider key
and returns the normalized result. All website OpenAI API inference/model reads
and Codex agent reads/turns additionally require a short-lived, server-minted
owner capability containing only the exact allow-listed `service.*` actions
for that service. Exact service grants do not authorize connectors, flows,
another service, or wildcard owner authority. App-scoped issuance requires the
active app owner; account/workspace issuance supports builder surfaces before
an app slug exists. Delegated Codex account login/logout stays Desktop-only.

This is a transitional pilot until service bindings and non-owner delegation
are designed. A later remote service-job relay is a separate protocol with
principal/app/device stamping, expiry, idempotency, ordered events,
cancellation, and bounded retention. Existing connector commands are not
widened into that transport.

No end-to-end privacy claim is made for a future hosted relay until request and
result payloads are application-layer sealed.

## Consequences

- Services can share a standard catalog/details shell while retaining custom
  settings and signed sandboxed screens.
- Search, categories, tags, actions, and pagination operate on one projection
  instead of provider-specific screens.
- Aokie and flows can migrate from URLs to stable source references without a
  flag day.
- Form/App builders have a protected account/workspace bridge available, but
  their existing hosted generation screens require an explicit provider picker
  and structured-output adapter before they can opt into Desktop services.
- The Codex integration can use a customer's eligible ChatGPT plan for trusted
  FormLogic agent work and, by explicit owner choice, an experimental Aokie
  text-call lane. Production low-latency voice still requires an inference or
  Realtime service designed and supported for that path.
- A remote job relay, generalized mapping runtime, and full persisted registry
  migration remain separately testable follow-up phases.
