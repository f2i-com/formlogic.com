# Custom App Platform — Operator Smoke Test

An end-to-end checklist proving the custom-app platform on a running install: sample app →
connectors → custom domain → signed manifests → native runtime → offline sync → maintenance.
Run top to bottom; each step lists the command/click and the expected result.

Conventions:

```bash
BASE=https://formlogic.local          # your platform origin
DOMAIN=mine.management                # the test custom domain you'll connect
```

Prerequisites:

- Logged-in owner session in the browser (UI steps) — API steps that need auth reuse that session.
- `APP_ENV != production` for the dev-override domain verify (step 3).
- `ext-sodium` installed so manifests sign with Ed25519 — otherwise `/client-manifest` and
  `/.well-known/formlogic-app.json` return **503** (`signing_unsupported`) unless
  `NATIVE_TRUST_REQUIRES_ED25519=0`.
- For steps 6–8: Rust + a WebView2/WebKit toolchain to run the native runtime
  (`formlogic/native-runtime`).

---

## 1. Install + publish the MineCab sample app

UI: **Apps dashboard → "Try a sample app" → MineCab Operator**.
API equivalent (session cookie required):

```bash
curl -sb "$COOKIES" -X POST "$BASE/api/sample-apps/minecab/install"
```

Expected:

- `201` with `{ success: true, apps: [{ id, name }], forms: [...] }`.
- Sample installs are **auto-published** (ordinary pack imports stay draft) — the app opens
  running immediately at `/app/<slug>`; note the slug from the URL for later steps.

## 2. Connector read — vehicle (MineCab) and device (`/device-check`)

**Vehicle (mock, browser):** open the MineCab app → **Pre-start Inspection** form.

- Fields auto-fill from the mock vehicle connector: `vehicle_id=TRUCK-044`, `fleet_number=F044`,
  `fuel_percent≈57`, `engine_hours≈4137`, plus a toast. (That's `onScreenEnter` →
  `connector.request(vehicle, status.read)` → `onConnectorEvent` → `ui.setValues`.)
- Set fuel below 15 → submit is **blocked**: "Fuel is too low … to start this shift."
  (`onBeforeSubmit`). Restore fuel → submits normally.

**Device (phone abilities, Web APIs):** open `$BASE/device-check`
(append `?flDeviceMock` for deterministic values).

- Status card shows the `device` connector available; the command list is feature-detected
  (`info.read`, `locale.read`, `screen.read`, `network.read`, `battery.read`, `gps.read`,
  `clipboard.write`, `vibrate`, …).
- Run each row → real (or mocked) data returns; no errors. Optional app-shaped version:
  `curl -sb "$COOKIES" -X POST "$BASE/api/sample-apps/device-check/install"`.

## 3. Connect a test custom domain

UI: open the app → **Deploy & share → Custom domains** (`CustomDomainsPanel`) → **Add domain**
→ enter `$DOMAIN`.

- The panel shows the DNS record to add: `TXT _formlogic.$DOMAIN = fl-domain-verification=<token>`.
- Click **Verify** (API: `POST /api/apps/{appId}/domains/{domainId}/verify`).

Verification modes — know which one you're testing:

| Mode | Condition | Behaviour |
|---|---|---|
| **Dev override** | `APP_ENV != production` | Verify succeeds **without a real DNS lookup**; `tls_status='external'` (nothing real to probe). Domain goes `active` immediately. |
| **Flexible** (default prod) | `APP_DOMAIN_REQUIRE_TLS_ACTIVE` unset/0 | Real DNS TXT lookup; ownership alone → `active`. TLS is *measured* separately (`tls_status`), never assumed. |
| **Strict** | `APP_DOMAIN_REQUIRE_TLS_ACTIVE=1` (also `true/yes/on`) | Ownership proven → holds at `status='verified'` until a live HTTPS probe succeeds; only then `active`. Public resolvers require `active`, so the domain stays private until TLS is genuinely up. |

