# ADR-010 — Application Package v2, declarative flow-node contributions, service distributions

Status: **accepted** · 2026-07-24 · source: extensible-flow-engine plan (`formlogic-extensible-flow-engine-plan.md`, grounded at `21195b4`) §2, §6–§11

## Decision

**Application Package v2** is the installable *aggregate* unit: a package may carry any
non-empty combination of Pack v1 content, declarative flow-node contributions, portable
service *requirements*, and references to separately signed service *distributions*.
A node-only package (contributions, no forms/apps) is valid and installs as an
Extension/Node Library — it never fabricates an empty launcher app.

| Layer | Contract | Owner |
|---|---|---|
| Delivery + signing | ADR-003 envelope (v1 today; envelope v2 draft adds publisher-key material) | signing/trust pipeline |
| **Aggregate content** | `docs/contracts/application-package.v2.schema.json` (`formatVersion: 2`) | **this ADR** |
| App content payload | Pack v1, validated exactly as today (its ≥1-form rule is NOT relaxed; a node-only v2 simply omits `content.pack`) | PackService |
| Node contribution | `docs/contracts/flow-node-definition.v1.schema.json` (`schemaVersion: 1`) | **this ADR** |
| Service actions | `service-definition.v3.schema.json` (ADR-009) | service platform |

Naming note: ADR-003's "package envelope v2" is the *signing* envelope; "Application
Package v2" is the *content aggregate*. They are different layers and may version
independently. The v1 `ApplicationPackage` JSON envelope (`manifest`/`pack`/
`customLogic`) continues to be read and adapts into the same normalized install model.

### Contributed nodes are data that LOWERS to trusted handlers

A Flow Node Definition contributes UI metadata, typed ports, a configuration schema,
and a **handler reference** — never runtime code. The server-authoritative compiler
lowers each contributed node to canonical core IR (`core-preset` → an existing core
node + validated defaults; `service-action` → the canonical `service_action` node
bound through a named binding slot). v1 accepts ONLY these two handler kinds; the
later kinds (`connector-action`, `subflow`, `quickjs`, `hosted-action`) are *known but
not enabled* — validators reject them with a distinct code so hosts can message
"requires a newer FormLogic" rather than "invalid".

- Contributed types are namespaced (≥3 dot-segments) and must extend the owning
  package's `publisherId`; core types are dot-free, so shadowing is structurally
  impossible and additionally rejected.
- `availability` and `requiredGrants` in a definition are *requests*. Effective
  availability is the intersection of the trusted handler's host support, the
  installed implementation, the bound device, and policy; effective permissions are
  derived transitively from handler + referenced action + transport — a definition
  cannot under-declare its way past review.
- Port/configuration schemas use a **declaration subset that is strictly tighter than
  the §6.5 runtime validator** (desktop `invocation.rs schema_subset`): structural
  keywords `type, properties, required, additionalProperties, items, enum, const,
  minLength, maxLength, minimum, maximum`; annotations `title, description, default,
  examples`; `$ref` only from the local allowlist (`formlogic://schemas/artifact-ref.json`);
  `x-artifactKinds` as the artifact-kind marker. Anything else fails closed. Rationale:
  the runtime ignores unknown keywords, so accepting them at declaration time would let
  a definition *claim* validation the runtime will not enforce.
- Invalid `uiHints` entries are the one explicitly presentation-only surface: they are
  dropped, never fatal (README ground rule: only presentation-only fields may be
  ignored).

### Requirements vs distributions

`requirements.services[]` declares portable, constraint-checked **slots** (what the
package needs); `serviceDistributions[]` lists separately signed, digest-pinned
**candidates** that can satisfy those slots. A user may bind another compatible
installed service instead of the author's candidate. `runtimeKind` selects the trusted
installer (`managed-service` vs `desktop-plugin`) and is immutable after review; a
plugin artifact never routes through the managed-service installer or vice versa.
`installPolicy` is `prompt`-only in v1 (native approval on the target Desktop).

### Identity, versions, grants, failure semantics

- IDs are lowercase dotted namespaces: package/publisher ≥2 segments; a package id
  must extend its `publisherId` (`com.acme` → `com.acme.media-tools`).
- Versions are exact semver; dependency ranges use the deliberately small v1 grammar
  `X.Y.Z | ^X.Y.Z | ~X.Y.Z | >=X.Y.Z` (resolver semantics land with the dependency
  resolver; the contract validates syntax only).
- Unknown fields fail closed at every level (README ground rule); counts, sizes, and
  schema depth are capped in the contract.
- Signed package content is immutable. Grant decisions (approve/deny per capability)
  are stored separately and bound to the reviewed plan — the SAFE-001 fail-closed
  import lane (`approvedConnectorGrants` required on every HTTP import) is the
  enforcement precedent v2 planning builds on.
- Installations are device-scoped sagas: `ready | pending_desktop | degraded | failed |
  rolling_back | removed`; contributed apps/nodes/bindings activate only when every
  required component is healthy on the selected device; a failed update retains the
  previous active version; compensation never deletes user-modified content.
- Components are reference-counted; installed packages, user pins, AND published flow
  revision locks are consumers. Garbage collection only after every consumer is gone.

## Reconciliation with prior ADRs

- **ADR-001 (five planes):** a v2 aggregate *references* other planes; it never merges
  them. Distributions are separately signed artifacts routed to their plane's
  installer; contributions are declarative data lowered to host-owned handlers; the
  application-content plane still never carries executable native code.
- **ADR-002 (connector binding):** untouched. `connector-action` handlers stay feature-
  gated until a contract/threat-model revision defines how contributed nodes interact
  with AppBinding-scoped connector authority.
- **ADR-003 (envelope + trust):** the signing envelope, publisher trust, and
  component-digest pack trust remain the delivery/trust substrate. Node definitions and
  service definitions become digest-tracked components under the same
  `verified_vendor / vendor_modified / owner_approved / untrusted / revoked` states;
  requested permissions travel, active grants never do.
- **ADR-004 (hosted boundary):** unchanged — packages *declare* hosted capability
  dependencies; they never install server code. The `hosted-action` handler kind, when
  enabled, resolves only to server-registered typed `service.invoke` operations.
- **ADR-005 (store lane):** remote component-install jobs are a direct-distribution
  feature; the Store build may ship with `desktop_component_install_jobs` disabled
  without corrupting installed state (flag-off leaves v1 behavior intact).
- **ADR-009 (service platform):** ServiceDefinition v3 is the single action contract a
  distribution's `definition` must satisfy; `ServiceTemplate.node` remains a local-only
  compatibility hint and never becomes remotely callable; AppFeature (`apps[].services`
  toggle) is NOT a Desktop service — v2 renames it `features` with the v1 name as a
  read-compatibility alias, and review UIs label it "App features".

## Consequences

- The four install sources (catalog, signed package, JSON, ZIP) normalize into one
  owner-bound install-plan model; v2 adds content *kinds*, not new trust lanes.
- Cross-language validators (TypeScript + PHP now; Rust when the Desktop consumes the
  format in the distribution phase) share one fixture corpus
  (`docs/contracts/fixtures/application-package-v2-cases.json`) asserting identical
  error CODES, so the languages cannot drift on what is valid.
- Rejecting more now (strict v1 grammar, handler allowlist, schema subset) is the
  compatible direction: later hosts may accept more; earlier hosts fail closed with
  actionable codes.
