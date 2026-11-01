# Deploying FormLogic to production

This guide covers the production launch checklist, backups, the webhook worker, and the
health/diagnostics endpoint. For first-time setup see the installer in
[`formlogic/install.php`](formlogic/README.md) or the manual steps in the README.
**Upgrading an existing install to a new release?** Follow [docs/UPGRADING.md](docs/UPGRADING.md) —
back up, replace files (keep `api/.env` + `api/storage/`), then run the `api/bin/upgrade.php` migration CLI.

> FormLogic runs the same codebase self-hosted or as a hosted multi-tenant service. Neither has
> plan limits at present (see Billing below). The hosted-only bits below are clearly marked.

---

## Native apps and embedded editors

A source deployment must install the browser runtime and editors before the UI build.
From `formlogic/ui`, run:

```sh
node ../../scripts/fetch-softn-release.mjs
npm run build
```

The first command takes the latest Softn release's `softn-formlogic-runtime-<tag>.zip`,
verifies it and installs the hosted runtime, the embedded editors and the native backend
runtime (`SOFTN_RELEASE=<tag>` picks one release). Deploy the generated `hosted-runtime/`
and `app-editors/` assets with the UI, and the installed `backend/resources/softn-native/`
modules with the API. The release preparation action installs these the same way for
packaged releases. Native backend execution requires PHP 8.2+, PDO SQLite and
`proc_open`. With a Softn release from v0.0.26 on Linux or Windows x86-64 that is all: the
release carries `softn-runner` (`resources/softn-native/bin/`), which runs native apps without
Node. Otherwise (an older release, another platform, or `FORMLOGIC_NATIVE_RUNNER=node`) it also
needs a compatible Node runtime (use the repository's pinned version); configure
`FORMLOGIC_NODE_BIN` for the PHP worker environment. Updating an installed native app also
needs the `sqlite3` PHP extension, which restores its database if the update fails
([details](docs/NATIVE_ROLLBACK_SAFETY.md)). OAIY is a separate optional desktop host.

The server sandbox launcher (`backend/bin/runtime/`, which runs form logic and scripts) is
not in git either. The release zip ships it for both platforms; a source deployment builds it
from the source of the ZIPP release the installed Softn release names with
`scripts/build-runtime.sh all` (needs Rust; see `formlogic/runtime/README.md`), or installs a
CI build. Without it the API still serves, but form logic fails open.

Back up `backend/storage/native-apps/`, including private configuration and SQLite-consistent
database snapshots. These records are not included in ordinary form exports. Schedule
`php bin/native-record-dispatch.php` from the backend directory to retry committed database
events after interrupted delivery. An execution runtime must still process the queued flows.
See [native hosting operations](docs/HOSTED_APPS.md#preparing-the-optional-native-runtime).

## 1. Production launch checklist

Work top to bottom before exposing the app publicly. Most of these live in
`formlogic/backend/.env`.

**App & secrets**
- [ ] `APP_ENV=production`
- [ ] `APP_DEBUG=false`
- [ ] `JWT_SECRET` set to a strong, unique 32+ char value (`openssl rand -base64 32`)
- [ ] `AUDIT_HMAC_KEY` set to a strong, unique value
- [ ] `DATA_ENCRYPTION_KEY` set, and **a copy kept away from this server**: without it, what it
      encrypted can never be read (see `docs/DATA_ENCRYPTION.md`)
- [ ] Nightly backups sealed with `BACKUP_PUBLIC_KEY`, and the secret key kept off this server
- [ ] `DB_PASSWORD` set to a strong value (the app refuses to boot in production with the
      default `password`)

**Web / transport**
- [ ] Served over **HTTPS** (auth cookies are `Secure` in production and won't be sent over HTTP)
- [ ] `COOKIE_DOMAIN` correct for your domain (e.g. `.example.com`), or empty for current-domain-only
- [ ] `CORS_ORIGIN` = your exact production frontend origin
- [ ] `CORS_ALLOWED_ORIGINS` contains only real origins (no leftover `localhost`/staging)
- [ ] `TRUSTED_PROXIES` set if behind a reverse proxy/load balancer (for correct client IPs)
- [ ] `TRUSTED_PROXY_HEADER` set with it, to the one header the proxy writes the client address into
      (`x-forwarded-for`, `x-real-ip` or `client-ip`). Clients can send any of these and a proxy passes
      on the ones it does not set, so unset (the order X-Forwarded-For, X-Real-IP, Client-IP), a client
      behind a proxy that sets only X-Real-IP can choose its own address for the rate limits
- [ ] Request-size layers are aligned: ordinary API JSON is capped at 2 MiB by the app; with
      the default 200 MiB backup setting, use a 220 MiB proxy/PHP request ceiling
      (`client_max_body_size 220m`, `post_max_size=220M`, `upload_max_filesize=200M`). Do not
      grant that ceiling to another virtual host. FormLogic grants it only to the exact
      authenticated backup/upgrade multipart routes; packs and ordinary uploads have smaller caps.
      If `BACKUP_MAX_ZIP_SIZE` changes, adjust all three ceilings together with 16 MiB of multipart
      overhead.

**Installer & files**
- [ ] **Delete `formlogic/install.php`** (it hard-disables itself once installed, but delete it anyway)
- [ ] `formlogic/backend/storage/` and `logs/` are **not** web-readable (serve only `public/`)
- [ ] `formlogic/backend/.env` is not web-readable

**Email (optional but recommended)**
- [ ] `MAIL_FROM_ADDRESS` (+ SMTP_* if using SMTP) set, and a test email sent (password reset / invite).
      A release includes `symfony/mailer`, which SMTP needs. A source checkout gets it from
      `composer install`. Without `SMTP_HOST`, mail goes through PHP `mail()`.
- [ ] After that test, Doctor's `email` check shows no failed mail. Password resets, invitations and
      new-response notifications go out after the visitor has their answer, and each step with the
      mail server may take 5 seconds. A mail that can't be sent isn't retried: it goes in the audit
      log as `mail.failed`, and Doctor reports the last 7 days' with the reason. The answer ends early
      on PHP-FPM, LiteSpeed and mod_php. Plain FastCGI (mod_fcgid) holds a short answer until PHP
      exits, so there the visitor waits for the send, and a forgot-password request takes longer for
      an address with an account. Doctor says so if this site runs that way: use PHP-FPM if you can.

**AI (optional)**
- [ ] AI uses any OpenAI-compatible API via `AI_BASE_URL` (LM Studio / Ollama / vLLM / self-hosted /
      OpenAI). `AI_API_KEY` is optional — blank for a keyless local server; set it only if required.
      Enabled when a key is set **or** `AI_BASE_URL` points at a non-OpenAI endpoint. Legacy
      `OPENAI_*` names still work. `GET /api/health/deep` → `ai` shows the resolved status.
- [ ] If sending a KEY to cloud AI, `AI_BASE_URL` is `https://…` (in production a key is never sent
      over plaintext `http://`; a keyed loopback model needs `ALLOW_INSECURE_LOCAL_AI=1`; a keyless
      local server over `http` is always fine)

**Billing & plans (hosted SaaS only)**
- [ ] See the PayPal go-live checklist in §4
- Plan limits are off in this release, whatever `.env` says: `CLOUD_PLAN_ENFORCED` is not read, so
  `CLOUD_MAX_FORMS` and `CLOUD_MAX_STORAGE_BYTES` limit nothing. Whether they return is an open
  product decision.

**Operations**
- [ ] Scheduled jobs set up (§3), including the nightly `backup-accounts.php`
- [ ] Backups configured (§2)
- [ ] `GET /api/health/deep` (as a platform admin) returns `status: ok` (§5)
- [ ] Dependency audits clean: `composer audit` (backend), `npm audit` (ui)
- [ ] Behind a CDN such as Cloudflare, nothing caches `sw.js`, `registerSW.js` or `index.html`: the
      site sends them `Cache-Control: no-cache`, so a cache rule is the only thing that can undo
      it. A CDN holding `sw.js` keeps returning visitors on the old release's page after an update,
      and that page can fail against the new server. An administrator's two-factor setup answers
      "out of date" or "Incorrect password" without asking for a password. Purge those addresses
      and reload.

---

## 2. Backup & restore

FormLogic stores data in **MySQL** (accounts, forms, apps, payments, audit) **and** in
per-form **SQLite** files plus uploaded files on disk. A backup is *not* just a MySQL dump.

**Back up all of:**
- MySQL database (`mysqldump formlogic > formlogic.sql`)
- `formlogic/backend/storage/forms/` — per-form SQLite response databases
- `formlogic/backend/storage/uploads/` — uploaded files
- `formlogic/backend/storage/packs/` — pack archives
- `formlogic/backend/.env` — secrets (store securely/separately)

Example:

```bash
mysqldump -u USER -p formlogic | gzip > backups/db-$(date +%F).sql.gz
tar czf backups/storage-$(date +%F).tar.gz -C formlogic/backend storage
cp formlogic/backend/.env backups/env-$(date +%F)   # keep this somewhere safe, and NOT with the backups above
```

Stop the site for this `tar`. The SQLite databases keep recent writes in a `-wal` file beside
them, and a copy of the two made while the site runs can miss records or be damaged. On a live
site use `bin/backup-accounts.php`, which takes a consistent snapshot of each database.

**Restore:**
1. Restore the MySQL dump into an empty database.
2. Restore the `storage/` directories with the **same paths and permissions** (dirs `0700`).
3. Restore `.env` (the `AUDIT_HMAC_KEY` must match the original or audit-chain verification fails, and `DATA_ENCRYPTION_KEY` must be the original or what it encrypted can't be read).
4. Sign in as a platform admin and run `GET /api/health/deep` with that session's token (the deep check needs an authenticated platform-admin session; the unauthenticated `GET /api/health` only says the API is up) and confirm `status: ok`.

> Keep MySQL and `storage/` backups in sync — a form row in MySQL points at a SQLite file on
> disk, so restoring one without the other leaves orphaned/missing responses.

---

## 3. Webhook retry worker

A failed webhook delivery is retried 5 times, waiting 1m, 5m, 30m, 2h and 6h between tries. That is
about 8½ hours in all, and a delivery still failing after that is marked `exhausted`. A permanent
refusal, such as a 404, is not retried. SSRF guards are re-applied at send time, so deferred retries
are safe. Schedule the worker so retries actually fire:

```cron
# once a minute
* * * * * php /path/to/formlogic/backend/bin/webhook-worker.php >> /path/to/formlogic/backend/logs/formlogic-webhooks.log 2>&1
```

On hosts without cron, run it continuously (sleeps 60s between passes). A pass that fails is tried
again on the next one, but the worker stops with exit code 1 if it loses its database connection or
fails three passes in a row, so run it under something that starts it again: a systemd service with
`Restart=always`, or a shell loop:

```bash
while true; do php formlogic/backend/bin/webhook-worker.php --loop; sleep 60; done
```

If the worker isn't running, initial (synchronous) deliveries still happen, but failed ones
are never retried.

Each run records a heartbeat, so `GET /api/health/deep` (and the Doctor view) report the
`webhook_worker` check as `last run ~Nm ago`, with a warning if it has never run or is stale
(>15 min) — an easy way to catch a missing/broken cron.

### Every scheduled job

The install wizard and `INSTALL.txt` print the same list. `backup-accounts.php` also purges the
recycle bin, clears abandoned uploads, applies each form's record retention and prunes the webhook
log, so none of that happens without it. It does these after a backup that failed too, and exits
non-zero at the end. If another backup is running it only prunes the webhook log, because the others
delete files that backup may be reading: a run started by this job does them when it finishes, and
after one started from the admin panel they wait for the next night.

```cron
* * * * *      php /path/to/backend/bin/webhook-worker.php >> /path/to/backend/logs/formlogic-webhooks.log 2>&1
* * * * *      php /path/to/backend/bin/native-record-dispatch.php >> /path/to/backend/logs/formlogic-native-records.log 2>&1
0-59/5 * * * * php /path/to/backend/bin/flow-runs-reclaim.php >> /path/to/backend/logs/formlogic-flow-runs-reclaim.log 2>&1
0-59/5 * * * * php /path/to/backend/bin/flow-outcome-dispatch.php >> /path/to/backend/logs/formlogic-flow-outcomes.log 2>&1
11 * * * *     php /path/to/backend/bin/artifact-sweep.php >> /path/to/backend/logs/formlogic-artifacts.log 2>&1
15 2 * * *     php /path/to/backend/bin/backup-accounts.php >> /path/to/backend/logs/formlogic-backup.log 2>&1
17 3 * * *     php /path/to/backend/bin/idempotency-cleanup.php >> /path/to/backend/logs/formlogic-idempotency.log 2>&1
23 3 * * *     php /path/to/backend/bin/desktop-commands-cleanup.php >> /path/to/backend/logs/formlogic-desktop-commands.log 2>&1
41 3 * * *     php /path/to/backend/bin/privacy-sweep.php >> /path/to/backend/logs/formlogic-privacy-sweep.log 2>&1
0 4 * * 1      php /path/to/backend/bin/reconcile.php >> /path/to/backend/logs/formlogic-reconcile.log 2>&1
```

The jobs that must not overlap hold a lock in `storage/locks`, or in the system's temp folder under
a name this install alone uses if the user running cron can't write there. They exit non-zero if
neither works. Run them as the web server's user, so that every run of a job shares one lock. It can
write to `logs/` as well. A job whose log it can't open never starts, so a log in `/var/log` won't do.
The wizard, the release zip and `install.sh` make `logs/`. git doesn't carry it, so on a checkout set
up by hand, create it first and give it to that user.

### Settings for these jobs

All optional, in `.env`:

| Setting | Default | What it does |
|---|---|---|
| `BACKUP_RETENTION_DAYS` | 7 | How many nightly backup folders to keep |
| `BACKUP_INCLUDE_FILES` | true | `false` leaves uploaded files out of nightly backups |
| `BACKUP_MAX_TOTAL_BYTES` | 1073741824 | Largest uncompressed total of an account backup zip uploaded for import |
| `BACKUP_MAX_RESPONSES_PER_FORM` | 200000 | Most records per form in an account backup zip uploaded for import |
| `TRASH_RETENTION_DAYS` | 30 | How long deleted forms, apps and flows stay in the recycle bin |
| `FLOW_RUN_STALE_SECONDS` | 600 | When `flow-runs-reclaim.php` ends a flow run that started and never finished |
| `DESKTOP_COMMANDS_RETENTION_DAYS` | 7 | When `desktop-commands-cleanup.php` removes finished desktop commands |
| `PRIVACY_SWEEP_RETENTION_DAYS` | 30 | When `privacy-sweep.php` clears the IP address kept with a private form's records |
| `DEMO_ENABLED` | true | `false` turns off the public no-signup demo |

---

## 4. PayPal go-live (hosted billing only)

Cloud billing is pay-as-you-go via PayPal (one-time captures, no subscription). Configure it
in `.env` and **test in sandbox before going live**:

- [ ] `PAYPAL_CLIENT_ID` / `PAYPAL_SECRET` — REST app credentials from developer.paypal.com
- [ ] `PAYPAL_WEBHOOK_ID` — from the app's webhook config; register the webhook URL
      `https://YOUR_API_HOST/api/billing/webhook/paypal` in the PayPal dashboard, subscribed to
      `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`,
      `PAYMENT.CAPTURE.DECLINED` and `PAYMENT.CAPTURE.DENIED` (without the refund and reversal
      events, a refunded payment keeps the time it bought)
- [ ] Keep `PAYPAL_ENV=sandbox` and run one full sandbox payment end-to-end:
  - [ ] a successful $5 capture credits exactly 30 days
  - [ ] buying again stacks (does not overwrite the expiry)
  - [ ] a declined payment does not credit
  - [ ] a pending/eCheck payment shows "processing" and credits once it clears (webhook)
  - [ ] re-submitting an order does not double-credit
  - [ ] a full refund takes back the time; a partial refund is audited as
        `billing.partial_refund` and leaves it
- [ ] Only then set `PAYPAL_ENV=live` with live credentials and repeat a real $5 test

Without credentials the `/billing` page degrades to "not configured" and no charges occur.

---

## 5. Health & diagnostics

- `GET /api/health` — public heartbeat (`{status, timestamp}`); use it for uptime/load-balancer checks.
- `GET /api/health/deep` — **authenticated** "Doctor": checks DB connectivity, writable
  `storage/`+`logs/` dirs, the sandbox runtime (`bin/runtime/` launcher, built not committed, + prelude), billing config
  (warns on sandbox / missing webhook id; never critical while plan limits are off), the
  document-conversion tools (`pdftoppm`, `ghostscript`, `libreoffice`), how email is sent and what
  couldn't be, the webhook retry-worker heartbeat, and dual-store file drift. Returns `200` when all
  critical checks pass, `503` otherwise. Run it after every deploy/restore.

> Rate limiting fails *open* if its table is unwritable (availability over strictness) — the
> Doctor's `writable:*` checks make that condition visible.

### Dual-store reconcile

MySQL (metadata) and the per-form SQLite files (responses) can drift after a partial failure.
`GET /api/health/deep` surfaces file-level drift cheaply; for a full report/repair run:

```bash
php formlogic/backend/bin/reconcile.php        # read-only report
php formlogic/backend/bin/reconcile.php --fix  # re-sync forms.response_count + drop orphaned response_links
```

Orphaned SQLite files / upload dirs are reported but never auto-deleted — remove them by hand after review.
