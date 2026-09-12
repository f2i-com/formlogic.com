# Hosted apps and private backend actions

[Documentation home](../README.md) · [Connected dashboards and Aokie](CONNECTED_APPS.md) ·
[AI setup](FREE_PLANS_AND_AI_SETUP.md) · [MCP tools](MCP.md)

App Studio → Screens → **App hosting** hosts a text app bundle with private `.logic` actions and a separate SQLite database. The starter is a working team notes app. Edit the interface and actions, publish the project, then open Preview or `/app/<slug>/project`. Publishing a project does not change the parent app's publication status: members need an active membership and a published app. Owners can preview drafts.

## Choose the right starting point

| You want to… | Start here |
|---|---|
| Show an app's existing forms and records in an editable dashboard | **Screens → Create connected dashboard**; see [Connected apps](CONNECTED_APPS.md). |
| Add Aokie's calls, appointments and logs to an existing app | Share its forms through **Add from another app**, then use the Front desk route or Aokie dashboard template. |
| Build a custom interface with its own backend actions and database | **Screens → App hosting**; edit the starter or import a project. |
| Let an AI author the project | Use `get_app_project` and `publish_app_project` through [MCP](MCP.md#portable-projects-and-aokie-via-mcp). |

### Publish your first project

1. Create or open the parent app, then open **App Studio → Screens → App hosting**.
2. On **Interface**, edit the `.ui`, `.logic` and `.json` client files, or use
   **Import project** for a compatible `.softn`, ZIP or `hosting-project.json`.
3. On **Backend**, define the action names called by the client. Give each action
   the required `owner`/`member` access and `read`/`write` database mode.
4. Choose **Publish app project**, then open **Preview**. The preview uses your
   authenticated session and the published database, so writes are real.
5. Publish the parent app and configure its member roles when it is ready for
   others. To make this project the home screen, use **Use as app home** in the
   connected dashboard panel. **Restore original home** switches back without
   deleting the hosted project.

Publishing again preserves records. If another editor has published a newer
version, refresh and merge their changes before retrying; do not discard the
version conflict by blindly replacing `expectedVersion`.

## Runtime and data boundaries

The hosted interface runs in a sandboxed iframe without same-origin access. The trusted FormLogic parent handles authentication and CSRF. Client code receives neither cookies nor tokens. The app's manifest cannot choose another app's database. Backend actions run in the existing ZIPP sandbox, with bounded record operations handled by PHP.

## Client `.logic`

Reference the entry logic from the interface: `<logic src="../logic/main.logic" />`. The app host supplies this callback API:

```javascript
let notes = [];
let message = "";
function _init() {
  softn.backend.call("listNotes", {}, function(response) {
    if (response.error) { message = response.error; return; }
    notes = response.result;
  });
}
```

Use `_init()` for initial asynchronous calls; event handlers use the same API. The name `softn` is the language namespace, not workspace product branding. An app opened in a host without a backend bridge receives an explicit error. A downloaded client does not contain credentials or a portable authenticated session.

## Private `.logic`

Each named action contains standalone source defining `onRequest(ctx)`, access (`owner` or `member`) and database mode (`read` or `write`). The source remains private. `member` grants every active member this action; scripts must enforce any finer record ownership rules using `ctx.user.id`. The starter deliberately shares its notes across members.

```javascript
function onRequest(ctx) {
  const text = String(ctx.input.text || "").trim();
  if (!text || text.length > 2000) {
    return {reject:true, message:"Write a note of 1–2,000 characters."};
  }
  return ctx.db.put("notes", ctx.requestId, {
    text:text,
    author:ctx.user.id
  });
}
```

`ctx.input` is the JSON request; `ctx.user` contains server-resolved `id` and `isOwner`. `ctx.requestId` is a new random ID for the invocation. It is not an idempotency key: use an application-supplied stable record ID for idempotent writes.

| Method | Result |
| --- | --- |
| `ctx.db.get(collection, id)` | Record data or `null` |
| `ctx.db.list(collection, limit, offset)` | `{id, data, updatedAt}[]`, newest updates first |
| `ctx.db.put(collection, id, data)` | Upsert and return `{id}` |
| `ctx.db.remove(collection, id)` | `{removed: boolean}` |

These are parameterized operations over a real SQLite `records` table. This version does not expose arbitrary SQL, migrations, filesystem access, HTTP calls, or the separate native private-server manifest dialect. Collections are app-wide. Existing form response databases are separate; importing a local form bundle does not migrate its records or automatically connect its submissions. Local XDB inside the isolated preview is temporary; connect persistent forms to backend actions.

Every action runs in a transaction. Script errors, rejection, read-only violations, host-operation errors (even if caught by the script), and oversized results roll back writes. Publish validates action declarations in a pure sandbox before changing the deployment. An optimistic version check rejects overwriting a newer deployment with HTTP 409. Republish preserves the database.

## HTTP API

The routes use existing FormLogic session/JWT authentication. Cookie-authenticated writes require the existing CSRF header. The authenticated user's identity and membership are checked on every request. A public manifest or an app ID alone grants no access.

| Route | Access / body |
| --- | --- |
| `GET /api/apps/{id}/hosting` | Owner; private source, version, record count |
| `PUT /api/apps/{id}/hosting` | Owner; `{expectedVersion, package}` |
| `GET /api/apps/{id}/hosting/database` | Owner; consistent SQLite snapshot, including private actions |
| `GET /api/app/{slug}/hosting` | Owner / active member; client files only |
| `POST /api/app/{slug}/actions/{action}` | Action's access rule; JSON object input; returns `{result}` |

The package is `{version:1, client:{"manifest.json":"…","ui/main.ui":"…"}, actions:{name:{source,access,mode}}}`. The editor imports client `.softn`/ZIP bundles or full `hosting-project.json` files. Client-only imports retain existing private actions for review. Public manifest metadata and permissions are rebuilt server-side; private directories and executable HTML/JavaScript files are rejected.

For a first publication, send `expectedVersion: 0`; subsequent publications use
the current deployment version returned by the owner GET. A deployment version
is separate from the package format's fixed `version: 1`.

The MCP equivalent is `get_app_project {appId}` followed by
`publish_app_project {appId, expectedVersion, package}`. Reading requires
`apps:read` and includes private backend source; publishing requires both
`apps:write` and `screens:write`. Token app confinement and owner checks apply.
`update_app {appId, hostedDashboard: true}` makes an already published project
the app home; `status: "published"` controls the parent app separately.

Limits: 2 MB package, 100 text client files (200 KB each), 30 actions (50 KB source each), 32 KB action input, 50 host calls, 256 KB result, 100 records / 200 KB per page, 16 KB per record, 10,000 records per app. The SQLite file has a 32,768-page cap (normally 128 MiB); busy waits stop after two seconds. The guest has the existing sandbox instruction and CPU limits. Hosting requests are rate limited and deployment/action writes use the existing cloud write gate. The shared demo cannot use hosting.

## Build and operate

Install dependencies in the sibling `softn.com` and FormLogic UI repositories, then:

```powershell
# From formlogic.com/formlogic/ui
npm run build:hosted-runtime
npm run test:zipp-sharing
npm run build
```

The first command checks that FormLogic and Softn vendor the same ZIPP version and binary hash, builds the shared core/components and `softn.com/apps/formlogic-host`, then replaces `public/hosted-runtime` with the verified output. A complete asset manifest detects missing, modified or obsolete files. These generated files are ignored by Git; preserve the entire artifact, including `runtime-manifest.json`, if frontend deployment runs without the sibling source checkout. A normal UI build rejects a missing or mismatched runtime. Deploy the parent UI and hosted runtime together. The runtime is excluded from the main PWA precache and SPA fallback.

Both browser integrations currently use ZIPP v0.0.17. FormLogic downloads and verifies the binary lazily once per page, then passes cloned bytes to its expression worker and each hosted Softn app. Each context keeps its own WASM instance, memory and permissions. Failed downloads can retry; worker restarts, additional apps and source replacements reuse the cached bytes. The shell announces its version and hash before initialization, so a stale shell displays an update error rather than running mismatched glue. The browser check covers both loading orders, concurrent startup, separate app state, backend actions, source replacement and download recovery using only local fixture data.

Hosted apps use main-thread script execution. The iframe's existing opaque origin and `worker-src blob:` policy do not permit Softn's additional URL-based sandbox workers; sharing engine bytes does not change those capabilities.

Serve `/hosted-runtime/` static assets with `Access-Control-Allow-Origin: *` and `X-Content-Type-Options: nosniff`; the opaque iframe needs anonymous CORS access to its trusted JS/WASM. An Apache `.htaccess` is included; equivalent headers must be configured for Nginx or another host. Do not add permissive CORS to authenticated API routes. Vite development has a middleware limited to the static runtime directory.

PHP needs the existing sandbox binaries, PDO SQLite, and writable `backend/storage/hosted-apps` outside the public document root. No new MySQL migration or Node process is needed on the API server. Deploy the new PHP classes and route wiring with the frontend assets.

## Export and back up

| Action | Includes | Purpose |
|---|---|---|
| **Download client** | Public interface files | Edit or reuse the Softn client; live backend access still requires a compatible authenticated host. |
| **Save project copy** | Client and private action source | Restore or continue editing the project; no stored records are included. |
| **Download database** | SQLite deployment and records, including private actions | Owner backup of the hosted project and its data. |

The hosting database file is `storage/hosted-apps/<sha256(appId)>.sqlite`. It contains both the deployment and records. **Download database** produces a transaction-consistent snapshot; **Save project copy** includes private backend code but no records; **Download client** includes only public interface files. Existing account/form backup exports do not yet include hosted databases. Include this directory in operator backups; use SQLite backup/VACUUM snapshots or stop writes while copying. Retain the server-owned app ID when restoring a database. Deleting/recreating an app does not automatically remap this storage.

## Troubleshooting

| Symptom | Check |
|---|---|
| Preview is missing or returns 404 | Publish the project first; verify the generated `/hosted-runtime/` assets are deployed and served with the documented static CORS headers. |
| Owner can open it but a member cannot | Publish the parent app and verify the member is active. Check each action's owner/member access rule. |
| Imported form data is missing | Client imports contain source, not records. Existing FormLogic responses use the workspace bridge; custom hosted collections use `ctx.db`. |
| Publishing returns 409 | Another publication changed the deployment version. Read the latest project and merge before publishing. |
| A write appears to fail silently | Check the client callback's `error`; validation, rejected actions and host errors roll back the whole transaction. |

This hosting format accepts text clients and the action API documented here.
Existing locally generated forms and native private-server packages need an
explicit adaptation; importing them does not migrate databases or credentials.
