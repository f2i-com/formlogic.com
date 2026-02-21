# FormLogic — Improvement Plan

> Comprehensive audit-driven improvement plan. Generated 2026-02-22 from full-codebase analysis across backend, frontend, and cross-cutting concerns.

---

## Executive Summary

**Total issues identified**: 80+ across security, architecture, performance, UX, and developer experience. Organized into 6 phases by priority and dependency.

| Phase | Focus | Issues | Effort |
|-------|-------|--------|--------|
| 1 | Critical Security & Data Integrity | 12 | 1-2 weeks |
| 2 | Error Handling & Reliability | 14 | 1-2 weeks |
| 3 | Performance & Scalability | 11 | 1-2 weeks |
| 4 | Frontend Quality & UX | 13 | 1-2 weeks |
| 5 | Testing & Developer Experience | 10 | 2-3 weeks |
| 6 | Architecture & Long-term | 8 | Ongoing |

---

## Phase 1: Critical Security & Data Integrity

These issues represent real vulnerabilities or data loss risks and should be addressed first.

### 1.1 SSRF Protection in FormLogicRuntime HTTP Module [DONE]
**Severity**: CRITICAL
**File**: `backend/src/Services/FormLogicRuntime.php` ~L623-669
**Problem**: The `ctx.http` module allows user-authored scripts to make HTTP requests via cURL. While there's DNS pinning logic, the SSRF protection needs to be verified as complete — scripts could potentially reach internal services, cloud metadata endpoints (169.254.169.254), or localhost services.
**Fix**: Already had comprehensive SSRF protection. Added cloud metadata hostnames (169.254.169.254, metadata.google.internal, metadata.internal) to blocked list. Redirect validation was already in place.

### 1.2 SSRF Protection in WebhookService [DONE]
**Severity**: HIGH
**File**: `backend/src/Services/WebhookService.php` ~L25-32, L213
**Problem**: Webhook delivery makes outbound HTTP requests to user-provided URLs. While basic URL validation exists, DNS-rebinding or redirect attacks could bypass initial checks.
**Fix**:
- Added blocked hostnames list (localhost, metadata endpoints, etc.)
- Added DNS pinning via `CURLOPT_RESOLVE` to prevent TOCTOU rebinding
- Disabled `CURLOPT_FOLLOWLOCATION` to prevent redirect-based SSRF

### 1.3 Dual-Database Consistency (MySQL + SQLite) [PARTIAL]
**Severity**: CRITICAL
**Files**: `backend/src/Services/FormService.php`, `backend/src/Services/ResponseService.php`
**Problem**: Forms have metadata in MySQL and responses in SQLite. No cross-database transactions means partial failures create inconsistent state.
**Fix**:
- Reordered `deleteForm()` to delete SQLite first (fail-fast) before MySQL deletion
- Remaining: verifyFormDatabase health check, compensating deletes in ResponseService, orphan cleanup

### 1.4 Missing Permission Check in Related Records Endpoint [DONE]
**Severity**: HIGH
**File**: `backend/src/Controllers/AppPublicController.php` ~L533-654
**Problem**: `getRelatedRecords` checks view permissions on the source form but doesn't validate that the target `responseId` actually belongs to the specified `formId`. An attacker could pass a response ID from a different form to access unauthorized data.
**Fix**:
```php
$targetResp = $this->responseService->getResponse($formId, $responseId);
if (!$targetResp) {
    return $this->jsonResponse($response, ['error' => true, 'message' => 'Response not found'], 404);
}
```

### 1.5 Race Condition in Form Duplication [DONE]
**Severity**: HIGH
**File**: `backend/src/Services/FormService.php` ~L254-280
**Problem**: `duplicateForm()` fetches the source form, then copies it. Between the authorization check and the actual copy, the source form could be deleted or ownership could change.
**Fix**:
- Wrapped in MySQL transaction with `SELECT ... FOR UPDATE` row lock on source form
- Rolls back on any failure

### 1.6 XSS via Redirect URL on Form Submission [DONE]
**Severity**: HIGH
**File**: `ui/src/pages/FormResponse.tsx` ~L722-729
**Problem**: After form submission, redirect URL validation only checks for `https?://` prefix. Edge cases like `http:////evil.com` or encoded characters could bypass the check.
**Fix**:
```typescript
try {
  const url = new URL(redirectUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  window.location.href = url.toString();
} catch {
  // Invalid URL — don't redirect
}
```

