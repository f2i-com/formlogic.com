# Aokie operations

[Documentation index](README.md) · [Connected apps](CONNECTED_APPS.md) · [Troubleshooting](AOKIE_TROUBLESHOOTING.md)

Aokie runs the phone conversation in OAIY. FormLogic hosts the editable front desk and stores records produced by connected flows. This guide covers current OAIY integration; the retired `formlogic-desktop.exe` host and port `17872` are not the current setup.

## Check each connection

| Component | Where to check | What success establishes |
|---|---|---|
| OAIY desktop | Overview; default `http://127.0.0.1:17972/api/health` | The host is reachable and identifies itself as OAIY. This alone does not prove flow or phone readiness. |
| Flow runtime | OAIY Overview and Runs | The CLI/Node runtime is available; queued and failed runs are visible. |
| Aokie plugin | Plugins → Aokie → AI Receptionist → Overview | Plugin health, build, phone, AI and event-delivery status. |
| Phone | Phone setup and Overview | Pairing has progressed to a phone connection; audio still needs a test. |
| AI and speech | OAIY Services/providers, then Aokie Settings | Selected LLM, STT and TTS endpoints are available. Model loading and GPU execution are separate from process startup. |
| Browser pairing | FormLogic Connect your AI; OAIY Connections | This browser may use the approved local host. |
| Linked account | OAIY Connections → Linked account | OAIY has scoped FormLogic access for records and background work. |
| App routing | FormLogic App Studio, receptionist settings and flow bindings | Events target the intended app/forms. Sharing Aokie forms into another app does not rewrite every automation. |

The GUI process is `oaiy-desktop.exe`; the headless alternative is `oaiy-server.exe`. Aokie runs as `aokie-plugin.exe` over supervised stdio. Model and speech processes depend on the selected services: do not assume a fixed LLM port or speech-server binary. FormLogic's development PHP API may already use port `8080`.

Use the host-advertised gateway URL for configured providers. Current OAIY provider routing supports chat completions, not a realtime WebSocket voice proxy. Aokie's tested local path uses separate LLM, STT and TTS endpoints. See [AI setup](FREE_PLANS_AND_AI_SETUP.md) and the [OAIY README](https://github.com/f2i-com/oaiy.com#readme).

## Set up and verify the app

1. Install the **Aokie Receptionist** starter, or compose its shared forms into the intended app. Check Calls, Appointments, Messages, Transcripts, Follow-ups and Device logs in the front desk.
2. Start Aokie in OAIY. Complete adapter setup and phone pairing with matching codes; select AI/speech providers and review Consent. Read the [hardware guide](https://github.com/f2i-com/aokie.com/blob/main/docs/HARDWARE.md) before changing an adapter driver.
3. Pair the FormLogic browser and link the FormLogic account in OAIY. Check the account, destination app and enabled event bindings.
4. Make a test call from a phone you control. Verify live state, caller/assistant transcript and the completed FormLogic call record. Test incoming and outbound behavior separately; outbound Aokie waits for the recipient to speak before introducing itself.
5. Submit a fictional appointment request in conversation. Check the flow result and Appointments record. A requested appointment remains a request until staff or an intentionally configured backend confirms it.
6. If using messaging, send a test SMS to a number you control and reply. Verify the phone operation, incoming event and app record separately. **Sent** means phone acceptance, not a carrier delivery receipt.
7. Review and test each automation before enabling it. Auto-answer is off by default. Call waiting/hold and callbacks need separate live checks on the actual handset/carrier.

The current local test configuration used Qwen3.5-9B Q4, NVIDIA Parakeet and Pocket TTS for incoming/outbound conversations, interruptions and SMS. These are tested choices, not required dependencies. Carrier-specific waiting/hold and automatic missed-call callbacks still need additional live validation.

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

Aokie's durable outbox tracks pending, failed and dead events. **All events delivered** describes delivery to the host; a successful FormLogic flow and stored record establish end-to-end success. Fix the link, permission or flow error before redriving. `outbox.redrive` can target one idempotency key or an explicit dead set; inspect business side effects before retrying. Preserve original event identity so deduplication can work.

Check the installed forms' `retentionDays` and purge behavior rather than assuming every deployment uses the starter's policy. Customers, appointments and follow-ups have different retention needs from call/transcript/message/device records. Set the app timezone for dashboard day boundaries and confirm booking dates/times in that timezone.

Preserve FormLogic records and Aokie plugin data during updates. Hosted custom backend databases need separate backups as described in [hosted apps](HOSTED_APPS.md#export-and-back-up). A downloaded editable client contains source, not live records or credentials.
