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
| Native XDB | local-only default; approved isolated peers; partition and reconnect | `tauri.rs` namespace tests | `network_settings_default_to_local_only…`, `reset_epochs_reject_stale_peers…`, `disconnected_peers_converge…` (database level), wire-compat test | a two-process LAN run (discovery, partition, reconnect) with the demo — manual per XDB README |
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

Still open from the recheck: live two-machine restart/partition qualification for R2-XD-01/02 (database-level and control-level tests only), a real Tauri end-to-end upgrade with a failing migration (registry logic tested; the loader flow is wired but not driven by an automated desktop test), and the ecosystem harness below.

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
