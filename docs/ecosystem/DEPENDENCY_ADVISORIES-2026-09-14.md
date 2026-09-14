# Dependency advisories reconciled against shipped lockfiles (ECO-04)

**Run:** 14 September 2026, reviewer's Windows 11 workstation, online. Tools: `cargo audit 0.22.2` (RustSec DB current at run time), `npm audit` (npm registry advisories, `--audit-level=high` for gating), `composer audit` (Packagist). Every result below is dated; re-run before widening native networking or tagging a release. A tool that cannot reach its service is recorded as **unknown**, never as clean (see `VERIFICATION_POLICY.md` §4).

## Results per shipped lockfile

| Lockfile | Tool | Result | Resolution |
| --- | --- | --- | --- |
| `xdb.org/Cargo.lock` | cargo audit | 4 vulnerabilities, 10 unmaintained, 4 unsound, 2 yanked (warnings) | **crossbeam-epoch 0.9.18 → 0.9.21** and **h2 0.4.12 → 0.4.19** updated in place (semver-compatible; `cargo test -p xdb` passes). **quick-xml 0.37.5** (RUSTSEC-2026-0194/0195, fixed in 0.41): not direct; constrained by a parent in the libp2p family — accepted exception below. |
| `aokie.com/Cargo.lock` | cargo audit | 0 vulnerabilities, 9 unmaintained warnings | clean; the existing `cargo audit` CI gate and `.cargo/audit.toml` (no ignores) stay. |
| `oaiy.com/desktop/src-tauri/Cargo.lock` | cargo audit | 0 vulnerabilities, 6 unmaintained, 1 unsound warning | clean. |
| `softn.com/apps/softn-loader/src-tauri/Cargo.lock` | cargo audit | 0 vulnerabilities | clean. Its XDB path dependency resolves through the sibling checkout pinned by `checkout-xdb.sh`; the XDB row above is the one that applies to shipped Softn desktop builds. |
| `softn.com/apps/softn-rust/Cargo.lock` | cargo audit | 0 vulnerabilities | clean. |
| `zipp.org/Cargo.lock` | cargo audit | 0 vulnerabilities | clean. |
| `softn.com/package-lock.json` (workspace) | npm audit (high) | 0 | clean (883 packages; 160 prod). |
| `formlogic.com/formlogic/ui/package-lock.json` | npm audit (high) | 0 | clean (703 packages). |
| `xdb.org/package-lock.json` | npm audit (high) | 0 | clean. |
| `aokie.com/apps/aokie-mobile/package-lock.json` | npm audit (high) | 0 | clean. |
| `oaiy.com/ui/package-lock.json` | npm audit (high) | **5 high, 3 moderate, 1 low** | see OAIY table below. |
| `oaiy.com/cli/package-lock.json` | npm audit (high) | **2 high, 1 moderate** | see OAIY table below. |
| `oaiy.com/desktop/package-lock.json` | npm audit (high) | **4 high, 3 moderate, 1 low** | see OAIY table below. |
| `formlogic.com/formlogic/backend/composer.lock` | composer audit | 0 advisories, 0 abandoned | clean. |
| `oaiy.com/api` | composer audit | no packages | nothing to audit. |

### OAIY npm findings (not remediated by this review; owner: OAIY release owner)

| Package | Where | Severity | Runtime or dev | Fix | Exposure note |
| --- | --- | --- | --- | --- | --- |
| browserslist ≤4.28.6 | ui, desktop | high | prod (build-time tooling resolved as prod) | `npm audit fix` (non-major) | build tooling; not reachable from shipped pages |
| nanoid ≤3.3.17 | ui, desktop | high | prod | `npm audit fix` | id generation; check shipped bundles for direct use |
| postcss ≤8.5.22 | ui (dev), desktop (prod) | high | dev / prod | `npm audit fix` | build-time source map loading; not in shipped output |
| undici 7.x / 8.x | ui (prod), cli (dev) | high | prod / dev | `npm audit fix` | HTTP client; **prod in ui** — verify whether the browser bundle includes it (likely a Node-only dependency of tooling) |
| vite 7.0–7.3.3 | ui, desktop | high | dev | `npm audit fix` | dev server only |
| sharp ≤0.35.4-rc.0 | cli | high | dev | major (0.35.4) | image tooling, dev only |
| dompurify ≤3.4.12 via monaco-editor | ui | moderate | prod | major (monaco 0.56) | editor sanitiser; assess whether untrusted HTML reaches DOMPurify in the flow builder |
| @vitest/mocker, vitest, esbuild | desktop, cli | moderate | dev | major | test tooling |
| baseline-browser-mapping | ui, desktop | moderate | prod | `npm audit fix` | tooling |

Recommended order for OAIY: run `npm audit fix` (non-major) in `ui`, `cli` and `desktop`, then re-run the release gate (`ci.yml`) which now includes the full CLI and desktop suites; schedule the major bumps (monaco-editor, sharp, vitest/esbuild) as a separate change with the same gate. Until then, OAIY's release workflow does not have an npm audit step; its `release-evidence-*.json` should carry `"dependencyAudit": { "status": "fail" }` for these lockfiles, not omit it.

## Accepted exceptions

| Advisory | Lockfile | Owner | Reason | Exposure assessment | Expiry |
| --- | --- | --- | --- | --- | --- |
| RUSTSEC-2026-0194 / RUSTSEC-2026-0195 (quick-xml 0.37.5 quadratic duplicate-attribute check; unbounded namespace allocation in `NsReader`) | `xdb.org/Cargo.lock` (and therefore Softn desktop builds) | XDB / Softn native release owner | Not a direct dependency; the 0.37 line is required by a parent in the libp2p/mDNS stack, so moving to 0.41 needs a coordinated parent upgrade and a native peer-networking regression run. | XML parsing is reached only through libp2p components; native peer networking is **off by default and opt-in** since XD-01, so a default installation does not exercise the code. Denial-of-service class, not code execution. | 2026-10-31 — re-audit; if the parent stack still pins 0.37, escalate before any decision to enable networking by default. |
| RustSec **unmaintained / unsound / yanked warnings** (XDB 10/4/2, Aokie 9, OAIY 6/1) | as listed | each repository's release owner | Warnings, not vulnerabilities; listed by `cargo audit` and left visible. | No known exploit; tracked so they are not forgotten. | reviewed at each release |

## How this feeds release evidence

- The compatibility manifest (`node scripts/ecosystem-manifest.mjs`) names the exact revisions whose lockfiles these results apply to. A lockfile change invalidates this table for that repository; the release record must carry a fresh dated result (`dependencyAudit` in `VERIFICATION_POLICY.md` §4).
- Each Cargo lockfile above is a candidate for an SBOM (`cargo sbom` / `cargo cyclonedx`) in the release evidence; this review did not add SBOM generation to the workflows.
- Historical alert text (the XDB audit of 12 September listing hickory-proto and others) is not a current verdict: the current run found no hickory-proto advisory against the shipped lockfile after the earlier upgrades.
