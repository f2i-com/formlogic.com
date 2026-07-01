# FormLogic — Launch Checklist

**This is the single source of truth for current open launch work.** `PLAN_1.md` and
`AGENT_NOTES.md` are historical planning notes and contain stale items (rate limiting is
MySQL-backed now, webhooks have a retry worker, etc.) — do not treat their TODOs as open.

Last reconciled against code: 2026-06-30.

---

## P0 — before public launch

- [x] **Hidden-field tamper protection** — client-submitted `hidden` values are stripped on all
  write paths; values come only from default/calc/`onSubmit`. (`sanitizeAnswers` nonInputTypes,
  3 controllers.) Done — verified E2E.
- [x] **Field-aware file uploads** — upload endpoints take `fieldId`; submission re-validates each
  stored file against its field (MIME/size), blocking cross-field reuse. Done — verified E2E.
- [x] **CI hard-fails on high/critical audits** — `composer audit` + `npm audit --audit-level=high`
  are gates; slim 4.15.2, npm highs fixed. Done.
- [x] **Launch E2E suite (Playwright)** — `e2e/launch-golden-paths.spec.ts` (6 tests, green):
  auth login/logout; build→publish→submit-public→view; required validation; hidden-field
  server-authority + calc; field-aware upload rejection; `onSubmit` reject + computed write.
  Self-cleaning, traces/screenshots on failure, documented in `e2e/README.md`. Now wired into CI:
  `.github/workflows/e2e.yml` brings up MySQL + PHP + the built SPA on one origin, seeds a test
  account, and runs the suite nightly + on demand (`workflow_dispatch`), uploading traces on failure.
  Remaining (follow-ups): app-RBAC / export / billing-disabled golden paths.

## P1 — security & data-integrity hardening

- [x] **Webhook SSRF tests** — `WebhookSecurityTest` covers blocked hosts / private IPs / schemes.
  Done.
- [x] **App/RBAC permission-matrix tests** — `AppRbacTest` (owner bypass, view-own vs view-all,
  edit-without-view-all, form-scoped vs app-level, suspended/pending/non-member). Done.
- [x] **Backend field-ID validation** — `FormService::fieldIdError()` rejects unsafe/reserved
  explicit IDs on every save path (matches the frontend); tested. Done.
- [x] **API key + external API tests** — `ApiKeyTest` (scope preservation/enforcement basis,
  invalid/empty scope, unknown/revoked/expired key, cross-user revoke, form-id restriction). Done.
  (Per-route middleware enforcement + batch-limit E2E remain a nice follow-up.)
- [x] **Webhook retry-worker health** — heartbeat in `system_meta` surfaced in `/api/health/deep`
  (`webhook_worker`: last-run age + stale/never-run warning); DEPLOYMENT.md §3 updated. Done.
- [x] **Dual-store (MySQL↔SQLite) reconcile doctor** — `ReconcileService` + `bin/reconcile.php`
  (`--fix` re-syncs counts + drops orphaned links); file-level drift summarized in
  `/api/health/deep` (`dual_store`). Done.
- [x] **Reconcile scripting/network docs** — README no longer says "no network access" (onSubmit
  has SSRF-guarded `ctx.http`). Done.
- [x] **Account export scope** — expanded to include apps (owned + memberships) + API-key metadata
  (no secrets) with explicit included/excluded lists; per-form responses stay per-form (memory-safe).
  Settings copy updated to match. Done.

## P2 — launch polish & UX

- [x] **Public-file visibility copy** — warn (field settings + pre-publish + docs) that files on
  public standalone forms are link-accessible; use app forms for member-only.
- [x] **First-run onboarding** — WelcomeModal routes new users to blank/template/AI (AI auto-opens the
  generator via ?ai=1); skippable; dismissal persisted; stops once they have a form. Done.
  (A deeper step-by-step coach-mark tour through preview→publish→submit remains a nice follow-up.)
- [x] **Demo pack(s)** — satisfied by the existing catalog: 6 installable packs (Finance OS US/AU, OHS/QMS,
  HR People, Events, Customer Service) — several tagged `onboarding`, all with forms+app+RBAC, no AI key
  needed, self-host friendly. A dedicated single "starter" demo + a gallery "featured" flag remain optional.
- [x] **README screenshots** — builder (hero) + public form, app runtime, Doctor, landing in docs/images,
  showcased atop the README. Done. (Animated GIFs still a nice-to-have.)
- [x] **Billing disabled/self-host states** — self-host says "unlimited / not required"; hosted
  enforced explains limits/top-up; PayPal sandbox/live warnings admin-only.
- [x] **AI config states** — clear unavailable/misconfigured/local-model/insecure-transport;
  status in `/api/health/deep`; never expose keys.
- [x] **Doctor UI** — `/doctor` admin page over `/api/health/deep` (pass/warn/fail cards: DB,
  storage, QuickJS, billing, doc converters, webhook worker, dual-store) with remediation hints,
  no secrets. Done.

## Nice-to-have

- [x] **Prelude sync checksum CI** — CI fails if the backend prelude is out of sync after the
  build's prebuild sync (tells the dev to run `npm run sync:prelude`). Done.
- [x] **Shared JSON error helper** — `JsonResponseTrait` (jsonResponse + jsonError {error,message,code?,
  details?}) extracted + adopted by all 15 controllers (removed the copy-pasted private copies, -108
  lines). Error shape was already uniform; now formalized. Done.
- [x] **Lint baseline to zero** — ESLint 47→0 across 27 files (justified inline disables for
  correct-but-flagged patterns + real type/memo fixes; fixed a TDZ crash in PackGalleryPage found en
  route). CI lint step is now a HARD GATE. Done.
