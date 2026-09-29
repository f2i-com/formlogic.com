# E2EE P3 — Browser hardening review notes (plan §14, v3 baseline)

Scope: the P3 gate items — baseline CSP, telemetry/log exclusions for private-form
surfaces, and the decrypted-renderer review. This is the **v3 baseline**, not the
"post-beta" tier (Trusted Types, lockfile audit in CI, independent XSS review) —
those remain P8 gates per plan §14.

## Baseline CSP (app shell)

Delivered as a `<meta http-equiv="Content-Security-Policy">` injected into
`index.html` at **build time only** by the `inject-app-shell-csp` plugin in
`formlogic/ui/vite.config.ts`. Build-time injection is deliberate: dev mode needs
Vite's inline React-refresh preamble, which a meta CSP would break, and the
dev origin (`http://formlogic.local`) is not a delivery target anyway.

Policy and what each allowance is for:

| Directive | Value | Why |
|---|---|---|
| `default-src` | `'self'` | Baseline deny. |
| `script-src` | `'self' 'wasm-unsafe-eval' https://www.paypal.com` | `wasm-unsafe-eval` is REQUIRED by the ZIPP form-logic VM (`ui/vendor/zipp-wasm`), esbuild-wasm (Studio screen compiler) and libsodium (private-form crypto) — all three instantiate WASM. **No `'unsafe-eval'`**: custom screens run in sandboxed iframes under `SCREEN_CSP` (pinned by `scripts/check-security-invariants.mjs`), and the app shell has no runtime `new Function`/`eval` (guarded by `client-runtime/flows/noEval.test.ts`). PayPal only for the Billing page SDK. |
| `style-src` | `'self' 'unsafe-inline' https://fonts.googleapis.com` | Tailwind inline styles + Google Fonts stylesheet. |
| `font-src` | `'self' data: https://fonts.gstatic.com` | Webfonts. |
| `img-src` | `'self' data: blob:` + PayPal hosts | Signature dataURLs, blob previews, PayPal button assets. |
| `media-src` | `'self' data: blob:` | Form media fields. |
| `connect-src` | `'self' wss: https://www.paypal.com` | API is same-origin; wss for realtime; no third-party telemetry exists to allow. |
| `worker-src` | `'self' blob:` | Module workers: formlogic eval worker + the E2EE crypto worker. |
| `frame-src` | `'self' https://www.paypal.com https://*.paypal.com` | Sandboxed custom-screen iframes load the same-origin `/screen-host.html` — deliberately not `srcdoc`, because a `srcdoc` document inherits this shell policy and its `script-src` blocks the screen's inline bootstrap; the recovery kit's temporary print frame (see below); PayPal button iframes. |
| `object-src` | `'none'` | No plugins. |
| `base-uri` | `'self'` | Base-tag injection defence. |
| `form-action` | `'self'` | No external form posts. |

Known limitations (documented, accepted for the baseline):

- `frame-ancestors` cannot be expressed in a `<meta>` CSP and must be delivered as a
  server response header (backend follow-up; clickjacking posture unchanged from today).
- `wasm-unsafe-eval` is required — there is no libsodium/ZIPP/esbuild path without
  it on this stack. Browsers too old to know the keyword (pre-2023) are outside the
  supported matrix.
- Dev mode runs without the CSP (see above); the production build is the enforced surface.

## Telemetry / log exclusion of decrypted values

- The app ships **no remote telemetry** — `src/lib/logger.ts` writes to the console
  only (`log`/`warn` are dev-only; `error` always logs to the local console). There
  is nothing to exclude server-side; the exclusion rule is "never log decrypted
  content anywhere".
- Crypto modules (`src/lib/crypto/**`) log/throw **status codes + suite ids only**:
  `CryptoClientError`/`WorkerError`/`EnvelopeError`/`ManifestError` carry a typed
  `code` and a static message — never answer values, key material, or ciphertext
  beyond structural facts. The owner decrypt pipeline
  (`useDecryptedResponses.ts`) logs only the typed error on batch failure.
- The storage-inspection test (`src/lib/crypto/storageInspection.test.ts`) sweeps
  localStorage/sessionStorage, the persisted response store, and the exact POST body
  the Workbox background-sync queue captures, after a submit + view + lock cycle:
  no plaintext canary survives anywhere. The service worker does not cache
  authenticated GETs and the offline POST queues carry sealed envelopes only
  (see the Workbox config comment in `vite.config.ts`).
- URLs/DOM attributes: decrypted answers render only inside the responses/record
  surfaces; record URLs carry `recordId` (already visible to the server as the row
  id) — no answer content in query strings, hashes, or `data-*` attributes.

## Recovery kit handling (vault setup wizard)

The recovery kit is key material the user has to be able to keep, so its handling is part
of the baseline (plan D5, §10 "Vault setup order"):

- **Ordering.** The vault is prepared in the browser and the kit shown and typed back
  *before* `PUT /api/vault` is sent (`vaultStore.prepareSetup` / `commitSetup`). Closing the
  tab, cancelling, a lock or a sign-out before that persists nothing. The prepared wrappers
  and the kit live in module memory only — outside the Zustand state, so they are never
  broadcast to subscribers — and are dropped on every exit.
