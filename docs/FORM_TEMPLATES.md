# Form builder templates

The **Create new form → All templates** picker loads JSON starter definitions from
`GET /api/form-templates` whenever it opens. It no longer bundles a fixed template list
into the frontend. No frontend rebuild, PHP restart, index file or database migration is
needed when adding, changing or removing a template.

## Choose a folder

| Folder (source checkout) | Purpose |
|---|---|
| `formlogic/backend/resources/form-templates/` | Bundled defaults, tracked in Git and shipped with releases. |
| `formlogic/backend/storage/form-templates/` | Operator additions and overrides. Create it if needed. Kept outside Git and preserved with other storage during upgrades. |

In a packaged installation the same folders are under `api/`. Back up custom templates
with the storage directory. Use the custom folder for site-specific changes so a release
cannot replace them. This is a catalogue of public form definitions: do not put credentials
or customer data into template files. It is separate from the marketplace's app packs and
from the forms-list filter for already installed templates.

## Add a template

Save this as `storage/form-templates/site-visit.json`, then close and reopen the form picker:

```json
{
  "id": "site-visit",
  "name": "Site visit request",
  "description": "Collect the address and preferred visit date.",
  "category": "field-service",
  "categoryLabel": "Field service",
  "categoryIcon": "Building",
  "icon": "CalendarDays",
  "estimatedTime": "2 min",
  "order": 20,
  "fields": [
    {
      "type": "short_text",
      "label": "Site address",
      "required": true,
      "properties": {}
    },
    {
      "type": "date",
      "label": "Preferred visit",
      "required": false,
      "properties": {}
    }
  ]
}
```

The lowercase ID must match the filename and can contain letters, numbers and hyphens.
Categories are derived from the files. Use the same category label/icon across files with
the same category ID. Unknown icons use a generic icon; no UI change is needed for a new
category. Templates sort by `order` (default 1000), then name and ID.

Copy a bundled JSON file as a starting point. Fields use the form builder's existing type
and properties format. Choice fields need `options` entries with `id`, `label` and `value`.
Each created form receives its own field IDs. Configure cross-field conditions, linked-form
references and automation after creating the form; these starter definitions do not import
a complete application or its private backend. Existing form-to-app/export behavior remains
unchanged.

## Override or hide a default

To replace a bundled template, put a valid custom file with the same filename and ID in
`storage/form-templates/`. Remove the override to restore the bundled version.

To hide `contact-form.json`, create the custom file with:

```json
{"id":"contact-form","disabled":true}
```

Deleting a bundled file also removes it from the catalogue, but a later release may restore
it. Existing forms are independent copies: changing a template never edits submitted data
or forms already created from it.

## Validate and troubleshoot

From `formlogic/backend` (or packaged `api/`):

```sh
php bin/check-form-templates.php
```

The command lists the available/skipped counts and exits nonzero for invalid files. Details
go to the PHP error log. A malformed file is skipped without breaking other templates; an
invalid custom override leaves a valid bundled default available. Files must be direct `.json`
children, at most 256 KiB, with up to 100 supported fields and 200 options per choice field.
At most 200 files per folder are read. Symlinked files are excluded.

The picker shows loading, retry and partial-catalogue messages. Blank forms remain available
if the catalogue cannot load. `All templates` means the currently enabled files, not a
hard-coded category list. Files added while the picker is open appear when it is reopened.
