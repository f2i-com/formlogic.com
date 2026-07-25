//! FormLogic Desktop flow runtime — the HEADLESS runner for flows + the Aokie
//! receptionist. The web app only VIEWS state remotely; execution happens here.
//!
//! - `data_ports`— RUN-302 typed data-port readiness (shared corpus with browser + cloud)
//! - `quickjs`   — user-code sandbox (condition / logic_block / app-logic hooks)
//! - `selectors` — pure Rust selector + template port (matches the browser)
//! - `runner`    — WorkflowGraph interpreter (same node semantics as the browser)
//! - `applogic`  — the app's `onConnectorEvent` scripts, applied headless
//! - `dispatcher`— event fan-out (bindings) + queued-run claim loop
//!
//! See `docs/FORMLOGIC_FLOWS.md` §4/§8–§14 and `docs/FORMLOGIC_DESKTOP.md`.

pub mod data_ports;
pub mod quickjs;
pub mod runner;
pub mod selectors;
pub mod serial_queues;
pub mod work_ledger;
// applogic + dispatcher added below once the leaf modules compile.
pub mod applogic;
pub mod dispatcher;
pub mod relay;

pub use dispatcher::{FlowRuntime, FlowRuntimeStatus};
