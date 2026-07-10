# FormLogic Custom App Platform Plan

## Custom Domains, PWAs, FormLogic SDK, Application Packages, Native Runtime, Connectors, Offline Sync, Marketplace, and QuickJS App Logic

**Document status:** planning/specification document only.
**Target repo:** `f2i-com/formlogic.com`
**Main product direction:** extend FormLogic from a business form/app builder into a full custom business app deployment platform.

This version expands the prior architecture document that described custom domains, app launch pages, browser PWAs, the FormLogic Native Runtime, connectors, and the MineCab proof-of-concept. 

---

# 1. Executive summary

FormLogic should evolve into a platform where a business can:

```txt
Create or install a FormLogic app
  ↓
Package it as a portable Application Package
  ↓
Bind it to a custom domain
  ↓
Show a branded launch page
  ↓
Run it as a browser PWA
  ↓
Optionally open it inside FormLogic Native Runtime
  ↓
Use native/device connectors when needed
  ↓
Run sandboxed QuickJS custom app logic
  ↓
Use FormLogic SDK hooks/components for custom screens
  ↓
Store/sync/report through FormLogic
```

The product promise becomes:

> **FormLogic lets businesses build, package, deploy, and run custom operational apps on their own domain, with forms, workflows, dashboards, reports, offline sync, native device connectors, QuickJS app logic, and SDK-powered custom screens.**

This moves FormLogic away from being perceived as “just forms” and toward:

```txt
Custom business app platform
+ workflow database
+ app runtime
+ SDK
+ PWA deployment
+ native runtime
+ connector framework
+ connector marketplace
+ sandboxed scripting
+ application packages
+ reports/dashboards
+ AI-generated business apps
```

The first strong demo should be:

```txt
mine.management
  ↓
MineCab launch page
  ↓
Open web app / install FormLogic Native Runtime
  ↓
Mock vehicle connector
  ↓
QuickJS maps vehicle data to pre-start form fields
  ↓
Custom screen uses FormLogic SDK hooks
  ↓
Submit pre-start into FormLogic
  ↓
Dashboard/report updates
```

---

# 2. Current repo baseline

The repo is already well aligned with this direction.

FormLogic is already described as a **self-hostable business app platform**, with ready-made vertical apps, customisable forms/dashboards, linked records, reports/PDFs, MCP/AI extension, sandboxed JavaScript, analytics, and audit logging.

The existing product model is already close to a custom business app platform: each app is structured as forms, workflow, configurable dashboards, reports, role-based access, and marketplace-pack installation.

The current frontend stack suits this direction: React 19, TypeScript, Vite, Tailwind CSS, Zustand, React Router, and PWA support via `vite-plugin-pwa`.  The backend stack also fits: PHP/Slim, HttpOnly cookie sessions, MySQL metadata, SQLite per-form responses, and QuickJS scripting.

The current app settings already contain PWA-oriented fields such as `enablePwa`, `pwaShortName`, and `pwaThemeColor`, plus `hideNav` for self-contained app experiences.  The app runtime already dynamically points the browser to an app-specific manifest and theme/icon when loading an app runtime.

The app runtime already protects app access by requiring the app to be published, the user to be authenticated, and the user to be an active member. It also filters runtime forms by permission.  For non-owner members, the controller narrows reports, dashboards, nav config, and landing pages so hidden forms and fields are not leaked.

So the strategy should be:

> **Extend the current app runtime rather than replacing it.**

---

# 3. Core product layers

The platform should be separated into these layers:

```txt
FormLogic Core
  Existing backend, apps, forms, responses, scripts, reports, dashboards, users, audit, API.

FormLogic Launch
  Custom domains, parked app pages, install/open buttons, app discovery, app manifests.

FormLogic Client Runtime
  Browser/PWA runtime for custom business apps.

FormLogic SDK
  Developer/AI-facing hooks, components, and utilities for building custom screens and app frontends.

FormLogic Application Package
  Portable .formlogic bundle containing app manifest, forms, screens, reports, logic, assets, translations, and native config.

FormLogic Native Runtime
  Tauri v2 Android-first runtime that loads FormLogic apps and exposes approved native connectors.

FormLogic Connect
  Connector/plugin system for vehicles, POS, barcode scanners, Bluetooth, USB, local APIs, printers, GPS, files, etc.

FormLogic Marketplace
  Marketplace for apps, connectors, themes, widgets, QuickJS libraries, SDK components, and templates.

FormLogic App Logic
  Sandboxed QuickJS custom app logic for client/runtime behaviour.
```

The corrected split is important:

```txt
React/PWA renders UI.
FormLogic SDK makes custom screens easy.
QuickJS runs sandboxed app logic.
FormLogic Native Runtime exposes native capabilities.
Connectors talk to devices/systems.
Application Packages make apps portable.
Marketplace makes apps/connectors/extensions installable.
FormLogic Core stores, validates, audits, reports.
```

---

# 4. Target user journey

Using `mine.management` as the example:

```txt
1. Business owner creates, installs, or imports the MineCab Application Package in FormLogic.

2. In FormLogic → App → Deploy & Share:
   - Adds custom domain: mine.management
   - Chooses launch mode: Launch page
   - Enables PWA install
   - Enables FormLogic Native Runtime
   - Adds MineCab branding/logo/copy
   - Enables connector capabilities such as vehicle status/faults/engine hours
   - Enables QuickJS app logic hooks
   - Optionally customises SDK-powered custom screens

3. DNS points mine.management to FormLogic.

4. Visiting mine.management shows:
   - MineCab logo/name
   - Open web app
   - Install PWA
   - Install Android app
   - Open in FormLogic Native Runtime
   - Support/contact links
   - Native connector notice

5. On a normal browser:
   - user opens the PWA/runtime
   - app works with manual entry and limited connector features

6. On Android:
   - user installs/opens FormLogic Native Runtime
   - native runtime loads the same MineCab app
   - native bridge exposes approved vehicle/device connector APIs

7. MineCab app:
   - reads vehicle data from connector
   - QuickJS maps that data to app fields
   - custom React screens use FormLogic SDK hooks
   - prefills pre-start/shift/fault forms
   - stores/syncs data into FormLogic
   - supervisors view dashboards/reports in FormLogic
```

---

# 5. The big product story

FormLogic should be positioned as:

```txt
Your business app
on your domain
installable as a PWA
extendable with native runtime connectors
programmable with QuickJS
customisable with SDK screens
packageable as a portable app
installable from a marketplace
reported/audited by FormLogic
```

The strongest customer-facing line:

> **Launch custom business apps on your own domain, connect them to real-world systems, and let FormLogic handle the workflows, data, reports, and automation.**

For a business, this changes the perception from:

```txt
“We use FormLogic.”
```

to:

```txt
“This is our MineCab app.”
“This is our client portal.”
“This is our POS workflow.”
“This is our field service system.”
```

That psychological shift is huge.

---

# 6. Why Tauri v2 for FormLogic Native Runtime

Tauri is a strong fit because it allows an app to use a web frontend while using Rust, Swift, or Kotlin for backend/native logic; its docs describe it as supporting major desktop and mobile platforms while integrating frontend frameworks that compile to HTML/CSS/JS. ([Tauri][1])

Tauri’s architecture is useful here because FormLogic already has a React/TypeScript frontend. The native runtime can reuse web UI patterns while exposing controlled native functions through Rust/Kotlin plugins. Tauri’s docs also describe JavaScript/Rust bindings through `invoke` and Swift/Kotlin bindings for plugins. ([Tauri][1])

The first target should be Android. Tauri’s docs include mobile development support and mobile development workflows. ([Tauri][2])

The practical architecture is:

```txt
React/TypeScript app UI
  +
Tauri v2 Android shell
  +
Rust command layer
  +
Android/Kotlin native connector plugins
  +
FormLogic API/runtime
```

The native runtime should be **generic**, not MineCab-specific.

MVP Android package:

```txt
com.formlogic.runtime
```

Later, white-labelled apps can be considered:

```txt
com.mine.management
com.client.portal
com.company.fieldops
```

But white-label native apps require separate package names, signing keys, app listings, app links, release pipelines, and support overhead, so they should not be part of the MVP.

---

# 7. Long-term Native Runtime vision

The FormLogic Native Runtime should not be thought of as merely:

```txt
Android wrapper
```

Long-term, it can become:

```txt
Business Operating Runtime
```

Meaning the same runtime concept could eventually run on:

```txt
Android
Windows
Linux
macOS
Industrial touch screens
Kiosks
Raspberry Pi
Warehouse tablets
Field laptops
Vehicle-mounted tablets
Workshop terminals
POS terminals
```

The idea:

```txt
One FormLogic app package
  ↓
Runs in browser/PWA mode
  ↓
Runs in FormLogic Native Runtime
  ↓
Connects to approved local/native systems
  ↓
Syncs with FormLogic Core
```

This is a powerful long-term direction because it allows one business app model to serve:

```txt
office workers
field workers
drivers
operators
customers
kiosks
machines
supervisors
```

without rebuilding the workflow for every device class.

---

# 8. High-level architecture

## Browser/PWA mode

```txt
mine.management
  ↓
FormLogic Launch Page
  ↓
Open web app
  ↓
FormLogic Client Runtime
  ↓
React app runtime
  ↓
FormLogic SDK-powered screens
  ↓
QuickJS app logic hooks
  ↓
FormLogic API
  ↓
Responses, workflows, dashboards, reports
```

## Native runtime mode

```txt
mine.management
  ↓
Open in FormLogic Native Runtime
  ↓
Tauri Android shell
  ↓
Embedded FormLogic Client Runtime
  ↓
FormLogic SDK-powered screens
  ↓
Native bridge
  ↓
Connector registry
  ↓
Vehicle / POS / scanner / USB / Bluetooth / local HTTP / files / GPS
  ↓
QuickJS app logic maps data
  ↓
FormLogic API sync
```

## Application package mode

```txt
MineCab.formlogic
  ↓
Import/install into FormLogic
  ↓
Creates forms, screens, dashboards, reports, roles, scripts, assets, native config
  ↓
Deploy to domain/PWA/native runtime
```

## Marketplace mode

```txt
Marketplace
  ↓
Install app package / connector / theme / widget / QuickJS library
  ↓
Customise in FormLogic
  ↓
Deploy as business app
```

---

# 9. Naming

Use these names:

```txt
FormLogic Core
FormLogic Launch
FormLogic Client Runtime
FormLogic SDK
FormLogic Application Package
FormLogic Native Runtime
FormLogic Connect
FormLogic Marketplace
FormLogic App Logic
```

Do **not** use Aokie here. Aokie remains separate.

The user-facing native app name should be:

```txt
FormLogic Native Runtime
```

For later marketing, the broader runtime idea could be described as:

```txt
FormLogic Business Operating Runtime
```

But keep the product/technical name simple for now:

```txt
FormLogic Native Runtime
```

---

# 10. Non-goals for the MVP

The MVP should not attempt everything at once.

Do not start with:

```txt
real mining rig integration
white-labelled Android apps
iOS runtime
full custom website builder
full SDK marketplace
full connector marketplace
arbitrary remote PWA native access
complex app-store release automation
offline app bundle packaging
Bluetooth/USB production drivers
bidirectional vehicle control
industrial kiosk support
Raspberry Pi runtime
```

