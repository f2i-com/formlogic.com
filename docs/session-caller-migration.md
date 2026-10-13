# Session fixture caller migration

Session creation requires JSON and an explicit trusted frontend Origin. The backend continues to reject missing or untrusted Origin before the session handler. This follow-up migrates repository HTTP clients; it does not weaken that policy or qualify a deployed host.

`scripts/session-request.mjs` derives an exact HTTP(S) origin from the client's configured SPA base URL. It never derives authority from the API address, request Host, Referer or forwarded headers. Paths on a configured SPA URL are removed by URL origin normalization. Credential-bearing and non-HTTP URLs fail before transport.

## Configuration and operational inventory

The nineteen migrated calls are:

| Client | Calls | Frontend setting |
| --- | --- | --- |
| `.github/workflows/e2e.yml` account seed | 1 registration | `E2E_BASE_URL`; the backend allowlist and curl header use the same helper |
| `scripts/smoke-dist.mjs` | 1 registration, 1 login | Explicit same-origin smoke `BASE`, also used for its `CORS_ORIGIN` |
| `formlogic/ui/e2e/app-dashboard.spec.ts` | 1 demo start | `E2E_BASE_URL`, default `http://formlogic.local` |
| `formlogic/ui/e2e/demo-isolation.spec.ts` | 1 demo start | Same E2E frontend setting |
| `formlogic/ui/e2e/app-editors.spec.ts` | 3 logins | Same E2E frontend setting |
| `formlogic/ui/e2e/app-editors-roundtrip.spec.ts` | 1 login | Same E2E frontend setting |
| `formlogic/ui/e2e/form-template-catalog.spec.ts` | 1 login | Same E2E frontend setting |
| `formlogic/ui/e2e/folder-packs.spec.ts` | 1 login | Same E2E frontend setting |
| `formlogic/ui/e2e/native-source-record-editor.spec.ts` | 1 login | Same E2E frontend setting |
| `formlogic/ui/e2e/native-notes-hosting.spec.ts` | 1 login | Same E2E frontend setting |
| `formlogic/ui/e2e/native-coffee-hosting.spec.ts` | 1 login | Same E2E frontend setting |
| `formlogic/ui/e2e/softn-apps.spec.ts` | 1 login | Same E2E frontend setting |
| `formlogic/ui/scripts/capture-pack-shots.mjs` | 1 demo-start helper | `APP_BASE`, separate from `API_BASE` |
| `formlogic/ui/scripts/perf-demo-dashboards.mjs` | 1 demo start | `APP_BASE`, separate from `API_BASE` |
| `formlogic/ui/scripts/capture-native-docs.mjs` | 1 login | Existing local `E2E_BASE_URL`, default `http://127.0.0.1:5173` |
| `formlogic/tools/ai-app-builder/api-client.mjs` (called by `clients.mjs`) | 1 login | New `FL_FRONTEND_BASE`, default `http://formlogic.local`; separate from `FL_API_BASE` |

The configured frontend origin must also be explicitly allowed by the backend. A split-origin API URL does not change the frontend setting. Playwright configuration and its API helpers share `e2e/session-request.ts`. Cookie jars, authenticated CSRF headers and existing session payloads are preserved. The AI builder's API-only module takes explicit configuration and an optional transport so offline tests do not load backend `.env` or AI providers.

Repository searches also cover login, registration, demo start and MFA verification in workflows, scripts, tools, UI tests and backend tests. No additional operational non-browser MFA-verification caller was found. `demo-flows.spec.ts`, `launch-golden-paths-2.spec.ts` and production `src/lib/api.ts` use browser fetch, which supplies browser Origin. Browser-driven login tests follow that path. Controller-level PHP tests are not HTTP session clients; dedicated middleware tests intentionally cover missing headers. OAuth dynamic client registration is a different endpoint and does not issue these cookie sessions.

## Preserved historical evidence

The versioned `docs/ecosystem/qualification/0.1.6/` packet remains unchanged. Its `lab/attach.mjs`, `lab/backup.mjs`, `lab/journey.mjs`, `lab/twoeditors.mjs` and `browser-roundtrip.md` contain historical login/registration requests without Origin. Those receipts do not qualify the successor contract. Before any separately authorized replay, make a new versioned copy, explicitly configure its actual SPA URL and send `Origin: <that URL's origin>` with JSON; configure the backend to trust the same exact origin. Do not infer it from the API host or alter the archived packet.

## Offline verification

From the repository root, set `FORMLOGIC_TEST_VENDOR_AUTOLOAD` to an existing read-only Composer autoloader, and optionally `FORMLOGIC_TEST_PHP` and `FORMLOGIC_TEST_BASH` to installed PHP/Git Bash executables. Then run:

```sh
node --test scripts/session-request.test.mjs
```

This suite executes all nineteen real session call sites with fictional inputs. For fifteen Playwright calls it executes the real APIRequestContext POST/header/JSON serializer and intercepts its channel before transport. The smoke test executes its actual cookie-jar request function. The AI test invokes the isolated API module with an injected transport and verifies subsequent cookie/CSRF handling. The workflow's actual seed shell executes with curl replaced by an argument capture; its origin-only Node CLI remains real. No network request, listener, browser, account, token issuance, host install or provider is involved.

The captured serialized request bodies and headers are replayed through the actual candidate CSRF middleware with an in-memory counter handler. Four shared-helper route cases additionally cover every session endpoint, including MFA. **6 tests passed; 23 captured requests produced 161 passing middleware checks.** Missing, untrusted or duplicate Origin, non-JSON content, absent configuration and Host/metadata substitution reach no handler. These checks do not establish HTTP wire/SAPI behavior, live cookies, proxy deployment or end-to-end account creation.

The prepared toolchain was Node 24.19.0, TypeScript 5.9.3 and Playwright 1.63.0; the repository package range names Playwright 1.64.0, so this is explicitly a prepared-dependency serialization check, not a frozen release-dependency E2E run. Dependency and source hashes accompany the local receipt.

Affected TypeScript passes a strict no-emit check of the ten changed specs, shared helper and Playwright configuration. The broader check of all E2E `.ts` files reports six existing TS7006 errors in unchanged `aokie-receptionist.spec.ts` at lines 159, 161, 166, 175, 182 and 185. Full Playwright, the real smoke workflow, account seeding and hosted CI were not run.

Both TypeScript checks use the UI working directory and:

```sh
node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --types node,vite/client --strict --skipLibCheck --allowImportingTsExtensions --jsx react-jsx --lib ES2022,DOM,DOM.Iterable <selected .ts files>
```

Local evidence is under `scratch/evidence/session-callers/final/`: captured requests, middleware outcomes, raw source bindings, toolchain hashes, test receipt and TypeScript outcomes. Source parsing normalizes CRLF for portability; bindings hash the actual working bytes.
