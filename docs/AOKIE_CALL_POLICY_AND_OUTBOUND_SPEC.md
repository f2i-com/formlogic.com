# Aokie: Call Policy, Internationalization, Outbound Calling, Manager Line, Hold/Waiting — Spec

Status: DRAFT v1 (2026-07-14, from user feature batch). Phases ordered by
value ÷ risk. Phase 0 ships first (this session); each later phase is a
session-sized build on the infrastructure the earlier ones create.

---

## Opinion / feasibility summary

| Feature | Verdict | Notes |
|---|---|---|
| Country-code config | Easy win | Matching is already last-9-digit suffix (country-agnostic); the code matters for normalizing locally-typed numbers and outbound SMS/dial. |
| Landline callers | Mostly policy | They already work for CALLS; they can't receive SMS — the `sms_capable` flag + missed-call CALLBACK (not SMS) is the landline-friendly channel. |
| `sms_capable` on Customer | Easy win | One field + a guard in every sms.send flow. Default ON for mobiles, owner can untick. |
| Call screening (block/filter/whitelist/private) | High value, moderate | Two layers by design: PLUGIN for number rules (fast, pre/at-answer), FLOWS for record rules (blocked flag, whitelist) via `call.reject`. |
| Abusive-call hangup + auto-block | Good with guardrails | The model FLAGS (`[[ABUSE]]`); deterministic code speaks the notice, hangs up, writes the block. One-click unblock in the web app. Keep the LLM out of the unblock path. |
| Outbound calling via flows | The big unlock | HFP `ATD` dialing exists at the protocol level; the agent session machinery is symmetric. Substantial but well-scoped. |
| Missed-call queue + callback + SMS fallback | Natural extension | Mirrors the SMS follow-up loop the app already has. |
| Manager line | Powerful; AUTH is the hard part | Caller-ID is spoofable. Require caller-ID match AND a spoken PIN before any record mutation. Read-only summaries can be caller-ID-only. |
| Hold & call waiting | Most complex; LAST | Needs carrier call-waiting + HFP `AT+CHLD` multiparty support on the phone; per-call context separation touches every per-call structure in radio.rs. Behind a feature flag, hardware-gated. |

---

## Phase 0 — Call screening & policy (plugin layer)  ← THIS SESSION

New settings (fixture-synced both repos; applied at radio start):
- `blockedNumbers` (Str): comma/newline list. Digits-only last-9-suffix match
  (same rule as `phone_eq` everywhere).
- `acceptPattern` (Str): optional regex the caller id must match (e.g.
  `^(\+?61|0)4` = Australian mobiles). Empty = accept all. Applied to the
  RAW caller id string. Invalid regex = ignored + health note.
- `rejectPrivate` (Bool): treat a withheld/absent caller id as screened.
- `screenMessage` (Str): optional line spoken to screened callers before
  hangup (e.g. "Please call back with caller ID enabled."). Empty = silent
  reject/hangup.

Enforcement point: the answer path. On phones that deliver +CLIP during
ring, a screened number is REJECTED pre-answer. On phones where the id only
arrives post-answer (the live Pixel: CLCC), the call is answered, screened
immediately, `screenMessage` spoken, then hung up. `rejectPrivate` uses the
existing id-wait window: no id by answer time = private.

Records: screened calls still write a Calls row (status `rejected`, note
`screened: blocked|filtered|private`) — an audit trail, not a black hole.

## Phase 0.5 — Record-driven screening (flow layer)  ← SHIPPED 2026-07-14

As built (deltas from the draft in brackets):
- Customers: the EXISTING `status` dropdown already had a 'blocked' option —
  that IS the blocked flag now (no separate yes/no field; blocking from the
  profile = set Status to Blocked). `sms_capable` (yes/no, blank = yes)
  added.
