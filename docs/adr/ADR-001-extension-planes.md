# ADR-001 — Five extension planes

Status: **accepted** · 2026-07-16 · source: v3 plan §2

## Decision

FormLogic has five deliberately separate extension planes. They are never combined
into one "plugin" concept; each has its own owner, trust domain, and portability rules.

| Plane | Scope / installer | Contains | Must NOT contain |
|---|---|---|---|
| **FormLogic application package** (`.formlogic-app`) | App/tenant; installed by the app owner | Forms, schemas, records config, flows, dashboards, assets, sandboxed screens, bounded QuickJS, requested capabilities, dependency descriptors | Native EXEs, drivers, API keys, unrestricted server routes |
| **Desktop native plugin** (`.formlogic-plugin`) | Machine/user; installed by the Desktop operator | Hardware connector, HFP/SCO, native media, driver-helper orchestration, connector commands/events, local service descriptors, declarative UI contributions | FormLogic account keys, app-membership authority, arbitrary host HTML, app business data |
| **Local service** | Machine; owned by the user or a native plugin | A supervised STT/TTS/model/process workload, or a declared local endpoint | Navigation, app authorization, publisher-trust decisions |
| **AI provider profile** | User/device, optionally mapped to an app via a capability alias | Protocol adapter, endpoint, model choices, capabilities, limits, secret **references** | Process supervision, portable secrets |
| **Hosted extension worker** | Deployment administrator | Stateful server ops, WebSockets, push, ICE/TURN, queues, schedules, native libs behind typed operations | Arbitrary tenant PHP loaded into the FormLogic web process |

## Target relationship (the Aokie shape)

The Aokie Receptionist **application package** owns the business experience and asks
for an Aokie connector capability. The Desktop **Aokie plugin** provides that connector
and owns physical phone/media truth. The FormLogic security kernel **binds** the
connector instance to exactly one app (ADR-002). **AI profiles** satisfy logical
chat/transcription/speech/realtime capability aliases. The **hosted Companion
extension** provides typed cloud operations. Each layer upgrades, removes, or denies
independently.

## Consequences

- Removing the native plugin makes hardware features unavailable but preserves the
  FormLogic app and its records.
- Importing a signed app package transfers all app content and vendor provenance —
  never active grants, machine bindings, or secrets.
- A native plugin is a full user-level process, not an OS sandbox; its declared
  permissions/destinations are disclosure + host-API authorization. The install UI
  must say this plainly (v3 §4.3).
- "Pure FormLogic app" has the acceptance test of v3 §3; until the hosted Aokie
  control plane moves behind the worker boundary (Phase 6), the honest milestone
  name is **pack-owned Aokie UI and business logic**.
