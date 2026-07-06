# FormLogic

**FormLogic is a self-hostable business app platform. Install a ready-made vertical app, customise forms and dashboards, collect linked records, generate reports and PDFs, and let your AI extend apps over MCP.**

Every app is *forms + workflow + a configurable dashboard + reports*, deployable with role-based access. Install a niche app from the marketplace (plumbing field service, salon bookings, café & restaurant ops, short-stay turnovers, fleet logbooks, retail, HR, OHS…), adapt it to your business, or point your own AI at it over MCP to generate and edit apps for you. Under the hood it's a full drag-and-drop form builder with a sandboxed JavaScript runtime, linked records, no-code widget dashboards, analytics, and audit logging.

![FormLogic form builder — drag-and-drop canvas, field palette, and per-field settings](docs/images/builder.png)

<p align="center">
  <img src="docs/images/public-form.png" width="49%" alt="Public form fill — focused, one-question-at-a-time mode" />
  &nbsp;
  <img src="docs/images/app-runtime.png" width="49%" alt="Business app runtime — multi-form app with RBAC" />
</p>
<p align="center">
  <img src="docs/images/doctor.png" width="49%" alt="Doctor — admin health diagnostics" />
  &nbsp;
  <img src="docs/images/landing.png" width="49%" alt="Landing page" />
</p>

<p align="center"><sub>Form builder · public form (focused mode) · business app runtime · Doctor diagnostics · landing</sub></p>

## Overview

FormLogic is built around a simple loop: **land → try the live demo → install a ready-made vertical app → customise it → hand it to your AI to improve → export/share it.** Each marketplace app bundles the forms, the workflow (roles, linked records, `onSubmit` scripts), and a configurable, drag-and-drop widget dashboard, so you start from a working business system rather than a blank canvas. It's fully self-hosted, with a Typeform-style builder and a sandboxed JavaScript (QuickJS) runtime underneath.

### Key Capabilities

