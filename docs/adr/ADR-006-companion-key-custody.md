# ADR-006 — Companion root-key custody

Status: **provisional** — host security broker retains authority; the AOK-303
continuity prototype is the approval gate · source: v3 plan §10

## Current reality (post `bbc6c7b`/`5cba3b` rebase)

- The **Aokie plugin** already owns authenticated Companion WSS/WebRTC signalling,
  leases, takeover continuity, and native remote media (`companion_gateway.rs`).
- **FormLogic Desktop** supplies endpoint identity + approved roster through the
  private bootstrap pipe and brokers short-lived `companion.admission` without ever
  exposing the linked `flk_` account key.
- **FormLogic hosted** owns membership, device/routing/push/admission/OAuth state.
- The **mobile app** owns mobile identity, WebRTC, and user interaction.

## Decision

- Permanent account credentials, app/device binding, admission policy, and
  endpoint/roster **authority stay in a generic FormLogic host security broker** —
  the Aokie-pinned host methods/feature flags are generalized, not merely renamed.
- The Aokie plugin keeps call snapshots, lease handling, physical call/media truth,
  and the Companion transport. Aokie-specific management UI moves to the
  application package.
- **Root-key custody options** (choose + prototype in AOK-303, in order of
  preference):
  1. host retains the existing endpoint root and performs narrowly scoped signing
     through the broker;
  2. host retains the root and issues a protocol-supported delegated/session key;
  3. an explicitly approved atomic transfer moves the exact existing root into
     plugin secure storage.
  Do **not** assume delegated keys are compatible with the current mobile protocol.
  The prototype must prove endpoint thumbprint continuity, roster update/revocation,
  admission refresh, and rollback before AOK-303 is approved.
- Prefer short-lived delegated/session signing authority over handing a permanent
  root seed to a plugin whenever the protocol supports it.

## Migration invariant

Every identity/binding item in [companion-inventory.md](companion-inventory.md)
migrates **without re-pairing**; re-mint/re-pair is a documented last-resort
fallback, never the normal path. Existing mobile monitor/assist/consult/takeover
flows must survive admission expiry and reconnect across the migration (v3 §16).
