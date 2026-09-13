# Pack integration and documentation review — 13 September 2026

Reviewed FormLogic's folder catalogue, installation/export paths, hosted project metadata, form templates, navigation and current documentation. All changes remain local; no release or remote deployment was performed.

## Issues fixed

- Legacy name-based pack links now resolve to the current folder source. Disabling a folder also disables those detail/download links. Invalid overrides no longer reserve unrelated catalogue names.
- Hosted project manifests retain additional UI screens and JSON resources, so an exported project can be loaded again from a folder without losing those files.
- Folder downloads and app exports preserve empty JSON maps as objects, while forms, fields and other lists remain arrays. This fixes schema incompatibilities for external editors and AI clients.
- The pack format and JSON schema describe hosted/native projects, private backend source and packs whose native database replaces the forms list. The native example now includes its description metadata.
- App settings explain that source export excludes records and that hosted/native databases need operator backups. Two retired desktop design documents now point readers to current OAIY guidance.
- Navigation tests now check the current OAIY connection section and the separate app Access tab.

## Validation

| Check | Result |
|---|---|
| Full frontend unit suite | 184 files, 2,035 tests passed |
| Backend pack/install, native SQLite, hosted actions and flow/capability checks | 37 tests passed; a subsequent 29-test focused run passed after the JSON and multi-screen fixes |
| All bundled pack installations and exports | 29 packs, 32 workspaces passed under temporary test owners |
| Browser navigation, folder packs and form templates | 9 checks passed across public, signed-in and demo views at desktop/mobile sizes |
| Final folder download/install/source-folder round trip | 2 browser checks passed after the final serialization changes |
| Documented JSON schema | All 29 live folder payloads and the native example validated; an empty pack was rejected |
| Documentation links | 42 Markdown files checked; no broken local file targets |
| Live `/docs#packs` | Current content, no horizontal overflow or page errors at 1440px and 390px |
| Frontend lint and production build | Passed; runtime/editor artifact checks included by prebuild |

The backend checks used the local ZIPP runtime and actual SQLite storage. Xdebug was disabled for these CLI runs because retained exception traces can hold SQLite files open during Windows test cleanup. Existing large-chunk build notices and test-environment diagnostics remain non-failing.

## Scope and remaining checks

This is a local functional review, not a guarantee that every workflow or production configuration is defect-free. Specialist dashboards and form tools remain FormLogic components connected from the editable Softn workspaces. Real Aokie calls/SMS, live AI providers, custom-domain/TLS setup, production load and restore drills were not repeated. Native database export/restore UI remains a documented follow-up in [Hosted apps](HOSTED_APPS.md).

For authoring and operating packs, use [Editable app packs](PACK_PROJECTS.md), [Pack format](PACK_FORMAT.md) and the [documentation index](README.md).
