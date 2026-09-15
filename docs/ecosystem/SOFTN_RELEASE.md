# The Softn runtime comes from Softn's release

FormLogic embeds four things Softn ships: the ZIPP browser engine
(`formlogic/ui/vendor/zipp-wasm/`), the hosted app runtime
(`formlogic/ui/public/hosted-runtime/`), the two embedded editors
(`formlogic/ui/public/app-editors/`) and the native backend runtime
(`formlogic/backend/resources/softn-native/`), plus the source of the vendored
FormLogic adapter (`formlogic/ui/src/lib/softn/project.ts`). Since 15 September
2026 these come from Softn's GitHub release, not from a Softn source build; the
browser engine does too from Softn v0.0.15, and none of the four is in git.

The engine follows releases, ZIPP to Softn to FormLogic: Softn takes it from a
ZIPP release (its `web-python` bundle, checked against ZIPP's top-level and the
bundle's own `SHA256SUMS`) and ships it in the archive as `zipp/`, with the ZIPP
release it came from recorded in `softn-release.json` `zipp`. FormLogic names no
ZIPP release anywhere: a Softn release built with a new ZIPP installs with no
FormLogic commit, and `scripts/engine-provenance-guard.mjs` (CI) fails if an
engine binary, anything under `formlogic/ui/vendor/` or a `zipp_wasm*` file is
ever tracked again.

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
   the archive was built from the commit the tag points at; the engine (below);
   the release's protocol versions equal `formlogic/ui/src/lib/softn/protocol.json`;
   the adapter the release ships is the one this tree has vendored.
4. Installs the four trees as one generation (below).
5. Records what it installed, with a complete file inventory, in
   `.runtime-source/softn-release/current.json`, which
   `scripts/ecosystem-manifest.mjs` reads.

`node scripts/fetch-softn-release.mjs --check` verifies an existing install
without the network. `--sync-adapter` rewrites the vendored adapter from the
release when it changed; that is a FormLogic change to review and commit.

## The engine

The expected identity is derived from the release, never from this tree:

- `softn-release.json` `zipp` must be a ZIPP release record
  (`zippReleaseIdentity` in `formlogic/ui/scripts/hosted-runtime-artifact.mjs`):
  `release` a `vX.Y.Z` tag equal to `version`, a 40-hex `revision`, `build`
  `release`, and the digests of the bundle, of ZIPP's `SHA256SUMS` and of the
  glue. An archive without it, or without `zipp/`, is refused as needing Softn
  v0.0.15 or later (v0.0.13 and v0.0.14 recorded a local build).
- `zipp/` must be that release, internally consistent (`checkZippTree`): the
  glue, `zipp_wasm.d.ts` (tsc needs it), the wasm, `LICENSE-APACHE` (the zip
  ships it), `SOURCE.json`, the bundle's `SHA256SUMS`, `BUILD-INFO.txt` and
  `RELEASE-SHA256SUMS` are present; every shipped file ZIPP built matches the
  bundle's `SHA256SUMS` (which also lists `gpu-lab/`, `host-sdk/`, `docs/` and
  a README Softn does not ship, so the check runs from shipped file to sums,
  never the reverse; Softn's `SOURCE.json`, `RELEASE-SHA256SUMS` and curated
  notices are exempt, and the notices `SOURCE.json` names may not be one of
  those files or a file the bundle's sums list); `BUILD-INFO.txt` names the
  recorded commit, version, variant, languages and stack size;
  `RELEASE-SHA256SUMS` is the recorded ZIPP sums and lists the recorded
  bundle; the wasm, glue and notices match `SOURCE.json`, which carries every
  field of `softn-release.json` `zipp` unchanged.
- The native runtime shares it: `native-runtime/wasm/zipp_wasm_bg.wasm` and its
  `SOURCE.json` name the same engine, and `zipp_wasm.mjs` is `zipp/zipp_wasm.js`.
- Every engine copy in the archive, found by its exports (`zippProfile`,
  `zipp_start`, `engine_evalInContext`) rather than its file name, has the
  recorded digest, and every copy Softn's packager places is found: `zipp/`,
  `native-runtime/wasm/`, and in `hosted-runtime/` and each editor both
  `assets/zipp_wasm_bg-*.wasm` and `assets/core-runtime/zipp_wasm_bg.wasm`.

This proves consistency, not authenticity: checking the bytes against ZIPP's
published `SHA256SUMS` is Softn's job (at install, and again online when it
releases). FormLogic never contacts ZIPP.

`zipp/` installs as `formlogic/ui/vendor/zipp-wasm/`, the path
`zipp-host.ts` and `zipp-bytes.ts` import, so no source names a generated
location. `check-hosted-runtime.mjs` and `check-app-editors.mjs` both run
`checkZippTree` over it at prebuild; `check-hosted-runtime.mjs` also runs
before `npm test` and `npm run typecheck:test`, so a fresh clone is told to
fetch instead of failing on a missing module. `scripts/package-dist.mjs`
checks it against `current.json` `zipp` (against its own `SOURCE.json` when no
release is installed, as from a source checkout), requires every engine the UI
build emitted to be that release's, and writes `zipp-licenses.txt` (the
notices, then ZIPP's `LICENSE-APACHE`) and `engine-identity.json` (`zipp`, and
the Softn release tag and archive digest) at the zip root.

