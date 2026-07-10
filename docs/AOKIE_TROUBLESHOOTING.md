# Aokie Receptionist — Troubleshooting

Concrete failure modes and their fixes. Start every diagnosis with the support
bundle (`GET :17872/api/desktop/support-bundle`) — see `AOKIE_OPERATIONS.md`.

## The desktop shows "Loading services…" forever

The `:17872` port is wedged by a dead desktop's inherited children
(`llama-server` / `aokie-voice-server`). Kill all four processes together and
relaunch — full recipe in `AOKIE_OPERATIONS.md`. Confirm with
`Get-NetTCPConnection -LocalPort 17872` returning nothing before relaunch.

## Live-call controls fail after an app update (`capability_denied`)

A linked desktop enforces server-minted, role-derived capability tokens on
loopback connector commands (SEC-001). A stale cached PWA bundle mints against
the old path and gets **403 capability_denied**. Fix: **Ctrl+F5** to hard-refresh
the tab. This is expected after any release that touches the web bundle.

## The browser can't reach the desktop (401 on every call)

Pairing tokens are stored in `pairing.json` (config dir) as sha256 hashes,
loaded **once at startup**. The file is **BOM-intolerant**: a PowerShell
`Set-Content -Encoding utf8` writes a UTF-8 BOM, and the desktop then silently
drops **all** pairing tokens (empty store → browser 401s). If you edit
`pairing.json` by hand, write it BOM-free (e.g. via Python), then restart the
desktop.

## The Calls summary says "no transcript summary available"

The summary LLM node returned empty. Cause: a Qwen3-class model burns its whole
token budget in a hidden `<think>` block unless the node sets
`extraBody.chat_template_kwargs.enable_thinking = false`. Every `llm_chat` node
in the pack now carries this; if you author a new one, add it too.

## A call connected but there is no audio (silent both ways)

The SCO alternate-setting failed to arm the USB iso pipes — the HFP link is up
but no audio flows. The plugin emits `hardware.error {code: sco_unarmed}` and
the Device Setup console shows it. Recovery: hang up, unplug and replug the
dongle, then take the next call. If a specific dongle does this consistently,
it is likely not fully compatible — see the aokie repo's `docs/HARDWARE.md`.

## The receptionist won't answer (health "degraded")

Read `plugins[].health.detail` in the support bundle. Common reasons:

- **"radio not running / dongle not initialised"** — the dongle isn't
  bound/enumerated; check Device Setup.
- **"outbox replay thread stalled / halted"** — durable delivery is frozen;
  restart the stack.
- **"settings file was corrupt"** — the config was quarantined to
  `settings.json.corrupt` and safe defaults (auto-answer OFF) are in effect;
  re-save the Receptionist Settings.
- **"voice feature not compiled"** — a non-voice plugin build is deployed;
  redeploy the `--features voice` build.

Note: `autoAnswer` defaults **OFF** — a fresh install must set it explicitly
before the receptionist answers.

## The receptionist interrupts the caller mid-sentence (esp. numbers)

Barge-in sensitivity. Raise `bargeSensitivity` (setting; higher = harder to
interrupt) and/or `sttEndpointMs` (longer end-of-utterance pause). A phone
number read in groups is held as one turn by the continuation logic, but a very
aggressive `bargeSensitivity` can still cut it.

## A record didn't save / a booking double-created

Both are guarded, so this signals a deeper issue — check
`flowRuntime.lastError` in the support bundle. Record writes carry deterministic
idempotency keys (crash-retry converges to one row), lifecycle upserts match by
`call_id` via an indexed server-side lookup (found regardless of age), and a
withheld caller id is stored as empty rather than a non-phone sentinel. If you
see a duplicate, capture the two response ids and the `lastError` before
retrying.

## Diagnosis probe with an API key

The desktop's own API key lives in `companion-config.json` (the `flk_`/`flm_`
value). Probe the cloud API directly with it, e.g. an indexed lookup:

```
GET /api/v1/forms/{callsFormId}/responses?answers.call_id=call_...&limit=1
Authorization: Bearer <key>
```
