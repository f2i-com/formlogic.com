# Plugin manifest v2 — UI contributions, owned services, app binding (Phase 2)

Manifest `schemaVersion: 2` adds optional sections on top of the v1 contract. A v1
manifest keeps loading byte-identically; a v2-only section under `schemaVersion: 1`
is refused. Inside the presentation-only `ui` section, unknown fields are tolerated
(forward-compatible); the execution/service/command/data sections fail closed. The
desktop understands `schemaVersion` 1..2; a v2 manifest is refused by an older
desktop, so **the desktop update always ships before a v2 plugin** (`minDesktopVersion`
covers the reverse).

## `ui` — declarative UI contributions (PLG-203)

Everything here is DATA rendered by generic desktop components — no plugin code runs
in the host. This is what makes a plugin's side-menu link + Overview banner appear
dynamically.

```jsonc
"ui": {
  "nav": [                              // side-menu entries
    { "id": "home", "label": "AI Receptionist", "icon": "phone", "badge": "New" }
  ],
  "overview": [                         // Overview banner / cards
    { "id": "hero", "kind": "hero", "title": "Aokie receptionist", "icon": "phone",
      "bind": { "headline": "$health.status", "body": "$health.detail",
                "cta": { "label": "Open", "nav": "home" } } }
  ],
  "statusCards": [                      // poll a declared command, show fields
    { "id": "phone", "title": "Phone bridge",
      "poll": { "command": "phone.status", "intervalMs": 5000 },
      "fields": [ { "label": "Phone", "path": "device.name" },
                  { "label": "Connected", "path": "connected" } ] }
  ],
  "actions": [                          // safe action button (a declared command)
    { "id": "sim", "label": "Simulate call", "command": "dongle.diagnostics",
      "confirm": "Fire a simulated incoming call?", "devOnly": true }
  ]
}
```

- **icon** — an allow-listed name (`phone`, `plug`, `server`, `database`, `gear`,
  `link`, `grid`, `terminal`, `puzzle`); unknown → a generic puzzle icon.
- **bind paths** — a safe JSON-pointer-like grammar (`$`-prefixed reads the plugin
  snapshot: `state`, `reason`, `health.status/ok/detail`; a status-card field path
  reads the poll command's response `data`). Dotted `[A-Za-z0-9_]` segments only —
  no executable syntax; unsafe paths are refused at parse.
- **CTA** — a card's `bind.cta.nav` must reference a `ui.nav` id (validated).
- **status-card commands / action commands** — must be declared by a connector.
- **polling** — host-clamped to ≥ 2 s and paused while the plugin isn't running.

The desktop renders nav entries as sidebar links (opening the plugin's contributed
screen — its status cards + actions), and overview cards on the Overview.

## `services` — plugin-owned local services (PLG-206)

```jsonc
"services": [ { "templateFile": "services/aokie-voice.json" } ]
```

Package-relative ServiceTemplate JSON files (no `..`, no absolute). On install each
is loaded and stamped `owner: "<pluginId>"`; the user cannot edit or delete an owned
template directly, a different plugin cannot claim the same id, and **uninstall or
disable stops + removes the plugin's owned services** so none outlive the plugin.
Replaces the old aokie-voice path-convention coupling.

## `commands.journalled` — durable requestIds (PLG-202)

```jsonc
"commands": { "journalled": ["call.answer", "call.reject"] }
```

Commands that carry physical side effects; the host mints a durable requestId for
them. Surfaced in the plugin snapshot as `journalledCommands`, replacing the
hardcoded client-side mirror for v2 plugins.

## `data.externalInventory` — purge checklist (PLG-107)

```jsonc
"data": { "externalInventory": [
  { "path": "%APPDATA%/com.aokie.app", "label": "Aokie radio data (pairing keys, call db)" },
  { "credential": "Aokie/*", "label": "Sealed keys in Windows Credential Manager" }
] }
```

Data the plugin stores OUTSIDE the desktop tree. It is **never auto-deleted**; on
uninstall-with-purge the confirm dialog lists it so the user can remove it manually.

## App binding (PLG-205)

`PluginInstallation → ConnectorInstance → AppBinding` — a host-authoritative local
record binding one connector to one app (`plugin-data/app-bindings.json`). The host
stamps every identity; a plugin/pack cannot supply its own scope fields. One physical
connector has one active owning app; switching owner bumps a monotonic epoch, and a
command carrying a stale epoch fails closed.

Routes: `GET /api/plugins/bindings`, `POST /api/plugins/bindings` (bind — webview/
server-token only), `DELETE /api/plugins/bindings/:id` (revoke).

**Additive + non-breaking**: the connector gateway consults a binding ONLY when a
request names an app (`appId`/`bindingEpoch` on the request). Today's relay + direct
paths send no app context, so a connector with zero bindings behaves exactly as
before — the live receptionist keeps working. Uninstall forgets a plugin's bindings.

Deep enforcement across the whole dispatch path + the matching hosted (PHP) record
land with the Aokie migration (Phase 3); Phase 2 delivers the model, storage, API,
and the non-breaking enforcement hook.

## Deferred to Phase 3

Rich host ceremonies (numeric-comparison pairing confirm, driver-setup wizard) are
Aokie-specific and land with the Aokie migration. The safe-action primitive
(`ui.actions[].confirm` → a host confirm dialog) ships now.
