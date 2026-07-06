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
The whole app can be exported as a signed `.formlogic-app` from the **Application package** card (see the
[Application Package Format](#application-package-format) section).

### Deferred
`onSyncConflict` custom merge, `onButtonClick` custom buttons UI, a Monaco-based editor with lint.

---

## FormLogic SDK

Status: **implemented** (foundation). Spec §27–28. Location: `form-builder/ui/src/sdk/`.

A thin, permission-aware wrapper over the app runtime store so custom screens / AI-generated UI can
read app data and act on it without touching raw endpoints, the runtime store internals, or the
native bridge. The server stays authoritative on every write.

### Import

```ts
import { useConnector, useSubmitResponse, ConnectorStatus, PermissionGate } from '../../sdk';
```

### Hooks

`useCurrentApp`, `useCurrentUser`, `useRole`, `usePermissions`, `useForms`, `useForm`,
`useResponses`, `useSubmitResponse`, `useConnector`, `useConnectors`, `useToast`,
`useAppNavigation`, `useRuntimeEnvironment`, `useOfflineQueue`.

- Permission-respecting: `useSubmitResponse` rejects without submit permission; `useResponses`
  resolves to `[]` when the user can't view (the store swallows a 403).
- `useConnector('vehicle').request('status.read')` uses the native bridge when present, else the mock.
- `useRuntimeEnvironment()` returns `{ hostMode: 'platform'|'custom-domain'|'native', nativeAvailable }`.

### Components

`ConnectorStatus`, `SyncStatus`, `PermissionGate`, `ResponseList`, `EmptyState` — theme-aware,
compose the hooks. Example:

```tsx
<PermissionGate permission="submit_responses" form="prestarts">
  <button onClick={startPrestart}>Start pre-start</button>
</PermissionGate>
<ResponseList form="faults" limit={5} titleField="fault_code" />
```

### Relationship to the sandboxed screen SDK

The existing *sandboxed* custom-screen SDK (postMessage bridge, iframe = the boundary) is unchanged.
This SDK is for **host-rendered** React screens that run in the trusted app shell. Both expose the
same capabilities; pick by whether your screen is sandboxed code or trusted React.

### Deferred
`<FormView>`, `<ResponseDetail>`, `<AppButton>`; an npm-published `@formlogic/sdk`; SDK version
negotiation in the client manifest.

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

*(.formlogic-app)* Status: **implemented** — types, validator, signed export, full ZIP-archive export + verified import. Spec §29.

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

- `GET /api/apps/{id}/export/signed` → `{ package, signature, alg, keyId, trust, capabilities }` (signed
  by `SigningService`; `trust` is `official` under Ed25519, `local-only` under the HS256 fallback that no
  third party can verify).
- `GET /api/apps/{id}/export/package` → the full **`.formlogic-app` ZIP** (`manifest.json` + `pack.json`
  + `quickjs/` + `assets/` + detached `signature.json`), streamed as `application/zip`.
- `POST /api/application-packages/import` — a multipart ZIP **or** a JSON `{ package, signature, alg }`
  envelope; the SERVER verifies the signature, stamps trust, and delegates to the atomic `importPack`.
  Every ZIP entry passes a shared path-traversal + zip-bomb guard (`PackFileService::assertSafeArchive`).
- `POST /api/packs/describe` with `{ package, signature, alg }` → `{ trust, capabilities }`. A valid
  signature ⇒ `official`; a tampered payload ⇒ `unverified`; unsigned ⇒ `community`.

### Capability review

`Helpers/PackCapabilities::describe(pack)` returns `{ forms, apps, hasScreens, hasCustomLogic,
logicScripts, connectors[], permissions[] }` — what an install will be able to do, surfaced before
the user commits. (Consumed by the [Marketplace](#marketplace) install flow.)

### Deferred
Non-pack marketplace item types (connector/theme/widget/…) — the catalog has the `item_type` column but
those have no runtime install target yet. `launch.json`/`native.json` are written on export and validated
on import but have no app-level storage target today (informational). Signature-derived `verified` trust
at publish time (the publish flow doesn't yet submit a package signature).

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

- `GET /.well-known/formlogic-app.json` — the **same signed client manifest** as `/client-manifest`
  (re-built by slug, so byte-identical). 404 on a platform host.
- `GET /manifest.json` — a **same-origin** PWA manifest rooted at `/` (the branded launch page), built
  from the request scheme + Host (Chrome refuses a cross-origin scope). 404 on a platform host — the
  VitePWA `/manifest.webmanifest` stays the platform default.
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

### Deferred
`website_plus_app` / `native_required` / `redirect` modes; automatic TLS *provisioning* (status is
measured, but certificate issuance is external). The per-domain landing-page editor UI is now
implemented (`CustomDomainsPanel`).

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