Expected (dev): status becomes **active**; preview the branded launch page without DNS at
`$BASE/?__flhost=$DOMAIN` (logo/name + "Open app" + install CTAs; with
`native_config.requireNativeRuntime` on, **Open in native runtime** becomes the primary CTA).

## 4. Root discovery endpoints

On a real customer domain these are fetched at *its* root; in dev, pass `?host=` to select the
domain while hitting `$BASE`:

```bash
# Signed client manifest (native-runtime discovery) — signed + domain-bound
curl -s "$BASE/.well-known/formlogic-app.json?host=$DOMAIN" | head -c 400
```

Expected: a signed envelope `{ payload, signature, alg: "Ed25519", keyId }`;
`payload.domain == "$DOMAIN"`, `payload.appSlug == <slug>`, links same-origin on `$DOMAIN`.
Without `?host` on the platform host → **404** (no domain→app mapping there).

```bash
# Same-origin PWA manifest for the custom domain
curl -s "$BASE/manifest.json?host=$DOMAIN"
```

Expected: a PWA manifest rooted at `/`. **Dev caveat:** `?host` selects *which app*; the manifest's
`start_url`/`scope`/icon origin follows the **actual request Host** (here `formlogic.local`) — there
is no cross-origin spoofing. The platform's own `/manifest.webmanifest` (VitePWA) is untouched.

```bash
# Dynamic Android App Links statements
curl -s "$BASE/.well-known/assetlinks.json?host=$DOMAIN"
```

Expected: statements for `com.formlogic.runtime` with the hosted runtime's cert fingerprint
(overridable via env `ANDROID_CERT_FINGERPRINT`). If the domain's `app_domains.native_config`
declares its own `packageName` + `sha256CertFingerprints` (a white-label build), **those are served
instead** — set them in the domain's native config and re-curl to confirm.

```bash
# Public verification key (used by the native runtime and third parties)
curl -s "$BASE/api/public/signing-key"      # → { alg: "Ed25519", keyId, publicKey }
```

## 5. Open in the native runtime (`formlogic://` deep link)

```bash
cd formlogic/native-runtime && npm install && npm run tauri dev
```

Open the app via deep link — this is exactly what the launch page's **Open in native runtime**
button fires:

```powershell
# Windows (runtime installed/registered for the scheme)
Start-Process "formlogic://open?url=$([uri]::EscapeDataString("$env:BASE/app/<slug>"))"
```

```bash
# Android emulator
adb shell am start -a android.intent.action.VIEW -d "formlogic://open?url=https%3A%2F%2Fformlogic.local%2Fapp%2F<slug>"
```

Expected:

- Navy FL splash → FL spinner → the app (no white flash, no console UI).
- **Verification:** the runtime fetches the signed manifest (preferring
  `/.well-known/formlogic-app.json`, falling back to `/api/app/{slug}/client-manifest`) +
  `/api/public/signing-key`, verifies the Ed25519 signature, and pins `appSlug` + `domain` to the
  navigated slug/origin. In the app page's DevTools console:
  `await window.FormLogicNative.runtime.ready()` → `{ verified: true }`.
