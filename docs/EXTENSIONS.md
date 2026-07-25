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

## Dependencies

A package may declare packages it needs:

```jsonc
"dependencies": {
  "packages": [
    { "id": "com.formlogic.ai-toolkit", "version": "^1.1.0" }
  ]
}
```

If a required dependency is not installed, the install plan looks for it **in the marketplace
catalog** and adds it to the plan — dependencies first, in install order. The review names every
package the install will bring before anything commits.

The rules are deliberately conservative, because auto-install is one step away from a silent
bulk installer:

| Situation | What happens |
|---|---|
| Required, missing, in the catalog | Planned and installed first |
| Required, missing, **not** in the catalog | Refused: `dependency_unavailable`, naming the id |
| Required, installed, incompatible version | Refused: `dependency_incompatible` — replacing a version something else may rely on is an **update**, reviewed on its own terms |
| **Optional**, missing | Left alone. Optional means the owner chooses; filling it in for them is not help |
| Already satisfied | Nothing planned |
| A cycle | Refused: `dependency_cycle`, naming the ring |

Two things worth being explicit about:

- **A dependency's grants are not granted by approving the package that wanted it.** Dependencies
  install with no connector access. If one needs access, you grant it deliberately, to it.
- **Dependencies are re-resolved at confirm, not replayed from the plan.** Something in the chain
  may have been installed by hand since the plan was proposed, and installing it twice would fail.

Once installed, a dependency cannot be uninstalled while something still requires it — the
existing reference counting applies, and the refusal names the dependents.

## In the marketplace

Application Package v2 extensions are listed in the **same catalog** as Pack v1 packs — from a
user's side, "browse what I can install" is one question, not two.

A listing declares which format it is, and that is read from the payload's own `formatVersion`
rather than inferred from its shape. The distinction is load-bearing: a v1 pack imports directly,
while a v2 aggregate goes through **propose → confirm** (validation, dependency resolution, and a
review of the connector grants and service slots it asks for). Installing one down the other's
lane would run the wrong thing, so the client routes on the declared format.

Consequences you will see:

- An extension is measured in **contributed flow nodes**, not forms and apps. A node-only
  extension has neither, and "0 forms · 0 apps" says nothing about what it gives you.
- `package.keywords` becomes the listing's searchable tags. A package says how it wants to be
  found once, in its own manifest, instead of in a separate listing maintained beside it.
- Search matches **tags as well as name and description**. A keyword you cannot type into the
  search box is decoration — you would have to already know the tag exists to find its chip.

## Being found: keywords

A package may declare search keywords:

```jsonc
"package": {
  "id": "com.acme.vision", "kind": "extension", "version": "1.0.0",
  "publisherId": "com.acme", "displayName": "Acme Vision",
  "keywords": ["ai", "image", "text-to-speech"]
}
```

The grammar is deliberately narrow — **lowercase letters, digits and hyphens, 1–32 characters,
at most 16 entries** — and anything else is refused with `bad_keywords`. Free-form keywords look
friendlier but make search worse: `Text To Speech`, `text-to-speech` and `TextToSpeech` become
three different terms for one idea, and an unbounded list is an invitation to stuff it. One
spelling per idea means two authors who mean the same thing are found by the same query.

## Where a node appears in the palette

A node definition may ask for a section with `display.category`:

```jsonc
"display": { "label": "LLM Chat", "category": "AI", "iconId": "message-square" }
```

This is matched against the host's existing sections (by id or label, case-insensitively) —
`AI`, `Logic`, `Input / Output`, `FormLogic data`, `Connectors`, `Flow storage`. Anything
unrecognised lands under **Installed extensions**, which is accurate rather than a failure.

It is an allowlist for the same reason icons are: the palette's section list is shared by every
package, and an author who could invent sections could fragment it or push their own to the top.
Asking to sit beside the other AI nodes is a reasonable request; inventing a section is not.
Note that `Requires FormLogic Desktop` cannot be claimed at all — that section means "needs a
local Desktop service", which is a host fact about how the node runs, not a label to choose.

