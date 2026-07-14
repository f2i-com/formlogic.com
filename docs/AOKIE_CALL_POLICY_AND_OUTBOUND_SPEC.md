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

## Phase 0.5 — Record-driven screening (flow layer)

- Customers form gains `blocked` (yes/no) and `sms_capable` (yes/no,
  default yes).
- `personalize-caller` (runs at caller-id): if the matched customer is
  `blocked` → `connector.request call.reject {callId}` (on post-answer-id
  phones this is an immediate hangup — acceptable).
- `whitelistOnly` (Bool setting): when on, `personalize-caller` rejects any
  caller with NO matching Customer record.
- Every `sms.send` site (kickoff, conversation loop, missed-call fallback)
  gates on the customer's `sms_capable` (unknown numbers default to
  attempting SMS as today).
- `defaultCountryCode` (Str, e.g. `+61`) on Receptionist Settings:
  normalizes locally-formatted numbers (leading 0 → +CC) for OUTBOUND sms/
  dial; matching stays last-9-suffix.

## Phase 1 — Abuse handling

- Standing prompt rule: if the caller is abusive, reply exactly `[[ABUSE]]`.
- Deterministic handler (never the LLM): speak "We do not tolerate abusive
  calls. Goodbye.", hang up (reuse the agent-hangup path incl. the
  ghost-turn latch), append the number to `blockedNumbers` via the
  settings store, write the Calls row with status `terminated_abuse`.
- Optional `autoBlockAbuse` (Bool, default ON when abuse handling enabled).
- Web app: blocked-number management UI on the Receptionist console
  (list + unblock button → settings.set). The block list is plain settings,
  so unblock is instant next radio start / next call via flows.

## Phase 2 — Outbound calling

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

0. Phase 0 (plugin screening) — this session.
0.5 Phase 0.5 (blocked/sms_capable/whitelist/country code) — next.
1. Phase 1 (abuse) — small, after 0.5.
2. Phase 2 (outbound + missed-call queue) — the big one, own session(s).
3. Phase 3 (manager line) — after outbound proves the dial path.
4. Phase 4 (hold/waiting) — last, behind flags.
