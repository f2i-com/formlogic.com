# ADR-008 — AI provider profiles + gateway authentication

Status: **accepted** · 2026-07-16 · source: v3 plan §12–§13

## Provider contract

ONE versioned provider-profile schema with conformance fixtures shared by web and
Desktop (no copy-and-diverge of the browser config). Fields: id, display name,
**protocol adapter**, base URL, optional model catalog, capabilities (chat,
transcription, speech, embeddings, realtime), per-capability request/response mode,
secret references + auth kind, health/test operation, timeouts/concurrency/size
limits, data destination/disclosure, usage/cost policy, enabled/default/fallback.

Protocols are **explicit adapters** (OpenAI Responses, OpenAI Chat Completions,
OpenAI Audio, OpenAI Realtime GA, Anthropic Messages, Ollama, LM Studio/OpenAI-
compatible, Custom HTTP) over a canonical internal chat/audio request model — one
provider's extra fields are never forwarded to another. Application flows bind to
**logical capability aliases** (e.g. `receptionist-chat`); the device owner maps the
alias to a provider profile. Exports carry the alias + requirements, never a
machine-specific provider id or secret. User-facing naming: **OpenAI API** (a
ChatGPT subscription is not an API credential).

Custom HTTP flexibility ships as safe declarative modes (JSON template / multipart /
raw bytes / form requests; JSON-path / raw-bytes / SSE-delta responses; protected
secret placeholders) — no eval. Egress hardening: HTTPS by default with explicit
LAN/loopback opt-in, redirect denial or full revalidation, DNS pinning/rebinding
protection, metadata + link-local + unsafe-private-address denial, no caller-supplied
hop-by-hop headers, newline rejection, request/response/audio/SSE limits, full
timeouts, secret + PII redaction in logs.

## Gateway authentication (the non-negotiable)

The Desktop AI Gateway lives on the management plane with **strictly separated
routes**; **inference is never anonymous**:

- Desktop webview → host IPC / trusted session.
- Paired browser → app-scoped pairing token with `ai.invoke` provider/capability
  grants.
- Native plugin → random, memory-only, short-lived credential issued at
  `plugin.init` over the existing private inherited pipe (never argv/env), bound to
  plugin id, process generation, connector/app binding, allowed
  providers/capabilities, and limits; revoked on stop/crash/restart.
- Authentication never implies permission to spend every configured key; CORS is
  route/origin-specific; loopback bind only; Origin/CSRF/PNA checks on HTTP;
  origin/one-time-ticket or native-only rules on WebSocket routes.
- The gateway records provider, capability, latency, bytes/audio duration,
  tokens/estimated cost, result, and correlation id — never secret headers or
  transcript/audio content.

## Aokie integration requirements (AI-406/406A)

Scoped gateway routes for chat/STT/TTS with the plugin credential applied to
**every** call class (model discovery, warmup, chat streaming, audio-transcript
correction, STT, TTS); consent destination mapped from the active app/connector
binding — explicit consent before phone audio/transcripts/caller data leave the
device; per-call/request limits + circuit breaker; explicit, consented, sticky
fallbacks; endpoint discovery fixed so a configured provider failure can never
silently fall back to an unrelated port-8080 service; **cloud readiness gates
auto-answer** (provider enabled, secret present, authenticated chat/model check, STT
response-format probe, TTS decodable-WAV probe, fresh readiness TTL — an invalid key
keeps the call ringing/manual, never answered into silence).

OpenAI Realtime (Phase 7) is a versioned provider adapter/session broker (never a
transparent proxy), native-plugin-only unless a one-time browser ticket design is
separately approved; barge-in truncates upstream at the exact played-sample duration
and the durable bot transcript derives from heard audio (v3 §13).