Separately, **users can group nodes however they like** in their own palette (the ⚙ control in
the node panel). That is a personal arrangement stored on their device, and deliberately not
something a package can set or see.

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

## Activation: what "installed" actually means

A package is not one thing. It can contribute flow-node definitions that live in the cloud, web
content, and (later) a signed distribution staged on a **device**. Committing those one at a time
and calling it done is how you get a half-installed package: the nodes appear in the editor, the
service they need is still staging, and the first run fails in a way nobody can act on.

So an install commits its components **provisionally** and activates them **together**, once
every required component has passed a health check:

| Component state | Meaning |
|---|---|
| `provisional` | Written, not yet proven. Never visible to consumers. |
| `pending` | A device component whose device has not reported. Not a failure — an offline laptop is a normal condition, and the install waits. |
| `active` | Proven healthy and visible. |
| `failed` | Health refused. A **required** failure refuses the whole activation; an **optional** one is recorded and the rest proceed. |

Consequences worth knowing as an author:

- Until an installation is active, it contributes **nothing** — `/api/flow-node-definitions`
  omits its nodes, so the editor never offers a node whose backing parts are not ready.
- Activation is one transaction: either every component flips to active or none does. There is
  no window in which a consumer sees an inconsistent set.
- Retrying an activation that already succeeded is a **no-op**, not a second install.
- The health check for cloud nodes is real: every stored definition must decode and agree with
  its own stored type, which catches a truncated write before a node reaches the editor.
- An **update** re-declares its components. A component the previous version had and the new one
  does not cannot survive to gate — or falsely satisfy — the update.
- Installations from before this existed have no component rows and read as **active**. A record
  that was never written is not a refusal.

The installed-extension **Details** panel names the blocking component and why.

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
- A plugin's declared set applies **atomically**: if any definition is refused, none are
  applied and the plugin keeps whatever it had. Half a set is a state neither you nor the
  installing user can reason about — the missing service surfaces later as a binding that
  will not resolve. Every reason is reported at once so the packaging error is fixable in
  one pass. A definition over 64 KiB is refused outright; every catalog fetch carries it.
- The catalog stamps each contributed entry with `provider` (the plugin id), so a
  plugin-supplied service is never indistinguishable from a built-in in a picker. The **host**
  stamps it from its registry: a definition file claiming a `provider` cannot fake provenance.
- Contributions **live and die with their plugin**: disabling or uninstalling removes them
  immediately, and re-enabling restores them. Re-registering replaces a plugin's previous set,
  so a definition it stops shipping disappears rather than lingering.

### Transports: where an action's address comes from

An action declares a **transport**. Two are executable today, and they differ in exactly one
important way — where the base URL comes from:

| Transport | Reaches | Bounded by | Status |
|---|---|---|---|
| `openai-compatible` | A provider profile's `/v1/*` surface | The connection the owner bound; the Desktop gateway holds the credential | enabled |
| `managed-process-http` | One supervised local process | The registry's port for the named service; loopback only | enabled |
| `plugin-command` | One installed plugin's declared commands | The plugin that **contributed** the definition, and only commands its manifest declares | enabled |
| `stdio-jsonrpc` | A spawned child process's stdio | — | gated off |
| streaming lanes | A long-lived duplex channel | — | gated off |

The last two are **named** rather than silently absent: writing one gets a typed refusal saying
the transport exists and is not enabled, which is actionable, instead of "unknown transport",
which reads like a typo. They are separate gates because they carry genuinely different risk — a
spawned child process and a duplex stream are not one feature.

Note that an action declaring `streaming: { mode: "sse" }` is **not** gated: a declared streaming
mode is a capability, not a requirement, and such an action returns a complete response when
nobody asks for a stream.

In no case does a definition author supply a host. That is deliberate and load-bearing:
there is no field an author could write that would aim a flow at an internal address, a cloud
metadata endpoint, or the wider network, so the SSRF surface is closed by construction rather
than by a blocklist that has to keep up. Both lanes also refuse `..`, query strings, fragments,
backslashes and protocol-relative paths — a declared route is a route, not a place to smuggle
parameters.

