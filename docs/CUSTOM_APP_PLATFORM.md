# Custom App Platform

The Custom App Platform is the web layer that turns a FormLogic app into a
runnable, distributable product: sandboxed app logic, a permission-aware SDK,
abstract connectors (including the phone's own device abilities), a portable
signed application package, a signed client manifest for the native runtime, a
marketplace trust layer, custom-domain launch, and the MineCab reference app
that proves it end-to-end.

This document consolidates eight previously separate design notes into one
place. The authoritative master design lives in `docs/CUSTOM_APP_SPEC.md`; the
sandbox internals are covered in [[formlogic-quickjs-runtime]] and the
desktop/mobile shell in [[NATIVE_RUNTIME_TAURI]].

## Contents

- [App Logic (QuickJS)](#app-logic-quickjs)
- [FormLogic SDK](#formlogic-sdk)
- [Connectors](#connectors)
- [Application Package Format](#application-package-format)
- [Client Manifest](#client-manifest)
- [Marketplace](#marketplace)
- [Custom Domains & App Launch](#custom-domains--app-launch)
- [Multi-App over Shared Forms](#multi-app-over-shared-forms)
- [Per-App Customization & Custom Code](#per-app-customization--custom-code)
- [MineCab Reference App](#minecab-reference-app)

---

## App Logic (QuickJS)

Status: **implemented** (app-level + form-level). See `docs/CUSTOM_APP_SPEC.md` §31–37 for the original design.

### What it is

Sandboxed JavaScript that runs *inside the app runtime* to customize behavior — prefill fields
from a connector, warn or block a submission, react to lifecycle events — without giving the
script any real IO. The rule (spec §65):

> **QuickJS scripts describe safe *effects*; the trusted host applies those effects after permission checks.**

Scripts run in the **same** QuickJS WASM sandbox as form expressions (empty globals, no
`window`/`fetch`/native bridge, memory/stack/time budgets). See [[formlogic-quickjs-runtime]].

### Authoring

A script is `function run(ctx) { … }` and returns a result object:

```js
function run(ctx) {
  if (Number(ctx.answers.fuel_percent || 0) < 15) {
    return { reject: true, message: "Fuel is too low to start this shift." };
  }
  return { ok: true };
}
```

`ctx` = `{ hook, answers, values, params, meta, event }`. Result may contain `effects[]`, a
`ui` shorthand (`setValues`/`toast`/`navigate`), `reject`/`message`, `warnings[]`.

#### Hooks
`onAppStart`, `onScreenEnter`, `onScreenLeave`, `onButtonClick`, `onBeforeSubmit`,
`onAfterSubmit`, `onConnectorEvent`, `onSyncConflict`, `mapConnectorDataToForm`,
`calculateDashboardState`. Wired today in `AppFormView`: **onScreenEnter → onConnectorEvent**
(connector prefill) and **onBeforeSubmit / onAfterSubmit** (submit gate).

#### Effects & permissions
Every outward effect maps to a permission or the host drops it (wildcards supported):

| effect | permission |
|---|---|
| `ui.setValues` / `ui.toast` / `ui.navigate` | `ui.setValues` / `ui.toast` / `ui.navigate` |
| `connector.request` (id, command) | `connector.<id>.<command>` (e.g. `connector.vehicle.status.read`) |
| `formlogic.submitResponse` / `listResponses` | `formlogic.responses.write` / `.read` |
| `storage.*` | `storage.local` |

`reject`/`warnings`/`message` are advisory (no permission needed). The **backend re-validates
every submission** — client logic is a UX layer only.

### Storage

- App-level: `apps.custom_logic` (JSON). Runs for every form in the app.
- Form-level: `forms.custom_logic` (JSON). Runs only when that form is open (natural per-screen scoping).
- Both are size-capped (100KB) and shape-sanitized on save (`Helpers\CustomLogicSanitizer`), delivered
  in the runtime config, and merged (`useCustomAppLogic`) with form scripts appended after app scripts.

### Key files

- Types: `ui/src/types/customAppLogic.ts`
- Sandbox: `ui/src/lib/formlogic/quickjs-host.ts` (`applogic` kind), `engine.ts` (`runAppLogic`)
- Host: `ui/src/client-runtime/logic/{appLogicHost,appLogicEffects,appLogicPermissions,useCustomAppLogic}.ts`
- Integration: `ui/src/components/app-runtime/AppFormView.tsx`
- Backend: `Helpers/CustomLogicSanitizer.php`, `AppController`/`FormController` (validate), `McpController` (`update_app`)

### Authoring in-product

Owners edit app logic in **Deploy & share → App logic (QuickJS)** (`components/apps/AppLogicPanel.tsx`):
add/enable/delete scripts, set per-script + app-wide permissions, and **Test run** each script against
a sample ctx in the real QuickJS host before saving (persists via `PUT /api/apps/{id}` → sanitizer).
The whole app can be exported as a signed `.formlogic` from the **Application package** card (see the
[Application Package Format](#application-package-format) section).

### Deferred
`onSyncConflict` custom merge, `onButtonClick` custom buttons UI, a Monaco-based editor with lint.

---

## FormLogic SDK

Status: **implemented** (foundation). Spec §27–28. Location: `formlogic/ui/src/sdk/`.

A thin, permission-aware wrapper over the app runtime store so custom screens / AI-generated UI can
read app data and act on it without touching raw endpoints, the runtime store internals, or the
native bridge. The server stays authoritative on every write.

### Import

```ts
import { useConnector, useSubmitResponse, ConnectorStatus, PermissionGate } from '../../sdk';
```

### Hooks

`useCurrentApp`, `useCurrentUser`, `useRole`, `usePermissions`, `useForms`, `useForm`,
`useResponses`, `useResponse`, `useSubmitResponse`, `useConnector`, `useConnectors`,
`useConnectorStatus`, `useConnectorPermission`, `useToast`, `useAppNavigation`,
`useRuntimeEnvironment`, `useNativeRuntime`, `useOfflineQueue`, `useSettings`, `useAppSettings`,
`useAppTheme`, `useAppManifest`.

- Permission-respecting: `useSubmitResponse` rejects without submit permission; `useResponses`
  resolves to `[]` when the user can't view (the store swallows a 403); `useResponse(form, id)`
  fetches a single response with the same gate.
- `useConnector('vehicle').request('status.read')` uses the native bridge when present, else the mock.
  `useConnectorStatus(id)` fetches a connector's live status; `useConnectorPermission(id, command)`
  reports whether the app is allowed to run that command.
- `useRuntimeEnvironment()` returns `{ hostMode: 'platform'|'custom-domain'|'native', nativeAvailable }`;
  `useNativeRuntime()` exposes native availability + `runtime.getInfo()` + the environment.
- `useSettings` / `useAppSettings` read app + runtime settings; `useAppTheme` returns the resolved
  theme tokens; `useAppManifest` fetches the app's signed client manifest.

### Components

`ConnectorStatus`, `SyncStatus`, `PermissionGate`, `ConnectorPermissionGate`, `ResponseList`,
`ResponseDetail`, `FormView`, `EmptyState`, `AppButton`, `SubmitButton`, `NativeRequiredNotice`,
`OfflineQueuePanel` — theme-aware, compose the hooks. Example:

```tsx
<PermissionGate permission="submit_responses" form="prestarts">
  <button onClick={startPrestart}>Start pre-start</button>
</PermissionGate>
<ResponseList form="faults" limit={5} titleField="fault_code" />
<ResponseDetail form="faults" id={faultId} />
```

- `AppButton` — a button styled with the app's primary accent; `SubmitButton` — an `AppButton`
  wired to a form via `useSubmitResponse` (async submit + busy state).
- `ResponseDetail` — one response's answers as label/value rows; `FormView` — a lightweight card
  that opens a form in the app runtime.
- `ConnectorPermissionGate` — renders children only when the connector command is granted;
  `NativeRequiredNotice` — a notice when a screen needs the native runtime and it isn't present.
- `OfflineQueuePanel` — pending/failed offline-queue counts + a "Sync now" that flushes both the
  browser and native queues.

### Relationship to the sandboxed screen SDK

The existing *sandboxed* custom-screen SDK (postMessage bridge, iframe = the boundary) is unchanged.
This SDK is for **host-rendered** React screens that run in the trusted app shell. Both expose the
same capabilities; pick by whether your screen is sandboxed code or trusted React.

#### Sandboxed bridge v1 (pack-owned screens)

App-runtime `code` screens (owner/verified trust ONLY — every bridge action below is
TRUSTED_ONLY in `sdkRuntime.ts`, including the subscription lifecycle actions) get typed,
bounded bridge methods on `window.FormLogic` beyond the original submit/records/record/related
set (`components/custom-screen/screenBridge.ts` + `screenSubscriptions.ts`):

- `connector(connectorId, command, payload?)` — invokes a connector command the app has **declared**
  (`connector.<id>.<command>` grant, the same gate as `useConnector`). Routing is **transparent**:
  with a local desktop bridge present the local transport is authoritative (its failures never
  retry remotely — a lost-response transport failure may have executed); without one, the local
  client is tried (in-browser connectors, demo simulator) and the typed pre-transport
  `connector_unavailable` falls back to the owner's command relay — so exactly one transport ever
  executes. Resolves an outcome
  `{ status: 'done'|'failed'|'expired'|'uncertain', result, error, via, handledBy? }` — command
  failures resolve (check `status`), and `uncertain` means a desktop claimed the command but hadn't
  reported back (the hardware may have acted — never treat it as a clean failure).
- `updateRecord(responseId, answers)` — updates one of this form's records through the app API
  (server-side edit permission is authoritative; payload bounded). Record screens may pass `null`
  to update the record being viewed.
- `deleteRecords(responseIds)` — deletes SPECIFIC records of this form by explicit id (max 25 per
  call, 10 calls/min; there is deliberately no clear-all). Each row is server-authorized
  individually; resolves `{ deleted: [ids], failed: [{id, error}] }` and a refused row never
  aborts the rest.
- `presence()` — one-shot desktop-presence snapshot
  `{ kind: 'local'|'remote'|'none', deviceName?, lastSeenAt? }` (demo mode is always `'none'`).
- `events.subscribe({connectorId, names?}, handler)` / `captions.subscribe(handler)` — LIVE feeds
  relayed from the host's desktop event hub and the volatile captions lane (LOCAL bridge only —
  remote mode stays records-polling; check `presence()`; refused outright in the shared demo,
  which must never attach to the operator's real desktop). Gated on the app declaring any grant
  targeting the connector (`connector.<id>...` / wildcard forms). Handlers receive
  `{ kind, seq, data }` push frames with a per-subscription monotonic `seq`; over-budget pushes
  are shed with a single `kind: 'dropped'` signal. The feed is LOSSY with no replay — the hub has
  no cursor and an SSE reconnect gap is invisible to the sandbox — so treat it as a live overlay:
  re-read records on `'dropped'` and on your own cadence; the durable plane is the source of
  truth. `captions.subscribe` additionally REQUIRES the local bridge at subscribe time (its
  reader would otherwise retry a dead loopback fetch forever); `events.subscribe` may late-bind
  (the hub connects once the desktop pairs). `captions.subscribe` resolves
  `{ unsubscribe, tombstone }` (call `tombstone()` when a durable caller turn lands, final-wins);
  max 4 live subscriptions, 1 captions, per screen.

Outside a matching app context (builder previews, public links) these actions reject with an honest
"not available on this screen". Deliberately NOT exposed (plan §8.3): raw backend fetch, arbitrary
connector commands without grants, `records.clearAll`, pack-initiated pairing-token minting.

### Trust boundary: host-rendered React is first-party only

Host-rendered SDK screens run as **trusted React inside the app shell** — there is no sandbox around
them — so they are restricted to the **first-party screen registry** (components FormLogic ships and
registers). The platform **never dynamically evaluates untrusted package React**: there is no runtime
`eval` / dynamic `import()` of component code that arrived inside an application package. If a
distributed or otherwise untrusted package needs custom UI, it must ship a **sandboxed `code` screen**
(the iframe is the security boundary) rather than an SDK screen. Widening this — running third-party
React in the trusted shell — would require **signed-package trust *and* an isolation mechanism**, and is
out of scope until both exist.

### Pack vendor signing (APP-501 first slice)

A pack may embed `pack.signing`: per-component sha256 digests of every form/app `customScreen`'s
EXECUTABLE surfaces (keyed `form:<packFormId>` / `app:<packAppId>`) plus an Ed25519 signature by a
vendor key (`ui/scripts/packSigning.mjs` signs at emit time; `PackService::packSigningVerdicts`
verifies at import). The embedded key proves nothing alone — it must be PINNED (first-party
constant in `PackService`, extendable per deployment via `FORMLOGIC_TRUSTED_PACK_PUBLISHERS`).
Effect: a DIRECT JSON import of an unmodified vendor pack stamps `custom_screen_trust='verified'`
(provenance `vendor-signed`) instead of `untrusted`; a tampered component stays `untrusted` with
provenance `verdict: 'vendor_modified'`; signing never downgrades catalog/owner trust, and the
signed-archive path keeps its own verdict. The digest is a length-delimited string recipe —
deliberately NOT canonical JSON — and `PackVendorSigningTest` recomputes every emitted marketplace
pack in PHP, locking the Node/PHP recipes together in CI.

### Deferred
An npm-published `@formlogic/sdk`; SDK version negotiation in the client manifest.
(`FormView`/`ResponseDetail`/`AppButton` — previously listed here — are now implemented; see
[Components](#components).)

---

## Connectors

*FormLogic Connect.* Status: **implemented** (mock vehicle connector, browser client + native bridge). Spec §40–46.

### Concept

An app asks a connector for **abstract commands** (e.g. vehicle `status.read`) and does not care
how the data is obtained — mock, local HTTP, Bluetooth, USB, or a vendor API. Swapping the
transport never changes the app.

### Commands (vehicle)

`identity.read`, `status.read`, `engineHours.read`, `faults.read`, `gps.read`, `production.read`.
Each connector command maps to a permission `connector.<id>.<command>`.

### Device connector — the phone's own abilities (dynamic + scriptable)

`deviceConnector.ts` (`id: 'device'`) exposes the **phone's abilities** as an abstract connector,
implemented entirely with the WebView's standard **Web APIs** — so it works identically in a plain
browser, the PWA, and the native runtime with **no native plugin and no Rust code**. Capabilities are
**feature-detected at runtime**: `commands`/`status().detail` reflect what the current device actually
exposes. Commands (permission `connector.device.<command>`):

`info.read` (platform/model/os/cores/memory via userAgentData) · `locale.read` (timezone/locale) ·
`screen.read` · `network.read` (online/effectiveType/downlink) · `battery.read` · `orientation.read` ·
`motion.read` · `gps.read` · `clipboard.write` · `wakeLock.acquire`/`release` · `vibrate`.

An app "custom connector" is just an **app-logic script** (see the [App Logic (QuickJS)](#app-logic-quickjs)
section) that emits `connector.request{connectorId:'device',command}`
effects and maps `ctx.event.result` into fields via `onConnectorEvent` — reusing the whole existing
effect/permission chain. The QuickJS sandbox stays empty (scripts never touch `navigator.*`); device
I/O runs in the trusted web layer and is gated by `connector.device.*` permissions. `?flDeviceMock`
returns deterministic values for testing. **Verify**: open `/device-check` in the runtime.

### Client (browser)

`ui/src/client-runtime/connectors/`:
- `connectorTypes.ts` — `BrowserConnector` (`preferLocal`, optional `subscribe`), `ConnectorStatusInfo`, and the `window.FormLogicNative` bridge contract.
- `deviceConnector.ts` — the **device** connector (Web-API phone abilities; `preferLocal` so it's always web-serviced).
- `vehicleConnector.ts` — the **mock** vehicle connector (realistic telemetry, no hardware).
- `localHttpConnector.ts` — **local HTTP** connector: reads a local bridge (`http://127.0.0.1:39291/status`)
  and maps the same commands; reports "unavailable" when no bridge is reachable.
- `nativeConnectorClient.ts` — `getConnectorClient()`: `preferLocal` connectors (device) are ALWAYS
  web-serviced and merged into `list()` even under the native bridge; other connectors route to the
  **native bridge when present** (`window.FormLogicNative`, resilient to bridge-IPC failure), else a browser connector.

`request(connectorId, command, payload)` is identical in both environments — the app-logic host
calls it for `connector.request` effects.

### Native (FormLogic Native Runtime)

Inside the Tauri runtime, connectors are serviced by Rust commands over `window.FormLogicNative`
(`connector_list` / `connector_status` / `connector_request`). See [[../docs/NATIVE_RUNTIME_TAURI]].
The Rust mock returns the **same telemetry shape** as the browser mock, so `onConnectorEvent`
mapping is identical whether running in a browser or the native runtime.

### Telemetry shape (mock)

```json
{ "vehicleId": "TRUCK-044", "fleetNumber": "F044", "operatorId": "OP-918",
  "engineHours": 4137.9, "odometer": 87447, "fuelPercent": 57,
  "faultCodes": [], "status": "ready", "location": { "lat": -20.123, "lng": 148.456 } }
```

### Deferred
Bluetooth, USB-serial, barcode, GPS, printer, POS connectors; connector permission prompts UI; real
vehicle adapters.

---

## Application Package Format

*(.formlogic)* Status: **implemented** — types, validator, signed export, full ZIP-archive export + verified import. Spec §29.

An Application Package is the portable, runtime-aware superset of a Pack: the app + forms + screens
+ dashboards + reports, plus custom app-logic, launch/native config, and assets. The existing Pack
import path is reused for the forms/app payload; the envelope adds the runtime metadata around it.

### Types

`ui/src/application-package/packageTypes.ts`:
- `ApplicationPackageManifest` — `{ version:1, kind:"formlogic.applicationPackage", id, name, category,
  tags, author, runtime.{requires,supports}, entry.homeScreen, capabilities }`.
- `ApplicationPackage` — `{ manifest, pack, customLogic?, launch?, native?, assets? }`.
- `SignedApplicationPackage` — `{ package, signature, alg, keyId }`.

### Validation

`ui/src/application-package/packageValidator.ts` — `validateApplicationPackage()` checks the
manifest kind/version/id, rejects **unsafe asset keys** (path traversal, absolute, backslash, NUL),
caps inline asset size, and confirms `customLogic` shape. The inner Pack is validated by the server's
existing `PackService::validatePack` on import.

### Signing (spec §29.6)

Routes:

- `GET /api/apps/{id}/export/signed` → `{ package, signature, alg, keyId, trust, capabilities }` (signed
  by `SigningService`; `trust` is `official` under Ed25519, `local-only` under the HS256 fallback that no
  third party can verify).
- `GET /api/apps/{id}/export/package` → the full **`.formlogic` ZIP** (`manifest.json` + `pack.json`
  + `quickjs/` + optional `launch.json`/`native.json` + `assets/` + detached `signature.json`), streamed
  as `application/zip`.
- `POST /api/application-packages/import` — a multipart ZIP **or** a JSON `{ package, signature, alg }`
  envelope; the SERVER verifies the signature, stamps trust, and delegates to the atomic `importPack`.
  Every ZIP entry passes a shared path-traversal + zip-bomb guard (`PackFileService::assertSafeArchive`).
- `POST /api/packs/describe` with `{ package, signature, alg }` → `{ trust, capabilities }`. A valid
  signature ⇒ `official`; a tampered payload ⇒ `unverified`; unsigned ⇒ `community`.

#### What the ZIP signature covers (whole-archive model)

`PackService::exportApplicationPackage` signs the **archive as a whole**, not just `pack.json`:

- `signature.json` is a **detached signature over the CANONICAL `manifest.json`** (the
  `ApplicationPackageManifest`, canonicalized by `SigningService`).
- The manifest carries **`entries`** — a `sha256` hex digest of **every archive entry the importer
  consumes**: `pack.json` (always), `quickjs/customLogic.json`, `launch.json`, `native.json`, and each
  `assets/*` file present. `contentHash` remains `sha256:<pack.json digest>` for backward-compatible
  identification.
- So the single detached signature **transitively covers the whole envelope**: a tampered
  quickjs/launch/native/asset file is detected on import even though it lives outside `pack.json`.

#### Import verification (`PackService::importApplicationPackage`)

Order of operations for a `.formlogic` ZIP:

1. **Zip-slip + zip-bomb guard** over every entry (`PackFileService::assertSafeArchive`) before
   anything is read.
2. `pack.json` is required and must parse (it is the atomic importer's source of truth).
3. When `signature.json` is present, the archive is treated as **signed** and everything must verify:
   - `manifest.json` must exist, parse, and its **signature must verify** (`SigningService::verify`).
     A present-but-failing signature is a **hard import failure** (HTTP 400), not a downgrade to
     "community".
   - The signed `manifest.entries` must cover `pack.json`, and **every listed entry's sha256 is
     recomputed and must match exactly** (`verifyEntryHashes`; constant-time compare). A mismatch, a
     covered entry missing from the archive, a malformed hash, or an unsafe listed entry name → reject.
   - **Unsigned extras are rejected**: an applicable envelope file (`quickjs/customLogic.json`,
     `launch.json`, `native.json`) or an `assets/*` file that is *present in a signed archive but not
     listed* in the verified manifest is treated as injected content and fails the import
     (`readArchiveEnvelope`).
   - Trust is then classified by the shared `PackService::classifyTrust`: Ed25519 ⇒ `official`,
     HS256 ⇒ `local-only`.
4. An archive **without** `signature.json` imports as `community` — no coverage constraint applies
   (there is no verification claim to enforce).
5. Only after the covered entries verify does it delegate to the atomic `importPack()` (remap /
   rollback / quota unchanged) and apply the now-signature-covered envelope metadata
   (`applyPackageMetadata`).

#### JSON-envelope path: invalid signatures are 400 by default

On the JSON import path (`POST /api/application-packages/import` with `{ package, signature, alg }`),
a **present-but-invalid** signature is a tamper / key-mismatch signal and is **rejected with HTTP 400**
(`code: "signature_invalid"`) rather than silently imported as `unverified`. An explicit
`allowUnverified: true` in the body lets a user knowingly proceed — the pack imports, but its
**envelope metadata (customLogic / logo / launch / native) is skipped** because the trust stays
`unverified`. Unsigned packages take neither branch and import as `community`.

#### Workspace policy: `REQUIRE_VERIFIED_PACKAGES`

With env `REQUIRE_VERIFIED_PACKAGES=true`, **every import path requires positive verification**
(trust `official` or `local-only`):

- ZIP path — rejected inside `importApplicationPackage` **before** the atomic import commits.
- JSON path — HTTP 403 (`code: "unverified_package"`); `allowUnverified` **cannot** bypass the policy.
- Legacy flat `POST /api/packs/import` — a flat pack is inherently unsigned (`community`), so it is
  rejected outright (403) — the policy can't be sidestepped via the older endpoint.

#### `launch.json` / `native.json` are warning-only today

Both files are signature-covered and hash-checked on import, but there is **no app-level storage
target** for them yet — launch/native configuration lives **per custom domain** on `app_domains`,
which an import does not create. They surface as import `warnings` ("configure them per custom domain
after install") rather than being silently dropped. Envelope `customLogic` (sanitized, size-capped,
fill-only-when-empty) and a `logo` asset (→ `logo_url`) are the envelope parts with runtime targets.

Related: every **signed client manifest** (the *runtime* manifest, distinct from the package manifest)
now carries a `domain` binding that the native runtime enforces — see
[Client Manifest → Domain binding](#domain-binding-signed-manifest--serving-origin).

### Capability review

`Helpers/PackCapabilities::describe(pack)` returns `{ forms, apps, hasScreens, hasCustomLogic,
logicScripts, connectors[], permissions[] }` — what an install will be able to do, surfaced before
the user commits. (Consumed by the [Marketplace](#marketplace) install flow.)

### Screen/UI portability rules

An application package can carry three kinds of screen, and they differ in trust *and* in whether they
are portable across installs:

| screen kind | trust model | portable in a package? |
|---|---|---|
| **dashboard** (no-code widget grid) | host-rendered, data-only — no author code runs | **yes** — fully portable; nothing to sandbox or review |
| **code** (sandboxed HTML/CSS/JS) | untrusted; the iframe sandbox **is** the boundary | **yes** — portable as untrusted; capability/permission review still applies |
| **sdk** (host-rendered React) | first-party trusted, **registry-only** (see the [FormLogic SDK trust note](#trust-boundary-host-rendered-react-is-first-party-only)) | **only** when the referenced component already ships in the first-party registry |

Importing **arbitrary package React** — component source that would render in the trusted shell — is
**NOT supported yet**: an untrusted package's custom UI must be a `code` screen. So a portable,
distributable package uses **dashboard + code** screens; `sdk` screens are for first-party apps whose
components already ship in the runtime. Widening to trusted third-party React requires signed-package
trust plus isolation (same condition as the SDK trust note).

### Deferred
Non-pack marketplace item types (connector/theme/widget/…) — the catalog has the `item_type` column but
those have no runtime install target yet. `launch.json`/`native.json` are signature-covered and
hash-checked on import but have no app-level storage target today (surfaced as import warnings; see
above). Signature-derived `verified` trust at publish time (the publish flow doesn't yet submit a
package signature).

---

## Client Manifest

*Client App Manifest & Signed Manifests.* Status: **implemented**. Spec §24–25.

Two manifests serve an app:

1. **PWA manifest** — `GET /api/app/{slug}/manifest.json` (existing). Same-origin `start_url`/`scope`,
   icons, theme; installable. On a custom domain it is same-origin automatically.
2. **Client app manifest** — `GET /api/app/{slug}/client-manifest` (new). A richer, **signed**
   descriptor for the native runtime: display / install / offline / native / sdk / logic sections.
   Public metadata only — never form schemas or field names.

### Custom-domain root endpoints

So the native runtime + browsers can discover an app from a custom domain **root** (no `/api/app/{slug}`
path), three top-level paths are served by the backend and resolve the request **Host** to its
connected+active domain of a **published** app (`AppDomainService::resolveAppSlugByHost`, same gate as
`resolveLaunchConfig`). The Host is trusted only because it's matched to an `app_domains` row:

- `GET /.well-known/formlogic-app.json` — the app's **signed client manifest**, rebuilt for the custom
  domain: links (`source.url`, `install.pwa.manifestUrl`, `install.android.*`) are emitted
  **same-origin** against the verified custom domain, and the payload's top-level `domain` field names
  it (so it is *not* byte-identical to the platform slug route, whose `domain` is the platform host —
  see [Domain binding](#domain-binding-signed-manifest--serving-origin)). 404 on a platform host.
- `GET /manifest.json` — a **same-origin** PWA manifest rooted at `/` (the branded launch page), built
  from the request scheme + Host (Chrome refuses a cross-origin scope). 404 on a platform host — the
  VitePWA `/manifest.webmanifest` stays the platform default.
  - **Dev `?host` override vs. manifest origin**: `?host=<domain>` selects *which app* the manifest
    describes (it resolves the app slug), but the manifest's **origin** — `start_url` / `scope` / icon
    URLs — is built from the **actual request `Host` header**, falling back to `?host` only when no
    `Host` is present. So previewing in dev on `formlogic.local` with `?host=mine.management` yields a
    manifest whose origin is `formlogic.local` (the local host), not the customer domain. There is no
    production origin-spoofing: the served origin always follows the real request Host, so `?host` can
    point the lookup at another app but cannot make a platform host emit a foreign-origin installable
    manifest.
- `GET /.well-known/assetlinks.json` — dynamic Android **App Links** statements. Defaults to the hosted
  runtime entry (`com.formlogic.runtime` + its cert fingerprint, env-overridable via
  `ANDROID_CERT_FINGERPRINT`); a domain whose `app_domains.native_config` declares its own
  `packageName` + `sha256CertFingerprints` (a white-label build) gets that instead.

These three paths live at the domain root, so the single-domain deploy's `.htaccess`
(`ui/public/.htaccess` + `ui/dist/.htaccess`) funnels them to the API front controller; the static
`ui/public/.well-known/assetlinks.json` remains the build-time default for split/API-elsewhere deploys.
See the App-Links compile-time caveat in [[NATIVE_RUNTIME_TAURI#app-links-hosts-are-compile-time-per-tenant--custom-domain-limit]].

### Signature envelope (spec §25)

```json
{ "payload": { "version": 1, "kind": "formlogic.clientApp", "appSlug": "minecab", "...": "..." },
  "signature": "base64url…", "alg": "Ed25519", "keyId": "formlogic-ed25519-1" }
```

- Signed by `Services/SigningService` (Ed25519 via libsodium, HMAC-SHA256 fallback). The keypair is
  generated once and stored in `system_meta`.
- Verifiers fetch the public key at `GET /api/public/signing-key`
  (`{ alg, keyId, publicKey }`) and check the detached signature over the canonical payload.
- Canonicalization normalizes `{}` vs `[]` through a JSON round-trip so a signature verifies after
  the payload crosses the wire.

### Domain binding (signed manifest ↔ serving origin)

**Every signed client manifest carries a top-level `domain` field** naming the origin host it was
built for, and the **native runtime requires it to match the origin that served it**:

- The custom-domain routes (`/.well-known/formlogic-app.json`, and `?host=`-resolved lookups) bind
  `domain` to the matched, pre-verified **custom domain** (`AppManifestController::clientManifestByHost`).
- The platform slug route (`GET /api/app/{slug}/client-manifest`) binds `domain` to the **platform
  host** derived from the server-trusted frontend base (`AppManifestController::platformHost()`, via
  `AppUrl::frontendBase` — never the request Host). On failure it emits an empty binding, which the
  runtime treats as missing — fail-closed.
- The native runtime (`check_manifest_identity` in `native-runtime/src-tauri/src/lib.rs`) verifies the
  Ed25519 signature, then requires `payload.appSlug` to match the navigated slug **and** `payload.domain`
  to be present and case-insensitively equal to the current origin host. A **missing or mismatched
  `domain` is a hard verification failure**: the webview stays display-only.

Why: without the binding, a validly-signed but domain-less manifest could be **replayed onto an
attacker origin** to grant native capabilities there. With it, a signature only ever authorizes the
origin the server bound it to.

### Native capabilities

The manifest's `native.capabilities` are **derived from the app's customLogic** connector
permissions: `connector.vehicle.status.read` → `{ connector: "vehicle", commands: ["status.read"] }`.
So the native runtime knows exactly what the app will ask for, and can prompt/approve.

### Files
`Controllers/AppManifestController.php`, `Services/SigningService.php`, `Controllers/AppPublicController.php`
(PWA manifest), `Controllers/AppDomainController.php` (asset links), `Services/AppDomainService.php`
(host→app resolver).

### Deferred
Key rotation / multiple keyIds. (The native runtime **now enforces** signature verification before
enabling the bridge — see `docs/NATIVE_RUNTIME_TAURI.md`.) When libsodium/Ed25519 is unavailable the
manifest endpoint returns 503 rather than an HS256 manifest no third party could verify.

---

## Marketplace

Status: **implemented** (item-type + server-derived trust level + capability review on install). Spec §30.

The existing pack marketplace distributes **apps**. This section covers the trust + safety layer added
for the custom-app platform. The catalog now carries `item_type`
(application_package/connector/theme/widget/quickjs_library/sdk_component/template) and a server-derived
`trust_level`; the non-`application_package` types are schema-supported but have no runtime install target
yet (future work). Trust + a capability review are surfaced before install.

### Trust levels

| level | meaning |
|---|---|
| `official` | Built/signed by FormLogic — signature verifies against the server key. |
| `verified` | Reviewed + signed third party (future). |
| `community` | User-published, unsigned — install with capability review. |
| `unverified` | Carries a signature that does **not** verify (tampered / wrong key). |

Determined by `POST /api/packs/describe` (verifies the signature via `SigningService`).

### Capability review before install

`POST /api/packs/describe { pack | package, signature?, alg? }` →
```json
{ "trust": "official",
  "capabilities": { "forms": 2, "apps": 1, "hasScreens": true, "hasCustomLogic": true,
                    "logicScripts": 3, "connectors": ["vehicle"],
                    "permissions": ["ui.setValues","ui.toast","connector.vehicle.status.read"] } }
```

So the install UI can show *"This app can: read vehicle status, set form values, show messages"*
and its trust level before the user commits (spec §30.1).

### Files
`Helpers/PackCapabilities.php`, `Services/SigningService.php`, `Controllers/PackController.php`
(`exportAppSigned`, `describe`).

### Deferred
Signed-package publishing to the catalog; a `trust_level` column on `pack_catalog`; connector/theme/
widget categories; a capability-review step wired into the install UI; revocation.

---

## Custom Domains & App Launch

Status: **implemented** (`launch_page` + `runtime_direct` modes). Spec §11–21.

Run a FormLogic app on the owner's own domain (e.g. `mine.management`) so it feels like their
product, not a page inside FormLogic.

### Owner flow

App → **Deploy & share** → **Custom domains**: add a domain, get the DNS TXT record, verify, open,
remove. UI: `ui/src/components/apps/CustomDomainsPanel.tsx`.

DNS to add: `TXT  _formlogic.<domain>  =  fl-domain-verification=<token>`.

### Modes

- `launch_page` — the site root shows a branded launch page (logo/name + Open app + install CTAs).
- `runtime_direct` — the root goes straight into the app runtime.

`AppDomainService::MODES` also lists `website_plus_app`, `native_required`, and `redirect` as
*accepted* strings (so a stored value round-trips), but only `launch_page` / `runtime_direct` are
rendered by `RootGate`. The others are reserved for later.

#### "Requires the native runtime" — the MVP mechanism (decision)

There is **no separate `native_required` domain mode in the MVP**. A `native_required` string exists
in `MODES` (forward-compat, never emitted by the UI), but the shipped mechanism for "this app is
meant to run in the FormLogic Native Runtime" is a **`launch_page` domain with
`native_config.requireNativeRuntime = true`** — a per-domain flag on the domain's native config
(`AppDomainController` saves it; `AppDomainService::sanitizeNativeConfig` normalizes it; the public
launch config surfaces the native section). When set, `AppLaunchPage` makes the **Open in native
runtime** CTA the *primary* way in (`requireNative` in `AppLaunchPage.tsx`) instead of the web
"Open app" button. This keeps the launch page as the single, brandable entry point (with graceful
web fallback if the runtime isn't installed) rather than forking a whole new mode + UI. A dedicated
`native_required` mode (e.g. a hard block that refuses the web app entirely) is intentionally
deferred until there's a product need to *forbid* web access, not just *prefer* the native runtime.
`CustomDomainsPanel` therefore exposes the `requireNativeRuntime` toggle, not a mode selector for
`native_required`.

### How it renders (frontend, Option A)

The same SPA loads on every domain. `RootGate` in `App.tsx` checks the host: on a customer domain's
**root**, it renders `DomainLaunchRouter` → `AppLaunchPage`; deeper paths (`/app/:slug`, `/form/:id`)
render the normal app. A `?__flhost=<domain>` **dev override** lets you preview any connected
domain on `formlogic.local` without DNS.

### Backend

- Table `app_domains` (idempotent migration); `AppDomainService` (normalize/validate, **reject
  localhost/private/internal/IP**, unique-domain, DNS-TXT verify, `resolveLaunchConfig`).
- `AppDomainController` — owner-gated CRUD under `/api/apps/{id}/domains` (+`/verify`), and the public
  `GET /api/public/launch/by-host?host=…` returning **display/install metadata only** (never form
  schemas, fields, reports, or scripts).
- Dev verify: when `APP_ENV != production`, `verify` marks the domain active without a real DNS
  lookup so the flow is locally testable.

### Security (spec §59)
Ownership verified via DNS-TXT before activation; TLS is then **measured** (a real HTTPS handshake sets
`tls_status` active/pending/external — not assumed), and the probe is SSRF-guarded (`IpSafety` rejects a
host resolving to a private/reserved/metadata IP). One app per domain (unique); no private structure in
the public launch config; HTTPS + real DNS required in production.

**SSRF guidance for any FUTURE outbound request** (e.g. an HTTP-file domain-verification method,
favicon/asset fetch, or `.well-known` probing): reuse `IpSafety::resolvesToPublicHost()` and call it
**immediately before every outbound request** — not once at domain-save time. A host that resolved to a
public IP at save time can be re-pointed at a private/metadata IP later (DNS rebinding), so re-resolve
per request. In addition: **re-check every redirect target** the same way (never blindly follow
`Location`), allow **`http`/`https` schemes only**, **cap the response size**, and use a **short
timeout**. `probeTls()` in `AppDomainService` is the reference call site — it re-guards the host right
before opening the TLS handshake; any new fetch path must do the same.

### Deferred
`website_plus_app` / `redirect` modes; automatic TLS *provisioning* (status is measured, but
certificate issuance is external). A separate `native_required` **mode** is intentionally NOT built —
the per-domain `native_config.requireNativeRuntime` flag on a `launch_page` domain is the MVP
mechanism (see [the decision above](#requires-the-native-runtime--the-mvp-mechanism-decision)). The
per-domain landing-page editor UI is now implemented (`CustomDomainsPanel`).

---

## Multi-App over Shared Forms

Status: **supported** (API + MCP + builder UI; the backend + runtime are shared-form aware end-to-end).
The mental model — one shared data backend, many portal apps — is summarized in
[ONE_BACKEND_MANY_PORTALS.md](ONE_BACKEND_MANY_PORTALS.md).

One dataset, several products: e.g. a **client app** (customers submit requests) and an **admin
app** (staff triage them) over the *same* forms. Responses live **per form** — each form has its own
SQLite database (`Database\SQLiteConnection::getFormDatabase`) and a response row carries no app id —
so every app a form is attached to reads and writes the **same records**.

### Recipe

1. Create the forms once (a form belongs to a user, not an app).
2. Create the second app, then attach the same forms:
   `POST /api/apps/{id}/forms { formId }` (`AppController::addForm` — the caller must own **both**
   the app and the form), or the MCP tool `add_form_to_app`. `app_forms` is unique on
   `(app_id, form_id)`: a form attaches once per app, to any number of apps.
3. Give each app its own roles + members — e.g. clients get `submit_responses`
   (+ `view_own_responses`) in the client app; staff get `view_all_responses` / `edit_responses` /
   `export_responses` in the admin app. Permissions are `app_role_permissions` rows keyed by role
   **and form** (`Constants\AppPermissions::FORM_LEVEL`), so the same form can be submit-only in one
   app and full-CRUD in another.

> UI: the **Manage forms** picker (`pages/apps/AppFormManager.tsx`) and the create wizard
> (`pages/apps/AppCreateWizard.tsx`) both offer forms that already belong to other apps, marked
> with a **Shared** badge — attaching one shares the form and its existing responses (both apps
> read and write the same data). Only *pack-installed* forms are excluded from the picker (they're
> managed through their pack). The one-click **companion app** (`POST /api/apps/{id}/companion`)
> is the fastest way to split off e.g. an admin console over all of an app's forms.

### Per-app vs shared

Each attached app keeps its **own**:

- Identity/branding — `apps` row: name, slug, description, `logo_url`, `theme`, `settings`, `nav_config`.
- Members + roles + per-form permissions — `app_users` / `app_roles` / `app_role_permissions` are all per-app.
- The shared form's in-app presentation — the `app_forms` row: `display_name`, `sort_order`, `is_visible`, `settings`.
- Home dashboard / custom home screen (`apps.custom_screen`) and saved reports + PDF documents (`apps.reports`).
- App-level customLogic (`apps.custom_logic`) — see [App Logic (QuickJS)](#app-logic-quickjs).
- Custom domains (`app_domains`), signed client manifest, and PWA manifest — see
  [Custom Domains & App Launch](#custom-domains--app-launch) and [Client Manifest](#client-manifest).
- Offline idempotency — the sync ledger is keyed `(app, form, idempotency_key)`.

**Shared**, because it lives on the *form*:

- Fields, validation, and the form's own theme.
- Form-level customLogic (`forms.custom_logic`) — runs in **every** app the form is open in.
- The server-side onSubmit **`logicScript`** — the submission pipeline
  (`AppPublicController::runSubmissionPipeline`) runs it whichever app submitted, so data rules
  cannot differ per app.
- The form's section screen / section dashboard (`forms.custom_screen`) — the spec is shared;
  its queries execute in whichever app renders it, under that app's permissions.
- Webhooks, form versions, per-form analytics, and `response_links`.

### Lifecycle notes

- Removing a form from one app (`AppService::removeFormFromApp`) leaves the records intact and keeps
  `response_links` while any *other* app still contains the form; deleting a whole app applies the
  same guard (`deleteApp` purges links only for forms in no other app).
- App-scoped uploaded files resolve access through *any* app that contains the form and in which the
  user is an active member (`AppService::activeAppIdsContainingForm`).

---

## Per-App Customization & Custom Code

Every custom-code surface on the platform, in one map. Details live in the linked sections; the
multi-app column nuance (what travels with a shared form) is in
[Multi-App over Shared Forms](#multi-app-over-shared-forms).

| surface | where it runs | trust model | typical use |
|---|---|---|---|
| App-level customLogic (`apps.custom_logic`) | client — QuickJS WASM sandbox in the app runtime | untrusted script describes *effects*; host applies them after permission checks; backend re-validates every submit | connector prefill, submit gates, toasts/navigation app-wide ([App Logic](#app-logic-quickjs)) |
| Form-level customLogic (`forms.custom_logic`) | same sandbox, only while its form is open | same effect/permission model | per-form logic that travels with the form into every app |
| onSubmit `logicScript` (`forms.logic_script`) | **server** — sandboxed `qjs` in the submission pipeline | trusted + authoritative — the one surface a client cannot bypass | validation, computed/hidden fields, rejecting bad data (test via `POST /api/forms/{formId}/script/test`) |
| Code screens (`custom_screen`, kind `code`) | opaque-origin **iframe**; data via the postMessage SDK bridge | untrusted — the iframe **is** the boundary | arbitrary / AI-generated UI: app home + form section screens; portable in packs |
| Dashboard screens (kind `dashboard`) | host React — recharts widget grid | no author code runs — declarative spec only | no-code KPIs/charts for app home + section screens |
| SDK screens (kind `sdk`) | host React tree (`SdkScreenRuntime`) | trusted — **first-party registry only** ([trust note](#trust-boundary-host-rendered-react-is-first-party-only)) | screens FormLogic ships in the runtime |
| FormLogic SDK (`ui/src/sdk`) | host React, imported by first-party code | trusted, permission-aware library | building host-rendered screens/components ([SDK](#formlogic-sdk)) |
| Connectors (device / vehicle / local_http + native bridge) | trusted web layer, or Rust in the native runtime | host code; every command gated by `connector.<id>.<command>` | device/vehicle/local-bridge data into app logic ([Connectors](#connectors)) |

### Choosing a surface

- **A data rule that must hold** → the onSubmit `logicScript` (server-authoritative; client logic is UX only).
- **App behavior** (prefill, gate, toast, navigate) → app-level customLogic; move it to form level
  when it should travel with the form across apps.
- **UI** — no code needed → a `dashboard` screen; arbitrary/untrusted code → a `code` screen;
  first-party runtime UI → an `sdk` screen built on the SDK
  (portability rules: [Screen/UI portability](#screenui-portability-rules)).
- **Hardware / device data** → a connector + an app-logic script mapping `ctx.event.result` in
  `onConnectorEvent` — a "custom connector" is just an app-logic script emitting
  `connector.request` effects.

Editors: app logic in **Deploy & share → App logic (QuickJS)** (`AppLogicPanel`); screens in the
Studio (`/forms/:id/screen/edit`, `/apps/:id/home/edit`); the onSubmit script in the builder's
ScriptEditor (with a server-side Test run).

---

## MineCab Reference App

Status: **implemented + tested**. Spec §51–53. Artifact: `backend/resources/sample-apps/minecab.json`.

MineCab is the reference app that proves the custom-app platform end-to-end.

### Install

Apps dashboard → "Try a sample app" → **MineCab Operator**, or:
`POST /api/sample-apps/minecab/install` (installs + publishes into your account).

### What it demonstrates

- **Forms**: Vehicle Register, Pre-start Inspection (classic layout).
- **App-logic** (`app.customLogic`, 3 scripts):
  - `onScreenEnter` → emits `connector.request(vehicle, status.read)`.
  - `onConnectorEvent` → maps telemetry into the pre-start fields via `ui.setValues` + a toast.
  - `onBeforeSubmit` → rejects a shift start on critically low fuel (<15%); warns on active faults.
- **Connector**: the mock vehicle connector (browser) — or the Rust connector when opened inside the
  native runtime. Same telemetry shape either way.
- **Permissions**: `ui.setValues`, `ui.toast`, `connector.vehicle.status.read` (strict).

### Verified flows (formlogic.local)

1. Open the Pre-start form → fields auto-fill from the connector (`vehicle_id=TRUCK-044`,
   `fleet_number=F044`, `fuel_percent≈57`, `engine_hours≈4137`).
2. Set fuel below 15% → submit is blocked: *"Fuel is too low (5%) to start this shift."*
3. Restore fuel → submits normally.
4. In the **native runtime**, the same prefill is serviced by the Rust mock connector.
5. Offline: a replayed submission (same idempotency key) returns the original response — no duplicate.

### Extend to a custom domain

Deploy & share → Custom domains → add e.g. `mine.management`, verify, then
`formlogic.local/?__flhost=mine.management` shows the branded launch page → Open app. (See the
[Custom Domains & App Launch](#custom-domains--app-launch) section.)

### Deferred vs the spec's full MineCab
Operators/Shifts/Fault Reports/Production Readings forms; supervisor dashboards; the full SDK screen
set (`CabHome`, `PrestartFlow`, …). The current pack focuses on the logic + connector + offline proof.
