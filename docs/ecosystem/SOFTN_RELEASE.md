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
   names one instead; `GITHUB_TOKEN` authenticates the calls, which CI sets),
   and the commit the release's tag points at (the annotated tag's target,
   not the release page's `target_commitish`, which may be a branch name).
2. Downloads the archive and its sidecar to `.runtime-source/softn-release/<tag>/`
   (ignored by Git, reused while its digest matches).
3. Verifies: the sidecar SHA-256 of the archive; the archive reads back as a
   sound zip; every file's digest in the archive's own `softn-release.json`;
   the archive was built from the commit the tag points at; the release's
   ZIPP engine is the one this tree vendors
   (`formlogic/ui/vendor/zipp-wasm/SOURCE.json`), byte for byte; the release's
   protocol versions equal `formlogic/ui/src/lib/softn/protocol.json`; the
   adapter the release ships is the one this tree has vendored.
4. Installs the three trees as one generation (below).
5. Records what it installed, with a complete file inventory, in
   `.runtime-source/softn-release/current.json`, which
   `scripts/ecosystem-manifest.mjs` reads.

`node scripts/fetch-softn-release.mjs --check` verifies an existing install
without the network. `--sync-adapter` rewrites the vendored adapter from the
release when it changed; that is a FormLogic change to review and commit.

## One release per run

A CI run prepares the runtime in several jobs. "Latest" is a moving target:
a Softn release published while a run is in flight would let a later job
install a different release from the one the earlier jobs tested. So a run
resolves the release **once** and freezes it:

```sh
node scripts/fetch-softn-release.mjs --resolve-only --frozen softn-frozen.json
```

writes a small record: the tag, the commit the annotated tag points at, the
asset's id and name, and the archive's SHA-256 from the release's sidecar.
Every job then installs with that record:

```sh
node scripts/fetch-softn-release.mjs --frozen softn-frozen.json     # or SOFTN_FROZEN=softn-frozen.json
```

which never asks for "latest": it fetches the frozen tag, requires the frozen
asset, checks the downloaded bytes against the frozen digest, and checks the
archive's own manifest names the frozen tag and commit. A tag that moved, an
asset that was replaced or renamed, a different tag named by
`SOFTN_RELEASE`, or replacement bytes fail with both values in the message.
A rerun of one job installs the frozen release again, from the cache.

`node scripts/ecosystem-manifest.mjs --check --exact` then asserts the
installed release **is** the frozen one (tag, commit, digest), on top of the
compatibility invariants. In the workflows (`package.yml`, `ci.yml`, and
`e2e.yml` when called), a first `resolve` job freezes the release and every
other job receives the record and passes it to the
`prepare-hosted-runtime` action's `frozen-release` input, whose manifest step
runs in `--exact` mode. The `softn-release` dispatch input still pins a tag
for the whole run; without a frozen record (plain development use) the
fetch installs the latest release and the check stays compatibility-only.

## One generation per install

The three trees are staged beside their destinations and verified there
(`runtime-manifest.json` per tree, per-editor manifests, the native runtime's
`provenance.json` plus `release: {tag, commit}`) before any destination
changes. They are then promoted together: a journal
(`.runtime-source/softn-release/promotion.json`) records the step, each old
tree is set aside as `<tree>.previous`, the new tree moves in, and only after
all three are in place is `current.json` written and the previous trees
dropped. A run that dies mid-swap is resolved by the next run before it does
anything else: if every tree had been promoted, the generation is completed
by recording it; otherwise every tree is put back from its `.previous` copy
(or removed, on a first install), so the result is all-old or all-new, never
a mixture. `--check` refuses to certify while a journal exists.

`current.json` carries the inventory of the generation: every file of every
tree with its digest, and the one transformation the install makes
(`provenance.json` gains `release`, recorded with the archive's content
digest). `--check` holds every installed file to that inventory: a missing,
extra or modified file, or one tree from another release with the same
engine and protocols, fails naming the tree and the paths, where the trees'
own manifests, each self-consistent, would have passed.

## What "latest, automatically" means for compatibility

The release installed is recorded, not pinned: `docs/ecosystem/compatibility-manifest.json`
carries the release, its commit, its archive digest and the frozen record as
informational fields that the plain `--check` ignores, because they move
with every Softn release without a FormLogic commit. What the check enforces
are the invariants: identical ZIPP bytes, equal protocol versions, the
vendored adapter being the one the release ships, and this tree's own
data-format constants. A Softn release that breaks one of those fails the
fetch itself, before anything is installed, with a message naming both sides
and the way out:

- a new ZIPP: update `formlogic/ui/vendor/zipp-wasm` to the same release
  (`node scripts/sync-zipp-from-softn.mjs`) and pass `npm run test:zipp-sharing`;
- a new protocol version: a FormLogic that speaks it, or `SOFTN_RELEASE=<older tag>`;
- a changed adapter: `--sync-adapter`, review, commit;
- a release without the archive (older than 15 September 2026): `SOFTN_RELEASE=<tag>`
  of one that has it, or wait for the next release.

The archive's contract (layout and `softn-release.json`) is
`softn.com/scripts/package-formlogic-runtime.mjs`; `scripts/fetch-softn-release.test.mjs`
exercises this side against a fixture built to it, including the frozen
record's refusals and the interrupted-promotion recoveries.

## Developing against a Softn checkout

Set `SOFTN_REPO` to the checkout and use the source builders as before:
`npm run build:hosted-runtime`, `npm run build:app-editors` (from `formlogic/ui`)
and `node scripts/prepare-native-runtime.mjs`; `formlogic/ui/scripts/sync-softn.mjs`
refreshes the adapter from that checkout. `SOFTN_REPO=... node scripts/ecosystem-manifest.mjs`
then describes the checkout instead of a release. Nothing in CI uses this path.
A local archive (`SOFTN_RELEASE_ARCHIVE=<zip>`) installs through the same
generation path and, given `--frozen`, is held to the record like a download.
