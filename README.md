# FormLogic

A full-stack form builder and internal apps platform. Build forms with drag-and-drop, add scripting logic for validation and calculations, deploy multi-form applications with role-based access control, and collect responses with analytics.

![FormLogic form builder — drag-and-drop canvas, field palette, and per-field settings](docs/images/builder.png)

<p align="center">
  <img src="docs/images/public-form.png" width="49%" alt="Public form fill — focused, one-question-at-a-time mode" />
  &nbsp;
  <img src="docs/images/app-runtime.png" width="49%" alt="Internal app runtime — multi-form app with RBAC" />
</p>
<p align="center">
  <img src="docs/images/doctor.png" width="49%" alt="Doctor — admin health diagnostics" />
  &nbsp;
  <img src="docs/images/landing.png" width="49%" alt="Landing page" />
</p>

<p align="center"><sub>Form builder · public form (focused mode) · internal app runtime · Doctor diagnostics · landing</sub></p>

## Overview

FormLogic combines a Typeform-style form builder with an internal apps platform. Forms support conditional logic, calculated fields, and custom validation powered by a sandboxed JavaScript (QuickJS) runtime. Multiple forms can be composed into deployable applications with user management, roles, and permissions.

### Key Capabilities

- **Form Builder** -- Drag-and-drop editor with 20+ field types, live preview, theme customization
- **Scripting Engine** -- Real JavaScript, sandboxed with QuickJS, for conditional logic, validation, calculated fields, and post-submission (`onSubmit`) scripts — the same engine and standard-library prelude run in the browser and on the server
- **Internal Apps** -- Compose forms into multi-form applications with navigation, RBAC, and linked records
- **Compliance Modules** -- Built-in `compliance` and `finance` script modules for Reg BI checks, suitability scoring, AML flags, AUM fee calculations, and more
- **Pack System** -- Import/export pre-built form + app bundles (e.g., Finance OS Pack with 12 templates and 2 apps)
- **Response Management** -- View, edit, export (CSV/JSON/SQLite), and bulk-import responses
- **Analytics** -- Per-form response charts, completion rates, average times, field breakdowns
- **Webhooks** -- Trigger HTTP callbacks on form submissions with delivery tracking
- **Versioning** -- Form version history with restore capability
- **Audit Trail** -- Immutable, hash-chained audit log with integrity verification
- **NIGO Dashboard** -- Real-time "Not In Good Order" field completion tracker for compliance workflows
- **AI Generation** -- Generate forms from text prompts, documents, or images (requires AI provider config)
- **PWA Support** -- Offline-capable progressive web app with service worker

---

## Tech Stack

### Frontend

| Layer | Technology |
|-------|-----------|
| Framework | React 19 + TypeScript |
| Build | Vite 7 |
| Styling | Tailwind CSS 4 |
| State | Zustand 5 (persisted stores) |
| Routing | React Router 7 |
| Drag & Drop | @dnd-kit |
| Animation | Framer Motion |
| Icons | Lucide React |
| PWA | vite-plugin-pwa |

### Backend

| Layer | Technology |
|-------|-----------|
| Framework | PHP 8.1+ / Slim 4 |
| Auth | HttpOnly cookie sessions (JWT-signed) |
| Database | MySQL (global metadata) + SQLite (per-form responses) |
| Logging | Monolog |
| Scripting | QuickJS sandbox (vendored static `qjs` binary — no Node.js) |
| DI | PHP-DI |

### Scripting Engine