- **App Marketplace** -- 28 ready-made vertical business apps, each a real working system (forms + workflow + configurable dashboard + demo data). Install in one click, customise, hand to your AI, or export as a portable `.json`. Browse by dynamic categories/tags. See [App Marketplace](#app-marketplace) below.
- **Live Demo** -- A no-signup shared Demo account with the whole marketplace pre-installed and populated, so dashboards are live on first look. *Launch the live demo* drops you into the full platform; visitors' changes (new records, new forms, settings) stay in *their* browser — the shared demo never gets polluted.
- **Configurable Dashboards** -- Every app screen — the home dashboard and each form's section screen — is a no-code, drag-and-drop grid of **recharts** widgets: KPIs, bar/line/area/pie/donut charts, record lists, and activity feeds. Edit a widget's query and chart type inline, exactly like a report — no code. (Advanced users can still drop to a sandboxed HTML/JS custom screen.)
- **Reports & PDFs** -- Each app has a no-code Reports section: compose bar, line, area, pie, donut, KPI, and table charts with grouping, measures, filters, and cross-form (linked-record) joins. Arrange charts and text blocks into exportable PDF documents.
- **Business Apps** -- Compose forms into multi-form applications with navigation, RBAC, linked records, and a configurable widget dashboard.
- **Build with AI / MCP** -- Generate forms/apps from a prompt, or connect an external AI (Claude, Cursor…) over MCP to build and edit whole apps — including forms, screens, and reports — for you. See [Build with your own AI (MCP)](#build-with-your-own-ai-mcp).
- **Form Builder** -- Drag-and-drop editor with 20+ field types, live preview, theme customization
- **Scripting Engine** -- Real JavaScript, sandboxed with QuickJS, for conditional logic, validation, calculated fields, and post-submission (`onSubmit`) scripts — the same engine and standard-library prelude run in the browser and on the server
- **Compliance Modules** -- Built-in `compliance` and `finance` script modules for Reg BI checks, suitability scoring, AML flags, AUM fee calculations, and more
- **Pack System** -- Every app is a portable pack (forms + apps + screens + scripts + reports); publish to the catalog, install into an account, or export/import as a single `.json` — reports included
- **Response Management** -- View, edit, export (CSV/JSON/SQLite), and bulk-import responses
- **Analytics** -- Per-form response charts, completion rates, average times, field breakdowns
- **Webhooks** -- Trigger HTTP callbacks on form submissions with delivery tracking
- **Versioning** -- Form version history with restore capability
- **Audit Trail** -- Immutable, hash-chained audit log with integrity verification
- **NIGO Dashboard** -- Real-time "Not In Good Order" field completion tracker for compliance workflows
- **AI Generation** -- Generate forms from text prompts, documents, or images (requires AI provider config)
- **PWA Support** -- Offline-capable progressive web app with service worker

---

## App Marketplace

FormLogic ships with a catalog of **28 ready-made vertical apps** — each one is a real, working business system (not a "Contact Us" form): several linked forms, role-based access, seeded demo data, and a configurable widget dashboard. Install one in a click, then customise it, hand it to your AI over MCP, or export it as a portable `.json`. The public **Live Demo** (no signup) has every app pre-installed and populated, so you can click straight into a working dashboard.

<p align="center">
  <img src="docs/images/packs/plumbing.png" width="49%" alt="Plumbing & Trades Field Service — invoiced-over-time, jobs-by-status, and recent jobs" />
  &nbsp;
  <img src="docs/images/packs/salon.png" width="49%" alt="Hair Salon & Beauty Studio — revenue KPIs, appointments by status, bookings over time" />
</p>
<p align="center">
  <img src="docs/images/packs/fitstudio.png" width="49%" alt="FitStudio — client and session KPIs, revenue trend, sessions by trainer" />
  &nbsp;
  <img src="docs/images/packs/stayready.png" width="49%" alt="StayReady — short-stay bookings, turnovers by status, guests hosted" />
</p>
<p align="center">
  <img src="docs/images/packs/brewdesk.png" width="49%" alt="BrewDesk — café orders over time, drinks by type, stock-to-reorder donut" />
  &nbsp;
  <img src="docs/images/packs/counterflow.png" width="49%" alt="CounterFlow — retail stock movements, products by category, recent movements" />
</p>
<p align="center">
  <img src="docs/images/packs/fleetflow.png" width="49%" alt="FleetFlow — trips over time, fleet by status donut, incidents by severity" />
  &nbsp;
  <img src="docs/images/packs/ohs.png" width="49%" alt="OHS & Quality Management — incidents by severity, incidents over time, recent incidents" />
</p>
<p align="center"><sub>Eight of the marketplace dashboards — Plumbing · Salon · FitStudio · StayReady · BrewDesk · CounterFlow · FleetFlow · OHS/QMS. Every dashboard is a no-code recharts widget grid and renders in light &amp; dark.</sub></p>

Browse by **dynamic categories and tags** derived from whatever's in the catalog (no hardcoded taxonomy) — publish your own packs and the browse chips update automatically.

| App | Category | What it runs |
|-----|----------|--------------|
| 🔧 Plumbing & Trades Field Service | Trades & Field Service | Customers → jobs → site visits → invoices → parts requests |
| 🚗 Mechanic Workshop Manager | Trades & Field Service | Customers → vehicles → job cards → parts → invoices |
| 🏠 Property Maintenance & Handyman | Trades & Field Service | Properties → tenants → requests → work orders → inspections |
| 🧹 CleanShift — Cleaning Scheduler | Trades & Field Service | Clients → teams → jobs → quality checks → supplies → issues |
| 🐾 PawRoute — Dog Walking & Pet Care | Trades & Field Service | Clients → pets → bookings → walks/visits → incidents & care notes |
| ☕ BrewDesk — Cafe & Barista Ops | Hospitality & Food | Orders → barista queue → menu → bean/milk stock → roster → daily close |
| 🍔 GrillStack — Burger Command Center | Hospitality & Food | Order board → kitchen pass → prep → stock → shifts → daily close |
| 🍽️ PassMaster — Restaurant Service | Hospitality & Food | Reservations → tables → orders → kitchen tickets → prep → shift close |
| 🎂 CaterCraft — Catering & Events | Hospitality & Food | Clients → menu packages → event pipeline → production → deliveries |
| 🛎️ StayReady — Short-Stay Turnover | Hospitality & Food | Properties → bookings → cleaner turnovers → inspections → supplies |
| 💇 Hair Salon & Beauty Studio | Beauty, Health & Fitness | Clients → services → stylists → appointments → product sales |
| 💪 FitStudio — Training & Coaching | Beauty, Health & Fitness | Clients → trainers → sessions → assessments → programs → payments |
| 🩺 Clinic Appointment & Intake | Beauty, Health & Fitness | Patients → providers → appointments → intake → follow-ups (front-desk) |
| 📦 Inventory & Purchase Orders | Retail & Operations | Products → suppliers → purchase orders → line items → stock movements |
| 🛍️ CounterFlow — Retail Store Ops | Retail & Operations | Products → suppliers → stock movements → store tasks → staff → returns |
| 🚚 FleetFlow — Fleet & Driver Log | Retail & Operations | Vehicles → drivers → trips → fuel → maintenance → incidents |
| ⛑️ OHS & Quality Management | Field Ops & Compliance | Incidents, hazards, audits, corrective actions, NCRs (ISO 45001 / 9001) |
| 🏗️ SitePulse — Construction Site Diary | Field Ops & Compliance | Projects → daily diaries → deliveries → defects → variations → insurances |
| 🌾 AgriLog — Farm Jobs & Harvest | Field Ops & Compliance | Paddocks → crop jobs → harvests → chemical register → machinery |
| 🎟️ VenueOps — Venue Hire & Bookings | Bookings & Education | Spaces → hirers → bookings → setups → payments → incidents |
| 📚 TutorTrack — Tutoring & Lessons | Bookings & Education | Students → tutors → lessons → progress notes → invoices |
| 🎉 Event Management | Bookings & Education | Registration, speakers, vendors, volunteers, incidents, budget, feedback |
| 🧾 Job & Invoice Management | Billing & Business | Clients → jobs → quotes → invoices → payments |
| 🛠️ RepairBench — Device Repair Shop | Billing & Business | Customers → devices → repair jobs → parts → quality sign-off → pickup |
| 👥 HR & People Management | Billing & Business | Recruitment, onboarding, leave, reviews, expenses, training, exits |
| 🎧 Customer Service | Billing & Business | Tickets, bugs, feature requests, feedback, refunds, escalations, KB |
| 🏦 Finance OS (US) | Finance | RIA/broker-dealer onboarding, compliance & advisory (Reg BI, Form CRS) |
| 🦘 Finance OS (AU) | Finance | AFSL advice, Best Interest Duty, super, AUSTRAC |

The Live Demo carries a few of these as multi-app packs (e.g. Finance OS ships onboarding **and** a portfolio/transition hub), so there are **34 installable demo apps** across the 28 catalog packs.

**Producing packs is a repeatable pipeline**: an AI author→review workflow generates the forms + linked records + widget dashboard + sample data, then each pack is verified (imports, renders light/dark, data populates, no dead KPIs) — including an automated screenshot vision-QA sweep — auto-screenshotted for the gallery, and published. New verticals are cheap to add.

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
│           ├── pages/                 # 24 pages + 9 app admin pages
│           ├── components/
│           │   ├── app-runtime/       # Business app runtime (data tables, form views, auth guards)
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
│               └── packs/             # 28 marketplace pack bundles (forms + apps + widget dashboards)
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

### Business Apps Platform

Forms can be composed into deployable business applications:

1. **Create an app** -- Name, description, theme, slug
2. **Add forms** -- Select which forms appear in the app's navigation
3. **Define roles** -- Create roles with granular per-form permissions (submit, view own, view all, edit, delete, export)
4. **Invite users** -- Users accept invitations and are assigned roles
5. **Deploy** -- Apps are accessible at `/app/{slug}` with their own auth guard, theme, and navigation

Linked record fields allow cross-form references within an app (e.g., a "Transfer Form" linking to a "Client Onboarding" record).

Several apps can share the same forms — e.g. a client portal and an admin console reading and writing the same records. See **[docs/ONE_BACKEND_MANY_PORTALS.md](docs/ONE_BACKEND_MANY_PORTALS.md)** for the model.

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

### Programmatic API (API keys)

External REST API for accessing forms with an **API key** (created in **Settings → API keys**), sent
as `Authorization: Bearer flk_…`. Submissions run the **full pipeline — validation, calculated
fields, and your `onSubmit` script** — identical to a browser submission.

| Method | Endpoint | Scope |
|--------|----------|-------|
| GET | `/api/v1/forms`, `/forms/{id}`, `/forms/{id}/fields` | `forms:read` |
| POST | `/api/v1/forms/{id}/responses`, `/responses/batch` | `responses:write` |
| GET | `/api/v1/forms/{id}/responses`, `/responses/{rid}`, `/analytics` | `responses:read` |
| PUT, DELETE | `/api/v1/forms/{id}/responses/{rid}` | `responses:manage` |
| GET, POST, PUT, DELETE | `/api/v1/forms/{id}/webhooks` | `webhooks:read` / `webhooks:write` |

See **[docs/API.md](docs/API.md)** for the full reference — scopes, request/response shapes,
examples, and error codes.

### Build with your own AI (MCP)

FormLogic also ships an **MCP server** (Model Context Protocol, over HTTP) so you can point your own AI
— Claude Desktop, Claude Code, Cursor, … — at FormLogic and have it build/edit forms, write custom
screens, and wire up an app. Start from **Connect an AI** (Settings, an app's *Manage* tab, or
*"Hand to an AI"* on the Apps page): you get a short‑lived, scoped bearer token (1h TTL, 15m idle,
revocable) and a ready‑to‑paste client config pointing at `/api/mcp`. Default tokens can build but
**cannot read submission data**; app‑scoped tokens are restricted to that one app. Set `AI_ENABLED=false`
to disable the built‑in AI and steer everyone to bring‑your‑own.

See **[docs/MCP.md](docs/MCP.md)** for the connection steps, scopes, and the full tool list.

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
