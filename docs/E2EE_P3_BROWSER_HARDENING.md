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
| `script-src` | `'self' 'wasm-unsafe-eval' https://www.paypal.com` | `wasm-unsafe-eval` is REQUIRED by the QuickJS form-logic VM, esbuild-wasm (Studio screen compiler) and libsodium (private-form crypto) — all three instantiate WASM. **No `'unsafe-eval'`**: custom screens run in sandboxed iframes under `SCREEN_CSP` (pinned by `scripts/check-security-invariants.mjs`), and the app shell has no runtime `new Function`/`eval` (guarded by `client-runtime/flows/noEval.test.ts`). PayPal only for the Billing page SDK. |
| `style-src` | `'self' 'unsafe-inline' https://fonts.googleapis.com` | Tailwind inline styles + Google Fonts stylesheet. |
| `font-src` | `'self' data: https://fonts.gstatic.com` | Webfonts. |
| `img-src` | `'self' data: blob:` + PayPal hosts | Signature dataURLs, blob previews, PayPal button assets. |
| `media-src` | `'self' data: blob:` | Form media fields. |
| `connect-src` | `'self' wss: https://www.paypal.com` | API is same-origin; wss for realtime; no third-party telemetry exists to allow. |
| `worker-src` | `'self' blob:` | Module workers: formlogic eval worker + the E2EE crypto worker. |
| `frame-src` | `'self' https://www.paypal.com https://*.paypal.com` | Sandboxed custom-screen iframes are same-origin/srcdoc; PayPal button iframes. |
| `object-src` | `'none'` | No plugins. |
| `base-uri` | `'self'` | Base-tag injection defence. |
| `form-action` | `'self'` | No external form posts. |

Known limitations (documented, accepted for the baseline):

- `frame-ancestors` cannot be expressed in a `<meta>` CSP and must be delivered as a
  server response header (backend follow-up; clickjacking posture unchanged from today).
- `wasm-unsafe-eval` is required — there is no libsodium/QuickJS/esbuild path without
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
