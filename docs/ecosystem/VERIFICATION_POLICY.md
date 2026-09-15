# Verification while automatic CI is paused (ECO-01)

**Status:** policy adopted 14 September 2026 for FormLogic, OAIY, Aokie, Softn, ZIPP and XDB. The pause of automatic push/PR checks (12 September 2026) is **temporary cost control**, not a change of what "verified" means. Nothing below turns an expensive automatic job back on; it makes the manual path produce the same evidence.

## 1. What a release consumes

Every release path runs the repository's **reusable verification workflow at the exact revision it builds**, never an earlier green run:

| Repository | Reusable gate | Release path that calls it |
| --- | --- | --- |
| FormLogic | `.github/workflows/ci.yml` jobs (backend + frontend) and `package.yml`'s own `verify`/`php-floor`/`e2e` jobs | `package.yml` (`package` needs `[verify, e2e, php-floor]`) |
| OAIY | `.github/workflows/ci.yml` (`workflow_call`, input `ref`) — web, CLI `npm test` + typecheck, desktop Vitest, `cargo test` headless and GUI | `release.yml` (`release` needs `[meta, verify, web, desktop]`; every job checks out `needs.meta.outputs.revision`) |
| Aokie | `ci.yml` jobs in the same run | `plugin-release` needs `[plugin, plugin-voice, clippy, supply-chain, managed-beta, companion]` |
| Softn | `.github/workflows/verify.yml` (`workflow_call`, input `ref`) | `release.yml` passes the tag |
| ZIPP | `.github/workflows/ci.yml` (`workflow_call`, input `ref`) + `security.yml` | `release.yml` passes the validated commit |
| XDB | `cargo test -p xdb` (both feature sets), `cargo clippy`, `npm run typecheck -w @xdb/react`, `npm test -w @xdb/react` | manual (README "Manual checks"); consumed through Softn's release |

A later commit cannot inherit a previous commit's status: the reusable gates check out the requested `ref`, and OAIY's release additionally refuses to publish evidence that names any other revision than the tagged commit.

## 2. Fast lanes versus heavy qualification

| Lane | Runs on every verified revision | Examples |
| --- | --- | --- |
| Fast contracts | yes | typecheck, lint, unit tests, small regressions, migration checks, contract-drift gates (Aokie `check-contracts.mjs`, Softn hosted-runtime tests, FormLogic `check-app-editors.mjs`), compatibility manifest check (`node scripts/ecosystem-manifest.mjs --check`) |
| Full conformance | on demand / before a tagged release | ZIPP full 230-binary engine suite, Test262, three-browser Worker smoke, FormLogic Playwright e2e, Softn Tauri matrix builds |
| Hardware qualification | consented lab only, never CI | Aokie radio/dongle/phone scenarios (see `RELEASE_QUALIFICATION.md` §hardware) |

Changes that require FULL qualification before release: engine bytecode/semantics (ZIPP), vendored `zipp_wasm_bg.wasm` bytes, the native hosting or hosted-runtime protocol (`host-protocol.json`, the app-editor port protocol), XDB wire messages or schema, account backup format, the Aokie connector contract, and any lockfile change in a networking or crypto dependency family.

## 3. Fresh evidence rules

Verification is stale, and must be re-run, when any of these change after it ran: source, lockfiles (`Cargo.lock`, `package-lock.json`, `composer.lock`), bridge/protocol contracts, toolchains (`rust-toolchain.toml`, `.node-version`, pinned action revisions), vendored runtime bytes (ZIPP wasm, Softn hosted runtime), or the revision itself (a rebase produces a new revision, and the evidence names the old one).

## 4. The manual verification record

When checks are run by hand instead of by the workflow, the release record must contain, per repository:

```json
{
  "repository": "f2i-com/oaiy.com",
  "revision": "<40-hex commit>",
  "verifiedAt": "2026-09-14T06:12:00Z",
  "environment": { "os": "…", "node": "v24.19.0", "rustc": "…", "php": "…" },
  "commands": ["npm ci", "npm test", "cargo test --no-default-features", "…"],
  "results": { "npm test": "pass (4 suites)", "cargo test --no-default-features": "pass (28)" },
  "skippedLanes": [{ "lane": "desktop cargo test --features gui", "reason": "no GTK on this host" }],
  "artifacts": [{ "name": "oaiy-server-0.0.5-linux-x86_64.tar.gz", "sha256": "…" }],
  "dependencyAudit": { "status": "pass | fail | unknown", "tool": "cargo audit 0.22.2", "at": "…" }
}
```

Rules: exact SHAs, not branch names; every skipped lane named with its reason; artifact digests recomputed from the bytes being shipped; **a dependency audit whose service was unreachable is recorded as `unknown`, never `pass`** (FormLogic's CI writes that state to the run summary; `package.yml` stops on it). Attach the record to the release (OAIY ships `release-evidence-*.json`; Aokie ships `release-manifest.json`; the others attach it to the GitHub release notes until their workflows emit one).

## 5. Branch and ruleset enforcement

Repository rulesets could not be inspected by the review (no administration access). Whoever holds it must confirm, per repository, that `main` requires the fast-lane checks (or, while paused, a linked manual record) before merge, and record that confirmation in this file's history when done. Do not infer protection from a green badge.
