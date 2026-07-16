//! FormLogic Desktop plugin host.
//!
//! Plugins are directories under `<data_dir>/plugins/<id>/` containing a
//! `manifest.json` and an executable; they run as supervised child processes
//! speaking JSON-RPC 2.0 over newline-delimited stdio. Contracts:
//! `formlogic-app/docs/DESKTOP_PLUGIN_SDK.md` +
//! `docs/contracts/plugin-manifest.schema.json` (local copy in
//! `docs/contracts/`).
//!
//! The flow:
//!   1. `registry::PluginHost` scans the plugins root (startup + every
//!      `GET /api/plugins`), validating manifests (`manifest`) and version
//!      compatibility; anything invalid surfaces as `disabled` + reason.
//!   2. `runner` supervises each started plugin: init handshake, 10 s health
//!      probes, crash detection with bounded auto-restart, graceful shutdown.
//!   3. `rpc` is the stdio JSON-RPC client: request/response correlation,
//!      notification dispatch (`event.emit` → the event bus, `log.emit` →
//!      the ring buffer), 1 MiB line cap, non-protocol output → logs.
//!   4. `crate::connectors` gates and forwards connector commands;
//!      `crate::events` fans validated event envelopes out to SSE consumers.
//!
//! `builtin` bundles first-party plugin TEMPLATES (e.g. the Aokie phone
//! bridge manifest) that materialise into the plugins dir on user install.

pub mod builtin;
pub mod install;
pub mod receipts;
pub mod manifest;
pub mod package_trust;
pub mod registry;
pub mod rpc;
pub mod runner;
