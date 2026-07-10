# FormLogic — Launch Checklist

**This is the single source of truth for current open launch work.** `PLAN_1.md` and
`AGENT_NOTES.md` are historical planning notes and contain stale items (rate limiting is
MySQL-backed now, webhooks have a retry worker, etc.) — do not treat their TODOs as open.

Last reconciled against code: 2026-07-10.

---

## Release gate (must be green before launch)

The **`E2E (Playwright) — release gate`** workflow (`.github/workflows/e2e.yml`) is the launch gate —
it runs the full-stack golden paths against a real PHP+MySQL+SPA. It runs nightly, on every `v*`
release tag, and on demand. Follow **[docs/RELEASE_RUNBOOK.md](docs/RELEASE_RUNBOOK.md)** for the full
pre-launch sequence.

Fast CI (`ci.yml`, every PR/push) runs: backend PHP unit+DB tests, the full frontend **Vitest**
suite, typecheck+build, bundle budget, pack-screen coverage, the custom-screen CSP no-egress pin
(`check-security-invariants.mjs`), dependency audits, and the **FormLogic Desktop Rust tests on a
Windows runner**. The **`Package` workflow refuses to build/publish a release zip unless its
`verify` job (backend tests + Vitest + invariants) passes on the exact same SHA** — a tag can no
longer publish untested code (audit REL-001/C-09). The Aokie plugin repo (`f2i-com/aokie.com`) has
its own Windows CI running the plugin's full test suite plus the voice-feature check.

**Golden-path coverage:** ✅ = spec exists; ⏳ = tracked follow-up spec.
- ✅ auth login/logout; build→publish→submit-public→view; required validation; hidden-field authority;
  field-aware upload rejection; `onSubmit` reject/computed write (`e2e/launch-golden-paths.spec.ts`).
- ✅ App file RBAC (view-all / view-own-own / view-own-other / non-member / anonymous) — `FileAccessRbacTest`.
- ✅ App RBAC permission matrix — `AppRbacTest`.
- ✅ Custom-screen CSP no-egress: static invariant (`check-security-invariants.mjs`) + a behavioural
  E2E that fires every egress vector (fetch/XHR/beacon/WS, img/css/font/media, iframe/object/worker,
  form, popup, self-nav) at a real server and asserts zero arrival (`e2e/custom-screen-csp.spec.ts`).
- ✅ Member schema/report/dashboard visibility filtering — `AppMemberFilterTest` (pure) +
  `AppVisibilityRouteTest` (real getApp/getForm route boundary).
- ✅ App dashboard renders populated widgets + records grid shows seeded data — `e2e/app-dashboard.spec.ts`.
- ✅ Public live-demo isolation: a demo session's server write is rejected (read-only) — `e2e/demo-isolation.spec.ts`.
- ✅ App export → import round trip; billing-disabled/self-host writes (no 402 with enforcement
  off); app-RBAC deny-by-default → invitation → member access (`e2e/launch-golden-paths-2.spec.ts`,
  audit FL-E2E-001). The e2e suite is now a HARD release requirement (package.yml zip + desktop
  jobs `needs` the reusable e2e workflow on every `v*` tag).
- ⏳ Interactive submit → dashboard/list/report updates (needs a real-account, non-read-only harness).
- ⏳ MCP token create/list/revoke golden path (backend suites cover the flows; e2e spec pending).

## Launch hardening review (2026-07) — actioned

- [x] **P0 custom-screen exfil** — `SCREEN_CSP` hardened to no-egress (img/media `data:/blob:`, font
  `data:`, `connect-src 'none'`); CI invariant guard added. Blocks `new Image().src='https://…'` /
  CSS `url(https://…)` record leaks.
- [x] **P0 app file RBAC** — files require an explicit form permission (owner/VIEW_ALL → any;
  VIEW_OWN → own uploads only), not mere app membership. `FileAccessRbacTest`.
- [x] **P0 release gate** — E2E workflow runs on `v*` tags; runbook + this checklist name it as the gate.
- [x] **P1 form-schema visibility** — `getApp()` only returns schemas of forms the member can use.
- [x] **P1 navigate() allowlist** — sandboxed app screens can only navigate to a safe app-relative set.
- [x] **P1 docs** — nested README aligned (28 apps / 34 demo), HTTPS-first deploy examples, doc split
  (widget vs legacy custom-screen), placeholder demo link removed, Dependabot added.
- [x] **P1 #6 pack trust warning** — import preview flags packs carrying custom CODE screens (vs
  no-code dashboards).
- [x] **P1 #9 email Doctor check** — `/doctor` surfaces the SMTP silent-failure traps (no from-address;
  SMTP set but symfony/mailer missing) with the exact fix.
- [x] **P2 #10 runbook** — `docs/RELEASE_RUNBOOK.md`. **#15 perf/bundle** — CI bundle-budget report +
  `perf-demo-dashboards.mjs`. **#16 device matrix** — `docs/BROWSER_DEVICE_MATRIX.md`. **#17 backup
  copy** — app export card states "structure, not a data backup".
