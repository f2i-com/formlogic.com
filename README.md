# FormLogic

A full-stack form builder and internal apps platform. Build forms with drag-and-drop, add scripting logic for validation and calculations, deploy multi-form applications with role-based access control, and collect responses with analytics.

## Overview

FormLogic combines a Typeform-style form builder with an internal apps platform. Forms support conditional logic, calculated fields, and custom validation powered by a sandboxed scripting engine. Multiple forms can be composed into deployable applications with user management, roles, and permissions.

### Key Capabilities

- **Form Builder** -- Drag-and-drop editor with 20+ field types, live preview, theme customization
- **Scripting Engine** -- Custom language (FormLogic) for conditional logic, validation expressions, calculated fields, and post-submission scripts
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
| Scripting | FormLogic VM (custom bytecode interpreter) |
| DI | PHP-DI |

### Scripting Engine

FormLogic includes a custom scripting language with both a TypeScript implementation (frontend) and a PHP implementation (backend). Scripts run in a sandboxed bytecode VM with memory limits -- no `eval()` or system access.

Built-in modules: `format`, `compliance`, `finance`

---

## Project Structure

```
formlogic-app/
├── form-builder/
│   ├── backend/
│   │   ├── public/index.php          # Routes, DI container, middleware
│   │   ├── config/settings.php       # Environment config
│   │   └── src/
│   │       ├── Controllers/           # 9 controllers (Auth, Form, Response, App, AI, Pack, Webhook...)
│   │       ├── Services/              # 17 services (FormLogicRuntime, AuditService, PackService...)
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
│           ├── stores/                # 6 Zustand stores (auth, form, app, response, runtime, ui)
│           ├── hooks/                 # Custom hooks (keyboard shortcuts, NIGO, online status)
│           ├── lib/
│           │   └── formlogic/         # Engine wrapper + compliance/finance modules
│           ├── types/                 # TypeScript interfaces (form, app)
│           └── data/
│               ├── formTemplates.ts   # Built-in form templates
│               └── packs/             # Pre-built pack bundles (Finance OS)
│
├── formlogic-typescript/              # Scripting engine (TypeScript/browser)
└── formlogic-php/                     # Scripting engine (PHP/server)
```

---

## Getting Started

### Prerequisites

- PHP 8.1+
- MySQL 8.0+
- Node.js 18+
- Composer

### Backend Setup

```bash
cd form-builder/backend

# Install dependencies
composer install

# Configure environment
cp .env.example .env
# Edit .env with your MySQL credentials, JWT secret, etc.

# Start development server
composer start
# API available at http://localhost:8080/api
```

### Frontend Setup

```bash
cd form-builder/ui

# Install dependencies
npm install

# Start development server
npm run dev
# App available at http://localhost:5173

# Production build
npm run build
```

### Database

MySQL tables are auto-created on first request via `MySQLConnection::initialize()`. Per-form SQLite databases are created on demand in the configured storage directory.

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

The scripting engine supports:
- **Conditional visibility** -- Show/hide fields based on expressions (`age >= 18 && country === "US"`)
- **Custom validation** -- Validate fields with expressions that return error messages
- **Calculated fields** -- Compute values from other fields (`price * quantity * (1 + tax_rate)`)
- **Post-submission scripts** -- Run logic after form submission (compute derived fields, set tags, reject submissions)

Script modules extend the language with domain functions:
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
- **Sandboxed scripting** -- FormLogic VM runs in isolated bytecode with memory limits (1MB string, 100K array)
- **Hash-chained audit log** with SHA-256 integrity verification
- **Body size limits** on uploads

---

## License

Proprietary. All rights reserved.
