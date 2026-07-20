# Desktop AI Gateway + provider registry (AI-401..407)

Bring your own AI: FormLogic can use cloud, local, or custom providers while
keeping provider credentials inside FormLogic Desktop. ChatGPT/Codex sign-in and
OpenAI Platform API keys are separate connections and billing domains.

## Provider registry and reusable secrets

`<data_dir>/ai-providers.json` holds provider profiles (id, name, protocol,
base URL, model, capabilities, custom headers/mappings, `secretRef`, local-access
policy, and enabled state) plus non-secret reusable-secret metadata.

Secret values are never written to that file or returned by an API. Named values
live in the OS credential store under `api-secret:<id>` and can be shared by
multiple providers. Existing provider-specific values under `ai-provider:<id>`
remain compatible. The UI exposes only presence and reference metadata at
`Services -> AI Providers -> API Secrets`.

Presets include OpenAI Platform, `gpt-4o-mini-transcribe`,
`gpt-realtime-2.1-mini`, `gpt-audio-1.5`, Anthropic, Ollama, LM Studio, and
Custom HTTP.

An optional capability alias maps a logical role to a provider. Explicit aliases
and provider ids fail closed: an unknown/disabled/incompatible selection never
falls through and spends another provider's secret.

## Gateway routes

The authenticated loopback gateway has default-provider routes and corresponding
named routes under `/api/ai/providers/:id/v1/*`:

- `GET /api/ai/v1/models`
- `POST /api/ai/v1/chat/completions`
- `POST /api/ai/v1/audio/transcriptions`
- `POST /api/ai/v1/audio/chat/completions`
- `POST /api/ai/v1/realtime/sessions`

The transcription adapter accepts a bounded multipart upload and injects the
provider profile's model when the caller omits it. The audio-chat adapter keeps
the OpenAI Chat Completions audio shape. The Realtime adapter combines a browser
SDP offer with a bounded session configuration and calls the unified upstream
`/v1/realtime/calls` interface, returning only the SDP answer.

OpenAI-shaped chat SSE is passed through incrementally where the provider dialect
does not need translation. Anthropic chat is mapped to/from Messages. Custom HTTP
may map paths, JSON request bodies, response paths, and credential headers;
credentials are deliberately unavailable to request-body templates.

Speech generation (`/audio/speech`), embeddings, and a native Aokie Realtime
WebSocket/SCO bridge remain separate follow-ups. The current Realtime route is a
website WebRTC session broker, not an Aokie phone-call transport.

## Authentication and secret boundaries

Inference is never anonymous. A paired website presents a short-lived,
owner-minted grant for the exact action: chat, model listing, transcription,
audio chat, or Realtime session creation. Provider/alias/secret configuration,
secret rotation, and connection tests require the Desktop webview or server
token; a paired site cannot rewire the destination it is allowed to invoke.

The per-install plugin inference token is injected only into the signed `aokie`
plugin, never into ordinary plugins or services. Provider credentials are added
only to the validated outbound request and are never logged or returned.

Every outbound target is address-pinned with redirects disabled. Public providers
must use HTTPS and resolve only to public unicast addresses. Loopback/private/http
targets require an explicit local-provider opt-in; metadata/link-local addresses,
embedded credentials, control characters, and host-spoofing headers are refused.

## Consumers

- Aokie's live LLM and transcription lanes can select named gateway providers.
- Receptionist Settings has a separate Background AI provider/model for SMS
  drafts, SMS follow-up decisions, call summaries, and after-call extraction.
- The virtual `openai-codex-agent` provider uses ChatGPT/Codex OAuth for text-only
  background/forms/flow work. It defaults to GPT-5.6 Luna with low reasoning and
  is distinct from both Platform API providers and the call-specific adapters.
- Desktop and browser flow runners interpolate `data.provider` and call the named
  Desktop route. Once a Desktop provider matches, failure is terminal rather than
  silently switching accounts/vendors.
- Paired website AI can call the same named routes. The intentionally explicit
  hosted-vs-Desktop feature matrix is in `WEBSITE_AI_DESKTOP_ROUTING.md`.

## Verification

Coverage includes egress/DNS hardening, reusable-secret lifecycle and legacy
compatibility, fail-closed resolution, virtual-provider reservation, protocol
mapping, exact website grants, Codex background normalization, multipart handling,
Realtime session paths, and browser/Desktop flow provider routing. The GUI and
headless server compile the same gateway implementation.
