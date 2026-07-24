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

## Package rules (v2 aggregate)

| Rule | Detail |
|---|---|
| Identity | `package.id` and `publisherId` are lowercase dotted namespaces (≥2 segments); the package id **must extend** its publisherId (`com.acme` → `com.acme.media-tools`). |
| Versions | Exact semver everywhere; dependency **ranges** use the small v1 grammar: `X.Y.Z` \| `^X.Y.Z` \| `~X.Y.Z` \| `>=X.Y.Z` (npm-style caret-zero rule; prereleases match only an identical exact). |
| Non-empty | A package must carry at least one content item, contribution, requirement, or distribution. |
| Fail closed | Unknown fields are rejected at every level. The one exception: invalid `uiHints` entries (presentation-only) are dropped, never fatal. |
| One active version | Per package id, per owner. Reinstalling requires uninstalling first (updates land in a later release). |
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

## Uninstalling

- Removes the package's contributed node definitions. Flows already using them keep
  their nodes as **read-only placeholders** (graph data always survives) and runs
  refuse with `invalid_flow` until the extension is reinstalled.
- A package **required by another installed package refuses to uninstall**
  (409 `uninstall_blocked`, dependents named) — remove the dependents first.

---

## Where nodes run

Contributed nodes never execute directly. The **server compiler** lowers them to the
canonical core node set, pinning a definition lock (package, definition version,
digest, lowering target) to each immutable flow revision:

| Surface | core-preset nodes | service-action nodes |
|---|---|---|
| Flow editor | Full: palette (Installed extensions), insert, configure, lint | Visible, disabled ("not yet runnable") |
| FormLogic Cloud runs | ✅ execute the revision's compiled IR | Typed refusal (`binding_unresolved` at compile; `cloud_unsupported_node` at preflight) |
| Browser runs (live, test, flow_call children) | ✅ fetch + execute the compiled IR (`POST /api/flows/{id}/compile`) | Typed refusal |
| FormLogic Desktop runs | Not yet — arrives with snapshot-delivered IR | Not yet |

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
| `unsupported_content` / `unsupported_distributions` / `unsupported_entry_path` | The aggregate uses a v2 feature this release cannot install yet. |
| `handler_kind_not_enabled` | The definition uses a later handler kind — requires a newer FormLogic. |
| `uninstall_blocked` | Another installed package requires this one; uninstall the named dependents first. |
| `plan_not_confirmable` / `plan_digest_mismatch` | The plan expired, was used/cancelled, or the digest is not the one you reviewed — re-propose. |
| `missing_definition` (compile) | A flow uses a contributed type that is no longer installed/enabled. |
| `binding_unresolved` (compile) | The node is a `service-action` — not runnable until service bindings ship. |
