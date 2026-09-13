# E2E tests (Playwright)

Launch-critical golden paths + feature specs. They run against the **live stack** (the WAMP-served
app at `formlogic.local` + the API at `api.formlogic.local`) using the system-installed Google
Chrome — `playwright.config.ts` does not start a server.

## Run

```bash
cd formlogic/ui
npm run test:e2e                 # all specs
npm run test:e2e -- launch-golden-paths   # one file
```

Failures capture a screenshot + trace (open with `npx playwright show-trace <trace.zip>`).

## Prerequisites

- The app is served at `http://formlogic.local` and the API at `http://api.formlogic.local`
  (override with `E2E_BASE_URL` / `E2E_API_URL`).
- A seeded test account exists: `test@example.com` / `password123` (override with
  `E2E_EMAIL` / `E2E_PASSWORD`).
- Google Chrome is installed (`channel: 'chrome'`).

## Specs

- `launch-golden-paths.spec.ts` — auth login/logout; build→publish→submit-public→view; required
  validation; **hidden-field server-authority** + **calc**; **field-aware upload** rejection;
  **onSubmit** reject + computed write. Each test creates and deletes its own form.
- `script-editor.spec.ts` — the ScriptEditor "Run Test" success + rejection flows.
- `storage-mode.spec.ts` — login auto-enables cloud (API) storage.

## Notes / follow-ups

- Tests are deterministic on a clean run. The ScriptEditor specs call the rate-limited
  `/script/test` endpoint (15/min, shared with recompute), so running the whole suite many times
  within a minute can transiently rate-limit — not an issue for a single CI run.
- Not yet covered (tracked in `LAUNCH_CHECKLIST.md`): app-runtime RBAC golden paths, CSV/JSON
  export authorization, billing-disabled self-host. App RBAC is also covered by backend
  integration tests.
- CI: automatic runs are paused. `.github/workflows/e2e.yml` runs on demand (`workflow_dispatch`)
  or when called by the manual package workflow (`workflow_call`). The nightly schedule is commented out. It
  brings up MySQL + PHP and serves the built SPA and the API on ONE origin
  (`formlogic/ci/router.php`, `VITE_API_URL=/api`) so cookies are same-origin over HTTP, seeds the
  `test@example.com` account, runs against `http://127.0.0.1:8080`, and uploads traces on failure. It
  is intentionally NOT on every PR (slow full-stack gate). Locally it still runs against the WAMP
  stack as described above.

## Local review fixtures

The design specs for admin, App Studio, settings, automations and packs intercept API calls with
fixtures. They check navigation, save/error states and responsive layouts without changing server
data. The folder-pack, template and native-hosting specs instead exercise the real local backend.
Use a disposable review account and an isolated test database for data-changing tests; never point
the backend integration suite at a workspace whose records you want to keep.

Set `FORMLOGIC_REVIEW_PASSWORD` for specs using `admin@formlogic.local`; this is separate from the
golden-path `E2E_EMAIL` / `E2E_PASSWORD` settings. Specs that write operator template/pack folders
also require a local checkout matching the running server. A skipped account-dependent test is
not a successful integration check.