- `personalize-caller` (runs at caller-id): matched customer with status
  'blocked' → condition-gated `connector.request call.reject {callId}`,
  configureAgent SKIPPED (exclusive branches). On post-answer-id phones this
  is an immediate clean hangup; the session tracker records outcome
  'rejected' (the plugin's reject_or_hangup path — no plugin change needed).
- `whitelist_only` [a Receptionist Settings FORM field, not a plugin
  setting — the flow already reads the record per call, so it applies from
  the next call with no reconnect]: on = callers with NO Customer record are
  rejected. Withheld ids never mint a caller_id event, so whitelist cannot
  see them — the console copy points those at rejectPrivate.
- `sms.send` gates: after-call kickoff (hasKickoffSms false + call-back note
  in the task) and the conversation loop (deterministic ctx verdict
  'no_sms' → task handoff, LLM skipped) both respect `sms_capable`='no' and
  blocked status. Unknown numbers still text, as before.
- `default_country_code` [also a form field]: outbound `to` numbers with a
  leading 0 are sent as +CC…; bare '61' tolerated; junk disables; Messages
  rows keep the observed number (matching is last-9-suffix everywhere).
- Console: whitelist toggle + country code live in the Call screening card
  (saved by the same Save-screening button: settings.set + record patch);
  blocked numbers render as chips with one-click remove + post-save
  read-back.

## Phase 1 — Abuse handling  ← SHIPPED 2026-07-14

As built:
- Standing prompt rule (`ABUSE_INSTRUCTION`): reply exactly `[[ABUSE]]` for
  slurs/threats/harassment; explicitly NOT for frustration/venting/swearing
  about their own situation (small-model overfire guard).
- Deterministic handler in the reply pump: the marker is held back from
  speech per-sentence (like `[[LOOKUP`), the generation abandoned, then
  fixed code flushes TX, speaks "We do not tolerate abusive calls, so this
  call will now end. Goodbye.", drains playout, hangs up with the
  ghost-turn latch, and suppresses the dead-air fail-safe for that reply.
- Auto-block lands in THREE layers: the running ScreenPolicy immediately
  (the number's next attempt is already screened), process env (policy
  rebuilds keep it), and the persisted `blockedNumbers` setting via a
  RadioStatus queue the connector drains on every command dispatch (the
  desktop health poll bounds the lag — the radio never touches the store).
- `autoBlockAbuse` (Bool, default ON, applies_live; fixture synced both
  repos): opting out disables ONLY the blocking — notice + hangup always
  happen. Console checkbox in the Call screening card.
- Calls row: new `terminated_abuse` status (TerminationIntent::
  AgentTerminateAbuse → outcome `terminated_abuse`, reason `agent_abuse`);
  LOGIC_CALL_ENDED passes it through; after-call-actions SKIPS abuse calls
  (no records/tasks/SMS off an abusive transcript — texting a just-blocked
  caller would be worse than nothing); call-summary still records the row.
- Unblock = one click on the console's blocked-number chips (shipped with
  Phase 0.5).

## Phase 2 — Outbound calling  ← LIVE-PROVEN 2026-07-14 (two real calls; queue slices remain)

Slice 1a (aokie `ad64616`, deployed z26): the radio/MO layer — `ATD` dial
command through both HFP paths, MO callsetup tracking (2=dialing → new
OutgoingDialing event, 3=alerting → the existing Ringing), the MT held
verdict extended to the MO answer race, outbound CallSessions with honest
never-answered outcomes (`no_answer` when alerted, `failed` when not,
reason `cancelled` when we gave up), and `direction` on call.ended.
Slice 1a fixed a latent bug: an owner dialing from the handset got GREETED
by the receptionist on their own outgoing call — now observed silently.

Slice 1b (aokie `1f5e628` + formlogic `caa0779`, deployed z27): outbound
is COMMANDABLE — `call.dial {number, openingLine, purpose?}` with typed
guardrails BEFORE the radio: `outboundEnabled` kill switch (DEFAULT OFF,
live-smoked on z27), local quiet hours (21→8 default, equal = disabled),
persisted per-local-day `maxDailyDials` (default 20, crash-safe counting).
openingLine spoken VERBATIM at pickup via the call-scoped overlay's
greeting slot; purpose → OUTBOUND persona block (be brief, [[END_CALL]]
when done, voicemail = one short message); 60s dial watchdog. Outbound
calls never mint caller_id events (whitelist would reject our own dial)
and are never screened. Contract churn complete both repos (manifests,
fixtures, flowEventCatalog, browser mock with demo parity, customLogic
grant retrofitted).

