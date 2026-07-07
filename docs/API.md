# FormLogic API

Access your forms programmatically — list forms, **submit responses that run your full backend
logic** (validation, calculated fields, and the `onSubmit` script), read/manage responses, pull
analytics, and manage webhooks.

A submission made through the API goes through the **exact same pipeline as a real form fill**:
field sanitization, server-side validation, calculated/hidden fields, and your `onSubmit(ctx)`
script (including `reject`, `setField`, `setStatus`, `addTag`). Anything you can do by filling out
the form in a browser, you can do over the API.

---

## Base URL

```
https://<your-api-host>/api/v1
```

`<your-api-host>` is the host your app's API runs on (the API subdomain on the hosted service; on a
self-host it's wherever the PHP backend is served). All endpoints below are relative to `/api/v1`.

## Authentication

1. In the app, go to **Settings → API keys → Create key**.
2. Give it a name, choose its **scopes** (least privilege — see below), optionally restrict it to
   specific forms and/or set an expiry.
3. Copy the key (`flk_…`). **It's shown only once** and stored hashed — keep it secret.

Send it as a Bearer token on every request:

```
Authorization: Bearer flk_xxxxxxxxxxxxxxxxxxxx
```

- A key only ever reaches **its owner's own forms**. Restricting a key to specific form IDs narrows
  it further.
- Missing/invalid key → `401`. Valid key without the required scope → `403`.
- Requests are rate-limited per key; exceeding the limit returns `429`.
- Use HTTPS in production — the key is a credential.

## Scopes

| Scope | Grants |
|---|---|
| `forms:read` | List forms, read a form + its fields |
| `responses:write` | Submit responses (single + batch) — **runs the onSubmit script** |
| `responses:read` | List/read responses, read analytics |
| `responses:manage` | Update / delete responses |
| `webhooks:read` | List webhooks |
| `webhooks:write` | Create / update / delete webhooks |
| `flows:read` | List flows + flow bindings, read run history, poll claimable queued runs, read flow KV |
| `flows:write` | Claim queued flow runs, complete runs, write/delete flow KV |
| `connector:relay` | Act as a desktop runtime: long-poll for pending connector commands, claim + complete them |

Grant only what each integration needs (e.g. a kiosk that only submits needs just
`responses:write`).

---

## Endpoints

### Forms
| Method | Path | Scope |
|---|---|---|
| `GET` | `/forms` | `forms:read` |
| `GET` | `/forms/{formId}` | `forms:read` |
| `GET` | `/forms/{formId}/fields` | `forms:read` |

### Responses
| Method | Path | Scope |
|---|---|---|
| `POST` | `/forms/{formId}/responses` | `responses:write` |
| `POST` | `/forms/{formId}/responses/batch` | `responses:write` |
| `GET` | `/forms/{formId}/responses` | `responses:read` |
| `GET` | `/forms/{formId}/responses/{id}` | `responses:read` |
| `PUT` | `/forms/{formId}/responses/{id}` | `responses:manage` |
| `DELETE` | `/forms/{formId}/responses/{id}` | `responses:manage` |
| `GET` | `/forms/{formId}/analytics` | `responses:read` |

### Webhooks
| Method | Path | Scope |
|---|---|---|
| `GET` | `/forms/{formId}/webhooks` | `webhooks:read` |
| `POST` | `/forms/{formId}/webhooks` | `webhooks:write` |
| `PUT` | `/forms/{formId}/webhooks/{webhookId}` | `webhooks:write` |
| `DELETE` | `/forms/{formId}/webhooks/{webhookId}` | `webhooks:write` |

### FormLogic Flows (headless runtime — used by FormLogic Desktop)

See `docs/FORMLOGIC_FLOWS.md` for the full flow model (queued→claim lifecycle, KV, workspace scope).
All paths are owner-scoped: a key only ever sees flows/bindings/runs of flows its owner owns.

| Method | Path | Scope |
|---|---|---|
| `GET` | `/flows` (`?appId=` / `?workspace=1`) | `flows:read` |
| `GET` | `/flow-bindings` (`?formId=`) | `flows:read` |
| `GET` | `/flow-runs` (`?flowId=&status=&appId=&page=&limit=`) | `flows:read` |
| `GET` | `/flow-runs/queued` | `flows:read` |
| `POST` | `/flow-runs/{runId}/claim` — `{runtime:'browser'\|'desktop', instanceId?}`; `409` if already claimed | `flows:write` |
| `PATCH` | `/flow-runs/{runId}` — complete: `{status, result?, error?}`; `409` if already finalized | `flows:write` |
| `GET` | `/flow-kv` (`?scope=&k=&appId=`) | `flows:read` |
| `PUT` | `/flow-kv` — `{scope, k, v, appId?}` (value ≤ 64 KiB, ≤ 500 keys/scope) | `flows:write` |
| `DELETE` | `/flow-kv` (`?scope=&k=&appId=`) | `flows:write` |

### Remote command relay (`connector:relay`) — desktop runtime side

