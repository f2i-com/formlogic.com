# MCP — build apps with your own AI

FormLogic ships an **MCP server** (Model Context Protocol, over HTTP) so you can point your *own* AI —
Claude Desktop, Claude Code, Cursor, or anything that speaks MCP — at a FormLogic app and have it build
and edit forms, write **custom screens**, and wire everything together. Bring your own (frontier) model
instead of the built-in one.

It works over a **temporary, scoped connection**: a short-lived bearer token with an idle timeout that you
can revoke at any time.

> Beta. App screens created this way run in the same sandbox as everything else (see [Custom screens](#)).

---

## Connecting

There are three places to start a connection — all open the same **Connect an AI** dialog:

| From | Scope of the token |
|---|---|
| **Settings → Connect an AI** | All your apps (account-wide) |
| **App settings → Manage → Connect an AI** | That one app only |
| **Apps → "Hand to an AI"** | Creates a blank app, then a link scoped to it |

Click **Generate connection**. You'll get an **MCP URL**, a **bearer token** (shown once), and a ready‑to‑paste
client config:

```json
{
  "mcpServers": {
    "formlogic": {
      "url": "https://your-host/api/mcp",
      "headers": { "Authorization": "Bearer flm_xxxxxxxx" }
    }
  }
}
```

Add it to your MCP client as a **remote / HTTP MCP server**. The endpoint speaks JSON‑RPC 2.0
(`initialize`, `tools/list`, `tools/call`).

---

## The connection is temporary

| | Default |
|---|---|
| Hard expiry (TTL) | **1 hour** (max 24h) |
| Idle timeout | **15 minutes** of inactivity |
| Reveal | token shown **once** at creation |
| Revoke | any time, from the same dialog |

Treat the token like a password — it can create and edit your content. The token is stored only as a
SHA‑256 hash; it can't be recovered after creation (generate a new one if lost).

---

## Scopes

Each token carries a capability list. The **default ("builder") token** can manage apps, forms, and
screens — but **cannot read submission data**:

`apps:read` · `apps:write` · `forms:read` · `forms:write` · `screens:write`

`responses:read` is **off by default** and must be granted explicitly. `tools/list` only returns the tools
your token's scopes allow.

**App‑scoped tokens** are enforced everywhere: they only see that one app's forms, can't create new apps,
and can't touch other apps or their forms.

---

## Self-describing (zero prior knowledge)

You can hand the link to any MCP-capable AI and just say *"build me an app"* — it doesn't need to know
FormLogic in advance:

- The **`initialize`** response carries an `instructions` string (the MCP client feeds it to the model) with
  the whole workflow: `create_app` → `create_app_form` → `set_app_home` → publish, the field types, and the
  custom-screen SDK.
- **`get_started`** is the first tool listed and returns a full guide with a worked example. It needs no
  scope, so an AI can always read it before acting.

## Tools

| Tool | Scope | What it does |
|---|---|---|
| `list_forms` | forms:read | List your forms (only the scoped app's, if app‑scoped) |
| `get_form` | forms:read | Get one form (fields, `logicScript`, `customScreen`) |
| `create_form` | forms:write | Create a form (fields, onSubmit script, custom screen, status) |
| `update_form` | forms:write | Update a form |
| `list_apps` | apps:read | List your apps (only the scoped one, if app‑scoped) |
| `create_app` | apps:write | Create an app (rejected for app‑scoped tokens) |
| `update_app` | apps:write | Rename, set description, change the **slug**, or publish |
| `add_form_to_app` | apps:write | Attach a form to an app |
| `set_app_home` | screens:write | Set the app's custom **home** screen |
| `list_responses` | responses:read | List a form's responses (off by default) |

Everything goes through the same services + ownership checks as the rest of the API, so an MCP token can
only ever touch the owner's resources (and, when app‑scoped, only that app).

### Custom screens via MCP

`create_form`/`update_form` accept a `customScreen` (`{ enabled, html, css, js }`) — a sandboxed UI over the
form that talks to the backend through the injected `FormLogic` SDK (`submit` / `records` / `currentUser` /
`context` / `toast`). `set_app_home` does the same for an app's landing page, with an app‑scoped SDK
(`submit(formId, …)` / `records(formId)` / `navigate(formId)`). See [docs/API.md](API.md) for the data model.

A good build flow for "hand a blank app to an AI":

1. `update_app` — name the app (and optionally set its slug).
2. `create_form` — create each form with its fields.
3. `add_form_to_app` — attach each form.
4. `update_form` / `set_app_home` — add custom screens.
5. `update_app` — `status: "published"`.

---

## Security

- Tokens are short‑lived (TTL + idle timeout), revocable, and hashed at rest.
- Default tokens cannot read submission data (`responses:read` is opt‑in); there is no response **write**
  tool over MCP.
- App‑scoped tokens are enforced on every call.
- Per‑call size caps (fields 500KB, script 100KB, custom screen 512KB) and a JSON‑RPC batch cap (20).
- Every action is audited (`mcp.*`) with the owner's user id.
- The `/api/mcp` endpoint authenticates with the bearer token only — never a session cookie.

To turn the **built‑in** AI off entirely and steer everyone to bring‑your‑own‑AI, set `AI_ENABLED=false`
in the backend `.env`.
