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
enable GPU execution.

For the Aokie phone receptionist, OAIY is the AI on the call. On the OAIY route,
the default, the Front desk agent answers with the model chosen in OAIY's
**Engines**, and OAIY Voice hears (Parakeet) and speaks (Qwen3-TTS, with the
voice chosen in OAIY). FormLogic's Receptionist Settings then send only the
greeting, the receptionist brief and the route. Aokie's own speech route, under
**Other routes**, still uses separately configured STT, LLM and TTS services. On
every route, the receptionist's after-call summaries, booking extraction and SMS
drafts use the **Background AI** provider chosen in Receptionist Settings. See
[Aokie operations](AOKIE_OPERATIONS.md#the-oaiy-route).

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

### Serving the Site AI from an always-on OAIY server

The Site AI card (Admin → Plans) serves members' Site AI from one of your linked OAIY computers. An
always-on server running `oaiy-server`, with no browser of its own, links with a one-time code:
choose **Connect an OAIY server**, keep **AI only** (the default), and run the command it shows on
the server (`oaiy-server link --code … --base-url …`). Once the server is started and has published its
chat key, it is listed beside your desktops. An **AI only** link answers AI requests and checks in,
and nothing else: it is given no connector or plugin commands, runs no flows and cannot be a storage
node. Choose **Everything a linked desktop can do** only for a computer you also want to run those.
See [Connecting an OAIY server](HOSTED_APPS.md#connecting-an-oaiy-server).

A computer you chose that is later unlinked, gets a new key (OAIY reinstalled) or whose account is no
longer an administrator's is no longer chosen: nothing is sent to it, nor to the provider in your
server settings in its place (members and apps are told the site's AI is unavailable), apps' requests
waiting for it are answered that the AI is unavailable, and the card names it until you choose again
or forget it. Forget it, and the provider in your server settings serves the Site AI again.

### AI for apps

SoftN apps can ask for AI from their own server: pictures, picture edits and chat (a logo maker that
draws for its visitors, "Ask AI" in an app). Admin → Platform → **AI for apps** decides whether they may
use this site's own AI, and how much. It is off until you turn it on, and each app's owner then turns
it on for their app (Settings → AI for this app).

- **Apps may use this site's AI.** Their requests go where the Site AI goes: your OAIY computer (above),
  or the provider in your server settings.
- **Picture model.** The OAIY Engines picture model apps' pictures use, named exactly; **List the
  computer's picture models** asks your computer for the ones switched on. None chosen: apps can ask
  for chat only. The chat model is optional; empty, apps chat with the Site AI's own.
- **Pause every app's AI** is the stop for all of them: apps are told their AI is paused, and nothing
  is sent. **Stop its AI**, in the list of apps, stops one, with a reason its owner sees.
- **Limits.** What a new app's owner starts from: per visitor or member a day (10), per address a day
  (20: an app's free rounds), per address an hour (10), and per app a day (500, also the most an owner
  may set on the site's AI). **Requests a day, every app together** (2,000) is the site's own ceiling.
- **Words a prompt may not use**, one a line: a request that uses one is refused, and the app is told.
- **Warnings.** The card says when a picture model was refused by your computer in the last day
  (switched off, or its files are missing), when apps may use the site's AI with no picture model, and
  when this site is reached through Cloudflare with `TRUSTED_PROXIES` unset, which makes every
  visitor's free rounds one shared allowance (see [Before going live](HOSTED_APPS.md#before-going-live)).

An app's owner may instead serve its AI from **their own OAIY** (Settings → AI for this app → Use my
OAIY): one of their own linked computers draws for it, whether or not this site offers its AI, and
spends none of the site's day. Your pause, a stop for one app and the words a prompt may not use
still apply to it.

The settings are kept in `backend/storage/app-ai.json` (include it in backups); a missing or broken file
means apps may not use the site's AI. Requests are sent and delivered by `bin/app-ai-worker.php`, which
must run every minute from cron or under a supervisor with `--watch`; without it, apps' requests wait and
then run out. Your OAIY computer draws one picture at a time, and a member's chat is never held up by a
picture, though the computer's one GPU is: a chat that reaches it while a picture is drawn waits for the
picture, and its model may take half a minute to load again. See [App AI: where it runs, and what the
app is delivered](HOSTED_APPS.md#app-ai-where-it-runs-and-what-the-app-is-delivered).

### App payments

SoftN apps can charge their visitors a few cents (5¢ to download a logo, say) from a balance the
visitors top up through this site's PayPal. Admin → Platform → **App payments** turns it on. The money
goes to this site's own PayPal account, so in this version only apps owned by an administrator can take
payments; the app's owner then turns them on for the app and confirms its prices (Settings → Payments).

- **It needs** the Plans payments switch on, PayPal configured (`PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`,
  and `PAYPAL_WEBHOOK_ID` for refunds and held payments), and `BETA_MODE` off. While any is missing,
  apps are told payments are off, and no top-up or charge is taken.
- **Top-ups offered**: $2, $5 and $10 to start; $2 at least, since PayPal's fixed fee makes less poor
  value.
- **Most one charge may be** (500¢), whatever an app declares, and **most one wallet may spend a day**
  (500¢).
- **The latest top-ups** are listed with PayPal's order and capture ids, to find them in PayPal. A
  refund you make in PayPal's dashboard takes the money back from the visitor's balance (below zero
  if it was spent; the balance is then held until a top-up settles it), and a dispute holds the
  balance until it is resolved. **Correct** adds or takes an amount with a note on the wallet's
  ledger.
- Balances do not expire; refund what is left when a visitor asks. A prepaid balance with one merchant
  is close to a gift card, and local law may have rules for those: check what applies to the site.

The settings are kept in `backend/storage/app-payments.json` (include it in backups); a missing or
broken file means no app takes payments. See [App payments](HOSTED_APPS.md#app-payments-a-prepaid-balance-and-a-charge-in-two-runs)
and [Before going live](HOSTED_APPS.md#before-going-live).

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
