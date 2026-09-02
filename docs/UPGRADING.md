# Upgrading an existing FormLogic install

How to move a deployed FormLogic instance (an existing client install) to a new release **without
losing data**. For first-time setup see the [developer guide](../formlogic/README.md); for the
production checklist, full backup/restore detail, and health checks see
[DEPLOYMENT.md](../DEPLOYMENT.md).

## The easiest path: the admin panel

A platform administrator (an account with the durable `users.is_admin=1` flag) can upgrade
entirely from the browser: **Admin → Upgrade → upload the release zip**
(the same `formlogic-vX.Y.Z.zip` the CI attaches to each GitHub release). The wizard then:

1. verifies the package's **signed release envelope**: `manifest.sig.json` is an Ed25519
   signature over the exact `manifest.json` bytes by the release key your install pins via
   `UPGRADE_RELEASE_PUBKEY` in `api/.env`. Every listed file is sha256-checked after
   extraction, the inventory must cover **every** file in the package (an unlisted file is a
   refusal), and unsigned/foreign-signed packages are refused. Production installs never
   accept unsigned packages; a development install may set `UPGRADE_ALLOW_UNSIGNED=true`
   (the override is ignored when `APP_ENV=production`). Release engineers: generate the
   keypair with `node scripts/generate-release-key.mjs` and give the packager the PEM via
   `FORMLOGIC_RELEASE_SIGNING_KEY`;
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
  ci && npm run build`) — the release zip ships both pre-built.
- **Idempotent by design**: every schema step is guarded, so re-running the CLI (or letting the web
  app re-run the same migrations) never double-applies anything.
- `schema_meta` is only stamped by deliberate upgrades — `upgrade_source=cli` (this CLI) or
  `upgrade_source=installer` (the wizard's upgrade mode); an install that has only ever
  auto-migrated via the web app won't have it — `--check` reports that informationally, not as
  drift.