Start with:

```txt
QuickJS custom app logic
FormLogic SDK foundation
mock connector
Application Package spec
MineCab package/demo
domain launch page
PWA open/install flow
FormLogic Native Runtime scaffold
local HTTP connector
offline queue with idempotency
```

---

# 11. Custom domain / parked app system

This is the key deployment feature.

Instead of only:

```txt
https://formlogic.com/app/minecab
```

FormLogic should support:

```txt
https://mine.management
```

as an app launch domain.

Important distinction:

> The custom domain should not just be a redirect. It should be a launch surface.

The launch surface decides whether to show:

```txt
branded landing page
direct app runtime
PWA install instructions
Android native install/open option
native-required notice
custom website/app shell
```

This is one of the biggest commercial features in the plan.

A business seeing:

```txt
mine.management
```

feels like they own:

```txt
their app
their workflow
their data
their operating system
```

not merely:

```txt
a page inside someone else’s SaaS
```

That matters.

---

# 12. Domain modes

Each app domain should support a mode.

```ts
type AppDomainMode =
  | 'launch_page'
  | 'runtime_direct'
  | 'website_plus_app'
  | 'native_required'
  | 'redirect';
```

## 12.1 `launch_page`

Default MVP mode.

Shows:

```txt
Open web app
Install PWA
Install Android app
Open native app
Support/contact
Privacy/terms
```

## 12.2 `runtime_direct`

The domain opens the runtime directly.

Example:

```txt
mine.management → MineCab runtime
```

Good for internal staff apps.

## 12.3 `website_plus_app`

A branded website/landing page with app CTAs.

Example:

```txt
Mine Management
- About
- Safety workflow
- Login/open app
- Install native runtime
```

This should be post-MVP.

## 12.4 `native_required`

Used when hardware access is central.

Example:

```txt
This app requires FormLogic Native Runtime to connect to vehicle systems.

[Install Android app]
[Open in native app]
[Use limited web mode]
```

This should be post-MVP or late MVP.

## 12.5 `redirect`

Simple redirect to `/app/:slug`.

Useful as fallback, but less valuable as a product differentiator.

---

# 13. Recommended MVP domain modes

Start with only:

```txt
launch_page
runtime_direct
```

Add later:

```txt
native_required
website_plus_app
redirect
```

Reason:

```txt
launch_page proves the custom-domain product.
runtime_direct proves custom-domain app runtime.
native_required needs mature native detection/install flow.
website_plus_app can become a product rabbit hole.
redirect is easy but not strategically exciting.
```

---

# 14. Backend data model: app domains

Add a table:

```sql
CREATE TABLE app_domains (
  id CHAR(36) PRIMARY KEY,
  app_id CHAR(36) NOT NULL,
  owner_id CHAR(36) NOT NULL,

  domain VARCHAR(255) NOT NULL UNIQUE,
  normalized_domain VARCHAR(255) NOT NULL UNIQUE,

  mode VARCHAR(32) NOT NULL DEFAULT 'launch_page',
  status VARCHAR(32) NOT NULL DEFAULT 'pending',

  verification_method VARCHAR(32) NOT NULL DEFAULT 'dns_txt',
  verification_token VARCHAR(128) NOT NULL,
  verified_at DATETIME NULL,

  tls_status VARCHAR(32) NOT NULL DEFAULT 'pending',

  landing_config JSON NULL,
  native_config JSON NULL,
  pwa_config JSON NULL,
  security_config JSON NULL,

  last_checked_at DATETIME NULL,
  last_error TEXT NULL,

  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,

  INDEX idx_app_domains_app_id (app_id),
  INDEX idx_app_domains_owner_id (owner_id),
  INDEX idx_app_domains_status (status)
);
```

Use `VARCHAR` status fields rather than MySQL `ENUM` for the first pass unless the project already standardises on `ENUM`. `VARCHAR` plus service-level validation is easier for self-hosted installs and future migration.

Supported values:

```txt
mode:
- launch_page
- runtime_direct
- website_plus_app
- native_required
- redirect

status:
- pending
- verifying
- active
- failed
- disabled

verification_method:
- dns_txt
- http_file

tls_status:
- pending
- active
- failed
- external
```

This allows one app to have multiple domains:

```txt
mine.management
cab.mine.management
portal.mine.management
client.company.com
```

---

# 15. Domain verification

In the Deploy page, owner adds:

```txt
mine.management
```

FormLogic generates:

```txt
fl-domain-verification=abc123...
```

The UI tells the owner to add DNS:

```txt
Type: TXT
Name: _formlogic.mine.management
Value: fl-domain-verification=abc123...
```

For a subdomain:

```txt
Type: CNAME
Name: cab
Value: domains.formlogic.com
```

For an apex/root domain such as:

```txt
mine.management
```

the DNS setup depends on provider:

```txt
A/AAAA record to FormLogic ingress IPs
ALIAS/ANAME/CNAME flattening to hosted target
Cloudflare proxy
Cloudflare Tunnel
platform-managed certificate target
```

Backend verification should check:

```txt
1. Domain is valid and normalized.
2. Domain is not already claimed.
3. Domain is not localhost/private/internal.
4. TXT verification token exists.
5. Domain points to FormLogic ingress/host.
6. HTTPS/TLS is available or pending.
7. App exists and owner can manage it.
```

Reject:

```txt
localhost
127.0.0.1
0.0.0.0
::1
private IP ranges
internal hostnames
invalid punycode/IDNA
wildcard collisions
duplicate claimed domains
```

---

# 16. TLS / HTTPS requirement

Custom domains must be HTTPS.

This matters because installable PWAs depend on secure web-app behaviour; MDN’s installability guide describes needing a web app manifest and secure context, among other install-related requirements. ([MDN Web Docs][3])

Hosted FormLogic should support one of:

```txt
Caddy automatic HTTPS
Traefik + Let's Encrypt
Nginx + Certbot
Cloudflare SSL
platform-managed certificates
```

Self-hosted docs should include examples for:

```txt
Caddy
Nginx
Apache
Cloudflare Tunnel
```

MVP recommendation:

```txt
Use Caddy or platform-managed TLS for hosted domains.
Document Nginx/Caddy examples for self-hosters.
```

---

# 17. AppDomainService

Add:

```php
FormLogic\Services\AppDomainService
```

Responsibilities:

```txt
normalizeDomain(host)
validateDomain(domain)
rejectPrivateOrInternalDomain(domain)
getDomainByHost(host)
getDomainsForApp(appId)
createDomain(appId, ownerId, domain, mode)
updateDomain(domainId, config)
deleteDomain(domainId)
generateVerificationToken()
verifyDnsTxt(domain)
verifyHttpFile(domain)
markActive(domainId)
markFailed(domainId, reason)
resolveLaunchConfig(host)
assertOwnerCanManageDomain(userId, appId, domainId)
buildPwaManifestForHost(host)
buildClientManifestForHost(host)
buildAssetLinksForHost(host)
```

---

# 18. AppDomainController

Add:

```php
FormLogic\Controllers\AppDomainController
```

Admin routes:

```txt
GET    /api/apps/{appId}/domains
POST   /api/apps/{appId}/domains
GET    /api/apps/{appId}/domains/{domainId}
PUT    /api/apps/{appId}/domains/{domainId}
POST   /api/apps/{appId}/domains/{domainId}/verify
DELETE /api/apps/{appId}/domains/{domainId}
```

Public/domain routes:

```txt
GET /.well-known/formlogic-app.json
GET /.well-known/assetlinks.json
GET /manifest.json
GET /api/public/launch/by-host
GET /api/public/launch/{domain}
```

---

# 19. Public launch API

Add:

```txt
GET /api/public/launch/by-host
```

It resolves the request host to an active app domain and returns **safe public metadata only**.

Example response:

```json
{
  "app": {
    "slug": "minecab",
    "name": "MineCab Operator",
    "description": "Cab-based mining pre-starts, shift logs, faults, and production readings.",
    "logoUrl": "/assets/minecab-logo.png",
    "theme": {
      "primaryColor": "#f59e0b"
    }
  },
  "domain": {
    "domain": "mine.management",
    "mode": "launch_page"
  },
  "landing": {
    "headline": "MineCab Operator",
    "subheadline": "Pre-starts, shift logs, faults, and production readings.",
    "showOpenWebApp": true,
    "showInstallPwa": true,
    "showInstallNative": true,
    "showOpenNative": true,
    "showQrCode": true
  },
  "native": {
    "enabled": true,
    "packageName": "com.formlogic.runtime",
    "minVersion": "0.1.0"
  }
}
```

Do **not** return:

```txt
form schemas
field names
report specs
dashboard queries
custom scripts
API keys
connector secrets
private permissions
hidden forms
owner-only metadata
```

The existing authenticated `/api/app/{slug}` runtime config can remain the full runtime config, because it already performs membership and permission filtering.

---

# 20. Custom domain routing

There are two implementation options.

## 20.1 Option A — frontend host detection

Same React app loads on every domain.

On boot:

```ts
const host = window.location.host;

if (!isFormLogicMainHost(host)) {
  render(<DomainLaunchRouter host={host} />);
} else {
  render(<NormalFormLogicApp />);
}
```

`DomainLaunchRouter` calls:

```txt
GET /api/public/launch/by-host
```

Then renders:

```txt
AppLaunchPage
or
AppRuntimeRoot in custom-domain mode
```

## 20.2 Option B — backend/server host rendering

The backend detects `Host` and serves domain-specific HTML/meta.

Pros:

```txt
better SEO
better social cards
faster first paint
cleaner launch HTML
```

Cons:

```txt
more server routing complexity
more deployment complexity
harder with SPA-only hosting
```

## 20.3 Recommendation

Start with **Option A**.

Reason:

```txt
The repo already uses a Vite SPA and has an app runtime.
Option A is faster to implement.
Server-rendered domain launch pages can come later.
```

---

# 21. App launch page

Add:

```txt
form-builder/ui/src/pages/AppLaunchPage.tsx
form-builder/ui/src/pages/DomainLaunchRouter.tsx
form-builder/ui/src/lib/domainLaunchApi.ts
```

The launch page should include:

```txt
App logo/icon
App name
Business name
Short description
Status badges:
  - Web app
  - PWA ready
  - Native supported
  - Offline ready
Primary CTA:
  - Open app
Secondary CTAs:
  - Install PWA
  - Install Android app
  - Open in FormLogic Native Runtime
Native connector notice
QR code for mobile install
Support email/phone
Privacy/terms links
Powered by FormLogic toggle
```

Suggested config:

```ts
export interface AppDomainLandingConfig {
  headline?: string;
  subheadline?: string;
  description?: string;

  heroImageUrl?: string;
  logoUrl?: string;
  backgroundImageUrl?: string;

  primaryButtonLabel?: string;
  secondaryButtonLabel?: string;

  showOpenWebApp: boolean;
  showInstallPwa: boolean;
  showInstallNative: boolean;
  showOpenNative: boolean;
  showQrCode: boolean;
  showPoweredBy: boolean;

  supportEmail?: string;
  supportPhone?: string;
  privacyUrl?: string;
  termsUrl?: string;
}
```

