# Extensions — Application Package v2 & contributed flow nodes

An **extension** is an installable package that contributes new **flow nodes** to a
FormLogic workspace — without shipping any runtime code. It is the first delivery of
**Application Package v2** (ADR-010), the aggregate distribution/dependency unit that
will eventually also carry Pack content and signed Desktop service distributions.

This guide is for package authors. The authoritative contracts are:

- [`docs/contracts/application-package.v2.schema.json`](contracts/application-package.v2.schema.json)
- [`docs/contracts/flow-node-definition.v1.schema.json`](contracts/flow-node-definition.v1.schema.json)
- shared validation fixtures: [`docs/contracts/fixtures/application-package-v2-cases.json`](contracts/fixtures/application-package-v2-cases.json)
  (asserted identically by the TypeScript and PHP validators — the fixture corpus is the
  ground truth for what is valid)
- architecture: [`docs/adr/ADR-010-application-package-v2.md`](adr/ADR-010-application-package-v2.md)

Pack v1 (forms/apps/screens) is unchanged and documented in [PACK_FORMAT.md](PACK_FORMAT.md).
A node-only extension **omits** Pack content — it never fabricates an empty launcher app.

---

## Quickstart: a working node-only extension

Save this as `acme-media-tools.json` and import it (Packs → Import, or the install-plan
API below). Its node appears in every flow editor under **"Installed extensions"**.

```jsonc
{
  "formatVersion": 2,
  "package": {
    "id": "com.acme.media-tools",        // must extend publisherId
    "kind": "extension",                 // application | extension | node-library | bundle
    "version": "1.4.0",                  // exact semver
    "publisherId": "com.acme",
    "displayName": "Acme Media Tools"
  },
  "contributions": {
    "flowNodes": [{
      "schemaVersion": 1,
      "type": "com.acme.media.watermark", // ≥3 dot-segments, extends publisherId
      "version": "1.0.0",
      "display": {
        "label": "Watermark text",
        "description": "Prefix a watermark line onto text",
        "iconId": "image-sparkles"        // host allowlist; unknown → default icon
      },
      "configurationSchema": {
        "type": "object",
        "properties": {
          "mark": { "type": "string", "description": "The watermark line" }
        },
        "required": ["mark"]
      },
      "handler": {
        "kind": "core-preset",            // v1 allowlist: core-preset | service-action
        "coreType": "template",
        "defaults": { "template": "© Acme — {{inputs.text}}" }
      },
      "sideEffects": "none"
    }]
  }
}
```

What happens on install:

1. The package is **reviewed first** — the server validates it, resolves its
   dependencies, and shows the contributed nodes before anything commits.
2. Its node definitions persist (digest-tracked, one owner per contributed type).
3. The flow editor lists them (no rebuild — the palette reads the registry live).
4. Flows using them compile server-side and run in **FormLogic Cloud and the browser**
   (see "Where nodes run" below).

---

## Quickstart: a service-backed extension

A `core-preset` node lowers to a built-in. When your node needs to *call something* — an
image API, a transcription service — use a `service-action` handler. The package names a
**slot** and the action it needs; the person installing it decides which service fills that
slot. That separation is what makes the package portable and keeps credentials out of it
entirely.

```jsonc
{
  "formatVersion": 2,
  "package": {
    "id": "com.acme.vision", "kind": "extension", "version": "1.0.0",
    "publisherId": "com.acme", "displayName": "Acme Vision"
  },
  "contributions": {
    "flowNodes": [{
      "schemaVersion": 1,
      "type": "com.acme.vision.generate-image",
      "version": "1.0.0",
      "display": { "label": "Generate image" },
      // The node's configuration IS the action input, so shape it like the action's
      // inputSchema. The host re-validates against that schema at invocation.
      "configurationSchema": {
        "type": "object",
        "properties": {
          "prompt": { "type": "string" },
          "size":   { "type": "string", "enum": ["1024x1024", "512x512"] }
        },
        "required": ["prompt"]
      },
      "handler": {
        "kind": "service-action",
        "bindingSlot": "imageGenerator",   // your name for the dependency
        "requiredAction": "generate-image" // the action id the slot must provide
      },
      "sideEffects": "external-write"
    }]
  },
  // Declare every slot your nodes reference. Only declared slots can be bound.
  "requirements": {
    "services": [
      { "slot": "imageGenerator", "required": true, "requiredActions": ["generate-image"] }
    ]
  }
}
```

