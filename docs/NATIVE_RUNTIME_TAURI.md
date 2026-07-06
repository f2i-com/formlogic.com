# FormLogic Native Runtime (Tauri v2)

Status: **implemented + built** (Windows desktop + Android, with deep-link "open in app"). Spec §38–39, §26. Location: `form-builder/native-runtime/`.

A generic desktop/mobile shell that loads a FormLogic app and exposes a small, approved set of
native capabilities over `window.FormLogicNative` — a connector registry and an offline sync queue.
The web runtime feature-detects the bridge (`detectRuntimeEnvironment()`), so the same app gains
native powers with no code change.

## Build & run

```bash
cd form-builder/native-runtime
npm install
npm run tauri dev      # dev: launches the window against the Vite dev server
npm run tauri build    # release: produces installers under src-tauri/target/release/bundle/
cd src-tauri && cargo test   # headless connector unit tests
```

Requirements: Rust (cargo) + a WebView (WebView2 on Windows 11, WebKitGTK on Linux, WKWebView on
macOS). Verified on Windows 11: MSI + NSIS installers build; the app runs and the bridge round-trips
`connector_request → mock vehicle → telemetry`.

## Android

```bash
# env: ANDROID_HOME, NDK_HOME (e.g. $ANDROID_HOME/ndk/27.x), JAVA_HOME=JDK 17-21 (Android Studio JBR works)
rustup target add aarch64-linux-android x86_64-linux-android armv7-linux-androideabi i686-linux-android
npm run tauri android init
npm run tauri android build --apk --debug -t x86_64   # or aarch64 for devices
```

**Windows gotcha:** `tauri android build` symlinks the compiled `.so` into `gen/android/app/src/main/jniLibs/<abi>/`,
which fails without Developer Mode/admin ("Creation symbolic link is not allowed"). Either enable
Windows Developer Mode, or after the Rust compile finishes, copy the lib and run Gradle directly:

```powershell
copy src-tauri\target\x86_64-linux-android\debug\libnative_runtime_lib.so `
     src-tauri\gen\android\app\src\main\jniLibs\x86_64\
cd src-tauri\gen\android; .\gradlew.bat assembleX86_64Debug   # APK -> app\build\outputs\apk\
adb install -r <apk>; adb shell am start -n com.formlogic.runtime/.MainActivity
```

The frontend is embedded in the `.so` (via `generate_context!`), so the APK is self-contained.
Verified on the `Pixel_9a` (x86_64) emulator (debug **and** signed release): launches, bridge
connects, vehicle telemetry round-trips.

### Release signing

`gen/android/app/build.gradle.kts` loads a `keystore.properties` (at `gen/android/`, gitignored) and
applies it to the `release` build type:

```properties
storeFile=/abs/path/to/formlogic-release.jks
storePassword=…
keyAlias=formlogic
keyPassword=…
```

Generate the keystore once (`keytool -genkeypair -keystore formlogic-release.jks -alias formlogic
-keyalg RSA -keysize 2048 -validity 10000`), then build a **release** `.so` (`tauri android build
-t <abi>`, no `--debug`), strip + place it in `jniLibs/<abi>/`, and
`gradlew assemble<Abi>Release -x rustBuild<Abi>Release --rerun-tasks`. Verify with
`apksigner verify --print-certs <apk>`. Release APKs are ~10–11 MB (optimized `.so` + minified).

> The keystore + `keystore.properties` are secrets — they are gitignored and must never be committed.
> Use a securely-stored keystore (and CI secrets) for production releases.

## Deep links — "open in app" without typing a URL

The runtime registers as a handler for FormLogic app links, so tapping a link (or the launch
page's **Open in native runtime** button) opens the app directly — no URL entry. Two forms, both
resolved by `deep_link_target()` in `lib.rs` and opened by navigating the window:

- **Custom scheme** `formlogic://open?url=<url-encoded app url>` — works with **no** domain
  verification (self-hosted / local / QR codes). This is what the launch-page button fires.
- **https App Links** `https://formlogic.com/open/...` — verified against
  `/.well-known/assetlinks.json` on the host (served from `ui/public/.well-known/assetlinks.json`);
  the OS opens the app straight from a normal web link.

