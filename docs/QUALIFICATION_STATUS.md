# Runtime candidate qualification status

Status recorded **2026-10-13**: the paired source candidates have passed the scoped checks below. The local credentialed fixture **failed during startup before application tests**. These results do not establish release or deployment readiness, and this document does not waive the gates in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Exact source pair

| Repository | Product candidate | Base |
| --- | --- | --- |
| FormLogic | `809f80a19eea244ea22e95e5e5bcf93b3387c868` | `548f23ec6f5c41a8fef8e8487511cba4801c6c9f` |
| SoftN | `75d2ab09a23cbeabd38c09d4830c285ab199b4a2` | `cf10cf1facb312eead65d4cde59a20729c0cdc15` |

Documentation-only descendants do not change these product identities. The backend admission descriptor and frontend consumer must ship together; acknowledged guest storage also requires the paired SoftN runtime. Published SoftN v0.0.20 does not contain that repair. See [session isolation and rollback limits](NATIVE_RUNTIME_SESSION_ISOLATION.md) and the paired [SoftN repair notes](https://github.com/f2i-com/softn.com/blob/75d2ab09a23cbeabd38c09d4830c285ab199b4a2/docs/FORMLOGIC_RUNTIME_REPAIR.md).

## Recorded successful checks

These are prior execution results, not tests rerun for this documentation commit. Overlapping suites and independent repetitions must not be summed as unique coverage.

| Scope | Result and boundary |
| --- | --- |
| Exact FormLogic recovery candidate | 177 targeted/boundary tests passed, including 18 recovery tests. Independent review repeated 177 and passed five additional recovery cases. Lint, test TypeScript, security and pack-screen checks passed. |
| FormLogic frontend build | Passed; the UI-only archive's 976 payloads and 124 paired hosted-runtime entries were verified. This is not a full installer or release build. |
| Earlier full FormLogic frontend | 3,453 passed, 227 skipped, zero failed on bytes committed as `a53b62f267bd8bd76249b253065a35040da14e46`. The full suite was not rerun at `809f80a1`. |
| Unchanged FormLogic backend | Targeted PHPUnit passed 133 tests / 805 assertions. The declared PHPStan gate passed over 206 production files with zero errors. Backend bytes are identical from `311b6a8390b2c0672616d5d69c08e08601d5be6c` through the product candidate, so these remain valid unchanged-source results. |
| Paired SoftN source/offline checks | Independent host 58, hosted XDB 23, migration/SQL 26, selected runner/deadline seven, copied-source native runtime nine and exact Coffee migration four checks passed. Source-copy checks did not execute the candidate ZIP. |
| Paired SoftN package | Packaging passed; 603 members / 602 manifest digests were verified. Independent checks passed: 40 byte/source, 43 compiled/function and six packaged-helper SQLite checks. |
| Windows fixture containment harness | The no-secret v5 native probe passed single-owner closure, inherited orphan closure and both same-handle reuse rounds, including verified console exits and empty Jobs. This qualifies the harness containment behavior, not the product runtime. |

Post-fixture integrity checks confirmed both product heads and all 47 changed-file hashes unchanged. This document includes no private fixture material.

## Failed local fixture

The final attempt verified 4,708 public file copies, generated fixture credentials and started owned MySQL. Startup did not complete. No authentication, browser, import/upgrade or restart application-phase receipts were produced; those phases are **not run / not qualified**, not failed application assertions.

Guarded destruction completed after a recorded credential lifetime of **14.033 seconds**. Subsequent checks found the private fixture absent, no processes referencing its exact private path, no fixture-port listeners and no remaining supervisor, watchdog or cleanup entrypoint. The initial cleanup verified schema/user absence. Restricted grants and logout remain unqualified. The exact first-secret and expiry timestamps were not retained publicly; no replacement lifetime was started.

The surviving process-identity error may have come from cleanup masking the original startup exception. A short-lived process identity race was reproduced in deterministic diagnostics, but the original failing operation and startup cause remain unknown. This evidence establishes neither a product startup defect nor successful live integration.

## Remaining qualification

- Full backend `composer test` (unit plus DB integration) and `composer audit` remain outstanding. The unchanged-backend PHPStan gate already passed.
- Rerun the complete frontend suite on the final product source; the earlier full-suite pass and exact-candidate targeted tests have different coverage.
- Complete exact-pair live authentication, import/upgrade, cross-tab/session transitions and restart qualification with verified cleanup. Preserve the primary startup error separately from cleanup errors before another authorized fixture attempt.
- Full-store/replay and broader timing races, physical IME, PWA, real SMS/phone ownership, production hosting and all-in-one release packaging remain outside this evidence. Tagged releases still require the complete local-stack Playwright and release gates.

Any source-only publication decision must retain these caveats and the paired compatibility requirements. This record provides no successful live-qualification claim or release/deployment authorization.