Remaining slices: dedicated `outbound` consent scope + wizard checkbox
(pre-GA), `aokie_dial` flow node (both runners), the missed-call queue
(Callback Tasks form + dial-back flow + SMS fallback via sms_capable),
formlogic Calls direction field + no_answer status + outbound app-logic,
and outbound-aware post-call processing.

LIVE-PROVEN (z28): two real dials to the owner's phone. Call 1 exposed the
overlay-wipe bug (callee got the INBOUND greeting) + the inbound booking
extractor minting junk records off an outbound transcript — both fixed
(scoped overlay wipe; after-call-actions skips direction 'outbound'). Call
2: opening line spoken verbatim, agent knew it placed the call, clean
records. Owner-confirmed audio quality.

- Radio: `dial(number)` via HFP `ATD<number>;` + outbound call session
  (state: dialing → ringing → active/failed/no-answer). The agent session
  machinery (greeting suppressed; OPENING SCRIPT instead), same duplex
  loop once audio is up.
- Connector command `call.dial {number, purpose?, script?, flowContext?}` →
  consent-gated (new `outbound` consent scope). Returns accepted/queued.
- Flow node `aokie_dial` (both runners) + `aokie.call.outbound.*` events
  (dialing/connected/no_answer/busy/completed) on the durable plane.
- Agent context for outbound: persona + explicit purpose ("You are calling
  <name> to confirm their booking at 6 PM") + the same lookup tools.
- MISSED-CALL QUEUE: `call.ended reason=missed` binding → flow writes a
  Callback Tasks row (new form) with attempt count; a scheduler flow (or
  the after-call flow) dials back ONCE after N minutes; on no-answer →
  `sms_capable ? send apology SMS with reply loop : leave task open for a
  human`. Attempt caps + quiet hours are settings.
- Guardrails: outbound only to numbers that called first OR are Customer
  records (no cold-dial arbitrary numbers), per-day dial cap, kill switch.

## Phase 3 — Manager line

- `managerNumbers` (Str list) + `managerPin` (Str, spoken digits).
- A manager caller gets the MANAGER persona: full read access via the
  existing lookup flow family (bookings today, caller history, messages),
  plus WRITE tools (confirm/cancel/move bookings, block numbers) — writes
  require the PIN spoken once per call (deterministic verification, never
  the LLM).
- Implementation rides Phase-2 infra: manager tools are lookup flows with
  write output-actions; `[[LOOKUP:]]`-style markers already proven.
- Explicit spoofing note in docs: caller-ID alone NEVER authorizes writes.

## Phase 4 — Hold & call waiting (feature-flagged, hardware-gated)

- Requires carrier call waiting + phone/HFP `AT+CHLD` support (probe at
  connect; feature stays off if unsupported).
- New CallSwitchboard: per-call context (history, lane, captions epoch —
  already epoch-keyed), hold = `AT+CHLD=2`, resume = `AT+CHLD=1/2x`.
- "Please hold" message + queue position; queue events on the realtime
  lane (the captions strip becomes a switchboard view).
- Missed/abandoned in queue → the Phase-2 callback/SMS machinery.
- Honest scoping: this is the largest single feature since full-duplex;
  plan a dedicated multi-session arc with the synthetic rig extended to
  two-call timelines.

---

## Rollout order

0. Phase 0 (plugin screening) — SHIPPED 2026-07-14.
0.5 Phase 0.5 (blocked/sms_capable/whitelist/country code) — SHIPPED 2026-07-14.
1. Phase 1 (abuse) — SHIPPED 2026-07-14.
2. Phase 2 (outbound + missed-call queue) — the big one, own session(s).
3. Phase 3 (manager line) — after outbound proves the dial path.
4. Phase 4 (hold/waiting) — last, behind flags.
