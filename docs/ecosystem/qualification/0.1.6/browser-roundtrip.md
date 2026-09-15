# 0.1.6 candidate: browser round trip through the embedded editors (lane 5b)

Run on 15 September 2026 in a real Chromium against the candidate UI built from
FormLogic `ff27444b2083095cac09da68c5bf1c8e9767e023` and the Softn runtime installed
from release **v0.0.13** (`2288b6dee98329554d4f9b48366703ddee2711e6`,
`softn-formlogic-runtime-v0.0.13.zip`, sha256 `131f9e8ff5438dba2081dc6dd0f5fa01371f903ad6b0a33c3c095c6dfd840d01`,
ZIPP 0.0.18 @ `2f5c4c8d`). The spec is `formlogic/ui/e2e/app-editors-roundtrip.spec.ts`
and joins the golden paths: it uses the seeded `E2E_EMAIL` / `E2E_PASSWORD` account, the real
backend and the real embedded editors; only the AI provider is stubbed (as `app-editors.spec.ts`
stubs it), so Studio's own apply-and-review path runs without a paid provider.

| Item | Value |
| --- | --- |
| FormLogic commit | `ff27444b2083095cac09da68c5bf1c8e9767e023` (clean tree; the spec and this record are the only additions) |
| UI build | `MSYS_NO_PATHCONV=1 VITE_API_URL=/api npm run build` (prebuild checks passed against the installed runtime); `dist/assets/index-*.js` sha256 `5cb498f45a359d35…` |
| Stack | `php -d variables_order=EGPCS -S 127.0.0.1:18090 -t formlogic/ui/dist docs/ecosystem/qualification/0.1.6/lab/router-hosted-cors.php` (PHP 8.4.15, Windows); MySQL 8.4.7 (WAMP), isolated database `formlogic_e2e_s6` from `database/schema.sql`, its own user; Node 24.19.0 for native hosting |
| Browser | Google Chrome 152.0.7977.83 via Playwright 1.63.0 (`chrome-desktop` project, 1440×1000, headless) |
| Result | **2 passed** (16.0 s); repeated twice after the readiness wait was added: 2 passed, 2 passed. One earlier run had the two-editor test time out opening the Builder because the panel offers the editors only after the native preflight (which spawns Node once per host); the spec now waits for the panel's ready state, which is what a user sees too. |

## What the spec proves

**Round trip (one session).**
1. A client-only bundle (Softn's Fieldnotes example, no server entry) dropped on *Import .softn project* is refused with its reason ("no native server entry"): the native import boundary is explicit.
2. The native starter project, zipped as a `.softn`, imports as a draft through the file input and *Install app project* installs version 1.
3. *Open Visual Builder*: the button label is changed in the Builder's property panel, *Review changes* hands the draft back, the panel says "Editor changes returned to your draft" and the footer reads "Unpublished draft"; the installed version still has the old label (nothing published).
4. *Open AI Studio* on that draft: Studio's own *Export bundle* download carries the Builder edit (the draft reloaded, not the installed version). A stubbed AI reply changes the heading; *Review changes* returns it.
5. *Publish changes*: version 2 carries both edits, the private backend source is byte-identical to the starter's, and the live run at `/app/<slug>/native` (the panel's own "Open installed app" link) renders the new heading and the new button label inside the hosted frame.
6. *Download editable project*: the archive's entry list equals the project's source files (no records, no host configuration); imported into a second app and installed, the second app's files equal the first's.

**Two live editors (two browser contexts, same account).** Both open the app at installed version 1 and edit in their own Visual Builder; A publishes (version 2); B's publish shows the alert "The project changed. Reload before importing.", B's *Publish changes* stays enabled, its footer still says "Unpublished draft", its Screens tab still shows B's edit, and the stored version is A's.

## Observations (nothing changed under `formlogic/`)

1. **The single-origin CI router cannot serve the hosted app frame.** `formlogic/ci/router.php` lets PHP's built-in server serve static files as they are, without the `Access-Control-Allow-Origin: *` that `docs/HOSTED_APPS.md` requires for `/hosted-runtime/` (the frame is a sandboxed, opaque-origin iframe, so its module scripts are cross-origin). With the plain router the frame stays blank: every `hosted-runtime/assets/*.js` fails with a CORS error. `lab/router-hosted-cors.php` wraps the CI router with the documented static headers (CORS + nosniff for `/hosted-runtime/` and `/app-editors/`, the framing headers on the entry documents) and is what this lane used. The e2e workflow's job uses the plain router, so any golden path that renders a hosted app in CI would fail the same way; today none does (`app-editors.spec.ts` needs the local review account and is skipped there). Recommendation: add the same headers to `ci/router.php` (or use the lab router) before this spec joins the CI run.
2. A UI bundle built from Git Bash with `VITE_API_URL=/api` gets `C:/Program Files/Git/api` unless `MSYS_NO_PATHCONV=1` is set; the SPA then calls a `file:` URL and every page renders as 404. Worth one line in `formlogic/README.md` for Windows developers.
3. `DELETE /api/apps/{id}` does not exist (the spec's cleanup is best effort); the lane's apps remain in the isolated database, which was dropped afterwards.
4. The panel's import path leaves *Use this app as the website home* unchecked, so the installed app lives at `/app/<slug>/native` rather than `/app/<slug>`; the existing `app-editors.spec.ts` installs the starter by API with `home: true` and visits `/app/<slug>`. Both are correct; the difference is worth a sentence in `docs/HOSTED_APPS.md`.

## Reproduce

```sh
# database: an empty MySQL schema from formlogic/backend/database/schema.sql, its own user
cd formlogic/ui && MSYS_NO_PATHCONV=1 VITE_API_URL=/api npm run build && cd ../..
DB_HOST=127.0.0.1 DB_PORT=3306 DB_DATABASE=<db> DB_USERNAME=<user> DB_PASSWORD=<pass> APP_ENV=development \
  JWT_SECRET=<hex> AUDIT_HMAC_KEY=<hex> CORS_ALLOWED_ORIGINS=http://127.0.0.1:18090 COOKIE_SECURE=false AUTH_LOGIN_RATE_LIMIT=500 \
  FORMLOGIC_NODE_BIN=<node> php -d variables_order=EGPCS -S 127.0.0.1:18090 -t formlogic/ui/dist docs/ecosystem/qualification/0.1.6/lab/router-hosted-cors.php
curl -X POST http://127.0.0.1:18090/api/auth/register -H 'Content-Type: application/json' -d '{"email":"test@example.com","password":"password123","name":"E2E Test"}'
cd formlogic/ui && E2E_BASE_URL=http://127.0.0.1:18090 E2E_API_URL=http://127.0.0.1:18090 npx playwright test e2e/app-editors-roundtrip.spec.ts
```

Set `FIELDNOTES_SOFTN` to the Fieldnotes bundle's path when the Softn checkout is not a sibling.
