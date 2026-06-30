# E2E tests (Playwright)

Launch-critical golden paths + feature specs. They run against the **live stack** (the WAMP-served
app at `formlogic.local` + the API at `api.formlogic.local`) using the system-installed Google
Chrome — `playwright.config.ts` does not start a server.

## Run

```bash
cd form-builder/ui
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
- CI note: this suite needs the full PHP/MySQL/SQLite stack running; wiring that into GitHub
  Actions (or a `webServer` block) is a separate task. For now it's a documented local/pre-release
  command.