After installing, the owner opens **Packs → Installed → Details** and binds
`imageGenerator` to a service and a connection. Until they do, flows using the node refuse
to compile with `binding_unresolved` naming the slot — the node is never silently broken at
run time. Once bound, the compiler lowers it to the canonical `service_action`, taking the
service and connection from the binding and the action id from your definition.

### Supplying the service from a plugin

The slot can be filled by a built-in service or by one a **Desktop plugin** contributes. A
`schemaVersion: 3` plugin manifest points at Service Definition files:

```jsonc
// manifest.json
{
  "schemaVersion": 3,
  "id": "acme-vision-host",
  "name": "Acme Vision Host",
  "version": "1.0.0",
  "entry": { "kind": "process", "command": "acme-vision-host.exe" },
  "serviceDefinitions": [{ "definitionFile": "definitions/images.json" }]
}
```

```jsonc
// definitions/images.json — id must be the plugin id, or start with "<plugin-id>."
{
  "schemaVersion": 3,
  "id": "acme-vision-host.images",
  "name": "Acme Images",
  "version": "1.0.0",
  "actions": [{
    "id": "generate-image",                 // matches the package's requiredAction
    "title": "Generate image",
    "sideEffects": "external-write",
    "transport": { "kind": "openai-compatible", "method": "POST", "path": "/v1/images/generations" },
    "inputSchema": {
      "type": "object",
      "properties": { "prompt": { "type": "string" }, "size": { "type": "string" } },
      "required": ["prompt"]
    },
    "outputSchema": { "type": "object" }
  }]
}
```

The Desktop registers it on install and it appears in the binding picker as
*"Acme Images — from acme-vision-host"*. Note that the **transport declares a path, not a
host**: the base URL and the credential come from the connection the owner picks, so a
definition can never point your flows at an arbitrary server.

---

## Package rules (v2 aggregate)

| Rule | Detail |
|---|---|
| Identity | `package.id` and `publisherId` are lowercase dotted namespaces (≥2 segments); the package id **must extend** its publisherId (`com.acme` → `com.acme.media-tools`). |
| Versions | Exact semver everywhere; dependency **ranges** use the small v1 grammar: `X.Y.Z` \| `^X.Y.Z` \| `~X.Y.Z` \| `>=X.Y.Z` (npm-style caret-zero rule; prereleases match only an identical exact). |
| Non-empty | A package must carry at least one content item, contribution, requirement, or distribution. |
| Fail closed | Unknown fields are rejected at every level. The one exception: invalid `uiHints` entries (presentation-only) are dropped, never fatal. |
| One active version | Per package id, per owner. Re-importing a **different** version proposes an update (see below); re-importing the same version refuses. |
| Contributed types | Owned by exactly one installed package — a second package contributing the same type refuses, never first-provider-wins. |
| Dependencies | `dependencies.packages[]` resolve against your **installed** packages at install time; a missing or incompatible required dependency refuses with exactly what to install first. Satisfied dependencies are locked (exact version + edge), and a depended-upon package refuses to uninstall while required. Optional dependencies never block; an installed-but-incompatible optional still refuses. |
| Not yet installable | `content.pack` inside v2, `serviceDistributions`, and archive entry-path contributions each refuse with a typed message (`unsupported_content`, `unsupported_distributions`, `unsupported_entry_path`). Deliver app content as Pack v1 for now. |

## Flow Node Definition rules (v1)

