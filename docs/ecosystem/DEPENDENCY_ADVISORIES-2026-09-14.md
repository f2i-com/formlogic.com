# Dependency advisories reconciled against shipped lockfiles (ECO-04)

**Run:** 14 September 2026, reviewer's Windows 11 workstation, online. Tools: `cargo audit 0.22.2` (RustSec DB current at run time), `npm audit` (npm registry advisories, `--audit-level=high` for gating), `composer audit` (Packagist). Every result below is dated; re-run before widening native networking or tagging a release. A tool that cannot reach its service is recorded as **unknown**, never as clean (see `VERIFICATION_POLICY.md` §4).

**Second pass, 14 September 2026 (later the same day):** the OAIY high findings were remediated and the XDB quick-xml exception was closed rather than accepted. The tables below show the state after that pass; the first-pass findings are kept in the "as found" rows so the record shows what changed.

## Results per shipped lockfile

| Lockfile | Tool | Result | Resolution |
| --- | --- | --- | --- |
| `xdb.org/Cargo.lock` | cargo audit | as found: 4 vulnerabilities, 10 unmaintained, 4 unsound, 2 yanked (warnings). **After the second pass: 0 vulnerabilities, 16 warnings.** | **crossbeam-epoch 0.9.18 → 0.9.21** and **h2 0.4.12 → 0.4.19** updated in place (semver-compatible; `cargo test -p xdb` passes). **quick-xml 0.37.5 → 0.41.0** (RUSTSEC-2026-0194/0195): the first pass attributed it to the libp2p stack; `cargo tree -i quick-xml` shows its only dependent is `wayland-scanner` (the demo app's Linux GUI tooling, not the `xdb` crate). `cargo update -p wayland-scanner` (0.31.7 → 0.31.11) moves it to 0.41.0; the xdb crate's own dependency set is unchanged. |
| `aokie.com/Cargo.lock` | cargo audit | 0 vulnerabilities, 9 unmaintained warnings | clean; the existing `cargo audit` CI gate and `.cargo/audit.toml` (no ignores) stay. |
| `oaiy.com/desktop/src-tauri/Cargo.lock` | cargo audit | 0 vulnerabilities, 6 unmaintained, 1 unsound warning | clean. |
| `softn.com/apps/softn-loader/src-tauri/Cargo.lock` | cargo audit | 0 vulnerabilities | clean. Its XDB path dependency resolves through the sibling checkout pinned by `checkout-xdb.sh`; the XDB row above is the one that applies to shipped Softn desktop builds. |
| `softn.com/apps/softn-rust/Cargo.lock` | cargo audit | 0 vulnerabilities | clean. |
| `zipp.org/Cargo.lock` | cargo audit | 0 vulnerabilities | clean. |
| `softn.com/package-lock.json` (workspace) | npm audit (high) | 0 | clean (883 packages; 160 prod). |
| `formlogic.com/formlogic/ui/package-lock.json` | npm audit (high) | 0 | clean (703 packages). |
| `xdb.org/package-lock.json` | npm audit (high) | 0 | clean. |
| `aokie.com/apps/aokie-mobile/package-lock.json` | npm audit (high) | 0 | clean. |
| `oaiy.com/ui/package-lock.json` | npm audit (high) | as found: **5 high, 3 moderate, 1 low**. After the second pass: **0 high**, 2 moderate. **Third pass: 0 at every severity.** | `npm audit fix`; then dompurify ^3.4.15 via npm `overrides`; see OAIY table below. |
| `oaiy.com/cli/package-lock.json` | npm audit (high) | as found: **2 high, 1 moderate**. After the second pass: **0 high**, 1 moderate. **Third pass: 0.** | `npm audit fix`, `sharp` → ^0.35.4, esbuild → ^0.28.2; see OAIY table below. |
| `oaiy.com/desktop/package-lock.json` | npm audit (high) | as found: **4 high, 3 moderate, 1 low**. After the second pass: **0 high**, 2 moderate. **Third pass: 0.** | `npm audit fix`, vitest → ^5; see OAIY table below. |
| `formlogic.com/formlogic/backend/composer.lock` | composer audit | 0 advisories, 0 abandoned | clean. |
| `oaiy.com/api` | composer audit | no packages | nothing to audit. |

### OAIY npm findings (as found, then remediated in the second pass; owner: OAIY release owner)

| Package | Where | Severity | Runtime or dev | Fix | Status after the second pass |
| --- | --- | --- | --- | --- | --- |
| browserslist ≤4.28.6 | ui, desktop | high | prod (build-time tooling resolved as prod) | `npm audit fix` (non-major) | **fixed** |
| nanoid ≤3.3.17 | ui, desktop | high | prod | `npm audit fix` | **fixed** |
| postcss ≤8.5.22 | ui (dev), desktop (prod) | high | dev / prod | `npm audit fix` | **fixed** |
| undici 7.x / 8.x | ui (prod), cli (dev) | high | prod / dev | `npm audit fix` | **fixed** |
| vite 7.0–7.3.3 | ui, desktop | high | dev | `npm audit fix` | **fixed** |
| sharp ≤0.35.4-rc.0 | cli | high | optional | `sharp` ^0.35.4 as an optional dependency (it had been listed twice, once as dev) | **fixed** |
| dompurify ≤3.4.12 via monaco-editor | ui | moderate | prod | npm `overrides`: dompurify ^3.4.15 (monaco 0.55.1 declares ^3.2; 0.56.0 still pins a vulnerable 3.4.8 and moves its worker entry points, which breaks the Vite build) | **fixed (third pass)**; `npm test`, production build and node contracts pass with the override |
| @vitest/mocker, vitest | desktop | moderate | dev | vitest ^5.0.0 | **fixed (third pass)**; 113 tests and the build pass |
| esbuild ≤0.24.2 | cli | moderate | dev | esbuild ^0.28.2 | **fixed (third pass)**; build, `npm test`, typecheck and the HTTPS shutdown check pass |
| baseline-browser-mapping | ui, desktop | moderate | prod | `npm audit fix` | **fixed** |

After the fixes the OAIY suites were re-run: ui `npm test`, cli build + `npm test` + `npm run typecheck` + HTTPS shutdown check, desktop Vitest + build. The CLI typecheck had never passed before (browser-only globals in the shared engine sources, untyped generated glue); it passes now, so the OAI-01 gate that runs it is honest. OAIY's `ci.yml` now runs `npm audit --audit-level=high` in the ui, cli and desktop lanes (high fails; unreachable registry is recorded as UNKNOWN and fails), and `release-evidence-*.json` carries `dependencyAudit`. The moderate items were closed in the third pass (esbuild 0.28, vitest 5, dompurify override); all three OAIY lockfiles audit clean at every severity as of 14 September 2026.

## Accepted exceptions

| Advisory | Lockfile | Owner | Reason | Exposure assessment | Expiry |
| --- | --- | --- | --- | --- | --- |
| ~~RUSTSEC-2026-0194 / RUSTSEC-2026-0195 (quick-xml 0.37.5)~~ | `xdb.org/Cargo.lock` | XDB release owner | **Closed in the second pass, not accepted.** The first-pass reason ("required by a parent in the libp2p stack") was wrong: the only dependent was `wayland-scanner`, pulled by the demo app's Linux GUI dependencies and never by the `xdb` crate that Softn's loader consumes. `cargo update -p wayland-scanner` resolved it to quick-xml 0.41.0. | Even as found, the code was unreachable from the xdb crate and from Windows/macOS builds of the demo. | — |
| RustSec **unmaintained / unsound / yanked warnings** (XDB 10/4/2, Aokie 9, OAIY 6/1) | as listed | each repository's release owner | Warnings, not vulnerabilities; listed by `cargo audit` and left visible. | No known exploit; tracked so they are not forgotten. | reviewed at each release |

## How this feeds release evidence

- The compatibility manifest (`node scripts/ecosystem-manifest.mjs`) names the exact revisions whose lockfiles these results apply to. A lockfile change invalidates this table for that repository; the release record must carry a fresh dated result (`dependencyAudit` in `VERIFICATION_POLICY.md` §4).
- Each Cargo lockfile above is a candidate for an SBOM (`cargo sbom` / `cargo cyclonedx`) in the release evidence; this review did not add SBOM generation to the workflows.
- Historical alert text (the XDB audit of 12 September listing hickory-proto and others) is not a current verdict: the current run found no hickory-proto advisory against the shipped lockfile after the earlier upgrades.
