# Softn integration verification — 13 September 2026

## Local checkpoints

All pre-existing changes were committed locally in FormLogic (306d3d80) and Softn
(bf184ce). The integration review added further local commits. Nothing was pushed.
Private runtime databases and generated build assets remain outside Git.

## Improvements

- Prevent returning Studio drafts while AI is generating; cancellation releases the
  parent bridge immediately so the user can retry. The editor independently guards export.
- Confirm before discarding unpublished hosted-app edits.
- Keep the backend file selection valid after editor changes rename/remove a source file.
- Clarify that Builder's standalone XDB designer is different from hosted SQLite;
  embedded database editing directs users to FormLogic records and migrations.
- Build both embedded editors and the native backend runtime from the shared pinned
  Softn source checkout in manual workflows. Include license notices.
- Validate editor asset manifests, hashes and ZIPP identity before UI builds and again
  when packaging. Verify the native runtime modules and include them in the release.

## Passed checks

- Four browser integration scenarios: native edit/AI cancel/retry/mobile/publish/runtime
  write; legacy hosted dashboard with private actions; a separate Coffee.Dating copy
  with media/backend/routes preserved; native records linked to a real local automation.
- 13 PHP tests, 305 assertions for native runtime, records, controllers and AI tools.
- 15 focused frontend tests for the runtime frame, archive import, storage and records.
- Nine artifact tests and eight release/signature/installer contract tests.
- Studio and Builder type checks; focused frontend lint; production UI build.
- Shared ZIPP browser checks: one download for expression-first, app-first, concurrent
  and WebCrypto-unavailable cases; two attempts for the deliberate failed-download retry;
  an incompatible runtime stops before downloading WASM.

AI replies in the editor regression test are deterministic fixtures. This validates
transport and file editing, not live model quality. Coffee.Dating's existing review app
and its records were not changed; the test imports source/assets into a separate draft.
Editor previews do not execute the unpublished backend; publish and open the hosted app
for backend testing. Both matching repo commits must be pushed before a remote workflow
can fetch the newly pinned Softn revision. Remote workflows were not run.
