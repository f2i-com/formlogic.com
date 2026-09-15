# Connected app workspaces

[Documentation home](../README.md) · [Host a custom app](HOSTED_APPS.md) ·
[Connect your AI](FREE_PLANS_AND_AI_SETUP.md) · [MCP reference](MCP.md)

Use a connected workspace when you want an editable app interface over forms
and records that already live in FormLogic. The client is a Softn app; FormLogic
supplies the authenticated host, navigation and data permissions. OAIY adds local
models, device plugins and flow execution when your app needs them.

## Create a connected dashboard

In the app studio, open **Screens** and choose **Create connected dashboard**.
This publishes an editable Softn client that lists current forms and tools, shows
permitted recent records, and opens existing form screens. Choose **Use as app home**
to use it as the landing screen. The original home is retained and can be restored.
This starter does not automatically convert existing dashboard chart widgets.

**Download starter** exports a `.softn` archive without account tokens, provider keys
or private backend actions. Its host bridge uses `workspaceInfo`,
`workspaceRecords {formId}` and `workspaceOpen {formId}`. Every operation resolves the
current app, confines forms to that app and retains server-side record permissions.
Live records require a compatible authenticated FormLogic host.

Canonical source is in the sibling repository at
`softn.com/examples/formlogic-workspace`. Run `node scripts/sync-workspace-project.mjs`
from `formlogic/ui` after editing to update the UI and PHP resource copies together.
Private actions stay in `package.actions`, using `onRequest(ctx)` and the existing
per-app SQLite API. Publishing requires `expectedVersion` to protect newer edits.

## Bring Aokie into an existing app

1. Install the Aokie starter from the marketplace or MCP starter tools.
2. In the destination app's Screens section, choose **Add from another app**.
3. Select the Aokie source app and the forms to share. Sharing keeps automation
   in its current app.
4. If the destination should own the automation too, choose **Move automation
   here too** and review the connector capabilities. This includes all source forms.
5. Review **People & roles**, connect OAIY, and configure the destination in
   **Device Setup**. Check both apps after moving.

Sharing retains the same form IDs and records in both apps. Moving also moves flows
and bindings, copies connector scripts/services, and pauses source scripts.
Destination branding, dashboard and roles remain. Active source flow runs,
incompatible connector settings and conflicting machine keys are rejected atomically.
Reload open source tabs after moving: they may have cached event handlers. The action
does not erase the source app or grant access to destination members.

### Connect the desktop and verify the result

The two connections have different jobs:

| Connection | Purpose | Where to check it |
|---|---|---|
| Browser pairing | Approves this browser's access to OAIY's local API and AI providers | FormLogic **Connect your AI**, then OAIY **Connections** |
| Linked FormLogic account | Gives OAIY scoped access for account-backed events, records and remote flow commands | OAIY **Connections → Linked account** |

Install and start the native Aokie plugin in OAIY separately from installing its
FormLogic starter. Follow Aokie's phone and speech setup, then confirm it reports
ready. Installing a pack does not install native software or pair a phone.

After sharing or moving, open the destination app's **Front desk** and confirm it
shows the intended forms. Perform an authorised test interaction and inspect
the resulting call, transcript, appointment or follow-up record. An appointment
request is not a confirmed booking until its booking flow succeeds. Check OAIY's
plugin logs and FormLogic's flow run history if an expected record does not appear.

## Build through an external AI

`/ai-setup` provides public onboarding; `/llms.txt` describes the tool workflow.
OAuth consent, account verification and hardware pairing still apply.

1. Use `get_started`, `list_apps` and `get_app` to inspect the target app and forms.
2. Use `get_workspace_template` (`template: "workspace"` or `"aokie"`) and read
   `get_app_project` before editing or publishing the package.
3. Publish with `publish_app_project` and the current `expectedVersion` (`0` only
   for a new deployment). `update_app {appId, hostedDashboard: true}` selects it
   as home after publication.
4. To reuse Aokie, inspect `get_aokie_starter`, install with an explicitly reviewed
   `approvedConnectorGrants` list, then use `compose_apps` to share or move it.
5. Read `list_app_roles` before creating roles or replacing permissions with
   `set_app_role_permissions` / `set_app_role_connector_grants`.

The tools share app services, owner checks, token confinement, plan limits and audit
events. Publishing also requires `screens:write`; starter installation requires
`forms:write` and `screens:write`. Connector grants require `connector:command`.
Composition requires `apps:write` plus `forms:read`, and both source and destination
must be within the token's scope. A token restricted to one app cannot import a
second app; use an appropriately scoped account connection for that task.
Installation requires an explicit reviewed grant list, including an empty list, and
honors verified-package-only policy. Role edits preserve the other permission class
and cannot modify the system Owner role. These tools do not send invitations.
Signup/verification and native installation are not MCP tools.

See [MCP projects and Aokie](MCP.md#portable-projects-and-aokie-via-mcp) for the
tool sequence and required scopes, and [Hosted apps](HOSTED_APPS.md) for the
package/action format and backups.

## Aokie portable front desk

The Aokie starter opens a real Softn client, authored in
`softn.com/examples/aokie-workspace/ui/main.ui` and `logic/main.logic`.
It reads Calls, Appointments, Transcript Turns, Hardware Events and Follow-ups through
the host-session bridge. Stable pack aliases survive form renaming. Records keep their
server permissions; the client does not receive account credentials. Refresh, pagination,
page search and expandable full record details are available. Appointment requests are
explicitly distinguished from confirmed bookings.

Use **Download editable app** to export its `.softn` client. In App Studio's connected
dashboard panel, choose **Use the Aokie front desk interface**, create the project, then
use it as app home. Existing hosted projects are never overwritten by this starter action.

To add Aokie to an existing app, choose **Add from another app** in the destination's
App Studio and share Aokie's forms. Sharing Calls and Appointments adds a **Front desk**
route (`/app/:slug/aokie`) alongside the destination's existing home, including a hosted
Softn home. Share the other receptionist forms for transcripts, logs and follow-ups.
The records are shared, not copied. Automation remains in the source unless the explicit
**Move automation here too** option is selected and its connector capabilities approved.
Review destination member roles before granting access.

AI/MCP clients can call `get_workspace_template` with `template: "aokie"`, then
`get_app_project` and `publish_app_project` with the expected version. `compose_apps`
shares existing forms or moves integration ownership; the source and destination must
both belong to the caller. Downloaded projects need a compatible FormLogic host bridge
to read live records; the archive is not an offline copy of the database.

The public `/packs` gallery and details use the shared landing navigation/footer. The live catalogue reads editable pack folders; see [Pack projects](PACK_PROJECTS.md). A
credential-free fallback catalogue is generated by `scripts/emit-marketplace.mjs`.
When the live API fails, the gallery clearly labels the bundled preview and keeps search,
pagination and Aokie's detail page available. Installation still requires the live API.

## Maintain the shared clients

Edit the canonical examples in the sibling `softn.com` checkout, then run these
commands from `formlogic.com/formlogic/ui`:

```powershell
node scripts/sync-workspace-project.mjs
node ../../scripts/fetch-softn-release.mjs
npm run build
```

The sync script updates the generic and Aokie client resource copies used by both
the UI and PHP tools. The runtime comes from the latest Softn release (or `SOFTN_REPO`
with `npm run build:hosted-runtime` for a source checkout).
Generated runtime assets must be included in deployment; a `.softn` download
contains the client, not its live records or an authenticated account session.
