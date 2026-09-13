# Editable app packs

The live catalogue reads pack folders on each request. The 29 bundled business packs contain 32 editable Softn workspaces and retain their 188 forms, linked records, roles, reports and automations. Installation creates an owned **draft** app; publish it and configure membership in App Studio before sharing it.

The Softn workspace provides navigation, search, recent records, record details and a getting-started guide. **Dashboard & reports** opens the pack's specialist dashboard. Form rendering, specialist tools and existing reports continue to use FormLogic's components. Aokie's calls, SMS and voice services require OAIY, a configured phone and approved connector grants; installing a pack does not place calls or send messages.

## Add or change a pack

- Bundled source: `formlogic/backend/resources/packs/<id>/`.
- Operator additions/overrides: `formlogic/backend/storage/pack-projects/<id>/`. This directory is preserved by upgrades and excluded from Git.
- Each folder needs `pack.json`, `install.json` and the project folders declared in its metadata. No TypeScript registry, frontend rebuild, database seeding or server restart is needed.
- A valid operator folder with the same ID replaces the bundled catalogue entry. `{"formatVersion":1,"id":"clinic-appointment-intake","disabled":true}` hides it. A malformed override is logged and the valid bundled entry remains available.
- Changes affect **future installs**. Existing copies, records and owner edits are not overwritten. Keep previous source folders in version control or backups; folder downloads expose the current source, not historical catalogue versions.

```text
my-pack/
  pack.json
  install.json
  server/forms/validate-request.logic
  projects/main/
    manifest.json
    permission.json
    formlogic.json
    ui/main.ui
    logic/main.logic
    server/packGuide.logic
```

`pack.json` supplies the listing and maps each installation app to a project folder:

```json
{
  "formatVersion": 1,
  "id": "my-pack",
  "name": "Service desk",
  "version": "1.0.0",
  "description": "Requests, people and follow-up work together.",
  "category": "Operations",
  "tags": ["requests", "service"],
  "icon": "Inbox",
  "projects": { "main": "projects/main" }
}
```

`install.json` uses the existing Pack v1 format: `packMeta`, `forms`, `apps`, optional `flows` and `flowBindings`. Its ID/version must match `pack.json`. Use `@pack:<form-id>` references for relationships; installation resolves these to new IDs. `apps[].packAppId` must match the `projects` map. An app with a project may have an empty `forms` list.

Start by copying one of the bundled folders. Their schemas include the real fields, dashboards, roles, reports and bindings. A form can use `logicScriptFile: "server/forms/validate-request.logic"` to load its submission script from a separate file. Form databases are provisioned by FormLogic from these definitions; no second copy of those records is created for the Softn workspace.

Optional `screenshots` metadata is an array of `{label,url}` entries referencing `/api/packs/screenshots/<filename>.png` (also JPG/WebP). Place images in `backend/storage/pack-screenshots/`. Bundled images show the retained specialist dashboards.

## Connected workspaces and named backend actions

In a project, `manifest.json` declares `main` and its `files.ui` / `files.logic` source lists. `permission.json` uses the hosted runtime's existing permission format. A connected project declares private named actions in `formlogic.json`:

```json
{
  "formatVersion": 1,
  "storage": "formlogic-forms-sqlite",
  "actions": {
    "packGuide": { "file": "server/packGuide.logic", "access": "member", "mode": "read" }
  }
}
```

Each action defines `onRequest(ctx)` and runs in the server ZIPP sandbox. Use `softn.backend.call("packGuide", {}, callback)` in the client. Access is `owner` or `member`; mode is `read` or `write`. The `ctx.db` action store is private to the app and separate from its form response databases. The bundled guide actions only return setup information; form records remain in FormLogic's form APIs and their existing automation paths.

The host bridge exposes `workspaceInfo`, `workspaceOpen`, `workspaceRecords` and `workspaceDashboard`. It resolves the current app and enforces the caller's form permissions. Use stable form aliases from `workspaceInfo` when customising navigation. No credentials or fixed installation IDs are embedded in source.

Edit these projects in **App Studio → Screens → Hosting & app tools → App hosting**. Visual Builder and AI Studio edit the interface; the Backend tab edits private actions. Publishing an interface update preserves the database. The owner can export the full pack again with the edited project included.

## Native apps with routes and SQLite migrations

A folder can instead contain a complete native Softn project. Its `manifest.json` declares the server `.logic` entry, routes, capabilities and private SQLite migrations. Use this `formlogic.json`:

```json
{
  "formatVersion": 1,
  "hosting": "native",
  "access": "members",
  "files": ["manifest.json", "ui/main.ui", "server/main.logic", "server/migrations/001.sql"],
  "assets": []
}
```

List every source file, including imported UI/logic modules and migrations. `assets` lists media paths under `assets/`. `members` requires FormLogic membership; `application` preserves the app's own sign-in logic. Parent app publication and the native host's runtime access checks still apply. The installer validates the source, applies migrations and provisions the private database before completing installation. Failed installs roll back their created app/form records and clean up newly created project storage.

A working example is in [`formlogic/backend/tests/fixtures/pack-projects/native-notes`](../formlogic/backend/tests/fixtures/pack-projects/native-notes). Copy that folder into `storage/pack-projects/` to try it. It contains real server routes and a SQLite migration. Native apps use **Native app hosting** for source editing and database CRUD, including the existing native record automation controls. See [Hosted apps](HOSTED_APPS.md).

## Download and move projects

**Download app sources** on a folder pack's detail page creates an installable ZIP with a Pack v1 `manifest.json` and a `.softn` archive for each app under `projects/`. It also includes `pack.json`, `install.json` and the unpacked source folders: operators can extract it under `storage/pack-projects/<pack-id>/` and edit it there. After editing live folders, download a fresh ZIP to rebuild its installation manifest; the manifest inside an older ZIP is a snapshot.

1. Import the outer ZIP through FormLogic's pack importer to install all forms, roles, reports, flows and app projects together.
2. Open an individual `.softn` file in Builder or Studio to edit the interface. Connected workspaces require their installed FormLogic host to access live records.
3. Import a named-action `.softn` into **App hosting** to retain its private actions. Import native `.softn` projects through **Native app hosting** to retain routes, migrations and application sign-in.

Archives contain source and schema definitions, **not existing responses, database rows, credentials or member accounts**. Review capabilities when installing. Server package verification policies and connector grant review continue to apply. To combine apps around existing records, use FormLogic's shared-form and integration composition tools rather than installing a second independent copy.

## Validation and limits

From `formlogic/backend`:

```sh
php bin/check-pack-projects.php
php vendor/phpunit/phpunit/phpunit tests/Unit/FolderPackCatalogTest.php
php vendor/phpunit/phpunit/phpunit tests/Integration/FolderPackInstallTest.php
```

The integration suite needs a configured test database; it creates a temporary owner and removes its installations. The unit suite checks feature preservation and executes every bundled guide through the local ZIPP runtime. Browser coverage lives in `ui/e2e/folder-packs.spec.ts`.

The loader limits folders, file sizes, project counts and total pack size (5 MB), validates metadata and rejects escaping/linked paths. Named-action and native projects also pass their existing host validators. Catalogue reads inspect source without executing it. Invalid packs are logged and omitted instead of breaking the whole catalogue.

The older `resources/marketplace-packs/*.json` / UI TypeScript pack exports remain for compatibility tests and the restricted shared demo. They no longer drive the live folder catalogue; edit the new folders to change live packs.
