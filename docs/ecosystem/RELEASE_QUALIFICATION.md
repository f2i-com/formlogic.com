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
