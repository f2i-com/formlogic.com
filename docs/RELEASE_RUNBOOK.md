# FormLogic Release Runbook

The single "before you push the button" page. This is the checklist; **[DEPLOYMENT.md](../DEPLOYMENT.md)**
has the detailed procedures (secrets, HTTPS, backups, webhook worker, PayPal, restore) and
**[LAUNCH_CHECKLIST.md](../LAUNCH_CHECKLIST.md)** tracks the open launch items. Do these in order.
Anything unchecked is a launch blocker.

## 0. Gate — CI must be green

- [ ] `ci` workflow green on the release commit (PHPUnit + tsc + eslint + build).
- [ ] **`release-e2e` workflow green** on the release commit/tag — the full launch golden paths
      (pack install → dashboard, app RBAC, file RBAC, export/import, demo isolation, billing-disabled,
      MCP, custom-screen CSP exfil). Run it manually from the Actions tab or by pushing the release tag.
- [ ] Dependency audits clean: `cd form-builder/backend && composer audit` and
      `cd form-builder/ui && npm audit --audit-level=high`. Triage anything flagged.

## 1. Environment & secrets

- [ ] `APP_ENV=production` in `backend/.env` (a missing/typo'd value defaults to production behaviour).
- [ ] `JWT_SECRET` ≥ 32 random chars; `AUDIT_HMAC_KEY` set; no default DB password. (Weak values
      fail hard on boot in production — that's expected.)
- [ ] HTTPS terminated (direct TLS or reverse proxy); port 80 → 443 redirect in place. Cookies are
      `Secure` in production and won't survive plain HTTP.
- [ ] Web server exposes only `ui/dist` and `backend/public` (`/api`). `backend/storage`,
      `backend/logs`, and `.env` are **not** web-reachable.
- [ ] `CORS_ORIGIN` matches the production frontend origin.
- [ ] AI: `AI_ENABLED` / `AI_BASE_URL` set intentionally (or intentionally disabled).
- [ ] Billing: `PAYPAL_ENV`/creds set for live, OR `CLOUD_PLAN_ENFORCED=false` for a self-host/free
      instance. If `CLOUD_PLAN_ENFORCED=true`, PayPal creds are required or the app refuses to boot.

## 2. Data & services

- [ ] Marketplace + demo seeded/refreshed:
      `cd form-builder/ui && node scripts/emit-marketplace.mjs` →
      `cd form-builder/backend && php scripts/provision-demo.php`.
- [ ] `GET /api/health/deep` returns healthy (DB, SQLite storage, writable dirs, migrations).
- [ ] Webhook retry worker cron is scheduled and its last-run heartbeat is recent (see DEPLOYMENT.md).
- [ ] Email verified: Doctor → **Email** check is green (or explicitly acknowledged as link-only).
      Send a test invite / password reset to yourself and confirm delivery. If SMTP is configured but
      `symfony/mailer` isn't installed, the check flags it — install it or fall back to link display.

## 3. Backups & rollback

- [ ] A fresh **backup** taken (MySQL dump + `backend/storage` per-form SQLite DBs + uploads).
- [ ] **Restore tested on staging** from that backup — don't assume; run it.
- [ ] Rollback path known: previous release tag/artifact identified; DB migrations are additive, but
      confirm you can redeploy the prior build and (if needed) restore the DB snapshot.

## 4. Smoke the launch-critical states (manually, in prod or a prod-like staging)

- [ ] Sign up → verify email → log in.
- [ ] Install a marketplace pack → open the app → dashboard renders populated widgets.
- [ ] Submit a record → dashboard/list/report updates.
- [ ] Public **Live Demo** starts, is read-only server-side, and browser-local changes don't pollute
      the shared demo.
- [ ] AI disabled/misconfigured state renders safely (no crash, clear "bring your own AI" path).
- [ ] Billing disabled/self-host state renders safely.

## 5. Post-launch monitoring

- [ ] Watch `backend/logs` (or your log sink) for 5xx / auth / webhook failures for the first hours.
- [ ] `GET /api/health/deep` on a schedule / uptime monitor.
- [ ] Webhook worker heartbeat monitored.
- [ ] A visible feedback channel is live (this is a beta — invite reports).

---

Launch posture: ship with a **beta** label, backups + this runbook ready, demo polished, and a very
visible feedback channel — not "quietly ship and pray."
