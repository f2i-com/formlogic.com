# FormLogic documentation

Build a form, connect your AI, publish an app, or operate the connected desktop. Start with a task below. The [project README](../README.md) shows the product and current screenshots; the website's `/docs` page provides an in-app introduction.

## Get started

| I want to… | Read |
|---|---|
| Add or customise form builder starters | [Folder-backed form templates](FORM_TEMPLATES.md) |
| Run FormLogic locally or build the web app | [Developer setup](../formlogic/README.md) |
| Connect OAIY, an API provider or an external AI | [Free access and AI setup](FREE_PLANS_AND_AI_SETUP.md) |
| Configure free access, optional support plans and Site AI | [Administrator controls](FREE_PLANS_AND_AI_SETUP.md#administrator-controls) |
| Combine forms, dashboards and Aokie in one app | [Connected app workspaces](CONNECTED_APPS.md) |
| Host and edit a Softn project with private `.logic` and SQLite | [Hosted apps](HOSTED_APPS.md) |
| Create, edit and delete native SQLite records | [Owner database controls and API](HOSTED_APPS.md#owner-record-api) |
| Let an AI create and edit my workspace | [MCP connection guide and tool reference](MCP.md) |
| Connect an external system using an API key | [REST API](API.md) |

Manual editing and starters do not require an AI provider. Site AI and payments are off by default. Browser pairing with OAIY and linking the FormLogic account for records/background flows are separate setup steps; the connected apps guide explains both.

## Build and extend apps

| Topic | Reference |
|---|---|
| Portable client, private backend actions, access rules, limits and database export | [Hosted apps](HOSTED_APPS.md) |
| Shared forms, app composition and the editable Aokie front desk | [Connected apps](CONNECTED_APPS.md) |
| Multiple portals using shared data with different permissions | [One backend, many portals](ONE_BACKEND_MANY_PORTALS.md) |
| Flow definitions, event bindings, queues and run history | [FormLogic Flows contract](FORMLOGIC_FLOWS.md) |
| Extension packages, contributed nodes and service bindings | [Extensions](EXTENSIONS.md) |
| Pack v1 structure, cross-references and import/export boundaries | [Pack format](PACK_FORMAT.md), [JSON schema](pack-schema-v1.json) |
| Existing custom screens, effects, connectors and app domains | [Custom app platform reference](CUSTOM_APP_PLATFORM.md) |
| Browser/server form expression sandbox and engine builds | [Runtime developer guide](../formlogic/runtime/README.md) |

For new portable Softn projects, use the hosted and connected app guides first. The custom-screen and flow contracts also cover older or staged features; their examples are not a guarantee that every desktop capability is available in the installed host.

## Operate Aokie and OAIY

| Task | Guide |
|---|---|
| Connect the phone receptionist to the intended app and verify delivery | [Aokie operations](AOKIE_OPERATIONS.md) |
| Diagnose connection, audio, transcript, booking or messaging failures | [Aokie troubleshooting](AOKIE_TROUBLESHOOTING.md) |
| Install/build the phone plugin and check current tested limits | [Aokie repository README](https://github.com/f2i-com/aokie.com#readme) |
| Check adapter and driver compatibility | [Aokie hardware guide](https://github.com/f2i-com/aokie.com/blob/main/docs/HARDWARE.md) |
| Configure the current desktop host, providers and local services | [OAIY repository README](https://github.com/f2i-com/oaiy.com#readme), [desktop guide](https://github.com/f2i-com/oaiy.com/blob/main/desktop/README.md) |
| Debug a hosted MCP client's OAuth connection | [MCP OAuth troubleshooting](MCP_OAUTH_TROUBLESHOOTING.md) |

OAIY replaces the retired FormLogic Desktop host. Its default local API is `http://127.0.0.1:17972`; use the address advertised by the installed host when it differs. The current provider gateway supports chat completions, while Aokie's working voice path uses separate LLM, STT and TTS services. Do not infer realtime WebSocket support from older design documents.

## Deploy, upgrade and verify

| Task | Guide |
|---|---|
| Configure production hosting, secrets, workers and backups | [Deployment](../DEPLOYMENT.md) |
| Upgrade an existing installation and plan rollback | [Upgrading](UPGRADING.md) |
| Run local backend, frontend and browser checks | [Developer checks](../formlogic/README.md#tests-and-checks), [browser/device matrix](BROWSER_DEVICE_MATRIX.md) |
| Prepare a packaged release and launch smoke checks | [Release runbook](RELEASE_RUNBOOK.md), [launch checklist](../LAUNCH_CHECKLIST.md) |
| Verify custom app permissions and runtime behavior | [Custom app smoke tests](CUSTOM_APP_PLATFORM_SMOKE_TEST.md) |

Automatic push/PR checks are temporarily paused. Run relevant checks manually and record their results for the commit being released. The package workflow is manual-only; select the intended branch or tag when starting it. The workflow files in [`.github/workflows`](../.github/workflows) define the actual release triggers.

Hosted app databases under `backend/storage/hosted-apps` are separate from per-form response databases and are not yet included in account/form exports. Include them in operator backups using a consistent SQLite snapshot; see [export and backup boundaries](HOSTED_APPS.md#export-and-back-up).

## Design records and legacy contracts

These documents retain design history and compatibility details. Use current source, installed capabilities and the guides above for deployment commands and supported behavior.

| Reference | How to use it |
|---|---|
| [FormLogic Desktop](FORMLOGIC_DESKTOP.md), [desktop plugin SDK](DESKTOP_PLUGIN_SDK.md), [desktop ADR](ADR_FORMLOGIC_DESKTOP.md) | Retired host design. Build and operate OAIY from its own repository. |
| [AI gateway](AI_GATEWAY.md), [website AI routing audit](WEBSITE_AI_DESKTOP_ROUTING.md), [site chat tunnel plan](SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md) | Historical routing and capability design. Some listed endpoints, including realtime gateway routes, are not implemented by current OAIY. |
| [Plugin lifecycle](PLUGIN_LIFECYCLE.md), [manifest v2](PLUGIN_MANIFEST_V2.md), [Aokie plugin contract](AOKIE_PLUGIN_CONTRACT.md), [call policy/outbound specification](AOKIE_CALL_POLICY_AND_OUTBOUND_SPEC.md) | Protocol and feature-design references; check the installed plugin manifest and current Aokie tests for available commands. |
| [Custom app specification](CUSTOM_APP_SPEC.md), [app sections](APP_SECTIONS_SPEC.md), [widget dashboards](WIDGET_DASHBOARD_DESIGN.md) | Architecture and screen model history. Current portable app authoring starts with the hosted/connected app guides. |
| [Custom-screen dashboard kit](CUSTOM_SCREEN_DASHBOARD_KIT.md) | Legacy sandboxed HTML/CSS/JS screen kit, separate from the Softn hosted runtime. |
| [Private forms plan](E2EE_PRIVATE_FORMS_PLAN.md), [browser hardening](E2EE_P3_BROWSER_HARDENING.md), [encrypted data-node plan](FORMLOGIC_DESKTOP_ENCRYPTED_DATA_NODES_PLAN.md), [data-node contract](FORMLOGIC_DATA_NODES.md) | Gated encryption/data-node work and retired desktop contracts; not a default-enabled deployment recipe. |
| [Native Tauri runtime](NATIVE_RUNTIME_TAURI.md) | Optional app shell design; distinct from the OAIY desktop host. |

When updating a feature, update its current task guide with the implementation and validation limits. Keep historical specifications labelled rather than presenting a proposed feature as available.
