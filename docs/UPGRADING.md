# Upgrading an existing FormLogic install

How to move a deployed FormLogic instance (an existing client install) to a new release **without
losing data**. For first-time setup see the [developer guide](../form-builder/README.md); for the
production checklist, full backup/restore detail, and health checks see
[DEPLOYMENT.md](../DEPLOYMENT.md).

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
  INSTALL.txt / UPGRADE.txt             <- condensed fresh-install / upgrade steps
```

## How schema upgrades work

There is **no separate migrations folder to run**. The app carries its whole schema lifecycle in
code (`MySQLConnection::initializeSchema()` + `runMigrations()`), and every step is guarded and
idempotent (`CREATE TABLE IF NOT EXISTS`, `SHOW COLUMNS`/`SHOW INDEX` before each `ALTER`). Two ways
to apply it:

1. **Automatic** — the web app runs the same schema bootstrap on startup, so the *first request*
   after the new files land migrates the database by itself. Fine for small installs.
2. **The CLI (`api/bin/upgrade.php`) — preferred**, especially for larger installs: it runs the
   migrations *deliberately, before traffic hits the new code*, with step logging and an exit code —
   instead of paying the migration cost inside a live web request (PHP-FPM time limits, no
   visibility, a slow first request on big tables). It also verifies the core tables afterwards and
   stamps a `schema_meta` table (`app_version`, `last_upgrade_at`, `upgrade_source`) so the install
   records what it was upgraded to. It is idempotent — running it twice is safe.

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

- **Source checkout instead of a release zip?** The backend lives at `form-builder/backend`, so the
  same command is `php form-builder/backend/bin/upgrade.php --check`. After pulling new code, also
  run `composer install` in `form-builder/backend` and rebuild the UI (`cd form-builder/ui && npm
  ci && npm run build`) — the release zip ships both pre-built.
- **Idempotent by design**: every schema step is guarded, so re-running the CLI (or letting the web
  app re-run the same migrations) never double-applies anything.
- `schema_meta` is only stamped by this CLI (`upgrade_source=cli`); an install that has only ever
  auto-migrated via the web app won't have it — `--check` reports that informationally, not as
  drift.