Avoid arbitrary `customCss` in the MVP. Add controlled theme/layout options instead.

---

# 22. PWA runtime plan

The existing app runtime already modifies the manifest link and theme/icon when an app is loaded.

For custom domains, improve this so the manifest is same-origin:

```txt
https://mine.management/manifest.json
```

The manifest should return:

```json
{
  "name": "MineCab Operator",
  "short_name": "MineCab",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "theme_color": "#f59e0b",
  "background_color": "#ffffff",
  "icons": [
    {
      "src": "/assets/icons/minecab-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/assets/icons/minecab-512.png",
      "sizes": "512x512",
      "type": "image/png"
    }
  ]
}
```

For custom domains, `start_url` should generally be:

```txt
/
```

not:

```txt
/app/minecab
```

That makes:

```txt
mine.management
```

feel like the app itself.

---

# 23. Auth and cookie model for custom domains

This is a major technical gotcha.

The current app runtime uses credentialed API calls and CSRF-protected writes. That works naturally on the main FormLogic domain, but custom domains introduce cookie boundaries:

```txt
formlogic.com cookies do not automatically belong to mine.management
```

## MVP recommendation: same-origin reverse proxy

Custom domain serves both:

```txt
https://mine.management/
https://mine.management/api/...
```

Behind the scenes:

```txt
/mine.management/api → FormLogic backend
```

This keeps cookies first-party for the custom domain.

## Long-term options

Add:

```txt
short-lived app session tokens
device-bound native sessions
kiosk/device scoped tokens
server-proxy mode for public websites
```

Avoid putting broad API keys in public browser apps.

The current external API already has scoped API-key concepts such as forms, responses, and webhooks. The external API routing separates forms read, response write, response read, response manage, analytics, and webhook scopes.

For public/browser apps, use least privilege:

```txt
public submit only
specific app/form only
no response reading unless authenticated
expiry/device/session binding
rate limits
```

---

# 24. Client App Manifest

Add an app-centric manifest separate from the browser PWA manifest.

Endpoints:

```txt
GET /.well-known/formlogic-app.json
GET /api/app/{slug}/client-manifest
```

Example:

```json
{
  "version": 1,
  "kind": "formlogic.clientApp",
  "appSlug": "minecab",
  "domain": "mine.management",

  "display": {
    "name": "MineCab Operator",
    "shortName": "MineCab",
    "description": "Cab pre-starts, shift logs, faults, and production readings.",
    "logoUrl": "/assets/logo.png",
    "themeColor": "#f59e0b"
  },

  "source": {
    "kind": "formlogic-runtime",
    "url": "https://mine.management/app/minecab",
    "fallbackUrl": "https://formlogic.com/app/minecab"
  },

  "install": {
    "pwa": {
      "enabled": true,
      "manifestUrl": "https://mine.management/manifest.json"
    },
    "android": {
      "enabled": true,
      "packageName": "com.formlogic.runtime",
      "minVersion": "0.1.0",
      "playStoreUrl": null,
      "apkUrl": "https://mine.management/download/android"
    }
  },

  "auth": {
    "mode": "app-session",
    "allowSelfRegistration": false
  },

  "offline": {
    "enabled": true,
    "queueSubmissions": true,
    "syncOnReconnect": true,
    "conflictStrategy": "server-wins"
  },

  "native": {
    "enabled": true,
    "requiredFor": ["vehicle.telemetry"],
    "capabilities": [
      {
        "connector": "vehicle",
        "commands": [
          "status.read",
          "faults.read",
          "engineHours.read"
        ],
        "required": true,
        "reason": "Prefill pre-start and fault reports from the current vehicle."
      }
    ]
  },

  "sdk": {
    "enabled": true,
    "version": "1",
    "allowedHooks": [
      "useCurrentApp",
      "useCurrentUser",
      "useForm",
      "useResponses",
      "useConnector",
      "useOfflineQueue",
      "usePermissions"
    ]
  },

  "logic": {
    "runtime": "quickjs",
    "strictPermissions": true,
    "permissions": [
      "ui.toast",
      "ui.setValues",
      "connector.vehicle.status.read",
      "connector.vehicle.faults.read"
    ]
  }
}
```

Do not expose full private form schemas from the public manifest.

Instead:

```txt
public launch manifest = install/display/native metadata
authenticated runtime config = forms/fields/permissions filtered by existing runtime rules
```

---

# 25. Signed manifests

Native capabilities are powerful, so the native runtime must not trust arbitrary remote JSON.

Return signed manifests:

```json
{
  "manifest": {
    "version": 1,
    "kind": "formlogic.clientApp"
  },
  "signature": "base64url-signature",
  "alg": "Ed25519",
  "keyId": "formlogic-prod-2026-01"
}
```

FormLogic Native Runtime verifies:

```txt
1. Signature is valid.
2. Signing key is trusted.
3. Current origin matches the manifest domain.
4. App slug/domain match.
5. Requested native capabilities are allowed.
6. User/device/session is allowed.
7. Runtime version satisfies minVersion.
```

Important rule:

> Any PWA can be displayed, but only signed FormLogic apps get native connector access.

---

# 26. Android App Links

Use Android App Links for “Open in FormLogic Native Runtime”.

Android’s docs describe App Links as web links associated with an Android app; verified Android App Links can open the app directly rather than showing a disambiguation dialog. ([Android Developers][4])

For verification, Android uses Digital Asset Links and checks the site association file. The App Links verification docs describe serving `assetlinks.json` from the website and configuring app intent filters for verification. ([Android Developers][5])

Serve:

```txt
https://mine.management/.well-known/assetlinks.json
```

Example:

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.formlogic.runtime",
      "sha256_cert_fingerprints": [
        "AA:BB:CC:DD:..."
      ]
    }
  }
]
```

Native button behaviour:

```txt
Open native app
  ↓
https://mine.management/open-native?app=minecab
  ↓
Android App Link opens FormLogic Native Runtime
  ↓
Native Runtime receives domain/app context
  ↓
Runtime fetches signed manifest
  ↓
Runtime loads app
```

Fallback:

```txt
If app not installed:
  browser remains on launch page
  show Install Android app CTA
```

---

# 27. FormLogic SDK

This is the major new product layer.

Think of it like:

```txt
React → React DOM
FormLogic Core → FormLogic SDK
```

The SDK makes custom screens, AI-generated interfaces, and app-specific frontends much easier to build.

Instead of every custom screen manually handling:

```txt
runtime config
forms
responses
permissions
connectors
offline queue
current user
current role
navigation
toasts
submission
```

the SDK exposes simple hooks and components.

## 27.1 SDK goals

```txt
Make custom screens easy.
Make AI-generated screens predictable.
Reduce boilerplate.
Keep permissions enforced.
Keep custom UI inside safe runtime boundaries.
Unify browser/PWA/native runtime APIs.
Make connectors feel like normal app data sources.
```

## 27.2 SDK package shape

Long-term package:

```txt
@formlogic/sdk
```

In-repo MVP location:

```txt
form-builder/ui/src/sdk/
```

Suggested structure:

```txt
sdk/
├── index.ts
├── hooks/
│   ├── useCurrentApp.ts
│   ├── useCurrentUser.ts
│   ├── useRole.ts
│   ├── usePermissions.ts
│   ├── useForm.ts
│   ├── useForms.ts
│   ├── useResponses.ts
│   ├── useResponse.ts
│   ├── useSubmitResponse.ts
│   ├── useConnector.ts
│   ├── useConnectors.ts
│   ├── useOfflineQueue.ts
│   ├── useSettings.ts
│   ├── useAppNavigation.ts
│   └── useToast.ts
├── components/
│   ├── FormView.tsx
│   ├── ResponseList.tsx
│   ├── ResponseDetail.tsx
│   ├── ConnectorStatus.tsx
│   ├── SyncStatus.tsx
│   ├── PermissionGate.tsx
│   ├── AppButton.tsx
│   └── EmptyState.tsx
├── runtime/
│   ├── FormLogicProvider.tsx
│   ├── sdkContext.ts
│   └── sdkClient.ts
└── types/
    ├── app.ts
    ├── form.ts
    ├── response.ts
    ├── connector.ts
    └── offline.ts
```

## 27.3 Core SDK hooks

```ts
useCurrentApp()
useCurrentUser()
useRole()
usePermissions()

useForm(formKeyOrId)
useForms()
useResponses(formKeyOrId, options)
useResponse(formKeyOrId, responseId)
useSubmitResponse(formKeyOrId)

useConnector(connectorId)
useConnectors()

useOfflineQueue()
useSettings()
useAppNavigation()
useToast()
```

## 27.4 SDK example

Instead of this:

```ts
ctx.formlogic.submit(...)
```

custom screens can do:

```tsx
const vehicle = useConnector("vehicle");
const user = useCurrentUser();
const responses = useResponses("faults");
const submitPrestart = useSubmitResponse("prestarts");
```

Example custom screen:

```tsx
import {
  useConnector,
  useCurrentUser,
  useSubmitResponse,
  useToast,
} from "@formlogic/sdk";

export function PrestartQuickStart() {
  const user = useCurrentUser();
  const vehicle = useConnector("vehicle");
  const submitPrestart = useSubmitResponse("prestarts");
  const toast = useToast();

  async function startPrestart() {
    const status = await vehicle.request("status.read");

    await submitPrestart({
      operator_id: user.id,
      vehicle_id: status.vehicleId,
      engine_hours: status.engineHours,
      fuel_percent: status.fuelPercent,
      started_at: new Date().toISOString(),
    });

    toast.success("Pre-start created");
  }

  return (
    <button onClick={startPrestart}>
      Start pre-start
    </button>
  );
}
```

## 27.5 SDK + AI-generated screens

This is a big deal.

AI-generated screens become much safer and easier if the AI only needs to use documented SDK hooks:

```tsx
const jobs = useResponses("jobs", { status: "open" });
const permissions = usePermissions();
const nav = useAppNavigation();
```

Instead of having to understand:

```txt
raw API endpoints
auth model
response schema shape
permissions
runtime store
native bridge
offline queue internals
```

This will make app generation much more reliable.

## 27.6 SDK permission boundaries

SDK hooks must not bypass existing permissions.

For example:

```ts
useResponses("faults")
```

should internally check:

```txt
Does user have view_own_responses or view_all_responses?
Should the query be scoped to own responses?
Can this role see this form?
```

The server remains authoritative, but the SDK should guide the UI correctly.

## 27.7 SDK runtime modes

The SDK should work across:

```txt
platform runtime
custom domain runtime
native runtime
demo mode
offline mode
test/preview mode
```

Example:

```ts
const env = useRuntimeEnvironment();

env.hostMode
// "platform" | "custom-domain" | "native"

env.nativeAvailable
// boolean

env.offline
// boolean
```

## 27.8 SDK should be versioned

Add:

```txt
sdkVersion: 1
```

to app/client manifests.

Custom screens should declare:

```json
{
  "sdk": {
    "version": 1,
    "requiredHooks": [
      "useConnector",
      "useSubmitResponse"
    ]
  }
}
```

This helps future-proof AI-generated screens.

---

# 28. SDK components

Hooks are great for developers, but components make AI generation even easier.

Suggested SDK components:

```tsx
<FormView form="prestarts" />

<ResponseList form="faults" limit={10} />

