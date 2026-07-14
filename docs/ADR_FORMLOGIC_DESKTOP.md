# ADR: FormLogic Desktop becomes FormLogic Desktop

**Date:** 2026-07-07 · **Status:** Accepted · **Repos:** `f2i-com/formlogic.com`, `formlogic-com/formlogic-web`, `f2i-com/aokie.com`

## Decision

The FormLogic desktop companion (`formlogic-web/desktop`, Tauri 2, `127.0.0.1:17872`) is rebranded and evolved into **FormLogic Desktop** — the single local capability layer for the FormLogic product family. Aokie ceases to be a standalone desktop product: its native phone/dongle capabilities become the **Aokie Desktop Plugin** hosted by FormLogic Desktop, and its user experience becomes the **Aokie Receptionist for FormLogic** app package. The FormLogic flow engine is surfaced inside FormLogic as **FormLogic Flows**.

```
FormLogic               = parent/company/technology brand
FormLogic         = main product platform
FormLogic Desktop = installed local companion (models, plugins, hardware, flows)
FormLogic Flows   = FormLogic flow engine integrated into FormLogic
Aokie             = a FormLogic app + a FormLogic Desktop plugin
```

## Rationale

Three disconnected products (FormLogic, FormLogic, Aokie) confuse users and triplicate platform work (auth, records, dashboards, roles, packaging). FormLogic already has the platform primitives (apps, forms, connectors with typed errors + permission grants, signed packages, marketplace, dashboards); the desktop companion already has the local-service/security machinery; Aokie already has the native stack. Composition beats parallel maintenance.

## Repo layout (decided 2026-07-07, hybrid)

FormLogic Desktop's source lives **in `f2i-com/formlogic.com` at `formlogic/desktop`** (moved from `formlogic-web/desktop` so the platform, desktop companion, flows, and app packages version together). `formlogic-com/formlogic-web` keeps the FormLogic flow-builder product (ui/api/cli) — its web UI only gained the dual companion-id matcher. `f2i-com/aokie.com` stays separate (large native stack, heavy CI) behind the versioned stdio plugin contract.

## Consequences

- **Compatibility:** port 17872 and bundle identifier `com.formlogic.desktop` are kept (existing installs keep working and keep their data dir). Health gains `companion:"formlogic-desktop"` with `legacyCompanion:"formlogic-desktop"`; both web UIs accept either id for 1–2 releases. Old *deployed* FormLogic web builds that match only the legacy id must be redeployed alongside the Desktop update.
- **Internal names stay:** crate `formlogic-desktop`, `FORMLOGIC_SERVER_*` env vars, `formlogic-core` remain; only user-facing strings change.
- **Security:** privileged local capabilities move behind an origin-bound pairing-token model (see `docs/FORMLOGIC_DESKTOP.md` §3), extending — not replacing — the existing origin guard.
- **Aokie legacy app** remains building (via `aokie-core`) as a developer/admin fallback until the plugin + FormLogic app reach feature parity for core flows.
- **Contracts** live canonically in `formlogic-app/docs/{FORMLOGIC_DESKTOP,DESKTOP_PLUGIN_SDK,AOKIE_PLUGIN_CONTRACT,FORMLOGIC_FLOWS}.md` + `docs/contracts/*.schema.json`; the other repos carry pointer docs + local schema copies for their tests.
