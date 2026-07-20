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
- `GET /api/ai/v1/realtime/stream` (WebSocket; signed Aokie/Desktop only)

The transcription adapter accepts a bounded multipart upload and injects the
provider profile's model when the caller omits it. The audio-chat adapter keeps
the OpenAI Chat Completions audio shape. The Realtime adapter combines a browser
SDP offer with a bounded session configuration and calls the unified upstream
`/v1/realtime/calls` interface, returning only the SDP answer.

The named server-audio route is
`/api/ai/providers/:providerId/v1/realtime/stream`. It connects once to the
provider profile's `websocketPath` (OpenAI default `/v1/realtime`) with the
profile model forced in the query and the reusable credential injected only by
Desktop. The upstream socket is opened to the DNS-pinned address while the
original hostname remains the TLS SNI/Host identity; redirects and automatic
per-call reconnects are not used.

The local Aokie protocol is deliberately smaller than the provider protocol:

- first text frame: `formlogic.realtime.start` with exact `callId`,
  `generation`, consent-bound `destinationOrigin`, instructions, greeting,
  voice, turn detection, and maximum output tokens;
- server `formlogic.realtime.ready` echoes the same call fence and actual
  provider origin, but does not generate the greeting;
- after the cellular call is answered, unscreened, Aokie-owned, and SCO is up,
  Aokie sends exact-fenced `formlogic.realtime.begin`; only then does Desktop
  create the one-shot greeting and accept audio;
- binary frames in both directions are raw PCM16LE mono at 24 kHz;
- exact-fenced `formlogic.realtime.cancel_output` truncates the assistant item
  at the milliseconds actually played, and `formlogic.realtime.stop` ends the
  session;
- bounded final transcript, speech-start, output-item, ready, and sanitized
  error controls are the only upstream metadata exposed locally.

Desktop forces audio-only output, PCM input/output, handset near-field noise
reduction, server or semantic VAD with response creation and interruption,
and no tools. Messages, frame sizes, PCM rate, session lifetime, concurrent
sessions, and send/connect time are bounded. An abandoned ringing preconnect
cannot generate or buffer a greeting.

OpenAI-shaped chat SSE is passed through incrementally where the provider dialect
does not need translation. Anthropic chat is mapped to/from Messages. Custom HTTP
may map paths, JSON request bodies, response paths, and credential headers;
credentials are deliberately unavailable to request-body templates.

Speech generation (`/audio/speech`) and embeddings remain separate follow-ups.
Realtime replaces Aokie's separate STT -> chat -> TTS response pipeline; it does
not replace the physical Bluetooth SCO link carrying caller audio between the
phone and the Aokie dongle.

## Authentication and secret boundaries

Inference is never anonymous. A paired website presents a short-lived,
owner-minted grant for the exact action: chat, model listing, transcription,
audio chat, or Realtime session creation. Provider/alias/secret configuration,
secret rotation, and connection tests require the Desktop webview or server
token; a paired site cannot rewire the destination it is allowed to invoke.

The per-install plugin inference token is injected only into the signed `aokie`
plugin, never into ordinary plugins or services. Provider credentials are added
only to the validated outbound request and are never logged or returned.
The server-audio WebSocket additionally requires that plugin token (or Desktop
administration) even if a paired website holds broad service grants. Provider
sources disclose only a canonical `destinationOrigin` (scheme, host, and
non-default port); Aokie binds consent to it and Desktop echoes it in `ready`
before any caller PCM can be sent.

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
headless server compile the same gateway implementation. Realtime bridge tests
also cover forced session configuration, exact call fencing, two-phase begin,
terminal-item playout truncation, assistant-item ordering, PCM bounds, and
suppression of partial transcript deltas.
