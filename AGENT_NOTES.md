# FormLogic — Comprehensive Agent Notes

> Full project reference covering backend and frontend. Last updated: 2026-06-29.

---

## Table of Contents

### Part 1: Project Overview
1. [Architecture Overview](#architecture-overview)
2. [Project Structure](#project-structure)
3. [Key Architectural Patterns](#key-architectural-patterns)

### Part 2: Backend (`form-builder/backend/`)
4. [Configuration & Entry Point](#configuration--entry-point)
5. [Database Layer](#database-layer)
6. [Models](#models)
7. [Middleware](#middleware)
8. [Controllers](#controllers)
9. [Services](#services)
10. [Helpers & Constants](#helpers--constants)
11. [Routes & DI Container](#routes--di-container)

### Part 3: Frontend (`form-builder/ui/src/`)
12. [Stores](#stores)
13. [Types](#types)
14. [API Client](#api-client)
15. [Hooks](#hooks)
16. [Lib Utilities](#lib-utilities)
17. [FormLogic Scripting Engine](#formlogic-scripting-engine)
18. [Data Files](#data-files)
19. [Pages](#pages)
20. [Components](#components)

---

# Part 1: Project Overview

## Architecture Overview

- **Backend**: PHP Slim 4 with PHP-DI container (`form-builder/backend/`)
- **Frontend**: React 18 + TypeScript + Vite + Zustand (`form-builder/ui/`)
- **Dual Database**: MySQL (metadata, users, apps, analytics) + SQLite (per-form field definitions, responses, computed data)
- **Auth**: JWT via HttpOnly cookies (firebase/php-jwt, HS256), with Bearer header fallback for API clients
- **CSRF**: Double-submit cookie pattern (non-HttpOnly cookie readable by JS, matched against `X-CSRF-Token` header)
- **Scripting**: QuickJS sandbox running real JavaScript — `quickjs-emscripten` in a Web Worker (frontend) and a vendored static `qjs` binary (backend, no Node.js), sharing one standard-library prelude
- **Audit**: Hash-chained audit log with SHA256 integrity verification
- **RBAC**: Role-based access control with per-form permission granularity (Owner role always bypasses checks)
- **Webhooks**: HMAC-SHA256 signed deliveries with SSRF protection
- **AI**: OpenAI-compatible API for form generation (text, file, image), script generation/improvement
- **PWA**: Service worker with background sync for form submissions

## Project Structure

```
formlogic-app/
  form-builder/
    backend/
      public/index.php          # Entry point, DI container, routes
      config/settings.php       # Environment-based config
      src/
        Controllers/            # HTTP handlers (7 controllers)
        Services/               # Business logic (13 services)
        Database/               # MySQL + SQLite connection managers
        Models/                 # Data models (6 models)
        Middleware/              # Auth, CORS, CSRF, rate limiting, security headers
        Helpers/                # IpResolver
        Constants/              # AppPermissions
      storage/sqlite/           # Per-form SQLite databases
      logs/                     # Monolog rotating logs
    ui/
      src/
        pages/                  # Route-level components (13+ pages)
        components/
          builder/              # Form construction UX (18 exports)
          app-runtime/          # End-user app components (11 exports)
          ui/                   # Presentational primitives (20+ exports)
          layout/               # AppShell, Sidebar, Header, MobileNav
          auth/                 # AuthModal, UserMenu
        stores/                 # Zustand state management (8 stores)
        hooks/                  # Custom React hooks (4 hooks)
        lib/
          api.ts                # Singleton API client
          utils.ts              # Shared utilities
          formlogic/            # Scripting engine + modules
        types/                  # TypeScript type definitions
        data/                   # Templates, pack catalog
      public/                   # Static assets, PWA manifest
```

## Key Architectural Patterns

1. **Dual Database Architecture**: MySQL for relational metadata (users, forms, apps, audit, webhooks) and SQLite for per-form data (fields, responses, computed values, tags). Individual form databases can be exported, deleted, or backed up independently.

2. **Snapshot-Before-Update Versioning**: When a form is updated, the current state is snapshotted to `form_versions` before the update is applied. Restoration also creates a snapshot first.

3. **Script Execution Pipeline**: On response creation: validate answers -> run the form's `onSubmit` script in the QuickJS sandbox -> handle rejection or capture computed fields/tags/status -> save response -> save computed data -> sync to MySQL metadata -> update analytics -> dispatch webhooks.

4. **SSRF Protection**: Applied consistently across webhook delivery, HTTP module in FormLogic runtime, and AI image URL validation. Uses DNS resolution + private IP blocking.

5. **Hash-Chained Audit Log**: Each audit entry's integrity hash includes the previous entry's hash, creating a tamper-evident chain verifiable via `AuditService::verifyChain()`.

6. **Compensating Transactions**: Since SQLite and MySQL cannot share a transaction, the system uses compensating deletes when MySQL operations fail after SQLite inserts succeed.

7. **Owner Bypass**: In the RBAC system, the Owner role always returns `true` for `hasPermission()` checks, bypassing all permission lookups.

8. **Pack Import with ID Remapping**: When importing packs, all form IDs and linked record references are remapped to new UUIDs, with a `formIdMap` maintaining the old-to-new mapping.

9. **Rate Limiting Layers**: Multiple independent rate limiters at different granularities: global auth (10/60s), form creation (20/60s), public submissions (30/60s), public form viewing (60/60s), plus login-specific dual rate limiting (per IP+email and per email alone). In-memory per-process — not suitable for multi-server production.

10. **Cookie-First Auth with Header Fallback**: Browser clients use HttpOnly cookies (immune to XSS token theft) + CSRF double-submit. API clients can use Bearer tokens in the Authorization header.

11. **Optimistic UI with Debounced Sync**: Frontend stores use optimistic updates for instant UX, then debounce API sync (1s delay). Per-form debounce timers prevent overlapping saves.

12. **Lazy Loading with Retry**: Heavy pages use `React.lazy()` wrapped in a retry mechanism (one reload attempt via sessionStorage flag) to handle chunk loading failures.

---

# Part 2: Backend

## Configuration & Entry Point

### `composer.json`

- **PSR-4 Autoload**: `FormLogic\` => `src/`
- **Dependencies**: `slim/slim` ^4.12, `php-di/slim-bridge`, `slim/psr7`, `monolog/monolog` ^3.5, `firebase/php-jwt` ^7.0, `vlucas/phpdotenv` ^5.6, `respect/validation` ^2.3. FormLogic expressions and `onSubmit` scripts run via the bundled QuickJS runtime (vendored `qjs` binary under `backend/bin/qjs`, invoked by `QuickJsRunner`), not a Composer package.
- **Minimum PHP**: 8.1

### `.env.example`

| Variable | Default / Notes |
|---|---|
| `APP_ENV` | `development` |
| `DB_HOST` / `DB_PORT` / `DB_DATABASE` / `DB_USERNAME` / `DB_PASSWORD` | MySQL config |
| `SQLITE_STORAGE_PATH` | `./storage/sqlite` |
| `JWT_SECRET` | Must be >= 32 chars in production |
| `JWT_EXPIRY` | `86400` (seconds) |
| `COOKIE_DOMAIN` | `localhost` |
| `CORS_ORIGIN` | `http://localhost:5173` |
| `CORS_ALLOWED_ORIGINS` | Comma-separated list (optional) |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_DECAY_MINUTES` | `5` / `15` |
| `UPLOAD_MAX_FILE_SIZE` | `10485760` (10MB) |
| `TRUSTED_PROXIES` | Comma-separated IPs/CIDRs |
| `OPENAI_API_KEY` / `OPENAI_API_URL` / `OPENAI_MODEL` / `OPENAI_VISION_MODEL` | AI features |

### `config/settings.php`

- **Production safety checks**: Fails hard if `JWT_SECRET` is default or < 32 chars, or if `DB_PASSWORD` is `"password"`
- **Logger**: Monolog with `RotatingFileHandler` (30-day retention); adds `StreamHandler(stderr)` in development
- **Cookie**: `formlogic_auth`, HttpOnly, `SameSite=Lax`, `Secure=true` only in production
- **Uploads**: Allowed MIME types: PDF, Word docs, PNG, JPEG, GIF, WEBP

### `public/index.php`

Entry point. Sets up Dotenv, PHP-DI Container, Slim App via `Bridge::create()`. Global middleware stack (bottom-to-top): `BodySizeLimitMiddleware` (1MB) -> `SecurityHeadersMiddleware` -> `CorsMiddleware` -> `CsrfMiddleware` -> Body parsing -> Error middleware (custom JSON handler with Monolog).

---

## Database Layer

### `src/Database/MySQLConnection.php`

**Singleton** PDO connection. Creates all tables via `initializeSchema()`:

| Table | Key Purpose |
|---|---|
| `users` | User accounts (email UNIQUE, bcrypt password_hash) |
| `forms` | Form metadata (user_id FK, status enum, settings/theme JSON, logic_script) |
| `form_versions` | Snapshot versioning (form_id FK, version INT, data JSON) |
| `api_tokens` | API key auth (token_hash, expires_at) |
| `response_metadata` | Global response index (form_id FK, status enum, ip_address) |
| `form_analytics` | Daily stats (views, starts, completions, avg_completion_time) |
| `apps` | Internal apps (owner_id FK, slug UNIQUE, settings/theme/nav_config JSON) |
| `app_forms` | App-form junction (app_id + form_id UNIQUE, display_name, sort_order) |
| `app_roles` | RBAC roles (app_id FK, is_system bool) |
| `app_role_permissions` | Permission assignments (role_id FK, form_id nullable, permission) |
| `app_users` | App membership (app_id + user_id UNIQUE, role_id FK, status enum) |
| `app_user_groups` / `app_user_group_members` | User grouping |
| `app_invitations` | Invitation tokens (SHA256 hashed, 7-day expiry) |
| `response_links` | Denormalized linked record refs for fast inverse lookups |
| `webhooks` / `webhook_deliveries` | Webhook config + delivery logs |
| `audit_log` | Hash-chained audit trail (integrity_hash, sequence_number UNIQUE) |
| `audit_sequence` | Monotonic sequence generator for audit chain |

**`runMigrations()`**: Idempotent column additions (logic_script, logic_prompt, integrity_hash, sequence_number) checked via `SHOW COLUMNS`.

### `src/Database/SQLiteConnection.php`

Per-form SQLite databases. Each form gets its own `.sqlite` file.

- **UUID IDs**: Uses UUID directly as filename
- **Non-UUID IDs**: `sanitized_prefix_sha256hash.sqlite` to prevent directory traversal
- Caches connections in memory. Enables `PRAGMA foreign_keys = ON`

Per-form tables: `form_data` (key-value), `fields` (type, label, properties JSON), `responses` (answers JSON, status, metadata), `field_groups`, `computed` (response_id FK, field_name, field_value), `tags` (response_id FK, tag), `script_logs` (execution metrics).

---

## Models

| Model | Key Fields | Notes |
|---|---|---|
| `User` | id, email, name?, passwordHash? | `toArray()` excludes passwordHash by default |
| `Form` | id, title, userId?, status, fields[], settings[], theme[], logicScript? | `fromArray()` handles both snake_case and camelCase; JSON-decodes strings |
| `App` | id, name, slug, ownerId?, status, settings[], theme[], navConfig[] | Similar dual-case handling |
| `AppRole` | id, appId, name, isSystem, sortOrder | System roles cannot be renamed/deleted |
| `AppUser` | id, appId, userId, roleId, status | Status: pending/active/suspended |
| `AppUserGroup` | id, appId, name, description? | — |

---

## Middleware

### `AuthMiddleware`
JWT auth supporting required and optional modes. Token extraction: `Authorization: Bearer` header first, then `formlogic_auth` cookie. Sets `user` and `userId` request attributes.

### `BodySizeLimitMiddleware`
Default 1MB. Checks `Content-Length` header (fast path), then `$body->getSize()`, then reads `maxBytes + 1` bytes for streaming. Returns 413.

### `CorsMiddleware`
Single-origin and multi-origin modes. Supports wildcard subdomains (`*.example.com`). Sets `Access-Control-Allow-Credentials: true` for non-wildcard. OPTIONS preflight returns immediately.

### `CsrfMiddleware`
Double-submit cookie. Only on POST/PUT/PATCH/DELETE. Exempt: login, register, logout, public form submission. Skips if no auth cookie present. `hash_equals()` for timing-safe comparison.

### `RateLimitMiddleware`
In-memory sliding window. Key: `prefix:sha256(client_ip)`. Adds `X-RateLimit-*` headers. Returns 429 with `Retry-After`. **Per-process storage — resets on restart.**

### `SecurityHeadersMiddleware`
X-Frame-Options: DENY, X-Content-Type-Options: nosniff, CSP, Referrer-Policy. Production adds HSTS.

---

## Controllers

### `AuthController`
- `POST /api/auth/register` — Validates email/password (min 8), sets auth + CSRF cookies
- `POST /api/auth/login` — Rate-limited by IP+email and by email alone
- `GET /api/auth/me` — Returns current user from middleware attribute
- `PUT /api/auth/me` — Updates name/email/password
- `POST /api/auth/logout` — Clears cookies

Error handling: `RuntimeException` -> 400, "Rate limit" messages -> 429, others -> 500.

### `FormController`
- `GET /api/forms` — Cursor-based pagination (`?cursor=updated_at|id`), status filter, limit 1-1000
- `POST /api/forms` — Validates: title string <=500, status enum, fields array. Defaults "Untitled Form"
- `PUT /api/forms/{id}` — Snapshots current state to `form_versions` before update. Extracts `_changelog` from body
- `DELETE /api/forms/{id}` — Auth + ownership check
- `POST /api/forms/{id}/duplicate` — Rate-limited alongside create
- Version endpoints: list, get, restore

### `ResponseController`
- `POST /api/forms/{formId}/responses` — **Public endpoint**. Checks form published. Validates answers against field definitions. Runs the form's `onSubmit` script (QuickJS). Handles `ScriptRejection` with 422
- `GET .../responses` — Auth + form ownership. Filters: status, from/to dates, limit/offset
- `POST .../responses/import` — Two-phase CSV: without mapping = preview, with mapping = import
- Export: CSV, SQLite file download, JSON download
- `POST .../responses/{id}/recompute` — Re-runs script on existing response

**`validateAnswers()`**: Validates required, email (FILTER_VALIDATE_EMAIL), url, number (is_numeric + min/max), phone (regex + length), date (strtotime), rating, scale, dropdown/multiple_choice (against options), checkboxes (array against options), short_text (500), long_text (10000).

### `AIController`
- `GET /api/ai/status` — Public. Checks OPENAI_API_KEY configured
- `POST /api/ai/generate-form` — From text prompt
- `POST /api/ai/generate-form-from-file` — Multipart upload, server-side MIME detection, converts to images via DocumentConverter
- `POST /api/ai/generate-form-from-images` — Base64 images (max 10)
- `POST /api/ai/generate-script` / `improve-script` — Script generation with field context

### `AppController`
- CRUD for apps (owner only)
- Form management: add/remove/update/reorder forms in app (verifies form ownership)
- Audit events: `app.create`, `app.update`, `app.delete`, `app.form.add`, `app.form.remove`

### `AppUserController`
Permission-based access control (not just ownership). Groups: Roles (MANAGE_ROLES), Permissions, Users (MANAGE_USERS), Invitations, Groups.

Key flows:
- Invitation: generates 32-byte token, stores SHA256 hash, 7-day expiry. Accept validates hash, checks not expired, creates app_user
- Role deletion blocked if users assigned. System roles cannot be modified

### `AppPublicController`
Slug-based app runtime. All methods verify app published + user is member.
- `GET /api/app/{slug}` — Returns app config + forms + user permissions. Strips `ownerId` for non-owners
- Response CRUD with permission checks (`SUBMIT_RESPONSES`, `VIEW_ALL_RESPONSES` vs `VIEW_OWN_RESPONSES`, `EDIT_RESPONSES`, `DELETE_RESPONSES`)
- `GET .../lookup` — SQL-level linked record search via `json_extract`
- `GET .../related` — Inverse relation lookup via `response_links` table
- `GET .../manifest.json` — Public PWA manifest

### `WebhookController`
- CRUD for webhooks. Validates URL scheme (http/https), events against allowlist
- Secret returned only on creation
- Delivery history with status/duration

### `PackController`
- `POST /api/packs/import` — Imports pack JSON, audits `pack.import`

---

## Services

### `AuthService`
- **Rate Limiting**: Static in-memory. Dual: per IP+email (5/15min) and per email alone (10/15min)
- `register()` — bcrypt hash, catches SQLSTATE 23000 for duplicate email
- `login()` — Checks both rate limits, `password_verify()`, clears on success
- `validateToken()` — Firebase JWT decode with claim validation (iss, aud, sub, exp, nbf)
- `generateToken()` — JWT with iss, aud, sub, email, iat, nbf, exp claims

### `FormService`
- `getAllForms()` — Cursor-based or offset pagination. Loads fields from SQLite
- `createForm()` — **Upsert**: if same ID exists AND user owns it, updates instead. Generates UUID if none
- `updateForm()` — Partial update. Sets `published_at` on first publish. Dispatches `form.published` webhook
- `deleteForm()` — Cleans up `response_links`, deletes MySQL (cascades), deletes SQLite file
- `duplicateForm()` — Copy with "(Copy)" suffix, draft status, regenerated field IDs
- `saveFormFields()` — Deletes all fields, re-inserts. Generates human-friendly IDs if missing

### `ResponseService`
- `createResponse()` — Execute script -> handle rejection -> INSERT SQLite -> apply computed/tags -> INSERT MySQL metadata -> update analytics -> dispatch webhook. Compensating deletes on failure
- `importResponses()` — Batch CSV import with type coercion (number->float, checkboxes->comma-split). Max 1000 rows. Transactional
- `formatResponses()` — Batch-loads computed fields and tags in 500-item chunks (N+1 prevention)

### `AppService`
- `createApp()` — Generates slug (name + 6-char random suffix), creates 3 system roles (Owner/Admin/Member), grants Owner all permissions, adds creator as Owner
- `getAllApps()` — Returns apps where user is owner OR member (LEFT JOIN)

### `AppUserService`
- `hasPermission()` — Owner role always returns true. Otherwise checks `app_role_permissions`
- `getUserPermissions()` — Returns `{appLevel: string[], formLevel: {formId: string[]}}`
- `acceptInvitation()` — Validates SHA256(token), checks pending + not expired + not already member. Transactional
- System role protection: cannot rename, delete, or remove owner

### `AppResponseService`
Wraps `ResponseService` with app context. Adds `appId`/`submittedByUserId` to metadata. Manages `response_links` for linked records.

### `WebhookService`
- `dispatch()` — Finds active webhooks matching event, delivers with SSRF protection
- Delivery: HMAC-SHA256 signature (`X-FormLogic-Signature`), 5s timeout, 3s connect. Logs delivery results
- SSRF: blocks private IPs (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x, ::1, fc00::/7)

### `FormLogicRuntime`
Sandboxed script execution (50000 instructions, 2000ms wall time, 100 call depth).

Registered modules:
- `__db`: `setField`, `getField`, `setStatus`, `addTag` (via `DbContextCapture`)
- `__utils`: `uuid`, `now`, `nowMs`, `hash`, `formatDate`
- `__http`: Full HTTP client with SSRF protection + DNS pinning (`CURLOPT_RESOLVE`)
- `compliance`: `regBICheck`, `suitabilityScore`, `amlFlag`, `kycComplete`, `nigoCheck`, `accreditedInvestor`
- `finance`: `compoundInterest`, `aumFee`, `riskScore`, `portfolioAllocation`, `transferFee`

`validateScriptSafety()` blocks reserved names, `eval()`, `Function()`, infinite loops.

### `AuditService`
- `log()` — Atomic: get sequence number -> fetch previous hash (or genesis) -> compute SHA256 -> insert. Never breaks main operations (try/catch)
- `verifyChain()` — Cursor-based iteration, recomputes each hash, reports first broken entry
- Hash format: `sha256(sequence_number:action:resource_type:resource_id:user_id:ip_address:details_json:previous_hash)`

### `FormVersionService`
- `createVersion()` — Auto-increment with retry loop (max 3 on duplicate key)
- `restoreVersion()` — Auto-snapshots current state before restoring

### `PackService`
- `importPack()` — Validates format, builds formIdMap, creates forms with remapped `@pack:` linked_record references, creates apps + system roles + custom roles. Transactional with cleanup on failure

### `DocumentConverter`
Converts PDF/Word/images to base64 PNG arrays. Priority: `pdftoppm` > `convert` (ImageMagick) > `gs` (Ghostscript). Word via LibreOffice headless.

### Other Services
- `FormLogicService` — Direct expression evaluation wrapper (not form submission context)
- `ScriptResult` — Immutable DTO (success/rejection/error, fields, tags, status, metrics)
- `ScriptRejection` — DTO for script-rejected submissions
- `DbContextCapture` — Captures `ctx.db` operations with limits (50 fields, 20 tags, validated names)

---

## Helpers & Constants

### `IpResolver`
Secure IP resolver preventing spoofing. Right-to-left header iteration. Supports trusted proxies (IP + CIDR). Sanitizes port suffixes. Uses `FILTER_VALIDATE_IP`.

### `AppPermissions`
App-level: `manage_app`, `manage_users`, `manage_roles`, `view_analytics`
Form-level: `submit_responses`, `view_own_responses`, `view_all_responses`, `edit_responses`, `delete_responses`, `export_responses`

---

## Routes & DI Container

### Middleware Instances

| Name | Config |
|---|---|
| `$authRequired` | `AuthMiddleware(optional: false)` |
| `$authOptional` | `AuthMiddleware(optional: true)` |
| `$authRateLimit` | `RateLimitMiddleware(10, 60, 'auth')` |
| `$formCreateRateLimit` | `RateLimitMiddleware(20, 60, 'form-create')` |
| `$submissionRateLimiter` | `RateLimitMiddleware(30, 60, 'submission')` |
| `$publicFormRateLimiter` | `RateLimitMiddleware(60, 60, 'public-form')` |
| `$appSubmissionRateLimiter` | `RateLimitMiddleware(30, 60, 'app-submission')` |

### Route Map

```
Auth:
  POST   /api/auth/register          [authRateLimit]
  POST   /api/auth/login             [authRateLimit]
  POST   /api/auth/logout            [authRateLimit]
  GET    /api/auth/me                [authRequired]
  PUT    /api/auth/me                [authRequired]

AI:
  GET    /api/ai/status              (public)
  POST   /api/ai/generate-form       [authRequired]
  POST   /api/ai/generate-form-from-file    [authRequired]
  POST   /api/ai/generate-form-from-images  [authRequired]
  POST   /api/ai/generate-script     [authRequired]
  POST   /api/ai/improve-script      [authRequired]

Forms:
  GET    /api/forms                  [authRequired]
  POST   /api/forms                  [authRequired, formCreateRateLimit]
  GET    /api/forms/{id}             [authRequired]
  PUT    /api/forms/{id}             [authRequired]
  DELETE /api/forms/{id}             [authRequired]
  POST   /api/forms/{id}/duplicate   [authRequired, formCreateRateLimit]

Versions:
  GET    /api/forms/{id}/versions                    [authRequired]
  GET    /api/forms/{id}/versions/{version}          [authRequired]
  POST   /api/forms/{id}/versions/{version}/restore  [authRequired]

Webhooks:
  GET    /api/forms/{id}/webhooks                         [authRequired]
  POST   /api/forms/{id}/webhooks                         [authRequired]
  PUT    /api/forms/{id}/webhooks/{webhookId}              [authRequired]
  DELETE /api/forms/{id}/webhooks/{webhookId}              [authRequired]
  GET    /api/forms/{id}/webhooks/{webhookId}/deliveries   [authRequired]

Responses:
  GET    /api/forms/{formId}/responses               [authRequired]
  POST   /api/forms/{formId}/responses               [submissionRateLimiter] (PUBLIC)
  GET    /api/forms/{formId}/responses/export        [authRequired]
  POST   /api/forms/{formId}/responses/import        [authRequired]
  GET    /api/forms/{formId}/responses/{id}          [authRequired]
  PUT    /api/forms/{formId}/responses/{id}          [authRequired]
  DELETE /api/forms/{formId}/responses/{id}          [authRequired]
  POST   /api/forms/{formId}/responses/{id}/recompute [authRequired]

Analytics & Export:
  GET    /api/forms/{formId}/analytics               [authRequired]
  GET    /api/forms/{formId}/export/sqlite           [authRequired]
  GET    /api/forms/{formId}/export/json             [authRequired]

Public:
  GET    /api/public/forms/{id}      [publicFormRateLimiter]

Packs:
  POST   /api/packs/import           [authRequired]

Audit:
  GET    /api/admin/audit/verify     [authRequired]

App Management:
  GET    /api/apps                                    [authRequired]
  POST   /api/apps                                    [authRequired]
  GET    /api/apps/{id}                               [authRequired]
  PUT    /api/apps/{id}                               [authRequired]
  DELETE /api/apps/{id}                               [authRequired]
  GET    /api/apps/{id}/forms                         [authRequired]
  POST   /api/apps/{id}/forms                         [authRequired]
  PUT    /api/apps/{id}/forms/{formId}                [authRequired]
  DELETE /api/apps/{id}/forms/{formId}                [authRequired]
  PUT    /api/apps/{id}/forms/reorder                 [authRequired]
  GET    /api/apps/{id}/roles                         [authRequired]
  POST   /api/apps/{id}/roles                         [authRequired]
  PUT    /api/apps/{id}/roles/{roleId}                [authRequired]
  DELETE /api/apps/{id}/roles/{roleId}                [authRequired]
  GET    /api/apps/{id}/roles/{roleId}/permissions    [authRequired]
  PUT    /api/apps/{id}/roles/{roleId}/permissions    [authRequired]
  GET    /api/apps/{id}/users                         [authRequired]
  PUT    /api/apps/{id}/users/{appUserId}             [authRequired]
  DELETE /api/apps/{id}/users/{appUserId}             [authRequired]
  GET    /api/apps/{id}/invitations                   [authRequired]
  POST   /api/apps/{id}/invitations                   [authRequired]
  POST   /api/apps/{id}/invitations/accept            [authRequired]
  DELETE /api/apps/{id}/invitations/{invitationId}    [authRequired]
  GET    /api/apps/{id}/groups                        [authRequired]
  POST   /api/apps/{id}/groups                        [authRequired]
  PUT    /api/apps/{id}/groups/{groupId}              [authRequired]
  DELETE /api/apps/{id}/groups/{groupId}              [authRequired]
  POST   /api/apps/{id}/groups/{groupId}/members      [authRequired]
  DELETE /api/apps/{id}/groups/{groupId}/members/{appUserId} [authRequired]

App Runtime (slug-based):
  GET    /api/app/{slug}/manifest.json                (public)
  GET    /api/app/{slug}                              [authRequired]
  GET    /api/app/{slug}/permissions                  [authRequired]
  GET    /api/app/{slug}/forms/{formId}               [authRequired]
  POST   /api/app/{slug}/forms/{formId}/responses     [authRequired, appSubmissionRateLimiter]
  GET    /api/app/{slug}/forms/{formId}/responses     [authRequired]
  GET    /api/app/{slug}/forms/{formId}/responses/{id} [authRequired]
  PUT    /api/app/{slug}/forms/{formId}/responses/{id} [authRequired]
  DELETE /api/app/{slug}/forms/{formId}/responses/{id} [authRequired]
  GET    /api/app/{slug}/forms/{formId}/lookup        [authRequired]
  GET    /api/app/{slug}/forms/{formId}/responses/{responseId}/related [authRequired]
```

---

# Part 3: Frontend

## Stores

All stores use Zustand with `(set, get) =>` pattern. Most use `persist` middleware.

### `authStore.ts`
**State**: `user`, `isLoading`, `isInitialized`, `error`
**Actions**: `initialize()` (calls `api.getMe()`), `login()`, `register()`, `logout()` (clears formStore, appStore, appRuntimeStore), `updateProfile()`
**Persistence**: Key `formlogic-auth`, partializes `user` only.

### `formStore.ts`
**State**: `forms`, `activeFormId`, `selectedFieldId`, `isLoading`, `storageMode` ('local'|'api'), `isInitialized`
**Key helpers**: `generateFieldId(label, existingIds)` (slug-based, dedupes with `_N`), `syncFormField()` (debounced 1000ms), `purgeEmptyForms()`, `debouncedSave()` (per-form timers)
**Actions**: `initialize()`, `createForm()` (optimistic + rollback), `updateForm()` (debounced), `deleteForm()`, `duplicateForm()`, `addField()`, `updateField()`, `deleteField()`, `reorderFields()`, `updateFormSettings()`, `updateFormTheme()`, `syncToApi()`, `saveFormToApi()`
**Persistence**: Key `formlogic-forms`, partializes `forms` and `storageMode`.

### `responseStore.ts`
**State**: `responses` (capped 500), `currentFormId`, `currentAnswers`, `currentStep`, `startTime`
**Actions**: `startResponse()`, `setAnswer()`, `nextStep()`/`prevStep()`/`goToStep()`, `submitResponse()` (captures completionTime, userAgent, referrer), `getResponsesByFormId()`, `updateResponse()`, `deleteResponse()`
**Persistence**: Key `formlogic-responses`, partializes last 500 responses.

### `toastStore.ts`
**State**: `toasts` array
**Convenience**: `toast.success()`, `toast.error()` (7000ms), `toast.warning()`, `toast.info()`
**No persistence.**

### `uiStore.ts`
**State**: `sidebarCollapsed`, `activeModal`, `modalData`, `isPreviewOpen`, `previewDevice`, `previewMode` ('focused'|'classic'), `builderTab`, `isMobile`, `mobilePanel`, `theme` ('light'|'dark', default 'dark'), `themeColor`
**Persistence**: Key `formlogic-ui-storage`, partializes `theme`, `themeColor`, `sidebarCollapsed`.

### `appStore.ts`
**State**: `apps`, `activeAppId`, `isLoading`, `error`
**Actions**: Full CRUD for apps, app forms (add/remove/update/reorder), roles + permissions.
**Inter-store dependency**: `addFormToApp` reads from `useFormStore.getState().forms`.
**Persistence**: Key `formlogic-apps`, partializes `apps` and `activeAppId`.

### `appRuntimeStore.ts`
**State**: `config` (AppRuntimeConfig), `appSlug`, `activeFormId`, `sidebarCollapsed`, `permissions`, `roleName`
**Actions**: `initialize(appSlug)`, response CRUD, `lookupRecords()`, permission helpers (`canSubmit`, `canViewOwn`, `canViewAll`, `canEdit`, `canDelete`, `canExport`)
**Permission check pattern**: `manage_app` OR specific permission at app-level OR form-level.
**Persistence**: Key `formlogic-app-runtime`, partializes `sidebarCollapsed` and `appSlug`.

### `appUserStore.ts`
**State**: `users`, `groups`, `invitations` (all keyed by appId)
**Actions**: Full CRUD for users, invitations (invite/accept/revoke), groups + members.
**No persistence.** All server-backed.

---

## Types

### `types/form.ts`
- **FieldType** (22 types): `short_text`, `long_text`, `email`, `phone`, `number`, `url`, `date`, `time`, `datetime`, `dropdown`, `multiple_choice`, `checkboxes`, `rating`, `scale`, `file_upload`, `signature`, `payment`, `statement`, `welcome_screen`, `thank_you`, `calculated`, `linked_record`
- **ValidationRule**: types: `required`, `minLength`, `maxLength`, `min`, `max`, `pattern`, `custom` (with expression)
- **ConditionalLogic**: `{ expression, action: 'show'|'hide'|'skip'|'require' }`
- **FormSettings**: `presentationMode`, `showProgressBar`, `allowBackNavigation`, `submitButtonText`, `redirectUrl?`, `notifications`, `quotaLimit?`, `isClosed`, `showNigoDashboard?`
- **Form**: `{ id, title, description?, fields, settings, theme, logicScript?, logicPrompt?, status, responseCount }`
- **Exports**: `DEFAULT_FORM_SETTINGS`, `DEFAULT_FORM_THEME`, `FIELD_TYPE_INFO`

### `types/app.ts`
- **AppSettings**: `allowSelfRegistration`, `requireApproval`, `defaultRoleId?`, `landingPage`, `showBranding`, `enablePwa`
- **PermissionAction** (10 values): `manage_app`, `manage_users`, `manage_roles`, `view_analytics`, `submit_responses`, `view_own_responses`, `view_all_responses`, `edit_responses`, `delete_responses`, `export_responses`
- **Runtime types**: `AppRuntimeForm`, `AppRuntimeConfig`, `AppUserPermissions`

---

## API Client

Singleton `ApiClient` class exported as `api`. Base URL: `import.meta.env.VITE_API_URL || '/api'`.

**Auth**: `_isAuthenticated` client-side hint. Actual auth via HttpOnly cookie. Session expiry callbacks fired on 401.
**CSRF**: Reads `formlogic_csrf` from `document.cookie`, attaches as `X-CSRF-Token` on state-changing methods.
**Core**: `credentials: 'include'` for cookies. On 401: `handleUnauthorized()`.

**Endpoint groups**: Auth, Forms (with cursor pagination), Responses, Analytics, Export (CSV/SQLite/JSON), Health, AI (form/script generation), App Admin (full CRUD), App Runtime (slug-based), Webhooks, Pack Import, CSV Import, Audit Verification, Form Versions.

---

## Hooks

### `useConditionalLogic(fields, formData)`
Evaluates conditional logic expressions. Returns `{ visibleFields, requiredFields, isFieldVisible, isFieldRequired, isEvaluating, refresh }`. Race-condition safe via evaluationId ref. Only updates state if sets actually changed.

### `useFieldValidation(field, value, formData)`
Single-field validation. Checks `required`, then iterates rules (custom expressions, minLength, maxLength, pattern, min, max). Debounced at 300ms.

### `useCalculatedField(expression, formData, dependencies)`
Evaluates calculation expressions. Uses `dependencyKey` for selective re-evaluation.

### `useExpressionTester()`
Interactive expression testing. Skips syntax validation when context vars provided.

### `useKeyboardShortcuts({ shortcuts, enabled })`
Attaches `keydown` listener. Skips non-modifier shortcuts in INPUT/TEXTAREA/SELECT. Mac-aware formatting.

### `useNigoDashboard(fields, formData, visibleFieldIds, requiredFieldIds)`
NIGO = "Not In Good Order" (financial compliance). Per-field evaluation: Red (required+empty or validation error), Yellow (suspicious values), Green (valid). Excludes statement/welcome/thank_you/calculated. Debounced 500ms.

### `useOnlineStatus()`
Returns boolean. Tracks `navigator.onLine` via events.

---

## Lib Utilities

### `lib/utils.ts`
- `cn()` — Tailwind class merge (clsx + twMerge)
- `generateId()` — UUID via `crypto.randomUUID()` with fallback
- `formatDate()` / `formatRelativeTime()` — Date formatting
- `debounce()` / `sanitizeFilename()` / `slugify()`
- `labelToVariableName(label)` — "Your Email" -> "yourEmail"
- `createFieldVariableMap(fields)` — Bidirectional field ID <-> variable name mapping
- `replaceVariablesWithIds()` / `replaceIdsWithVariables()` — Expression variable resolution

---

## FormLogic Scripting Engine

### `engine.ts`
Thin client over a QuickJS sandbox: each evaluation is dispatched to a dedicated
Web Worker (`formlogic.worker.ts` → `quickjs-host.ts`, using `quickjs-emscripten`)
with memory/stack/interrupt limits and a terminate watchdog. The standard library
below is the shared prelude (`prelude.js`), which also runs server-side via the
vendored `qjs` binary, so client and server results match.

**Standard-library modules** (from `prelude.js`):
- `validators`: email, phone, url, minLength, maxLength, pattern (ReDoS-limited 500 chars), required, min, max
- `format`: currency, number, date, uppercase, lowercase
- `compliance`: regBICheck, suitabilityScore, amlFlag, kycComplete, nigoCheck, accreditedInvestor, wholesaleClient, austracFlag, tfnValid
- `finance`: compoundInterest, aumFee, riskScore, portfolioAllocation, transferFee, auAumFee, auTransferFee
- `safety`: riskMatrix, riskLevel, controlEffectiveness, residualRisk

**Builtins**: isEmpty, isNotEmpty, contains, sum, avg, count

**Exported functions**:
- `evaluateCondition(expression, formData)` — Returns boolean (conditional logic)
- `validateWithExpression(expression, value, formData)` — Returns error message or null
- `calculateValue(expression, formData)` — Returns computed value
- `testExpression(expression, context)` — Returns `{ valid, output?, error? }`
- `validateExpression(expression)` — Syntax check only

### `compliance` module (in `prelude.js`)
- `regBICheck(riskScore, portfolioType)` — Reg BI suitability (conservative 0-30, moderate 20-60, aggressive 50-85, speculative 75-100)
- `suitabilityScore(age, income, netWorth, riskTolerance, timeHorizon)` — Weighted 1-100 (age 20%, income 15%, netWorth 20%, tolerance 25%, horizon 20%)
- `amlFlag(amount, frequency?)` — CTR threshold (>=10k), structuring ($8k-$10k, freq>3), high volume (>50/month)
- `kycComplete(...fields)` — Variadic: all non-empty
- `nigoCheck(...fields)` — Comma-separated 1-based indices of missing fields
- `accreditedInvestor(income, netWorth)` — SEC Rule 501(a): income >$200k or netWorth >$1M

### `finance` module (in `prelude.js`)
- `compoundInterest(principal, rate, periods)` — A = P * (1+r)^n, rounded 2 decimals
- `aumFee(assets, tiersJson?)` — Tiered fee (default: 1% first $1M, 0.75% $1M-$5M, 0.50% $5M-$10M, 0.35% above)
- `riskScore(age, timeHorizon, riskTolerance)` — Weighted 30/30/40
- `portfolioAllocation(riskScore)` — Returns "equity:bond:cash" string, linear interpolation
- `transferFee(amount, custodian?)` — $0 for Schwab/Fidelity/Vanguard, $75 otherwise, waived under $500

---

## Data Files

### `data/formTemplates.ts`
8 templates across 7 categories (business, feedback, events, hr, education, finance, other): Contact Form, Customer Feedback, Event Registration, Job Application, Newsletter Signup, Bug Report, Course Evaluation, RSVP Form.

### `data/packs/index.ts`
`PackCatalogEntry` interface. Single entry: Finance OS Pack.

### `data/packs/financeOsPack.ts`
**Finance OS Pack** (formatVersion 1, v1.0.0):

12 Forms:
1. **New Client Onboarding** — Personal/financial/regulatory info. Calculated `risk_score` and `kyc_status`
2. **Risk Tolerance Questionnaire** — Linked to #1. Calculated `risk_profile_score` and `reg_bi_check`
3. **ACAT / Transfer Form** — Linked to #1. Conditional logic on transfer_type. Calculated `transfer_fee`
4. **Form CRS & Relationship Summary** — SEC disclosures, signatures
5. **Annual Client Review** — Linked to #1. AUM, goal progress, life changes
6. **Fee Agreement** — Linked to #1. Calculated `aumFee`
7. **Document Vault** — Linked to #1. File upload
8. **W-9 Form** — Tax form with SSN/EIN validation
9. **Beneficiary Designation** — Linked to #1. Primary/contingent beneficiaries
10. **Power of Attorney** — Principal/agent, witnesses, notary
11. **1035 Exchange** — Linked to #1. Insurance/annuity exchange
12. **Rollover Form** — Linked to #1. Retirement plan rollover

2 Apps:
1. **Client Onboarding Navigator** — Forms 1,2,4,7,8,9. Roles: Advisor, Compliance Officer, Operations, Client
2. **Advisor Transition Hub** — Forms 1,3,5,6,11,12. Roles: Managing Advisor, Transition Coordinator, Compliance, Operations

Pack references use `@pack:packFormId` syntax for linked records, resolved at import time.

---

## Pages

### `App.tsx` (Root)
`ErrorBoundary > BrowserRouter > AppInitializer > ThemeManager + Suspense(AppRoutes) + ToastContainer`

**Initialization sequence**: auth init -> (wait) -> form init based on auth + storage mode -> app fetch if authenticated. Zustand `persist` hydrates from localStorage before React renders.

**Routing (unauthenticated)**: `/` Landing, `/login`, `/signup`, `/form/:formId` (public), `/app/:appSlug/*`, `*` NotFound
**Routing (authenticated)**: Inside `AppShell`: Dashboard, FormsList, Settings, Analytics, Responses, AppsDashboard, AppCreateWizard, App settings/forms/users/roles/relations/deploy. Outside AppShell: FormBuilder, FormPreview, FormResponse, AppRuntime.

### `Dashboard.tsx` — Welcome, stat cards, quick actions (new form, templates, import pack), recent forms (top 5), recent activity
### `FormsList.tsx` — Search, sort, tabs (All/Published/Drafts/Archived), grid of memoized `FormCard` components, portal-based dropdown menus
### `FormBuilder.tsx` — Full-screen editor. DnD-sortable field canvas. Header with title input (local state + onBlur sync). Panels: FieldPalette (left), FieldSettingsPanel (right). Modals: ScriptEditor, EmbedModal, AIFormGenerator, ThemeEditor, FormSettingsModal. Keyboard shortcuts: Ctrl+S save, Ctrl+P preview, Ctrl+/ help, Escape deselect, Ctrl+D duplicate, Delete/Backspace delete, arrows navigate/move, T/E/N/R quick-add
### `FormPreview.tsx` — Two modes: Focused (one field, animated via framer-motion) and Classic (scrollable). Device toggle. Optional NIGO Dashboard sidebar. Full `FieldPreview` component renders all 22 field types including signature canvas, file upload, rating stars, scale
### `FormResponse.tsx` — Public form submission (no auth). Focused-mode. Calls `responseStore.submitResponse()`
### `FormResponses.tsx` — Stats cards, search, sort, paginated table (10/page), view/edit/delete modals, CSV export, CSV import wizard
### `FormAnalytics.tsx` — Total responses, completion rate, avg time, response chart (7 days). Export options
### `Settings.tsx` — Profile, password, preferences (localStorage), UI settings (theme/color), Audit Integrity Verification
### `Landing.tsx` — Marketing page (unauthenticated)
### `Login.tsx` / `Signup.tsx` — Split layout auth forms

### App Admin Pages
- **AppsDashboard** — List apps, create button
- **AppCreateWizard** — Multi-step creation
- **AppSettings** — Name, description, slug, theme, settings
- **AppFormManager** — Add/remove/reorder forms
- **AppUserManager** — View/invite/manage users
- **AppRoleEditor** — Roles + permission matrix
- **AppDeploySettings** — Deploy URL, PWA, self-registration
- **AppRelationsManager** — Linked record relations

---

## Components

### `components/builder/` (18 exports)

| Component | Description |
|-----------|-------------|
| `SortableFieldCard` | DnD-sortable card. `memo`-wrapped. Accepts `(fieldId: string)` callbacks for stable references |
| `FieldSettingsPanel` | Right panel. `memo`-wrapped. Edits label, description, type-specific settings, validation, logic, calculated expressions, linked record config |
| `FieldPalette` | Categorized field type picker. Groups: Text, DateTime, Choice, Rating, Advanced, Layout |
| `LogicEditor` | Conditional logic expression editor + action selector (show/hide/skip/require) |
| `ValidationEditor` | Add/edit validation rules |
| `CalculatedFieldEditor` | Expression editor with formula testing |
| `ScriptEditor` | Full-screen modal code editor for `onSubmit` scripts (JavaScript, runs in QuickJS) |
| `ThemeEditor` | Visual theme customizer: colors, font, border radius, background |
| `EmbedModal` | Share/embed: direct link, iframe, JavaScript snippet |
| `AIFormGenerator` | AI form generation: text prompt, file upload (PDF/images) |
| `FormSettingsModal` | Form settings: presentation, progress bar, back nav, submit text, redirect, notifications, quota, NIGO toggle |
| `TemplateSelector` | Template browser with category filter, search, preview |
| `LinkedRecordSettings` | Config for linked_record fields: target form, display/search fields |
| `WebhookManager` | Webhook CRUD with delivery history |
| `NigoDashboard` | Real-time NIGO status panel: traffic-light per field, overall score, clickable field list |
| `PackImportModal` | Pack catalog browser, preview, one-click import |
| `CsvImportWizard` | Multi-step CSV import: upload, preview, map columns, execute |
| `ICON_MAP` | Maps field type strings to Lucide icon components |

### `components/app-runtime/` (11 exports)

| Component | Description |
|-----------|-------------|
| `AppRuntimeRoot` | Entry point for `/app/:appSlug/*`. Theme provider + auth guard wrapper. Sub-routes: dashboard, form view, response detail, profile |
| `AppRuntimeShell` | Layout: sidebar (form navigation with permission-filtered items, collapse toggle), header (app name, user menu), content area |
| `AppRuntimeThemeProvider` | Applies app's custom theme as CSS variables on a wrapper div |
| `AppRuntimeAuthGuard` | Auth check + app member verification. Shows login prompt or "request access" for non-members |
| `AppDashboard` | App home: summary cards (total responses, forms, recent activity), recent submissions table, quick-nav to forms |
| `AppFormView` | Form submission within app runtime. Uses `useConditionalLogic` for field visibility. Focused/classic presentation modes. Handles linked record fields. Optional NIGO dashboard. Submits via `appRuntimeStore.createResponse()` |
| `AppDataTable` | Response data table. Pagination, search (debounced 300ms), column sorting. View/edit/delete actions gated by permissions. Resolves linked records for display. CSV export |
| `AppResponseDetail` | Single response detail view. Renders all field types with formatted values. Edit mode for users with `EDIT_RESPONSES`. Status management. Linked record display with navigation. Related records panel |
| `AppUserProfile` | User profile within app: role display, membership info, joined date |
| `LinkedRecordInput` | Searchable dropdown for linked records. Debounced search (300ms) via `appRuntimeStore.lookupRecords()`. Shows display labels. Handles single/multi select |
| `RelatedRecordsPanel` | Inverse relations: shows records from other forms that link to current record. Grouped by source form. Clickable navigation to related records |

### `components/ui/` (20+ exports)

`Button` (variants: primary/outline/ghost/danger/link, sizes: xs-lg, isLoading), `Input` (label, leftIcon, error), `Textarea`, `Card`/`CardHeader`/`CardContent`/`CardFooter`, `Modal` (sizes: sm-full, portal-based), `Badge` (variants: default/success/warning/danger/info), `Dropdown`, `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent`, `Tooltip`, `ProgressBar`, `Switch`, `ConfirmDialog`, `DataTable`, `EmptyState`, `Spinner`, `Toast`/`ToastContainer`, `ThemeToggle`, `ThemeManager`, `Logo`/`LogoWhite`, `PermissionMatrix`

### `components/layout/` (4 exports)

`AppShell` (main layout with `<Outlet>`, sidebar + mobile nav), `Sidebar` (desktop nav: Dashboard, Forms, Apps, Settings; collapsible), `Header` (page header bar), `MobileNav` (bottom nav bar)

### `components/auth/`

`AuthModal` (modal wrapper for auth flows), `UserMenu` (dropdown: profile, settings, logout)

### `ErrorBoundary.tsx`

Class component. Catches render errors, shows fallback UI with collapsible error details, "Try Again" and "Reload Page" buttons.