Wiring:
- `tauri-plugin-deep-link` (`.plugin(tauri_plugin_deep_link::init())`) + config in
  `tauri.conf.json > plugins.deep-link` (`mobile: [{scheme:["formlogic"]}, {host, pathPrefix:["/open"]}]`,
  `desktop.schemes:["formlogic"]`). The plugin **generates the Android intent filters** (custom
  scheme + App Links) — don't hand-add them. `deep-link:default` is granted in the capability.
- **Cold start** (app was closed): the launch intent arrives before the shell's `index.html` has
  loaded, so a direct navigate is lost. `lib.rs` stashes the target and opens it from the window's
  `on_page_load` (first `Finished`) hook. **Warm start** (already running, Android `onNewIntent` via
  `launchMode=singleTask`): `on_open_url` navigates immediately.
- **Web fallback:** the SPA route `/open/app/:slug` (`pages/OpenInApp.tsx`) redirects to `/app/:slug`
  so a shared App Link degrades to the web app when the runtime isn't installed.

Test on the emulator: `adb shell am start -a android.intent.action.VIEW -d "formlogic://open?url=http%3A%2F%2Flocalhost%3A8090%2Fapp%2F<slug>"`
opens the runtime straight into that app (verified cold **and** warm on the x86_64 emulator).

### App-Links hosts are compile-time (per-tenant / custom-domain limit)

