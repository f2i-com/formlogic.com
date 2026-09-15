# Upgrading an existing FormLogic install

How to move a deployed FormLogic instance (an existing client install) to a new release **without
losing data**. For first-time setup see the [developer guide](../formlogic/README.md); for the
production checklist, full backup/restore detail, and health checks see
[DEPLOYMENT.md](../DEPLOYMENT.md).

## The easiest path: the admin panel

A platform administrator can update from **Admin → Updates → Check for updates**.
FormLogic checks the latest published stable release in `f2i-com/formlogic.com` and shows its
version, size and release-notes link. Choose **Download and verify**, review the staged version,
then choose **Install** and confirm. Downloading alone never changes the running installation.

No GitHub token or release-signing key is required for this official online update path. The wizard:

1. downloads the built release ZIP over HTTPS from the fixed official repository, verifies its
   size and SHA-256 against GitHub's release metadata, and checks its complete file manifest.
   Before applying, it re-fetches metadata for the **exact release and asset you reviewed**, hashes
   the retained ZIP again, and checks the extracted manifest against that original archive.
   A changed, unavailable or unverifiable release stops before maintenance or live-file changes;
2. closes the site for maintenance (a file flag, so it holds even mid-migration),
3. **exports the MySQL database and snapshots the current code automatically** into
   `api/storage/backups/<id>/`,
4. applies the new backend + UI files — `api/.env`, `api/storage/**` (per-form SQLite databases,
   uploads, packs), `api/logs/` and `.well-known/` are **never written**, by construction —
   and removes managed files the new release no longer ships (obsolete endpoints don't stay
   deployed; rollback likewise reconstructs the prior file inventory exactly). Applying is
   bound to the exact reviewed package (id + content digest) under a cross-process lock, and
   the immutable staged tree is fully re-verified immediately before any file is copied,
5. stamps the version and reopens; schema migrations run automatically on the next request.

If anything looks wrong afterwards, the same tab offers **one-click code rollback** from the
backup (the database is deliberately NOT auto-restored — records created since the upgrade are
kept; a separate, heavily-confirmed "Restore DB" exists for genuine corruption).

The manual paths below remain fully supported and are what the wizard automates.

## Official release requirements

The updater uses published stable `vX.Y.Z`/`X.Y.Z` releases and their built
`formlogic-X.Y.Z.zip` (or `formlogic-vX.Y.Z.zip`) asset. Source archives, drafts and prereleases
are not offered. A release needs exactly one matching ZIP, at most 512 MiB, with a GitHub
`sha256:` asset digest. Older assets without a digest must be uploaded again by the publisher.
Expanded packages are limited to 2 GiB and 50,000 entries.

The server needs outbound HTTPS and PHP curl and zip extensions. Public GitHub API rate limits
apply; an unavailable API leaves the installation untouched and can be retried later. GitHub
repository access and HTTPS are the release-authenticity trust source for this path. Keep control
of the official repository and its release publishing permissions.

An older installation without this GitHub update screen needs a one-time manual upgrade using
the steps below, or a signed ZIP accepted by its existing updater. After that, use the online flow.

## Building and publishing releases

The Package workflow remains manual and **needs no signing secrets**. It checks PHP 8.2 compatibility
as well as the main PHP 8.3 suite, and builds the hosted runtime from the exact Softn commit in
[prepare-hosted-runtime](../.github/actions/prepare-hosted-runtime/action.yml). The packager verifies
its complete inventory, JavaScript and matching ZIPP binary, including with `--skip-ui-build`.
Development source maps are excluded.

Run `node scripts/package-dist.mjs` locally, or dispatch Package for a release tag. The workflow
uploads the ZIP, compares GitHub's reported asset digest and size against the local ZIP, and then
publishes a new draft release. Branch runs produce a workflow artifact only, which is not yet
trusted by the online updater. Compatible Softn and ZIPP versions stay pinned inside each release.

## Optional signed uploads and offline upgrades

**Upload a signed package instead** remains available for offline/custom distributions. This path
requires an Ed25519 `manifest.sig.json` verified against `UPGRADE_RELEASE_PUBKEY` in the server's
`api/.env`, as well as the complete file inventory. Arbitrary unsigned uploads are refused in
production. The development-only `UPGRADE_ALLOW_UNSIGNED=true` override remains ignored in production.