<ResponseDetail form="faults" responseId={id} />

<ConnectorStatus connector="vehicle" />

<SyncStatus />

<PermissionGate permission="submit_responses" form="prestarts">
  <button>Start pre-start</button>
</PermissionGate>

<AppButton action="navigate" to="faults">
  Report fault
</AppButton>
```

Example MineCab screen:

```tsx
import {
  ConnectorStatus,
  ResponseList,
  SyncStatus,
  PermissionGate,
  AppButton,
} from "@formlogic/sdk";

export function CabHome() {
  return (
    <main>
      <ConnectorStatus connector="vehicle" />
      <SyncStatus />

      <PermissionGate permission="submit_responses" form="prestarts">
        <AppButton action="navigate" to="prestart">
          Start pre-start
        </AppButton>
      </PermissionGate>

      <ResponseList form="faults" limit={5} />
    </main>
  );
}
```

This gives FormLogic a much stronger AI story:

> AI can generate app screens using a safe, documented FormLogic SDK instead of inventing API calls.

---

# 29. FormLogic Application Package

Right now FormLogic has packs, which are excellent. But this plan introduces a broader concept:

```txt
Application Package
```

Suggested file extension:

```txt
.formlogic
```

Example:

```txt
MineCab.formlogic
```

This is the portable app unit for the future.

## 29.1 Difference between Pack and Application Package

Current pack:

```txt
forms
apps
screens
scripts
reports
sample data
```

Application Package:

```txt
app manifest
forms
screens
dashboards
reports
QuickJS logic
SDK screens
assets
translations
native connector config
domain launch config
offline sync config
marketplace metadata
tests
sample data
```

In other words:

```txt
Pack = installable business system
Application Package = full deployable/runtime-aware business app bundle
```

The existing pack system can evolve into Application Packages rather than being replaced.

## 29.2 Package structure

Suggested `.formlogic` archive:

```txt
MineCab.formlogic
├── manifest.json
├── forms.json
├── screens.json
├── dashboards.json
├── reports.json
├── roles.json
├── permissions.json
├── workflows.json
├── quickjs/
│   ├── prestart.onScreenEnter.js
│   ├── prestart.onConnectorEvent.js
│   ├── prestart.onBeforeSubmit.js
│   └── fault.onConnectorEvent.js
├── sdk-screens/
│   ├── CabHome.tsx
│   ├── PrestartFlow.tsx
│   └── FaultReport.tsx
├── native/
│   ├── capabilities.json
│   ├── connectors.json
│   └── permissions.json
├── launch/
│   ├── landing.json
│   └── pwa.json
├── assets/
│   ├── logo.svg
│   ├── icon-192.png
│   ├── icon-512.png
│   └── hero.png
├── translations/
│   ├── en.json
│   └── en-AU.json
├── demo-data/
│   ├── vehicles.json
│   ├── operators.json
│   └── prestarts.json
├── tests/
│   ├── import.test.json
│   ├── quickjs.test.json
│   └── dashboard.test.json
└── README.md
```

## 29.3 Application package manifest

Example:

```json
{
  "version": 1,
  "kind": "formlogic.applicationPackage",
  "id": "minecab",
  "name": "MineCab Operator",
  "description": "Mining cab pre-starts, shift logs, fault reports, and production readings.",
  "category": "Field Ops & Compliance",
  "tags": [
    "mining",
    "fleet",
    "pre-start",
    "offline",
    "native-runtime"
  ],
  "author": {
    "name": "FormLogic",
    "url": "https://formlogic.com"
  },
  "runtime": {
    "requires": {
      "formlogic": ">=1.0.0",
      "sdk": ">=1.0.0"
    },
    "supports": [
      "browser-pwa",
      "native-android"
    ]
  },
  "entry": {
    "app": "manifest.json",
    "homeScreen": "sdk-screens/CabHome.tsx"
  },
  "capabilities": {
    "offline": true,
    "native": true,
    "connectors": [
      "vehicle"
    ],
    "quickjs": true
  }
}
```

## 29.4 Package import flow

```txt
Upload MineCab.formlogic
  ↓
Validate manifest
  ↓
Check version compatibility
  ↓
Preview forms/screens/reports/native permissions
  ↓
Install into workspace
  ↓
Seed demo data optionally
  ↓
Create app
  ↓
Open Deploy & Share
```

## 29.5 Package export flow

```txt
Existing FormLogic app
  ↓
Export as .formlogic
  ↓
Include forms, roles, dashboards, reports, QuickJS, SDK screens, assets, native config
  ↓
Optionally include demo data
  ↓
Sign package
  ↓
Publish to marketplace or share privately
```

## 29.6 Package signing

Application Packages should eventually support signatures:

```json
{
  "package": {},
  "signature": "base64url...",
  "alg": "Ed25519",
  "keyId": "formlogic-marketplace-2026-01"
}
```

Use cases:

```txt
official FormLogic packages
verified third-party packages
private enterprise packages
tamper detection
connector trust
```

---

# 30. FormLogic Marketplace

The marketplace should eventually expand beyond apps.

Marketplace categories:

```txt
Apps
Connectors
Themes
QuickJS Libraries
SDK Components
Widgets
Templates
Reports
Dashboards
Application Packages
```

Example marketplace items:

```txt
Apps:
- MineCab Operator
- CounterFlow POS
- FleetFlow
- BrewDesk
- RepairBench

Connectors:
- Komatsu Connector
- CAT Connector
- Square POS Connector
- Stripe Connector
- MYOB Connector
- Xero Connector
- Shopify Connector
- Barcode Scanner Connector
- Local HTTP Connector

Themes:
- Industrial Dark
- Cafe Light
- Field Ops High Contrast
- Client Portal Minimal

QuickJS Libraries:
- Safety validation helpers
- Finance calculations
- Inventory reorder rules
- Shift scheduling helpers

SDK Components:
- Job board
- Kanban board
- POS cart
- Vehicle status card
- Signature approval flow

Widgets:
- KPI card pack
- Fleet status grid
- Order queue
- Fault heatmap
```

## 30.1 Marketplace install model

```txt
Marketplace item
  ↓
Preview
  ↓
Permissions/capabilities review
  ↓
Install
  ↓
Configure
  ↓
Use in app
```

For connectors, the install flow must show:

```txt
connector capabilities
native permissions required
cloud credentials required
data access scope
offline support
supported platforms
security notes
```

## 30.2 Connector marketplace

Connectors can become a major product category.

A connector package could include:

```txt
connector manifest
native plugin references
cloud auth config
QuickJS mapping helpers
SDK hook helpers
test simulator
sample data
docs
```

Example connector package:

```txt
CAT Connector
├── manifest.json
├── native/
│   ├── android.json
│   └── driver.rs
├── quickjs/
│   └── mapping-helpers.js
├── sdk/
│   └── useCatVehicle.ts
├── simulator/
│   └── sample-status.json
└── README.md
```

## 30.3 Marketplace trust levels

```txt
Official
  Built by FormLogic.

Verified
  Reviewed and signed.

Community
  User-published, lower trust.

Private
  Internal workspace/enterprise only.
```

Native connectors should generally require:

```txt
Official or Verified trust level
signed package
explicit capability review
runtime permission prompts
```

---

# 31. QuickJS custom app logic

This is the key correction to the plan.

QuickJS should be used for **sandboxed custom app logic**, not for the whole UI.

## 31.1 Correct division

```txt
React/PWA:
  renders screens, forms, dashboards, navigation, install UI.

FormLogic SDK:
  makes custom screens easy and permission-aware.

QuickJS:
  runs custom business logic hooks safely.

Trusted host:
  applies allowed effects after permission checks.

FormLogic backend:
  validates, stores, runs server scripts, audits, reports.
```

## 31.2 Why this fits the repo

The backend QuickJS runner already runs user code in a sandbox and supports host-mediated calls such as `ctx.db`, `ctx.http`, and `ctx.utils`, where IO and safety guards stay in PHP.

The browser-side QuickJS host already runs untrusted expressions in a QuickJS WASM VM with an empty global object, no host bindings, memory/stack limits, and interrupt deadlines.

So custom app logic should extend the existing QuickJS philosophy:

```txt
same sandbox mindset
limited JSON context
explicit permissions
safe host bridge
no raw window/document/fetch/native access
```

## 31.3 Do not overload CustomScreen

The existing `CustomScreen` type is for custom frontend screens and dashboard screens. It has HTML/CSS/JS fields and a `kind` of `code` or `dashboard`.

Do not jam app behaviour logic into this same field.

Instead, add a separate app-logic concept:

```ts
app.customLogic?: CustomAppLogicBundle
form.customLogic?: CustomAppLogicBundle
screen.customLogic?: CustomAppLogicBundle
```

MVP should start with:

```ts
app.customLogic
```

---

# 32. QuickJS effect-based model

Browser QuickJS should not directly call native async connectors in MVP.

Avoid this as the first model:

```js
const status = await ctx.connectors.vehicle.readStatus();
```

Use an effect model instead:

```txt
QuickJS receives JSON ctx
  ↓
QuickJS returns effects / UI patches
  ↓
Trusted host checks permissions
  ↓
Trusted host executes effects
  ↓
Host may trigger another hook with results
```

Example:

```js
function run(ctx) {
  if (!ctx.meta.nativeAvailable) {
    return {
      ui: {
        toast: {
          level: "warning",
          message: "Vehicle connector unavailable. Enter vehicle details manually."
        }
      }
    };
  }

  return {
    effects: [
      {
        type: "connector.request",
        connectorId: "vehicle",
        command: "status.read"
      }
    ]
  };
}
```

Then host does:

```txt
connector.request
  ↓
vehicle status result
  ↓
run onConnectorEvent with result
```

Second hook:

```js
function run(ctx) {
  const vehicle = ctx.event.vehicleStatus;

  return {
    ui: {
      setValues: {
        vehicle_id: vehicle.vehicleId,
        fleet_number: vehicle.fleetNumber,
        engine_hours: vehicle.engineHours,
        fuel_percent: vehicle.fuelPercent
      }
    }
  };
}
```

This is safer than giving QuickJS raw live access.

---

# 33. QuickJS app logic types

Suggested type model:

```ts
export type CustomAppLogicRuntime = 'quickjs';

export type CustomAppLogicHookName =
  | 'onAppStart'
  | 'onScreenEnter'
  | 'onScreenLeave'
  | 'onButtonClick'
  | 'onBeforeSubmit'
  | 'onAfterSubmit'
  | 'onConnectorEvent'
  | 'onSyncConflict'
  | 'mapConnectorDataToForm'
  | 'calculateDashboardState';

export type CustomAppLogicPermission =
  | '*'
  | 'formlogic.forms.read'
  | 'formlogic.responses.write'
  | 'formlogic.responses.read'
  | 'formlogic.responses.manage'
  | 'storage.local'
  | 'ui.toast'
  | 'ui.navigate'
  | 'ui.setValues'
  | 'ui.reject'
  | `connector.${string}.${string}`
  | `${string}.*`;

export interface CustomAppLogicBundle {
  version: 1;
  runtime: CustomAppLogicRuntime;
  scripts: CustomAppLogicScript[];
  permissions?: CustomAppLogicPermission[];
  strictPermissions?: boolean;
}

