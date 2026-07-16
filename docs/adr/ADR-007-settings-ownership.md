# ADR-007 — Settings ownership split

Status: **accepted** · 2026-07-16 · source: v3 plan §7

## Decision

No single plugin-shipped settings schema is canonical for every layer. Settings are
owned by scope:

| Scope | Examples | Storage |
|---|---|---|
| Machine / plugin | Driver, dongle, hardware diagnostics, local model paths | Plugin/host machine data |
| Connector instance | Phone pairing, line behavior, local runtime options | Plugin data keyed by connector instance |
| FormLogic app | Business persona, greeting, forms, flows, disclosure/consent policy | App package/config + app records |
| User preference | UI, notifications, audio route preference | User profile/device |
| AI provider profile | Endpoint, secret reference, models, limits | Desktop config + Credential Manager |

Rules:

- Deterministic effective-config **precedence** with revisions; optimistic revision
  checks so two UIs can't silently overwrite each other.
- Packs store **logical provider bindings** (capability aliases), never API keys.
- The generic settings renderer needs signed **presentation metadata** beyond the
  current operational schema: label, help, group, order, defaults, enum labels,
  advanced flag, conditional visibility, widget, apply boundary, reconnect warnings.

## Security prerequisite (AOK-304A — blocks any generic settings UI over Aokie)

`managerPin` is currently returned by `settings.get` and stored plaintext in
`settings.json` (+ backup/quarantine copies). Before generic settings UI ships:
migrate it to Credential Manager/DPAPI or a strong one-way verifier; scrub
primary/backup/quarantine files; make the field secret/write-only returning only
`hasValue`/masked state; exclude it from exports, logs, and support bundles.
