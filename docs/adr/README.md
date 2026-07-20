# Architecture Decision Records — Plugin Platform / Pure-Pack Aokie / AI Endpoints

Phase −1 deliverables of the 2026-07-16 v3 plan ("FormLogic Plugin Platform, Pure-Pack
Aokie, Services and Open AI Endpoints"). Each ADR records a decision that would
otherwise change package layout, security authority, data roots, or connector routing
mid-implementation. Statuses: **accepted** (locked for implementation), **provisional**
(direction chosen; a named gate can revise it).

| ADR | Title | Status |
|---|---|---|
| [ADR-001](ADR-001-extension-planes.md) | Five extension planes | accepted |
| [ADR-002](ADR-002-connector-app-binding.md) | PluginInstallation → ConnectorInstance → AppBinding | accepted |
| [ADR-003](ADR-003-package-and-publisher-trust.md) | Package envelope v2, publisher trust, component-digest pack trust | accepted |
| [ADR-004](ADR-004-hosted-extensions.md) | Hosted server-side extension boundary | accepted (model); Phase 6 decides Aokie's migration |
| [ADR-005](ADR-005-store-distribution-lane.md) | Microsoft Store distribution lane | provisional — MSI/EXE lane preferred; MSIX not approved |
| [ADR-006](ADR-006-companion-key-custody.md) | Companion root-key custody | provisional — host security broker; AOK-303 prototype is the gate |
| [ADR-007](ADR-007-settings-ownership.md) | Settings ownership split | accepted |
| [ADR-008](ADR-008-ai-provider-gateway.md) | AI provider profiles + gateway authentication | accepted |
| [ADR-009](ADR-009-service-platform.md) | One service contract, one credential boundary, many consumers | accepted for first slice |

Supporting Phase −1 artifacts:

- [threat-models-phase-minus-1.md](threat-models-phase-minus-1.md) — native package supply chain, powered pack bridge, AI gateway.
- [companion-inventory.md](companion-inventory.md) — the Companion identity/binding migration inventory (live verification = AOK-303 step 1).
- Draft schemas in [`docs/contracts/drafts/`](../contracts/drafts/): plugin manifest v2, package envelope v2, command contract v1, AppBinding v1, app dependencies v1.

Ground rules that apply across all ADRs (v3 §2, §16):

- The five planes never merge files or trust domains; a solution catalog may associate them into one guided install.
- Every cross-plane command/event carries installation, connector, deployment, app, and desktop-connection identities plus correlation/idempotency IDs and a contract version.
- Unknown execution/permission/trust/service/migration/update fields fail closed; only explicitly presentation-only fields may be ignored by an older host.
- No test of a destructive lifecycle feature ever first targets the live Aokie installation; the sample echo plugin is the test subject.