| Field | Rules |
|---|---|
| `type` | ≥3 dot-segments, must extend the package's `publisherId`. Core node types are dot-free, so shadowing is structurally impossible. |
| `display` | `label` required (≤80 chars); `iconId` from the host allowlist (`bot`, `boxes`, `database`, `file-text`, `image`, `image-sparkles`, `layers`, `message-square`, `mic`, `puzzle`, `send`, `sparkles`, `wand`, `workflow`) — anything else renders the default. |
| `ports` | ≤32; `direction` input/output; `kind` control/data; only **data** ports may declare a `schema`; ids unique case-insensitively. |
| Schemas | The **declaration subset** (deliberately tighter than the runtime validator): structural keywords `type properties required additionalProperties items enum const minLength maxLength minimum maximum`, annotations `title description default examples`, `$ref` only from the local allowlist (`formlogic://schemas/artifact-ref.json`), and `x-artifactKinds`. Depth ≤8, ≤64 properties per object, ≤64 enum entries. Anything else fails closed. |
| `configurationSchema` | Must declare `"type": "object"`. Its `properties` become the node's settings fields (`title` → label, `description` → help, `default`, `enum` → select); `uiHints` may pick the widget (`text`/`textarea`/`number`/`checkbox`/`select`/`json`). `required` keys are enforced at compile. |
| `handler` | v1 allowlist: **`core-preset`** (lowers to an existing core node; `defaults` merge *under* the author's values) and **`service-action`** (declares a binding slot + action — accepted at install, **not yet runnable**). The later kinds (`connector-action`, `subflow`, `quickjs`, `hosted-action`) are rejected with the distinct code `handler_kind_not_enabled`. |
| `sideEffects` | Required: `none` \| `read` \| `external-write` \| `destructive`. |
| `availability` / `requiredGrants` | Requests only — effective availability/permissions are always host-derived; a definition cannot under-declare its way past review. |

---

## Installing: the install-plan API

Every install is **review-first**. The v2 lane uses install plans — owner-bound,
expiring (15 min), single-use, digest-bound:

```
POST /api/packages/install-plans
     { "package": { …v2 aggregate… }, "signature"?, "alg"? }
  →  201 { planId, planDigest, expiresInSeconds, trust, capabilities, resolution }

POST /api/packages/install-plans/{planId}/confirm
     { "planDigest": "<echo what you reviewed>", "approvedConnectorGrants": [] }
  →  201 { installationId, packageId, nodeTypes, … }

GET  /api/packages/install-plans/{planId}          — the stored review
POST /api/packages/install-plans/{planId}/cancel   — discard
```

Key properties:

- **What you review is what installs** — propose stores the exact reviewed bytes
  server-side; confirm installs *those* bytes, and the echoed `planDigest` proves you
  reviewed this plan.
- **The world is re-checked at confirm** — dependencies re-resolve against current
  installed state; a stale plan fails cleanly (`plan_not_confirmable` /
  `unresolved_dependencies`) and is terminal — re-propose to retry.
- **`approvedConnectorGrants` is always required** (an empty array approves none) —
  omission is a 400, never "activate everything".
- Signature/trust semantics match the import lane: Ed25519 → `official`, HS256 →
  `local-only`, unsigned → `community`, present-but-invalid → rejected by default.

The Packs UI drives this flow automatically (upload a v2 JSON → the review *is* the
proposed plan → Import confirms it). Pack **v1** sources currently use the direct
describe→import lane with the same grant-review requirement.

### Delivering as an archive

A package can ship as a `.formlogic` archive instead of one JSON document. `pack.json` holds
the aggregate, and `contributions.flowNodes[]` may then reference **entry paths** rather than
inlining definitions:

```jsonc
// pack.json
"contributions": { "flowNodes": ["flow-nodes/greet.json", "flow-nodes/upscale.json"] }
```

`POST /api/packages/install-plans` and `POST /api/packs/describe` both accept the archive as a
multipart `file` upload. Entry paths are resolved **once, at parse**, so the review, the stored
plan, its digest, and the install all see the same fully inlined aggregate — reviewing an
archive and installing it cannot diverge.

Rules:

- A reference must be **package-relative** with no `..` — and must exist in the archive.
- In a **signed** package, every referenced entry must be **covered by the signature**.
  Otherwise a signed archive could be extended with unsigned definitions after signing and
  still verify. Unsigned archives have no coverage set, so the rule does not apply to them.
- A referenced file that is not valid JSON is refused, never skipped.
- JSON delivery must still inline its definitions (`unsupported_entry_path`) — there is no
  archive to resolve against.

## Updating

Importing a **different version of an already-installed package id** proposes an
**update plan** — propose returns `action: "update"` plus `installedVersion`, and the
UI labels the commit "Update extension". Confirm applies it atomically:

- The installation keeps its **identity** (same installation id, dependency edges from
  dependents stay attached) and its receipt records `updatedFrom`.
- The **publisher cannot change** (`publisher_mismatch`) — a different publisher
  shipping an installed package id is a hijack, not an update.
- Every **dependent's declared range must still be satisfied** by the new version, or
  the update refuses (`update_blocked`, dependents + ranges named). Satisfied
  dependents re-lock their edges to the new version.
- Contributed definitions are **replaced wholesale**: bumped nodes re-digest, removed
  nodes leave stored flow nodes as read-only placeholders, added nodes must not
  collide with another package's types.
- A failed update **changes nothing** — the prior version stays fully active (one
  transaction), and flow revisions published before the update keep the compiled IR
  and definition locks they were pinned with, forever.

Downgrades ride the same lane (any different version), gated by the same dependent-range
checks.

## Inspecting an installed extension

```
GET /api/package-installations/{installationId}
  →  200 { installation: { packageId, publisherId, version, state, source, installedAt,
                           receipt, nodes[], dependencies[], dependents[] } }
```

`receipt` is the **immutable install receipt** (package meta, contribution digests, the
dependency versions each range locked to, and the reviewed connector grants —
plus `updatedFrom` after an update). `nodes[]` carries each contributed type with the
digest the compiler locks against. The two dependency directions are both reported:
`dependencies[]` is what this package requires, `dependents[]` is what requires it —
the latter is what blocks an uninstall and constrains which versions an update may
move to. This is a **management** surface: it stays readable even when the
`APPLICATION_PACKAGES_V2` kill switch is off.

The Packs UI renders this under **Details** on each installed extension.

## Where services come from

A binding points at a **service definition**. Two sources feed one registry, and the whole
system — the catalog the browser lists, `service_action` resolution, every flow run — reads
that one composed view:

| Source | How |
|---|---|
| **Built-in** | Ships with FormLogic Desktop (`openai-api`, `openai-codex-agent`). |
| **Desktop plugin** | A `schemaVersion: 3` plugin manifest declares `serviceDefinitions[].definitionFile` — package-relative paths to Service Definition v3 JSON. |

Contribution rules (the registry enforces all of them):

- A contributed definition **cannot shadow a built-in** — that would silently re-point every
  flow already bound to it.
- A definition id is **namespaced to its plugin** (`<plugin-id>` or `<plugin-id>.<name>`), so
  provenance is readable from the id and two plugins cannot race for a generic name.
- **One plugin owns an id.** A second plugin claiming it is refused, not first-wins.
- One malformed definition is refused **without costing its valid siblings**, and a
  definition over 64 KiB is refused outright — every catalog fetch would carry it.
- The catalog stamps each contributed entry with `provider` (the plugin id), so a
  plugin-supplied service is never indistinguishable from a built-in in a picker. The **host**
  stamps it from its registry: a definition file claiming a `provider` cannot fake provenance.
- Contributions **live and die with their plugin**: disabling or uninstalling removes them
  immediately, and re-enabling restores them. Re-registering replaces a plugin's previous set,
  so a definition it stops shipping disappears rather than lingering.

## Service slots and bindings

A `service-action` node never names a concrete service. It names a **slot** plus the action
it needs:

```jsonc
"handler": { "kind": "service-action", "bindingSlot": "imageGenerator", "requiredAction": "generate-image" }
```

and the package declares that slot in `requirements.services[]`. The slot is your portable
request; the **binding** is the installing owner's answer — which service definition fills
it, on which connection:

```
GET    /api/package-installations/{id}/service-bindings          → { slots: [{ slot, required, requiredActions, binding }] }
PUT    /api/package-installations/{id}/service-bindings/{slot}   { definitionId, connection }
DELETE /api/package-installations/{id}/service-bindings/{slot}
```

Rules:

- Only a **declared** slot can be bound (`unknown_slot`) — a binding can never grant reach
  the install review did not show.
- `connection` is an opaque Desktop provider-profile id. **Packages never carry credentials**,
  and this API never sees one. The UI offers the paired Desktop's configured providers as a
  list (both here and on the `service_action` node), falling back to a typed id only when
  there is nothing to offer.
- While a slot is unbound, every node using it fails compilation with `binding_unresolved`
  naming the slot. Fail-closed by design: a run that could only fail is never produced.
- Once bound, the compiler lowers the node to the canonical `service_action` — `definitionId`
  and `connection` from the binding, `actionId` from the definition's `requiredAction`, and
  the node's own configuration as the action input. **Author `configurationSchema` to match
  the action's `inputSchema`**; the host re-validates against the action's declared schema at
  invocation, so a mismatch fails typed (`input_invalid`) rather than sending a wrong shape.
- The binding is pinned into the revision's definition lock, so re-binding later is visible
  as a different lock rather than a silent swap under an already-published flow.
- Uninstalling removes the bindings with the installation — no orphaned grants survive.
- **Updating** keeps bindings for slots the new version still declares (a patch release does
  not make you re-choose), and **drops** bindings for slots it no longer declares. A later
  version re-declaring that slot name comes back **unbound** — a binding is never silently
  resurrected for a purpose the owner did not re-approve.

The Packs UI renders slots under **Details** on the installed extension, offering only
services whose actions satisfy the slot.

## Uninstalling

- Removes the package's contributed node definitions. Flows already using them keep
  their nodes as **read-only placeholders** (graph data always survives) and runs
  refuse with `invalid_flow` until the extension is reinstalled.
- A package **required by another installed package refuses to uninstall**
  (409 `uninstall_blocked`, dependents named) — remove the dependents first. The
  Details panel shows those dependents before you commit.

---

## Where nodes run

Contributed nodes never execute directly. The **server compiler** lowers them to the
canonical core node set, pinning a definition lock (package, definition version,
digest, lowering target) to each immutable flow revision:

| Surface | core-preset nodes | service-action nodes |
|---|---|---|
| Flow editor | Full: palette (Installed extensions), insert, configure, lint | Full — the palette entry notes that its slot must be bound |
| FormLogic Cloud runs | ✅ execute the revision's compiled IR | Compiles once bound, but Cloud cannot execute `service_action` (`cloud_unsupported_node` at preflight) |
| Browser runs (live, test, flow_call children) | ✅ fetch + execute the compiled IR (`POST /api/flows/{id}/compile`) | ✅ once the slot is bound — via the paired same-machine Desktop |
| FormLogic Desktop runs | ✅ the flow snapshot delivers the compiled IR (requires an up-to-date Desktop build; older builds fail the node typed as unknown) | ✅ once the slot is bound — the Desktop's ServiceActionHost executes it |

Operational note: the whole v2 plane sits behind the `APPLICATION_PACKAGES_V2` kill switch
(default on). Setting it to `false` disables installs and definition serving — installed
content stays listed and removable, stored graphs degrade to placeholders, and already-pinned
compiled IR keeps executing.

Notes for authors:

- A `core-preset` must lower to a node the target surface supports — e.g. FormLogic
  Cloud's v1 subset is `input output template formlogic_* llm_chat http_request
  connector_request flow_call`.
- `defaults` merge **under** the user's authored values (the user always wins).
- Required configuration keys missing after that merge block compilation
  (`missing_config`).

## Troubleshooting (error codes)

| Code | Meaning / fix |
|---|---|
| `grant_review_required` | Send `approvedConnectorGrants` (array; `[]` approves none) on every import/confirm. |
| `invalid_package` + issues | The aggregate failed validation — each issue carries a code and JSON path; the fixture corpus shows valid shapes. |
| `unresolved_dependencies` | A required dependency is missing or the installed version is outside the declared range — the message names it. |
| `unsupported_content` / `unsupported_distributions` | The aggregate uses a v2 feature this release cannot install yet. |
| `unsupported_entry_path` | Entry-path contributions need archive delivery — inline the definitions, or ship a `.formlogic` archive. |
| `handler_kind_not_enabled` | The definition uses a later handler kind — requires a newer FormLogic. |
| `uninstall_blocked` | Another installed package requires this one; uninstall the named dependents first. |
| `update_blocked` | The new version escapes a dependent's declared range — update or remove the named dependents first. |
| `publisher_mismatch` | The update is signed by a different publisher than the installed package — refused. |
| `plan_not_confirmable` / `plan_digest_mismatch` | The plan expired, was used/cancelled, or the digest is not the one you reviewed — re-propose. |
| `missing_definition` (compile) | A flow uses a contributed type that is no longer installed/enabled. |
| `binding_unresolved` (compile) | The node is a `service-action` — not runnable until service bindings ship. |