```jsonc
"transport": {
  "kind": "managed-process-http",
  "serviceId": "acme-renderer",   // a service THIS Desktop supervises
  "method": "POST",
  "path": "/render"
}
```

For `plugin-command`, the action names a command and nothing else — a command addresses a name,
not a route, so declaring a path is refused:

```jsonc
"transport": { "kind": "plugin-command", "command": "tools.run" }
```

Two containment rules apply, and neither is taken on trust from the definition:

- **The plugin is whoever contributed the definition.** It is read from the registry's record,
  never from the transport block, so a definition cannot reach into another plugin's commands
  (a `pluginId` written there is simply not read), and a host built-in cannot use this transport
  at all — there would be no contributing plugin to be bounded by.
- **The command must be one the plugin's own manifest declares.** The manifest is what the user
  reviewed at install; a definition file shipped alongside it must not be able to widen that
  surface afterwards.

Behaviour worth knowing:

- **A stopped service refuses.** It is never auto-started. If the owner stopped it, a flow
  quietly restarting it would override a decision they made on purpose; the refusal names the
  service and tells them where to start it.
- **A binary response becomes an artifact.** A JSON response is validated against the action's
  `outputSchema` as usual; a non-JSON response (an image, an audio file) is stored on that device
  and the node receives an
  [ArtifactRef](contracts/artifact-ref.v1.schema.json) with `locality: "device"`. Large binary
  data never travels in-band, so it cannot end up inside a flow revision or a run log — and the
  bytes are not silently uploaded anywhere.
- **Errors are redacted.** A managed process's error body is third-party text that can echo back
  what it was given. Anything credential-shaped is stripped before it reaches a run log, and the
  body is truncated.
- **Size and time are capped** on both lanes; the artifact lane has its own larger ceiling.


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

### What a binding actually authorizes

Binding a slot is not just bookkeeping — it is the **authorization** that lets a browser
invoke that service on the owner's Desktop. Before service slots existed, a two-entry list
of host built-ins (`openai-api`, `openai-codex-agent`) was compiled into the backend and
mirrored in the browser client, so a plugin-contributed service could never be invoked from
a browser at all, however legitimately it was installed and registered.

Authorization is now derived from live installed state, and the derived grants are the same
`service.<definition>.<action>` strings the Desktop already enforces:

| Definition | Authorized when | Actions granted |
|---|---|---|
| Host built-in | always | the built-in's own action list |
| Anything else | the owner bound an installed package's declared slot to it | the union of that slot's `requiredActions` and the `handler.requiredAction` of every enabled node bound to it |

The action set comes from both halves deliberately. `requiredActions` is what install review
displayed; `handler.requiredAction` is what the compiler actually lowers. Taking only the
first would let a node compile to a call the capability refuses; taking only the second would
let a node widen past what the owner reviewed. A bound slot that resolves to **no** actions
authorizes nothing rather than the whole service.

Because capability tokens are short-lived but not instantaneous, the events that remove the
justification — unbinding, re-binding the slot elsewhere, uninstalling — **revoke live tokens
immediately** rather than letting them run out their TTL. Unauthorized, unknown, and
malformed definition ids all get the identical refusal, so the response cannot be used to
probe which is which.

## Installing on a Desktop

A package that ships a signed **distribution** — a service binary, a plugin — has work to do on a
device, and the device is the only thing that can say whether that work succeeded. Three records
are involved, and keeping them separate is what makes the awkward cases legible:

| Record | Owns | Lives |
|---|---|---|
| Install job | who may do the work, progress, outcome | backend |
| Ledger | what this machine has, wants, and is waiting on | device |
| Audit | every step that was attempted, including refusals | device |

What an author (and an operator) should expect:

