# One Backend, Many Portals

The mental model for running several apps ("portals") over the same data. The
implementation reference is
[CUSTOM_APP_PLATFORM.md → Multi-App over Shared Forms](CUSTOM_APP_PLATFORM.md#multi-app-over-shared-forms);
this page is the shape of the idea.

## The model

There is **one data backend**: forms and their responses. Apps are **windows
onto it**. A form is attached to an app via the `app_forms` join
(many-to-many), and responses live in per-form SQLite keyed by `form_id` — a
response row carries no app id. So every app a form is attached to reads and
writes the **same records**. There is no copy, no sync, no "export to the
admin app": attach the form and the data is simply *there*.

```
   Client Portal          Staff App             Admin Console
   (own slug, users,      (own slug, users,     (companion app: every
    roles, branding,       roles, dashboards,    form attached, full-
    dashboards, domain)    reports)              visibility roles)
        │                      │                      │
        └──────────────┬───────┴──────────────────────┘
                       │   app_forms (many-to-many)
        ┌──────────────┴───────────────────┐
        │           SHARED FORMS           │
        │   Jobs   Clients   Invoices ...  │
        │   (fields, onSubmit logicScript, │
        │    webhooks, versions)           │
        └──────────────┬───────────────────┘
                       │   form_id
        ┌──────────────┴───────────────────┐
        │         SHARED RESPONSES         │
        │  per-form SQLite — one store per │
        │  form, no app id on any row      │
        └──────────────────────────────────┘
```

## Per-app vs shared (the one-line version)

Each app owns its **presentation and its people**: name/slug/branding/theme,
members, roles + per-form permissions, nav, home dashboard, saved reports,
custom domains, app-level logic. The **form owns the data rules**: fields,
validation, the server-side onSubmit `logicScript`, webhooks, section screens,
and every response ever submitted — through any app. Full column-by-column
list: [Per-app vs shared](CUSTOM_APP_PLATFORM.md#per-app-vs-shared).

## Permissions decide visibility

Splitting into portals does *not* rely on hiding forms client-side. The member
runtime payload (`GET /api/app/{slug}`) is filtered **server-side**: a member
receives only the forms they hold a permission on, and the nav, saved reports,
dashboard widgets, and landing page are stripped of anything referencing a
form they can't see (`AppPublicController::filterAppForMember`). The same form
can be submit-only in the client portal and full-CRUD in the admin console —
that's just two roles in two apps over one form.

## The fastest split: a companion app

**Settings → Manage → Forms → "Create a companion app"** (the Manage tab's
"Companion app" card jumps straight there; or
`POST /api/apps/{id}/companion`) clones the *window*, not the data: the new
app gets every form attached (same `form_id`s — hidden ones included), the
theme and nav for continuity, its own fresh slug/roles/members, and optional
copies of the dashboard / reports / app logic. Members, domains, and status
never copy. One click turns "the app" into "the client app + its back office".

## Naming the portals: appKind & rolePreset

Optional metadata that keeps a multi-portal workspace legible:

- **`settings.appKind`** — what a portal *is*:
  `admin` ("Admin console"), `client` ("Client portal"), `staff` ("Staff
  app"), `public` ("Public intake"), `internal` ("Internal tool"), `custom`
  ("Custom"). Server-validated on save (invalid values are dropped); absent =
  untyped. Companion creation defaults to `admin`.
- **`rolePreset`** on app creation — tunes the *new* app's default
  system-role permissions for its intended audience:
  `admin-console` | `client-portal` | `staff-field-app` | `public-intake`.
  It only adjusts role defaults on the freshly created app (the owner role is
  untouched); an invalid preset is ignored.

## Seeing the topology

- **Relations map** — `GET /api/apps/{id}/forms/relations` (owner-scoped):
  every attached form with its outgoing/incoming `linked_record` links, for
  understanding how the shared forms reference each other.
- **Recent activity** — `GET /api/app/{slug}/activity`: newest submissions
  across all forms *the caller can see* (the same server-side permission
  filter as the runtime payload), which is what the dashboard Activity widget
  renders.
- In the builder UI, forms already used by another app carry a **Shared**
  badge in the create wizard and Manage-forms picker, with the operative
  sentence everywhere: *attaching a form shares it — every app it belongs to
  reads and writes the same data.*