export interface CustomAppLogicScript {
  id: string;
  hook: CustomAppLogicHookName;
  runtime: CustomAppLogicRuntime;
  source: string;
  description?: string;
  enabled?: boolean;
  permissions?: CustomAppLogicPermission[];
  budgetMs?: number;
}
```

A draft type-only file was briefly created before the request was clarified; it reflects this same concept and currently defines the planned hook/effect types only.

If no repo change is wanted, either leave it as an unused draft or revert it before implementation.

---

# 34. QuickJS permissions

Example app logic config:

```json
{
  "version": 1,
  "runtime": "quickjs",
  "strictPermissions": true,
  "permissions": [
    "ui.toast",
    "ui.setValues",
    "ui.navigate",
    "formlogic.responses.write",
    "connector.vehicle.status.read",
    "connector.vehicle.faults.read"
  ],
  "scripts": [
    {
      "id": "prestart-prefill",
      "hook": "onConnectorEvent",
      "runtime": "quickjs",
      "permissions": [
        "ui.setValues",
        "ui.toast"
      ],
      "source": "function run(ctx) { return { ui: { setValues: {} } }; }"
    }
  ]
}
```

Permission examples:

```txt
ui.toast
ui.setValues
ui.navigate
ui.reject

storage.local

formlogic.forms.read
formlogic.responses.write
formlogic.responses.read
formlogic.responses.manage

connector.vehicle.status.read
connector.vehicle.faults.read
connector.vehicle.engineHours.read
connector.barcode.scan
connector.pos.order.read
```

Every emitted effect must map to a permission.

Recommended connector effect:

```json
{
  "type": "connector.request",
  "connectorId": "vehicle",
  "command": "status.read"
}
```

Permission:

```txt
connector.vehicle.status.read
```

---

# 35. QuickJS hooks

## 35.1 `onAppStart`

Runs when app starts.

Use for:

```txt
welcome messages
native availability check
role-based home route
offline notice
initial connector status request
```

## 35.2 `onScreenEnter`

Runs when a screen opens.

Use for:

```txt
prefill requests
connector status requests
screen-specific warnings
local state restore
```

## 35.3 `onScreenLeave`

Runs when leaving a screen.

Use for:

```txt
draft save
cleanup
local validation warning
```

## 35.4 `onButtonClick`

Runs for custom buttons.

Use for:

```txt
scan barcode
start shift
report fault
open connector settings
navigate to guided flow
```

## 35.5 `onBeforeSubmit`

Runs before submitting a form.

Use for:

```txt
local warnings
required connector checks
answer transformations
offline queue decision
basic validation
```

Backend remains authoritative.

The app runtime backend already sanitizes submitted answers, re-derives file URLs, recalculates calculated fields, validates answers, checks closed/quota states, and then creates the response through app response services.

## 35.6 `onAfterSubmit`

Runs after server accepts response.

Use for:

```txt
show success toast
navigate to summary
start next task
queue follow-up local action
```

## 35.7 `onConnectorEvent`

Runs when native/browser connector returns data.

Use for:

```txt
map vehicle status to form values
map barcode to product
map POS order to record
map GPS to location field
```

## 35.8 `onSyncConflict`

Runs when offline record conflicts with server.

MVP:

```txt
server-wins
manual retry
show conflict notice
```

Post-MVP:

```txt
custom merge script
supervisor review queue
field-level conflict resolution
```

---

# 36. QuickJS host API shape

Inside QuickJS, expose a safe `ctx`.

```ts
interface CustomAppLogicCtx {
  hook: string;
  answers: Record<string, unknown>;
  values: Record<string, unknown>;
  params: Record<string, unknown>;
  meta: {
    appSlug?: string;
    appId?: string;
    formId?: string;
    formKey?: string;
    screenId?: string;
    userRole?: string;
    nativeAvailable?: boolean;
    offline?: boolean;
    now?: string;
  };
  event?: unknown;

  formlogic: {
    submitResponse(formKey: string, answers: Record<string, unknown>): EffectRef;
    listResponses(formKey: string, query?: Record<string, unknown>): EffectRef;
  };

  connectors: {
    request(connectorId: string, command: string, payload?: unknown): EffectRef;
  };

  storage: {
    get(key: string): EffectRef;
    set(key: string, value: unknown): EffectRef;
    remove(key: string): EffectRef;
  };

  ui: {
    toast(message: string, level?: 'info' | 'success' | 'warning' | 'error'): EffectRef;
    navigate(screenId: string, params?: Record<string, unknown>): EffectRef;
    setValues(values: Record<string, unknown>): EffectRef;
    reject(message: string): EffectRef;
  };
}
```

No access to:

```txt
window
document
raw fetch
WebSocket
Bluetooth
USB
filesystem
cookies
native bridge directly
API keys
eval outside sandbox
```

---

# 37. QuickJS result format

Script returns:

```ts
interface CustomAppLogicRunResult {
  ok: boolean;
  value?: unknown;
  effects: CustomAppLogicEffect[];
  ui?: {
    setValues?: Record<string, unknown>;
    navigate?: { screenId: string; params?: Record<string, unknown> };
    toast?: { message: string; level?: 'info' | 'success' | 'warning' | 'error' };
  };
  reject?: boolean;
  message?: string;
  warnings?: string[];
  error?: string;
}
```

Example `onBeforeSubmit`:

```js
function run(ctx) {
  if (Number(ctx.answers.fuel_percent || 0) < 10) {
    return {
      reject: true,
      message: "Fuel is too low to start this shift."
    };
  }

  if (ctx.answers.active_fault_codes) {
    return {
      warnings: [
        "Active fault codes detected. Supervisor review recommended."
      ]
    };
  }

  return { ok: true };
}
```

Example `onConnectorEvent`:

```js
function run(ctx) {
  const vehicle = ctx.event.vehicleStatus;

  if (!vehicle) {
    return {
      ui: {
        toast: {
          level: "warning",
          message: "No vehicle data received."
        }
      }
    };
  }

  return {
    ui: {
      setValues: {
        vehicle_id: vehicle.vehicleId,
        fleet_number: vehicle.fleetNumber,
        engine_hours: vehicle.engineHours,
        fuel_percent: vehicle.fuelPercent,
        active_fault_codes: (vehicle.faultCodes || []).join(", ")
      }
    }
  };
}
```

---

# 38. FormLogic Native Runtime structure

Create:

```txt
form-builder/native-runtime/
```

Suggested structure:

```txt
form-builder/native-runtime/
├── package.json
├── src/
│   ├── main.tsx
│   ├── NativeHostRoot.tsx
│   ├── bridge/
│   │   ├── nativeBridge.ts
│   │   ├── connectorClient.ts
│   │   └── syncClient.ts
│   ├── screens/
│   │   ├── AppChooser.tsx
│   │   ├── DomainOpenScreen.tsx
│   │   ├── ConnectorPermissionsScreen.tsx
│   │   └── OfflineQueueScreen.tsx
│   └── styles.css
│
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── capabilities/
    │   └── default.json
    ├── src/
    │   ├── main.rs
    │   ├── commands.rs
    │   ├── app_manifest.rs
    │   ├── sync_queue.rs
    │   ├── secure_store.rs
    │   └── connectors/
    │       ├── mod.rs
    │       ├── registry.rs
    │       ├── types.rs
    │       ├── mock_vehicle.rs
    │       ├── local_http.rs
    │       ├── bluetooth.rs
    │       └── usb_serial.rs
    └── gen/android/
```

MVP modes:

```ts
type NativeAppSource =
  | { kind: 'formlogic-runtime'; appSlug: string; domain?: string }
  | { kind: 'hosted-pwa'; url: string; allowedOrigins: string[] }
  | { kind: 'local-dev'; url: string };
```

Later mode:

```ts
type NativeAppSource =
  | { kind: 'packaged-bundle'; bundleId: string; version: string; integrity: string };
```

Packaged bundles are useful later for mine sites with weak internet, but they should not be in the first milestone.

---

# 39. Native bridge API

Inside the PWA/runtime, expose:

```ts
declare global {
  interface Window {
    FormLogicNative?: {
      available: boolean;

      runtime: {
        getInfo(): Promise<NativeRuntimeInfo>;
        openExternal(url: string): Promise<void>;
      };

      connectors: {
        list(): Promise<ConnectorSummary[]>;
        status(connectorId: string): Promise<ConnectorStatus>;
        request<T = unknown>(
          connectorId: string,
          command: string,
          payload?: unknown
        ): Promise<T>;
        subscribe(
          connectorId: string,
          eventName: string,
          callback: (event: unknown) => void
        ): () => void;
      };

      sync: {
        enqueueSubmission(input: OfflineSubmission): Promise<{ id: string }>;
        flush(): Promise<SyncResult>;
        getQueue(): Promise<QueuedSubmission[]>;
      };

      secureStore: {
        get(key: string): Promise<string | null>;
        set(key: string, value: string): Promise<void>;
        remove(key: string): Promise<void>;
      };
    };
  }
}
```

But do not expose this bridge to arbitrary origins.

Bridge activation requirements:

```txt
origin allowed
manifest signed
manifest domain matches origin
app slug matches manifest
user/device/session approved
capabilities explicitly granted
connector command allowed
```

---

# 40. Connector registry

Native connector abstraction:

```rust
pub trait Connector {
    fn id(&self) -> &'static str;
    fn kind(&self) -> &'static str;
    fn capabilities(&self) -> Vec<Capability>;

    async fn status(&self) -> ConnectorStatus;