- MineCab's pre-start prefill now comes from the **Rust** mock connector — same telemetry shape.
- **Negative check (display-only):** on an unverified origin (any non-FormLogic page, or a manifest
  whose `domain` doesn't match the serving origin) — `ready()` → `{ verified: false }`,
  `connectors.list()` → `[]`, connector/sync calls → `origin_denied`; a granted origin asking for an
  ungranted command → `capability_denied`. The page still renders (display-only), it just gets no
  native capabilities.
- Headless contract check: `cd formlogic/native-runtime/src-tauri && cargo test`.

## 6. Offline submit — browser

1. In the app runtime (browser), DevTools → Network → **Offline**.
2. Submit a Pre-start Inspection → the UI proceeds (optimistic `queued` response); the item lands in
   IndexedDB `formlogic-offline` → `submissions` with `status: 'pending'` and a fresh
   `idempotencyKey`.
3. Go back **Online** → the `online` listener auto-flushes: each item re-POSTs to the same
   idempotent endpoint `POST /api/app/{slug}/forms/{formId}/responses`.

Expected: the response appears once in the form's Responses; the queue row is removed.
Outcome handling: idempotent replay (same key, same payload) → delivered, **no duplicate**;
`409 { processing: true }` → kept pending (retry later); `409 { conflict: true }` (same key,
*different* payload) → terminal `failed`, surfaced, never retried; other errors retry up to 8
attempts, then terminal.

## 7. Offline submit — native runtime (restart → reconnect → flush)

1. In the native runtime with the app open, cut connectivity (unplug/adapter off), submit a form →
   `sync.enqueueSubmission` persists it to a JSON file in the app data dir (atomic write).
2. **Quit and relaunch the runtime** (still offline) → the queue survives:
   `await window.FormLogicNative.sync.getQueue()` shows the pending item.
3. Restore connectivity → the web layer's `online` listener runs `flushNativeQueue()`:
   - `flush()` returns pending items **grouped by appSlug** and bumps each item's `attempts`
     (nothing is removed at this point — a failed POST can never drop data);
   - the WebView POSTs each group to `POST /api/app/{slug}/sync/batch` (session cookie attached),
     which replays through the idempotency ledger and returns per-item results keyed by
     `idempotencyKey`;
   - successes → `sync.ack(ids)` (rows removed); failures → `sync.fail(ids, error)` (kept
     retryable; after 5 attempts → terminal `status:"failed"`).

Expected: exactly one server response per queued submission; re-flushing changes nothing
(idempotent replay); a same-key-different-payload conflict comes back unsuccessful and the item
fails rather than duplicating. Pending/failed counts are visible via the SDK's
`OfflineQueuePanel` / `useOfflineQueue` (its **Sync now** flushes both browser + native queues).

## 8. Idempotency-ledger cleanup

The `app_submission_idempotency` table grows one row per offline submission key; prune replay
windows that have expired:

```bash
php formlogic/backend/bin/idempotency-cleanup.php --dry-run     # count only, deletes nothing
php formlogic/backend/bin/idempotency-cleanup.php               # delete rows older than 30 days
php formlogic/backend/bin/idempotency-cleanup.php --days=7      # override retention
```

Expected output: `idempotency cleanup: deleted N row(s) older than D day(s) (< <cutoff>)`.
Retention: `--days=N` wins, else env `IDEMPOTENCY_RETENTION_DAYS`, else 30 (clamped ≥ 1).
Safe to re-run (batched deletes + a lock file prevents overlapping cron ticks). Cron example:

```
17 3 * * * php /path/to/formlogic/backend/bin/idempotency-cleanup.php >> /var/log/formlogic-idempotency.log 2>&1
```

---

## Env flags touched by this checklist

| Flag | Effect |
|---|---|
| `APP_ENV` | `!= production` enables the dev-override domain verify (no real DNS) |
| `APP_DOMAIN_REQUIRE_TLS_ACTIVE` | `1/true/yes/on` = strict: domain activates only once HTTPS is live |
| `NATIVE_TRUST_REQUIRES_ED25519` | `0` allows HS256 client manifests (local-only; native runtime won't verify them) |
| `ANDROID_CERT_FINGERPRINT` | overrides the default runtime fingerprint in dynamic assetlinks.json |
| `REQUIRE_VERIFIED_PACKAGES` | `true` = only signed (`official`/`local-only`) application packages import |
| `IDEMPOTENCY_RETENTION_DAYS` | retention window for the cleanup job (default 30) |

Related docs: [[CUSTOM_APP_PLATFORM]] (platform design + signing model),
[[NATIVE_RUNTIME_TAURI]] (runtime build, deep links, verification, sync queue contract).
