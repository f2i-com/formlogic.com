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
  Self-cleaning, traces/screenshots on failure, documented in `e2e/README.md`. Remaining
  (follow-ups): app-RBAC / export / billing-disabled golden paths, and wiring the PHP/MySQL stack
  into CI (currently a documented local/pre-release command).

## P1 — security & data-integrity hardening

- [x] **Webhook SSRF tests** — `WebhookSecurityTest` covers blocked hosts / private IPs / schemes.
  Done.
- [ ] **App/RBAC permission-matrix tests** — owner/admin/member/view-own/view-all/export/edit/
  delete/suspended/pending/non-member; a VIEW_OWN user can't read another's response; EDIT without
  VIEW_ALL can't edit another's; suspended/pending denied; owner always; non-member 403/404.
- [x] **Backend field-ID validation** — `FormService::fieldIdError()` rejects unsafe/reserved
  explicit IDs on every save path (matches the frontend); tested. Done.
- [ ] **API key + external API tests** — scope enforcement (`forms:read` can't write), revocation,
  batch limits, consistent error shapes.
- [ ] **Webhook retry-worker health** — heartbeat timestamp surfaced in `/api/health/deep` as
  ok/warn/stale; document cron frequency; Doctor shows "retries not running".
- [ ] **Dual-store (MySQL↔SQLite) reconcile doctor** — read-only report (+ optional `--fix`) for
  missing SQLite files, orphaned metadata/uploads/`response_links`, `response_count` drift;
  summarized in `/api/health/deep`.
- [x] **Reconcile scripting/network docs** — README no longer says "no network access" (onSubmit
  has SSRF-guarded `ctx.http`). Done.
- [ ] **Account export scope** — decide GDPR-complete vs lightweight; expand (apps/memberships/
  responses/file manifest/API-key metadata/billing/audit) or rename the "download my data" UI.

## P2 — launch polish & UX

- [ ] **Public-file visibility copy** — warn (field settings + pre-publish + docs) that files on
  public standalone forms are link-accessible; use app forms for member-only.
- [ ] **First-run onboarding** — welcome → blank/template/AI → create → field → preview → publish →
  test submit → view; skippable; state persisted.
- [ ] **One killer demo pack** — client onboarding + file upload + reviewer status + dashboard +
  export; installable from the gallery; no AI/API key needed; self-host friendly.
- [ ] **README/docs screenshots + GIFs** — landing, builder, script editor, public form, response
  dashboard, app runtime, pack gallery, Doctor.
- [ ] **Billing disabled/self-host states** — self-host says "unlimited / not required"; hosted
  enforced explains limits/top-up; PayPal sandbox/live warnings admin-only.
- [ ] **AI config states** — clear unavailable/misconfigured/local-model/insecure-transport;
  status in `/api/health/deep`; never expose keys.
- [ ] **Doctor UI** — admin page over `/api/health/deep` (DB/storage/logs/QuickJS/billing/doc
  converters/webhook worker/installer) with remediation hints, no secrets.

## Nice-to-have

- [ ] **Prelude sync checksum CI** — fail if `ui/src/lib/formlogic/prelude.js` and
  `backend/resources/formlogic-prelude.js` diverge (tell dev to run `npm run sync:prelude`).
- [ ] **Shared JSON error helper** — standardize `{ error, message, code?, details? }` /
  `errors` across controllers; migrate gradually.
- [ ] **Lint baseline to zero** — ~49 ESLint problems; drive down, then make lint a hard CI gate.
