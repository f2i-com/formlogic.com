# ADR-004 — Hosted server-side extension boundary

Status: **accepted** (model) · Phase 6 decides Aokie's migration · source: v3 plan §9

## Decision

Server-side extensibility is never "arbitrary PHP/JS loaded into the FormLogic API
process". The model:

- **Small, bounded request logic** stays QuickJS custom logic with CPU/memory/time/
  effect limits (the existing plane).
- **Durable workers** (WebSockets, push, ICE/TURN, schedules, queues, native libs)
  run as separately deployed **hosted extension workers**.
- The FormLogic API exposes only **typed `service.invoke` operations** — each
  server-registered with an exact handler, method, request/response schema, required
  permission, app binding, rate limit, timeout, byte cap, and response projection.
- Hosted FormLogic: worker installation by the platform administrator only.
  Self-hosted: by the deployment administrator only. Application packages declare a
  server capability/version **dependency**; they never silently install executable
  server code.
- Workers use namespaced data/migrations, short-lived service identity,
  least-privilege DB/API access, health/readiness, and audit.

## Aokie reality check

The current Aokie Companion hosted scope (devices, sessions, routing groups, push
endpoints/deliveries, offers, admission, OAuth device/refresh-family binding,
endpoint/holder keys, roster revision/hash, deployment/app/desktop bindings,
ICE/TURN, consent) is a full control plane, not "a few PHP routes".

Near-term (transitional, Phase 5): retain the current Aokie hosted code and expose it
to pack screens **through typed `service.invoke` adapters**; the milestone is named
"pack-owned UI/business logic". Phase 6 chooses between: (a) accept + document as a
core dependency, (b) extract behind the worker contract, (c) generalize into
reusable FormLogic realtime/companion capabilities. Only (b)/(c) permit the strict
"pure FormLogic app" claim (v3 §3).

Rejected bridge alternatives (v3 §8.3): raw `backend.fetch` with caller-selected
paths, arbitrary headers/cookies/redirects, `records.clearAll`, unrestricted
connector commands, pack-initiated Desktop pairing-token minting.