FormLogic expressions and `onSubmit` scripts are **real JavaScript** run inside a sandboxed [QuickJS](https://github.com/quickjs-ng/quickjs) engine — one engine and one shared standard-library prelude (`ui/src/lib/formlogic/prelude.js`) on both the client and the server:

- **Browser** -- [`quickjs-emscripten`](https://github.com/justjake/quickjs-emscripten) runs the engine in a dedicated Web Worker for real-time validation, conditional logic, and calculated-field previews.
- **Server** -- the PHP API shells out to a vendored static `qjs` binary (committed under `backend/bin/qjs/`, selected per-OS); a `prebuild` step syncs the prelude into `backend/resources/`. **No Node.js is required on the server.**

The sandbox enforces instruction-count, wall-clock, memory, and call-depth limits, and exposes no `eval`, DOM, or filesystem access (field expressions also have no network; `onSubmit` scripts additionally get a server-brokered, SSRF-guarded `ctx.http` for external API calls). The shared prelude ships built-in helper modules: `validators`, `format`, `compliance`, `finance`, and `safety`.

---

## Project Structure

```
formlogic-app/
├── form-builder/
│   ├── backend/
│   │   ├── public/index.php          # Routes, DI container, middleware
│   │   ├── config/settings.php       # Environment config
│   │   └── src/
│   │       ├── Controllers/           # Auth, Form, Response, App, AI, Pack, Webhook, ...
│   │       ├── Services/              # FormLogicRuntime, QuickJsRunner, AuditService, PackService, ...
│   │       ├── Middleware/            # 6 middleware (Auth, CORS, CSRF, RateLimit, Security, BodySize)
│   │       ├── Models/                # 6 models
│   │       ├── Database/              # MySQLConnection + SQLiteConnection
│   │       ├── Constants/             # AppPermissions
│   │       └── Helpers/               # IpResolver
│   │
│   └── ui/
│       └── src/
│           ├── pages/                 # 11 pages + 9 app admin pages
│           ├── components/
│           │   ├── app-runtime/       # Internal app runtime (data tables, form views, auth guards)
│           │   ├── builder/           # Form builder (field palette, script editor, NIGO dashboard...)
│           │   ├── layout/            # App shell, sidebar, header
│           │   └── ui/                # Shared UI components (buttons, modals, toasts...)
│           ├── stores/                # Zustand stores (auth, form, app, response, runtime, ui, ...)
│           ├── hooks/                 # Custom hooks (keyboard shortcuts, NIGO, online status)
│           ├── lib/
│           │   └── formlogic/         # QuickJS engine wrapper, Web Worker + shared prelude
│           ├── types/                 # TypeScript interfaces (form, app)
│           └── data/
│               ├── formTemplates.ts   # Built-in form templates
│               └── packs/             # Pre-built pack bundles (Finance OS)
```

> The FormLogic scripting engine is embedded in `form-builder/`: the browser side in
> `ui/src/lib/formlogic/` (QuickJS via `quickjs-emscripten`, run in a Web Worker) and
> the server side in `backend/bin/qjs/` + `backend/resources/` (a vendored static
> `qjs` binary). Both run the same JavaScript and share one prelude — no Node.js on
> the server.

---

## Getting Started

### Prerequisites

- PHP 8.1+ with the `pdo_mysql`, `pdo_sqlite`, `mbstring`, `json`, `openssl`, and `fileinfo` extensions
- MySQL 8.0+
- Node.js 20.19+ or 22.12+ (required by Vite 7)
- Composer

### Easy install (recommended)

Two assisted installers live in `form-builder/` — both create the `.env` files, generate
security keys, and set up the database for you:

- **Web wizard (WAMP / XAMPP / any PHP web server):** serve the repo from your web root
  and open `http://localhost/<your-folder>/form-builder/install.php` in a browser
  (for the default checkout that's `http://localhost/formlogic-app/form-builder/install.php`).
  It checks requirements, tests the DB connection, and writes config. **Delete
  `install.php` when you're done.**
- **CLI (macOS / Linux):**
  ```bash
  cd form-builder
  chmod +x install.sh && ./install.sh
  ```

Both still need `composer install` (backend) and `npm install` (frontend) — they tell you
which are outstanding. Prefer to do it by hand? Follow the manual steps below.

### Manual setup

**1. Create the database** (the app creates the tables, not the database):

```bash
mysql -u root -p -e "CREATE DATABASE formlogic CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

**2. Backend:**

```bash
cd form-builder/backend
composer install
cp .env.example .env
# Edit .env: set DB_DATABASE/DB_USERNAME/DB_PASSWORD, and a 32+ char JWT_SECRET
# (the installers generate JWT_SECRET + AUDIT_HMAC_KEY for you).
composer start
# API available at http://localhost:8080/api
```

MySQL *tables* are auto-created on the first request inside that database via
`MySQLConnection::initializeSchema()`; per-form SQLite databases are created on demand in
the configured storage directory.

**3. Frontend:**

```bash
cd form-builder/ui
npm install
npm run dev          # app at http://localhost:5173
npm run build        # production build
```

Then open <http://localhost:5173> and create your account.

### Going to production

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the production launch checklist, backup &
restore procedure, the webhook retry worker (cron), PayPal go-live steps, and the
`GET /api/health/deep` diagnostics endpoint.

---

## Architecture

### Dual Database Strategy

- **MySQL** -- Users, forms (metadata + field definitions), apps, roles, permissions, audit log, webhooks, response metadata, analytics aggregates
- **SQLite** (one file per form) -- Response data, computed fields, tags, script logs. Provides data isolation between forms and enables easy per-form export.

### Authentication

Session-based auth using HttpOnly cookies with JWT-signed tokens. The CSRF token is set as a readable cookie and validated on state-changing requests. Session expiry triggers automatic store cleanup on the frontend.

### Storage Modes

Forms can be stored in two modes:
- **Local** -- Forms persist in browser localStorage (no account required)
- **Cloud** -- Forms sync to the backend API (requires authentication)

The storage mode preference persists across sessions.

### Internal Apps Platform

Forms can be composed into deployable internal applications:

1. **Create an app** -- Name, description, theme, slug
2. **Add forms** -- Select which forms appear in the app's navigation
3. **Define roles** -- Create roles with granular per-form permissions (submit, view own, view all, edit, delete, export)
4. **Invite users** -- Users accept invitations and are assigned roles
5. **Deploy** -- Apps are accessible at `/app/{slug}` with their own auth guard, theme, and navigation

Linked record fields allow cross-form references within an app (e.g., a "Transfer Form" linking to a "Client Onboarding" record).

### FormLogic Scripting

Scripts and expressions are plain JavaScript, evaluated in the QuickJS sandbox described above. The engine supports:
- **Conditional visibility** -- Show/hide fields based on expressions (`age >= 18 && country === "US"`)
- **Custom validation** -- Validate fields with expressions that return error messages
- **Calculated fields** -- Compute values from other fields (`price * quantity * (1 + tax_rate)`)
- **Post-submission scripts** -- An `onSubmit` script runs after a submission to read the record (`ctx.answers` / `ctx.db.getField`), compute and write derived fields (`ctx.db.setField`), set tags/status, or reject the submission. Scripts run **synchronously** (don't `await` `ctx.http`/`ctx.db`).
- **Hidden fields** -- A `hidden` field stores a default, computed, or script-set value that respondents never see, but that's saved with the response and included in exports — the natural home for `onSubmit`/calculated output.

The shared prelude provides domain helper modules:
```
// Compliance module
compliance.regBICheck(risk_score, portfolio_type)
compliance.suitabilityScore(age, income, net_worth, risk_tolerance, time_horizon)
compliance.amlFlag(amount, frequency)
compliance.kycComplete(field1, field2, ...)

// Finance module
finance.aumFee(assets)
finance.riskScore(age, time_horizon, risk_tolerance)
finance.portfolioAllocation(risk_score)
finance.transferFee(amount, custodian)
```

---

## API Reference

### Auth
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/register` | No | Create account |
| POST | `/api/auth/login` | No | Login |
| POST | `/api/auth/logout` | No | Logout |
| GET | `/api/auth/me` | Yes | Current user |
| PUT | `/api/auth/me` | Yes | Update profile |

### Forms
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/forms` | Yes | List forms |
| POST | `/api/forms` | Yes | Create form |
| GET | `/api/forms/{id}` | Yes | Get form |
| PUT | `/api/forms/{id}` | Yes | Update form |
| DELETE | `/api/forms/{id}` | Yes | Delete form |
| POST | `/api/forms/{id}/duplicate` | Yes | Duplicate form |

### Responses
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/forms/{id}/responses` | No | Submit response (public) |
| GET | `/api/forms/{id}/responses` | Yes | List responses |
| POST | `/api/forms/{id}/responses/import` | Yes | CSV bulk import |
| GET | `/api/forms/{id}/responses/export` | Yes | Export CSV |
| GET | `/api/forms/{id}/analytics` | Yes | Form analytics |

### Apps
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/apps` | Yes | List apps |
| POST | `/api/apps` | Yes | Create app |
| PUT | `/api/apps/{id}` | Yes | Update app |
| DELETE | `/api/apps/{id}` | Yes | Delete app |
| POST | `/api/packs/import` | Yes | Import pack bundle |

### App Runtime
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/app/{slug}` | Yes | App config + forms + permissions |
| POST | `/api/app/{slug}/forms/{id}/responses` | Yes | Submit within app |
| GET | `/api/app/{slug}/forms/{id}/responses` | Yes | List within app |
| GET | `/api/app/{slug}/forms/{id}/lookup` | Yes | Linked record search |

### Admin
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/admin/audit/verify` | Yes | Verify audit chain integrity |
| GET | `/api/health` | No | Health check |

---

## Field Types

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

---

## Security

- **HttpOnly cookies** for session tokens (not accessible to JavaScript)
- **CSRF protection** with double-submit cookie pattern
- **Rate limiting** on auth endpoints (10/min) and submissions (30/min)
- **Security headers** (X-Content-Type-Options, X-Frame-Options, CSP, etc.)
- **Input validation** with type checking and constraint enforcement
- **Sandboxed scripting** -- user scripts run in an isolated QuickJS sandbox with instruction-count, wall-clock, memory, and call-depth limits, and no `eval`, DOM, or filesystem access (field expressions also have no network; `onSubmit` scripts additionally get a server-brokered, SSRF-guarded `ctx.http` for external API calls)
- **Hash-chained audit log** with HMAC-SHA256 integrity verification
- **Body size limits** on uploads

---

## License

Proprietary. All rights reserved.