### 1.7 ReDoS Vulnerability in User-Provided Pattern Validation [DONE]
**Severity**: HIGH
**File**: `ui/src/lib/formlogic/engine.ts` ~L80-92
**Problem**: User-provided regex patterns are compiled and executed without a timeout. Malicious patterns like `(a+)+b` cause catastrophic backtracking that freezes the browser tab.
**Fix**:
- The 500-char length limit helps but doesn't prevent backtracking
- Added detection of known catastrophic backtracking constructs (nested quantifiers, alternation with quantifiers)
- Rejects patterns matching `(+|*|{})` followed by another quantifier, or `(a|b)+` constructs

### 1.8 Input Length Validation on Large JSON Fields [DONE]
**Severity**: MEDIUM
**File**: Multiple controllers (`FormController.php`, `AppController.php`)
**Problem**: While `title` validates length (<=500 chars), large JSON fields (`settings`, `theme`, `logicScript`, `logicPrompt`, `fields`) have no size limits. A malicious user could submit multi-megabyte JSON payloads.
**Fix**:
- Add size validation in `FormController::create()` and `update()`:
  - `logicScript`: max 100KB
  - `fields` JSON: max 500KB (generous for 100+ field forms)
  - `settings`/`theme`: max 10KB each
- Return 422 with descriptive message when exceeded

### 1.9 Missing Validation of Linked Record Field IDs [DONE]
**Severity**: HIGH
**File**: `backend/src/Controllers/AppPublicController.php` ~L444-445, L516-517
**Problem**: `displayFieldIds` and `searchFieldIds` query parameters are split by comma and used directly without validating they're actual field IDs in the target form.
**Fix**:
- After loading the target form, validate each field ID exists: `array_intersect($requestedIds, array_column($form['fields'], 'id'))`
- Return 400 for any invalid field IDs

### 1.10 Validate App Slug Format Before Database Query [DONE]
**Severity**: MEDIUM
**File**: `backend/src/Controllers/AppPublicController.php` ~L50, L106, L124
**Problem**: App slug from URL is passed directly to database queries without format validation. While PDO parameterization prevents injection, malformed slugs generate unnecessary database queries.
**Fix**:
```php
if (!preg_match('/^[a-z0-9][a-z0-9-]{0,60}$/', $slug)) {
    return $this->jsonResponse($response, ['error' => true, 'message' => 'Not found'], 404);
}
```

### 1.11 CSRF Token Cookie Parsing Fragility [DONE]
**Severity**: MEDIUM
**File**: `ui/src/lib/api.ts` ~L51-54
**Problem**: CSRF token extraction from cookies uses regex that could match cookie names that are superstrings (e.g., `formlogic_csrf_v2` would match before `formlogic_csrf`).
**Fix**:
```typescript
const match = document.cookie.match(/(?:^|;\s*)formlogic_csrf=([^;]+)/);
return match ? decodeURIComponent(match[1]) : null;
```

### 1.12 Timing Attack in CSRF Empty Check [DONE]
**Severity**: MEDIUM
**File**: `backend/src/Middleware/CsrfMiddleware.php` ~L66
**Problem**: The check `empty($csrfCookie) || empty($csrfHeader)` before `hash_equals()` leaks timing information about whether the token is missing vs. invalid.
**Fix**:
```php
if (!hash_equals($csrfCookie ?? '', $csrfHeader ?? '')) {
    return $this->forbidden('CSRF token validation failed');
}
```

---

## Phase 2: Error Handling & Reliability

### 2.1 Silent API Failures in Form Creation [DONE]
**Severity**: HIGH
**File**: `ui/src/stores/formStore.ts` ~L241-262
**Problem**: When `createForm` fails on the API after optimistic local update, the rollback happens silently. The user sees their form appear then vanish with no explanation.
**Fix**:
- Add `toast.error('Failed to create form', 'Please try again')` in the catch block
- Consider keeping the local form and retrying rather than removing it

### 2.2 Unhandled Promise Rejections in Event Handlers [DONE]
**Severity**: MEDIUM
**Files**: `ui/src/pages/FormsList.tsx` ~L216-223, multiple other pages
**Problem**: Async event handlers (`handleCreateForm`, `handleDelete`, etc.) don't have catch blocks. Unhandled rejections crash silently.
**Fix**:
- Wrap all async event handlers in try/catch with user-facing error toasts
- Pattern:
```typescript
const handleCreateForm = async () => {
  try {
    const newForm = await createForm('Untitled Form');
    if (newForm) navigate(`/builder/${newForm.id}`);
  } catch {
    toast.error('Failed to create form');
  }
};
```

### 2.3 Missing Error Handling on Export Downloads [DONE]
**Severity**: MEDIUM
**File**: `ui/src/lib/api.ts` ~L267-278, L304-324
**Problem**: Blob download methods (SQLite, JSON export) don't handle partial download failures. If the connection drops mid-transfer, the user gets a corrupt file with no error.
**Fix**:
- Check `response.ok` before calling `response.blob()`
- Validate blob size is reasonable before triggering download
- Show error toast on failure