    async fn request(
        &self,
        command: String,
        payload: serde_json::Value
    ) -> Result<serde_json::Value, ConnectorError>;
}
```

Connector types:

```txt
mock_vehicle
local_http
bluetooth_ble
bluetooth_classic
usb_serial
barcode_scanner
nfc
gps/geolocation
camera
receipt_printer
pos_api
file_import
```

Use official/common Tauri plugins where practical. Tauri’s plugin documentation and plugin ecosystem cover common app capabilities, and the plugin model is intended for extending app functionality beyond core Tauri. ([Tauri][6])

---

# 41. Connector command model

Apps should not care about transport details.

MineCab should request abstract commands:

```txt
vehicle.identity.read
vehicle.status.read
vehicle.engineHours.read
vehicle.faults.read
vehicle.gps.read
vehicle.production.read
```

A connector implementation decides whether those come from:

```txt
mock data
local HTTP bridge
Bluetooth
USB serial
CAN/J1939 adapter
vendor API
site telemetry API
```

MVP command naming should be simpler:

```txt
identity.read
status.read
engineHours.read
faults.read
gps.read
production.read
```

With connector ID:

```txt
vehicle
```

Permission examples:

```txt
connector.vehicle.identity.read
connector.vehicle.status.read
connector.vehicle.engineHours.read
connector.vehicle.faults.read
connector.vehicle.gps.read
```

---

# 42. FormLogic Connect

FormLogic Connect is the connector/plugin layer used by FormLogic Native Runtime and, in limited cases, browser/PWA runtime.

Connector categories:

```txt
mock connectors
local HTTP connectors
Bluetooth connectors
USB serial connectors
barcode scanners
NFC
GPS/geolocation
camera
receipt printers
POS APIs
file import/export
external REST APIs
webhooks
```

## MVP connectors

```txt
mock_vehicle
local_http
```

## Later connectors

```txt
bluetooth_ble
usb_serial
barcode_scanner
receipt_printer
pos_api
gps
file_import
```

---

# 43. MineCab connector strategy

MineCab should not know whether data comes from Bluetooth, USB, local HTTP, or API.

It asks for:

```txt
vehicle.identity.read
vehicle.status.read
vehicle.engineHours.read
vehicle.faults.read
vehicle.gps.read
vehicle.production.read
```

MVP command naming:

```txt
identity.read
status.read
engineHours.read
faults.read
gps.read
production.read
```

Connector ID:

```txt
vehicle
```

Permission examples:

```txt
connector.vehicle.identity.read
connector.vehicle.status.read
connector.vehicle.engineHours.read
connector.vehicle.faults.read
connector.vehicle.gps.read
```

---

# 44. Mock vehicle connector

Start with:

```txt
mock_vehicle
```

Response:

```json
{
  "vehicleId": "TRUCK-044",
  "fleetNumber": "F044",
  "operatorId": "OP-918",
  "engineHours": 4120.7,
  "odometer": 87221,
  "fuelPercent": 68,
  "faultCodes": [],
  "status": "ready",
  "location": {
    "lat": -20.123,
    "lng": 148.456
  }
}
```

This enables the demo without hardware.

---

# 45. Local HTTP connector

Second connector:

```txt
local_http
```

Reads from:

```txt
http://127.0.0.1:39291/status
```

or:

```txt
http://192.168.4.1/status
```

Example local bridge response:

```json
{
  "vehicleId": "TRUCK-044",
  "fleetNumber": "F044",
  "engineHours": 4120.7,
  "fuelPercent": 68,
  "faultCodes": ["P0123"],
  "status": "warning"
}
```

The MineCab app still only sees the abstract connector output.

---

# 46. Real vehicle connector later

Real integration depends on site/rig/vendor:

```txt
Bluetooth adapter
USB serial adapter
Wi-Fi gateway
J1939/CAN adapter
OBD-style adapter
vendor SDK/API
mine site telemetry API
```

Do not start here.

Real mining hardware will likely require:

```txt
site-specific protocols
safety approvals
vendor documentation
device testing
offline reliability testing
permission/security review
liability review
```

---

# 47. Offline sync

Offline sync is critical for field/mining/POS.

Use:

```txt
Browser/PWA:
  IndexedDB queue

FormLogic Native Runtime:
  SQLite or Tauri Store/SQL plugin

Backend:
  idempotency table
  batch sync endpoint
```

Queued submission:

```ts
interface QueuedSubmission {
  id: string;
  appSlug: string;
  formId: string;
  formKey?: string;
  answers: Record<string, unknown>;
  attachments?: QueuedAttachment[];
  idempotencyKey: string;
  status: 'pending' | 'syncing' | 'synced' | 'failed';
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}
```

Server idempotency:

```sql
CREATE TABLE app_submission_idempotency (
  id CHAR(36) PRIMARY KEY,
  app_id CHAR(36) NOT NULL,
  form_id CHAR(36) NOT NULL,
  user_id CHAR(36) NULL,
  device_id VARCHAR(128) NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  response_id CHAR(36) NULL,
  payload_hash VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL,
  created_at DATETIME NOT NULL,

  UNIQUE KEY uniq_app_form_key (app_id, form_id, idempotency_key)
);
```

Batch sync endpoint:

```txt
POST /api/app/{slug}/sync/batch
```

Request:

```json
{
  "items": [
    {
      "idempotencyKey": "uuid",
      "formId": "uuid-prestarts",
      "answers": {
        "vehicle_id": "TRUCK-044"
      }
    }
  ]
}
```

Response:

```json
{
  "results": [
    {
      "idempotencyKey": "uuid",
      "success": true,
      "responseId": "resp_123"
    }
  ]
}
```

Each item must go through the normal app response pipeline.

---

# 48. Response submission rules

The app should not duplicate business rules on the client.

Client/PWA/native can:

```txt
prefill
warn
queue offline
perform basic UX validation
```

Backend remains authoritative for:

```txt
field validation
answer sanitisation
file normalisation
calculated fields
closed form checks
quota checks
permissions
onSubmit scripts
webhooks
audit logging
notifications
```

The existing app response path already performs several of these backend-side protections.

---

# 49. Running arbitrary PWA code safely

The native runtime can display arbitrary hosted PWAs, but native connector access must be restricted.

Trust tiers:

```txt
Tier 1 — Display-only hosted PWA
  Can render in native shell.
  No native connector access.

Tier 2 — Signed FormLogic app
  Can use approved native bridge features.
  Must have signed manifest.

Tier 3 — Device-managed FormLogic app
  Can use sensitive connectors/offline sync.
  Requires app + device + user/session approval.
```

Never allow arbitrary remote JS to call:

```ts
window.FormLogicNative.connectors.request(...)
```

unless:

```txt
origin is allowed
manifest is signed
capabilities are approved
user/session is valid
device is approved
connector permission was granted
```

---

# 50. Connector permission UX

Client manifest contains:

```json
{
  "native": {
    "capabilities": [
      {
        "connector": "vehicle",
        "commands": [
          "status.read",
          "faults.read",
          "engineHours.read"
        ],
        "required": true,
        "reason": "Prefill pre-start and fault reports from the current vehicle."
      }
    ]
  }
}
```

Native runtime shows:

```txt
MineCab Operator wants to access:
- Vehicle status
- Engine hours
- Fault codes

Reason:
Prefill pre-start and fault reports from the current vehicle.

[Allow] [Deny]
```

Store approval:

```txt
domain: mine.management
appSlug: minecab
connector: vehicle
allowedCommands:
  - status.read
  - faults.read
  - engineHours.read
approvedAt
approvedByUserId
deviceId
```

---

# 51. MineCab reference app

MineCab should be the first reference app because it proves:

```txt
custom domain
launch page
PWA runtime
SDK screens
native runtime
connector framework
QuickJS app logic
offline sync
Application Package
FormLogic storage/reporting
```

## 51.1 Forms

```txt
Vehicles
- vehicle_id
- fleet_number
- make_model
- site
- status
- current_engine_hours
- current_fault_codes

Operators
- operator_id
- name
- licence_class
- site
- active

Shifts
- shift_id
- vehicle
- operator
- start_time
- end_time
- start_engine_hours
- end_engine_hours
- status

Pre-start Inspections
- shift
- vehicle
- operator
- engine_hours
- fuel_percent
- tyres_ok
- fluids_ok
- brakes_ok
- lights_ok
- safety_equipment_ok
- defects_found
- photos
- signature
- result

Fault Reports
- vehicle
- operator
- shift
- fault_code
- severity
- description
- photos
- status

Production Readings
- shift
- vehicle
- location
- payload_count
- tonnes
- cycle_count
- notes
```

## 51.2 Screens

```txt
Cab Home
- vehicle card
- operator card
- current shift
- sync status
- start pre-start
- report fault
- production reading

Pre-start Flow
- one step at a time
- vehicle prefill
- photo/signature support
- submit/sync

Fault Report
- active fault codes
- severity
- description
- photo
- submit/sync

Shift Summary
- engine hours
- faults
- production readings
- sign off

Offline Queue
- pending
- failed
- synced
- retry
```

## 51.3 Dashboards

```txt
Supervisor Dashboard
- pre-starts today
- active vehicles
- vehicles with faults
- faults by severity
- production readings over time
- open shifts
- recent incidents/faults

Vehicle Dashboard
- latest engine hours
- latest pre-start result
- unresolved faults
- last operator
- recent production readings
```

## 51.4 QuickJS scripts

```txt
prestart.onScreenEnter
  Request vehicle status if native is available.

prestart.onConnectorEvent
  Map vehicle status to pre-start fields.

prestart.onBeforeSubmit
  Warn/reject if critical values are missing.

fault.onConnectorEvent
  Map fault codes to fault report.

shift.onAfterSubmit
  Navigate to shift summary.
```

## 51.5 SDK screens

```txt
CabHome.tsx
PrestartFlow.tsx
FaultReport.tsx
ShiftSummary.tsx
OfflineQueue.tsx
```

---

# 52. Example MineCab QuickJS scripts

## 52.1 Request vehicle status

```js
function run(ctx) {
  if (!ctx.meta.nativeAvailable) {
    return {
      ui: {
        toast: {
          level: "warning",
          message: "Vehicle connector unavailable. Enter vehicle details manually."
        }
      }
    };
  }

  return {
    effects: [
      {
        type: "connector.request",
        connectorId: "vehicle",
        command: "status.read"
      }
    ]
  };
}
```

## 52.2 Map vehicle status

```js
function run(ctx) {
  const vehicle = ctx.event && ctx.event.vehicleStatus;

  if (!vehicle) {
    return {
      ui: {
        toast: {
          level: "warning",
          message: "No vehicle status was received."
        }
      }
    };
  }

  return {
    ui: {
      setValues: {
        vehicle_id: vehicle.vehicleId,
        fleet_number: vehicle.fleetNumber,
        operator_id: vehicle.operatorId,
        engine_hours: vehicle.engineHours,
        fuel_percent: vehicle.fuelPercent,
        active_fault_codes: (vehicle.faultCodes || []).join(", ")
      }
    }
  };
}
```

## 52.3 Before-submit warning

```js
function run(ctx) {
  const fuel = Number(ctx.answers.fuel_percent || 0);
  const faults = String(ctx.answers.active_fault_codes || "");

  if (fuel > 0 && fuel < 10) {
    return {
      reject: true,
      message: "Fuel is too low to start this shift."
    };
  }

  if (faults.trim()) {
    return {
      warnings: [
        "Active fault codes detected. Supervisor review recommended."
      ]
    };
  }

  return { ok: true };
}
```

---

# 53. Example MineCab SDK screen

```tsx
import {
  ConnectorStatus,
  PermissionGate,
  ResponseList,
  SyncStatus,
  useConnector,
  useCurrentUser,
  useSubmitResponse,
  useToast,
} from "@formlogic/sdk";

export function CabHome() {
  const user = useCurrentUser();
  const vehicle = useConnector("vehicle");
  const submitPrestart = useSubmitResponse("prestarts");
  const toast = useToast();

  async function startPrestart() {
    const status = await vehicle.request("status.read");

    await submitPrestart({
      operator_id: user.id,
      vehicle_id: status.vehicleId,
      fleet_number: status.fleetNumber,
      engine_hours: status.engineHours,
      fuel_percent: status.fuelPercent,
      started_at: new Date().toISOString(),
    });

    toast.success("Pre-start started");
  }

  return (
    <main>
      <ConnectorStatus connector="vehicle" />
      <SyncStatus />

      <PermissionGate permission="submit_responses" form="prestarts">
        <button onClick={startPrestart}>
          Start pre-start
        </button>
      </PermissionGate>

      <ResponseList form="faults" limit={5} />
    </main>
  );
}
```

This is the style AI-generated screens should aim for.

---

# 54. Deploy & Share UI changes

The repo already has app deployment/PWA concepts, so extend the app deploy page.

New layout:

```txt
Deploy & Share
├── Status
├── Share link
├── PWA settings
├── Custom domains
├── Launch page
├── FormLogic Native Runtime
├── Deep links / Android App Links
├── Client app manifest
├── SDK settings
├── QuickJS app logic
├── Application Package export
└── Advanced / Embed
```

## Custom domains panel

Fields:

```txt
Domain
Mode
Status
DNS instructions
Verify button
Open domain button
Remove domain
```

Example UI copy:

```txt
Custom domain
mine.management

