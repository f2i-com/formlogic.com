# Source-review checkpoint, 14 October 2026

**Source is published for review at the user's explicit request; final tests and packaging remain incomplete. This is not a release or deployment qualification.** The user requested `main`, `[skip ci]` commits, and preservation of the incomplete gate state. This deliberate publication exception does not change the normal pre-push requirements in [CONTRIBUTING.md](../../CONTRIBUTING.md), weaken test assertions, waive release gates or authorize deployment. No release, tag, workflow dispatch or live service change accompanies this checkpoint.

## Source and compatibility

The fetched `main` base was `fafd66d49071b1345f4e610a898c8a15b83cbe05`. The six existing commits through final product candidate **`08a3e71e722162a484bc4843360919b736f3480e`** form a direct fast-forward from it; all carry `[skip ci]`:

| Commit | Change |
| --- | --- |
| `8002c4376b57962c368c1d3b0bf6e3a213817074` | Session compatibility and explicit hosted caller/origin handling |
| `aa6b8b08fd4d6c6aac086e64ff35846d4b4f4433` | Aokie end-to-end response typing |
| `cdf3c6c587b0494b517d94403a5c2edfa97d1ab1` | Windows sandbox watchdog lifecycle |
| `166beaa008d61ea4613b30946c605252307705ef` | Installer prerequisites, locked frontend setup and native-app storage packaging |
| `da24ef8a502bc5875b1344db435d6e79920e8465` | Structured unavailable-runtime behavior when PHP `proc_open` is disabled |
| `08a3e71e722162a484bc4843360919b736f3480e` | Python client import/editor preservation, explicit logic inventories and allowlisted public Python package declarations |

The final candidate Git tree is `ac592b0bf65b92b5f179b45d23fc57eb300d8069`. This checkpoint adds qualification documentation only; it does not change that reviewed product code.

SoftN remains unchanged by this self-contained-installation work at `93ecbe75aa16a159c95e205513ca7bf4cba11b8a`; no empty commit was created. The reusable paired runtime archive still records its genuine original SoftN source `75d2ab09a23cbeabd38c09d4830c285ab199b4a2`. Only a qualification document and a test differ through 93ec, so production inputs match. The archive is not a fresh 93ec build. Preserve the paired runtime/session/storage requirements in [NATIVE_RUNTIME_SESSION_ISOLATION.md](../NATIVE_RUNTIME_SESSION_ISOLATION.md); the public SoftN v0.0.20 archive is not a substitute for this repaired candidate.

## Completed scoped checks

These checks were recorded against final candidate 08a or the explicitly identified existing artifacts. Overlapping suites and repetitions must not be summed as unique coverage. Documentation publication did not rerun them.