A web member enqueues a connector command (e.g. an Aokie call action) for the app owner's paired
FormLogic Desktop runtime running on another machine; the desktop long-polls for pending commands,
claims one (`pending → claimed`, exactly-once) and completes it (`claimed → done|failed`). The web
member reads the result via the app-runtime endpoint below. Pending commands **expire 60 s** after
they are created (swept to `expired` on the next poll). All paths are owner-scoped: a key only ever
sees commands for the apps its owner owns.

| Method | Path | Scope |
|---|---|---|
| `GET` | `/connector-commands/pending` (`?since=<commandId>&wait=<ms ≤ 25000>&limit=`) — long-poll; returns as soon as any pending exist, else after `wait` | `connector:relay` |
| `POST` | `/connector-commands/{id}/claim` — `{instanceId?}`; `409` if already claimed or expired | `connector:relay` |
| `POST` | `/connector-commands/{id}/complete` — `{status:'done'\|'failed', result?, error?}`; `409` if not in the claimed state | `connector:relay` |

The **enqueue** + **read** side is a session-authed app-runtime surface (not `/api/v1`), used by the
web UI:

| Method | Path | Auth |
|---|---|---|
| `POST` | `/api/app/{slug}/connector-commands` — `{connectorId, command, payload?, idempotencyKey?}` → `{commandId, status}` | session; app **member** AND `connector.<connectorId>.<command>` role grant (rate-limited `connector_relay`, 30/min) |
| `GET` | `/api/app/{slug}/connector-commands/{id}` → `{command}` (status/result/error) | session; app member |

Reserve-first on `idempotencyKey`: a duplicate enqueue returns the existing command (`200` with
`idempotent:true`). The `connector.<connectorId>.<command>` gate is the SAME permission the in-app
connector client checks — a per-connector wildcard `connector.<connectorId>.*` or the bare
`connector.<connectorId>` grant also satisfies it, and the app owner always passes.

**Cleanup cron note:** pending commands are expired opportunistically on each poll; a periodic sweep
should also call `DesktopCommandService::expireStale()` (no argument = global) to reap commands from
owners whose desktop never polls.

---

## Submitting a response (with full scripting)

`POST /forms/{formId}/responses` — body is `{ "answers": { fieldId: value, … } }`, keyed by **field
ID** (find IDs via `GET /forms/{formId}/fields`).

```bash
curl -X POST https://<your-api-host>/api/v1/forms/FORM_ID/responses \
  -H "Authorization: Bearer flk_xxx" \
  -H "Content-Type: application/json" \
  -d '{ "answers": { "full_name": "Ada Lovelace", "score": 80 } }'
```

What happens server-side, in order — identical to a browser submission:

1. **Sanitize** — non-input and unknown fields are dropped; client-supplied `status` is ignored.
2. **Calculated / hidden fields** are computed on the server (you can't set them from the client).
3. **Validation** — required fields, types, and your validation rules run. Failures → `400`.
4. **`onSubmit(ctx)` script** runs — it can `reject` the submission, `setField`, `setStatus`,
   `addTag`, call `ctx.http`, etc.

**Success** → `201`:

```json
{
  "response": {
    "id": "…",
    "status": "approved",                 // e.g. set by the script
    "answers": { "full_name": "Ada Lovelace", "score": 80, "grade": 160 },  // incl. calculated
    "tags": ["high-score"],               // added by the script
    "submittedAt": "…"
  }
}
```

**Rejected by the script** → `422`:

```json
{ "error": true, "rejected": true, "message": "Score cannot be negative" }
```

**Validation failed** → `400`:

```json
{ "error": true, "message": "Validation failed", "errors": { "score": "This field is required" } }
```

### Batch submit

`POST /forms/{formId}/responses/batch` with `{ "responses": [ { "answers": {…} }, … ] }` (max 100).
Each item runs the full pipeline independently; the response reports per-item success/failure:

```json
{ "total": 2, "succeeded": 1, "failed": 1,
  "results": [ { "index": 0, "success": true, "responseId": "…" },
               { "index": 1, "success": false, "errors": { "email": "Invalid email address" } } ] }
```

---

## Errors

| Status | Meaning |
|---|---|
| `400` | Validation failed (see `errors`) or malformed request |
| `401` | Missing / invalid API key |
| `403` | Key lacks the required scope (or the form isn't accepting responses) |
| `404` | Form / response not found, or not accessible to this key |
| `413` | Submission too large |
| `422` | Submission rejected by the `onSubmit` script (`rejected: true`) |
| `429` | Rate limit exceeded |

Error bodies use a consistent shape: `{ "error": true, "message": "…", "errors"?: {…} }`.

---

## Notes

- The `onSubmit` script runs in the same sandbox as in the app (instruction/time/memory limits, no
  filesystem; `ctx.http`/`ctx.db` are synchronous). See the in-app **Docs → Backend scripts**.
- `PUT /forms/{formId}/responses/{id}` returns the updated record only if the key also holds
  `responses:read`; a `responses:manage`-only key gets `{ "success": true, "id": "…" }`.
- A successful API submission triggers the form's "new response" email notification and is recorded
  in the audit log, just like a browser submission.