Status: Pending verification

Add this DNS record:
TXT _formlogic.mine.management
fl-domain-verification=abc123...

Then point your domain to:
domains.formlogic.com
```

## Launch page panel

Fields:

```txt
Headline
Subheadline
Description
Logo
Hero image
Show Open Web App
Show Install PWA
Show Install Android App
Show Open Native App
Show QR Code
Support email
Privacy URL
Terms URL
Powered by FormLogic
```

## Native runtime panel

Fields:

```txt
Enable FormLogic Native Runtime
Require native runtime for this app
Minimum runtime version
Android package name
Play Store URL
APK URL
Enable Android App Links
Connector capabilities
```

## SDK panel

Fields:

```txt
Enable SDK custom screens
SDK version
Allowed hooks
Allowed components
Preview custom screens
Validate SDK imports
```

## QuickJS logic panel

Fields:

```txt
Enable custom app logic
Logic runtime: QuickJS
Strict permissions
App-level permissions
Scripts by hook
Test run with sample ctx
Permissions preview
Runtime budget
```

## Application Package panel

Fields:

```txt
Export as .formlogic
Include demo data
Include assets
Include SDK screens
Include native config
Include QuickJS logic
Sign package
Publish to marketplace
```

---

# 55. Backend app runtime changes

Keep the existing authenticated runtime boundary.

The current app runtime controller already:

```txt
checks app is published
requires authenticated user
requires active app membership
filters forms by permissions
filters owner-only data
```

Do not expose full app runtime config publicly from a custom domain launch page.

Add only:

```txt
GET /api/public/launch/by-host
GET /.well-known/formlogic-app.json
GET /manifest.json
GET /.well-known/assetlinks.json
```

Full app runtime remains:

```txt
GET /api/app/{slug}
```

with auth/membership.

---

# 56. Frontend runtime changes

Add:

```txt
form-builder/ui/src/client-runtime/
```

Suggested files:

```txt
client-runtime/
├── detectEnvironment.ts
├── clientAppManifest.ts
├── nativeBridge.ts
├── offlineQueue.ts
├── syncEngine.ts
├── logic/
│   ├── quickJsAppLogicHost.ts
│   ├── appLogicTypes.ts
│   ├── appLogicPermissions.ts
│   └── appLogicEffects.ts
├── connectors/
│   ├── connectorTypes.ts
│   ├── vehicleConnector.ts
│   └── nativeConnectorClient.ts
├── screens/
│   ├── LaunchAwareRuntime.tsx
│   ├── NativeRequiredNotice.tsx
│   └── SyncStatusPanel.tsx
└── examples/
    └── minecab.clientManifest.ts
```

Add:

```txt
form-builder/ui/src/sdk/
```

Suggested files:

```txt
sdk/
├── index.ts
├── hooks/
├── components/
├── runtime/
└── types/
```

Add:

```txt
form-builder/ui/src/application-package/
```

Suggested files:

```txt
application-package/
├── packageTypes.ts
├── packageValidator.ts
├── packageImporter.ts
├── packageExporter.ts
└── packageSignature.ts
```

Runtime environment:

```ts
export interface RuntimeEnvironment {
  hostMode: 'platform' | 'custom-domain' | 'native';
  domain?: string;
  nativeAvailable: boolean;
  appSlug: string;
}
```

Detection:

```ts
const env = detectRuntimeEnvironment();

if (env.hostMode === 'custom-domain') {
  // Resolve app by host.
}

if (env.nativeAvailable) {
  // Enable native connector affordances.
}
```

---

# 57. Milestone plan

## Milestone 0 — documentation/specs only

Create:

```txt
docs/NATIVE_RUNTIME_TAURI.md
docs/CUSTOM_APP_PLATFORM.md
# CUSTOM_APP_PLATFORM.md consolidates the custom-app web layer (originally planned as
# separate files): custom domains & launch, client manifest, connectors (incl. the device
# connector), QuickJS app-logic, SDK, application package format, marketplace, MineCab ref.
```

Acceptance:

```txt
No runtime changes required.
No native app required.
Docs describe APIs, security, permissions, data models, SDK, package format, marketplace, rollout.
```

## Milestone 1 — FormLogic SDK foundation

Add:

```txt
useCurrentApp
useCurrentUser
useRole
usePermissions
useForm
useForms
useResponses
useSubmitResponse
useConnector
useOfflineQueue
useToast
useAppNavigation
```

Acceptance:

```txt
SDK wraps existing runtime store/API.
Hooks respect permissions.
Hooks work inside app runtime.
No custom screen generation yet.
```

## Milestone 2 — Application Package spec

Define:

```txt
.formlogic format
manifest.json
forms/screens/reports/roles/quickjs/assets/native config
import/export rules
validation rules
```

Acceptance:

```txt
Docs and type definitions exist.
Existing packs can be conceptually mapped to application packages.
No marketplace publishing yet.
```

## Milestone 3 — QuickJS app logic types/spec

Define:

```txt
hooks
permissions
effect model
ctx shape
result shape
security rules
MineCab examples
```

Acceptance:

```txt
Types compile.
No runtime wiring yet.
No native access yet.
No arbitrary JS bridge.
```

## Milestone 4 — QuickJS browser host

Add:

```txt
ui/src/client-runtime/logic/quickJsAppLogicHost.ts
ui/src/client-runtime/logic/appLogicPermissions.ts
ui/src/client-runtime/logic/appLogicEffects.ts
```

Acceptance:

```txt
Runs script in QuickJS.
No window/document/raw fetch/native bridge exposed.
Accepts JSON ctx only.
Returns JSON result/effects only.
Enforces memory/stack/time budget.
Rejects effects without permissions.
```

## Milestone 5 — integrate `onBeforeSubmit`

Start with one hook:

```txt
onBeforeSubmit
```

Acceptance:

```txt
Form before-submit can run QuickJS.
Script can return reject/message.
Script can return warnings.
Backend still validates authoritatively.
Failures fail safely.
```

## Milestone 6 — MineCab mock connector flow

Add:

```txt
mock vehicle connector abstraction
onScreenEnter request
onConnectorEvent mapping
SDK useConnector("vehicle")
```

Acceptance:

```txt
Pre-start screen receives mock vehicle data.
QuickJS maps vehicle JSON to field values.
SDK screen can display connector status.
User submits pre-start.
Backend stores response.
Dashboard updates.
```

## Milestone 7 — app domains backend

Add:

```txt
app_domains table
AppDomainService
AppDomainController
domain routes
verification flow
```

Acceptance:

```txt
Owner can add domain.
Non-owner cannot add domain.
Duplicate domain rejected.
TXT token generated.
Verify endpoint checks TXT token.
Active domain resolves to one app.
Disabled domain removes public launch.
```

## Milestone 8 — public launch resolver

Add:

```txt
GET /api/public/launch/by-host
```

Acceptance:

```txt
Published active app domain returns launch config.
Draft/unpublished app returns unavailable/404.
Disabled domain returns 404.
Full form schemas are not returned.
Private app data is not leaked.
```

## Milestone 9 — launch page frontend

Add:

```txt
DomainLaunchRouter
AppLaunchPage
domainLaunchApi
```

Acceptance:

```txt
mine.management-style host renders launch page.
Open web app works.
PWA/native buttons render from config.
Works logged out.
Does not load full platform dashboard.
```

## Milestone 10 — Deploy & Share UI

Extend:

```txt
AppDeploySettings
```

Acceptance:

```txt
Add domain from UI.
Show DNS instructions.
Verify domain.
Edit landing config.
Enable/disable native runtime.
Configure connector capabilities.
Configure SDK.
Configure QuickJS logic.
Export .formlogic package.
Copy/open domain.
```

## Milestone 11 — same-origin PWA manifest

Add:

```txt
GET /manifest.json
```

for custom domains.

Acceptance:

```txt
mine.management/manifest.json returns MineCab manifest.
start_url is custom-domain aware.
scope is custom-domain aware.
icons/theme/name use app config.
app remains installable.
```

## Milestone 12 — client app manifest and signing

Add:

```txt
GET /.well-known/formlogic-app.json
GET /api/app/{slug}/client-manifest
manifest signing
```

Acceptance:

```txt
Manifest is versioned.
Manifest is signed.
Native capabilities are included only when enabled.
SDK requirements are included.
Public response does not leak private schemas.
Native runtime can verify signature.
```

## Milestone 13 — FormLogic Native Runtime scaffold

Create:

```txt
form-builder/native-runtime
```

Acceptance:

```txt
Android app builds.
User can enter/paste a domain.
App fetches signed client manifest.
App loads web runtime.
No connectors yet.
```

## Milestone 14 — native bridge MVP

Add Tauri commands:

```rust
runtime_info
connector_list
connector_status
connector_request
sync_enqueue
sync_flush
sync_get_queue
```

Acceptance:

```txt
Bridge only active for approved origins.
Manifest signature checked.
Connector command permission checked.
PWA detects native runtime safely.
Calls fail safely in normal browser.
```

## Milestone 15 — mock/local connectors

Add:

```txt
mock_vehicle
local_http
```

Acceptance:

```txt
MineCab works with mock connector.
MineCab can later switch to local HTTP bridge without app changes.
```

## Milestone 16 — Android App Links

Add:

```txt
/.well-known/assetlinks.json
Android intent filters
open-native route
```

Acceptance:

```txt
Active domain can open FormLogic Native Runtime.
Fallback install page works.
Native runtime receives domain/app context.
Native runtime fetches signed manifest.
```

## Milestone 17 — offline sync

Add:

```txt
IndexedDB queue
native queue
idempotency table
batch sync endpoint
sync status UI
```

Acceptance:

```txt
Offline submissions queue.
Reconnect sync works.
Duplicate retries do not duplicate records.
Failures are visible and retryable.
```

## Milestone 18 — MineCab Application Package

Add:

```txt
MineCab.formlogic
MineCab forms
roles
dashboards
reports
SDK screens
mock connector config
QuickJS scripts
launch config
native config
demo data
```

Acceptance:

```txt
Demo shows:
mine.management
  → launch page
  → open web/native
  → SDK custom screen
  → mock vehicle connector
  → QuickJS prefill
  → pre-start submit
  → FormLogic dashboard
```

## Milestone 19 — Marketplace foundation

Add marketplace support for:

```txt
Application Packages
Connectors
Themes
Widgets
QuickJS libraries
SDK components
```

Acceptance:

```txt
Marketplace metadata format exists.
Install/preview/security review flow exists.
Official packages can be published.
Third-party trust levels are designed.
```

---

# 58. Suggested AI/dev task breakdown

## Task 1 — write docs

```txt
Create:
- docs/NATIVE_RUNTIME_TAURI.md
- docs/CUSTOM_APP_PLATFORM.md  (consolidates custom domains & launch, client manifest,
  connectors incl. device, QuickJS app-logic, SDK, application package format, marketplace, MineCab)

