# The Softn runtime comes from Softn's release

FormLogic embeds three things Softn builds: the hosted app runtime
(`formlogic/ui/public/hosted-runtime/`), the two embedded editors
(`formlogic/ui/public/app-editors/`) and the native backend runtime
(`formlogic/backend/resources/softn-native/`), plus the source of the vendored
FormLogic adapter (`formlogic/ui/src/lib/softn/project.ts`). Since 15 September
2026 these come from Softn's GitHub release, not from a Softn source build.

## How it works

Every Softn release (tag `v*`) publishes `softn-formlogic-runtime-<tag>.zip`
and its `.sha256`, built once by Softn's release workflow and verified there.
`scripts/fetch-softn-release.mjs`:

1. Looks up the latest release through the GitHub API (`SOFTN_RELEASE=<tag>`
   names one instead; `GITHUB_TOKEN` authenticates the calls, which CI sets).
2. Downloads the archive and its sidecar to `.runtime-source/softn-release/<tag>/`
   (ignored by Git, reused while its digest matches).
3. Verifies: the sidecar SHA-256 of the archive; the archive reads back as a
   sound zip; every file's digest in the archive's own `softn-release.json`;
   the release's ZIPP engine is the one this tree vendors
   (`formlogic/ui/vendor/zipp-wasm/SOURCE.json`), byte for byte; the release's
   protocol versions equal `formlogic/ui/src/lib/softn/protocol.json`; the
   adapter the release ships is the one this tree has vendored.
4. Installs the three trees through the same staging-and-verify path the
   source builders used (`runtime-manifest.json` per tree, per-editor
   manifests, the native runtime's `provenance.json` plus `release: {tag, commit}`).
5. Records what it installed in `.runtime-source/softn-release/current.json`,
   which `scripts/ecosystem-manifest.mjs` reads.

`node scripts/fetch-softn-release.mjs --check` verifies an existing install
without the network. `--sync-adapter` rewrites the vendored adapter from the
release when it changed; that is a FormLogic change to review and commit.

## What "latest, automatically" means for compatibility

The release installed is recorded, not pinned: `docs/ecosystem/compatibility-manifest.json`
carries the release, its commit and its archive digest as informational fields
that the `--check` ignores, because they move with every Softn release without
a FormLogic commit. What the check enforces are the invariants: identical ZIPP
bytes, equal protocol versions, the vendored adapter being the one the release
ships, and this tree's own data-format constants. A Softn release that breaks
one of those fails the fetch itself, before anything is installed, with a
message naming both sides and the way out:

- a new ZIPP: update `formlogic/ui/vendor/zipp-wasm` to the same release
  (`node scripts/sync-zipp-from-softn.mjs`) and pass `npm run test:zipp-sharing`;
- a new protocol version: a FormLogic that speaks it, or `SOFTN_RELEASE=<older tag>`;
- a changed adapter: `--sync-adapter`, review, commit;
- a release without the archive (older than 15 September 2026): `SOFTN_RELEASE=<tag>`
  of one that has it, or wait for the next release.

The archive's contract (layout and `softn-release.json`) is
`softn.com/scripts/package-formlogic-runtime.mjs`; `scripts/fetch-softn-release.test.mjs`
exercises this side against a fixture built to it.

## Developing against a Softn checkout

Set `SOFTN_REPO` to the checkout and use the source builders as before:
`npm run build:hosted-runtime`, `npm run build:app-editors` (from `formlogic/ui`)
and `node scripts/prepare-native-runtime.mjs`; `formlogic/ui/scripts/sync-softn.mjs`
refreshes the adapter from that checkout. `SOFTN_REPO=... node scripts/ecosystem-manifest.mjs`
then describes the checkout instead of a release. Nothing in CI uses this path.