Tauri v2's deep-link plugin bakes the verified **https App-Links hosts into the binary at build
time** (`tauri.conf.json > plugins.deep-link.mobile[].host` → the generated Android intent filters +
`assetStatements`). The generic FormLogic Native Runtime therefore App-Link-verifies **only** the
hosts compiled into it (`formlogic.com` and whatever else is listed there) — it **cannot** verify an
arbitrary customer domain at runtime. So a **verified** per-tenant Android App Link (a normal
`https://mine.management/…` link the OS opens straight into the app) requires a **per-white-label
build** of the runtime with that host baked into `tauri.conf.json`. Custom domains that aren't
compiled in still open the app via the **`formlogic://open?url=…` custom scheme** — no host
verification needed. That's what the launch page's *Open in native runtime* button fires, and it's
the guaranteed fallback (if nothing claims the scheme the page shows a "Get the app" prompt rather
than silently staying on web). The **dynamic** `/.well-known/assetlinks.json` (served by the backend
at the domain root; see [[CUSTOM_APP_PLATFORM#custom-domains--app-launch]]) can advertise a
white-label build's `packageName` + fingerprints per custom domain via `app_domains.native_config`,
which is what supports those per-tenant builds when they exist — it does **not** make the generic
runtime verify uncompiled hosts. Runtime-configurable App-Links host verification is not something
Tauri v2 exposes; we deliberately do not attempt it.

## Loading experience (no white flash, no console flash)

Opening an app shows a branded FL spinner and nothing else — never the console UI, never a
white gap. The pieces:

- **Empty shell** (`src/index.html`, `styles.css`, `main.ts`): the runtime holds NO app of its
  own — the empty state is a minimal placeholder ("No app loaded" + guidance to open via a link).
  There is intentionally **no URL entry** and no connector/sync demos; apps arrive only via links.
- **Loader-first boot:** the shell boots into a full-screen loader (`#loading`). On start it asks
  Rust `pending_deep_link` (via the bridge) — if a deep link launched the runtime it opens that app
  (never flashing the placeholder). Otherwise it **reopens the last app** (`localStorage['fl.lastApp']`,
  shown as "Reopening app…"), or shows the placeholder if none. A `formlogic://home` deep link (or
  a rapid double-launch) escapes a remembered app that won't load.
- **Destination overlay:** the bridge init-script injects a matching FL spinner into the *app* page
  and keeps it up until the app renders real UI (`#root` has >16 elements — so it also covers the
  hosted app's *own* light loading spinner), then fades out.
- **No white on cold start:** the Android theme (`res/values*/themes.xml`) sets `windowBackground`,
  `windowSplashScreenBackground`, and status/nav bars to the runtime navy (`@color/fl_navy`), and the
  window is built with a matching `background_color(Color(8,11,22,255))`. The system splash shows the
  amber FL mark on navy.

Verified sequence (cold deep link): navy FL splash → FL spinner "Loading app…" → app — all dark.

## Android build (Windows symlink workaround, verified)

`tauri android build` fails placing the `.so` in `jniLibs/<abi>/` without Developer Mode. Working
recipe (see `scripts` history): let the tauri build cross-compile the Rust (it fails at the symlink),
then `llvm-strip -o gen/android/app/src/main/jniLibs/<abi>/libnative_runtime_lib.so
target/<abi>-linux-android/<profile>/libnative_runtime_lib.so`, then
`gradlew assemble<Abi>Debug -x rustBuild<Abi>Debug --rerun-tasks`. Stripping takes the debug `.so`
from ~120 MB → ~19 MB so it fits the emulator.

## Structure

- `src/` — the runtime shell frontend (`main.ts`, `index.html`, `styles.css`): a branded loader +
  an empty "No app loaded" placeholder. It opens/reopens a hosted app into this window (via deep
  link or the remembered `fl.lastApp`), which then inherits the bridge.
- `src-tauri/src/lib.rs` — Rust commands (`runtime_info`, `connector_list/status/request`,
  `sync_enqueue/get_queue/flush`), the **mock vehicle connector**, and the **bridge init-script**
  injected into every page so `window.FormLogicNative` is present on the shell *and* any FormLogic
  app the window navigates to.
- `src-tauri/tauri.conf.json` — `withGlobalTauri: true`; the window is built in `setup()` so it can
  carry the init script.
- `src-tauri/capabilities/default.json` — grants the main window IPC + `remote.urls` for
  `formlogic.local` / `formlogic.com` so the bridge's `invoke` works after navigating to a hosted app.

## Bridge contract

`window.FormLogicNative` = `{ available, runtime.{getInfo,openExternal,ready?}, connectors.{list,status,request,subscribe}, sync.{enqueueSubmission,getQueue,flush,ack?,fail?} }`.
Matches the TS `FormLogicNativeBridge` type in `connectors/connectorTypes.ts`, consumed by
`nativeConnectorClient.ts` (connectors) and `nativeOfflineQueue.ts` (sync). `ack`/`fail` are optional
so a web caller feature-detects them (older runtimes predate them).

## Offline sync queue — flush / ack / fail contract

The native side **persists** queued submissions (JSON file in the app data dir, atomic temp-file +
rename write, so they survive a process restart) but **never POSTs to the server itself** — the
WebView holds the session cookie, so the web layer does the HTTP and the Rust side is a durable store.
The loop (`nativeOfflineQueue.ts` `flushNativeQueue()` drives it; `lib.rs` `PersistentSyncQueue`
implements it):

1. **`enqueueSubmission(item)`** — the runtime store appends `{ appSlug, formId, idempotencyKey,
   answers }` (an id / `createdAt` / `status:"pending"` are filled in if absent) and persists. Returns
   `{ id }`.
2. **`flush()`** — returns pending items **grouped by appSlug**: `{ pending: [{ appSlug, items[] }] }`.
   It **increments each returned item's `attempts`** (this counts as a delivery attempt) but **removes
   nothing** — so a failed POST can never silently drop data.
3. The web layer POSTs each group to **`/api/app/{slug}/sync/batch`** (session cookie attached),
   which replays through the idempotency ledger and returns **per-item results keyed by
   `idempotencyKey`** (`{ results: [{ idempotencyKey, success, error }] }`).
4. **`ack(ids)`** — the web layer maps the *successful* results back to queue-item ids and acks them;
   the runtime **removes** those rows and returns `{ acked, remaining }`.
5. **`fail(ids, error)`** — the *unsuccessful* ids are failed; the runtime **keeps** them (retryable),
   records `lastError`, and promotes an item to terminal **`status:"failed"`** once `attempts` exceeds
   `MAX_SYNC_ATTEMPTS` (5) so a poison item stops being retried forever. Returns `{ failed }`.

Notes:
- An item whose `answers` can't be resolved at flush time is **not** delivered as an empty submission
  (that would ack it and bind its idempotency key to an empty response); the web layer `fail()`s it
  and leaves it queued for a later flush that carries the answers.
- A whole-batch transport error `fail()`s every delivered item (still retryable) — nothing is acked.
- `getQueue()` returns the full queue (including terminal `failed` items) so the UI can show
  pending vs failed counts (`OfflineQueuePanel` / `nativeQueueCounts()`).
- Reconnect auto-flushes: the web layer registers an `online` listener that calls `flushNativeQueue()`.
- Every `sync_*` command is gated by `require_verified_origin` — the queue is inaccessible from an
  unverified page.

## Manifest routes: slug endpoint vs. custom-domain `/.well-known/formlogic-app.json`

The **signed client manifest** is served at two routes. Both are signed by the same server key, but
they are **not byte-identical**: each route binds the payload's top-level **`domain`** field to the
origin it serves (see [[CUSTOM_APP_PLATFORM#domain-binding-signed-manifest--serving-origin]]), and the
custom-domain manifest additionally emits **same-origin links** (source/install URLs on the custom
domain):

- **Custom-domain root** `GET /.well-known/formlogic-app.json` — served at the *domain root*: the
  backend resolves the request **Host** to its connected + active domain of a *published* app
  (`AppDomainService::resolveAppSlugByHost`, the same gate as `resolveLaunchConfig`) and returns the
  signed manifest with `domain` = that custom domain. It **404s on a platform host** (there's no
  domain→app mapping there). See [[CUSTOM_APP_PLATFORM#custom-domain-root-endpoints]].
- **Slug endpoint** `GET /api/app/{slug}/client-manifest` — the platform route; `domain` is bound to
  the **platform host** (from the server-trusted frontend base, never the request Host).

The runtime (`fetch_and_verify()` → `choose_manifest_envelope()` in `lib.rs`) **prefers the
same-origin `/.well-known/formlogic-app.json`** manifest and **falls back** to
`{origin}/api/app/{slug}/client-manifest` when the well-known probe 404s / doesn't parse as a signed
envelope (e.g. on the platform host). Either way the envelope is verified identically against
`{origin}/api/public/signing-key`, and the payload's `appSlug` + `domain` must match the navigated
slug + the current origin host — a **missing or mismatched `domain` is a hard failure** (a
validly-signed manifest replayed from another origin is refused).

## Security
Only signed FormLogic apps on approved origins get bridge access: a remote-IPC origin allowlist PLUS
per-app **signed client-manifest verification**. On each page load of a hosted app (`/app/<slug>`) the
runtime fetches the signed client manifest (preferring `/.well-known/formlogic-app.json`, falling back
to `/api/app/{slug}/client-manifest`) + `/api/public/signing-key`, verifies the detached Ed25519
signature over the PHP-canonical payload, and **pins identity**: `payload.appSlug` must match the
navigated slug and `payload.domain` must match the serving origin host (missing/mismatched → hard
failure). Only then does it expose `connectors`/`sync` for the connector commands the manifest grants —
unverified origin → `origin_denied`, ungranted command → `capability_denied`, and the webview otherwise
stays display-only. Arbitrary PWAs can render but not touch connectors. Connector errors are typed
(`{code,message}`) so the web client never masks a capability denial with mock data.

`runtime.ready()` (bridge → the `runtime_ready` command) lets the web layer **await the current
origin's verification outcome** before its first native connector request (so an early
`onScreenEnter` read can't race the async verifier into `origin_denied`): it resolves
`{ verified: true }` once the manifest verified, `{ verified: false }` on definitive failure or for
any page that isn't a hosted app (a 10s hard backstop in the Rust command bounds the wait; the web
caller applies its own ~3s timeout and proceeds best-effort).

## Deferred
Real device connectors (beyond the mock vehicle); iOS build + Universal Links (the assetlinks/App-Links
pattern ports directly); and — per §25 — verified per-tenant Android App Links (Tauri bakes deep-link
hosts at compile time, so custom domains fall back to the `formlogic://` scheme). The offline sync queue
is now **persistent** (survives restart) and flushes via the WebView (design (a), so the queued POST
carries the session cookie); native attachment upload inside a batch is still deferred.
