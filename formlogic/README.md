# FormLogic — Developer Setup

This is the developer guide for installing, running, testing, and deploying FormLogic. For what FormLogic *is* — the product story, feature tour, marketplace catalog, and screenshots — see the **[root README](../README.md)**.

Everything lives in this directory:

- `backend/` — PHP 8.2 / Slim 4 API
- `ui/` — React 19 + TypeScript + Vite SPA
- `native-runtime/` — Tauri v2 desktop/mobile shell (optional; has its own [README](native-runtime/README.md))
- `install.php` / `install.sh` — assisted installers

## Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| PHP | 8.2+ | `php -v` |
| PHP extensions | pdo_mysql, pdo_sqlite, mbstring, json, openssl, fileinfo | `php -m` |
| Composer | any | `composer --version` |
| MySQL | 8.0+ | `mysql --version` |
| Node.js | 20.19+ / 22.12+ (Vite 7) | `node -v` |
| npm | any | `npm -v` |
| Git | any | `git --version` |

Node.js is a **build-time** dependency only. The server-side script sandbox is a vendored static QuickJS binary — no Node.js on the server.

## Install

### Option 1: Web install wizard (Windows / WAMP / XAMPP)

Serve the repo from your web root and open the wizard in a browser (the URL must include the `/formlogic/` segment, since that's where `install.php` lives):

```
http://localhost/<your-folder>/formlogic/install.php
```

For the default checkout under your web root that's:

```
http://localhost/formlogic.com/formlogic/install.php
```

The wizard checks requirements and file permissions (fixing what it can — including the Linux `qjs` execute bit), tests the MySQL connection, and writes the config files, database, and security keys. It then tells you which of `composer install` / `npm install` are still outstanding, and prints cron lines for the maintenance CLIs. On an already-installed deployment it instead offers an **"Upgrade existing installation"** mode (same guarded migrations as `backend/bin/upgrade.php`; requires `INSTALL_ENABLE=1` since the wizard locks itself once installed). The wizard also ships at the root of the release zip (`install.php` beside `api/`). **Delete `install.php` when done.**

### Option 2: Install script (Linux / macOS / Git Bash)

```bash
cd formlogic
chmod +x install.sh
./install.sh
```

The script verifies prerequisites, runs `composer install`, creates `backend/.env` with generated `JWT_SECRET` + `AUDIT_HMAC_KEY`, creates the MySQL database and imports the schema (when a DB password is provided), runs `npm install`, creates `ui/.env`, makes the vendored `qjs` binary executable, and builds the frontend. Afterwards, set your database password in `backend/.env` if you skipped it.

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
mkdir -p storage/forms storage/packs storage/uploads logs
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

The default `ui/.env` points at `http://localhost:8080/api` for development. For same-domain production, change it to `/api`.

#### 5. Scripting runtime — nothing to do

Form expressions and `onSubmit` scripts run in a **QuickJS** sandbox on both sides, sharing one standard-library prelude (`ui/src/lib/formlogic/prelude.js`):

- **Browser:** `quickjs-emscripten` (pulled by `npm install`) runs the engine in a Web Worker; the prelude is bundled automatically.
- **Server:** the PHP API shells out to a vendored static `qjs` binary committed under `backend/bin/qjs/` (selected per-OS). `npm run build` runs a `prebuild` step that syncs the prelude into `backend/resources/formlogic-prelude.js`.

On Linux/macOS ensure the binary is executable (`chmod +x backend/bin/qjs/qjs-linux-x86_64`); `install.sh` does this for you.

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

Open http://localhost:5173 and create an account.

### Production

Build the frontend, then serve two directories from your web server:

```bash
cd ui
npm run build     # output: ui/dist/
```

- Serve `ui/dist/` as the document root (SPA fallback to `index.html`)
- Route `/api/*` to `backend/public/index.php`

> **Production must be HTTPS.** Auth uses `Secure` cookies in production, so login fails over plain HTTP. Terminate TLS directly or at a reverse proxy (which must send `X-Forwarded-Proto: https`), and redirect port 80 → 443. See [DEPLOYMENT.md](../DEPLOYMENT.md) for the full launch checklist.
>
> **Only expose two directories:** `ui/dist` and `backend/public`. **Never** let the web server reach `backend/storage` (per-form SQLite response DBs + uploads), `backend/logs`, or any `.env` — those hold your data and secrets.

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
The [package workflow](../.github/workflows/package.yml) runs the same script on every `v*` tag — attaching the zip to the GitHub release — and on demand via *Run workflow*.

## Tests and checks

### Backend (PHPUnit)

```bash
cd backend
composer test          # runs phpunit (unit + integration suites, tests/)
php -l path/to/File.php   # quick syntax check on a single file
```

### Frontend

```bash
cd ui
npm run test           # vitest run (unit tests, single pass)
npm run test:unit      # vitest in watch mode
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
| Build | Vite 7 |
| Styling | Tailwind CSS 4 |
| State | Zustand 5 (persisted stores) |
| Routing | React Router 7 |
| Charts | recharts (widget dashboards + reports) |
| Drag & Drop | @dnd-kit |
| Animation | Framer Motion |
| Icons | Lucide React |
| PWA | vite-plugin-pwa |
| Scripting (browser) | QuickJS (`quickjs-emscripten`) in a Web Worker |

### Backend

| Layer | Technology |
|-------|-----------|
| Framework | PHP 8.2+ / Slim 4 |
| Auth | HttpOnly cookie sessions (JWT-signed) + scoped API keys + ephemeral MCP tokens |
| Database | MySQL (global metadata) + SQLite (per-form responses) |
| Logging | Monolog |
| DI | PHP-DI |
| Scripting (server) | QuickJS (vendored static `qjs` binary, no Node.js) |
| Signing | Ed25519 via libsodium (packages + client manifests) |

### Scripting engine

FormLogic runs user expressions and `onSubmit` scripts as real JavaScript inside a **QuickJS** sandbox, using one engine and one shared standard-library prelude on both sides (so client and server results match by construction):

- **Browser** — [`quickjs-emscripten`](https://github.com/justjake/quickjs-emscripten) runs in a dedicated Web Worker for real-time validation, conditional logic, and calculated fields, with memory/stack/interrupt limits and a terminate watchdog.
- **Server** — a vendored static [`qjs`](https://github.com/quickjs-ng/quickjs) binary (under `backend/bin/qjs/`, selected per-OS) invoked by `QuickJsRunner` via `proc_open`. `onSubmit` `ctx.db`/`ctx.http`/`ctx.utils` calls are handled in PHP over a synchronous RPC, keeping the SSRF/DNS-pinning guards on the trusted side.

Untrusted code runs with an empty global and zero host bindings; runaway scripts are killed by the watchdog. The same sandbox also runs app-level and form-level **custom logic** in the app runtime (effect + permission model — see [docs/CUSTOM_APP_PLATFORM.md](../docs/CUSTOM_APP_PLATFORM.md#app-logic-quickjs)).

**Edit the prelude only at `ui/src/lib/formlogic/prelude.js`** — the build's `prebuild` step (`npm run sync:prelude`) syncs it into `backend/resources/`.

## Project structure

```
formlogic/
├── install.php                    # Browser install wizard (delete after install)
├── install.sh                     # CLI install script (Linux / macOS / Git Bash)
├── backend/
│   ├── public/index.php           # All routes, DI container, middleware wiring
│   ├── config/settings.php        # Environment config
│   ├── database/schema.sql        # MySQL schema export (+ migrate.php)
│   ├── bin/qjs/                   # Vendored static qjs binaries (server-side sandbox)
│   ├── resources/                 # Synced prelude + bundled sample apps
│   ├── scripts/                   # provision-demo.php (demo account seeder)
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
│   ├── scripts/                   # sync-prelude, emit-marketplace, screenshot/QA tooling
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
│       ├── lib/formlogic/         # QuickJS engine wrapper (Web Worker) + shared prelude
│       ├── types/                 # TypeScript interfaces (form, app, custom logic)
│       └── data/packs/            # The 29 marketplace pack bundles
│
├── native-runtime/                # Tauri v2 shell (Rust) — see its README
└── README.md                      # This file
```

## Architecture notes

- **Dual database** — MySQL holds users, forms (metadata + field definitions), apps, roles, permissions, audit log, webhooks, and response metadata; each form's response data lives in its **own SQLite file**, which isolates forms and makes per-form export trivial.
- **One backend, many portals** — a form can be attached to many apps (`app_forms` many-to-many) and every app reads/writes the same records; member payloads are filtered server-side by role. See [docs/ONE_BACKEND_MANY_PORTALS.md](../docs/ONE_BACKEND_MANY_PORTALS.md).
- **Auth** — HttpOnly cookies with JWT-signed tokens; CSRF via double-submit cookie, validated on state-changing requests.
- **Storage modes** — forms can live in browser localStorage (no account) or sync to the backend; the preference persists.
- **Scripting** — conditional visibility, custom validation, calculated fields, and a server-authoritative `onSubmit` script that can read the record (`ctx.answers` / `ctx.db.getField`), write derived fields (`ctx.db.setField`), set tags/status, or reject. Scripts run **synchronously** (don't `await` `ctx.http`/`ctx.db`). `hidden` fields are the natural home for computed output.

## Environment variables

The authoritative, fully annotated list is **`backend/.env.example`** (mail/SMTP, PayPal billing, beta mode, cloud plan limits, trusted proxies, support email, and more). The core ones:

### Backend (`backend/.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_ENV` | `development` | `development` or `production` |
| `APP_DEBUG` | `true` | Show detailed errors (disable in production) |
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
| `AI_BASE_URL` | | OpenAI-compatible API base URL — OpenAI, Azure, or a local server (LM Studio / Ollama / vLLM) |
| `AI_API_KEY` | | API key; optional — leave blank for a keyless local server |
| `AI_MODEL` | `gpt-4o` | Text model for AI generation |
| `AI_VISION_MODEL` | `gpt-4o` | Vision model for image/document extraction (defaults to `AI_MODEL`) |
| `AI_ENABLED` | `true` | Set `false` to disable the built-in AI entirely (steers users to bring their own AI via MCP) |
| `REQUIRE_VERIFIED_PACKAGES` | `false` | Require a verified signature on every package/pack import |

Legacy `OPENAI_API_KEY` / `OPENAI_API_URL` / `OPENAI_MODEL` names are still honored as fallbacks for the `AI_*` variables.

### Frontend (`ui/.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `http://localhost:8080/api` | Backend API URL (dev default; use `/api` for same-domain production) |
| `VITE_PUBLIC_DOMAIN` | `formlogic.com` | Domain shown in landing-page mockups + sales contact (baked in at build time) |

## API overview

Three ways in, all documented elsewhere:

- **Internal API** (`/api/...`) — cookie-authenticated; everything the SPA does: auth, forms, responses, apps (incl. companion apps, form relations, custom domains, signed exports), app runtime (incl. `sync/batch` offline sync, activity, reports), packs/marketplace, billing. Routes are all declared in `backend/public/index.php`.
- **External REST API** (`/api/v1/...`) — API-key authenticated (`Authorization: Bearer flk_…`, scoped keys created in Settings → API keys). Submissions run the full pipeline including the `onSubmit` script. Full reference: **[docs/API.md](../docs/API.md)**.
- **MCP server** (`POST /api/mcp`) — short-lived scoped tokens for external AI clients (Claude, Cursor, …) to build and edit apps. Setup + tool list: **[docs/MCP.md](../docs/MCP.md)**.

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
- **Sandboxed scripting** — user scripts run in an isolated QuickJS sandbox with instruction-count, wall-clock, memory, and call-depth limits, and no `eval`, DOM, or filesystem access
- **Signed packages & manifests** — Ed25519 signatures over `.formlogic` exports and client manifests; tampered archives are rejected on import
- **Hash-chained audit log** with HMAC-SHA256 integrity verification (`GET /api/admin/audit/verify`)
- **Body size limits** on uploads; **User-Agent sanitization** against stored XSS

## Troubleshooting

### "SECURITY ERROR: JWT_SECRET must be set" on first request
`APP_ENV` is `production` but `JWT_SECRET` is empty. Either set `APP_ENV=development` in `backend/.env` for local development, or generate a secret (`php -r "echo bin2hex(random_bytes(32));"`) and set it.

### CORS errors in the browser console
Update `CORS_ORIGIN` in `backend/.env` to match your frontend URL (e.g. `http://localhost:5173` for dev).

### Scripting (form logic / validation / calculations) not running
- **Browser:** make sure `npm install` completed in `ui/` — it pulls `quickjs-emscripten` (the WASM engine). There is no separate download step.
- **Server:** ensure the vendored `qjs` binary exists under `backend/bin/qjs/` for your OS (it's committed in the repo). On macOS/Linux it must be executable (`chmod +x backend/bin/qjs/qjs-linux-x86_64`; `install.sh` does this). The prelude is synced to `backend/resources/` by the `prebuild` step of `npm run build`.

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
Set `AI_BASE_URL` (and `AI_API_KEY` if your provider needs one) in `backend/.env` — any OpenAI-compatible endpoint works, including keyless local servers. Check `GET /api/ai/status`. Note that in production an API key is never sent over plain `http://` (keyless local servers are fine).

## Upstream scripting runtime

- **[quickjs-emscripten](https://github.com/justjake/quickjs-emscripten)** — QuickJS compiled to WASM, used in the browser (via npm)
- **[quickjs-ng](https://github.com/quickjs-ng/quickjs)** — source of the vendored static `qjs` binary used on the server

## License

Proprietary, source-available. Free to self-host and modify for your own use; selling or offering it as a paid/hosted service requires a commercial agreement. See [LICENSE](../LICENSE).