In the browser, form expressions, calculated fields, validation and app logic
run in a dedicated worker; each evaluation gets a fresh `Engine`, the canonical
FormLogic prelude and a JSON data context, with no host bridge. The page's byte
broker (`formlogic/ui/src/lib/formlogic/zipp-bytes.ts`) downloads the wasm
lazily, checks its SHA-256 against `SOURCE.json` and hands cloned bytes to the
form worker and to any hosted Softn app; on an HTTP LAN development address
without WebCrypto the check uses FormLogic's bundled libsodium instead of
requiring HTTPS or skipping it. A page that neither evaluates a form nor
starts a hosted app never fetches the binary. Each worker and hosted frame
keeps its own WebAssembly instance, memory and capabilities: a worker restart
or a second app reuses the page's bytes, not its VM state or sandbox
authority. The hosted shell announces its engine version and hash first and
is refused on a mismatch, so new engine bytes are never paired with an old
shell's glue. Serve the wasm as `application/wasm` with compression
(FormLogic's `.htaccess` sets both); its content-hashed URL lets a new engine
coexist with a cached older one. Useful checks from `formlogic/ui`:

```sh
npx vitest run src/lib/formlogic/corpusParity.test.ts src/lib/formlogic/zipp-bytes.test.ts src/lib/formlogic/engine.test.ts src/components/studio/HostedAppFrame.test.tsx
npm run test:hosted-runtime
npm run test:zipp-sharing
```

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
`e2e.yml` when called), a first `resolve` job (the reusable
`resolve-softn-release.yml`) freezes the release and every other job passes
the record it outputs to the `prepare-hosted-runtime` action's
`frozen-release-json` input; the action writes it to a file of its own, and
its manifest step runs in `--exact` mode. (Its `frozen-release` input takes
the path of a record already on disk instead, never together with the JSON.)
A job given no record fails there unless its caller sets `allow-latest`
(only `e2e.yml` dispatched on its own does), so a record lost between jobs
cannot become "latest". The `softn-release` dispatch input still pins a tag
for the whole run; without a frozen record (plain development use) the
scripts install the latest release and the check stays compatibility-only.

## One generation per install

The four trees are staged beside their destinations and verified there
(the engine tree's release check, `runtime-manifest.json` per tree, per-editor
manifests, the native runtime's `provenance.json` plus `release: {tag, commit}`)
before any destination
changes. They are then promoted together: a journal
(`.runtime-source/softn-release/promotion.json`) records the step, each old
tree is set aside as `<tree>.previous`, the new tree moves in, and only after
all four are in place is `current.json` written and the previous trees
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

The release installed, and the ZIPP release it ships, are recorded, not pinned:
`docs/ecosystem/compatibility-manifest.json` carries the release, its commit, its
archive digest, the frozen record and the ZIPP identity (release, revision,
digests) as informational fields that the plain `--check` ignores, because they
move with every Softn release without a FormLogic commit. What the check enforces
are the invariants: identical ZIPP bytes in the browser engine and the native
runtime, the engine tree carrying the release's ZIPP record, equal protocol versions, the
vendored adapter being the one the release ships, and this tree's own
data-format constants. A Softn release that breaks one of those fails the
fetch itself, before anything is installed, with a message naming both sides
and the way out:

- an engine copy that is not the recorded ZIPP release, or no `zipp/` tree (Softn
  before v0.0.15): `SOFTN_RELEASE=<tag>` of a release that ships one (a new ZIPP
  release on its own needs nothing: it installs);
- a new protocol version: a FormLogic that speaks it, or `SOFTN_RELEASE=<older tag>`;
- a changed adapter: `--sync-adapter`, review, commit;
- a release without the archive (older than 15 September 2026): `SOFTN_RELEASE=<tag>`
  of one that has it, or wait for the next release.

The archive's contract (layout and `softn-release.json`) is
`softn.com/scripts/package-formlogic-runtime.mjs`; `scripts/fetch-softn-release.test.mjs`
exercises this side against a fixture built to it, including the frozen
record's refusals and the interrupted-promotion recoveries. CI runs it with the
other engine sourcing tests (the guard, the manifest, source-mode sync and
`scripts/release-runtime.test.mjs`) in `ci.yml`'s frontend job and `package.yml`'s
verify job.

## Developing against a Softn checkout

Set `SOFTN_REPO` to the checkout, run `npm run fetch:zipp` there (its
`wasm-zipp/` is generated from the ZIPP release its Cargo tag names), and use the
source builders: `node scripts/sync-zipp-from-softn.mjs` (runs the checkout's
`fetch-zipp-release.mjs --check`, then installs its whole ZIPP release as
`formlogic/ui/vendor/zipp-wasm` and checks it like a release's `zipp/`),
`node scripts/prepare-native-runtime.mjs`, and `npm run build:hosted-runtime` and
`npm run build:app-editors` (from `formlogic/ui`); `formlogic/ui/scripts/sync-softn.mjs`
refreshes the adapter from that checkout. `SOFTN_REPO=... node scripts/ecosystem-manifest.mjs`
then describes the checkout instead of a release; with `--check` it holds the checkout
to the committed (release-mode) manifest, setting aside only the `pinnedBy` texts that
name the mode. Nothing in CI uses this path.
A local archive (`SOFTN_RELEASE_ARCHIVE=<zip>`) installs through the same
generation path and, given `--frozen`, is held to the record like a download.
