# Free access, optional support and AI setup

[Documentation home](../README.md) · [Connected apps](CONNECTED_APPS.md) ·
[Hosted apps](HOSTED_APPS.md) · [Build with an external AI](MCP.md)

FormLogic defaults to a free workspace with bring-your-own AI. There is no payment requirement for creating forms, publishing apps, accepting responses or continuing to use existing data. The legacy CLOUD_PLAN_ENFORCED environment setting no longer locks the workspace on an expiry date.

You can create forms manually or use a starter without configuring AI. The public
website's `/ai-setup` page explains the available connections before signup;
`/connect-ai` opens the authenticated setup wizard. When signed out, it takes you
to login and preserves the destination.

## Connect your own AI

Open **Connect your AI** (`/connect-ai`), also linked from **Settings → AI
assistant**. Follow **Choose → Connect → Use in FormLogic**.

| Choice | Setup | Where it works |
|---|---|---|
| **OAIY desktop** | Start OAIY, complete its runtime/AI setup, connect from FormLogic and approve the matching code in OAIY **Connections**. Select the provider as your default in FormLogic. | OAIY runs on the same machine and stays online while the browser uses its local AI gateway. |
| **API provider** | Add the endpoint, model and key in the browser AI service editor, save, test and select it as the default. | The setup stays in this browser/account storage. The provider must permit browser requests; otherwise connect it through OAIY. |
| **External AI using MCP** | Give your MCP client the FormLogic MCP URL and approve its scoped connection. | Your external AI builds through FormLogic tools. This is separate from choosing a model for FormLogic's own chat. See [MCP setup](MCP.md). |

The wizard's final check verifies the saved choice and provider availability.
Use the separate **Test connection** action to test an actual model response;
it may send a small provider request and incur provider charges.

For Aokie events, records and background flows, also complete OAIY's **Linked
account** connection. Browser pairing and linking a FormLogic account serve
different purposes. See [Connected apps](CONNECTED_APPS.md).

### Choose Codex or a local model in OAIY

OAIY's **Overview** guide covers **Runtime → Your AI → Plugins → FormLogic**.
Under **Your AI**, choose **Codex / ChatGPT**, **Provider API key**, or **Local
model**. Codex sign-in starts only when you choose it; OAIY uses a separate
managed Codex session and the Codex process owns its credentials. The wizard
links to the official CLI installation guide if the CLI is missing.

For a local model, configure and start its server under **Services**, download
its model under **Models**, then select it in FormLogic. GPU acceleration is
configured by the model server; selecting a local provider alone does not
enable GPU execution. Aokie's speech pipeline can use separately configured
STT, LLM and TTS services.

### What uses the selected AI

New preferences default to custom AI without a selected provider. Operator-funded
**Site AI** is off by default, even if a server key is present. Admins can opt in;
`AI_ENABLED=false` remains an additional override. Disabled Site AI cannot make
provider requests, even when an existing user's preference still selects it.

Chat and default-source automations use the selected provider. Some specialised
document, form and script generation routes still require operator-enabled Site
AI; BYO support is not universal across those routes. Manual editing, starters
and authorised external MCP tools remain separate ways to build an app.

### If the connection needs attention

| Symptom | Check |
|---|---|
| Setup is saved but a model request fails | Run **Test connection**; check the model name, endpoint, provider availability and account limits. |
| OAIY is not found or a saved connection stopped working | Keep OAIY open on this machine, check its local API status, then reconnect and approve the matching code. |
| Direct API requests fail in the browser | Confirm the provider permits browser requests, or configure it through OAIY's gateway. |
| Calls appear in OAIY but app records or automations do not update | Check the linked account, selected app, event bindings and run history; browser pairing alone does not configure these. |
| A generation route says Site AI is disabled | Use an available BYO workflow or manual editor, or ask the operator whether that specific server-side route is enabled. |

## Administrator controls

Open Admin > Platform > Plans & bring your own AI. Edit the free and paid plan names and descriptions, and the price in USD. The optional Supporter plan defaults to $5 USD per 30 days. It uses the existing prepaid PayPal order/capture system; there is no recurring subscription or automatic renewal. Supporting the project does not grant an exclusive feature tier or remove free access from anyone.

Payments are OFF by default. Enabling the admin switch makes the optional plan visible. Checkout additionally requires configured PayPal credentials, and BETA_MODE still overrides the switch and refuses payments. Both order creation and capture check the switch server-side. Existing order amounts are recorded on the server and do not change when the admin edits the price. Existing payment webhooks still reconcile completed payments.

GET /api/admin/plans and PUT /api/admin/plans live behind the existing authenticated platform-admin gate. Updates are audited. The validated settings are atomically replaced in backend/storage/platform-plans.json. A missing or malformed file falls back to free access, no payments and no Site AI. Include this operator configuration file in infrastructure backups. It contains no provider or payment credentials.

Public pricing is returned in the `plans` object of `GET /api/health`, and account
pricing in the `plans` object of `GET /api/billing`. Landing, billing and admin
screens consume these settings. Public configuration refreshes when a view
mounts. USD is the supported currency; the optional support plan is not a
multi-tier entitlement or recurring subscription engine.

## Verify a local setup

1. Visit `/ai-setup` and `/connect-ai` while signed out; verify the public guide
   loads and login returns to the wizard.
2. Connect a provider, save it, run **Test connection**, and send a small prompt
   through FormLogic chat. Confirm the intended provider handled the request.
3. Reopen settings and check the saved default. Stop or disconnect a development
   provider to verify the UI reports the failure, then reconnect it.
4. In a development admin account, save plan labels with payments disabled and
   verify landing/billing agree. Use PayPal sandbox credentials for checkout
   tests; editing labels does not require a purchase.

Use your configured development ports. OAIY's default local API port is `17972`;
its UI preview and FormLogic's Vite server can use different ports. Previewing
the desktop UI does not bypass native/headless administration authentication.
