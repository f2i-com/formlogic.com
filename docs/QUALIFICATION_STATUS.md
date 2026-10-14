# Runtime candidate qualification status

## Source-review publication checkpoint: 2026-10-14

The user explicitly requested publication to `main` with `[skip ci]` after being told final tests and packaging are incomplete. The reviewed source now extends through `08a3e71e722162a484bc4843360919b736f3480e`. This is a source-review checkpoint, not release or deployment qualification. See the [current scoped results, retained failures and remaining gates](qualification/2026-10-14-source-review.md). Release gates and security/integrity checks remain unchanged.

## Historical checkpoint retained below

Status recorded **2026-10-13**: FormLogic's full frontend suite and dependency audits passed within the limits below; complete backend and paired-platform gates remain open. The local credentialed fixture **failed during startup before application tests**. These results do not establish release or deployment readiness, and this document does not waive the gates in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Exact source pair

| Repository | Runtime candidate | Base |
| --- | --- | --- |
| FormLogic | `809f80a19eea244ea22e95e5e5bcf93b3387c868` | `548f23ec6f5c41a8fef8e8487511cba4801c6c9f` |
| SoftN | `75d2ab09a23cbeabd38c09d4830c285ab199b4a2` | `cf10cf1facb312eead65d4cde59a20729c0cdc15` |

