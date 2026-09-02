# Deploying FormLogic to production

This guide covers the production launch checklist, backups, the webhook worker, and the
health/diagnostics endpoint. For first-time setup see the installer in
[`formlogic/install.php`](formlogic/README.md) or the manual steps in the README.
**Upgrading an existing install to a new release?** Follow [docs/UPGRADING.md](docs/UPGRADING.md) —
back up, replace files (keep `api/.env` + `api/storage/`), then run the `api/bin/upgrade.php` migration CLI.

> FormLogic runs the same codebase self-hosted (no limits) or as a hosted multi-tenant
> service (with plan limits). The hosted-only bits below are clearly marked.

---

## 1. Production launch checklist

Work top to bottom before exposing the app publicly. Most of these live in
`formlogic/backend/.env`.

**App & secrets**
- [ ] `APP_ENV=production`
- [ ] `APP_DEBUG=false`
- [ ] `JWT_SECRET` set to a strong, unique 32+ char value (`openssl rand -base64 32`)
- [ ] `AUDIT_HMAC_KEY` set to a strong, unique value
- [ ] `DB_PASSWORD` set to a strong value (the app refuses to boot in production with the
      default `password`)

**Web / transport**
- [ ] Served over **HTTPS** (auth cookies are `Secure` in production and won't be sent over HTTP)
- [ ] `COOKIE_DOMAIN` correct for your domain (e.g. `.example.com`), or empty for current-domain-only
- [ ] `CORS_ORIGIN` = your exact production frontend origin
- [ ] `CORS_ALLOWED_ORIGINS` contains only real origins (no leftover `localhost`/staging)
- [ ] `TRUSTED_PROXIES` set if behind a reverse proxy/load balancer (for correct client IPs)
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
- [ ] `MAIL_FROM_ADDRESS` (+ SMTP_* if using SMTP) set, and a test email sent (password reset / invite)

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
- [ ] If enforcing plans, `CLOUD_PLAN_ENFORCED=true` (requires PayPal configured — the app
      refuses to boot otherwise) and `CLOUD_MAX_FORMS` / `CLOUD_MAX_STORAGE_BYTES` reviewed

**Operations**
- [ ] Webhook retry worker scheduled (§3)
- [ ] Backups configured (§2)
- [ ] `GET /api/health/deep` returns `status: ok` (§5)
- [ ] Dependency audits clean: `composer audit` (backend), `npm audit` (ui)

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
cp formlogic/backend/.env backups/env-$(date +%F)   # keep this somewhere safe
```

**Restore:**
1. Restore the MySQL dump into an empty database.
2. Restore the `storage/` directories with the **same paths and permissions** (dirs `0700`).
3. Restore `.env` (the `AUDIT_HMAC_KEY` must match the original or audit-chain verification fails).
4. Run `GET /api/health/deep` and confirm `status: ok`.

> Keep MySQL and `storage/` backups in sync — a form row in MySQL points at a SQLite file on
> disk, so restoring one without the other leaves orphaned/missing responses.

---

## 3. Webhook retry worker

Failed webhook deliveries are retried with exponential backoff (1m, 5m, 30m, 2h, 6h, up to 5
attempts). SSRF guards are re-applied at send time, so deferred retries are safe. Schedule the
worker so retries actually fire:

```cron
# once a minute
* * * * * php /path/to/formlogic/backend/bin/webhook-worker.php >> /var/log/formlogic-webhooks.log 2>&1
```

On hosts without cron, run it continuously (sleeps 60s between passes):

```bash
php formlogic/backend/bin/webhook-worker.php --loop
```

If the worker isn't running, initial (synchronous) deliveries still happen, but failed ones
are never retried.

Each run records a heartbeat, so `GET /api/health/deep` (and the Doctor view) report the
`webhook_worker` check as `last run ~Nm ago`, with a warning if it has never run or is stale
(>15 min) — an easy way to catch a missing/broken cron.

---

## 4. PayPal go-live (hosted billing only)

Cloud billing is pay-as-you-go via PayPal (one-time captures, no subscription). Configure it
in `.env` and **test in sandbox before going live**:

- [ ] `PAYPAL_CLIENT_ID` / `PAYPAL_SECRET` — REST app credentials from developer.paypal.com
- [ ] `PAYPAL_WEBHOOK_ID` — from the app's webhook config; register the webhook URL
      `https://YOUR_API_HOST/api/billing/webhook/paypal` in the PayPal dashboard
- [ ] Keep `PAYPAL_ENV=sandbox` and run one full sandbox payment end-to-end:
  - [ ] a successful $5 capture credits exactly 30 days
  - [ ] buying again stacks (does not overwrite the expiry)
  - [ ] a declined payment does not credit
  - [ ] a pending/eCheck payment shows "processing" and credits once it clears (webhook)
  - [ ] re-submitting an order does not double-credit
- [ ] Only then set `PAYPAL_ENV=live` with live credentials and repeat a real $5 test

Without credentials the `/billing` page degrades to "not configured" and no charges occur.

---

## 5. Health & diagnostics

- `GET /api/health` — public heartbeat (`{status, timestamp}`); use it for uptime/load-balancer checks.
- `GET /api/health/deep` — **authenticated** "Doctor": checks DB connectivity, writable
  `storage/`+`logs/` dirs, the sandbox runtime (`bin/runtime/` launcher + prelude), billing config
  (critical only when plan enforcement is on; warns on sandbox / missing webhook id), the
  document-conversion tools (`pdftoppm`, `ghostscript`, `libreoffice`), the webhook retry-worker
  heartbeat, and dual-store file drift. Returns `200` when all critical checks pass, `503`
  otherwise. Run it after every deploy/restore.

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
