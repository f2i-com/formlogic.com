# FormLogic — Developer Setup

This is the developer guide for installing, running, testing, and deploying FormLogic. For the product tour and screenshots, see the **[root README](../README.md)**. For task guides and API references, start with the **[documentation index](../docs/README.md)**.

The web application lives in this directory:

- `backend/` — PHP 8.2 / Slim 4 API
- `ui/` — React 19 + TypeScript + Vite SPA
- `native-runtime/` — Tauri v2 desktop/mobile shell (optional; has its own [README](native-runtime/README.md))
- `install.php` / `install.sh` — assisted installers

OAIY is the separate desktop host for local AI, services, plugins and background flows. Aokie runs as an OAIY plugin and connects its call, message and appointment records to FormLogic. Their source lives in the sibling `oaiy.com` and `aokie.com` repositories; the optional `native-runtime/` shell here is not OAIY. See [connected apps](../docs/CONNECTED_APPS.md) for pairing, account linking and app bindings.

Hosted app interfaces use Softn. Their browser runtime, embedded editors and native backend modules are installed from Softn's latest GitHub release by `scripts/fetch-softn-release.mjs` (no sibling checkout needed); developers working on Softn itself can still build them from a sibling checkout with `SOFTN_REPO`. The native app backend also requires a compatible Node runtime on the server; OAIY is optional and supplies local AI/device services rather than the hosted backend.

## Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| PHP | 8.2+ | `php -v` |
| PHP extensions | pdo_mysql, pdo_sqlite, mbstring, json, openssl, fileinfo, sodium | `php -m` |
| Composer | any | `composer --version` |
| MySQL | 8.0+ | `mysql --version` |
| Node.js | Use `.node-version` (24.19.0); frontend supports ^22.22.2, ^24.15.0 or >=26 | `node -v` |
| npm | any | `npm -v` |
| Git | any | `git --version` |

Node.js builds the UI. **Native app hosting also uses Node on the API server**, with `node:sqlite`, to run the trusted ZIPP backend host. Use the pinned Node version for this path and set `FORMLOGIC_NODE_BIN` when it is not on the PHP process PATH. Standard form scripts and named hosted actions use the vendored ZIPP guest and wasmtime launcher. When building from a fresh source checkout, prepare the hosted runtime below before the first UI build, including builds started by an installer.

## Install

### Option 1: Web install wizard (Windows / WAMP / XAMPP)

