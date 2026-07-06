# Pack format (v1)

A **pack** is a single JSON document that bundles forms, apps, screens, scripts, and roles into a
portable, self-contained unit. It powers three things:

- **App export/import** — download a whole app as `<slug>.formlogic.json` and re-import it ([docs/API.md](API.md), App settings → Manage → Export).
- **The pack marketplace / templates** — publish and install reusable bundles.
- **The AI App Builder + MCP** — the shape an AI assembles when it builds an app.

`PackService::validatePack()` (backend) is the authoritative validator; this document describes what it
accepts. Import is the single trust boundary: it regenerates all ids, sets the importer as owner, forces
`status: draft`, strips notification recipients, and remaps cross-references.

---

## Top level

```jsonc
{
  "formatVersion": 1,                 // required, must be 1
  "packMeta": {                       // required
    "id": "expense-tracker",          // optional
    "name": "Expense Tracker",        // required
    "description": "Track spending",  // required (may be "")
    "version": "1.0.0",               // optional (default 1.0.0)
    "author": "…",                    // optional
    "tags": []                        // optional
  },
  "forms": [ /* PackForm[] */ ],       // required, 1–50
  "apps":  [ /* PackApp[]  */ ]        // optional, 0–20
}
```

## PackForm

```jsonc
{
  "packFormId": "orders",             // required, unique within the pack; the local key used by @pack: refs
  "title": "Orders",                  // required (≤ 500 chars)
  "description": "…",                 // optional
  "icon": "FileText",                 // optional (≤ 100 chars)
  "settings": {},                     // object (≤ 10KB) — notifications are stripped on export + import
  "theme": {},                        // object (≤ 10KB)
  "logicScript": "function onSubmit(ctx){…}", // optional (≤ 100KB), the QuickJS onSubmit script
  "customScreen": { /* see below */ }, // optional (≤ 512KB)
  "fields": [ /* ≤ 200 */             // required
    { "id": "customer", "type": "linked_record", "label": "Customer", "required": false,
      "properties": { "targetFormId": "@pack:customers" } } // cross-form ref, see @pack:
  ]
}
```

Object-shaped fields (`settings`, `theme`, field `properties`) export as `{}` when empty, never `[]`.

## PackApp

```jsonc
{
  "packAppId": "expense-tracker",     // required, unique
  "name": "Expense Tracker",          // required
  "description": "…",
  "logoUrl": null,
  "settings": {                       // object; notifications/notificationEmail stripped
    "hideNav": true,
    "landingPage": "@pack:orders",    // a form id is exported as a @pack: ref (or "dashboard")
    "defaultRoleName": "Member"       // defaultRoleId is exported by ROLE NAME, re-resolved on import
  },
  "theme": {},
  "navConfig": [                      // nav items; each item.formId is a @pack: ref (unknown → dropped)
    { "formId": "@pack:orders", "label": "Orders", "icon": "FileText" }
  ],
  "customScreen": { /* the app's custom frontend, see below */ },
  "forms": [                          // membership + metadata
    { "packFormId": "orders", "displayName": "Orders", "sortOrder": 0, "isVisible": true, "settings": {} }
  ],
  "roles": [                          // custom roles + non-Owner system roles (see Roles)
    { "name": "Reviewer", "description": "read-only", "system": false,
      "permissions": [ { "packFormId": "@pack:orders", "permission": "view_all_responses" },
                       { "packFormId": null, "permission": "view_analytics" } ] }
  ]
}
```

## Reports

`PackApp` may include an optional `reports` array of pre-configured chart reports and PDF documents that appear
in the app's Reports section when the pack is installed. The entire `reports` array is capped at **256KB**.

Each item is either a `kind:'chart'` (a query-backed visualization) or a `kind:'document'` (a PDF report
composed of text blocks and embedded charts). `reportId` is a pack-local stable string used to cross-reference
chart items from document blocks — it is remapped to a real UUID on install.

