# AI App Builder (harness)

Turn **one prompt** into a fully-wired FormLogic **app** — a plan, multiple linked forms, `onSubmit`
scripts, roles, and the app shell — in a single run.

```bash
cd form-builder/tools/ai-app-builder
node run.mjs "Create a HR app that manages job applications, interviews, and offers"

# preview only (plan + generate + assemble + validate, create nothing):
node run.mjs --dry "Incident reporting app for a manufacturing site"
```

## Pipeline

1. **Plan** — one AI call turns the prompt into a structured plan: app name, the forms (key + title +
   purpose), the relationships between them, and roles.
2. **Generate** (the loop) — for each form, calls the app's form generator for its fields, and the
   script generator for an `onSubmit` script when the form needs logic.
3. **Assemble** — packages everything into a [Pack](../../../docs/API.md) — cross-form links are
   expressed as `linked_record` fields with `targetFormId: "@pack:<formKey>"`.
4. **Validate** — checks the plan + pack (unique keys, safe field ids, every link target resolves,
   importer limits) before touching the server.
5. **Import** — one atomic `POST /api/packs/import` creates the app, all forms, the links (the server
   remaps `@pack:` → real UUIDs), and the roles in a single transaction. Then publishes them.

## Config (env or `form-builder/backend/.env`)

| Var | Default | Purpose |
|---|---|---|
| `FL_API_BASE` | `http://api.formlogic.local` | FormLogic API host |
| `FL_EMAIL` / `FL_PASSWORD` | `test@example.com` / `password123` | account the app is created under |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | from backend `.env` | OpenAI-compatible model for planning |
| `FL_MAX_FORMS` | `6` | cap on generated forms (more = more slow AI calls) |

## Layout

- `config.mjs` — configuration
- `clients.mjs` — AI chat + the FormLogic API client (cookie-jar session + CSRF) — the only I/O
- `assemble.mjs` — **pure engine**: planner prompt, Pack assembler, validators (portable to the UI)
- `run.mjs` — the pipeline + CLI

## Notes / roadmap

- The pure engine in `assemble.mjs` is deliberately I/O-free so it can lift into
  `ui/src/lib/ai-app-builder/` for an in-app **"Generate app with AI"** flow with a **plan-preview**
  step (review/edit the plan before building) — the recommended next step.
- AI output is treated as untrusted: field ids are sanitized to the backend's rules, links must
  resolve, and the pack is validated before import; the import itself is transactional (rolls back on
  any error).
- Roles map by level: `admin` (full), `contributor` (submit + view own), `viewer` (view all). The
  importer is always the app **owner** regardless.
