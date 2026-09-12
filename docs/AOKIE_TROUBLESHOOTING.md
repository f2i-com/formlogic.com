# Aokie troubleshooting

[Documentation index](README.md) · [Operations](AOKIE_OPERATIONS.md) · [Connected apps](CONNECTED_APPS.md)

Start with Aokie Overview in OAIY, the latest health result and the corresponding flow run. Record the time and error before changing settings. OAIY's default API is `http://127.0.0.1:17972`; old `formlogic-desktop.exe`, port `17872` and `/api/desktop/support-bundle` instructions do not describe the current host.

## OAIY is unreachable or stays on a loading screen

Check `GET /api/health` at the host's actual address. It should identify OAIY; a listener alone is not enough. If discovery works but a protected read returns 401, reconnect FormLogic's browser and approve the matching code in OAIY **Connections**. Overview or authenticated `GET /api/bridge/status` distinguishes missing CLI/Node runtime from a stopped plugin.

Use OAIY's stop/start controls first. If a port stays occupied, identify its owner before stopping it; see [restart guidance](AOKIE_OPERATIONS.md#restart-or-update-safely). Do not edit pairing files or reuse another account's credentials.

## Aokie says Starting or Needs attention

Check plugin `state`, `reason`, `lastHealth`, `lastHealthAt` and `lastHealthError`, also shown in Overview. Running means a process can answer; it does not establish phone, AI or delivery readiness. An unhealthy plugin may still accept diagnostics. Probe failures should show **Needs attention**, not indefinite startup or a stale green state.

| Problem | Next step |
|---|---|
| Radio not initialized or phone disconnected | Check Device/Phone setup, adapter access and handset connection. Pairing alone is not an active hands-free link. |
| Voice feature not compiled | Install the intended voice-enabled build. |
| Model or speech unavailable | Start the configured service, wait for model loading and check its endpoint/model in Settings. |
| Settings quarantined/corrupt | Review and save valid settings through the UI; check auto-answer explicitly because safe defaults leave it off. |
| Failed events/delivery backlog | Check the linked account, app routing and flow errors before redriving. |

## A provider works in OAIY but not in Aokie

Select it through Aokie Settings to use that host's advertised gateway URL. Avoid the legacy port `17872`; preserve a custom endpoint when the service is intentionally separate. Check the model/capabilities and test a small request.

Current OAIY supports gateway chat completions, not a realtime WebSocket voice proxy. Configure separate STT, LLM and TTS services for local voice. A local provider does not automatically use a GPU: verify the service's execution provider and startup diagnostics. See [AI setup](FREE_PLANS_AND_AI_SETUP.md).

## A call connects but audio is missing or distorted

Check phone transport and the speech pipeline separately. `hardware.error` with `sco_unarmed` means call control connected but adapter audio did not. End the test call, follow adapter recovery steps and retry. Do not unplug during a live conversation.

Without a transport error, verify STT receives audio and TTS produces a complete local sample. Compare that sample with a call using the same voice to isolate synthesis from Bluetooth/carrier audio. Inspect available sample-rate, codec, clipping, underrun and transport diagnostics; static alone cannot identify the cause. See [hardware compatibility](https://github.com/f2i-com/aokie.com/blob/main/docs/HARDWARE.md).

## Words are clipped, names are wrong, or replies are slow

Confirm the STT model/service in Settings and its actual logs. Compare transcript with captured audio only when recording is enabled and the caller agreed to the test. Confirm short names and numbers in conversation instead of silently guessing their spelling.

Separate utterance detection, STT, LLM and TTS timing. Increasing **STT endpoint** (`sttEndpointMs`) allows longer pauses in grouped speech but delays replies. Change one setting at a time and repeat the same phrase; a slow first turn may include model warmup.

With interruption enabled, the plugin captures speech while the AI talks. **Barge sensitivity** (`bargeSensitivity`) is a threshold: a higher value makes it harder to interrupt. Raising it does not fix early end-of-utterance detection and can hide quiet callers. Check overlap/interrupted transcript labels and echo behavior before tuning. Test a clear correction during an AI reply, then verify the complete correction reached the app.

## An outbound call is silent at first or stops hearing the recipient

The recipient-first greeting is intentional: Aokie waits for speech after the phone confirms the call is active. **Dialing** should show Cancel call, not Answer/Reject. Once active, it uses the normal conversation loop, including interruptions and transcripts.

If no greeting follows speech, compare phone active state, received audio/STT and current call ID. If later turns stop, inspect the last STT/LLM/TTS error and whether the call ended or switched. Delayed results from a previous call must not enter a new conversation. Reproduce with one controlled call rather than repeatedly redialling while state is uncertain.

## Call waiting or hold appears stuck

Overview's switchboard shows waiting/held callers and switching transitions. A requested hold/swap is not complete until the handset reports its state. A failed snapshot means unknown state, not an empty queue. The summary is read-only; it adds no caller-activation action.

Check handset/carrier support and avoid repeated commands during a pending switch. Test with numbers you control. Code checks and single-call tests do not establish waiting/hold behavior on every phone.

## Calls appear locally but records or appointments are missing

1. Check OAIY **Connections → Linked account**. Browser pairing alone does not grant account-backed record/event access.
2. Check the intended app, forms, enabled event bindings and runtime readiness. App composition shares forms without rewriting every automation.
3. Inspect the flow error/result, then search the appropriate form by call/request ID. Outbox delivery to OAIY happens before the final FormLogic record write.
4. For bookings, check that a validated request was queued and its appointment flow completed. Caller agreement and a request record do not confirm a slot. Check app timezone and date/time.
5. For apparent duplicates, retain both record IDs and originating event/run IDs before retrying. Stable identity supports safe retries; unrelated flow side effects still need review.

A 403 from MCP/API can indicate a missing role, app binding or capability. Refreshing a stale web bundle may help after an update, but is not a universal fix. Use documented scopes and supported relinking instead of broadening permissions or extracting a stored desktop key.

## SMS or a missed-call follow-up did not happen

Check handset messaging support, consent, draft/approval state and the phone's send result. **Needs approval** does not mean queued for automatic sending; **sent** means phone acceptance, not carrier delivery. Verify incoming reply events and app records separately.

For a callback, check that the call ended as **missed**, the callback flow is enabled, a caller number is available and the run reached its outbound step. Withheld numbers cannot be called back. Inspect failed attempts and policy conditions before retrying; a follow-up task alone does not mean a call was placed. Automatic callbacks and carrier waiting/hold still need additional live validation on the deployed setup.

## A call summary is empty or incomplete

Inspect the summary flow's model result, token budget and errors. A reasoning model can use its budget before producing the required structured response; configure a model-compatible response mode rather than assuming every provider accepts the same extra fields. Where configured, use the settled transcript event for analysis so overlap/corrections can land first.

Keep raw logs, recordings, caller numbers and transcripts private unless deliberately shared for diagnosis. An issue should include redacted errors, build versions and reproducible steps, not pairing tokens, API keys or account sessions.