For signed builds, set `FORMLOGIC_RELEASE_SIGNING_KEY` to a private PEM **file path** locally, or
`FORMLOGIC_RELEASE_SIGNING_KEY_PEM` to its PEM contents; do not set both. Use
`node scripts/package-dist.mjs --require-signature` when an offline package must be signed.
Invalid supplied keys fail the build; the packager never silently drops a configured signature.

Optional GitHub Actions configuration:

- Secret `FORMLOGIC_RELEASE_SIGNING_KEY`: private Ed25519 PEM contents.
- Variable `FORMLOGIC_RELEASE_PUBLIC_KEY`: matching base64 raw public key, to check the intended pin.

The private PEM is loaded in memory and removed from the packager environment before npm/Composer
run. It is not written into the release or logs. Signatures are self-verified before ZIP creation.
Use an existing trusted key for installed servers. For a new trust setup,
`node scripts/generate-release-key.mjs` generates a keypair; keep its private key outside Git.

## Verification commands

`node --test scripts/release-signing.test.mjs` checks optional signing, explicit offline signing,
runtime inventory and installer behavior, including interoperability with the real PHP verifier.
PHP with Sodium must be on PATH. Backend `GitHubReleaseServiceTest` and `AdminPanelTest` exercise
official release selection, reviewed asset binding, checksum checks, backup and rollback using local
fixtures; no test installs a remote release over the development checkout.

## The deployed layout

A FormLogic release zip is laid out for a single web root (this is the layout the shipped
`.htaccess` routes — the UI at the root, the whole backend under `api/`):

```
<web-root>/
  index.html, assets/, .htaccess, ...   <- the built UI
  api/                                  <- the PHP backend (front controller: api/public/index.php)
    .env                                <- YOUR configuration + secrets  (never replaced on upgrade)
    storage/                            <- YOUR data: per-form SQLite, uploads, packs (never replaced)
    bin/upgrade.php                     <- the upgrade CLI described below
    VERSION                             <- version string of the shipped release
  VERSION                               <- same version string, at the zip root
  install.php                           <- browser install/upgrade wizard (delete after use)
  INSTALL.txt / UPGRADE.txt             <- condensed fresh-install / upgrade steps
```

## How schema upgrades work

There is **no separate migrations folder to run**. The app carries its whole schema lifecycle in
code (`MySQLConnection::initializeSchema()` + `runMigrations()`), and every step is guarded and
idempotent (`CREATE TABLE IF NOT EXISTS`, `SHOW COLUMNS`/`SHOW INDEX` before each `ALTER`). Three
ways to apply it:

1. **Automatic** — the web app runs the same schema bootstrap on startup, so the *first request*
   after the new files land migrates the database by itself. Fine for small installs.
2. **The CLI (`api/bin/upgrade.php`) — preferred**, especially for larger installs: it runs the
   migrations *deliberately, before traffic hits the new code*, with step logging and an exit code —
   instead of paying the migration cost inside a live web request (PHP-FPM time limits, no
   visibility, a slow first request on big tables). It also verifies the core tables afterwards and
   stamps a `schema_meta` table (`app_version`, `last_upgrade_at`, `upgrade_source`) so the install
   records what it was upgraded to. It is idempotent — running it twice is safe.
3. **The wizard (`install.php` at the web root, shipped in every release zip)** — for operators
   without shell access: it detects the existing install (configured `api/.env` + core tables in
   the database) and offers **"Upgrade existing installation"**, which runs the exact same
   `initializeSchema()` + `runMigrations()` path, verifies the core tables, and stamps
   `schema_meta` with `upgrade_source=installer` (version from the shipped `api/VERSION`). It
   also re-checks file permissions and the execute bit on the Linux sandbox launcher. Once installed the wizard
   locks itself: temporarily add `SetEnv INSTALL_ENABLE 1` at the top of the web-root `.htaccess`
   to allow the run, then remove the line and delete `install.php`.

## Upgrade steps

### 1. Back up first

