# Ecosystem release qualification (ECO-03)

**Status:** plan and lane map, 14 September 2026. It names, per lane, what already exists and runs, what the review added, and what is still a gap. A lane marked *gap* has **not** been run; do not cite this document as evidence that it passed.

## Lanes

| Lane | Scenario | Existing coverage (runs today) | Added by the 14 Sept remediation | Gap |
| --- | --- | --- | --- | --- |
| FormLogic backup | active WAL, old reader, concurrent committed writes | — | `SqliteSnapshotTest` (WAL-pinned reader; concurrency boundary; failure cleanup), `AccountBackupTest::testExportCarriesRowsCommittedOnlyToTheWal…` | disk-full / permission-failure simulation under the real zip pipeline (the helper's failure paths are unit-tested) |
| FormLogic full recovery | conventional forms + native app, media, migrations, key-dependent records restored on an empty host | — | `AccountBackupTest::testNativeAppRoundTrip…` (records restored; HMAC verifies with restored keys, fails with reissued keys; both reported), missing-payload and runtime-absent refusals, format-1 compatibility | restore of an **interrupted** upgrade; site-wide restore rehearsal from a scheduled day folder onto a clean VM |
| Softn durable data | bulk replacement, forced IPC/SQL failure, immediate close and reopen | `xdb-tauri.test.ts`, `xdb-import-merge.test.ts` | XDB `bulk_import_commits_every_batch_or_none`, `replace_import_tombstones…`; Softn `import_records` contract, failure reload, `whenIdle`, hydration-failure state | a real Tauri process kill between the durable signal and disk (in-process tests only) |
| Softn upgrade | v1 records, user-approved v2, migration failure | — | `installations.test.ts` (identity policy, ledger, rollback mapping, damaged registry) | end-to-end desktop run: install v1 in the loader, approve v2, restart, verify records; a failing seed migration |
| Hosted editors | save before handshake, disconnect, concurrent writers | FormLogic `saveNativeProject` expectedVersion → 409 | Softn `hostedEditor.test.ts` (disconnected, ack, timeout, teardown); FormLogic `AppEditorDialog.test.tsx` (early save refused, ack after apply, refusal with reason) | two live editors racing against one app version in a browser (the server-side version check exists; the UI race is untested) |
| Aokie packaging | signed/unsigned manual, signed tag, missing-secret tag | `plugin-release` job prerequisites, sign-before-hash, extracted verification | AK-01 signing-state gate; every pwsh step parse-checked | a staging run of `workflow_dispatch` without secrets on GitHub (the logic is fixed; the run itself was not performed here) |
| OAIY release | web, full CLI, desktop, headless and native tests on the same revision | web tests, CLI HTTPS shutdown, staged/extracted headless smoke | reusable `ci.yml` at the exact revision (CLI `npm test` + typecheck, desktop Vitest, `cargo test` headless + gui), `release-evidence-*.json`, revision check before publish | a staging workflow run with a deliberately failing fixture in each lane (acceptance criterion; requires GitHub) |
| Native XDB | local-only default; approved isolated peers; partition and reconnect | `tauri.rs` namespace tests | `network_settings_default_to_local_only…`, `reset_epochs_reject_stale_peers…`, `disconnected_peers_converge…` (database level), wire-compat test; **third pass:** `two_nodes_discover_deliver_partition_and_reconcile_over_loopback` (two real nodes, real sockets, mDNS, partition, restart under a new identity, automatic reconciliation; ignored by default, passes in ~35 s) | a run across two hosts (two network stacks) with the demo — manual per XDB README |
| ZIPP hosting | repeated engines, bounded long-running guest, tenant switches | `worker-deadline.cjs`, `resource-usage.cjs`, Softn worker/sandbox tests | `instance-recycling-soak.cjs` (in the boundary suite); FormLogic UI measured Worker recycling tests | Softn main-thread mode has no wall clock by design (documented; warns) |
| Ecosystem event | synthetic Aokie event → OAIY → FormLogic → Softn record; lost response, crash/retry, restart | FormLogic `AokieCompanionRelayTest`, `DesktopFlowRelayTest`, `AppSubmissionIdempotencyTest`, `AppSyncBatchIdempotencyTest`, `NativeAppServiceTest::testCommittedRecordEventsSurviveDeliveryFailure…`; Aokie outbox/idempotency tests | — | **the six-project harness itself**: one fixture that drives Aokie → OAIY → FormLogic → Softn with the deployed ZIPP runtime, interrupts at each durable boundary and asserts one business effect via idempotency keys. Not built by this remediation. |
| Hardware qualification | real phone/dongle/Windows combinations | Aokie hardware-labelled suites (dev machine) | — | consented-lab protocol and evidence template (privacy-safe) |

## Recheck follow-ups (14 September 2026, second pass)

| Ticket | Repaired | Regression |
| --- | --- | --- |
| R2-SN-01 restore validated before mutation | `planImport` decides everything (envelope, names, writability, rows) before `executeImport`; `restoreAsync` refuses partial restores with zero change and no native batch | `xdb-restore-ordering.test.ts` (browser + native) |
| R2-SN-02 no eager browser clear; replace parity | one atomic key replacement per collection, earlier collections restored on a later failure with the state named in the error; `clearFirst`/`merge:false` mean "exactly the accepted rows" on both backends | same file |
| R2-SN-03 durable upgrade approval and real rollback | upgrade needs a verified backup and a durable staging record or it stops unapplied; the digest is mapped only when the new package starts; a failed start restores the snapshot (or enters an explicit recovery-only state); a damaged registry is quarantined and blocks unknown packages until discarded | `installations.test.ts` |
| R2-FL-01 one managed native snapshot | `NativeAppService::captureForBackup` holds the shared management lock across source, version, database and host-config capture and re-checks the version; installs hold it exclusively | `NativeAppServiceTest::testCaptureForBackupHoldsTheManagementLock…` |
| R2-XD-01 durable pause before replacement | `pending-restore.json` written and gate paused before any byte moves, loaded before any network start, cleared only by `resume_sync` | `pending_restore_survives_restart_and_holds_the_gate_until_resolved` |
| R2-XD-02 monotonic authority over the union | `replace_from_file_authoritative`: epoch = max(live, snapshot)+1 for every collection in either catalog; plan persisted before publication, re-applied idempotently | `authoritative_restore_exceeds_both_live_and_snapshot_epochs…` |
| R2-XD-03 legacy snapshot migrated in staging | `replace_from_file` copies to staging, runs the idempotent schema init, validates, then swaps; source untouched | `restoring_a_legacy_snapshot_keeps_the_epoch_table_usable_without_a_restart` |
| R2-XD-04 create-only fork identities | `<label>-fork-<uuid>` with existence/open checks and retry | `fork_identities_are_distinct_within_one_second…` |

Still open from the recheck: a two-host restart/partition run for R2-XD-01/02 (the single-machine loopback test now covers discovery, partition, restart and reconciliation on real sockets), a real Tauri end-to-end upgrade with a failing migration (registry logic tested; the loader flow is wired but not driven by an automated desktop test), and the ecosystem harness below.

## Third pass (14 September 2026, later the same day)

| Item | Done | Evidence |
| --- | --- | --- |
| ECO-04 OAIY high advisories | `npm audit fix` in ui, cli, desktop; `sharp` ^0.35.4; 0 high in all three lockfiles (moderates listed in `DEPENDENCY_ADVISORIES-2026-09-14.md`) | ui `npm test`, cli build + `npm test` + typecheck + HTTPS shutdown, desktop Vitest + build |
| ECO-04 audit gate | OAIY `ci.yml` runs `npm audit --audit-level=high` per npm lane; unreachable registry = UNKNOWN and fails; `dependencyAudit` in `release-evidence-*.json` | workflow yaml parsed; the GitHub run itself is pending the next push to a tag |
| OAI-01 CLI typecheck | `npm run typecheck` had never passed, so the gate that runs it would have failed on GitHub; generated glue typed, browser-only globals declared for the CLI | passes locally |
| ECO-04 quick-xml exception | closed, not accepted: only dependent was the demo's `wayland-scanner`; bumped, xdb.org `cargo audit` 0 vulnerabilities | `cargo test -p xdb` 39 tests |
| XD-04 batch edit | `Database::update_records` + Tauri `update_records`: 200 → 101 rows, 1.15 s → 34 ms at 10k | `update_records_commits_all_or_nothing_with_one_snapshot_per_collection`; benchmarks.md third pass |
| FormLogic lock handle | the refused (409) paths of native install, restore and request returned without closing the `manage.lock` handle they had opened; closed explicitly like the other lock sites | `NativeAppServiceTest`; full backend suite 1637 tests OK |
| FormLogic test warnings | the remaining "Resource temporarily unavailable" / "Directory not empty" cleanup warnings were traced to Xdebug `develop` mode, which retains every frame's locals at each throw for the life of the process (reproduced with plain objects and with PDO/SQLite3 on PHP 8.0–8.5; absent with `xdebug.mode=off`). Not a code defect; documented in the backend README. The one genuine warning, `mkdir()` on a storage path that is a file (the `storage.writable` preflight scenario), is now refused before mkdir | `php -d xdebug.mode=off vendor/bin/phpunit`: 0 warnings |
| XD-01/02 network run | two real nodes over loopback sockets in one process: discovery, delivery, partition with writes on both sides, restart with a new peer id, automatic two-way reconciliation, live delivery after reconnect | xdb.org `two_nodes_discover_deliver_partition_and_reconcile_over_loopback` (`cargo test -p xdb -- --ignored two_nodes`), 35 s on Windows 11 |
| OAIY moderate advisories | esbuild ^0.28 (cli), vitest ^5 (desktop), dompurify ^3.4.15 via npm `overrides` (ui; monaco 0.56 still pins a vulnerable dompurify and moves its worker entry points) | all three lockfiles audit clean at every severity; cli, ui and desktop suites and builds pass |
| Pins | xdb.org (this pass) → softn.com → formlogic.com; manifest regenerated | `node scripts/ecosystem-manifest.mjs --check` |

## Round 3 (14 September 2026, `F2i-Ecosystem-Round-3-Handoff-2026-09-14`)

The round-3 review confirmed the eight round-2 repairs and named six narrower follow-ups plus one hardening item. All were confirmed against the current source before being changed; the review's six registry probes were promoted into the project suites.

| Ticket | Repaired | Regression |
| --- | --- | --- |
| R3-SN-01 installation-level gating and durable completion/undo | every digest mapped to an installation with a pending upgrade resolves `upgrade-unresolved` (the older package is not run against possibly-changed data; the person restores the snapshot here or finishes by opening the newer file); completion and undo are bound to the operation (digest + backup); an unsaved completion closes the app with the pending record intact; undo reports data-restored and record-saved separately and never claims more | softn.com `test/upgradeFlow.test.ts` (R3-SN-01 block) |
| R3-SN-02 truthful registry state | a failing read is `unavailable` (nothing resolves, saves or opens); invalid identity-critical records are kept as damaged material with their raw value, gate the packages they name, block ordinary saves until an explicit discard, while valid records still load; the opaque-origin fallback is one non-durable session registry on which upgrades are refused | `test/upgradeFlow.test.ts` (R3-SN-02 block), `installations.test.ts` |
| R3-SN-03 browser import preparation failures | every read and preparation precedes the first write; a later-collection read failure changes nothing; crash atomicity across collection writes is documented as not promised | core `xdb-restore-ordering.test.ts` |
| R3-XD-01 restore pause enforced everywhere | one policy `SyncGate::permits(SyncActivity)` for updates, resets, request answers, join/repair/reconnect reconciliation and publishes (only the committed reset plan may leave while paused), re-checked under the database lock; an unreadable pending file (any error but NotFound) holds the gate with a visible reason | xdb.org `network.rs` and `tauri.rs` tests (paused policy, update waiting for the lock, held resets, unreadable pending file) |
| R3-XD-02 recoverable authoritative restore | plan computed without touching the live database; data and reset epochs activated in one backup step from the validated staging copy; journal (`phase`, prior catalog, source, backup, plan) written before any byte moves and advanced under the lock; `resume_sync` refuses unapplied or unreadable records; `recover_restore { rollback | complete | discard }` resolves them | `authoritative_restore_activates_data_and_epochs_together_or_leaves_the_live_database_untouched`, `resume_refuses_a_restore_interrupted_before_it_was_applied` |
| Fork reservation | destination reserved with create-new semantics before the identity is returned; colliding ids and concurrent allocations retry | `fork_allocation_reserves_the_destination_and_retries_a_colliding_id`, `concurrent_fork_allocations_never_share_an_identity` |
| R3-OAI-01 release evidence | build jobs write `unverified` / `pending`; the tag-only release job attests `verified` / `pass` with the exact run only after the gate succeeded and every artifact digest re-checks; Node version from the runtime | oaiy.com `scripts/attest-release-evidence.test.mjs` (12 cases) |

Pins after round 3: xdb.org 84e952e → softn.com db17857 → formlogic.com (this commit); manifest regenerated and checked. The XDB loopback network test could not be rerun on the reviewer's machine today because unrelated desktop applications hold the mDNS port; it fails identically at discovery on the previous commit, so the round-3 change is not the cause. Rerun it (and the two-host check) before the next tag.

Still open after round 3: the two-host LAN run, the automated desktop upgrade end to end (the loader's unresolved-upgrade and stop-on-unfinalised paths are unit-tested, not driven through Tauri), the ecosystem harness below, and the GitHub-side runs of the OAIY attestation and Aokie no-secrets dispatch.

## Round 4 (15 September 2026, `F2i-Ecosystem-Round-4-Handoff-2026-09-15`)

The round-4 review confirmed the seven round-3 repairs and left three tickets. All three were confirmed against the current source; the review's proposed regression file was adopted verbatim into the loader suite. Running the LAN qualification in containers to verify XDB first, as requested, found and fixed a fourth defect the review had not seen.

| Item | Repaired | Regression |
| --- | --- | --- |
| R4-SN-01 registry operations across awaits | no registry snapshot survives an await: every commit re-reads the stored registry, revalidates the operation (record present, no other pending upgrade, digest not mapped elsewhere, pending record still this operation's) and writes only what it owns; a cancellation signal from the loader stops an operation before new side effects and obsolete dialogs are answered with cancel; a restore that already ran is still recorded | softn.com `test/upgrade-overlap.regression.test.ts` (the review's file: suspended upgrade vs unrelated open, competing upgrades, rollback vs unrelated open) and R4 cases in `upgradeFlow.test.ts` |
| R4-SN-02 recovery retry | a successful rollback retry clears the recovery marker together with the pending record; `recoverInstallation` verifies installation and backup identity, restores, then clears both markers in one commit or keeps the block with a precise reason; opening a recovery-only installation offers "restore the backup and retry" with the backup path shown | `upgrade-overlap.regression.test.ts` (recovery), `upgradeFlow.test.ts` (R4-SN-02 block) |
| R4-XD-01 offline authoritative resume | one rule (`NetworkControl::publication_precondition`) for initial import, `resume_sync` and every `recover_restore` step: an applied `replace` restore without a running network node is refused with the fix named, the plan is kept, the pause holds, a restart finds the same plan; `local` restores resume without a node | xdb.org `an_applied_replace_restore_keeps_its_plan_pending_while_networking_is_off` |
| LAN dial defect (found by the container run) | libp2p reuses the listening port as dial source port; two peers discovering each other in the same instant dialed each other at once with mirrored 4-tuples, the kernel merged the dials into one TCP simultaneous open, both Noise handshakes ran as initiator and failed, and nothing retried, so the peers never connected. The node now dials discovered peers from a fresh port, registers explicit GossipSub peers only once connected, retries failed dials with jittered back-off, logs connection failures, and re-queries mDNS every 30 s instead of every 5 min | two `lan-probe` containers on a Docker bridge (`scripts/lan-two-containers.sh`), simultaneous start: converged in both of two runs; in-process loopback in a container: 3 of 3 (previously 1 of 4) |

XDB qualification on this machine: the in-process loopback test cannot run on the Windows host while WSL or Docker Desktop is up (their virtual adapter wins the multicast route, so discovery packets never loop back); it and the two-container run pass in Linux containers, which the XDB README now documents as the supported way to run them on a single machine. A run across two real hosts is still to be recorded.

Pins after round 4: xdb.org e642c31 → softn.com 0cd405d → formlogic.com (this commit); manifest regenerated and checked.

Still open after round 4: the two-host LAN run, the automated desktop upgrade end to end, the ecosystem harness below, and the GitHub-side runs of the OAIY attestation and the Aokie no-secrets dispatch.

## What the ecosystem harness must do when it is built

1. Fixture: one representative Softn app hosted in FormLogic (conventional form + native app), one Aokie synthetic telephony source (no real hardware), OAIY CLI as the flow runner, the pinned ZIPP runtime from the compatibility manifest.
2. Drive one event end to end; record component revisions, artifact digests and a correlation id per run.
3. Interrupt at each durable acknowledgement boundary (Aokie outbox → OAIY; OAIY → FormLogic relay; FormLogic → Softn record), reconnect, replay; assert exactly one business effect through the existing idempotency keys and uniqueness rules.
4. Exercise hosted editor save/publish/upgrade/failed-migration/rollback with two simultaneous editors and a stale version.
5. Restore the account (conventional + native, with key material) into a clean host and re-run the read.
6. Run against the **final archives** named in the compatibility manifest, not a developer tree.

Hardware runs stay separate: consented lab, supported phone/dongle/driver combinations, disconnect/reconnect, competing call events, caller cancellation, SMS acknowledgement; evidence must be privacy-safe (no recordings, no numbers).

## Evidence format

Each lane run records: exact component revisions (from the compatibility manifest), artifact digests, correlation ids, expected durable effects, the interruption point, and the outcome. No workflow is marked complete because an in-memory queue accepted it; only the persisted effect counts.