```jsonc
"reports": [
  // A chart grouped by a field on the base form
  {
    "reportId": "by-status",          // pack-local stable id; referenced by document blocks
    "kind": "chart",
    "name": "Expenses by Status",
    "description": "Breakdown of submitted expenses",
    "spec": {
      "formId": "@pack:expenses",     // @pack: ref — resolved to a real form id on install
      "viz": "pie",
      "groupBy": { "field": "status", "bucket": "none" },
      "measure": { "fn": "count" }
    }
  },
  // A chart that joins a second form via a linked_record field
  {
    "reportId": "expense-by-dept",
    "kind": "chart",
    "name": "Expenses by Department",
    "spec": {
      "formId": "@pack:expenses",
      "viz": "bar",
      "joins": [
        { "via": "department_id",             // field id of a linked_record on the base form (bare id)
          "formId": "@pack:departments",       // @pack: ref to the joined form
          "type": "left" }
      ],
      "groupBy": { "field": "@pack:departments::dept_name" }, // joined-form field ref
      "measure": { "fn": "sum", "field": "amount" },
      "sort": "desc",
      "limit": 10
    }
  },
  // A PDF document referencing the charts above
  {
    "reportId": "expense-summary-doc",
    "kind": "document",
    "name": "Monthly Expense Summary",
    "blocks": [
      { "kind": "text", "title": "Overview", "body": "Monthly expense totals by department." },
      { "kind": "report", "reportId": "expense-by-dept", "caption": "Top 10 departments" }
    ]
  }
]
```

### Report field reference conventions

| Syntax | Meaning |
|--------|---------|
| `"amount"` | A field on the base form (bare field id) |
| `"@pack:departments::dept_name"` | A field on a joined form |
| `"__submitted_at"` | Submission timestamp (pseudo-field, always available) |
| `"__status"` | Workflow status (pseudo-field, always available) |

`spec.formId` and `joins[].formId` always use `@pack:<packFormId>`. `joins[].via` is the **field id** of a
`linked_record` field on the base form (a bare id, not a `@pack:` ref).

On install (`PackService::resolvePackReports`) every `@pack:` reference is rewritten to the newly-created real
form UUID. A chart whose base or joined form cannot be resolved is silently dropped; document blocks referencing
a dropped or unknown chart are dropped; a document left with no blocks is dropped. On export (`packifyReports`)
the inverse runs — any report referencing a form outside the exported app is dropped. Packs never carry
dangling ids.

## customScreen (form + app)

```jsonc
{
  "enabled": true,
  "html": "<div id=\"app\"></div>",   // shell markup (index.html for a multi-file screen)
  "css": "…",
  "ts": "…",                          // single-file TypeScript/JS source (compiled to js), OR
  "files": [                          // a multi-file project (TS/TSX/CSS + index.html, relative imports)
    { "path": "index.ts", "content": "import { total } from './util';" },
    { "path": "util.ts",  "content": "export function total(…) {…}" }
  ],
  "js": "…",                          // the compiled/bundled artifact the sandbox runs
  "publicRecords": false,             // (form only) allow reading records on the public link
  "publicRecordFields": []            // (form only) field-id whitelist for public reads
}
```

The screen runs in a sandboxed **opaque-origin iframe** (CSP `connect-src 'none'`); its only capability is
the injected `window.FormLogic` bridge.

## @pack: cross-references

Anything that points at another form in the same pack uses `@pack:<packFormId>`:
`linked_record.properties.targetFormId`, `navConfig[].formId`, `settings.landingPage`, role
`permissions[].packFormId`, and report `spec.formId` / `joins[].formId`. On import these are remapped to the
freshly-created form UUIDs. A `linked_record` pointing at an unknown packFormId is a hard error; nav/landing
refs to unknown forms are dropped; report items whose form refs cannot be resolved are dropped.

Report field refs on **joined** forms use the compound form `@pack:<packFormId>::<fieldId>`. Fields on the
**base** form use a bare field id. The pseudo-fields `__submitted_at` and `__status` are available on every
form without a `@pack:` prefix. See **Reports** above for full details and examples.

## Roles

- **Custom roles** export in full (`system: false`) and are recreated on import.
- **Non-Owner system roles** (Admin, Member) export with `system: true` so permission *customizations*
  round-trip — on import those permissions are applied to the same-named system role `createApp` recreates.
- **Owner** is never exported (recreated with all permissions; not an import-escalation path).

## What is NOT exported

Packs are structure, not data or secrets. Export **excludes**: form responses + uploaded files, app
members/invitations, API keys, MCP tokens, webhook URLs/secrets, notification recipient emails, billing,
owner/user ids, and all real UUIDs (only `@pack:` refs + fresh ids). An app export is **not** a data backup.

## Limits

≤ 50 forms, ≤ 20 apps, ≤ 200 fields/form; `logicScript` ≤ 100KB, `fields` ≤ 500KB, `settings`/`theme` ≤ 10KB,
`customScreen` ≤ 512KB (app `navConfig`/`settings`/`theme` ≤ 10KB), app `reports` ≤ 256KB. Oversized packs
are rejected with a clear message.
