# Phase −1 threat models

Working threat models for the three new attack surfaces. Each lists assets,
adversaries, the attacks the design must survive, and where the mitigation lives.
The malicious-package fixtures (PLG-108) and release gates (v3 §16) turn these into
executable tests.

## 1. Native plugin supply chain

**Assets**: the operator's machine (a native plugin is a full user-level process),
the phone line, plugin data (call records, pairing keys), publisher reputation.

**Adversaries**: a malicious package author; a compromised publisher key; a MITM on
the download path; a local attacker staging files into the plugins dir; a hostile
update to a previously good plugin.

| Attack | Mitigation (ADR-003) |
|---|---|
| Zip-slip / traversal / ADS / junction in archive | staging extractor rejects absolute paths, `..`, ADS, symlinks/junctions/reparse points |
| Zip bomb | file-count / compressed / expanded / ratio limits before extraction |
| Unsigned or tampered payload | Ed25519 envelope over every file digest, verified at scan AND launch; unlisted-loadable-file = tamper |
| Signer swap / downgrade / id-version mismatch | signed identity binding; signer-change, downgrade, and mismatch rejection |
| PATH/command hijack | package-relative hash-listed entry files only in production; no shell |
| Connector/event squatting on install | collision quarantine (ADR-002) |
| Post-install mutation between scan and start | full re-verify immediately before launch (TOCTOU close) |
| Malicious uninstall/purge target list | purge is a host-owned ceremony with a resolved target list + typed confirmation; external paths listed, never auto-deleted |
| Update bricking the live receptionist | versioned dirs + atomic `current` pointer + data snapshot + N-1 rollback; quiescence rules refuse updates mid-call/lease/pairing/driver-transaction |
| Driver-flavour confusion | attested-public vs managed-beta are separate channels; never auto-upgrade across |

**Residual risk**: a signed-and-trusted publisher shipping malicious code — a native
process is NOT sandboxed. Mitigated by pinned-publisher-only production posture and
plain-language install disclosure; a future restricted-token/AppContainer design is
the only real fix (explicitly out of scope for v1).

## 2. Powered pack bridge (sandboxed app screens)

**Assets**: app records (PII), the phone (connector commands can dial), consent
integrity, the desktop pairing trust model, hosted companion operations.

**Adversaries**: a malicious marketplace pack; a tampered import of a good pack; a
compromised screen edited post-install; a pack trying to escalate via the bridge.

| Attack | Mitigation (ADR-003 §component trust, ADR-004) |
|---|---|
| Malicious pack UI drives the phone | bridge calls gated on component digest trust (`verified_vendor`/`owner_approved`) AND deployment grants AND role permissions; install-time grant review |
| Edited screen inherits vendor trust | per-digest trust; any local edit → `vendor_modified`, powered bridge lost |
| Export/import laundering of grants | requested permissions travel; active grants/bindings/secrets never exported; clone/rebind resets grants |
| Bulk destruction via records API | no `records.clearAll`; `records.deleteMany` = explicit IDs, small batch cap, row-level RBAC, optimistic versions, idempotency, recycle-bin, audit |
| Arbitrary backend reach | no raw `backend.fetch`; typed server-registered `service.invoke` operations with schema/permission/rate/byte caps |
| Pairing-token theft | pack code can never mint or read desktop pairing tokens; pairing initiation stays host-owned |
| Event/caption cross-app leakage | subscriptions scoped by deployment/app/connector/call with sequence numbers + resume cursors (ADR-002 identity stamping) |
| Update overwriting owner edits silently | three-way merge, conflict + permission-expansion review |

## 3. AI gateway

**Assets**: the user's cloud API keys (spend), caller audio/transcripts (privacy +
consent), provider config integrity.

**Adversaries**: any web page in any local browser (drive-by), a local unprivileged
process, a malicious/compromised custom provider endpoint, a hostile pack screen, a
crashed-and-replaced plugin process reusing credentials.

| Attack | Mitigation (ADR-008) |
|---|---|
| Drive-by key spend from a browser page | inference never anonymous; Origin-bearing calls need webview/pairing token with `ai.invoke` grants; CORS route-specific |
| Local process spends keys | native tier requires the per-session plugin credential delivered over the private pipe (never argv/env) |
| Credential replay after crash/restart | credential bound to process generation; revoked on stop/crash/restart |
| Consent laundering via loopback | consent context derives from WHO authenticated; cloud destinations must be present in the active signed grant; disclosure logging |
| SSRF via custom provider URL | HTTPS default, LAN/loopback explicit opt-in, DNS pinning/rebinding protection, metadata/link-local/private denial, redirect denial |
| Header/secret injection | no caller-supplied hop-by-hop headers; newline rejection; `{{apiKey}}` resolved gateway-side only |
| Resource exhaustion / runaway cost | request/response/audio/SSE size limits, timeouts, per-call limits, circuit breaker, cost ceilings (Realtime) |
| Key exfiltration via logs/support bundles | secrets only in Credential Manager; `hasKey` booleans on the wire; log redaction |
| Silent fallback to the wrong model | discovery never falls back across providers; readiness probes gate auto-answer |