### 2.4 Response Export Memory Exhaustion
**Severity**: HIGH
**File**: `backend/src/Controllers/ResponseController.php` ~L869
**Problem**: `exportJson` loads ALL responses (up to 10,000) into memory. For forms with many large responses, this can exhaust PHP memory.
**Fix**:
- Stream JSON output using PHP generators and `fwrite()` to `php://output`
- Or add a hard limit (e.g., 5,000 responses) with a date-range filter requirement for larger datasets
- Add `Content-Length` header for progress indication

### 2.5 CSV Import Error Recovery
**Severity**: MEDIUM
**File**: `backend/src/Services/ResponseService.php` ~L867-1000
**Problem**: CSV import starts a transaction but uses `continue 2` in nested loops, which could skip transaction commits or leave partial state.
**Fix**:
- Wrap the entire import in a try/catch that always rolls back on exception
- Track imported response IDs so compensating MySQL deletes can clean up on partial failure
- Return partial success results (X of Y imported, errors on rows Z)

### 2.6 Script Error Message Information Disclosure [DONE]
**Severity**: MEDIUM
**File**: `backend/src/Services/FormLogicRuntime.php` ~L103-118
**Problem**: Script execution errors are returned to the client unsanitized. Error messages could leak file paths, database info, or internal implementation details.
**Fix**:
- Strip file paths and stack traces from error messages returned to clients
- Return generic message with an error reference ID
- Log full details server-side at ERROR level

### 2.7 Missing Null Checks in FormResponses Page [DONE]
**Severity**: MEDIUM
**File**: `ui/src/pages/FormResponses.tsx` ~L112-120
**Problem**: `displayFields` calculation doesn't verify `form` is loaded. If async load fails, UI shows empty state without error feedback.
**Fix**: Add early return guard and loading/error states for form data.

### 2.8 Inconsistent Error Response Shapes [DONE]
**Severity**: MEDIUM
**Files**: Various backend controllers
**Problem**: Some endpoints return `{ error: true, message: "..." }`, others return `{ error: "..." }`, and some throw exceptions that become 500s. Frontend `api.ts` tries to handle all cases but the fallback is fragile.
**Fix**:
- Standardize all error responses to: `{ error: true, message: string, code?: string, details?: unknown }`
- Create a shared `errorResponse()` helper in a base controller or trait
- Update frontend `request()` method to match the standard shape

### 2.9 Missing Error Boundary Per Route [DONE]
**Severity**: MEDIUM
**File**: `ui/src/App.tsx` ~L32-52
**Problem**: Lazy-loaded pages are wrapped in a single top-level `ErrorBoundary`. If `FormBuilder` fails to load, the entire app crashes rather than showing an error for just that page.
**Fix**:
- Add per-route error boundaries, especially around heavy pages (FormBuilder, FormPreview, AppRuntime)
- Show a route-specific error UI with "Go Back" / "Try Again" buttons

### 2.10 Webhook Delivery Failure — No Retry Mechanism
**Severity**: MEDIUM
**File**: `backend/src/Services/WebhookService.php` ~L145+
**Problem**: Failed webhook deliveries are logged but never retried. Transient network errors cause permanent data loss for webhook consumers.
**Fix**:
- Add a `webhook_delivery_queue` table with status and retry count
- Implement exponential backoff retries (1min, 5min, 30min, 2h) — max 4 retries
- Deliver synchronously on first attempt, queue retries for a background process
- Mark webhook as unhealthy after N consecutive failures

### 2.11 Form Status Transition Validation [DONE]
**Severity**: LOW
**File**: `backend/src/Services/FormService.php` ~L186-194
**Problem**: Forms can transition between any status (draft → archived → published) without validation. This allows illogical transitions.
**Fix**:
```php
$validTransitions = [
    'draft' => ['published', 'archived'],
    'published' => ['draft', 'archived'],
    'archived' => ['draft'],
];
```

