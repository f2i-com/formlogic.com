# FormLogic Release Runbook

The single "before you push the button" page. This is the checklist; **[DEPLOYMENT.md](../DEPLOYMENT.md)**
has the detailed procedures (secrets, HTTPS, backups, webhook worker, PayPal, restore) and
**[LAUNCH_CHECKLIST.md](../LAUNCH_CHECKLIST.md)** tracks the open launch items. Do these in order.
Anything unchecked is a launch blocker.

## 0. Gate — CI must be green

- [ ] `ci` workflow green on the release commit (PHPUnit + tsc + eslint + build).
- [ ] **`E2E (Playwright) — release gate` workflow green** on the release commit/tag (run it from the
      Actions tab or by pushing the `v*` tag). What it **automates today**: auth login/logout;
      build → publish → submit-public → view; required validation; hidden-field authority; field-aware
      upload rejection; `onSubmit` reject/computed write. RBAC/CSP/file-RBAC boundaries are covered by
      unit/integration tests (`AppRbacTest`, `AppMemberFilterTest`, `FileAccessRbacTest`,
      `check-security-invariants.mjs`) in the fast `ci` workflow.
- [ ] **Manual smoke** the product-differentiator flows that are NOT yet automated (see §4 and the
      "Golden-path coverage" list in LAUNCH_CHECKLIST.md): pack install → dashboard, submit → dashboard
      updates, export/import, live-demo isolation, billing-disabled/self-host, MCP token flow. These are
      tracked follow-up specs — until they land, they are a **manual** gate, not an automated one.
- [ ] Dependency audits clean: `cd formlogic/backend && composer audit` and
      `cd formlogic/ui && npm audit --audit-level=high`. Triage anything flagged.

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
      `cd formlogic/ui && node scripts/emit-marketplace.mjs` →
      `cd formlogic/backend && php bin/provision-demo.php`.
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

- [ ] Sign up → log in → log out. (There is no email-verification step: registration creates the
      account and signs in immediately. Email delivery is exercised via password-reset / invite in §2.)
- [ ] Install a marketplace pack → open the app → dashboard renders populated widgets.
- [ ] Submit a record → dashboard/list/report updates.
- [ ] Public **Live Demo** starts, is read-only server-side, and browser-local changes don't pollute
      the shared demo.
- [ ] AI disabled/misconfigured state renders safely (no crash, clear "bring your own AI" path).
- [ ] Billing disabled/self-host state renders safely.
- [ ] **Dashboard perf**: run `node formlogic/ui/scripts/perf-demo-dashboards.mjs` against
      staging/prod (set `APP_BASE`/`API_BASE`) and **paste the output** (first-chart paint per demo
      app) into the release issue. Investigate anything over the threshold.

## 5. Post-launch monitoring

- [ ] Watch `backend/logs` (or your log sink) for 5xx / auth / webhook failures for the first hours.
- [ ] `GET /api/health/deep` on a schedule / uptime monitor.
- [ ] Webhook worker heartbeat monitored.
- [ ] A visible feedback channel is live (this is a beta — invite reports).

---

Launch posture: ship with a **beta** label, backups + this runbook ready, demo polished, and a very
visible feedback channel — not "quietly ship and pray."
