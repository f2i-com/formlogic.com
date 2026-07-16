# ADR-002 — PluginInstallation → ConnectorInstance → AppBinding

Status: **accepted** · 2026-07-16 · source: v3 plan §6

## Problem

Connector dispatch today routes to the FIRST plugin declaring a connector id
(`connectors.rs` find_target), events fan out by name alone, and installing a plugin
implicitly makes it available to every app. Two plugins claiming one connector id are
nondeterministic; a second app could receive another app's call events.

## Decision

Introduce explicit ownership records:

```
PluginInstallation (machine)  →  ConnectorInstance (per declared connector)
                                     →  AppBinding (per app, host-authoritative)
```

`AppBinding` fields: `deploymentId, appId, desktopConnectionId, pluginInstallationId,
connectorInstanceId, settingsProfileId, contractVersion,
state ∈ {active, inactive, missing, incompatible, bound_elsewhere}`.

Rules (all fail-closed):

1. **One physical phone-line connector has ONE active owning app.** Ownership may
   switch only while the line is idle. Other apps see `bound_elsewhere` and receive
   no events.
2. Desktop persists the local binding record; the hosted deployment persists the
   matching remote record. **The host stamps** all deployment/app/desktop/plugin/
   connector identities on every command and event — plugin- or pack-supplied scope
   fields are ignored/rejected.
3. Every ownership change increments a **binding epoch**; commands/events carrying a
   stale epoch fail closed.
4. Revocation immediately blocks dispatch and invalidates plugin/provider session
   credentials.
5. Offline operation uses the last server-confirmed binding within an explicit
   policy/expiry; offline can never create or transfer ownership.
6. Reconnect performs deterministic two-sided reconciliation; irreconcilable
   ownership conflict stops the connector.
7. Uninstall → binding `missing` (reinstall can reconnect it); purge/revoke have
   separate semantics.
8. Install-time and scan-time **collision quarantine**: two plugins declaring the
   same connector id (or squatting another's event names) never race — the later
   one is quarantined visibly.

Deep-link contributions must resolve (deployment, installed app instance, screen)
with explicit states for: not linked, pack missing, no binding, multiple matches,
incompatible contract.

## Consequences

- `connectors.rs` first-match routing is replaced in Phase 2 (PLG-205); until then no
  second connector-declaring plugin is supported.
- Correlation/idempotency IDs are host-added to every mutation (v3 §4.2).
- The flow dispatcher gains a per-binding source filter (event name alone is never
  the routing key across apps).
