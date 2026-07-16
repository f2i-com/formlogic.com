//! AI-401..407 — the Desktop AI provider layer + gateway.
//!
//! `providers` holds the versioned provider-profile registry (config on disk,
//! API keys in the OS credential store) shared by web and Desktop. `gateway`
//! is the authenticated loopback OpenAI-compatible surface (`/api/ai/…`) that
//! translates the canonical request to whatever provider a capability alias
//! resolves to — local (the services registry) or an external endpoint
//! (OpenAI / Anthropic / Ollama / LM Studio / Custom HTTP) with the user's
//! own key. See ADR-008.

pub mod egress;
pub mod gateway;
pub mod providers;