- **Local confirmation is required by default.** A native install is not something a device does
  because a server said so. Nothing is even downloaded until someone on that machine answers —
  asking after a half-gigabyte transfer wastes bandwidth on something they may decline. A package
  cannot waive this; only the operator can.
- **Verification precedes trust.** Declared size is checked before the download, the digest
  before anything is unpacked. A digest mismatch is a **tamper**: it is never retried and never
  staged "pending investigation".
- **A partial install is never healthy.** Staging is its own recorded state and reports as
  unusable. A component becomes usable only after it installs *and* passes health. A pipeline
  interrupted anywhere leaves `Staged` or `Failed`, never a half-thing that reads as working.
- **A failed update keeps the previous version.** Rollback restores what was there and the report
  says which version the device is actually running — the most useful fact in a failure.
- **Shared components are protected.** Removing a package does not remove a component another
  installation still consumes; the refusal names who still needs it. A user **pin** outranks the
  reconciler entirely, even at zero consumers.
- **Offline removals wait as tombstones.** A removal requested while a device was offline stays
  queued (idempotent by job id, surviving restarts) until that device does it and reports back.
  Readiness is per-device by definition: the same package can be live on a desktop and still
  staging on a laptop.
- **Native privileges are not action grants.** A package's connector grants say what its *flows*
  may reach. They say nothing about whether a machine will run an installer — different question,
  different blast radius.

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

## Performance budgets

The paths every install and every flow save go through are budgeted, and the budgets are
enforced by tests (`PackagePerformanceTest`):

| Path | Size | Budget |
|---|---|---|
| Validate a package | 64 contributed definitions (the schema maximum) | 1500 ms |
| Compile a flow | 500 nodes, half of them contributed | 1500 ms |
| Resolve dependencies | 200 declared dependencies | 500 ms |

The budgets are deliberately loose — several times the observed cost — because they exist to
catch a change in *complexity*, not normal variance on a busy machine. A separate test pins
that compilation stays **linear** in graph size, which is the thing a wall-clock budget cannot
express: quadratic work hides comfortably inside a generous budget until graphs get large.

## Troubleshooting (error codes)

| Code | Meaning / fix |
|---|---|
| `grant_review_required` | Send `approvedConnectorGrants` (array; `[]` approves none) on every import/confirm. |
| `invalid_package` + issues | The aggregate failed validation — each issue carries a code and JSON path; the fixture corpus shows valid shapes. |
| `unresolved_dependencies` | A required dependency is missing or the installed version is outside the declared range — the message names it. |
| `unsupported_content` / `unsupported_distributions` | The aggregate uses a v2 feature this release cannot install yet. Distribution descriptors are still **verified** — see `invalid_distribution`. |
| `invalid_distribution` | A `serviceDistributions[]` entry is malformed: unknown `runtimeKind`, bad sha256, oversized artifact, or a path that escapes staging. Fixable now, before staging ships. |
| `unsupported_entry_path` | Entry-path contributions need archive delivery — inline the definitions, or ship a `.formlogic` archive. |
| `handler_kind_not_enabled` | The definition uses a later handler kind — requires a newer FormLogic. |
| `uninstall_blocked` | Another installed package requires this one; uninstall the named dependents first. |
| `update_blocked` | The new version escapes a dependent's declared range — update or remove the named dependents first. |
| `publisher_mismatch` | The update is signed by a different publisher than the installed package — refused. |
| `plan_not_confirmable` / `plan_digest_mismatch` | The plan expired, was used/cancelled, or the digest is not the one you reviewed — re-propose. |
| `missing_definition` (compile) | A flow uses a contributed type that is no longer installed/enabled. |
| `data_input_unsatisfied` (compile) | A required data input has no producer and no configured value — the node could never become ready. |
| `data_cycle` (compile) | Data dependencies form a ring; every node in it waits for the next, so the flow can never start. |
| `data_fan_in_ambiguous` (compile) | Two producers feed one input — which value won would depend on arrival order. |
| `binding_unresolved` (compile) | The node is a `service-action` — not runnable until service bindings ship. |
