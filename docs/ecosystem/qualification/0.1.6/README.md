# FormLogic 0.1.6 candidate: qualification lanes run on 15 September 2026

Evidence for ticket FL-S09 of the source-verified handoff. Every lane below was run
on this machine against the candidate built from FormLogic `d27d9446eb769538a8d74cef6705e5c6cd0b58e1`
with the Softn runtime installed from release **v0.0.13** (commit `2288b6dee98329554d4f9b48366703ddee2711e6`,
`softn-formlogic-runtime-v0.0.13.zip`, sha256 `131f9e8ff5438dba2081dc6dd0f5fa01371f903ad6b0a33c3c095c6dfd840d01`).
`evidence.json` carries the same facts machine-readably; `lab/` holds the exact scripts.

Identity of the tested bytes:

| Artifact | Value |
| --- | --- |
| FormLogic commit | `d27d9446eb769538a8d74cef6705e5c6cd0b58e1` (working tree also carried other streams' uncommitted edits to `scripts/fetch-softn-release*.mjs` and backend/UI sources; the package was built from that tree) |
| Candidate package | `formlogic-d27d9446-20260915.zip`, 144 442 778 bytes, sha256 `5fa5251788bae8d154f27b41e89168ffa3409acef9f149621017f3c27f1e3843`, built with `node scripts/package-dist.mjs --no-install --out <scratch>` on Windows (zip written by the PowerShell fallback) |
| Predecessor package | `formlogic-0.1.5.zip` from the GitHub release, sha256 `34dee2b59990f00afcb71ec467b37e60afd47d8aca182ea4b3baa3f55cb9ec7e` |
| Native runtime inside the package | `api/resources/softn-native/provenance.json`: source `softn.com/apps/softn-host-php/runtime`, nativeProtocol 1, ZIPP 0.0.18 @ `2f5c4c8d…` sha256 `206630229207e0ecb0e3440444092d45abb6fdc7bc7608f5c469ff49af4360ab` |
| Lab hosts | Docker Desktop (Linux containers): `php:8.3-apache` (PHP 8.3.33, Apache 2.4.68) + pdo_mysql/zip/gd, Node 24.19.0, `mysql:8` (8.4.11); image recipe in `lab/Dockerfile` |

## Lane results

| Lane | Result | What was done |
| --- | --- | --- |
| 1. Assembled distribution | pass | Package built from the tree; 2 956 files extracted; `VERSION` `d27d9446-20260915`; front controller, root `.htaccess`, `INSTALL.txt`/`UPGRADE.txt`, native runtime and editors present. |
| 2. Clean-host install | pass | Empty container, `INSTALL.txt` manual steps only (`api/.env` from `.env.example`, `php api/bin/upgrade.php`, chmod of the sandbox binary). `/api/health` ok. Register → login → form with a calculated field (evaluated by the vendored sandbox runtime: 42) → response → create app → native preflight (9 checks ok, Node 24.19.0, worker started) → install a minimal native project (version 1) → hosted request 201 → owner records listing (1 row). |
| 2b. Missing Node | pass | With `FORMLOGIC_NODE_BIN` pointing at a missing binary: preflight `node.executable` fails with "The configured Node.js binary could not be executed (set FORMLOGIC_NODE_BIN to a working Node.js install)", hosted requests answer 503 "The native app host is unavailable. Check its runtime configuration.", form submissions still 201. |
| 3. Predecessor upgrade | pass | v0.1.5 installed in a fresh pair and seeded (account, form + response, native app with a record). `docs/UPGRADING.md` steps: dump + `.env` + `storage/` backup, files replaced except `api/.env` and `api/storage/`, `php api/bin/upgrade.php --app-version=…`, `--check` exit 0. After: same account logs in, responses kept and a new one accepted, native app version 1 with 4 files, hosted read returns the pre-upgrade record, hosted write 201. Attachment lane on the upgraded host: PNG upload → response referencing it (201) → download digest matches. |
| 3b. Interrupted upgrade | no window | `upgrade.php` killed 3 s after start on a second v0.1.5 host: every schema step between 0.1.5 and this candidate is a no-op ("Migrations applied … already-applied steps are no-ops"), the CLI finishes in about a second, so the kill landed after completion. Container restarted: health ok, `--check` passed, data and hosted app verified. Consequence: for 0.1.5 → this candidate the schema is unchanged, so file-level rollback (restore the old files, keep `.env` and `storage/`) is sufficient; no migration reversal is involved. A future release that adds a migration needs this lane re-run with a real window. |
| 4a. Account backup → empty host | pass with documented boundary | `GET /api/account/backup/export` (13 249 bytes: `manifest.json`, `backup.json`, `data/forms/*`, `files/*`, `native/<app>/*`; no `.env`, no host key material). Imported into a NEW account on an empty candidate host: 4 forms, 3 responses, 1 file, native app restored with its database; ids are regenerated. Reads and writes work on the restored host: new response accepted, hosted read shows both records, hosted write 201, the attachment downloads with the original digest. The import reports `cryptoMaterial: reissued` and warns that values sealed or signed under the old host keys cannot be read; key-preserving recovery is the scheduled site backup. |
| 4b. Site-level restore (DEPLOYMENT.md §2) | pass | `mysqldump --skip-ssl` + `storage/` tar + `.env` from the upgraded host restored onto the wiped empty host: the native app's `private/config.json` digest is identical before and after, the ORIGINAL account and ids work, hosted read/write work. (`GET /api/health/deep` requires an authenticated token; the guide should say so.) |
| 5a. Two editors, one draft version | pass | Two sessions read version 1; A saves (→ 2); B saves with expectedVersion 1 → **409 "The project changed. Reload before importing."**, stored file is A's; B retries with the reloaded version → 200 (→ 3). Owner project document keys are `home, version, updatedAt, files, assets, access` only: no records, no host configuration. |
| 5b. Browser round trip (import → Builder → ack → Studio → reload → publish → run → export → reimport) | not run | Needs Playwright against the container with the e2e fixtures (`E2E_BASE_URL`, seeded accounts) plus the hosted editors' iframe flow; the server-side version check above is what protects the race. Remains the open item the lane map already lists. |
| 6. Standalone fetcher tests | pass | `node --test scripts/fetch-softn-release.test.mjs`: 22 tests, 22 pass (run against the working tree, where another stream had uncommitted edits to the script and its test). |

## Observations (no source changed by this lane)

1. **Windows-built package lacks unix mode bits.** `scripts/package-dist.mjs` falls back to PowerShell `Compress-Archive` when `zip` is absent; the resulting entries carry external attributes 0 (the CI-built 0.1.5 zip carries `100755` on the sandbox binary). `INSTALL.txt`'s `chmod +x` step covers it and `unzip` only warns about the MS-DOS header, but a Windows-built zip should not be published as a release: CI builds on Linux.
2. **`formlogic/README.md` still describes the sibling-checkout runtime build** (lines 14, 52, 130, 551: "With `softn.com` checked out next to `formlogic.com`…"), while the root `README.md`, `DEPLOYMENT.md` and `docs/ecosystem/SOFTN_RELEASE.md` describe the release fetch. Documentation drift only.
3. **Hosted-request failures give the developer no reason.** A handler that used `softn.time` without declaring the `time` capability answered `{"error":"The request could not be completed.","code":"host_error"}` and nothing under `api/storage/native-apps/<app>/` or `api/logs/` recorded why. The behaviour is correct (capability gating), the diagnosability is not: an owner-visible reason (or a per-app log line) would save a support round.
4. **`mysqldump` from Debian's MariaDB client refuses MySQL 8's self-signed TLS** ("TLS/SSL error: self-signed certificate in certificate chain") unless `--skip-ssl` is passed; `UPGRADING.md`/`DEPLOYMENT.md` examples assume the Oracle client. One sentence in the guides would help operators.
5. `GET /api/health/deep` needs an authenticated token; `DEPLOYMENT.md` §2 lists it as a plain restore check.
6. Attachment uploads refuse `text/plain` ("File type not allowed") by default; image/png works. Expected allowlist behaviour, noted because the lane first tried a text file.

## Reproduce

Scripts in `lab/` (lab-only credentials, throwaway containers): `Dockerfile` (host image), `container-install.sh`
(INSTALL.txt manual steps), `container-upgrade.sh` (UPGRADING.md steps, with `--interrupt-after`), `journey.mjs`
(fresh / verify / nonode phases), `attach.mjs`, `backup.mjs`, `twoeditors.mjs`, `zipcheck.py`. Containers were named
`fl016s4-*` on network `fl016s4-net`, ports 18080–18083, and removed afterwards.