- [ ] **P2 #11 guided coach-mark tour** — deferred follow-up. WelcomeModal first-run exists; a
  multi-step overlay tour (install → dashboard → submit → view → edit widget → invite/export) is a
  larger UX build, intentionally not rushed this pass.
- [ ] **P2 #12 dedicated "starter" pack** — deferred follow-up. The 28-pack catalog covers onboarding
  (several tagged `onboarding`); a bespoke 3–4-form starter + making it *the* featured default is
  net-new content + a marketplace-curation decision (all demo packs are currently `featured=1`).

## Launch hardening review — round 2 (2026-07) — actioned

- [x] **P0 #1 custom-screen self-nav** — CSP adds `navigate-to`/`frame-src`/`object-src`/`worker-src`
  `'none'`; invariant guard requires them. Empirically verified (`e2e/custom-screen-csp.spec.ts`):
  every egress vector — incl. self-navigation — is blocked in Chromium (measured at a real server, not
  via Playwright request events). Code screens remain trusted-content for untested engines (Safari).
- [x] **P0 #2 member visibility** — `getForm()` gated on `memberCanSeeForm`; `getApp()` filters
  `safeApp` (nav, landingPage, report specs + doc blocks, dashboard widgets) for non-owners.
  `AppMemberFilterTest`.
- [x] **P0 #3 runbook overclaim** — runbook now separates automated vs manual-smoke launch paths.
- [x] **P1 #4 VIEW_OWN old file** — `ResponseService::userOwnsFile` unbounded lookup; `FileServeRouteTest`
  covers a file on the oldest of 120+ responses.
- [x] **P1 #5 marketplace install warning** — same code-trust prompt as upload (`lib/packTrust.ts`).
- [x] **P1 #6 route-level file tests** — `FileServeRouteTest` hits `serve()` with real DB/SQLite/files
  (status + cache headers).
- [x] **P1 #7 stale FileController docblock** — updated to the explicit-permission model.
- [x] **P1 #8 email-verification wording** — runbook no longer implies a nonexistent verify step.
- [x] **P1 #9 golden paths** — dashboard-renders-populated + records-grid specs added (priority 1);
  interactive submit→updates tracked above.
- [x] **P2 #12 perf capture** — runbook asks the launcher to paste `perf-demo-dashboards.mjs` output.
- [ ] **P2 #10/#11 onboarding tour + dedicated starter pack** — remain the deferred UX/content items.

## Launch hardening review — round 3 (2026-07) — actioned

- [x] **P0 #1 release-gate wiring** — E2E workflow `E2E_API_URL` fixed (was doubling to `/api/api/...`)
  + a `provision-demo` step so the demo specs run from a clean DB.
- [x] **P0 #2 userOwnsFile exactness** — file ownership requires real file_upload metadata, not a
  substring in arbitrary answers JSON; `FileServeRouteTest` adds the id-in-a-text-answer case.
- [x] **P1 #3 route-level visibility test** — `AppVisibilityRouteTest` (getApp/getForm boundary).
- [x] **P1 #4 official-pack flag** — server-computed `official` (real publisher email), not the
  spoofable display name.
- [x] **P1 #5 code-screen trust copy** — the app-home + form-section studios note that code screens
  are trusted app-wide content; prefer no-code dashboards for per-role hiding.
- [x] **P1 #6 (partial)** — added the demo-isolation golden path (above); interactive submit→updates,
  export/import, and MCP flows remain tracked follow-ups (need a real-account harness).
- [ ] **P2 #7/#8 onboarding tour + starter pack** — still the deferred UX/content items.

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
  Follow-ups CLOSED (audit FL-E2E-001, `e2e/launch-golden-paths-2.spec.ts`): app export→import
  round trip, billing-disabled/self-host write behaviour (no 402 with enforcement off), and
  app-RBAC (non-member deny-by-default → invitation → member runtime access). The e2e suite is
  now a HARD release requirement: package.yml's zip + desktop jobs `needs` the reusable e2e
  workflow on every v* tag (e2e.yml keeps nightly + manual runs).

- [ ] **Desktop/Aokie installer signing (audit PKG-001)** — the pipelines are in place
  (`package.yml` `desktop` job: verify-gated NSIS+MSI via `tauri build`, SHA256SUMS, release
  attach; aokie.com `ci.yml` `plugin-release` job: helper-hash-pinned voice plugin bundle +
  checksums), but artifacts ship **UNSIGNED** until a Windows code-signing certificate exists.
  To close: buy an OV/EV cert, add `WINDOWS_CERT_PFX_B64` + `WINDOWS_CERT_PASSWORD` secrets to
  BOTH repos — the sign steps then activate on the next tag. Note the pinned-helper caveat in the
  aokie job: a signed helper changes bytes, so a signed release must rebuild the plugin with the
  post-sign hash (documented in the workflow; automate when the cert lands). Until signed,
  SmartScreen warns on install — do not ship to external users.

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