Base the docs on:
- existing app runtime
- existing QuickJS sandbox
- existing PWA support
- existing permission filtering
- proposed custom domain/native runtime plan
- SDK custom screen goals
- application package goals
- marketplace expansion
```

## Task 2 — add FormLogic SDK foundation

```txt
Create SDK hooks and components.
Wrap existing appRuntimeStore/API.
Start with hooks:
- useCurrentApp
- useCurrentUser
- usePermissions
- useForm
- useResponses
- useSubmitResponse
- useConnector
- useOfflineQueue
- useToast
```

## Task 3 — add Application Package spec/types

```txt
Define .formlogic.
Add package manifest type.
Add package validator.
Map current pack format to future app package format.
```

## Task 4 — add QuickJS app logic types

```txt
Add CustomAppLogicBundle.
Add CustomAppLogicScript.
Add hook names.
Add effect types.
Add permission types.
Do not wire runtime yet.
```

## Task 5 — add QuickJS app logic host

```txt
Run app logic scripts inside QuickJS WASM.
Expose JSON ctx only.
Expose effect-builder helpers only.
No window/document/fetch/native access.
Return JSON result/effects.
Enforce budget/memory/stack limits.
```

## Task 6 — integrate onBeforeSubmit

```txt
Before app form submission:
- collect answers
- run matching QuickJS scripts
- handle reject/message/warnings
- continue to backend submission
```

## Task 7 — add mock connector

```txt
Create connector abstraction.
Create mock vehicle connector.
Expose vehicle status test data.
Trigger onConnectorEvent hook.
Expose through SDK useConnector.
```

## Task 8 — add app domain backend

```txt
Create app_domains table.
Create AppDomainService.
Create AppDomainController.
Add admin routes.
Add DNS TXT verification.
```

## Task 9 — add launch resolver

```txt
Add GET /api/public/launch/by-host.
Resolve Host to active app domain.
Return public-safe launch data.
```

## Task 10 — add launch page frontend

```txt
Detect custom host.
Render AppLaunchPage.
Open app / install PWA / install native / open native buttons.
```

## Task 11 — add client app manifest

```txt
Add /.well-known/formlogic-app.json.
Add /api/app/{slug}/client-manifest.
Sign manifest.
Add native capabilities section.
Add SDK section.
Add QuickJS logic section.
```

## Task 12 — scaffold FormLogic Native Runtime

```txt
Create Tauri v2 Android project.
Load app by domain.
Fetch signed manifest.
Open runtime in webview.
```

## Task 13 — native bridge and connector registry

```txt
Add runtime_info.
Add connector_list.
Add connector_status.
Add connector_request.
Gate by signed manifest permissions.
```

## Task 14 — offline sync

```txt
Add queue.
Add idempotency keys.
Add sync batch endpoint.
Add retry/status UI.
```

## Task 15 — MineCab demo

```txt
Create MineCab Application Package.
Add forms/dashboards/reports.
Add SDK screens.
Add mock connector config.
Add QuickJS prefill scripts.
Add launch/native config.
```

## Task 16 — marketplace foundation

```txt
Define marketplace item types.
Support Application Package listing.
Support Connector listing.
Add trust levels.
Add install/preview flow.
```

---

# 59. Security checklist

## Domain security

```txt
Verify domain ownership before activation.
Prevent duplicate domain claims.
Normalize domains.
Reject localhost/private/internal domains.
Reject invalid punycode/IDNA.
Serve HTTPS only.
Handle X-Forwarded-Host only from trusted proxies.
```

## Launch security

```txt
Launch API returns safe public metadata only.
No form schemas unless authenticated and authorized.
No report specs in public launch.
No custom scripts in public launch.
Sanitize landing content.
Avoid arbitrary custom CSS in MVP.
```

## Auth security

```txt
Do not expose broad API keys in browsers.
Prefer same-origin /api proxy for custom domains.
Use short-lived app sessions later.
Keep CSRF protections for cookie writes.
Use rate limits.
```

## Native security

```txt
Native bridge only enabled for approved origins.
Native bridge only enabled for signed manifests.
Connector capabilities are explicit.
User/device approval required for sensitive connectors.
Connector calls are audited.
No arbitrary PWA native access.
```

## SDK security

```txt
SDK hooks must respect current runtime permissions.
SDK must not expose hidden form schemas.
SDK must not bypass server-side auth.
SDK must not expose raw native bridge directly.
SDK custom screens should declare SDK version and required hooks.
```

## QuickJS security

```txt
No window/document/fetch/native bridge in QuickJS.
JSON-only input/output.
Memory/stack/time budgets.
Effect permissions required.
Host re-checks permissions before applying effects.
Backend remains authoritative.
```

## Application Package security

```txt
Validate manifest before import.
Scan package paths for traversal.
Limit asset sizes.
Validate QuickJS scripts.
Validate SDK imports.
Require capability review.
Support package signatures.
Differentiate official/verified/community/private packages.
```

## Marketplace security

```txt
Trust levels are visible.
Native connectors require stricter review.
Packages show permissions before install.
Connector packages show data access and native capabilities.
Signed packages preferred.
Revocation/update path required.
```

## Offline sync security

```txt
Idempotency keys prevent duplicates.
Queue data encrypted where practical.
Attachments respect size/type limits.
Failed sync errors avoid leaking secrets.
Device-bound sessions for native runtime.
```

---

# 60. What to build first

Recommended first build sequence:

```txt
1. FormLogic SDK foundation
2. Application Package spec
3. QuickJS custom app logic docs/types
4. QuickJS onBeforeSubmit hook
5. Mock vehicle connector
6. MineCab SDK screen + QuickJS prefill demo
7. Custom domain launch page
8. Same-origin PWA manifest
9. Client app manifest
10. FormLogic Native Runtime scaffold
11. Native bridge mock connector
12. Offline sync
13. Local HTTP connector
14. Marketplace foundation
15. Real vehicle connector later
```

Why this order?

```txt
SDK makes custom screens easy.
Application Package makes the app portable.
QuickJS logic proves safe customisation.
Mock connector proves business/device mapping.
MineCab demo proves product story.
Custom domains make it feel real.
Native runtime comes after the web/runtime model is clear.
Marketplace comes after packages/connectors exist.
Real hardware comes last.
```

---

# 61. What not to build first

Do not start with:

```txt
real mining hardware
Bluetooth production driver
USB serial production driver
white-label Android packages
iOS runtime
custom website builder
full offline app bundle packaging
connector marketplace production economy
arbitrary PWA native permissions
industrial kiosk runtime
Raspberry Pi runtime
```

Those are valuable later, but they can derail the MVP.

---

# 62. Final recommended MVP demo

The best first demo is:

```txt
MineCab Operator
  ↓
FormLogic Application Package
  ↓
Vehicles, Operators, Shifts, Pre-starts, Faults, Production Readings
  ↓
SDK-powered Cab Home screen
  ↓
Mock vehicle connector
  ↓
QuickJS maps connector data to pre-start fields
  ↓
User submits pre-start
  ↓
FormLogic backend validates/stores
  ↓
Dashboard updates
```

Then add:

```txt
mine.management
  ↓
Launch page
  ↓
Open web app
  ↓
Install PWA
  ↓
Open FormLogic Native Runtime
```

Final demo story:

```txt
A mining business points mine.management at its FormLogic MineCab app.
Operators open/install the app.
If they use FormLogic Native Runtime, the app can read vehicle data.
QuickJS maps that data into the workflow.
SDK screens make the app feel custom-built.
Submissions sync into FormLogic.
Supervisors see reports and dashboards.
The whole thing can be exported/imported as MineCab.formlogic.
```

That is the strongest version of the vision.

---

# 63. Final product positioning

FormLogic should be positioned as:

> **A self-hostable custom business app platform for launching operational apps with forms, workflows, dashboards, reports, custom domains, PWAs, SDK-powered screens, native connectors, offline sync, application packages, marketplace extensions, and sandboxed QuickJS logic.**

Simpler marketing version:

> **Build business apps that run on your domain, install like apps, connect to real-world systems, and store/report everything in FormLogic.**

For the mining example:

> **MineCab runs pre-starts, shift logs, fault reports, and production readings from a custom domain and Android runtime, while FormLogic handles the data, workflow, reporting, automation, and audit trail.**

For the AI angle:

> **Tell AI what business system you need, and FormLogic can generate the forms, workflows, dashboards, screens, QuickJS logic, package, and deployment configuration.**

---

# 64. The larger AI platform vision

This is where the plan becomes much bigger.

FormLogic should eventually let a user say:

```txt
Build me a warehouse management app with stock intake, picking, packing,
barcode scanning, low-stock alerts, supplier purchase orders, dashboards,
offline mobile picking, and a custom warehouse.company.com launch page.
```

Then AI generates:

```txt
Application Package
Forms
Linked records
Roles
Permissions
Dashboards
Reports
SDK custom screens
QuickJS hooks
Connector requirements
Offline config
PWA config
Native runtime config
Domain launch config
Marketplace dependencies
Demo data
Tests
```

That means FormLogic becomes:

```txt
An operating system for AI-generated business applications
```

The stack would be:

```txt
AI prompt
  ↓
Application Package
  ↓
FormLogic Core
  ↓
FormLogic SDK screens
  ↓
QuickJS logic
  ↓
Connectors
  ↓
PWA/native runtime
  ↓
Custom domain
  ↓
Business runs the app
```

That is the long-term strategic prize.

---

# 65. Bottom-line recommendation

This is a strong direction.

The corrected and expanded plan is:

```txt
FormLogic Core remains the source of truth.
FormLogic Launch gives apps real domains and install/open surfaces.
FormLogic Client Runtime runs the PWA.
FormLogic SDK makes custom screens and AI-generated UI easy.
FormLogic Application Packages make apps portable and marketplace-ready.
FormLogic Native Runtime adds device/native powers.
FormLogic Connect abstracts external systems/devices.
FormLogic Marketplace distributes apps, connectors, themes, widgets, libraries, and templates.
FormLogic App Logic uses QuickJS for sandboxed custom behaviour.
```

The biggest architectural rule:

> **QuickJS scripts describe safe effects; trusted hosts apply those effects after permission checks.**

The biggest SDK rule:

> **Custom screens should use FormLogic SDK hooks/components, not raw API/runtime internals.**

The biggest package rule:

> **A full business app should be exportable/importable as a `.formlogic` Application Package.**

The biggest marketplace rule:

> **Apps, connectors, themes, SDK components, QuickJS libraries, and widgets should all become installable building blocks.**

The biggest product rule:

> **Custom domains and native connectors should make FormLogic feel like the business’s actual operational app, not a form builder wearing a hat.**

[1]: https://v2.tauri.app/start/ "https://v2.tauri.app/start/"
[2]: https://v2.tauri.app/develop/ "https://v2.tauri.app/develop/"
[3]: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable "https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable"
[4]: https://developer.android.com/training/app-links "https://developer.android.com/training/app-links"
[5]: https://developer.android.com/training/app-links/verify-android-applinks "https://developer.android.com/training/app-links/verify-android-applinks"
[6]: https://v2.tauri.app/develop/plugins/ "https://v2.tauri.app/develop/plugins/"
