# Aokie operations

[Documentation index](README.md) · [Connected apps](CONNECTED_APPS.md) · [Troubleshooting](AOKIE_TROUBLESHOOTING.md)

Aokie is the phone bridge, and OAIY runs it. On the **OAIY route**, the default for a new receptionist, OAIY also answers the calls: its voice gateway hears and speaks, and the Front desk agent in OAIY's Agent app does the talking. FormLogic hosts the editable front desk, sends the greeting and the brief, screens callers, answers bookings and lookups through its flows, and stores the records. This guide covers the current OAIY integration. The retired `formlogic-desktop.exe` host is not the current setup; port `17872` now belongs to OAIY's voice gateway.

## Check each connection

| Component | Where to check | What success establishes |
|---|---|---|
| OAIY desktop | Overview; default `http://127.0.0.1:17972/api/health` | The host is reachable and identifies itself as OAIY. This alone does not prove flow or phone readiness. |
| Flow runtime | OAIY Overview and Runs | The CLI/Node runtime is available; queued and failed runs are visible. |
| Aokie plugin | Plugins → Aokie → AI Receptionist → Overview | Plugin health, build, phone, AI and event-delivery status. |
| Phone | Phone setup and Overview | Pairing has progressed to a phone connection; audio still needs a test. |
| Call route | FormLogic Receptionist Settings → OAIY card | **Calls go to: OAIY**. The OAIY card also shows whether OAIY is reachable, the model and voice it reports, and who calls back missed calls. |
| AI and speech | OAIY Engines and OAIY Voice (OAIY route); OAIY Services/providers, then Aokie Settings (Aokie's own speech) | On the OAIY route, OAIY Voice is running and Engines has a model loaded. On Aokie's own route, the selected LLM, STT and TTS endpoints are available. Model loading and GPU execution are separate from process startup. |
| Browser pairing | FormLogic Connect your AI; OAIY Connections | This browser may use the approved local host. |
| Linked account | OAIY Connections → Linked account | OAIY has scoped FormLogic access for records and background work. |
| App routing | FormLogic App Studio, receptionist settings and flow bindings | Events target the intended app/forms. Sharing Aokie forms into another app does not rewrite every automation. |

The GUI process is `oaiy-desktop.exe`; the headless alternative is `oaiy-server.exe`. Aokie runs as `aokie-plugin.exe` over supervised stdio. Model and speech processes depend on the selected services: do not assume a fixed LLM port or speech-server binary. FormLogic's development PHP API may already use port `8080`.

OAIY serves two local ports. Its API (default `17972`) serves the UI, pairing and the chat-completions provider gateway. Its voice gateway (`127.0.0.1:17872`) serves one route: the realtime call stream Aokie opens on the OAIY route, `ws://127.0.0.1:17872/api/ai/providers/oaiy/v1/realtime/stream`. Aokie attaches its gateway token only to `17872`. Aokie's own speech route (the older path) uses separate LLM, STT and TTS endpoints instead. See [AI setup](FREE_PLANS_AND_AI_SETUP.md), [OAIY's call design](https://github.com/f2i-com/oaiy.com/blob/main/docs/CALLS.md) and the [OAIY README](https://github.com/f2i-com/oaiy.com#readme).

## The OAIY route

The OAIY route is the recommended way to run the receptionist. It is the first choice under **Receptionist Settings → Where calls go**, and a new receptionist starts on it.

### What OAIY does

- **Hears and speaks.** Aokie streams each call's audio to OAIY's voice gateway. OAIY Voice transcribes the caller with Parakeet and speaks with Qwen3-TTS, in the voice chosen in OAIY.
- **Talks.** The Front desk agent in OAIY's Agent app writes every reply, using the model chosen in OAIY's **Engines**. It follows its own brief (`/brief.md`), its knowledge files, what it remembers about each caller and the call instructions in **Agent → Phone**.
- **Takes turns.** It talks on over an "mm-hmm" and stops for a real interruption. It greets a known caller by name, and it keeps the conversation going while a business lookup runs.
- **Calls back missed calls**, when that is switched on in **OAIY → Agent → Phone → Missed calls**.

### What FormLogic still does

- **Sends the greeting and the brief.** Receptionist Settings sends the greeting and the persona text to Aokie, which passes the persona to OAIY as *the receptionist brief*. The Front desk's own brief and call instructions take precedence over it. When the brief is blank, FormLogic sends no persona of its own. For a caller whose number is known, Personalize Caller sends a call-scoped brief with their bookings and the calendar's taken times.
- **Answers the call tools.** Aokie still offers the `request_appointment`, `lookup_business_data` and `finish_call` tools. The pack's flows answer them: an appointment request becomes a *requested* Appointment and a confirmation task, and a lookup reads the business's records.
- **Screens callers** (below), keeps every call, transcript, message and follow-up record, and runs the after-call and SMS flows. Those flows use the separate **Background AI** provider.

On this route, FormLogic stops sending what OAIY owns or Aokie ignores: the LLM, speech-to-text and text-to-speech lanes, the model, the voice and the transcript-correction lane. Turn detection, pause and interruption tuning and speculative generation are OAIY's too; FormLogic never set those.

### Where each setting lives

| Setting | Where |
|---|---|
| Where calls go, greeting, receptionist brief, business info | FormLogic Receptionist Settings |
| Call screening, manager line, call waiting, phone auto-connect | FormLogic Receptionist Settings (Aokie's own settings) |
| Background AI for after-call summaries, bookings and SMS drafts | FormLogic Receptionist Settings |
| Replies: the Front desk's brief, knowledge files and caller notes | OAIY → Agent → Front desk |
| Call and text instructions; whether the agent answers calls | OAIY → Agent → Phone |
| Missed-call callbacks | OAIY → Agent → Phone → Missed calls |
| Model | OAIY → Engines |
| Hearing, voice and turn-taking | OAIY Voice (the voice is chosen in OAIY) |
| Auto-answer, consent, restarting the receptionist | OAIY → Plugins → Aokie |

### How the route is saved

The route is saved on the Receptionist Settings record as `call_route`:

- `oaiy`: OAIY answers. The Configure Receptionist flow (on every incoming call) and **Save & apply now** send `aiReceptionist: true`, `realtimeVoiceMode: desktop_realtime`, `realtimeVoiceEndpoint: ws://127.0.0.1:17872/api/ai/providers/oaiy/v1/realtime/stream` and `realtimeVoiceDestination: https://oaiy.localhost`, with the greeting and the brief.
- `aokie`: Aokie's own speech lanes, chosen on the same page. This route also sends `realtimeVoiceMode: legacy`, which takes calls back from any realtime route.
- blank: the route set in Aokie's own settings is left alone. Every record saved before the field existed has a blank route.

Aokie applies a route change when the receptionist next starts, so restart it in **OAIY → Plugins → Aokie** between calls. OAIY on this computer (`https://oaiy.localhost`) must be a destination in Aokie's consent grant. If it is not, Aokie pauses the receptionist and the settings page says to accept it in **OAIY → Plugins → Aokie → Consent**.

### Existing installs

The server copy of the pack carries the route. An existing installation gets it through the in-place upgrade, run from `formlogic/backend`. Check the dry run first:

```powershell
php bin/upgrade-aokie-receptionist.php --app=<app-uuid> --dry-run
php bin/upgrade-aokie-receptionist.php --app=<app-uuid> --apply
```

The upgrade appends the blank `call_route` field, refreshes the settings screen, and updates the Configure Receptionist, Personalize Caller, Missed Call Follow-up and Callback Drain flows in place, keeping records and bindings.

A saved route never moves by itself:

- If Aokie already sends calls to OAIY, Receptionist Settings shows the route as OAIY, marked as an unsaved change. Press **Save** to record it. The follow-ups read the saved route, so they keep calling back missed calls themselves until it is saved.
- Any other route stays as it is. The OAIY card offers **Use OAIY**, which saves the route and applies it at once.

### Missed-call callbacks

OAIY calls back a missed call once the receptionist is free: after a minute and a half, then once more twenty minutes later if there is no answer. It skips a caller who rings again or sends a text. Aokie's own limits still apply: outbound calling must be switched on, and quiet hours and the daily cap hold.

So that a missed call is never rung twice, the pack's follow-ups skip their own callback when the saved route is OAIY:

- **Missed Call Follow-up** still raises the follow-up task, but never dials. The task says that OAIY calls back missed calls when that is on in OAIY → Agent → Phone.
- **Callback Drain** never dials on the OAIY route. A callback FormLogic queued before the switch stays queued for a person to handle.
- The SMS apologies are unchanged: the text to a caller lost on hold, and the text after an unanswered FormLogic callback.

On the other routes, the follow-ups call back as before. Switch callbacks on in one place only.

### Screening

Call screening is Aokie's own setting. The Screening card in Receptionist Settings and **OAIY → Agent → Phone → Who is answered** edit the same blocked numbers, accept filter and private-number setting, so whichever was saved last is what Aokie uses. Record-driven screening (blocked customers and whitelist mode) runs in the Personalize Caller flow on every route.

### Resetting the dongle

**Device Setup → Bluetooth dongle → Reset the dongle** resets the Bluetooth dongle in software through Aokie's `dongle.reset` command, with no unplugging. The phone then reconnects by itself, and the card says whether it has. Aokie refuses a reset during a call; the card tells you to reset after the call ends. An older Aokie plugin does not know the command; the card then tells you to update Aokie in OAIY → Plugins, and to unplug the dongle and plug it back in until then. The button needs the `connector.aokie.dongle.reset` grant, which the Device Admin role has.

### When OAIY is offline

The pack does not assume OAIY is reachable. When it is not, Receptionist Settings, Device Setup and the Live Call console say so, with the name of the linked computer and when it was last seen. They show that information without repeating errors.

- While it is away, OAIY keeps answering calls, lookups and appointment requests from its own calendar. It syncs the Appointments form when it reconnects, so the desktop's own records are the source for that gap.
- A saved setting that the Configure Receptionist flow applies (the route, greeting, brief and Aokie's own lanes) waits: the flow applies it on the first call after OAIY is back. The page says it was saved but not applied yet.
- A setting that exists only in Aokie is not queued. This covers screening, call waiting, audio and the speech engine. The page says it was not applied, and that nothing changed on the phone.

## Set up and verify the app

1. Install the **Aokie Receptionist** starter, or compose its shared forms into the intended app. Check Calls, Appointments, Messages, Transcripts, Follow-ups and Device logs in the front desk.
2. Start Aokie in OAIY. Complete the adapter setup and the phone pairing with matching codes, and review Consent. Read the [hardware guide](https://github.com/f2i-com/aokie.com/blob/main/docs/HARDWARE.md) before changing an adapter driver. On the OAIY route, load a model in OAIY's Engines and start OAIY Voice. On Aokie's own route, select its AI and speech providers.
3. In FormLogic, open **Receptionist Settings**. Keep **OAIY (this computer)** under **Where calls go**, write the greeting and the receptionist brief, and press **Save & apply now**. Then restart the receptionist in OAIY → Plugins → Aokie.
4. Pair the FormLogic browser and link the FormLogic account in OAIY. Check the account, destination app and enabled event bindings.
5. Make a test call from a phone you control. Verify live state, caller/assistant transcript and the completed FormLogic call record. Test incoming and outbound behavior separately; outbound Aokie waits for the recipient to speak before introducing itself.
6. Submit a fictional appointment request in conversation. Check the flow result and Appointments record. A requested appointment remains a request until staff or an intentionally configured backend confirms it.
7. If using messaging, send a test SMS to a number you control and reply. Verify the phone operation, incoming event and app record separately. **Sent** means phone acceptance, not a carrier delivery receipt.
8. Review and test each automation before enabling it. Auto-answer is off by default. Call waiting/hold and callbacks need separate live checks on the actual handset/carrier. On the OAIY route, switch missed-call callbacks on in OAIY → Agent → Phone.

On the OAIY route, the model is the one in OAIY's Engines, and OAIY Voice uses Parakeet and Qwen3-TTS. Aokie's own route was tested with Qwen3.5-9B Q4, NVIDIA Parakeet and Pocket TTS for incoming and outbound conversations, interruptions and SMS. These are tested choices, not required dependencies. Carrier-specific waiting/hold and automatic missed-call callbacks still need additional live validation.

## Diagnose without changing state

Start with readiness cards, current errors and run history. A failed health read is unknown state; the current console shows **Needs attention** rather than retaining a stale green reading.

These read-only OAIY endpoints use the connected host's base URL:

| Endpoint | Use |
|---|---|
| `GET /api/health` | Public host discovery/identity. |
| `GET /api/bridge/status` | Authenticated runtime readiness, CLI/Node details, run counts and plugin availability. |
| `GET /api/plugins` | Authenticated plugin state, reason, manifest version and `lastHealth`, `lastHealthAt` or `lastHealthError`. |
| `GET /api/plugins/aokie/logs?tail=100` | Authenticated bounded plugin stdout/stderr logs. |

Use the existing approved browser or desktop session for protected requests. The old `/api/desktop/support-bundle` recipe is not a current OAIY endpoint. Reconnect or relink through the UI instead of extracting credentials from local config files.

A public discovery check in PowerShell:

```powershell
Invoke-RestMethod 'http://127.0.0.1:17972/api/health'
```

Record timestamps, build versions, error codes and relevant run/record IDs. Plugin logs can contain phone numbers, messages and transcripts; review and redact them before sharing. A raw log is not a privacy-filtered support bundle.

## Restart or update safely

End the test call and check waiting/held callers before restarting. Use OAIY's plugin/service stop and start controls for a clean shutdown. Confirm Aokie has stopped before replacing a Windows executable, then install the intended package, start required services and recheck readiness.

For source builds, follow the [Aokie build guide](https://github.com/f2i-com/aokie.com#build-from-source), including its voice feature and driver-helper integrity requirements. Find the active OAIY data directory through its configuration UI; the retired `com.formlogic.desktop` install path is not appropriate.

If OAIY cannot bind its API after restarting, inspect the listener and its process command line before stopping anything:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 17972 |
    Select-Object LocalAddress, LocalPort, OwningProcess
```

Use the actual configured port for a headless/custom host. Avoid terminating every model or speech process by name; another project may own one. Verify pairing, account linking, providers and a resulting app record after recovery.

## Delivery, retention and time

If Calls says there is no desktop but Device Setup reports **unverified custom screen**, check the pack's screen provenance. This is a screen-verification failure, not evidence that OAIY is offline. Use **Records → Calls** or **Records → Transcript Turns** to check server data independently. Unsigned folder-pack imports cannot use privileged screen SDK actions, even when their background app logic is receiving events.

Maintainers can refresh the bundled Aokie screens and sign the exact folder payload from `formlogic/ui` with `node scripts/emit-marketplace.mjs --folder-screens aokie-receptionist`. This requires the existing trusted vendor key and updates the matching legacy catalogue entry too. It preserves forms, flows and hosted project source. Deploying a new catalogue does not replace screens in an existing installation: update those screens through a reviewed in-place upgrade, preserving IDs and records. Do not disable SDK trust checks or reinstall over customer data to work around this.

For after-call summaries and appointment extraction, configure the **Default model** in **OAIY → Providers → Edit** or specify a model in Receptionist Settings. The phone responder can work while these background flows fail with “no model specified,” because they use OAIY's AI gateway independently. After correcting the model, test a new call or inspect the failed run's business effects before retrying it.

Aokie's durable outbox tracks pending, failed and dead events. **All events delivered** describes delivery to the host; a successful FormLogic flow and stored record establish end-to-end success. Fix the link, permission or flow error before redriving. `outbox.redrive` can target one idempotency key or an explicit dead set; inspect business side effects before retrying. Preserve original event identity so deduplication can work.

Check the installed forms' `retentionDays` and purge behavior rather than assuming every deployment uses the starter's policy. Customers, appointments and follow-ups have different retention needs from call/transcript/message/device records. Set the app timezone for dashboard day boundaries and confirm booking dates/times in that timezone.

Preserve FormLogic records and Aokie plugin data during updates. Hosted custom backend databases need separate backups as described in [hosted apps](HOSTED_APPS.md#export-and-back-up). A downloaded editable client contains source, not live records or credentials.