- **Not persisted, not sent.** The app writes the kit to no storage (local/session storage,
  IndexedDB, caches) and to no request. It leaves the page only by the user's own explicit
  saves through the browser:
  - *Download* — a `text/plain` Blob URL on a temporary link, revoked shortly after the click
    (also when the click fails); the file holds the FLRK1 kit exactly as displayed, its date
    and a plain warning.
  - *Print* — a minimal one-page view in a temporary same-origin iframe: a static shell whose
    content is added with `textContent` (no markup is built from the kit or any other
    string), removed when `afterprint` fires or after a five-minute cap. It is an `about:srcdoc`
    document, so it inherits the shell policy above (which is why custom screens do *not* use
    `srcdoc`); it needs no CSP change because it contains no script, loads nothing and sets its
    styles through the CSSOM, leaving the inherited policy nothing to block. Checked by a reviewer
    on 2026-09-29 in headless Chromium, Firefox and WebKit (Playwright) against a replica of the
    production meta policy and the SPA's Apache headers: the frame loaded, was filled, reached
    `print()` with no CSP violation and was removed on `afterprint` (Chromium and Firefox;
    headless WebKit never fires `afterprint`, so only the five-minute cap applies there). Not yet
    checked: Android Chrome, and a real production build.
  - *Copy* — the existing clipboard copy.
- **No accidental loss.** While the kit is on screen the dialog ignores its close button,
  click-outside and Escape; the only way out is an explicit "Cancel and start over" that
  discards the kit and creates no vault. This holds when the wizard is opened from another
  dialog too (Form settings is the usual place): a dialog underneath — the shared `Modal` and
  every overlay using `useFocusTrap` — acts on Escape and Tab only while it is the one on top
  (`src/lib/dialogStack.ts`); before that, Escape closed Form settings, which unmounted the
  wizard and dropped the kit, and Tab was pulled onto Form settings' own close button behind it.
  While the vault is only being *prepared* no kit exists yet, so the passphrase step can still be
  left; a prepare that finishes afterwards is dropped.
- **A create request that gets no answer.** Once `PUT /api/vault` has been sent and nothing came
  back, the vault may exist and the saved kit may be the only way into it, so nothing calls the
  kit void, says nothing was saved or tells the user to throw it away until the server has said
  there is no vault: retries re-send the same vault (a `409` for it is adopted), "Cancel and
  start over" asks the server first, and a lock or sign-out in that window says the vault may
  exist. See the plan's §10 "Vault setup order".
- **Idle lock.** A vault that is only *prepared* (kit on screen, not yet created) has no idle
  timer: it is not on the server yet, its worker holds only its own new secrets and there is
  nothing to decrypt, and an auto-lock would void a kit the user may be writing down. Any lock,
  sign-out or closed tab still drops it, and the 30-minute idle lock starts when the vault is
  created.
- **What it does not change.** Like the passphrase, the kit is visible to whatever script runs
  in the page while it is displayed: a server that serves hostile JavaScript defeats it (see
  *Threat model honesty*). A downloaded or printed kit is as safe as the place the user keeps
  it; the file says so in plain words.

## Decrypted-renderer review

Every renderer that can touch decrypted answers was reviewed (P3 standalone
surfaces: `FormResponses.tsx`, `FormResponseView.tsx`,
`components/responses/recordDisplay.tsx`, `components/responses/renderEditField.tsx`,
`recordFormat.ts`, `FileAnswerValue.tsx`, `SignatureValue.tsx`):

- **No `dangerouslySetInnerHTML`** exists on any of these surfaces (grep-verified
  2026-07-22). Answer values render as React text children only (auto-escaped).
- Signatures render as `<img src={dataURL}>` — a passive raster surface; the src is
  answer content but cannot execute.
- File answers (P4-only on private forms — blocked by the §9.1 preflight) download
  via object URL with `application/octet-stream`; no inline preview of active types.
- CSV export escapes formula-injection leading characters (`= + - @` incl. leading
  whitespace/tab/CR) — the same rule as the hardened backend export.
- The decrypted LRU (`privateDataStore`) is generation-scoped: on lock the vault
  generation bumps, the LRU is dropped, and private-data surfaces re-render from
  the locked state (React state rebuilt empty on the next mount; the hook also
  refuses to publish results computed under a superseded generation).

## Threat model honesty (external review, 2026-07-22)

State this plainly in docs/UI — never oversell:

- **What browser E2EE protects against:** theft of the database, stolen backups,
  and passive server access (a curious or compelled operator reading stored rows).
  Responses are sealed in the submitter's browser; the server stores only
  ciphertext envelopes and cannot read the answers.
- **What it does NOT protect against:** an **actively compromised server** that
  serves modified JavaScript to a future session. Browser E2EE cannot defend
  against hostile code delivery — the submitted code is the trust root each
  session (the §8 signed manifest + TOFU signer pinning constrain *key*
  substitution, not code substitution). Do not claim otherwise.
- **Metadata is not encrypted.** The per-form SQLite stores envelopes, but record
  ids, timestamps, row status, form structure, and submission metadata remain
  plaintext, and submitter IPs are retained briefly (the §12 sweep). E2EE covers
  answer content, not traffic analysis.
- **SQLCipher would add at-rest encryption of the database file, but it would not
  be E2EE** while the server holds its key — the operator could still read every
  row. It is a complementary hardening option, not a substitute for end-to-end
  encryption, and it must never be marketed as E2EE.