| Scope | Recorded result and limit |
| --- | --- |
| Full frontend Vitest | **3,576 passed**, zero failures, **227 optional OAIY parity cases skipped**; 295 passing test files and one skipped file. Optional parity remains unqualified. |
| Frontend/static gates | Full ESLint, strict scoped TypeScript, pack-screen and security invariants passed. Standard `npm run build` passed on an unchanged scoped retry after a retained sandbox `EPERM`; 977 output files / 392,576,746 bytes. Runtime inputs were verified and reused, not rebuilt. Bundle budget: 1,118,752 bytes below 1,400 KiB. Script-profile consistency and 10 fixture tests passed. |
| Backend selected regressions | 97 tests / 755 assertions passed; watchdog protocol 95 / 706 passed. These overlap. Full PHPStan on unchanged configuration reported zero errors. An actual PHP process with `proc_open` disabled returned the intended unavailable result. This is not the full backend suite. |
| Installer tests | Initial selected regressions: 4 tests / 56 assertions and 7 CLI/browser contracts passed. Later source-only installer run: **22 tests / 180 assertions** passed, excluding two methods requiring a network attempt or PHP listener. |
| Dependency audits | Exact committed locks validated. Composer: zero advisories and abandoned packages across 53 production/development packages; npm: zero vulnerabilities across 694 dependency entries. Initial network-sandbox failures and unchanged successful retries were retained. No dependency versions were changed. |
| Additional static/contracts | 215 / 215 PHP syntax files passed under PHP 8.4.15. Actual tracked-source engine provenance guard passed. **147 distinct Node contract tests passed, two optional artifact tests skipped**, reconciled across unchanged attempts. Initial engine batch was 123 passed / 8 failed / 2 skipped; exactly those eight environment-blocked tests passed on retry. |
| Existing paired SoftN archive | Final validators accepted all 603 ZIP members and recorded manifest digests; all **592 installed-generation files** matched. Browser/editor/native contracts, exclusions and static handshake/storage protocol checks passed. This is existing-artifact inspection, not live storage or startup qualification. |
| Module closure | Literal relative imports and worker URLs were complete across **236 parsed modules**. Strict universal browser closure remains **not established**: four deferred Studio Node/Tauri imports and 22 computed expressions remain inventoried; the broad diagnostic remains failed. No hosted startup defect was demonstrated. |
| Built-output isolation | Six diagnostic tests reported passes, including four previously skipped cases. Core/web dist trees outside the runtime ZIP lack a contemporaneous complete hash inventory, so these are not reproducible exact-input or final-build qualification. |
| Available package inputs | Six asset checks passed; 2,354 exact source blobs and 977 SPA hashes reverified. Static projection inventories 1,639 files and 294 backend exclusions. Projection is not an assembled distribution. |

Retained unsuccessful attempts include the first broader selected backend run's two missing-installed-inventory failures, later explicitly excluded from its 97-test pass; sandbox restrictions on fixture Git/Bash/bootstrap operations; frontend collection/setup failures; and the first normal SPA build's `EPERM`. They are not silently relabelled as passing runs. Three initial custom archive-scan errors were corrected harness assumptions; the real broad browser-import diagnostic remains open.

The Node contract skips remain the absent exact `v0.0.18-local` archive fixture and absent Linux ELF fixture. Separate v0.0.20 archive verification does not turn the old fixture skip into a pass. The excluded installer methods are `testAFailedDatabaseStepLeavesNoEnvSoTheWizardCanBeRunAgain` and `testTheSelfTestRequestReachesThisServerWithTheHostAsAHeader`; marketplace database provisioning was not run in the source-only follow-up.

## Packaging: blocked, no distributable produced

The unchanged normal unsigned diagnostic packager exited 1 with **`the linux launcher is not recorded`**, before staging, production Composer installation or ZIP creation. A sandbox-denied SPA reuse junction also remains an input-preparation issue for the next attempt; the Linux gate was reached first. The final SPA was checked directly at its sealed path. No guard or pin was changed, no substitute binary was supplied, and no final FormLogic distribution, distributable digest, full manifest or extraction/clean-install result exists.

Required Linux input: `formlogic-runtime-linux-x86_64`, target `x86_64-unknown-linux-musl`, ELF64 little-endian x86-64, static or static-pie with no dynamic interpreter. To pair with the current Windows launcher it must have genuine original provenance binding its real bytes to this guest:

| Input | Identity |
| --- | --- |
| ZIPP | `v0.0.23`, revision `407b81cd6d20776b9c83b6afee692927e9a0f659` |
| Guest SHA-256 | `1173efb897a428e760c3d76a81a8fae76b32aa411621109dfb34d0d4b421abef` |
| Windows launcher SHA-256 | `3dfdc51cb5083ab08eb4fef345c73678e3e0825a9b9648984377f4483ea2ffed` |
| Paired SoftN runtime ZIP SHA-256 | `318302c7db8a8c1d7c37d233c6271a7eb1093b96c1cefdff036dd95a9505673c` |
| Final SPA output-inventory SHA-256 | `ee8e121df449b6a7d13c6f874ac22abe36a15a84e5ae82ef6d20917b2459d0e2` |

