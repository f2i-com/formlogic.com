//! Application Package v2 on the Desktop side (ADR-010, plan phase 5).
//!
//! The backend owns what an OWNER installed. This module owns what THIS MACHINE did about it —
//! which is a different question, and one the backend cannot answer: a laptop can be offline when
//! an install is requested, a component can be shared by two packages, a user can pin something
//! they want left alone, and a native install can be waiting on a confirmation nobody has given.
//!
//! - `ledger`  — desired vs observed state, consumers, pins, consent, and the offline queue.
//! - `install` — fetch → verify → approve → stage → install → health → activate, with cancel,
//!               rollback and an audit line for every transition.

//! - `jobs`    — the seam to the backend's install jobs: device-scoped outcomes, reference
//!               counting, and offline removal tombstones.

pub mod install;
pub mod jobs;
pub mod ledger;