Documentation-only descendants do not change these product identities. The backend admission descriptor and frontend consumer must ship together; acknowledged guest storage also requires the paired SoftN runtime. Published SoftN v0.0.20 does not contain that repair. See [session isolation and rollback limits](NATIVE_RUNTIME_SESSION_ISOLATION.md) and the paired [SoftN repair notes](https://github.com/f2i-com/softn.com/blob/75d2ab09a23cbeabd38c09d4830c285ab199b4a2/docs/FORMLOGIC_RUNTIME_REPAIR.md).

SoftN's later test-only descendant `2ad998bb309239a3cd5630ce238ca3d50acded69` resolves the `TS2345` mismatch with an explicit `watched<unknown>(pending)` test-helper type argument. SoftN's production runtime bytes and runtime ZIP identity remain bound to `75d2ab09`.

The reviewed candidate artifacts remain identified by SHA-256:

| Artifact | SHA-256 |
| --- | --- |
| FormLogic UI-only ZIP | `2297bdec538108c99bf8bcdf926e583e0140fcad77384b7c73ac9c450af565de` |
| Paired SoftN runtime ZIP | `318302c7db8a8c1d7c37d233c6271a7eb1093b96c1cefdff036dd95a9505673c` |

## Recorded checks

Entries marked fresh ran on unchanged FormLogic product source at `809f80a1`, through its documentation-only descendant. Other entries retain earlier scoped evidence. No tests were rerun for this documentation commit. Overlapping suites and independent repetitions must not be summed as unique coverage.

| Scope | Result and boundary |
| --- | --- |
| Full FormLogic frontend, fresh | **PASS:** 3,471 passed, 227 optional `OAIY_CLI` parity cases skipped, zero failed; 289 test files passed and one skipped. The successful normal-permission run took 83.453 seconds after retained failed sandbox attempts. The skipped optional parity lane remains unqualified. |
| Frontend checks, fresh | Lint, test TypeScript, pack-screen, security, bundle-budget and engine-provenance checks passed. Script-profile tests: ten passed. Engine-sourcing tests: 152 passed, two skipped. |
| Dependency audits, fresh | npm audit: zero advisories across 694 dependencies. Composer audit: zero advisories or abandoned packages across 53 installed packages, all matching lockfile versions. |
| Browser runtime sharing, fresh | All 12 credential-free ZIPP browser-sharing orders/scenarios passed. This exercises runtime sharing and frame behavior; it does not qualify authentication, import/upgrade or restart. |
| Backend unit coverage, fresh | Broad run: 1,073 tests / 6,583 assertions, zero errors, **one failure** requiring the absent legacy ZIPP sandbox launcher; a six-method expression-parity suite was skipped. Separately executed mail-capture and curl-pin cases passed one test / seven assertions and one test / one assertion. Full MySQL integration was **not run** without a safe authorized test database. |
| Earlier backend evidence | Targeted PHPUnit passed 133 tests / 805 assertions. The declared PHPStan gate passed over 206 production files with zero errors. Backend bytes are identical from `311b6a8390b2c0672616d5d69c08e08601d5be6c` through the product candidate, so these remain valid unchanged-source results. |
| Earlier recovery and build evidence | 177 targeted/boundary tests passed, including 18 recovery tests; independent review repeated 177 and passed five additional cases. The frontend build passed, with 976 UI-only archive payloads and 124 paired hosted-runtime entries verified. This is not a full installer or release build. |
| Paired SoftN source/offline checks | Independent host 58, hosted XDB 23, migration/SQL 26, selected runner/deadline seven, copied-source native runtime nine and exact Coffee migration four checks passed. Source-copy checks did not execute the candidate ZIP. |
| SoftN typecheck repair | **PASS:** full typecheck completed in 12.968 seconds on the test-only repair. The affected hosted-storage file passed 23/23 tests in the default configuration and 23/23 in `host-js`. These scoped results resolve the recorded `TS2345` hold without changing production runtime code. |
| Paired SoftN package | Packaging passed; 603 members / 602 manifest digests were verified. Independent checks passed: 40 byte/source, 43 compiled/function and six packaged-helper SQLite checks. |
| Windows fixture containment harness | The no-secret v5 native probe passed single-owner closure, inherited orphan closure and both same-handle reuse rounds, including verified console exits and empty Jobs. This qualifies the harness containment behavior, not the product runtime. |

At the post-fixture checkpoint, integrity checks confirmed both runtime candidate heads and all 47 reviewed changed-file hashes unchanged. The subsequent SoftN test-only correction is identified separately above. This document includes no private fixture material.

The first broad backend unit attempt used an overly long Windows Temp path and reported 55 native errors/failures. An unchanged single-test control and the broad repeat with a short owned Temp path cleared all 55. The remaining launcher failure and parity skip are separate prerequisites; no product code or assertions were changed to obtain the repeated result.

## Failed local fixture

The final attempt verified 4,708 public file copies, generated fixture credentials and started owned MySQL. Startup did not complete. No authentication, browser, import/upgrade or restart application-phase receipts were produced; those phases are **not run / not qualified**, not failed application assertions.

Guarded destruction completed after a recorded credential lifetime of **14.033 seconds**. Subsequent checks found the private fixture absent, no processes referencing its exact private path, no fixture-port listeners and no remaining supervisor, watchdog or cleanup entrypoint. The initial cleanup verified schema/user absence. Restricted grants and logout remain unqualified. The exact first-secret and expiry timestamps were not retained publicly; no replacement lifetime was started.

The surviving process-identity error may have come from cleanup masking the original startup exception. A short-lived process identity race was reproduced in deterministic diagnostics, but the original failing operation and startup cause remain unknown. This evidence establishes neither a product startup defect nor successful live integration.

The separate v7 harness diagnostics correction is complete: sanitized primary startup and cleanup errors now have separate receipts, operation labels and retained-handle exit observations. Inert regressions passed 66 supervisor, 386 identity and 72 lifecycle assertions in their respective scopes. No replacement fixture, credentials or services ran for this correction. It improves future evidence; it does not identify the earlier startup cause or waive strict identity checks.

## Remaining qualification

- Complete backend `composer test` with a reviewed ZIPP sandbox launcher and an authorized disposable MySQL test database. The unchanged-backend PHPStan gate and fresh Composer audit already passed.
- Optional frontend `OAIY_CLI` parity, the two skipped engine-sourcing cases and backend expression parity remain outside the passed coverage.
- Complete exact-pair live authentication, import/upgrade, cross-tab/session transitions and restart qualification with verified cleanup. Use the reviewed v7 diagnostics for any separately authorized fixture attempt.
- Full-store/replay and broader timing races, physical IME, PWA, real SMS/phone ownership, production hosting and all-in-one release packaging remain outside this evidence. Tagged releases still require the complete local-stack Playwright and release gates.

Any source-only publication decision must retain these caveats and the paired compatibility requirements. This record provides no successful live-qualification claim or release/deployment authorization.