The Windows/guest record genuinely names the older local FormLogic build fafd66; relevant runtime/build source is unchanged through 08a, but its provenance is not relabelled. No required Linux digest is known without the genuine binary. Release mode additionally requires the guest and both launchers from one CI run; existing local components cannot satisfy that rule.

Official metadata inspected on October 14 returned nine FormLogic releases and 20 package runs. Latest [v0.1.11](https://github.com/f2i-com/formlogic.com/releases/tag/v0.1.11) and its only retained `sandbox-linux` artifact belong to the October 11 run using ZIPP 0.0.22. This is metadata association, not a downloaded binary comparison. ZIPP 0.0.23's Linux GNU CLI is not the FormLogic musl launcher. A bounded C: search of 34 named paths and 11 ZIPs also found no matching launcher. No binary was downloaded. This is a bounded availability result, not a claim about every private artifact or computer path.

The smallest genuine next step is a Linux-launcher-only build around the preserved guest on an authorized prepared native Linux build host, using the committed host lock, Rust 1.92.0, musl target/compiler and cached dependencies. Do not use `all` to rebuild the guest unnecessarily or create new provenance around an unknown binary. No Linux environment, build, runtime, service or CI run was started here.

## Live and platform gates still open

- **Full backend on 08a has not run.** The closed campaign's 2,628 tests / 20,171 assertions apply to cdf3c6c, not the final candidate. An owned disposable database and exact native/sandbox inputs are required for the unchanged full suite and actual cross-engine parity.
- **Complete default Playwright has not passed.** Each earlier cdf campaign attempt had one API-only pass and 82 browser-launch failures. Their root cause remains unresolved; they are not 82 demonstrated application defects. New final-candidate browser/editor/Python/policy tests and required Coffee/SoftN fixtures remain necessary.
- **CRM qualification is partial.** Installation/authentication, client CRUD, picker and quote checks ran; a mobile-driver navigation omission stopped progress. Invoice/discard, cross-member isolation, reload/relogin and full restart/readback remain incomplete. The corrected 390px route must use the visible Back-to-documents control. Portable PDF bridge/router integration is separate application/host work.
- **Packaged clean install has not run.** First create and verify the genuine final archive, then run `smoke-dist --zip` only with a freshly owned isolated MySQL target, credentials and runtime; it drops/recreates its configured database and fixed smoke principals. Static checks cannot substitute for boot, authentication and durable storage.
- **Production sharing/tooling checks on the final candidate, catalogue provisioning, PHP 8.2, Linux execution and release provenance remain open.** No fixture was restarted by this publication; previous owned fixtures were closed and independently cleaned.
- Broader retained limits include upgrade/recovery races, full-store/replay, physical IME/PWA, subdirectory hosting, real phone/SMS ownership, external providers and universal offline capability. Optional external fonts/npm/model capabilities remain outside ordinary bundled-app checks. No identity assurance, live payments or external integration is newly claimed.

## Evidence integrity

Local review receipts retain commands, source/artifact hashes, successful and unsuccessful attempts, exclusions and cleanup boundaries. The evidence packets remain unchanged; these are local integrity inventories, not signed releases or published artifact attestations:

| Packet | Files | Seal SHA-256 |
| --- | --- | --- |
| `self-contained-readiness` | 187 | `c88152e55708cac8f9eb5d5c2c00f97f6804a19891dabda394091d066055d39e` |
| `final-candidate-checks-20261014` | 144 | `8c417fe47f4504a010ef790c98408b05a374a5a12597a8a0e125ae97c900183c` |
| `linux-launcher-resolution-20261014` | 33 | `390a4b14b8fabfcdb57260b0e1fce485bf7ded053e56a213385c98fcc6ba686a` |

Independent reviews approved the scoped source changes and evidence statements, including the retained limitations. They do not expand the tested scope or establish release readiness. Earlier historical records remain in [QUALIFICATION_STATUS.md](../QUALIFICATION_STATUS.md).
