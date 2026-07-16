# Desktop AI Gateway + provider registry (Phase 4 — AI-401..407)

Bring your own AI: point the receptionist or a flow at OpenAI (ChatGPT API),
Anthropic, a local Ollama/LM Studio, or any custom HTTP endpoint — run everything
in the cloud on your own key with nothing local, or mix local + cloud freely.
Backed by ADR-008.

## Provider registry (AI-401)

`<data_dir>/ai-providers.json` holds provider **profiles** (id, name, protocol,
baseUrl, model, capabilities, custom headers, per-capability specs for Custom,
`allowLocal`, `enabled`). **API keys are never in this file** — they live in the OS
credential store under `ai-provider:<id>`; the API and UI only ever see a `hasKey`
boolean. Managed at `Services → AI Providers` and over `/api/ai/providers*`.

A **capability alias** (`receptionist-chat`, `speech-to-text`, …) maps a logical
capability to a provider profile. Flows/exports reference the alias; the device owner
maps it to a machine-local provider. Exports carry the alias + requirements, never a
machine provider id or a secret.

Presets: OpenAI, Anthropic, Ollama (local), LM Studio (local), Custom HTTP.

## Gateway (AI-402/403)

An OpenAI-compatible loopback surface on the management plane:

- `GET  /api/ai/v1/models` — default provider's models (empty list if none configured).
- `POST /api/ai/v1/chat/completions` — canonical OpenAI chat request; a `provider`
  field selects a capability alias/provider id.
- `GET  /api/ai/providers/:id/v1/models`, `POST /api/ai/providers/:id/v1/chat/completions`
  — a named provider.

The gateway attaches the key server-side and normalizes the response back to the
OpenAI shape, so a consumer speaks one dialect regardless of the upstream:

- **OpenAI protocol** — pass-through (llama.cpp / Ollama / LM Studio `/v1` are this).
- **Anthropic** — OpenAI chat → Messages (system extracted, `x-api-key` +
  `anthropic-version`), response text unwrapped back to OpenAI choices.
- **Custom HTTP** — a `requestTemplate` (`{{model}} {{messages}} {{prompt}} {{input}}
  {{apiKey}}` placeholders, JSON-escaped) and a dot-path `responsePath` let a user wire
  essentially any service.

Streaming SSE, the audio (STT/TTS) routes, embeddings, and OpenAI Realtime (WS) are
additive follow-ups on this same surface (audio + realtime land with the Aokie
gateway wiring / Phase 7).

## Auth (ADR-008 — inference is NEVER anonymous)

Every `/api/ai/*` route sits behind the management-plane auth guard (webview | server
token | pairing token). There is no anonymous tier, so a drive-by web page in the
user's browser cannot spend their keys. Provider **config** + **key** routes are
additionally in `is_privileged_path`, so a no-Origin native caller cannot reconfigure
providers or set keys (only drive inference). The per-session native-plugin credential
(issued at `plugin.init`) is layered on when the Aokie plugin is wired to the gateway;
today the plugin reaches inference over the same authenticated loopback surface.

## Egress hardening (AI-404)

Every outbound provider call is validated + address-pinned (`ai/egress.rs`):

- HTTPS required unless the provider is explicitly marked **local** (the only way a
  plaintext/loopback/private endpoint is allowed);
- no embedded credentials, no control/whitespace in the URL;
- DNS resolved once and the socket **pinned** to the resolved address (rebinding
  protection); a non-local provider must resolve to a **public unicast** IP —
  loopback, RFC-1918 private, CGNAT (100.64/10), link-local + metadata
  (169.254.169.254), unique-local, and multicast are refused;
- redirects **disabled** at the client (a 3xx is surfaced, never followed to a fresh
  host);
- hop-by-hop / host-spoofing headers from config are dropped; header values with
  newlines are refused (injection guard); the key is never logged.

## Consumer wiring (AI-405/406 — follow-ups)

- **Aokie plugin**: point `aiEndpoint/sttEndpoint/ttsEndpoint` at the gateway's
  loopback URLs — loopback passes the plugin's own endpoint validation + consent
  gates. The gateway must serve `/v1/models` (it does) so the plugin's discovery
  probe doesn't fall back to `:8080`. The consent-destination mapping + the readiness
  probes that gate auto-answer (AI-406A) land with the Aokie wiring slice.
- **Desktop flow runner**: gains a resolution step so `data.provider` on nodes works
  desktop-side (today it's ignored) — provider id → gateway route.
- **Browser runner**: the gateway appears as a loopback provider/base URL; requests
  carry the pairing token.

## Tests

`ai::egress` (private/metadata/CGNAT refusal, public-IP allow, loopback-when-local,
plaintext/credentials refusal), `ai::providers` (upsert/persist/reload, alias +
capability resolution, delete cascades aliases, default paths), `ai::gateway`
(OpenAI↔Anthropic mapping, custom template render + response-path extraction,
dot-path). 12 unit tests; the whole thing compiles into both the GUI and headless
binaries.
