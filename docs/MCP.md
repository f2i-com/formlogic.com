# MCP — build apps with your own AI

[Documentation home](../README.md) · [AI setup](FREE_PLANS_AND_AI_SETUP.md) ·
[Connected apps and Aokie](CONNECTED_APPS.md) · [Hosted app actions](HOSTED_APPS.md)

FormLogic ships an **MCP server** (Model Context Protocol, over HTTP) so you can point your *own* AI —
using a compatible client — at a FormLogic app and have it build and edit forms,
compose **widget dashboards**, publish **Softn app projects**, write private
backend actions, configure roles and connect **Aokie** to an existing app.

It works over a **temporary, scoped connection**: a short-lived bearer token with an idle timeout that you
can revoke at any time. Clients that support remote MCP OAuth start from the MCP
URL; other compatible HTTP clients can use a [manual token](#manual-tokens-advanced--other-clients).

MCP gives an external AI tools to build in your account. **Connect your AI**
selects the model used by FormLogic's own chat; these are separate connections.
Use the public `/ai-setup` guide before signing in, or `/llms.txt` for an AI-readable
overview. Signup, verification, OAuth consent, native installation and phone
pairing remain user setup steps; they are not MCP tools.

**Start every build by reading `get_started`, then inspect existing apps before
editing them.** For an existing app, use an app-scoped connection. Combining two
existing apps needs a connection that can access both.

Screens and backend actions use the same host boundaries as their UI editors.
See [Custom screens](API.md) and [Hosted apps](HOSTED_APPS.md).

---

## Connecting from Claude / ChatGPT (OAuth)

FormLogic is an OAuth 2.1 **protected resource** and **authorization server** on
the same origin. A client that supports remote MCP discovery and OAuth can
discover the connection from the MCP URL. Client availability and menu labels
depend on that client's account and version.

**User steps**

1. Copy your MCP URL — `https://<your-host>/api/mcp` (shown in **Settings → External AI access → Manage AI connections**).
2. Add a remote HTTP MCP connection in your client, paste the URL and start its
   authentication flow. If it only accepts bearer headers, use the manual-token
   instructions below instead.
3. Your browser opens FormLogic's consent page (`/oauth/authorize`). Sign in if you aren't already.
4. Check **who is asking** (the client name and the redirect host are shown — if they aren't the AI you
   just used, deny), optionally **limit the connection to one app**, and **Approve**.
5. Back in the AI client the connection completes and the FormLogic tools appear.

Approving mints a normal scoped MCP session under the hood (token prefix `flm_oauth_`), so everything in
[Scopes](#scopes), [Tools](#tools) and [Security](#security) applies unchanged — same app-scoping, same
audit trail, revocable like any other token.

> **Hosted clients need a reachable server.** A service running outside your
> machine cannot reach your `localhost`. Use the deployed HTTPS origin for a
> hosted client, or a locally running MCP client for a local development server.

### How the flow works (technical appendix)

The discovery chain, starting from nothing but the pasted URL:

1. The client calls `POST /api/mcp` without a token and gets a **401** carrying
   `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/api/mcp", scope="<default scopes>"`.
2. It fetches the **protected-resource metadata** (RFC 9728) — served at both the `/api/mcp` path-suffix
   form and the root form — which names the resource (`<origin>/api/mcp`, exactly the URL you pasted)
   and its authorization server (`<origin>`).
3. It fetches the **authorization-server metadata** (RFC 8414) at `/.well-known/oauth-authorization-server`.
4. It registers as a client (CIMD or DCR, below) and runs the **authorization-code + PKCE (S256)** flow
   through the consent page and token endpoint.

The origin is derived from the request host with the same upgrade-only scheme rule as the signed app
manifests (production is always `https`), so the advertised `resource` matches the URL users paste.

**Endpoints**

| Endpoint | Method | Notes |
|---|---|---|
| `/.well-known/oauth-protected-resource` (also `…/api/mcp`) | GET | RFC 9728 protected-resource metadata; CORS `*` |
| `/.well-known/oauth-authorization-server` | GET | RFC 8414 authorization-server metadata; CORS `*` |
| `/oauth/authorize` | GET | the consent page (an SPA route; requires a signed-in FormLogic session) |
| `/api/oauth/token` | POST | `application/x-www-form-urlencoded`; grants `authorization_code` + `refresh_token`; CORS `*`, rate-limited |
| `/api/oauth/register` | POST | RFC 7591 dynamic client registration; JSON, unauthenticated, rate-limited; CORS `*` |
| `/api/mcp` | POST | the MCP endpoint — `Authorization: Bearer` header only (tokens are never accepted in the query string) |

(`GET /api/oauth/authorize-info` and `POST /api/oauth/approve` are the consent page's same-origin support
APIs — approve is session-authenticated + CSRF-protected like every other authed POST, and performs the
final redirect back to the client from the browser.)

**Client registration** — three paths, in spec priority order:

1. **CIMD** (client-ID metadata document — Claude's preferred path): the `client_id` *is* an https URL
   with a path. The server fetches that JSON document server-side (SSRF-guarded, 5s timeout, 64KB cap,
   JSON content-type, cached ~5 minutes), requires the document's `client_id` to equal the URL exactly,
   and takes `redirect_uris` / `client_name` from it.
2. **DCR** (RFC 7591 — ChatGPT, and the general fallback): `POST /api/oauth/register` → `201` with a
   `client_id` (plus a `client_secret` — Claude registers as a **confidential** client this way).
3. **Public clients** (`token_endpoint_auth_method: "none"`) are accepted.

**Redirect URIs** are exact-matched against the client's registered/CIMD list, with one RFC 8252
exception: `http://localhost:<port>/…` and `http://127.0.0.1:<port>/…` loopback redirects match
**port-agnostically** (Claude Code). Claude web/desktop/mobile uses
`https://claude.ai/api/mcp/auth_callback`.

**Tokens**

- **PKCE S256 is mandatory** (OAuth 2.1): authorize requests without a code challenge are rejected, and
  `plain` is not supported.
- Authorization codes are **one-time**, expire in ≤60 seconds, and are bound to the client, redirect URI,
  PKCE challenge, user, scopes, and resource (plus the optional one-app narrowing).
- **Access tokens** are opaque `flm_oauth_…` bearer tokens — real MCP sessions with an absolute expiry of
  **3600s**, **audience-bound** to `<origin>/api/mcp` (a token minted for one host is rejected on
  another), hashed at rest, and subject to the same idle timeout, revocation, and audit as manual tokens.
- **Refresh tokens** last ~30 days. Public clients get **rotation**: every refresh returns a new refresh
  token and invalidates the old one, and reuse of a rotated token revokes the whole token family.
  Confidential clients may keep the same refresh token.
- Errors follow RFC 6749: JSON `{ "error": "invalid_grant" | "invalid_client" | "invalid_request" |
  "unsupported_grant_type", "error_description": … }` with status 400 (401 for bad client credentials).

**Scopes and app narrowing** — the OAuth scope model *is* the [token scope model](#scopes); the metadata
documents additionally advertise `offline_access` for clients that request refresh tokens. The consent
page's **"Limit to one app"** picker mints an app-scoped session with exactly the semantics described
under [Scopes](#scopes).

---

## FormLogic Desktop device-link (first-party native client)

This is the account-link protocol used by compatible desktop runtimes, including
OAIY. Open **OAIY → Connections → Linked account** for the user-facing flow.
It is separate from an external AI's temporary MCP connection and from browser
pairing with OAIY's local API.

FormLogic Desktop links an account through the **same OAuth 2.1 authorization server**, but as a
first-party PUBLIC native client — no manual API-key paste. This reuses the authorize + consent +
PKCE machinery above; only the client and the token-exchange output differ.

- **Static client**: `client_id = formlogic-desktop`, PUBLIC (`token_endpoint_auth_method = none`),
  seeded automatically (`MySQLConnection::seedFirstPartyOAuthClients`). **PKCE S256 is required** —
  the public client's only proof-of-possession.
- **Loopback redirects (RFC 8252 §7.3)**: the registered redirect URIs are `http://127.0.0.1/callback`
  and `http://localhost/callback`, matched **port-agnostically** — the desktop binds any ephemeral
  local port for the one-shot callback listener. Non-loopback redirects are rejected for this client.
- **Distinct scope vocabulary**: this client requests **ApiKeyService** scopes, not MCP session
  scopes — `flows:read flows:write responses:write connector:relay`
  (`McpOAuthService::DESKTOP_SCOPES`). The consent page renders human-readable labels
  (`authorize-info` returns `scopeLabels` + `isDesktopLink` + the `?device=` label).
- **Token exchange mints a real scoped API key** (not an `flm_` MCP session): the `authorization_code`
  grant returns a long-lived `flk_…` key holding exactly the granted scopes, named
  *"FormLogic Desktop on `<device>`"* (the sanitized `?device=` label captured at authorize time),
  tied to a `desktop_connections` row. The token body is:

  ```json
  {
    "access_token": "flk_…",          // == formlogic_api_key (so generic OAuth libs find a bearer)
    "token_type": "Bearer",
    "scope": "flows:read flows:write responses:write connector:relay",
    "formlogic_api_key": "flk_…",     // the documented field the desktop stores
    "api_key_id": "…",
    "desktop_connection_id": "…",
    "device_name": "FormLogic Desktop on Reception PC"
  }
  ```

  There is **no `expires_in` / `refresh_token`** — the key is long-lived and revocable, not a rotating
  session. The desktop uses `formlogic_api_key` as the `Bearer` against `/api/v1`.
- **Revocation / re-link**: three ways, all end-state-equivalent (connection row gone + key revoked):
  - **From the web** — revoke in **Settings → API keys**, or delete the connection
    (`DELETE /api/desktop-connections/{id}`, session-auth) which revokes the tied key as a cascade.
  - **From the desktop** — clicking **Unlink** calls `DELETE /api/v1/desktop-connections/self` with its
    own `flk_` key (scope `flows:write`). The key identifies the install, so the server removes that
    install's own connection row and revokes the calling key — no id, and a key can only ever unlink
    itself. A hand-entered key (Advanced setup, no connection row) is left untouched.

  Re-linking mints a fresh key + connection; revoke the old one to supersede it.

The MCP flow above is unchanged — the desktop branch only runs for `client_id = formlogic-desktop`.

---

## Manual tokens (advanced / other clients)

For MCP clients without OAuth support, generate a bearer token by hand. There are three places to start —
all open the same **Connect an AI** dialog:

| From | Scope of the token |
|---|---|
| **Settings → External AI access → Manage AI connections** | All your apps (account-wide) |
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

(OAuth‑minted connections behave the same, except the access token always expires after 1 hour and the
client refreshes it silently — see [the appendix](#how-the-flow-works-technical-appendix).)

---

## Scopes

Each token carries a capability list. The **default ("builder") token** can manage apps, forms, screens
**and flows** (flows ride the `apps:*` scopes — they are app configuration) — but **cannot read or write
submission data**:

`apps:read` · `apps:write` · `forms:read` · `forms:write` · `screens:write`

`responses:read` (read records) and `responses:write` (create/update/delete records through the same
validated pipeline as the external API, including each form's onSubmit script) are **off by default** and
must be granted explicitly, as is **`connector:command`** (lets the token drive connectors on your linked
desktop runtime — e.g. control the Aokie phone). `tools/list` filters tools by
their primary scopes; some actions additionally require the scopes listed in
the project-tool table below when called.

**App‑scoped tokens** are enforced everywhere: they only see that one app's forms, can't create new apps,
and can't touch other apps or their forms.

---

## Self-describing (zero prior knowledge)

You can hand the link to any MCP-capable AI and just say *"build me an app"* — it doesn't need to know
FormLogic in advance:

- The **`initialize`** response carries an `instructions` string (the MCP client feeds it to the model) with
  the whole workflow: `create_app` → `create_app_form` → `set_app_home` (widget dashboard) → flows → publish,
  the field types, the dashboard widget shapes, and the custom-screen SDK.
- **`get_started`** is the first tool listed and returns a full guide with worked examples — including the
  complete flow node-type reference (§ Flows) and the record tools (§ Records). It needs no scope, so an AI
  can always read it before acting.
- **`tools/list` is ordered build-path-first** (`create_app`, `create_app_form`, `set_app_home`,
  `update_app`, `create_flow`, `create_flow_binding`, …) so clients that eager-load only the first tool
  schemas can build an app without waiting on lazily-loaded schemas.

## Tools

| Tool | Scope | What it does |
|---|---|---|
| `list_forms` | forms:read | List your forms (only the scoped app's, if app‑scoped) |
| `get_form` | forms:read | Get one form (fields, `logicScript`, `customScreen`) |
| `create_form` | forms:write | Create a form (fields, onSubmit script, custom screen, status) |
| `create_app_form` | forms:write + apps:write | Create a form and attach it to the target app in one call; preferred when building an app |
| `update_form` | forms:write | Update a form |
| `list_apps` | apps:read | List your apps (only the scoped one, if app‑scoped) |
| `create_app` | apps:write | Create an app — optional `description` + `appKind` audience tag (rejected for app‑scoped tokens) |
| `update_app` | apps:write | Rename, set description/slug, publish (`status: "published"`), unpublish (`"draft"`), or select an existing published project with `hostedDashboard: true` |
| `add_form_to_app` | apps:write | Attach a form to an app |
| `set_app_home` | screens:write | Set the app's **home** screen — a widget **dashboard** (preferred) or a custom code screen |
| `set_form_screen` | screens:write | Set a form's **custom screen** (replaces the whole `customScreen`) — the form-side twin of `set_app_home` |
| `list_blueprints` | apps:read | List the account's **diagrams** (blueprints) — the visual sketches on the /diagrams canvas |
| `get_blueprint` | apps:read | Get one diagram: elements (nodes + edges) and its current `semanticRevision` |
| `blueprint_propose_elements` | apps:write | Sketch/edit a diagram with typed operations. `commit:false` parks a **ghost preview** the owner approves on the canvas; `commit:true` applies |
| `materialize_blueprint` | apps:write | Turn a diagram into a **real app** (concept forms → real forms, relations → `linked_record` fields, flows/triggers/actors) — delta mode adds later sketches to the same app |
| `create_report` | apps:write | Add a chart, KPI, or table to the app's Reports section |
| `create_document` | apps:write | Compose an exportable PDF report page from charts and text |
| `list_flows` | apps:read | List an app's flows (automations) — summaries only |
| `get_flow` | apps:read | Get one flow incl. its `flowJson` graph + `nodeCapabilities` |
| `create_flow` | apps:write | Create a flow: a graph of nodes (LLM chat, find/submit/update records, condition, template, sandboxed JavaScript logic, HTTP, connector commands, speech) |
| `update_flow` | apps:write | Update a flow (name/slug/description/`flowJson`/`nodeCapabilities`/enabled; graph changes bump the version) |
| `delete_flow` | apps:write | Delete a flow (its bindings go with it) |
| `list_flow_bindings` | apps:read | List which events trigger which flows |
| `create_flow_binding` | apps:write | Wire a flow to its trigger: `form.submitted` + `formId`, or a connector event (e.g. `aokie.call.incoming` + `connectorId`) — with `inputMap` and optional `outputActions` |
| `update_flow_binding` | apps:write | Update a binding (partial) |
| `delete_flow_binding` | apps:write | Delete a binding (the flow stays) |
| `list_responses` | responses:read | List a form's responses (off by default) |
| `add_response` | responses:write | Create a record through the FULL pipeline (validation, calculated fields, onSubmit script). Off by default |
| `update_response` | responses:write | Patch a record (partial `answers` merged over the stored record, validated) and/or set its status. Off by default |
| `delete_response` | responses:write | Permanently delete a record. Off by default |
| `desktop_status` | connector:command | Is your FormLogic Desktop online (polling the relay)? Returns `{ online, lastSeenSecondsAgo }` — call before `connector_command`. |
| `connector_command` | connector:command | Send a command to a connector on your linked **FormLogic Desktop** and wait for the result — remote-control hardware/services like the **Aokie** phone bridge (`call.answer`/`call.hangup`/`call.operatorSpeak`/`sms.send`/…). Off by default. |

**`connector_command`** is how an AI drives your desktop remotely. It enqueues the command for the owner's
desktop runtime; the desktop (holding a `connector:relay` key) claims it exactly-once, runs it through its
local connector gateway, and completes the result — which the tool returns (or a note if the desktop is
offline). The desktop must be **running and linked** (see [device-link](#formlogic-desktop-device-link-first-party-native-client)).

Everything goes through the same services + ownership checks as the rest of the API, so an MCP token can
only ever touch the owner's resources (and, when app‑scoped, only that app).

**Implementation note (Phase 6, 2026‑07):** the tool handlers above (everything except the transport
tools `get_started` / `desktop_status` / `connector_command`) now live in the shared
`ChatToolsService` (`backend/src/Services/ChatToolsService.php`), which the floating **site chat**
also uses for its v1 tool subset (`docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md` §5.4). `McpController`
delegates to it, threading the token session (scopes, app/creator confinement, `mcp.*` audits)
through an explicit caller context — **MCP behavior, scopes, wire shapes and audit rows are
unchanged**; the extraction only gives the two surfaces one implementation that cannot drift.

### Portable projects and Aokie via MCP

These tools use the same project, composition and role services as App Studio.
They retain owner checks, token confinement and audit events. Read the current
project and permissions before replacing them.

| Tool | Required scopes | Use |
|---|---|---|
| `get_app` | `apps:read` | Read one app and its attached forms. |
| `get_workspace_template` | `apps:read` | Fetch an editable connected dashboard package; `template` is `workspace` or `aokie`. |
| `get_app_project` | `apps:read` | Read the deployment, current version and **private backend action source**. |
| `publish_app_project` | `apps:write`, `screens:write` | Publish `{appId, expectedVersion, package}` with per-app SQLite storage. |
| `get_aokie_starter` | `apps:read` | Inspect starter forms and requested connector capabilities before installation. |
| `install_aokie_starter` | `apps:write`, `forms:write`, `screens:write` | Create a new app from the starter; requires an explicit `approvedConnectorGrants` list. Nonempty grants also require `connector:command`. |
| `compose_apps` | `apps:write`, `forms:read` | Share existing forms between owned apps; moving automation additionally requires `connector:command` and reviewed connector grants. |
| `list_app_roles` | `apps:read` | Read current roles and valid permission names. |
| `create_app_role` | `apps:write` | Create an empty role before assigning permissions. |
| `set_app_role_permissions` | `apps:write` | Replace the role's complete ordinary permission list, retaining connector grants. |
| `set_app_role_connector_grants` | `apps:write`, `connector:command` | Replace the role's complete connector permission list, retaining ordinary permissions. |

**Publish a dashboard or custom app**

1. Read `get_app {appId}` and `get_app_project {appId}`. A missing deployment
   means the first publish uses `expectedVersion: 0`.
2. For a new connected interface, call `get_workspace_template {template:
   "workspace"}` or `{template: "aokie"}`. Edit the returned package, preserving
   existing private actions when updating a project.
3. Call `publish_app_project {appId, expectedVersion, package}`. Use the version
   you read, and merge newer work if publication reports a conflict.
4. Preview `/app/<slug>/project`. Then use `update_app {appId, hostedDashboard:
   true}` to make it home. Publishing the project does not publish the parent app;
   use `update_app {appId, status: "published"}` when it is ready for members.

The package separates public `.ui`/`.logic` files in `client` from private actions
in `actions`. Actions define `onRequest(ctx)` and use `ctx.db.get/list/put/remove`.
See [Hosted apps](HOSTED_APPS.md) for the format, access rules and transaction
limits. Keep private source out of client files; a client download does not
include records or an authenticated session.

**Integrate Aokie with an existing app**

1. Inspect `get_aokie_starter`. If installation is needed, call
   `install_aokie_starter {approvedConnectorGrants: [...]}` with the reviewed
   list, including `[]` when no capabilities are granted. Installation creates a
   new app and cannot use an app-scoped token; verified-package policy applies.
2. Read both apps and their form IDs. Call `compose_apps` with the destination as
   `appId`, Aokie as `sourceAppId`, and the selected `formIds`.
3. Sharing preserves form IDs and records, leaves automation in the source, and
   keeps the destination's home and roles. Aokie's Calls and Appointments forms
   expose its **Front desk** route alongside the existing home.
4. To transfer automation ownership too, use `moveAutomation: true` and an
   explicitly reviewed `approvedConnectorGrants` list. This includes all source
   forms, moves flows/bindings and disables source scripts to avoid duplicate
   writers. Active source runs and incompatible connector settings block the move.
5. Review destination member permissions with `list_app_roles`. Role updates
   replace the specified permission class; they cannot modify the system Owner
   role and do not send invitations.

Both apps must be owned by the caller and accessible to the token. Native OAIY
plugin installation, account linking, phone pairing and provider setup are
separate from starter installation. Check `desktop_status` before an authorised
hardware command, then verify records and flow outcomes in the destination app.
See [Connected apps](CONNECTED_APPS.md) for the complete user workflow.

### Widget dashboards via MCP (the primary home screen)

A dashboard is **data, not code**: a grid of widgets the host renders natively (theming, drill‑down and
auto‑refresh come free). `set_app_home` accepts it as the `customScreen`:

```json
{
  "appId": "<appId>",
  "customScreen": {
    "kind": "dashboard",
    "dashboard": {
      "cols": 12,
      "widgets": [
        { "kind": "report", "layout": { "x": 0, "y": 0, "w": 4, "h": 2 }, "title": "Open jobs",
          "spec": { "formId": "<formId>", "viz": "kpi", "measure": { "fn": "count" } } },
        { "kind": "actions", "layout": { "x": 0, "y": 2, "w": 12, "h": 1 } },
        { "kind": "list", "layout": { "x": 0, "y": 3, "w": 6, "h": 3 },
          "list": { "formId": "<formId>", "limit": 8, "titleField": "title" } }
      ]
    }
  }
}
```

- `dashboard` = `{ cols?: 12, widgets: […] (max 60), showRangePicker?, refreshInterval?: 30|60|300 }`.
- Every widget: `{ kind, layout: {x,y,w,h}, title? }`. Kinds: **report** (an inline chart/KPI/table —
  `spec` is exactly the `create_report` spec shape), **list** (recent records:
  `{ formId, limit?≤25, titleField?, subtitleField?, metaField? }`), **text** (`{ body }`), **actions**
  (new‑record buttons, no config), **activity** (a latest‑records feed, no config).
- Saves run through the same sanitizer as the app UI (`AppReportService`): a widget whose `formId`,
  joins, or field refs point outside the app is **dropped**, layout is clamped — use the real form ids.
- **Form section dashboards**: a form can carry its own dashboard on its section screen —
  `update_form { formId, customScreen: { kind: "dashboard", dashboard } }` *after* creating the form
  (its specs may reference that form and the forms its `linked_record` fields target). The same
  sanitizer runs on this path too (also when a dashboard is passed directly to
  `create_form`/`create_app_form`).

### Custom code screens via MCP

`create_form`/`update_form` accept a `customScreen` (`{ enabled, html, css, js/ts/files }`) — a sandboxed UI
over the form that talks to the backend through the injected `FormLogic` SDK (`submit` / `records` /
`currentUser` / `context` / `toast`). `set_app_home` does the same for an app's landing page, with an
app‑scoped SDK (`submit(formId, …)` / `records(formId)` / `navigate(formId)`). See [docs/API.md](API.md)
for the data model.

A good build flow for "hand a blank app to an AI":

1. `update_app` — name the app (and optionally set its slug). Or `create_app { name, description?, appKind? }`
   for account‑wide/creator tokens — `appKind` tags the audience: `admin` | `client` | `staff` | `public` |
   `internal` | `custom` (invalid values are rejected with the list of valid kinds).
2. `create_app_form` — create each form with its fields (creates **and** attaches in one call).
3. `set_app_home` — give the app a **widget dashboard** home (or a custom code screen).
4. (optional) `update_form` — add `logicScript` automation and/or form **section dashboards**.
5. (optional) `create_report` / `create_document` — add charts, KPIs, and PDF report pages (forms must exist first).
6. `update_app` — `status: "published"` (`"draft"` unpublishes).

### Reports & PDF documents

`create_report` adds a single chart, KPI, or table to the app's Reports section. `create_document`
combines existing reports with explanatory text into an exportable PDF page. Create chart reports
first; documents reference them by the `id` returned from `create_report`.

**`create_report` inputs**

| Field | Required | Notes |
|---|---|---|
| `appId` | yes | |
| `name` | yes | |
| `description` | no | |
| `spec.formId` | yes | Real form id (as returned by `create_app_form`) |
| `spec.viz` | yes | `bar` \| `line` \| `area` \| `pie` \| `donut` \| `kpi` \| `table` |
| `spec.groupBy` | no | `{ field, bucket? }` — `bucket`: `"day"` \| `"month"` \| `"year"` for date fields |
| `spec.measure` | no | `{ fn, field? }` — `fn`: `count` \| `countDistinct` \| `sum` \| `avg` \| `min` \| `max` (`field` required except for `count`) |
| `spec.joins` | no | `[{ via, formId, type }]` — cross-form joins |
| `spec.filters` | no | `[{ field, op, value? }]` |
| `spec.columns` | no | Array of field refs (table viz) |
| `spec.seriesSort`, `spec.sort`, `spec.having`, `spec.limit` | no | Sorting, post-aggregate filter, row cap |

**`create_document` inputs**

| Field | Required | Notes |
|---|---|---|
| `appId` | yes | |
| `name` | yes | |
| `description` | no | |
| `blocks` | yes | At least one. Each block: `{ kind:"text", title?, body }` or `{ kind:"report", reportId, caption? }` |

**Examples**

*(a) KPI — total submission count*

```json
{
  "appId": "<appId>",
  "name": "Total submissions",
  "spec": { "formId": "<formId>", "viz": "kpi", "measure": { "fn": "count" } }
}
```

*(b) Bar chart grouped by a status field*

```json
{
  "appId": "<appId>",
  "name": "Jobs by status",
  "spec": {
    "formId": "<jobFormId>",
    "viz": "bar",
    "groupBy": { "field": "status" },
    "measure": { "fn": "count" }
  }
}
```

*(c) Table with specific columns*

```json
{
  "appId": "<appId>",
  "name": "Recent submissions",
  "spec": {
    "formId": "<formId>",
    "viz": "table",
    "columns": ["__submitted_at", "name", "email"],
    "limit": 50
  }
}
```

*(d) PDF document — intro text block + two chart blocks*

```json
{
  "appId": "<appId>",
  "name": "Monthly summary",
  "description": "KPIs and status breakdown",
  "blocks": [
    { "kind": "text", "title": "Overview", "body": "Submission counts and status breakdown for the current period." },
    { "kind": "report", "reportId": "<id from create_report for example (a)>", "caption": "Total submissions" },
    { "kind": "report", "reportId": "<id from create_report for example (b)>", "caption": "Breakdown by status" }
  ]
}
```

**Constraints**

- Use **real form ids** (returned by `create_app_form` / `list_forms`). The `@pack:` reference syntax
  is for offline pack files only — it is not valid over MCP.
- `spec.formId`, and every form id in `joins`, **must belong to the target app**. A foreign form id is
  rejected.
- `joins[].via` must be the id of a `linked_record` field on the **base** form pointing to the joined
  form.
- Field references in `groupBy`, `measure`, `filters`, and `columns` are one of:
  - a base form field id (e.g. `"status"`)
  - a joined-form field ref: `"<joinFormId>::<fieldId>"`
  - a pseudo-field: `__submitted_at` (submission timestamp) or `__status` (workflow status)
- `responses:read` scope is **not** required to create reports. Runtime data access still respects
  each user's response permissions.

---

## Security

- Tokens are short‑lived (TTL + idle timeout), revocable, and hashed at rest.
- Default tokens cannot read or write submission data: `responses:read` is opt‑in, and the record write
  tools (`add_response`/`update_response`/`delete_response`) need the separately opt‑in `responses:write`
  scope — and every write runs the same validated pipeline as the external API (field validation,
  calculated fields, the form's onSubmit script).
- App‑scoped tokens are enforced on every call.
- Per‑call size caps (fields 500KB, script 100KB, custom screen 512KB) and a JSON‑RPC batch cap (20).
- Widget‑dashboard and report specs are sanitized server‑side against the target app/form on save (the
  same `AppReportService` boundary as the UI): out‑of‑scope forms, joins, and field refs are dropped.
- Every action is audited (`mcp.*`) with the owner's user id.
- The `/api/mcp` endpoint authenticates with the bearer token only — never a session cookie, and never a
  token in the query string.
- OAuth‑minted tokens (`flm_oauth_…`) additionally carry an absolute 1‑hour expiry and are
  **audience‑bound** to the origin they were minted on; refresh tokens are stored hashed and are rotated
  for public clients (reuse of a rotated token revokes the family). PKCE S256 is required — there is no
  implicit or password grant.

To turn the **built‑in** AI off entirely and steer everyone to bring‑your‑own‑AI, set `AI_ENABLED=false`
in the backend `.env`.