### 2.12 Audit Log for Authorization Failures [DONE]
**Severity**: LOW
**Files**: `FormController.php`, `ResponseController.php`, etc.
**Problem**: When authorization fails (user doesn't own form), a 404 is returned but not logged. This makes security incident investigation difficult.
**Fix**: Added `logger->warning()` for ownership check failures in FormController.authorizeFormAccess().

### 2.13 Field ID Uniqueness Validation [DONE]
**Severity**: MEDIUM
**File**: `backend/src/Services/FormService.php` ~L156
**Problem**: `saveFormFields()` doesn't validate that field IDs are unique within a form. Duplicate IDs would cause ambiguous answer lookups.
**Fix**:
```php
$fieldIds = array_column($fields, 'id');
if (count($fieldIds) !== count(array_unique($fieldIds))) {
    throw new \InvalidArgumentException('Field IDs must be unique within a form');
}
```

### 2.14 Stale Closure in AppInitializer
**Severity**: MEDIUM
**File**: `ui/src/App.tsx` ~L90-105
**Problem**: The dependency array `[isAuthInitialized, user?.id, initializeForms]` doesn't react to user property changes (only ID). If user name/email changes, the effect won't re-run.
**Fix**: Use `[isAuthInitialized, !!user, initializeForms]` or a hash of user properties.

---

## Phase 3: Performance & Scalability

### 3.1 Replace In-Memory Rate Limiting
**Severity**: CRITICAL for production
**File**: `backend/src/Middleware/RateLimitMiddleware.php` L26
**Problem**: `private static array $requests = []` is per-PHP-process. With N PHP-FPM workers, effective rate limit is N * configured limit. Resets on process recycle.
**Fix**:
- **Short-term**: Add clear documentation that this is development-only
- **Medium-term**: Implement a `RateLimitBackendInterface` with two implementations:
  - `InMemoryRateLimitBackend` (current, for development)
  - `RedisRateLimitBackend` (production) using Redis MULTI/EXEC with TTL
- Configure via environment variable: `RATE_LIMIT_DRIVER=redis`
- Redis key pattern: `ratelimit:{prefix}:{ip_hash}` with `INCR` + `EXPIRE`

### 3.2 N+1 Query in Form Listing [DONE]
**Severity**: HIGH
**File**: `backend/src/Services/FormService.php` ~L86-91
**Problem**: `getAllForms()` queries MySQL for form metadata, then loops through each form to load fields from its individual SQLite database. Listing 50 forms = 1 MySQL query + 50 SQLite queries.
**Fix**:
- Added `includeFields` option (default `false`) to `getAllForms()`. List views skip SQLite queries.
- Only load fields when viewing/editing a single form via `getForm()`

### 3.3 Missing Memoization in FormsList [DONE]
**Severity**: MEDIUM
**File**: `ui/src/pages/FormsList.tsx` ~L254-286
**Problem**: `filteredForms`, `draftForms`, `publishedForms`, `archivedForms` are recalculated every render without `useMemo`. Sorting by response count calls `getResponsesByFormId` repeatedly.
**Fix**: Wrapped `filteredForms`, `draftForms`, `publishedForms`, `archivedForms` in `useMemo`.

### 3.4 FieldPreview Missing Memoization
**Severity**: MEDIUM
**File**: `ui/src/pages/FormPreview.tsx` ~L17-583
**Problem**: `FieldPreview` function creates handlers and elements inline on every render. For multi-field forms, this causes excessive re-renders.
**Fix**: Convert to a `React.memo`-wrapped component with `useCallback` for event handlers.

### 3.5 AppDataTable Virtualization
**Severity**: MEDIUM
**File**: `ui/src/components/app-runtime/AppDataTable.tsx` ~L44-95
**Problem**: Response list renders all items without virtualization. With hundreds of responses, mobile card list becomes sluggish.
**Fix**:
- Implement `React.memo` for individual response cards
- For 100+ items, add virtual scrolling (e.g., `@tanstack/virtual` or `react-window`)
- Current pagination (10/page) mitigates this, but mobile card view can still be slow

### 3.6 SQLite Concurrent Write Bottleneck [DONE]
**Severity**: HIGH for production
**File**: `backend/src/Database/SQLiteConnection.php`
**Problem**: SQLite allows only one writer at a time. Under concurrent form submissions, requests will queue/timeout.
**Fix**:
- Enabled WAL mode: `PRAGMA journal_mode = WAL;` — allows concurrent reads during writes
- Added `PRAGMA busy_timeout = 5000;` to wait up to 5s instead of immediately failing

### 3.7 Synchronous Webhook Delivery
**Severity**: MEDIUM
**File**: `backend/src/Services/WebhookService.php`
**Problem**: Webhook HTTP requests happen synchronously during form submission. A slow/unresponsive webhook endpoint delays the user's submission response.
**Fix**:
- **Short-term**: Add aggressive timeouts (already 5s total / 3s connect — verify these are enforced)
- **Long-term**: Move webhook delivery to an async job queue (see 6.3)
- Return submission response immediately, deliver webhooks asynchronously

### 3.8 Debounce Race Condition in Form Saves [DONE]
**Severity**: HIGH
**File**: `ui/src/stores/formStore.ts` ~L94-131
**Problem**: `updateForm` sent the entire form object, potentially overwriting field/settings/theme changes from their separate syncs.
**Fix**:
- Changed `updateForm` to use `${id}-meta` debounce key and send only the specific `updates` payload
- Separate debounce keys now: `-meta`, `-fields`, `-settings`, `-theme`

### 3.9 Response Store Unbounded localStorage Growth
**Severity**: MEDIUM
**File**: `ui/src/stores/responseStore.ts` ~L87-88
**Problem**: Responses are capped at 500 globally via `.slice(-500)`, but with 20+ forms, localStorage can still hold significant data. No per-form limit.
**Fix**:
- Add per-form response cap (e.g., 50 per form) in addition to global cap
- Consider not persisting responses at all in API mode (they're server-backed)
- Add a size check before persisting: `if (JSON.stringify(responses).length > 2 * 1024 * 1024)` → prune oldest

### 3.10 Export Operations Load Full Dataset Into Memory
**Severity**: MEDIUM
**Files**: `backend/src/Controllers/ResponseController.php` (export, exportSqlite, exportJson)
**Problem**: Exports load all responses into memory before sending. Large forms can exhaust PHP memory.
**Fix**:
- CSV export: stream rows using `fputcsv()` to `php://output` with `ob_flush()`
- JSON export: stream using incremental JSON encoding
- SQLite export: stream the file directly (already a file — just stream it)
- Add response count check: if >5000, require date range filter

### 3.11 PWA Aggressive Caching of Form Definitions [DONE]
**Severity**: MEDIUM
**File**: `ui/vite.config.ts` ~L52-53
**Problem**: Form definitions are cached for 1 hour. If a form owner publishes changes, respondents may see the stale version for up to an hour.
**Fix**: Switched form definitions to `NetworkFirst` strategy with 5s timeout and 5-minute fallback cache.

---

## Phase 4: Frontend Quality & UX

### 4.1 Signature Field Keyboard Accessibility
**Severity**: HIGH
**File**: `ui/src/pages/FormResponse.tsx` ~L367-481
**Problem**: The signature canvas has no keyboard alternative. Users who can't use a mouse/touchscreen are completely blocked from completing forms with signature fields.
**Fix**:
- Add a "Type your name" text input as an alternative to drawing
- Include a keyboard shortcut or button to switch between draw/type modes
- Add `aria-label` and `role="img"` to the canvas

### 4.2 Missing Save Indicator
**Severity**: MEDIUM
**File**: `ui/src/stores/formStore.ts` ~L268-293
**Problem**: `updateForm` performs debounced async saves but there's no UI indicator showing save status. Users don't know if their changes are saved.
**Fix**:
- Add `savingFormIds: Set<string>` to formStore state
- Set it when debounce fires, clear on API success/failure
- Show "Saving..." / "Saved" / "Save failed" indicator in FormBuilder header

### 4.3 No Offline Mode Indicator
**Severity**: MEDIUM
**File**: `ui/src/hooks/useOnlineStatus.ts` exists but isn't used in main UI
**Problem**: `useOnlineStatus` hook exists but no component displays network status. Users submitting forms offline get silent failures.
**Fix**:
- Add a global offline banner in `AppShell` and `AppRuntimeShell`
- Disable submit buttons when offline with tooltip explaining why
- Show pending sync count if background sync is queued

### 4.4 Missing ARIA Labels on Dynamic Content [DONE]
**Severity**: MEDIUM
**File**: `ui/src/pages/FormsList.tsx` ~L94-157
**Problem**: Portal-based dropdown menus lack ARIA attributes. Screen reader users can't navigate these menus.
**Fix**:
- Added `role="menu"`, `aria-label` to dropdown portal
- Added `role="menuitem"` to all menu buttons
- Added `aria-haspopup="menu"`, `aria-expanded` to trigger button

### 4.5 Form Validation Not Announced to Screen Readers [DONE]
**Severity**: MEDIUM
**File**: `ui/src/pages/FormResponse.tsx` ~L827-829
**Problem**: Inline validation errors appear visually but aren't announced to screen readers.
**Fix**:
```tsx
<div role="alert" aria-live="polite" className="text-red-500 text-sm">
  {error}
</div>
```

### 4.6 Optimistic Update Rollback Without Feedback [DONE]
**Severity**: MEDIUM
**File**: `ui/src/stores/formStore.ts` ~L239-265
**Problem**: When optimistic create/update fails and rolls back, the UI changes without explanation. User's work appears to vanish.
**Fix**: Added toast.error() notifications for all rollback scenarios (done as part of 2.1).

### 4.7 Stale Response Count After CSV Import
**Severity**: LOW
**File**: `ui/src/stores/responseStore.ts`
**Problem**: Response count badges aren't updated after CSV import. Requires manual page refresh.
**Fix**: Call `refreshForms()` or update the specific form's `responseCount` after successful CSV import.

### 4.8 Storage Mode Change Not Visible
**Severity**: MEDIUM
**Problem**: When switching between local/API storage, there's no visual indicator showing current mode or sync status.
**Fix**: Add a subtle badge in the sidebar or header: "Cloud" / "Local" with sync status icon.

### 4.9 Missing Loading States in App Runtime [DONE]
**Severity**: MEDIUM
**File**: `ui/src/components/app-runtime/AppFormView.tsx`
**Problem**: During form submission in app runtime, there's no loading overlay to prevent double-submission.
**Fix**: Disable submit button + show spinner during API call. Add `isSubmitting` state.

### 4.10 Theme Color Validation [DONE]
**Severity**: LOW
**File**: `ui/src/components/builder/ThemeEditor.tsx`
**Problem**: Custom theme colors are applied as inline styles without validation. Non-hex values could cause rendering issues.
**Fix**: Validate with `/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/` before applying.

### 4.11 Module-Level Session Callback Leak
**Severity**: MEDIUM
**Files**: `ui/src/stores/authStore.ts` ~L41-54, `ui/src/stores/appRuntimeStore.ts` ~L41-62
**Problem**: `sessionExpiredRegistered` is a module-level flag. If stores are recreated (dev hot reload, testing), the callback registration state becomes stale.
**Fix**: Move the registration flag into Zustand state itself, or use a WeakRef pattern to avoid leaks.

### 4.12 Missing Document Event Listener Cleanup [DONE]
**Severity**: MEDIUM
**File**: `ui/src/pages/FormBuilder.tsx` ~L258-268
**Problem**: Mobile menu click-outside detection adds a `document` event listener that isn't properly cleaned up if the component unmounts while the menu is open.
**Fix**: Add cleanup in useEffect return:
```typescript
useEffect(() => {
  if (!mobileMenu) return;
  const handler = (e: MouseEvent) => { /* ... */ };
  document.addEventListener('click', handler);
  return () => document.removeEventListener('click', handler);
}, [mobileMenu]);
```

### 4.13 Sensitive Form Data in localStorage [DONE]
**Severity**: MEDIUM
**File**: `ui/src/stores/formStore.ts` L199
**Problem**: In API mode, form data was unnecessarily persisted to localStorage despite being server-backed.
**Fix**: Changed `partialize` to only persist forms when `storageMode === 'local'`. API mode persists an empty array.

---

## Phase 5: Testing & Developer Experience

### 5.1 Add Frontend Test Infrastructure
**Severity**: HIGH
**File**: `ui/package.json`
**Problem**: Zero test infrastructure. No Jest, Vitest, React Testing Library, or Playwright. All UI logic is completely untested.
**Fix**:
- Install Vitest + React Testing Library + jsdom: `npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom`
- Add `vitest.config.ts` with jsdom environment
- Add `"test": "vitest"` to package.json scripts
- Priority test targets:
  1. Zustand stores (formStore CRUD, auth flow, optimistic updates)
  2. `useConditionalLogic` and `useFieldValidation` hooks
  3. API client error handling
  4. FormBuilder field operations

### 5.2 Add Backend Test Infrastructure
**Severity**: HIGH
**File**: `backend/composer.json`
**Problem**: PHPUnit is in `require-dev` but no tests exist. No `tests/` directory.
**Fix**:
- Create `backend/tests/` directory structure
- Add `phpunit.xml` config
- Priority test targets:
  1. `AuthService` — registration, login, rate limiting, JWT validation
  2. `ResponseService::createResponse()` — the script execution pipeline
  3. `FormService` — CRUD with field ID generation, duplication
  4. `AuditService` — hash chain integrity
  5. `PackService::importPack()` — ID remapping logic

### 5.3 Add Static Analysis (Backend)
**Severity**: MEDIUM
**File**: `backend/composer.json`
**Problem**: No static analysis tool configured. Type errors and null pointer bugs caught only at runtime.
**Fix**:
- Install PHPStan: `composer require --dev phpstan/phpstan`
- Start at level 5, increase incrementally
- Add `"phpstan": "phpstan analyse src"` to composer scripts
- Fix errors before raising level

### 5.4 Add Pre-commit Hooks
**Severity**: LOW
**Problem**: No automated checks before commits. Easy to commit broken code, debug logs, or forgotten `console.log`.
**Fix**:
- Install `husky` + `lint-staged`
- Pre-commit: run ESLint on staged .ts/.tsx files, run `php -l` on staged .php files
- Pre-push: run `npm run build` (frontend type check)

### 5.5 Remove Production console.log/console.error
**Severity**: MEDIUM
**Files**: 23+ instances across stores and pages
**Problem**: `console.error()` calls in production code go nowhere useful. They clutter browser console and leak implementation details.
**Fix**:
- Create a `logger` utility: in development, logs to console; in production, sends to error tracking service (or no-ops)
- Replace all `console.error` with `logger.error()`
- Add ESLint rule: `no-console: warn`

### 5.6 Add API Documentation
**Severity**: MEDIUM
**Problem**: No API documentation. Frontend developers must read PHP source to understand endpoints.
**Fix**:
- Add OpenAPI/Swagger spec (can be generated incrementally)
- Or add a `docs/API.md` covering all endpoints with request/response examples
- Minimum: document auth flow, error response format, pagination patterns

### 5.7 Add Docker Compose for Local Development
**Severity**: LOW
**Problem**: Setup requires manual installation of PHP, MySQL, Node.js, and configuration of .env files. Complex for new developers.
**Fix**:
- Create `docker-compose.yml` with services: PHP-FPM, MySQL, Node.js (dev server), Nginx
- Auto-initialize database schema on first run
- Include `.env.docker` with pre-configured values

### 5.8 Frontend .env.example [DONE]
**Severity**: LOW
**Problem**: No `.env.example` for the frontend. Developers must guess what `VITE_*` variables are needed.
**Fix**: Create `ui/.env.example`:
```
VITE_API_URL=http://localhost:8080/api
```

### 5.9 Add ESLint Rules for Code Quality
**Severity**: LOW
**File**: `ui/eslint.config.js`
**Problem**: No custom rules for import ordering, complexity limits, or preventing unsafe patterns.
**Fix**: Add rules for:
- `import/order` — consistent import grouping
- `@typescript-eslint/no-explicit-any` — warn
- `react-hooks/exhaustive-deps` — error
- `no-console` — warn

### 5.10 SQLite Schema Version Tracking
**Severity**: LOW
**File**: `backend/src/Database/SQLiteConnection.php`
**Problem**: No version tracking for per-form SQLite schema changes. Migrations are ad-hoc.
**Fix**:
- Add `schema_version` key to `form_data` table on creation
- Check version on each connection, apply incremental migrations
- Provides safe evolution path for SQLite schemas

---

## Phase 6: Architecture & Long-term Improvements

### 6.1 Type Safety in API Client
**Severity**: HIGH
**File**: `ui/src/lib/api.ts` ~L404-659
**Problem**: App management and runtime endpoints return `unknown[]` and `unknown` types. No compile-time safety for the most complex part of the app.
**Fix**:
- Define proper TypeScript interfaces for all API responses (many already exist in `types/app.ts`)
- Replace `unknown` with proper types in all API methods
- Consider using Zod for runtime response validation on critical paths

### 6.2 Centralized Error Response Contract
**Severity**: MEDIUM
**Files**: All backend controllers
**Problem**: No base controller class or shared error handling. Each controller formats errors slightly differently.
**Fix**:
- Create `BaseController` with standardized helpers:
  - `errorResponse(Response, int $status, string $message, ?string $code = null)`
  - `validationError(Response, array $errors)`
  - `notFound(Response, string $resource)`
- All controllers extend BaseController

### 6.3 Background Job Queue
**Severity**: MEDIUM
**Problem**: Long-running operations (webhook delivery, AI generation, large exports) block HTTP requests.
**Fix**:
- Implement a simple file/database-backed job queue
- Or integrate a message queue (Redis-backed, or database-polled)
- Move to async processing:
  - Webhook delivery (retry with exponential backoff)
  - Large CSV imports (return job ID, poll for status)
  - AI form generation (return job ID, poll for result)

### 6.4 Structured Logging with Correlation IDs
**Severity**: MEDIUM
**File**: `backend/config/settings.php` ~L34-38
**Problem**: Logs don't include request correlation IDs. Impossible to trace a user's request through multiple service calls.
**Fix**:
- Generate a UUID per request in middleware, attach to Monolog context
- Include in all log entries: `$logger->info('Response created', ['correlationId' => $id, ...])`
- Return correlation ID in error responses for user-reported issues

### 6.5 Error Tracking Integration
**Severity**: MEDIUM
**Problem**: Frontend errors go to `console.error()`, backend errors go to log files. No alerting, no aggregation, no trends.
**Fix**:
- Frontend: integrate Sentry (or equivalent) for automatic error capture
- Backend: add Monolog handler for Sentry
- Configure alerting for error rate spikes

### 6.6 Database Read Replicas / Connection Pooling
**Severity**: LOW (future scaling)
**File**: `backend/src/Database/MySQLConnection.php`
**Problem**: Single MySQL connection for all operations. At scale, read-heavy operations (form listing, analytics) compete with writes.
**Fix**:
- Separate read/write connection configs
- Route read-only queries (listings, analytics, exports) to read replica
- Implement connection pooling for SQLite (already partially done with in-memory cache)

### 6.7 API Versioning Strategy
**Severity**: LOW
**Problem**: All endpoints are at `/api/*` with no versioning. Breaking changes would affect all clients simultaneously.
**Fix**:
- Add version prefix: `/api/v1/*`
- Document deprecation strategy
- Plan for v2 with breaking changes (e.g., consistent error format, proper typing)

### 6.8 Content Security Policy for Form Responses
**Severity**: MEDIUM
**Problem**: Form response data (user-submitted text) is rendered in various contexts. While React escapes by default, any `dangerouslySetInnerHTML` usage (markdown, rich text) would be vulnerable.
**Fix**:
- Audit all uses of `dangerouslySetInnerHTML` (should be zero or minimal)
- Add `Content-Security-Policy` header to frontend that restricts inline scripts
- Consider sanitizing response data at the API level before storage (DOMPurify equivalent in PHP)

---

## Implementation Notes

### Quick Wins (can be done in a single PR each)
- [x] 1.6 (redirect URL validation) — DONE
- [x] 1.10 (slug format validation) — DONE
- [x] 1.11 (CSRF cookie parsing) — DONE (already correct)
- [x] 1.12 (timing attack fix) — DONE
- [x] 2.13 (field ID uniqueness) — DONE
- [x] 2.11 (status transition validation) — DONE
- [x] 4.5 (ARIA live region) — DONE
- [x] 4.10 (theme color validation) — DONE
- [x] 5.8 (frontend .env.example) — DONE (already existed)

### Phase 1 Security Fixes
- [x] 1.1 (SSRF protection — cloud metadata blocking) — DONE
- [x] 1.2 (SSRF in WebhookService — DNS pinning, no redirects) — DONE
- [x] 1.4 (response ownership check) — DONE
- [x] 1.5 (race condition in form duplication) — DONE
- [x] 1.7 (ReDoS pattern validation) — DONE
- [x] 1.8 (input length validation) — DONE
- [x] 1.9 (linked record field ID validation) — DONE

### Phase 2 Error Handling
- [x] 2.1 (toast for silent API failures) — DONE
- [x] 2.2 (try/catch on async handlers) — DONE
- [x] 2.3 (export download error handling) — already correct
- [x] 2.6 (sanitize script error messages) — DONE
- [x] 2.7 (FormResponses null checks) — already correct
- [x] 2.8 (standardize error response shapes — AIController) — DONE
- [x] 2.9 (per-route error boundaries) — DONE

### Phase 2 continued
- [x] 2.12 (audit log for auth failures) — DONE

### Phase 3 Performance
- [x] 3.2 (N+1 query in form listing) — DONE
- [x] 3.3 (memoization in FormsList) — DONE
- [x] 3.6 (SQLite WAL mode + busy_timeout) — DONE
- [x] 3.8 (debounce race condition) — DONE
- [x] 3.11 (PWA form definition caching) — DONE

### Phase 4 Frontend Quality
- [x] 4.4 (ARIA labels on dynamic menus) — DONE
- [x] 4.6 (optimistic rollback feedback) — DONE (via 2.1)
- [x] 4.9 (double-submission prevention) — already correct
- [x] 4.12 (event listener cleanup) — already correct
- [x] 4.13 (don't persist API forms to localStorage) — DONE

### Requires Careful Testing
- 1.3 (dual-database consistency) — affects core data flow
- 3.1 (rate limiting replacement) — needs Redis infrastructure
- 3.8 (debounce race condition) — affects all form saves
- 5.1-5.2 (test infrastructure) — foundational for future quality

### Dependencies Between Items
- 3.1 (Redis rate limiting) enables 6.3 (job queue) if using Redis
- 5.1 (frontend tests) should precede 3.3-3.5 (performance refactors)
- 2.8 (error response contract) should precede 6.1 (API type safety)
- 6.2 (base controller) should precede 2.8 (error standardization)

---

## Verification Checklist

After implementing each phase:

1. `php -l` on all modified PHP files
2. `cd form-builder/ui && npm run build` — must pass
3. Manual smoke test: create form, add fields, preview, submit response, view responses
4. For security fixes: attempt the attack vector and verify it's blocked
5. For performance fixes: measure before/after (React DevTools Profiler, Chrome DevTools Network)
6. For backend fixes: verify with `curl` that error responses match expected format