For a source checkout, complete the [frontend dependency setup](#4-frontend) and [hosted runtime build](#5-hosted-app-runtime) before building the UI. The runtime is required; the wizard does not generate it. A packaged release already includes the built runtime assets.

Serve the repo from your web root and open the wizard in a browser (the URL must include the `/formlogic/` segment, since that's where `install.php` lives):

```
http://localhost/<your-folder>/formlogic/install.php
```

For the default checkout under your web root that's:

```
http://localhost/formlogic.com/formlogic/install.php
```

The wizard checks requirements and file permissions (fixing what it can — including the execute bit on the Linux sandbox launcher), tests the MySQL connection, and writes the config files, database, and security keys. It then tells you which of `composer install` / `npm install` are still outstanding, and prints cron lines for the maintenance CLIs. On an already-installed deployment it instead offers an **"Upgrade existing installation"** mode (same guarded migrations as `backend/bin/upgrade.php`; requires `INSTALL_ENABLE=1` since the wizard locks itself once installed). The wizard also ships at the root of the release zip (`install.php` beside `api/`). **Delete `install.php` when done.**

### Option 2: Install script (Linux / macOS / Git Bash)

The script runs `npm run build`, whose prebuild check requires the generated hosted runtime. **Install that runtime before invoking the installer.** For a clean source install:

```bash
git clone git@github.com:f2i-com/formlogic.com.git
cd formlogic.com/formlogic/ui
npm install
node ../../scripts/fetch-softn-release.mjs   # latest Softn release; SOFTN_RELEASE=v0.0.13 pins one
cd ..
chmod +x install.sh
./install.sh
```

The fetch downloads Softn's `softn-formlogic-runtime-<tag>.zip`, verifies it (checksum, every file digest, identical ZIPP engine bytes, protocol versions, the vendored adapter) and installs the hosted runtime, the embedded editors and the native backend modules. See [docs/ecosystem/SOFTN_RELEASE.md](../docs/ecosystem/SOFTN_RELEASE.md).

The script verifies prerequisites, runs `composer install`, creates `backend/.env` with generated `JWT_SECRET` + `AUDIT_HMAC_KEY`, creates the MySQL database and imports the schema (when a DB password is provided), runs `npm install`, creates `ui/.env`, makes the vendored sandbox launcher executable, and builds the frontend. Afterwards, set your database password in `backend/.env` if you skipped it.

### Option 3: Manual setup

#### 1. Clone

```bash
git clone git@github.com:f2i-com/formlogic.com.git
cd formlogic.com/formlogic
```

#### 2. Backend

```bash
cd backend
composer install
cp .env.example .env
```

Edit `backend/.env` and set at minimum:

```ini
DB_PASSWORD=your_password_here

# Generate each with: php -r "echo bin2hex(random_bytes(32));"
JWT_SECRET=your_generated_secret_here
AUDIT_HMAC_KEY=your_generated_key_here
```

Create the storage directories:

```bash
mkdir -p storage/forms storage/hosted-apps storage/packs storage/uploads logs
```

#### 3. Database

**Option A: auto-create** — the app creates all tables on the first request; just create an empty database:

```bash
mysql -u root -p -e "CREATE DATABASE formlogic CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

**Option B: import the schema** directly:

```bash
mysql -u root -p formlogic < database/schema.sql
```

#### 4. Frontend

```bash
cd ../ui
npm install
cp .env.example .env
```

Keep the default `VITE_API_URL=/api` for development and same-domain production. In development, Vite forwards `/api` to `http://127.0.0.1:8080`, keeping requests and session cookies on the browser's frontend origin. If your PHP server uses another address, set `VITE_API_PROXY_TARGET` in `ui/.env`; use `off` only when you intentionally do not want the proxy. Restart Vite after changing environment variables.

#### 5. Hosted app runtime

Install the shared assets from Softn's release:

```bash
# From formlogic.com/formlogic/ui
node ../../scripts/fetch-softn-release.mjs            # latest release
node ../../scripts/fetch-softn-release.mjs --check    # verify an install offline
```

The fetch installs `ui/public/hosted-runtime/`, `ui/public/app-editors/` and `backend/resources/softn-native/` as one verified generation. Generated runtime assets are ignored by Git. To build them from a Softn source checkout instead (Softn development only), set `SOFTN_REPO` to the checkout and run `npm run build:hosted-runtime`, `npm run build:app-editors` and `node ../../scripts/prepare-native-runtime.mjs`. A normal UI build checks runtime and editor assets exist; deploy them with the UI, or restore a compatible build artifact when the Softn source is unavailable. See [hosted app deployment](../docs/HOSTED_APPS.md#build-and-operate) for the iframe's static-asset CORS requirements.

When editing the canonical workspace or Aokie client templates in Softn, also run `node scripts/sync-workspace-project.mjs` from `ui/` to refresh the UI and PHP resource copies. See [maintaining shared clients](../docs/CONNECTED_APPS.md#maintain-the-shared-clients).

#### 6. Form scripting runtime

Form expressions and `onSubmit` scripts run in a **zipp** sandbox on both sides, sharing one standard-library prelude (`ui/src/lib/formlogic/prelude.js`):

- **Browser:** the vendored module in `ui/vendor/zipp-wasm/` runs in a Web Worker; Vite bundles its WASM and the prelude.
- **Server:** the PHP API invokes a vendored per-OS launcher under `backend/bin/runtime/`, which runs zipp as a WebAssembly guest under wasmtime. See the [runtime README](runtime/README.md). The UI build's `prebuild` step syncs the prelude into `backend/resources/formlogic-prelude.js`.

On Linux/macOS ensure the launcher is executable (`chmod +x backend/bin/runtime/formlogic-runtime-linux-x86_64`); `install.sh` and `install.php` both do this for you.

## Running

### Development (two terminals)

```bash
# Terminal 1: backend API
cd backend
composer start
# API at http://localhost:8080/api

# Terminal 2: frontend dev server (hot reload)
cd ui
npm run dev
# App at http://localhost:5173
```

Open http://localhost:5173 and create an account. Keep using one hostname (`localhost` or `127.0.0.1`) throughout the browser session. A request to `/api/health` on the frontend origin should return JSON through the Vite proxy.

The workspace is free by default and does not need AI for manual editing or starters. The public `/ai-setup` guide explains the options; `/connect-ai` opens the setup wizard after login. Operator-funded Site AI and payments are off by default in the admin platform settings. See [free plans and AI setup](../docs/FREE_PLANS_AND_AI_SETUP.md) for BYO providers, OAIY, MCP and the separate Site AI switch.

### Production

Build the frontend, then serve two directories from your web server:

```bash
cd ui
npm run build     # output: ui/dist/
```

- Serve `ui/dist/` as the document root (SPA fallback to `index.html`)
- Route `/api/*` to `backend/public/index.php`
- Serve `/hosted-runtime/*` as real static files, with `Access-Control-Allow-Origin: *` and `X-Content-Type-Options: nosniff` for the sandboxed app frame. Missing assets must return 404, not the SPA HTML. Apply these headers only to this static directory, not authenticated API routes.

> **Production must be HTTPS.** Auth uses `Secure` cookies in production, so login fails over plain HTTP. Terminate TLS directly or at a reverse proxy (which must send `X-Forwarded-Proto: https`), and redirect port 80 → 443. See [DEPLOYMENT.md](../DEPLOYMENT.md) for the full launch checklist.
>
> **Only expose two directories:** `ui/dist` and `backend/public`. **Never** let the web server reach `backend/storage` (form and hosted-app SQLite databases, private action source and uploads), `backend/logs`, or any `.env` — those hold your data and secrets.

<details>
<summary><strong>Example Apache VirtualHost (HTTPS)</strong></summary>

```apache
# Redirect all plain HTTP to HTTPS.
<VirtualHost *:80>
    ServerName formlogic.example.com
    Redirect permanent / https://formlogic.example.com/
</VirtualHost>

<VirtualHost *:443>
    ServerName formlogic.example.com
    DocumentRoot /var/www/formlogic/ui/dist

    SSLEngine on
    SSLCertificateFile      /etc/letsencrypt/live/formlogic.example.com/fullchain.pem
    SSLCertificateKeyFile   /etc/letsencrypt/live/formlogic.example.com/privkey.pem

    # Frontend (SPA fallback) — document root is ui/dist ONLY.
    <Directory /var/www/formlogic/ui/dist>
        AllowOverride None
        FallbackResource /index.html
    </Directory>

    # Sandboxed hosted apps load these static assets without an origin identity.
    # Requires mod_headers; missing runtime assets must not fall back to the SPA.
    <Directory /var/www/formlogic/ui/dist/hosted-runtime>
        FallbackResource disabled
        Header always set Access-Control-Allow-Origin "*"
        Header always set X-Content-Type-Options "nosniff"
    </Directory>

    # Backend API — exposes backend/public ONLY (never backend/storage, backend/logs, or .env).
    Alias /api /var/www/formlogic/backend/public
    <Directory /var/www/formlogic/backend/public>
        AllowOverride All
        Require all granted
    </Directory>

    RewriteEngine On
    RewriteRule ^/api/(.*)$ /api/index.php [QSA,L]
</VirtualHost>
```

</details>

<details>
<summary><strong>Example Nginx config (HTTPS)</strong></summary>

```nginx
# Redirect all plain HTTP to HTTPS.
server {
    listen 80;
    server_name formlogic.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name formlogic.example.com;

    ssl_certificate     /etc/letsencrypt/live/formlogic.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/formlogic.example.com/privkey.pem;

    # Serve ui/dist ONLY (never expose backend/storage, backend/logs, or .env).
    root /var/www/formlogic/ui/dist;
    index index.html;

    # Frontend (SPA fallback)
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Static hosted runtime only; do not apply permissive CORS to /api.
    location ^~ /hosted-runtime/ {
        try_files $uri =404;
        add_header Access-Control-Allow-Origin "*" always;
        add_header X-Content-Type-Options "nosniff" always;
    }

    # Backend API — backend/public ONLY.
    location /api/ {
        alias /var/www/formlogic/backend/public/;
        try_files $uri /api/index.php$is_args$args;

        location ~ \.php$ {
            fastcgi_pass unix:/run/php/php8.2-fpm.sock;
            fastcgi_param SCRIPT_FILENAME $request_filename;
            include fastcgi_params;
        }
    }
}
```

Behind a TLS-terminating reverse proxy or load balancer instead? Keep the server blocks on HTTP internally but ensure the proxy sets `X-Forwarded-Proto: https` so the app treats the request as secure (and still issues `Secure` cookies).

</details>

For production also update `backend/.env`:

```ini
APP_ENV=production
APP_DEBUG=false
CORS_ORIGIN=https://formlogic.example.com
COOKIE_DOMAIN=.example.com
```

And `ui/.env`, then rebuild (`cd ui && npm run build`):

```ini
VITE_API_URL=/api
```

> **One domain, no separate API host.** With `VITE_API_URL=/api` the SPA calls the backend on the **same origin**, so a single domain serves both — route `/api` to PHP and serve `ui/dist` for everything else. No second domain and no CORS config are needed. Only set a separate `VITE_API_URL` + `CORS_ORIGIN` if you deliberately host the API on its own domain.

Custom app domains (running an app on a customer's own domain) additionally use three root-level paths — `/.well-known/formlogic-app.json`, `/manifest.json`, `/.well-known/assetlinks.json` — which the shipped `ui/public/.htaccess` already routes to the API on single-domain Apache deploys. See [docs/CUSTOM_APP_PLATFORM.md](../docs/CUSTOM_APP_PLATFORM.md#custom-domains--app-launch).

### Distributable zip (packaged release)

`node scripts/package-dist.mjs` (from the repo root) builds a ready-to-upload release zip in the single-domain layout: the built UI at the zip root, the production-filtered backend under `api/`, plus the `install.php` wizard, `INSTALL.txt`, `UPGRADE.txt`, and `VERSION` — output at `dist-package/formlogic-<version>.zip` (flags: `--skip-ui-build`, `--no-install`, `--out <dir>`, `--keep-staging`).
The [package workflow](../.github/workflows/package.yml) is **manual-only**. Use Actions → **Package (distributable zip)** → **Run workflow**. Selecting a `v*` tag attaches the zip to that tag's GitHub release after its verification jobs pass; selecting a branch creates an artifact without publishing a release. Pushing a tag alone does not start this workflow. Prepare the generated hosted-runtime assets before packaging from source.

## Tests and checks

Automatic push/PR checks are temporarily paused. Run the relevant checks locally, or explicitly start a manual workflow; a push does not establish that its checks passed. Use a disposable local test database and account for tests that create or remove records.

### Backend (PHPUnit)

```bash
cd backend
composer test          # runs phpunit (unit + integration suites, tests/)
composer analyse       # PHPStan
php -l path/to/File.php   # quick syntax check on a single file
```

### Frontend

```bash
cd ui
npm run test           # vitest run (unit tests, single pass)
npm run test:unit      # vitest in watch mode
npm run typecheck:test # type-check test files
npm run lint           # eslint
npm run build          # tsc -b + vite build (type-checks everything)
```

### End-to-end (Playwright)

E2E tests run against a **live deployment** — no dev server is started for you:

```bash
cd ui
E2E_BASE_URL=http://your-local-host npm run test:e2e
```

The default `E2E_BASE_URL` is `http://formlogic.local` (see `ui/playwright.config.ts`). Tests use the system-installed Chrome (`channel: 'chrome'`), so no Playwright browser download is needed.

## Tech stack

### Frontend

| Layer | Technology |
|-------|-----------|
| Framework | React 19 + TypeScript |
| Build | Vite 8 |
| Styling | Tailwind CSS 4 |
| State | Zustand 5 (persisted stores) |
| Routing | React Router 7 |
| Charts | recharts (widget dashboards + reports) |
| Drag & Drop | @dnd-kit |
| Animation | Framer Motion |
| Icons | Lucide React |
| PWA | vite-plugin-pwa |
| Scripting (browser) | Vendored zipp WASM in a Web Worker |
| Hosted app UI | Softn shared runtime in a sandboxed frame |

### Backend

| Layer | Technology |
|-------|-----------|
| Framework | PHP 8.2+ / Slim 4 |
| Auth | HttpOnly cookie sessions (JWT-signed) + scoped API keys + ephemeral MCP tokens |
| Database | MySQL (global metadata), per-form SQLite responses, per-hosted-app SQLite deployment and records |
| Logging | Monolog |
| DI | PHP-DI |
| Scripting (server) | zipp, as a WebAssembly guest under a vendored wasmtime launcher (no Node.js) |
| Signing | Ed25519 via libsodium (packages + client manifests) |

### Scripting engine

FormLogic runs user expressions and `onSubmit` scripts inside a **zipp** sandbox, using the same engine revision and shared standard-library prelude on both sides. A shared expression corpus checks browser/server behavior:

- **Browser** — the vendored `ui/vendor/zipp-wasm/` module runs in a dedicated Web Worker for validation, conditional logic and calculated fields. Engine limits and the worker watchdog bound evaluation.
- **Server** — a vendored launcher (under `backend/bin/runtime/`, selected per-OS) invoked by `SandboxRunner` via `proc_open`; inside it the [zipp](https://github.com/f2i-com/zipp.org) engine runs as a WASI guest under wasmtime, behind a hard memory ceiling, a fuel budget and no filesystem or network capability. `onSubmit` `ctx.db`/`ctx.http`/`ctx.utils` calls are handled in PHP over a synchronous RPC, keeping the SSRF/DNS-pinning guards on the trusted side.

Host access is denied by default; each evaluation receives only its permitted bindings, and runaway scripts are stopped by the sandbox budgets or watchdog. The same sandbox also runs app-level and form-level **custom logic** (effect + permission model — see [custom app platform](../docs/CUSTOM_APP_PLATFORM.md#app-logic-quickjs); that reference retains its older QuickJS heading).

**Edit the prelude only at `ui/src/lib/formlogic/prelude.js`** — the build's `prebuild` step (`npm run sync:prelude`) syncs it into `backend/resources/`.

Hosted client `.logic` calls named private backend actions through FormLogic's authenticated bridge. The backend resolves the app identity and gives each action access to that app's records. Private action source stays on the server; the client download contains only public interface files. See [hosted apps](../docs/HOSTED_APPS.md) for the action API, access rules and limits.

Hosted databases live in `backend/storage/hosted-apps/<sha256(appId)>.sqlite`; `SQLITE_STORAGE_PATH` configures form response databases separately. The PHP user needs write access to both directories. Include hosted databases in operator backups: current account/form exports do not include them. Use **Download database** for a consistent hosted-app snapshot, or the SQLite backup procedure in the hosting guide.

## Project structure

```
formlogic/
├── install.php                    # Browser install wizard (delete after install)
├── install.sh                     # CLI install script (Linux / macOS / Git Bash)
├── backend/
│   ├── public/index.php           # All routes, DI container, middleware wiring
│   ├── config/settings.php        # Environment config
│   ├── database/schema.sql        # MySQL schema export (+ migrate.php)
│   ├── bin/                       # Maintenance CLIs (upgrade, provision-demo, workers) + runtime/ sandbox launchers
│   ├── resources/                 # Synced prelude + bundled sample apps
│   ├── scripts/                   # dev-only: build-expression-corpus.php (provision-demo.php lives in bin/ so it ships)
│   ├── .env.example               # Annotated backend environment template
│   ├── tests/                     # PHPUnit (Unit/ + Integration/)
│   └── src/
│       ├── Controllers/           # Auth, Form, Response, App, AppDomain, AppManifest, Pack, AI, Mcp, Billing, ...
│       ├── Services/              # FormLogicRuntime, PackService, SigningService, AppDomainService, ReportService, ...
│       ├── Middleware/            # Auth, ApiKey, CORS, CSRF, RateLimit, SecurityHeaders, BodySize, DemoReadOnly, CloudWriteGate
│       ├── Models/                # User, Form, App, AppRole, AppUser, AppUserGroup
│       ├── Database/              # MySQLConnection + SQLiteConnection
│       ├── Constants/             # AppPermissions
│       └── Helpers/               # IpResolver, IpSafety, AppUrl, CustomLogicSanitizer, PackCapabilities, RecordLabel
│
├── ui/
│   ├── .env.example               # Frontend environment template
│   ├── e2e/                       # Playwright specs (run against a live deploy)
│   ├── public/hosted-runtime/      # Generated Softn runtime assets (not tracked)
│   ├── vendor/zipp-wasm/           # Browser scripting engine
│   ├── scripts/                   # Prelude/template sync, runtime build, marketplace and QA tooling
│   └── src/
│       ├── pages/                 # Top-level pages + pages/apps/ (app admin)
│       ├── components/
│       │   ├── app-runtime/       # App runtime (form views, widget dashboards, data tables)
│       │   ├── apps/              # App management panels (domains, logic, deploy)
│       │   ├── builder/           # Form builder (field palette, script editor, AI generator)
│       │   ├── layout/            # App shell, sidebar, header, mobile nav
│       │   └── ui/                # Shared UI components
│       ├── stores/                # Zustand stores (auth, form, app, response, runtime, ...)
│       ├── client-runtime/        # App-logic host, effects/permissions, connectors
│       ├── sdk/                   # FormLogic SDK (permission-aware hooks + components)
│       ├── application-package/   # .formlogic package types + validator
│       ├── lib/formlogic/         # zipp engine wrapper (Web Worker) + shared prelude
│       ├── types/                 # TypeScript interfaces (form, app, custom logic)
│       └── data/packs/            # Marketplace pack bundles
│
├── native-runtime/                # Tauri v2 shell (Rust) — see its README
└── README.md                      # This file
```

## Architecture notes

- **Data storage** — MySQL holds users, forms (metadata + field definitions), apps, roles, permissions, audit log, webhooks and response metadata. Each form has a SQLite response database; each hosted project has a separate SQLite deployment/record database. Back up both storage paths.
- **One backend, many portals** — a form can be attached to many apps (`app_forms` many-to-many) and every app reads/writes the same records; member payloads are filtered server-side by role. See [docs/ONE_BACKEND_MANY_PORTALS.md](../docs/ONE_BACKEND_MANY_PORTALS.md).
- **Auth** — HttpOnly cookies with JWT-signed tokens; CSRF via double-submit cookie, validated on state-changing requests.
- **Storage modes** — forms can live in browser localStorage (no account) or sync to the backend; the preference persists.
- **Scripting** — conditional visibility, custom validation, calculated fields, and a server-authoritative `onSubmit` script that can read the record (`ctx.answers` / `ctx.db.getField`), write derived fields (`ctx.db.setField`), set tags/status, or reject. Scripts run **synchronously** (don't `await` `ctx.http`/`ctx.db`). `hidden` fields are the natural home for computed output.

## Environment variables

Start with **`backend/.env.example`** for local configuration. The defaults below describe runtime fallbacks; the example explicitly enables development mode. Admin-managed plan and Site AI settings are separate from environment variables; see [platform settings](../docs/FREE_PLANS_AND_AI_SETUP.md#administrator-controls).

### Backend (`backend/.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_ENV` | `production` | Only explicit `development` enables development behavior |
| `APP_DEBUG` | `false` | Detailed errors only when also in development mode |
| `DB_HOST` | `localhost` | MySQL host |
| `DB_PORT` | `3306` | MySQL port |
| `DB_DATABASE` | `formlogic` | MySQL database name |
| `DB_USERNAME` | `formlogic` | MySQL user |
| `DB_PASSWORD` | | MySQL password (**required in production**) |
| `SQLITE_STORAGE_PATH` | `storage/forms` | Per-form SQLite directory (relative to `backend/`) |
| `JWT_SECRET` | | JWT signing secret, min 32 chars (**required in production**) |
| `JWT_EXPIRY` | `86400` | Token lifetime in seconds (24h) |
| `AUDIT_HMAC_KEY` | | HMAC key for audit-log integrity (**required in production**) |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed CORS origin |
| `CORS_ALLOWED_ORIGINS` | | Additional CORS origins (comma-separated) |
| `COOKIE_DOMAIN` | | Cookie domain (empty = current domain) |
| `UPLOAD_MAX_FILE_SIZE` | `10485760` | Max upload size in bytes (10MB) |
| `AI_BASE_URL` | `https://api.openai.com/v1` | Operator-funded Site AI endpoint; an OpenAI-compatible API base URL |
| `AI_API_KEY` | | API key; optional — leave blank for a keyless local server |
| `AI_MODEL` | `gpt-4o` | Text model for AI generation |
| `AI_VISION_MODEL` | `AI_MODEL` | Vision model for image/document extraction |
| `AI_ENABLED` | `true` | Additional Site AI gate: `false` disables it. Site AI still defaults **off** in admin settings, even with a server key present. Does not disable BYO providers or MCP. |
| `REQUIRE_VERIFIED_PACKAGES` | `false` | Require a verified signature on every package/pack import |

Legacy `OPENAI_API_KEY` / `OPENAI_API_URL` / `OPENAI_MODEL` names are still honored as fallbacks for the `AI_*` variables.

### Frontend (`ui/.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `/api` | Same-origin API path in development and production |
| `VITE_API_PROXY_TARGET` | `http://127.0.0.1:8080` in development | PHP target for Vite's `/api` proxy; `off` disables it. No production proxy is started by this setting. |
| `VITE_PUBLIC_DOMAIN` | `formlogic.com` | Domain shown in landing-page mockups + sales contact (baked in at build time) |

## API overview

Three ways in, all documented elsewhere:

- **Internal API** (`/api/...`) — cookie-authenticated; everything the SPA does: auth, forms, responses, apps (incl. companion apps, form relations, custom domains, signed exports), app runtime (incl. `sync/batch` offline sync, activity, reports), packs/marketplace, billing. Routes are all declared in `backend/public/index.php`.
- **External REST API** (`/api/v1/...`) — API-key authenticated (`Authorization: Bearer flk_…`, scoped keys created in Settings → API keys). Submissions run the full pipeline including the `onSubmit` script. Full reference: **[docs/API.md](../docs/API.md)**.
- **MCP server** (`POST /api/mcp`) — scoped access for external AI clients to build and edit apps. See **[MCP setup and tool reference](../docs/MCP.md)**.

## Field types

| Type | Description |
|------|-------------|
| `short_text` | Single-line text input |
| `long_text` | Multi-line textarea |
| `email` | Email with validation |
| `phone` | Phone number |
| `number` | Numeric input |
| `url` | URL input |
| `date` | Date picker |
| `time` | Time picker |
| `datetime` | Date + time picker |
| `dropdown` | Select dropdown |
| `multiple_choice` | Radio buttons |
| `checkboxes` | Multiple selection |
| `rating` | Star rating |
| `scale` | Linear scale (1-10) |
| `file_upload` | File attachment |
| `signature` | Signature pad |
| `calculated` | Computed from expression |
| `linked_record` | Reference to another form's response |
| `location` | Latitude / longitude capture |
| `hidden` | Stores a default, computed, or script-set value — never shown to respondents, saved with the response and included in exports |
| `statement` | Display-only text/media |
| `welcome_screen` | Form intro screen |
| `thank_you` | Form completion screen |

## Security

- **HttpOnly cookies** for session tokens (not accessible to JavaScript)
- **CSRF protection** with the double-submit cookie pattern
- **Rate limiting** per endpoint class: auth 10/min, form mutations 20/min, submissions 30/min, public form views 60/min, external API + MCP 120/min
- **Security headers** (X-Content-Type-Options, X-Frame-Options, CSP, etc.)
- **Input validation** with type checking and constraint enforcement
- **SSRF protection** on webhooks, `ctx.http`, and domain probes — DNS resolution checks and private/reserved IP blocking, re-resolved per request
- **Sandboxed scripting** — user scripts run in isolated zipp sandboxes with bounded execution and explicitly granted host bindings; no direct DOM, filesystem or network access
- **Signed packages & manifests** — Ed25519 signatures over `.formlogic` exports and client manifests; tampered archives are rejected on import
- **Hash-chained audit log** with HMAC-SHA256 integrity verification (`GET /api/admin/audit/verify`)
- **Body size limits** on uploads; **User-Agent sanitization** against stored XSS

## Troubleshooting

### "SECURITY ERROR: JWT_SECRET must be set" on first request
`APP_ENV` is `production` but `JWT_SECRET` is empty. Either set `APP_ENV=development` in `backend/.env` for local development, or generate a secret (`php -r "echo bin2hex(random_bytes(32));"`) and set it.

### API requests fail or return HTML instead of JSON
Keep `VITE_API_URL=/api`; confirm the PHP server is running and Vite's proxy target reaches it. Restart Vite after editing `.env`. In production, route `/api` to PHP before the SPA fallback. If you deliberately use a separate API origin, configure `CORS_ORIGIN`/`CORS_ALLOWED_ORIGINS` for the frontend and verify cookie policy.

### Hosted preview is blank or a build reports a missing hosted runtime
Run `npm run build:hosted-runtime` and `npm run build:app-editors` with the sibling Softn dependencies installed, then rebuild the UI. For native backend hosting, also run `node ../../scripts/prepare-native-runtime.mjs` from `ui/` and verify `FORMLOGIC_NODE_BIN`. Check that `/hosted-runtime/index.html` and its JS/WASM assets are deployed. The static runtime needs the CORS headers above; missing files must not return the landing page. See [hosting troubleshooting](../docs/HOSTED_APPS.md#troubleshooting).

### Scripting (form logic / validation / calculations) not running
- **Browser:** ensure the vendored `ui/vendor/zipp-wasm/` files are present and the built WASM asset loads successfully in the worker. It is bundled by Vite; no `quickjs-emscripten` download is required.
- **Server:** ensure the vendored launcher exists under `backend/bin/runtime/` for your OS (it's committed in the repo). On macOS/Linux it must be executable (`chmod +x backend/bin/runtime/formlogic-runtime-linux-x86_64`; `install.sh` and `install.php` do this). The prelude is synced to `backend/resources/` by the `prebuild` step of `npm run build`.

### MySQL connection refused
- Verify MySQL is running: `mysql -u root -p -e "SELECT 1"`
- Check `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD` in `backend/.env`
- Ensure the database exists: `mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS formlogic CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"`

### PHP extensions missing
Check with `php -m`. On Ubuntu/Debian:
```bash
sudo apt install php8.2-mysql php8.2-sqlite3 php8.2-mbstring php8.2-xml
```

### AI generation not working
Check the selected source in **Connect your AI** and run its connection test. For OAIY, confirm browser pairing, provider readiness and the exact advertised gateway endpoint; browser pairing is separate from linking the FormLogic account for background records and flows. Direct browser providers need browser-compatible CORS.

Some server-side generation routes still require operator-funded Site AI. For those, an admin must enable Site AI and configure `AI_BASE_URL`, model and any required key; `AI_ENABLED=false` overrides the admin switch. Check `GET /api/ai/status`. Production blocks provider keys over plain HTTP unless the explicit loopback-only exception is enabled. See [AI setup and limits](../docs/FREE_PLANS_AND_AI_SETUP.md).

## Upstream scripting runtime

- **[zipp](https://github.com/f2i-com/zipp.org)** — the JavaScript engine behind form logic in the browser, on the server and on the desktop; **[wasmtime](https://wasmtime.dev)** — the WebAssembly runtime the server launcher embeds

## License

Proprietary, source-available. Free to self-host and modify for your own use; selling or offering it as a paid/hosted service requires a commercial agreement. See [LICENSE](../LICENSE).

### Installer recovery and marketplace setup

The web installer publishes the installable marketplace catalogue using a bounded `--catalog-only` run. Bulk demo-account installation and sample records run separately from a shell to avoid hosting/Cloudflare request timeouts:

```sh
php api/bin/provision-demo.php
```

Use `backend/bin/provision-demo.php` in a source checkout. The command is idempotent. If catalogue setup could not finish during web installation, rerun it with `--catalog-only` to publish only the catalogue. Failures show an error reference in the wizard and are logged in the hosting PHP error log and, when writable, `api/logs/installer.log`. The browser retains the last request error for that tab. After an interrupted install, preserve `.env` and storage; reload the wizard and use its existing-installation checks before retrying. Never enable environment replacement merely to recover from a timeout.
