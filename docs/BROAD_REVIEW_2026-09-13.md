# Broader local project review — 13 September 2026

This pass extends the [pack and documentation review](PACK_REVIEW_2026-09-13.md) to backend types, all backend unit tests, app data/permission integration, responsive product screens, editor tooling, shared engine behaviour and release-package checks.

## Fixed

Native app updates previously retained the capability list from the first installation. An owner adding a supported capability such as `time` could get an unsupported-capabilities error even with valid updated source. The installer now updates that list under its existing management lock, preserves the app identity and cryptographic keys, and restores the previous configuration when installation fails. Configuration replacement is atomic so a failed write cannot truncate the existing key file.

A new real-ZIPP/SQLite regression checks adding a capability, invoking it, recovering from broken updated source, removing the capability and continuing normal writes. The hosting guide documents these update/rollback rules.

The browser-test README now reflects paused automatic CI, manual/reusable workflow triggers, fixture-based UI checks and the separate review-account prerequisites.

## Checks completed

| Area | Result |
|---|---|
| PHPStan, configured level 3 | No errors, including after the native update fix |
| Complete backend unit suite before the fix | 546 tests, 3,681 assertions passed |
| Native runtime regression after the fix | 8 tests, 49 assertions passed, including the added update/rollback case |
| Test TypeScript compilation | Passed |
| Admin, App Studio, app/account settings, automations and landing-page browser checks | 27 passed; light/dark and phone/tablet/desktop coverage |
| App exports, sharing, visibility, roles, form attachment, submission idempotency and cross-store rollback | 47 integration tests, 284 assertions passed against a separate disposable MySQL instance |
| Hosted runtime/editor artifact checks | 9 passed |
| Production editor tooling | Editor rendering, TypeScript worker, formatted hover and dialog focus/scroll restoration passed |
| Shared ZIPP runtime | Normal startup orders made one WASM request; retry and stale-host cases behaved as expected |
| Browser/server expression parity | 137 cases agreed |
| FormLogic/Aokie shared contracts | 7 shared files matched; 59 JSON documents parsed |
| Release-package regression checks | 8 passed, including signature compatibility, runtime assets and private storage setup |

The app database account correctly refused creation of another database. Rather than use the review workspace for tests that modify schemas or clear tables, the integration run used a new loopback-only MySQL instance on a separate port. That instance was shut down and its data directory removed afterwards. The existing local app database and user records were not used by those integration tests.

The full frontend unit suite, production build, lint and pack round trips passed in the preceding review. No frontend application code changed in this pass. Native backend changes received their own regression and static-analysis checks.

## Limits

These are local checks, not a claim that the entire product is defect-free. The whole backend integration suite, production restore/load tests, custom-domain/TLS provisioning, native Tauri builds and live Aokie phone/SMS/provider tests were not rerun. The UI design checks use mocked API responses; the 47 data integration checks and native runtime tests exercise actual database operations. Existing large-bundle notices remain a performance follow-up. Nothing was pushed or deployed.