Non-negotiable. A FormLogic backup is the **database plus the on-disk data** (see
[DEPLOYMENT.md §2](../DEPLOYMENT.md#2-backup--restore) for the full detail):

```bash
mysqldump -u USER -p formlogic | gzip > backups/db-$(date +%F).sql.gz
tar czf backups/storage-$(date +%F).tar.gz -C <web-root>/api storage
cp <web-root>/api/.env backups/env-$(date +%F)     # secrets — store securely
```

### 2. Replace the files — except `api/.env` and `api/storage/`

Unpack the new release zip over the web root, replacing everything **except**:

- `api/.env` — your configuration and secrets (the release ships `api/.env.example` for reference;
  compare it against your `.env` for any new settings)
- `api/storage/` — your data: per-form SQLite response databases, uploads, pack archives

Everything else (the UI at the root, `api/src`, `api/vendor`, `api/public`, `api/bin`, …) should be
replaced wholesale. If you're cautious, move the old files aside rather than deleting them until
the upgrade is verified.

### 3. Run the upgrade CLI

```bash
php <web-root>/api/bin/upgrade.php --app-version=<new version>
```

Without `--app-version` it falls back to the shipped `api/VERSION` file (else stamps `unknown` —
though `unknown` never overwrites a previously stamped real version). Expected output ends with:

```
[...] Schema ensured (base tables present).
[...] Migrations applied (every step is guarded — already-applied steps are no-ops).
[...] Core tables verified: 8/8 present (users, forms, apps, app_forms, app_users, app_submission_idempotency, app_domains, rate_limits).
[...] schema_meta stamped: app_version=<v> (...), last_upgrade_at=<utc> UTC, upgrade_source=cli.
[...] Upgrade complete. Running this command again is safe (idempotent).
```

If you skip this step, the app still migrates itself on the first request — the CLI is just the
observable, pre-traffic way to do the same thing.

### 4. Verify

```bash
php <web-root>/api/bin/upgrade.php --check     # read-only drift report; writes nothing; exit 0 = good
curl -fsS https://your-domain/api/health       # public heartbeat: {"status":"ok",...}
```

`--check` lists every core table plus a set of recently-migrated columns/indexes and the
`schema_meta` stamp. For a deeper post-upgrade diagnosis, `GET /api/health/deep` (authenticated)
runs the full Doctor checks — see [DEPLOYMENT.md §5](../DEPLOYMENT.md#5-health--diagnostics).

### 5. Rollback (if needed)

Restore the backup from step 1: the old files, the MySQL dump, `api/.env`, and `api/storage/`
together (MySQL rows point at SQLite files on disk — restore both sides or you get orphaned
responses). Migrations are additive/guarded, so a database that was migrated forward generally
still works with the previous release's code, but restoring the DB dump alongside the old files is
the clean, supported rollback.

## CLI reference — `api/bin/upgrade.php`

| Invocation | What it does |
|---|---|
| `php api/bin/upgrade.php --app-version=<v>` | Ensure schema + run all migrations, verify core tables, stamp `schema_meta` with `<v>` |
| `php api/bin/upgrade.php` | Same, version taken from the `api/VERSION` file (else `unknown`, which never overwrites a real stamp) |
| `php api/bin/upgrade.php --check` | **Read-only**: report which core tables / recently-migrated columns/indexes exist. Writes nothing |
| `php api/bin/upgrade.php --help` | Usage |

Exit codes: `0` success / check passed · `1` drift found or post-migration verification failed ·
`2` bad arguments, config error, or database unreachable (the error message names the host/database
it tried and points at `api/.env`).

The CLI reads the same `.env` + `config/settings.php` the app uses, so no extra configuration is
needed — if the app can reach the database, so can the CLI.

## Notes

- **Source checkout instead of a release zip?** The backend lives at `formlogic/backend`, so the
  same command is `php formlogic/backend/bin/upgrade.php --check`. After pulling new code, also
  run `composer install` in `formlogic/backend` and rebuild the UI (`cd formlogic/ui && npm
  ci && node ../../scripts/fetch-softn-release.mjs && npm run build`) — the release zip ships both pre-built.
- **Idempotent by design**: every schema step is guarded, so re-running the CLI (or letting the web
  app re-run the same migrations) never double-applies anything.
- `schema_meta` is only stamped by deliberate upgrades — `upgrade_source=cli` (this CLI) or
  `upgrade_source=installer` (the wizard's upgrade mode); an install that has only ever
  auto-migrated via the web app won't have it — `--check` reports that informationally, not as
  drift.
