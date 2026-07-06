# AI App Builder (harness)

Turn **one prompt** into a fully-wired FormLogic **app** — a plan, multiple linked forms, `onSubmit`
scripts, roles, a **widget dashboard home**, and the app shell — in a single run.

```bash
cd form-builder/tools/ai-app-builder

node run.mjs "Create a HR app that manages job applications, interviews, and offers"

# build + validate everything but create nothing — writes the pack JSON to disk instead:
node run.mjs --dry-run "Incident reporting app for a manufacturing site"
node run.mjs --dry-run --out incident-app.json "Incident reporting app for a manufacturing site"

# offline self-test (no AI, no backend) — canned plan → assemble → sanitize → validate:
node selftest.mjs
```

## Pipeline

1. **Plan** — one AI call turns the prompt into a structured plan: app name + **kind** (admin console /
   client portal / staff app / …), the forms (key + title + purpose), the relationships between them,
   and roles.
2. **Generate** (the loop) — for each form, calls the app's form generator (`/api/ai/generate-form`)
   for its fields, and the script generator for an `onSubmit` script when the form needs logic.
3. **Assemble** — packages everything into a [Pack](../../../docs/PACK_FORMAT.md) — cross-form links
   are `linked_record` fields with `targetFormId: "@pack:<formKey>"`; a valid plan `kind` becomes
   `settings.appKind`.
4. **Dashboard** — a second AI call designs the app's home dashboard (the no-code
   `customScreen: { kind: 'dashboard', widgets: [...] }` — KPIs, charts, joins, lists, activity,
   quick actions) from the **final** generated field ids. Every widget is sanitized against the pack
   using the same rules as the server (`AppReportService::sanitizeDashboard`); anything referencing a
   hallucinated field/form is dropped with a logged reason. If nothing chartable survives (or the AI
   call fails), a deterministic built-in template takes over — a generated app never lands on a bare
   form list.
5. **Validate** — checks the plan + pack (unique keys, safe field ids, every `@pack:` link/role/widget
   ref resolves, importer size caps) before touching the server.
6. **Import** — one atomic `POST /api/packs/import` creates the app, all forms, the links (the server
   remaps `@pack:` → real UUIDs), the dashboard, and the roles in a single transaction. Then publishes
   the forms + the app.

## What gets created

- One **app** (published), with `settings.appKind` when the plan picked a valid kind.
- All **forms** (published) with AI-generated fields; relations become `linked_record` fields.
- **onSubmit scripts** on forms the generator flagged as needing logic (best-effort).
- **Roles** mapped by level: `admin` (full form permissions), `contributor` (submit + view own),
  `viewer` (view all). The importer is always the app **Owner** regardless.
- A **widget dashboard** as the app home (`customScreen.kind = 'dashboard'`): KPI counts/sums, bar/
  area breakdowns, joined charts (e.g. jobs per client via the link field), a recent-records list, an
  activity feed, and a quick-actions row.

## Config (env or `form-builder/backend/.env`; `process.env` wins)

| Var | Default | Purpose |
|---|---|---|
| `FL_API_BASE` | `http://api.formlogic.local` | FormLogic API host |
| `FL_EMAIL` / `FL_PASSWORD` | `test@example.com` / `password123` | account the app is created under |
| `AI_BASE_URL` | `http://localhost:8001/v1` | OpenAI-compatible `/v1` root (same convention as the app) |
| `AI_API_KEY` | *(empty)* | only if your provider needs one — **keyless local servers work** |
| `AI_MODEL` | `gpt-4o` | model name for the plan + dashboard calls |
| `FL_MAX_FORMS` | `6` (max 12) | cap on generated forms (more = more slow AI calls) |
| `FL_AI_TIMEOUT_MS` | `300000` | per-AI-call timeout (raise for slow local models) |

Keyless local example (LM Studio / llama.cpp / Ollama's OpenAI endpoint):

```bash
AI_BASE_URL=http://localhost:8001/v1 AI_MODEL=qwen2.5-32b-instruct \
  node run.mjs "A dog-walking business: clients, dogs, walks, incident reports"
```

Note: steps 2's form/script generation goes through the **backend's** AI endpoints, so the backend
`.env` must have a working `AI_BASE_URL` too (by default the harness reads the same file, so they
already match).

## Layout

- `config.mjs` — configuration (env + backend `.env`)
- `clients.mjs` — AI chat (`aiChat`/`aiJson` with JSON-retry) + the FormLogic API client
  (cookie-jar session + CSRF) — the only I/O
- `assemble.mjs` — **pure engine**: prompts, Pack assembler, dashboard sanitizer + fallback template,
  validators (portable to `ui/src/lib/ai-app-builder/`, which hosts the in-app port)
- `run.mjs` — the pipeline + CLI (`--dry-run` / `--out`)
- `selftest.mjs` — offline self-test of the pure engine (run it after changing `assemble.mjs`)

## Failure modes & troubleshooting

- **AI endpoint down / wrong URL** — errors name the exact host and the env var to fix
  (`AI_BASE_URL` must be a `/v1` root; leave `AI_API_KEY` empty for keyless local servers).
- **Model returns prose instead of JSON** — `aiJson` retries once demanding JSON-only, then fails
  with the start of the reply so you can see what the model actually said.
- **Import rejected** — the server's message is surfaced verbatim and the assembled pack is written
  to `<id>.failed.formlogic.json` so you can inspect/fix/re-import it via the Apps dashboard. If the
  message mentions `unverified_package`, the workspace has `REQUIRE_VERIFIED_PACKAGES=true`, which
  blocks flat JSON imports.
- **Dashboard widgets missing** — the run log lists every widget the sanitizer dropped and why
  (hallucinated field, bad join, unknown form). The built-in template kicks in when the AI design is
  unusable, so the app still gets a working dashboard.

## Notes / roadmap

- The pure engine in `assemble.mjs` mirrors the server's rules on purpose:
  `PackService::validatePack` (structure, `@pack:` remapping, size caps) and
  `AppReportService::sanitizeDashboard` (widget kinds, chart-spec vocabulary, layout clamps). The
  importer *silently drops* unresolved dashboard widgets and role grants — the harness treats those
  as build errors instead so generated apps never ship dead panels.
- Dashboard specs only carry pack-transportable keys (`formId/viz/joins/groupBy/measure/filters/
  columns/seriesSort/sort/having/limit`) — `dateRange`, `filterMode`, and presentation keys are
  stripped by `PackService::resolveSpecRefs` on import, so emitting them would be silently lost.
- The backend now has its own planning endpoint (`POST /api/ai/generate-app-plan`) used by the in-app
  "Generate with AI" flow; the harness keeps its own planner because it also selects `appKind` and
  pairs with the dashboard-design call, which the server planner doesn't return.
- AI output is treated as untrusted end to end: field ids are sanitized to the backend's rules, links
  and widget refs must resolve, and the pack is validated before import; the import itself is
  transactional (rolls back on any error).
