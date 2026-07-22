# E2EE Private Forms — Design & Implementation Plan

**Status:** v3 — working specification. **P1 may begin** (the two v2 protocol errata — DEK
wrapper and manifest identity — are fixed in this revision). **P3 may begin only after its
entry checklist (§9.1) is re-verified against the then-current code.** P4–P7 become
authoritative only when their stated addenda are appended. Two independent review passes
(2026-07-22) are incorporated; changelog in §0. The architecture review at
`C:\Users\User\Desktop\tasks\FormLogic-E2EE-Architecture-and-Implementation-Plan.md` remains
the threat-model narrative; this document governs implementation.
**Prepared:** 2026-07-22, against formlogic `00a4bb7` (post Site-AI/tunnel epic).
**Scope:** formlogic repo only. Aokie alignment is Phase 7 and gets its own doc when reached.

**Product promise (exact wording, keep honest):**
> Responses to a Private form are encrypted in the submitter's browser before upload. FormLogic
> stores only ciphertext and cannot read the answers or files. You decrypt them in your own
> browser with your vault passphrase. If you lose your passphrase and recovery kit, FormLogic
> cannot recover the data.

What it does NOT protect against (state in docs/UI, never oversell): a server that maliciously
serves altered JavaScript to a future session; metadata (submission time, ciphertext size, form
identity, IP handling per §12); a logged-in user copying plaintext after decryption; a removed
team member retaining copies of keys or plaintext they already had (§11). The client-side
guarantee is **no plaintext at rest** — decrypted values necessarily exist transiently in
main-thread memory while displayed; the guarantee is that they are never persisted and are
dropped on lock (§10).

---

## 0. Changelog

### v2 → v3 (second review pass, all findings adopted)

1. **DEK adoption removed from the v1 frozen format.** The FK-wrapped DEK (72 B) contradicted
   the envelope's fixed 80 B `wrappedDek`, its AAD needed an `fkEpoch` the envelope lacked,
   and adopted records would have pinned old FK epochs across rotations. v1 has exactly one
   wrap suite; a future `__flenc:2` restructures to a `dekWrap` object (§6.1). Consequence:
   FK rotation never touches response rows — it rewraps ingestion secrets only, which is now
   fully consistent. §5, §6, §11.
2. **Immutable `form_manifests` table + verifiable manifests.** v2 overwrote one
   `manifest_sig` slot on the ingestion-key row and served a `signerKeyId` without the
   verification key. v3: append-only manifest rows storing the exact signed bytes, signature,
   signer key id **and signer public key**; the served manifest includes `signerPk` so any
   browser can mathematically verify; envelope acceptance is manifest-row-based, which also
   aligns schema-version acceptance with ingestion-key grace (they can no longer disagree).
   §7, §8.
3. **Grant rows persist their full verification context** (wrap suite, grantor signing-key id,
   grantee public-key snapshot, canonical-string version) and P5 adds **reciprocal**
   fingerprint verification (grantee authenticates grantor too). §7, §11.
4. **Atomic enable lifecycle** — new durable `forms.ever_published_at` (backfilled NOW() for
   all pre-existing forms, making v1 private forms strictly post-feature creations); enable is
   one transaction re-checking the full §9.1 preflight (webhooks/flows CAN exist on unpublished
   forms — v2's assumption was unsafe). Private mode is **irreversible** in v1 — no disable
   toggle, and clone/import/stale-client paths cannot strip it. §3, §7, §9.1.
5. **Rotation policy made unambiguous:** routine rotation = 7-day grace; member removal =
   strict by default (grace only via explicit warning override); suspected compromise =
   strict, always. The P5 gate no longer contradicts grace mode. §11, §16-P5.
6. **Implementation-path corrections:** private-mode dispatch happens *before* any plaintext
   answer sanitation in `ResponseController`, `AppPublicController`, and every batch/sync
   drain path; `expectedRev` shown in the request shape; idempotency contract unchanged from
   today's API (root-level body field); CAS is one atomic conditional `UPDATE`, never
   read-then-write; duplicate-key detection uses a reviewed duplicate-aware parser
   (`seld/jsonlint` w/ key-conflict detection) at request root AND envelope level instead of a
   hand-rolled tokenizer; **P3 is standalone forms only** (app-runtime private forms deferred
   to P5); `schema_json` becomes `MEDIUMBLOB` (exact bytes, immune to charset/collation
   mangling) and the builder renders the exact snapshot being hashed. §6, §7, §8, §9.
7. **Browser hardening promoted into P3 gates:** multi-tab lock/logout propagation
   (BroadcastChannel), worker termination on lock, vault-generation counter clearing all
   decrypted state (Zustand/in-memory caches/component state via remount), storage-inspection
   tests over real IndexedDB/CacheStorage/Workbox queues/local+sessionStorage/SW bodies,
   baseline CSP + telemetry exclusions + decrypted-renderer review. "Remember this device"
   ships only together with device inventory + revocation. LRU-vs-search reconciled; CSV
   export is full-fetch with explicit `-partial` handling on cancel. §10, §14, §16-P3.
8. **P4 addendum checklist expanded** (one-time claim consumption, atomic insert+commit, 1:1
   claim/list matching, plaintext-vs-ciphertext hash roles, framing/memory budgets, private
   file authorization, retry/abandoned cleanup); P3 preflight blocks file/camera fields
   entirely until P4. §13.

### v1 → v2 (first review pass, all findings adopted)

1. **Form Key epochs** — v1's revocation was cryptographically broken (new ingestion secret
   wrapped under the FK the revoked member already knew). FK is epoched; revocation mints
   FK[e+1], re-grants to remaining members only, re-wraps all ingestion secrets. §7, §11.
2. **Signature binding widened** — grants sign the wrapped-key hash, fingerprints, epoch,
   suite, role, expiry; manifests sign suites + schema version/hash + signer + expiry, and are
   stored (server cannot regenerate them). §7, §8, §11.
3. **Recovery kit format fixed** — 32 B = 52 unpadded Base32 chars + `FLRK1` prefix +
   checksum group + explicit recovery AAD. §5.
4. **Sealed-box test methodology corrected** — sealing is randomized by construction; use
   open-committed-fixture tests in both directions, never byte-identical seal vectors; suite
   renamed `sealedbox-x25519xsalsa20p1305.1`. §5, §16-P1.
5. **Immutable schema versions** — envelopes bind `schemaVersion`+`schemaHash` to stored
   exact-bytes snapshots; live-form recomputation abolished. §7, §8.
6. **Attachment claim path redesigned** — plaintext `attachments` id list on the envelope,
   bound into the AAD by hash; opaque `.bin` names; abuse controls gated into P4. §13.
7. **Key states + offline/rotation conflict** — `active/retiring/retired`, `accept_until`,
   grace-window trade-off stated. §11.
8. **Wire/storage tightening** — single `{envelope}` request shape; `rev` CAS in AAD;
   raw-body duplicate-key checks; public keys re-derived after unlock; `kdf_par` dropped. §5–§8.

---

## 1. Verified current state (ground truth this plan is built on)

Audited 2026-07-22 directly from the code. Every design choice below is anchored to these facts.

**Where answer plaintext lives today**

| # | Location | Detail |
|---|----------|--------|
| 1 | `storage/forms/<formId>.sqlite` → `responses.answers` (JSON) + `-wal`/`-shm` | Primary store. Written by `ResponseService::createResponse` (~line 1490, `json_encode($data['answers'])`). Schema v4 in `SQLiteConnection::initializeFormSchema()` |
| 2 | Same DB: `responses.metadata` | IP, user-agent, referrer, language, completionTime, submittedByUserId (expression index on submittedByUserId) |
| 3 | Same DB: `computed.field_value`, `tags.tag`, `script_logs.error_message` | Server-derived from answers |
| 4 | MySQL `response_metadata` | ip_address, user_agent, completion_time mirror |
| 5 | MySQL `webhook_deliveries.payload` | Full answers JSON, retained for retries (`WebhookService::deliverBatch`) |
| 6 | MySQL `flow_run_logs` | `input_snapshot_json` (full answers ≤64 KiB), `result_json` (`formlogic_list_responses` returns full rows) |
| 7 | Backups | Nightly `ScheduledBackupService` ZIPs copy per-form SQLite verbatim + `database.sql.gz`; on-demand `AccountBackupService` ZIPs; `AppDataExportService` CSV/SQL/sqlite exports |
| 8 | `storage/trash/<userId>/<id>.zip` | Recycle-bin snapshots (verbatim SQLite) |
| 9 | `storage/uploads/<formId>/<fileId>.<ext>` | Raw file bytes, unencrypted. Original filename lives only inside `responses.answers` (already!) |
| 10 | Client: IndexedDB `formlogic-offline` (`offlineQueue.ts`), Workbox background-sync POST queue, localStorage `formlogic-responses` (local mode only), `demoLocal` | Plaintext answers at rest client-side |

**Server code that computes over answers** (must be gated in private mode):
`ResponseService` json_extract pushdown (`answersEq`/`answersGte`/`answersLte`/`answersPhoneEq`,
`ORDER BY json_extract`, `answers LIKE`), `FormLogicRuntime`/`QuickJsRunner` (onSubmit +
calculated, via stdin pipe — transient only), `ReportService`/`AppReportService` (compute on
read, nothing persisted), `AppDataExportService`, `WebhookService`, `FlowService` bindings +
`CloudFlowRunner` nodes, `ChatToolsService::list_responses`, `RelatedRecords`/`RecordLabel`
resolution, and `FileStorageService::commitResponseFiles` (locates file refs by reading
plaintext answers — see §13).

**Crypto already in the codebase (reuse the discipline, not necessarily the code):**
- Browser: `tweetnacl` NaCl box in `desktopTunnel.ts` — TOFU pinning, directional counter
  nonces, fail-closed opening. Dev origin is `http://formlogic.local` → **`crypto.subtle` is
  unavailable**; `crypto.getRandomValues` works. Any library we add must not require WebCrypto.
- PHP: `ext-sodium` used opportunistically (`SigningService` Ed25519 w/ HMAC fallback,
  `PackService` verify, `AokieCompanionPushService` secretbox). Relay lanes
  (`DesktopAiRelayService` etc.) already store opaque sealed blobs and never decrypt.
- Rust (desktop): `crypto_box 0.9`, `chacha20poly1305 0.10` (XChaCha journal sealing),
  `ed25519-dalek 2`, Credential Manager via `keyring`.
- Cross-language vector discipline exists: `docs/contracts/e2e-envelope-vectors.json` asserted
  by vitest + cargo, regenerated via a `FORMLOGIC_E2E_VECTORS_WRITE=1` env-var pattern. We
  repeat this pattern (including the write-side generation trick) for the storage envelope.

**Useful accident:** because uploads' original filenames live only inside `answers`, and
because backups/trash/exports copy the SQLite file verbatim, *encrypting the `answers` column
at the source automatically converts every derived copy (#5–#8) to ciphertext* — provided the
plaintext never reaches the server in the first place. This drives the central design choice
in §3.

---

## 2. Changes from the original review document (deltas, with reasons)

1. **Sealed box instead of HPKE (RFC 9180)** for wrapping the response DEK to the form
   ingestion key. libsodium's sealed box is natively available in all three languages
   (libsodium-wrappers JS, PHP `sodium_crypto_box_seal`, Rust `crypto_box::seal`), audited, and
   interop-proven. The envelope carries a `wrap` suite identifier so HPKE or a PQ-hybrid KEM
   can be added later as a new registry entry without changing stored data.
2. **SQLCipher de-scoped.** PHP's pdo_sqlite cannot open SQLCipher databases without a custom
   compiled extension — not realistic on the WAMP production stack. In its place, the
   following are **required operational controls** (not suggestions): OS volume encryption on
   the server, encrypted backup storage targets, and encrypted snapshots; plus `VACUUM` + WAL
   truncate after migration (best-effort logical cleanup of free pages — *not* physical
   shredding, and documented as such) and the documented backup retention windows. Revisit
   SQLCipher only if the backend platform changes.
3. **Envelope rides in `responses.answers`** (a reserved marker object, §6) rather than a new
   parallel table. This keeps every existing pipeline — idempotency, grid endpoints, backups,
   trash, restore, account export/import, GDPR export — working untouched, now carrying
   ciphertext. Only code that *interprets* answers needs gating.
4. **Per-form keys, not workspace/collection keys.** FormLogic's unit of data is the form
   (per-form SQLite). The hierarchy is user vault → per-form Form Key (epoched) → per-epoch
   ingestion keypair → per-response DEK.
5. **v1 enables encryption only on forms created private, before first publication** (§3 D8).
6. **`schemaHash` is client-computed against immutable server-stored schema snapshots** (§8) —
   PHP never canonicalizes JSON; it stores and serves exact bytes.
7. **Immutable version chains / signed event logs deferred.** v1 edit = client re-encrypts the
   complete envelope with a fresh DEK under a compare-and-swap `rev` (§6). Rollback/tamper
   evidence chains are a Phase 8 hardening item, stated honestly in the threat model until then.
8. **Blind indexes omitted from v1** (confirmed recommendation).
9. **Separate vault passphrase** (confirmed recommendation); OPAQUE single-password UX is a
   possible later phase, never a v1 blocker.
10. **Crypto worker from day one, honest about its limits** — hygiene and jank-avoidance, not
    an XSS boundary; §14 carries the real mitigations.

---

## 3. Decisions locked

| # | Decision | Choice |
|---|----------|--------|
| D1 | Product surface | **"Private form"** — a per-form property. Badge + explainer in builder and viewer. Never a silent global switch. |
| D2 | Browser-only operation | Permanent release gate. Desktop is never required. (Desktop becomes an *optional* grant target in P7 via its existing X25519 identity.) |
| D3 | Crypto library | **libsodium** everywhere: `libsodium-wrappers-sumo` (browser, lazy-loaded WASM, works on the http dev origin), PHP `ext-sodium` (hard requirement for private mode — fail closed, no fallbacks), Rust RustCrypto equivalents later (P7) pinned by shared vectors. |
| D4 | Vault | Separate vault passphrase; Argon2id (`crypto_pwhash_ALG_ARGON2ID13`; opslimit/memlimit stored per-vault, upgrade-only); UMK rewrap on passphrase change. |
| D5 | Recovery | Recovery kit (§5 format) is **mandatory at vault creation**. Organization recovery keys deferred to P5. |
| D6 | Server behavior on private forms | Fail closed with typed error **`private_form_encrypted`** for every content-dependent server feature (§9 matrix). No silent degradation. |
| D7 | Search | v1 = client-side decrypt-and-filter with **progressive full fetch** (§10). No blind indexes, no persisted plaintext index. |
| D8 | Eligibility & irreversibility | Private is chosen **at creation of a standalone form** (P3) that has `ever_published_at IS NULL` and passes the §9.1 preflight atomically. **Private mode is irreversible in v1**: no disable toggle; clone yields either a new private form (fresh keys, no data) or a schema-only plain form; imports preserve privacy or refuse; stale clients cannot write plaintext (envelope is mandatory forever). Legacy migration is Phase 8. |
| D9 | Beta gating | `PRIVATE_FORMS` public-config flag (existing `/api/health` closure pattern) until Phase 5 completes. Demo account: disabled (`demo_readonly`). |
| D10 | External claim | No public "zero-knowledge" language before the Phase 8 independent review. UI copy until then: "End-to-end encrypted (beta)". |
| D11 | Rotation policy | Routine/scheduled rotation → 7-day grace. Member removal → **strict by default** (grace only via an explicit "weakens revocation" override). Suspected compromise → strict, always. §11. |

---

## 4. Architecture overview

```
Anonymous submitter browser                    Owner/team browser
  form manifest (signed, verifiable)             vault passphrase → Argon2id → PUK
  DEK = random 32B                               PUK unwraps UMK → unwraps X25519/Ed25519 keys
  ct = XChaCha20-Poly1305(DEK, answers, AAD)     grant (fk_epoch e) unwraps Form Key FK[e]
  wrappedDek = crypto_box_seal(DEK, ingest_pk)   FK[e] unwraps ingestion sk (per ingest epoch)
        │                                        ingestion sk opens wrappedDek → DEK → answers
        ▼                                                       ▲
  POST /api/forms/{id}/responses {envelope} ──►  per-form SQLite: │ responses.answers = envelope
                                                (ciphertext; backups/trash/exports inherit it)
```

The PHP API keeps: authentication, authorization to ciphertext, publication state, rate limits
(30/60s submission limiter unchanged), idempotency (`payload_hash` over ciphertext; the
idempotency key stays exactly where today's API carries it — a root-level body field read by
`ResponseController::create`), size caps (§6), envelope *structural* validation, storage,
listing/pagination by non-content columns, and trash/backup/export of ciphertext. It never
holds a content key.

---

## 5. Cryptographic profile (exact constructions)

All byte fields are standard base64 (with padding) in JSON — matching the tunnel's existing
convention (`bytesToBase64`). All identifiers used in AAD strings are ASCII `[a-zA-Z0-9_-]`
(validated by regex before use), so the pipe-delimited AAD needs no escaping. Absent optional
AAD components are the literal `-`.

| Purpose | Construction | Notes |
|---|---|---|
| Passphrase → PUK | Argon2id (`crypto_pwhash`, `ALG_ARGON2ID13`) | Per-vault random 16 B salt; initial params `memlimit=64 MiB, opslimit=3`; **no parallelism parameter** (libsodium does not expose one); params stored on the vault row; server rejects downgrades |
| UMK wrap | XChaCha20-Poly1305 AEAD under PUK | AAD `flvault-umk:1|<userId>` |
| Private key bundle | XChaCha20-Poly1305 under UMK | Plaintext `{"v":1,"x25519Sk":b64,"ed25519Sk":b64}`; AAD `flvault-bundle:1|<userId>`. **After unlock the client re-derives both public keys and compares to stored `x25519_pk`/`ed25519_pk`; mismatch = fail closed (`vault_corrupt`)** |
| Recovery key | 32 random bytes | Display: `FLRK1-` + 52 unpadded RFC 4648 Base32 chars in groups of 4 + a final 4-char checksum group (first 20 bits of SHA-256 of the key, Base32). Parser strips grouping/hyphens, verifies prefix + checksum before any KDF work |
| Recovery wrap | XChaCha20-Poly1305 under key = `crypto_kdf_derive_from_key(recoveryKey, 1, "flrecov1")` | Second wrapper of the UMK; AAD `flvault-umk-recovery:1|<userId>` |
| Form Key (FK) grant | `crypto_box_seal(FK[e], member_x25519_pk)` + Ed25519 grant signature (§11) | 32 B FK → 80 B sealed blob; grant row labeled with `fk_epoch` |
| Ingestion secret wrap | XChaCha20-Poly1305 under FK[e] | AAD `flingest:1|<formId>|<ingestEpoch>|<fkEpoch>` |
| Response DEK wrap | `crypto_box_seal(DEK, ingestion_pk)` | 80 B. **The only DEK wrap in v1** (see §6.1 for the deferred multi-wrapper evolution) |
| Response content | XChaCha20-Poly1305, fresh random 24 B nonce, fresh 32 B DEK per write | AAD §6 |
| Attachments (P4) | `crypto_secretstream_xchacha20poly1305`, 256 KiB chunks, per-file DEK | §13; TAG_FINAL required |
| Signatures | Ed25519 (`crypto_sign_detached`) | Manifests + grants; canonical strings in §8/§11 |
| Randomness | `sodium.randombytes_buf` only | Never `generateId()`/`Math.random` for key material (its fallback is non-CSPRNG) |

Suite registry (strings pinned in envelopes/rows; unknown values rejected, never skipped):
- `content: "xchacha20p1305.1"`
- `wrap: "sealedbox-x25519xsalsa20p1305.1"` — named for what libsodium's sealed box actually
  is on the wire: ephemeral X25519 + `crypto_box` (XSalsa20-Poly1305) with nonce =
  BLAKE2b(epk‖rpk). **Sealing is randomized by construction** (fresh ephemeral keypair per
  seal) — test methodology in §16-P1 accounts for this.
- `kdf: "argon2id13.1"`

Adding a suite is an additive registry + vector change, never a mutation of existing meanings.

---

## 6. Envelope specification

**Request shapes (the only ones):**

```
create:  POST … {"envelope": {…}, "idempotencyKey": "…", "attachmentClaims": […]?}
update:  PUT  … {"envelope": {…}, "expectedRev": 2, "idempotencyKey": "…"}
```

The server stores the envelope object serialized as the `responses.answers` column value.
There is no `answers` field in private-mode requests; its presence is a validation error.
**Dispatch order:** the private-form branch is taken at the *top* of
`ResponseController::create/update`, `AppPublicController::createResponse`, and every
batch/sync drain path that funnels into them — before `sanitizeSubmittedAnswers`,
`normalizeAnswers`, or any other plaintext-shaped code can touch the body. A plaintext-answers
write to a private form is rejected without ever entering the legacy pipeline (guard test).

```json
{
  "__flenc": 1,
  "recordId": "8f0c4c9e-…",            // client-generated UUIDv4; becomes the response row id
  "rev": 1,                             // compare-and-swap revision, starts at 1
  "keyId": "fik_…",                     // form_ingestion_keys.id
  "epoch": 1,                           // ingestion epoch
  "content": "xchacha20p1305.1",
  "wrap": "sealedbox-x25519xsalsa20p1305.1",
  "schemaVersion": 3,                   // immutable form_schema_versions.version
  "schemaHash": "hex64",                // SHA-256 of that version's exact stored bytes
  "attachments": ["fil_…", "fil_…"],    // optional; opaque stored file ids, sorted (P4)
  "wrappedDek": "b64(80B)",
  "nonce": "b64(24B)",
  "ct": "b64"
}
```

- **AAD** for `ct`:
  `flenc:1|<formId>|<recordId>|<rev>|<keyId>|<epoch>|<schemaVersion>|<schemaHash>|<attHash>`
  where `attHash` = SHA-256 hex of the sorted attachment ids joined by `,`, or `-` when there
  are none. Any tamper with the plaintext routing fields (including the attachment list or a
  replayed old revision) makes the owner-side decrypt fail.
- **Inner plaintext** (owner-side JSON, never seen by the server):
  `{"v":1,"answers":{...},"meta":{"completionTime":n,"language":s,"clientAt":iso},"files":{<fieldId>:[{fileId,name,mime,size,sha256}]}}`.
  Filenames, signature dataURLs, and file metadata live only here.
- **Compare-and-swap:** create ⇒ `rev=1`. Update ⇒ one **atomic conditional update** — never
  read-then-write:
  `UPDATE responses SET answers=:env, updated_at=:now WHERE id=:id AND
  json_extract(answers,'$.rev') = :expectedRev` (single statement; P4 wraps it in the same
  SQLite transaction as claim commits). Zero affected rows → 409 `revision_conflict` (current
  `rev` fetched only for the error payload). The new envelope must carry
  `rev == expectedRev + 1`.
- **Server structural validation** (`EnvelopeValidator`, no decryption). Duplicate JSON keys
  are invisible after PHP `json_decode`, so the raw body is parsed with a **reviewed
  duplicate-aware parser** (`seld/jsonlint`, `DETECT_KEY_CONFLICTS`) at BOTH the request root
  and the envelope object; the fuzz corpus (§17) runs against it. Then: `__flenc===1`; suite
  strings in registry; `recordId` UUIDv4 and unique; `rev` rules above; the tuple
  `(keyId, epoch, schemaVersion, schemaHash)` must match a stored **manifest row** that is
  currently acceptable (§8 — this single rule covers key state, grace, and schema-version
  skew together); base64 decodes with exact lengths (nonce 24, wrappedDek 80); `attachments`
  ids well-formed, ≤ the form's file-field capacity, claims 1:1 (§13); **no other keys**; size
  caps below. Any failure → 400 `envelope_invalid` (or the specific typed code), nothing
  stored.
- **Size caps:** stored envelope (the serialized JSON) ≤ existing `MAX_ANSWER_BYTES` (2 MB).
  Because base64 adds ~33%, this yields an **effective inner-plaintext budget of ≈1.4 MB** —
  documented in the product limits page, enforced client-side with a friendly error before
  sealing, and asserted by a validator cap of `ct` ≤ 1.9 MB base64.

### 6.1 Format evolution (explicitly NOT in v1)

A future `__flenc: 2` replaces the flat `wrap`/`wrappedDek` pair with a structured wrapper —
sketch (not frozen, not implemented, no v1 code may emit or accept it):

```json
"dekWrap": { "suite": "…", "keyId": "…", "keyEpoch": 1, "blob": "b64", "nonce": "b64"? }
```

possibly as an array (multi-wrapper: ingestion + FK adoption with its own `fkEpoch`, nonce,
and validation rules). DEK adoption is deferred until then (§11). This keeps v1 frozen,
consistent, and single-suite.

Cross-language vectors: `docs/contracts/e2ee-envelope-vectors.json` + sealed-fixture files
(§16-P1) with a malformed corpus (bad tag, wrong AAD per-field mutation, truncated ct, wrong
lengths, duplicate keys in raw JSON at both levels, unknown suite, plaintext smuggling, rev
replay).

---

## 7. Key hierarchy and server schema (MySQL, additive)

```
vault passphrase ──Argon2id──► PUK ──► UMK ──► {X25519 sk, Ed25519 sk}
recovery key ────KDF─────────►     ──► UMK          │ (sealed-box grant @ fk_epoch)
                                                    ▼
                                       Form Key FK[e]  (32B, per form, EPOCHED)
                                                    │ (XChaCha wrap, labeled fk_epoch)
                                                    ▼
                                     ingestion X25519 sk (per form × ingest epoch)
                                                    │ (sealed box)
                                                    ▼
                                        response DEK (per response write)
```

```sql
CREATE TABLE user_vaults (
  user_id VARCHAR(36) PRIMARY KEY, version INT NOT NULL DEFAULT 1,      -- optimistic lock
  kdf VARCHAR(32) NOT NULL,                    -- 'argon2id13.1'
  kdf_salt VARBINARY(16) NOT NULL,
  kdf_memlimit INT UNSIGNED NOT NULL, kdf_opslimit INT UNSIGNED NOT NULL,
  wrapped_umk VARBINARY(128) NOT NULL,         -- nonce||ct
  wrapped_umk_recovery VARBINARY(128) NULL,
  enc_key_bundle VARBINARY(512) NOT NULL,      -- nonce||ct of the private-key bundle
  x25519_pk VARCHAR(64) NOT NULL, ed25519_pk VARCHAR(64) NOT NULL,
  created_at DATETIME, updated_at DATETIME);

-- forms table (existing) gains:
--   ever_published_at DATETIME NULL  -- durable; set on FIRST publish, never cleared.
--   Migration backfills ever_published_at = NOW() for ALL existing forms, so v1 private
--   forms are strictly post-feature creations.

CREATE TABLE form_encryption (
  form_id VARCHAR(36) PRIMARY KEY, mode ENUM('private') NOT NULL,
  current_ingest_epoch INT NOT NULL DEFAULT 1,
  current_fk_epoch INT NOT NULL DEFAULT 1,
  state ENUM('enabling','active','trashed') NOT NULL DEFAULT 'active',
  enabled_by VARCHAR(36) NOT NULL, enabled_at DATETIME);
  -- NO disable path exists (D8): no state value, no endpoint, no import flag can revert
  -- 'private'. Enforced in code review + a dedicated test.
  -- 'enabling' (added post-review): durable enable-in-flight marker. The enable endpoint
  -- writes it FIRST (PK insert is the gate; a stale marker >5 min is retaken once, so a
  -- crash never wedges the form), then preflights + writes keys/manifest/grant and flips
  -- to 'active' in ONE transaction under a forms-row lock. While 'enabling', submit
  -- (plaintext AND envelope), publish/field saves and integration mutations fail closed
  -- with 409 encryption_enabling; plaintext inserts are atomic conditional writes that
  -- re-check the marker at write time. A second concurrent enable gets
  -- private_enable_blocked with reason enable_in_progress.

CREATE TABLE form_schema_versions (
  id VARCHAR(40) PRIMARY KEY, form_id VARCHAR(36) NOT NULL, version INT NOT NULL,
  schema_json MEDIUMBLOB NOT NULL,             -- EXACT bytes; served verbatim, never re-encoded;
  schema_hash CHAR(64) NOT NULL,               --   BLOB so charset/collation can never mangle it
  created_at DATETIME,
  UNIQUE KEY uq_form_version (form_id, version));

CREATE TABLE form_ingestion_keys (
  id VARCHAR(40) PRIMARY KEY, form_id VARCHAR(36) NOT NULL, epoch INT NOT NULL,
  public_key VARCHAR(64) NOT NULL,
  wrapped_secret VARBINARY(128) NOT NULL,      -- under FK[fk_epoch]
  fk_epoch INT NOT NULL,                       -- WHICH Form Key epoch wraps wrapped_secret
  state ENUM('active','retiring','retired') NOT NULL DEFAULT 'active',
  accept_until DATETIME NULL,                  -- retiring: server accepts until this instant
  created_at DATETIME,
  UNIQUE KEY uq_form_epoch (form_id, epoch));

CREATE TABLE form_manifests (                  -- APPEND-ONLY; one row per signed manifest
  id VARCHAR(40) PRIMARY KEY, form_id VARCHAR(36) NOT NULL,
  manifest_seq INT NOT NULL,                   -- per-form monotonic
  key_id VARCHAR(40) NOT NULL, ingest_epoch INT NOT NULL,
  schema_version INT NOT NULL, schema_hash CHAR(64) NOT NULL,
  content_suite VARCHAR(48) NOT NULL, wrap_suite VARCHAR(48) NOT NULL,
  signer_key_id VARCHAR(16) NOT NULL,          -- hex8 fingerprint prefix
  signer_pk VARCHAR(64) NOT NULL,              -- the Ed25519 verification key ITSELF
  signed_bytes MEDIUMBLOB NOT NULL,            -- exact canonical bytes that were signed
  signature VARBINARY(64) NOT NULL,            -- server CANNOT regenerate this
  created_at DATETIME NOT NULL, expires_at DATETIME NULL, superseded_at DATETIME NULL,
  UNIQUE KEY uq_form_seq (form_id, manifest_seq));

CREATE TABLE form_key_grants (
  id VARCHAR(40) PRIMARY KEY, form_id VARCHAR(36) NOT NULL, user_id VARCHAR(36) NOT NULL,
  fk_epoch INT NOT NULL,
  wrapped_key VARBINARY(128) NOT NULL,         -- sealed box of FK[fk_epoch] to grantee x25519_pk
  wrap_suite VARCHAR(48) NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'owner',   -- v1: 'owner'; P5 adds member roles
  grantor_user_id VARCHAR(36) NOT NULL,
  grantor_key_id VARCHAR(16) NOT NULL,         -- fingerprint of the signing key used
  grantee_pk VARCHAR(64) NOT NULL,             -- SNAPSHOT of the recipient X25519 key sealed to
  sig_version SMALLINT NOT NULL DEFAULT 1,     -- canonical-string version
  signature VARBINARY(64) NOT NULL,            -- Ed25519 over the §11 canonical string
  expires_at DATETIME NULL,
  state ENUM('active','revoked','trashed') NOT NULL DEFAULT 'active', created_at DATETIME,
  UNIQUE KEY uq_form_user_epoch (form_id, user_id, fk_epoch));
```

Rules: key/schema/manifest rows are never hard-deleted while the form exists or sits in trash
(`state='trashed'` when the form is trashed; restored with it; purged when trash expires —
wire into `TrashService::capture`/restore/purge). The server never stores FK, UMK, DEKs, or
any secret key unwrapped. All rows above are included in `AccountBackupService` exports
(ciphertext/public material only). **Import/restore must preserve `user_id`, `form_id`,
`recordId`, key ids and epochs byte-for-byte** — they are baked into AADs; an import that
remints ids must refuse private forms (typed error; asserted by the P3 restore drill).

---

## 8. Public submission protocol

**Manifest.** `GET /api/public/forms/{id}` gains (served with `Cache-Control: no-store` for
private forms):

```json
"encryption": {
  "mode": "private", "keyId": "fik_…", "epoch": 1,
  "publicKey": "b64(32B)",
  "content": "xchacha20p1305.1", "wrap": "sealedbox-x25519xsalsa20p1305.1",
  "schemaVersion": 3, "schemaHash": "hex64",
  "signerKeyId": "hex16", "signerPk": "b64(32B)",
  "expiresAt": null,
  "sig": "b64(64B)"
}
```

`sig` = Ed25519 over the canonical string
`flmanifest:1|<formId>|<keyId>|<epoch>|<publicKey>|<content>|<wrap>|<schemaVersion>|<schemaHash>|<signerKeyId>|<expiresAt|->`,
signed by the **owner's vault Ed25519 key** at enable/rotation/schema-publish time. Each
signing appends an immutable `form_manifests` row storing the exact signed bytes + signature +
`signer_pk` (§7); the served manifest is the latest non-superseded row. Consequence, stated
plainly: publishing field changes to a private form requires the owner's vault unlocked (a new
`form_schema_versions` row is cut and a new manifest signed in the same action).

**Verification honesty.** Any browser can now *mathematically* verify `sig` against the
included `signerPk`. For an anonymous first-time submitter, both still arrive from the same
server, so verification proves internal consistency, not server honesty; the strong checks are
owner-side (the owner's browser asserts `signerPk` equals its own vault `ed25519_pk` and
alarms on mismatch) and submitter-side pinning of `signerPk` per form (TOFU, same posture as
the tunnel pins — a changed signer for a known form is refused loudly).

**Envelope acceptance is manifest-based** (single rule, no clock-skew mismatches): the
envelope's `(keyId, epoch, schemaVersion, schemaHash)` must exactly match some
`form_manifests` row for the form, AND that row's ingestion key must be `active`, or
`retiring` with `now < accept_until`. Superseded manifests therefore remain acceptable exactly
as long as their key epoch does — schema-version grace and key grace are the same window by
construction (7 days routine; zero in strict mode, §11).

**Schema versions.** `schema_json` is the exact serialized field-definition bytes (fields
incl. options, validation, conditional logic — everything rendering depends on). The
submitting client re-hashes the served bytes and refuses on mismatch with the manifest. The
builder's "view schema version" surface renders **the exact stored snapshot** (not the live
form) so what's hashed is what's shown. Owner-side deep verification (recompute the hash from
stored bytes, compare against decrypted responses) is client-side only — PHP never
canonicalizes.

**Submit flow (client):** run existing QuickJS form logic for UX (calculated/hidden values are
folded into `answers` *pre-encryption*; the server no longer re-derives them — documented trust
change) → verify manifest (sig, pin, schema hash) → mint `recordId`, DEK, nonce → seal with
the §6 AAD → `POST {envelope, idempotencyKey}`. Offline: the envelope (not plaintext) is what
enters `offlineQueue`/background-sync — plaintext never reaches client persistence for private
forms. Queued envelopes carry their manifest tuple; delivery after acceptability lapses fails
with typed `key_epoch_retired` and honest UX (§11).

**Server (`ResponseService::createResponse`) private-mode branch** (reached via the top-of-
controller dispatch, §6): validate envelope → store envelope JSON string as
`responses.answers`, row id = `recordId` → `responses.metadata` = `{"submittedByUserId":…}`
**only** (keeps the own-records expression index working; no UA/referrer/language/
completionTime) → `response_metadata` mirror keeps `ip_address` for abuse (30-day sweep, §12)
with `user_agent`/`completion_time` NULL → **skip**: sanitize/normalize of answers,
`applyCalculatedFields`, onSubmit script, `computed`, `tags`, content webhooks,
`form.submitted` flow payloads. Rate limiting, idempotency, publication checks unchanged.

---

## 9. Server behavior in private mode

### 9.1 Enable lifecycle (atomic preflight — P3 entry checklist)

`POST /api/forms/{id}/encryption` runs **one transaction** that re-verifies ALL of the
following at commit time (any failure → typed `private_enable_blocked` with a `reasons[]`
array; nothing partially enabled):

1. `forms.ever_published_at IS NULL` (durable publication history — never the current
   published flag; backfilled NOW() for all pre-feature forms, §7);
2. zero responses (per-form SQLite count AND `response_metadata` mirror count);
3. no pending uploads (`storage/uploads/<formId>/.pending` empty);
4. no `webhooks` rows for the form (**unpublished forms can have webhooks — check, don't
   assume**);
5. no flow bindings or flow nodes referencing the form; no report/widget specs, public
   screens, or custom-screen references; no `response_links` rows;
6. no related-record coupling in either direction: the form has no `linked_record` fields,
   and no other form's `linked_record`/matchField configuration targets it;
7. field types all within the P3 allowlist — **no `file_upload`/camera fields until P4**,
   no `linked_record`; `hidden`/`calculated` allowed (client-computed);
8. standalone form only in P3 — not attached to any app (`app_forms`), no app bindings
   (app-runtime private forms arrive with grants in P5);
9. requester's vault exists and is unlocked-capable; server `ext-sodium` present; demo and
   acting-as refused.

The same transaction writes `form_encryption` + FK grant + ingestion key + schema version +
manifest rows. Post-enable invariants: adding a blocked feature to a private form (webhook,
flow binding, linked_record field, file field pre-P4, app attachment pre-P5) is refused at
that feature's creation path with `private_form_encrypted` — the §9.2 matrix is enforced on
*both* ends. Private mode is irreversible (D8).

**Post-review hardening (implemented 2026-07-22, supersedes where it conflicts):**
- Enable is two-phase with the durable `enabling` marker described above; concurrent submits
  lose to an atomic conditional write that re-checks the marker at insert time.
- **Atomic publish:** `PUT /api/forms/{id}` accepts `encryptionSchema {schema, manifest}`
  applied in the SAME transaction as fields+status; a private form whose fields change while
  (being) published without a valid signed schema fails `409 manifest_required` with nothing
  saved. The UI signs first — "published but not re-signed" no longer exists.
- New codes: `encryption_enabling` (409, retryable), `manifest_required` (409),
  `kdf_downgrade` (400 — passphrase change may never lower ops/mem; maxima ops ≤ 10,
  mem ≤ 256 MiB refuse corrupt-browser-freezing params), `encryption_not_restorable`
  (400 — backups restore E2EE material to the SAME account only; cross-account is refused
  whole because wrappers are AAD-bound to the original account id).
- Account erasure transactionally purges all six E2EE tables and verifies zero rows before
  reporting success. Trash restore/purge consumes its recovery ZIP only after the crypto
  lifecycle rows commit in the same transaction. Retired ingestion keys stay served to the
  owner (state gates WRITES only) so historical responses remain decryptable after rotation.

### 9.2 Fail-closed feature matrix

Single source of truth: `FormEncryptionService::isPrivate(formId)` (per-request cached).
Every gate throws typed `private_form_encrypted` (HTTP 400/409) — never returns wrong/empty
results silently.

| Surface | File(s) | Behavior on private form |
|---|---|---|
| answers filters/sort/LIKE (`answersEq/Gte/Lte/PhoneEq`, `ORDER BY json_extract`, search) | `ResponseService` | refuse (UI stops sending them) |
| CSV / SQL-dump / per-field exports | `AppDataExportService`, export routes | refuse; sqlite-bundle + account-backup exports allowed (ciphertext) |
| Webhook create / dispatch | `WebhookService`, routes | creation refused; enable preflight guarantees none pre-exist (§9.1) |
| Flow bindings on `form.submitted` + cloud nodes reading answers | `FlowService`, `CloudFlowRunner` | binding creation refused v1; `formlogic_list_responses`/`update_response` nodes refuse private forms |
| Reports/widgets aggregating answers | `ReportService`, `AppReportService` | private forms excluded; UI renders a "Private form — open records to view" placeholder |
| MCP + chat tools reading/writing records | `ChatToolsService` | typed refusal (prevents feeding ciphertext to models) |
| Related-record label resolution (`resolve` variants) | `RelatedRecords`, `RecordLabel` | n/a by preflight (no links can exist); defensive refusal kept |
| Controller PATCH-merge on update | `ResponseController` | bypassed; complete envelope + atomic `expectedRev` CAS only (§6) |
| Server-side answer validation / required-field enforcement | `ResponseService` | not possible; documented trust change (client validates; abuse controls remain) |
| File claim/commit via plaintext answers | `FileStorageService::commitResponseFiles` | replaced by the envelope `attachments` list path (§13); file fields blocked until P4 |
| Batch/sync drains (offline queue delivery, native bridge sync) | controllers feeding `createResponse` | same top-of-controller dispatch; envelope-only |
| Demo mode | `api.ts` `_demoMode`, backend demo guards | private mode disabled |
| Admin acting-as | `actingRoute()` default-deny + backend | vault + private-form record surfaces denied (extend existing deny list) |

Non-content operations stay fully server-side and unchanged: list/paginate by
`submitted_at`/`status`/id, own-records scope, delete, trash/restore, account backup/restore,
GDPR export (ciphertext), response counts.

---

## 10. Authenticated app: vault, worker, decrypt pipeline

**Crypto worker** (`ui/src/lib/crypto/worker.ts` + `cryptoClient.ts` request/response façade,
mirroring the `formlogic.worker.ts` pattern): lazy-loads `libsodium-wrappers-sumo`; owns all
long-lived secret material in worker memory only. API: `unlock`, `lock`, `status`,
`createVault`, `changePassphrase`, `recoveryUnlock`, `enableFormEncryption` (keygen + wraps +
manifest sign), `publishSchemaVersion` (re-sign), `rotateKeys` (§11), `sealResponse`,
`openResponses` (batched), `sealFile`/`openFile` (P4). Unlock verifies re-derived public keys
(§5).

**Plaintext honesty:** decrypted values necessarily enter main-thread memory (React props/DOM)
while displayed. The guarantee is **no plaintext at rest and none surviving lock**: on lock —
`worker.terminate()` (fresh worker on next unlock), a **vault-generation counter** increments,
which drops the decrypted LRU, clears any Zustand in-memory state holding decrypted values,
and force-remounts private-data components so React state/DOM are rebuilt empty. Lock/logout
propagates across tabs via a `BroadcastChannel('fl-vault')` (all tabs lock together).
Auto-lock after 30 min idle (configurable) + explicit lock + lock on logout
(`authStore.clearUserSessionData` hook — which today does NOT clear IndexedDB/uiCache; the
vault path must not rely on it for secrets, and holds none outside the worker anyway).

**Never persisted:** PUK/UMK/private keys/FK/DEKs, decrypted answers. Decrypted rows live in a
non-persisted in-memory LRU (cap 2000 *viewed* records) keyed by `recordId`+`rev`. The
existing Zustand persist stores must never receive decrypted content (`formlogic-responses`
persist stays API-mode empty; local-storage-mode is incompatible with private forms — refuse).

**Unlock UX:** vault setup wizard (passphrase + mandatory recovery-kit confirmation) under
Settings → Security; `VaultUnlockDialog` on first private-data access; visible locked/unlocked
chip in the app shell. Locked state renders rows as "🔒 Encrypted — unlock to view", never
spinners pretending to load.

**Read pipeline:** `useDecryptedResponses(formId, rows)` hook wraps the existing fetches in
`FormResponses.tsx`, `FormResponseView.tsx`, `recordDisplay.tsx`, `renderEditField.tsx`
(P3 standalone surfaces; `AppRecords`/`AppDataTable` join at P5 with app-runtime support).
Server `search`/`sort`-by-answer params are never sent for private forms.

**Search/filter/sort (D7):** progressive full fetch — page through all permitted rows,
decrypt in worker batches, **retain only matches** (searching 5,000 rows does not pin 5,000
decrypted rows in memory; the viewed-record LRU stays at 2,000), with a progress indicator and
a hard cap (default 5,000 rows, configurable). Under the cap the UI states "Searched all N
records"; over it, a visible "Searched first 5,000 of N — refine or raise the limit" banner.
No silent partial results.

**CSV export:** always a full fetch of ALL rows (no search cap), streaming decrypt → CSV
assembly with progress; cancelling mid-export requires a confirm and names the file
`…-partial.csv`. Replaces the server export button for private forms.

**"Remember this device"** (optional, P2+): ships **only together with** a device inventory +
revocation UI (list of remembered devices, server-side deletion of the wrapped blob
registration) — never as a bare convenience toggle. Secure contexts only — wraps the UMK
under a non-extractable WebCrypto AES-GCM key in IndexedDB. On the http dev origin the
feature is hidden (no plaintext-key fallback).

**Bundle budget:** sodium WASM is dynamically imported only when a private form is rendered or
the vault is touched — public non-private forms load zero crypto. Respect
`check-bundle-budget.mjs`.

---

## 11. Teams, grants, rotation, revocation (P5 design; tables + epochs from day one)

**Grant integrity.** `signature` = Ed25519 by the grantor over
`flgrant:1|<grantId>|<formId>|<fkEpoch>|<grantorUserId>|<granteeUserId>|<sha256(grantee_x25519_pk)>|<sha256(wrapped_key)>|<wrapSuite>|<role>|<expiresAt|->`.
The grant row persists the full verification context (`wrap_suite`, `grantor_key_id`,
`grantee_pk` snapshot, `sig_version` — §7) so verification never depends on mutable current
state. Binding the hash of `wrapped_key` means a server cannot swap the sealed FK blob under
an existing signature; binding the grantee key fingerprint means it cannot redirect the grant
to a different keypair. The grantee's browser verifies the signature against the grantor's
published `ed25519_pk` before trusting FK. The owner's own grant is created (self-signed) at
enable time.

**Key authentication is reciprocal (P5):** the grantor verifies the grantee's key fingerprint
out-of-band, AND the grantee verifies the grantor's signing key the same way (safety-number
style: one short combined fingerprint both sides compare), with per-form signer pinning as the
ongoing check — same TOFU + explicit-verify posture as the desktop tunnel pins. Without this,
a malicious server could substitute keys in either direction at grant time.

**Membership removal / compromise rotation — the FK-epoch procedure:**
1. An authorized client (owner) mints **FK[e+1]** and a **new ingestion keypair** (epoch i+1 —
   required because the leaver may have unwrapped ingestion secrets while authorized).
2. It unwraps every ingestion secret it can read, **re-wraps all of them under FK[e+1]**
   (updating each row's `wrapped_secret` + `fk_epoch`), seals FK[e+1] to **each remaining
   member only** (new signed grant rows at `fk_epoch = e+1`), and marks the leaver's grants
   `revoked`. Because v1 responses are only ever sealed to ingestion keys (§6.1 — no DEK
   adoption), rotation never touches response rows and no record can pin a stale FK epoch.
3. The whole new key-set is submitted in **one atomic endpoint**
   `POST /api/forms/{id}/encryption/rotate` (server applies transactionally; version-checked
   against `current_fk_epoch`/`current_ingest_epoch` so concurrent rotations conflict cleanly).
   A new manifest row is signed in the same action.
4. What removal *cannot* do: make the leaver forget FK[e], ingestion secrets, or plaintext
   they already copied — old ciphertext they already possess stays readable to them. Stated in
   the UI.

**Ingestion key lifecycle (D11):** `form_ingestion_keys.state` ∈ `active | retiring |
retired`.
- **Routine/scheduled rotation:** old epoch → `retiring`, `accept_until = now + 7 days`, so
  offline queues drain (an offline client holds only ciphertext and *cannot rewrap* — it no
  longer has the DEK).
- **Member removal:** **strict by default** — old epoch → `retired` immediately
  (`accept_until = now`). The UI offers a grace override behind an explicit "this lets the
  removed member read submissions that arrive during the grace window" warning.
- **Suspected compromise:** strict, always; no override.
Queued offline submissions to a retired epoch fail with typed `key_epoch_retired` and honest
messaging ("this offline submission can no longer be delivered — the form's keys were rotated;
please re-enter it"). Manifests are `no-store` (§8) so clients pick up new epochs promptly.

**Rotation ≠ passphrase change:** passphrase change rewraps the UMK only; no grants, keys, or
data are touched — guaranteed by the hierarchy.

**DEK adoption: deferred entirely** (v3 change). It returns only with the `__flenc:2`
structured `dekWrap` (§6.1), designed with its own epoch labeling and historical-access rules.
Until then, very old ingestion epochs must be retained (wrapped under the current FK) for as
long as their records exist.

## 12. Metadata minimization & abuse data

Private forms: SQLite `metadata` = submittedByUserId only (§8); `response_metadata` keeps
`ip_address` (abuse/rate-limit forensics) with a **30-day null-out sweep** for private-form
rows via a new `bin/privacy-sweep.php` scheduled with the existing nightly task;
`user_agent`/`completion_time` never written. The server still observes (and this is stated in
the product docs): ciphertext size, submission timestamps, form/app identity, IPs pre-sweep,
access patterns. The public-form abuse posture (rate limiter 30/60s + quotas) is unchanged for
text-only private forms; **file-upload abuse controls are a P4 entry gate** (§13).

## 13. Attachments (P4) — redesigned claim flow

The current pipeline discovers uploaded-file references by reading plaintext answers
(`commitResponseFiles`) — impossible once answers are ciphertext. **P3 blocks file/camera
fields on private forms completely (§9.1); nothing ships until the P4 addendum is appended to
this document and reviewed.** The addendum must pin, at minimum:

- server-generated, server-validated opaque file ids (client never chooses ids);
- one-time claim consumption (a claim token is spent exactly once, atomically);
- atomic response insertion + claim commit in one SQLite transaction (with the §6 CAS);
- exact 1:1 matching between `envelope.attachments` and `attachmentClaims` (either direction's
  surplus is a 400);
- hash roles: the *ciphertext* blob hash for transport/storage integrity checks vs the *inner
  plaintext* sha256 (inside `ct`) for end-to-end verification — never conflated;
- framing (secretstream header/chunk layout), chunk limits, max file size, and browser memory
  budgets for encrypt/decrypt;
- private-file authorization on serve (who may fetch which opaque blob);
- retry semantics and abandoned-upload cleanup (extend the existing `.pending` TTL sweep).

Design already fixed (v2): per-file DEK; `secretstream` 256 KiB chunks, per-chunk AD
`flfile:1|<fileId>|<chunkIndex>`, TAG_FINAL mandatory; multipart + stored names both opaque
`<fileId>.bin`; envelope `attachments` list bound via `attHash` in the AAD; inner `files`
metadata (name, MIME, size, sha256, field mapping) only inside `ct`; serving always
`application/octet-stream` + `attachment` + `no-store`; secretstream truncation/reorder/
duplication detection is **client-side only** — the server knowingly stores unverifiable
ciphertext and a corrupt blob surfaces as `file_corrupt` at decrypt; previews restricted to
passive types (raster images via `<img>` + object URL, plain text) — SVG/HTML/PDF/anything
active is download-only in v1; **abuse entry gate:** per-form + per-IP upload quotas and rate
limits for anonymous encrypted uploads (server cannot content-scan), CAPTCHA/proof-of-work
hook designed even if not enabled.

## 14. Browser code-delivery risk

Moved forward (v3): the following are **P3 gates**, not post-beta work — baseline CSP for the
app shell (document what `wasm-unsafe-eval` etc. the QuickJS/esbuild/sodium WASM loaders
require), telemetry/log exclusion of decrypted values (plus URLs/DOM attributes), and a review
of every renderer that touches decrypted answers (no `dangerouslySetInnerHTML` on answer
content; lint guard). Before dropping the "beta" label additionally: Trusted Types where
supported, dependency lockfile + audit in CI, no third-party scripts in the unlocked app
(already true — keep it a test), multi-tab/storage inspection suite green in CI (§17). A
signed/pinned client (extension or Desktop) is a later assurance tier, never a prerequisite.
An independent XSS/supply-chain-focused review is the Phase 8 gate for any "zero-knowledge"
claim (D10).

## 15. Migration of existing forms (P8, deliberately last)

1. Owner opts a legacy form in; server freezes writes (`409 migrating`). The §9.1 preflight
   items that can apply to a legacy form (webhooks/flows/reports/links removed or migrated)
   must pass first.
2. Owner's browser pages through plaintext rows over TLS, seals each (fresh DEKs, current
   epochs, `rev` seeded fresh), uploads envelopes via a batch endpoint; server swaps
   `answers` → envelope in place preserving row ids, drops `computed`/`tags` rows for migrated
   responses.
3. Verification pass: second read-back decrypts every row; counts + per-row sha256 of inner
   plaintext compared client-side.
4. Server runs `VACUUM` + `wal_checkpoint(TRUNCATE)` on the form DB — **best-effort logical
   cleanup** of free pages and WAL history, not physical shredding (stated as such); the real
   controls are the encrypted-volume requirement (§2.2) and retention expiry below.
5. Plaintext copies age out on documented schedules: nightly backups (7-day default retention),
   trash ZIPs (30 days), a one-time purge of `webhook_deliveries`/`flow_run_logs` rows for the
   form, `response_metadata` sweep per §12. A signed migration-completion record (owner
   Ed25519) is stored.
6. A server-assisted bulk path (server briefly re-handles plaintext it already had) is honest
   and acceptable here; the client-led path stays the default.

---

## 16. Phases, deliverables, gates

Standing gates for every phase (repo standard): backend `phpunit` + `phpstan
--memory-limit=1G`; ui `vitest` + `eslint` + `node scripts/check-pack-screens.mjs` + **`npm run
build`** (the real type gate — bare `tsc --noEmit` validates nothing); no new bundle-budget
regression. New standing gate from P3: the **plaintext canary test** — an integration test
seeds a canary answer through a private form and asserts it appears nowhere in the form SQLite
+ WAL, MySQL dump, logs, or API traces.

### P1 — Crypto core + vectors (no product surface) — MAY BEGIN
- `ui/src/lib/crypto/`: `sodium.ts` loader, `envelope.ts` (seal/open/AAD), `vault.ts` (KDF +
  wraps), unit tests.
- PHP: `EnvelopeValidator` (duplicate-aware parse via `seld/jsonlint` at root + envelope
  levels, structural rules §6); `composer.json` gains `ext-sodium` + `seld/jsonlint` in
  `require`.
- **Vector methodology** (sealed box is randomized — §5 — so no byte-identical seal vectors):
  - `docs/contracts/e2ee-envelope-vectors.json`: deterministic KATs only — Argon2id
    (fixed pass/salt/params), XChaCha AEAD (fixed key/nonce/AAD, per-field AAD mutation
    matrix), `crypto_kdf` derivations, recovery-kit encode/decode incl. checksum.
  - `docs/contracts/e2ee-sealed-js.json`: sealed fixtures **written by vitest** under
    `FORMLOGIC_E2EE_VECTORS_WRITE=1` (fixed recipient keypair, fixed plaintexts), committed,
    **opened by phpunit** → real JS-seal→PHP-open interop.
  - `docs/contracts/e2ee-sealed-php.json`: mirror image, written by a phpunit generator,
    opened by vitest → PHP-seal→JS-open.
  - One full-envelope fixture (sealed once, committed, opened by both) + the malformed corpus.
  - Rust joins the same fixture files at P7.
- **Gate:** all KATs byte-identical across JS/PHP; both sealed-fixture directions open; every
  malformed-corpus case rejected on both sides (incl. duplicate keys at both JSON levels); no
  crypto primitive used outside `ui/src/lib/crypto/` (lint rule / review checklist).

### P2 — Vault + recovery
- MySQL `user_vaults`; `VaultService`/`VaultController`; routes `GET/PUT /api/vault`,
  `POST /api/vault/change-passphrase` (version-checked), acting-as denied.
- Worker + `cryptoClient`; setup wizard w/ mandatory recovery kit (§5 format incl. checksum
  round-trip); unlock dialog (with re-derived-pubkey verification); lock/auto-lock +
  `BroadcastChannel` multi-tab propagation + worker termination on lock; passphrase change;
  recovery unlock. ("Remember this device", if built now, includes device inventory +
  revocation per §10 — otherwise it slips to a later phase whole.)
- **Gate:** server cannot recover a test vault without passphrase/recovery kit; passphrase
  change rewraps only (vault row diff proves no data touched); KDF params round-trip and
  refuse downgrade; a mistyped recovery code is caught by checksum before any KDF work;
  corrupted bundle (pubkey mismatch) fails closed; lock in one tab locks all tabs and
  terminates workers; unlock works on Safari/iOS + Firefox + Chromium and a low-memory
  Android profile (64 MiB WASM).

### P3 — Private forms pilot (standalone forms only) — requires §9.1 re-verified at entry
- MySQL `form_encryption` / `form_schema_versions` / `form_ingestion_keys` /
  `form_manifests` / `form_key_grants` + `forms.ever_published_at` (backfill NOW() for all
  existing forms); `FormEncryptionService`; atomic enable endpoint w/ the full §9.1 preflight;
  schema-version cutting + manifest signing on enable and on field publish; manifest in the
  public form payload (`no-store`), submitter-side signer pinning.
- Client: builder "Private form" choice at creation + explainer; submit-path sealing
  (FormResponse.tsx, offline queue receives envelopes); owner decrypt pipeline (§10 P3
  component list); progressive-fetch search/filter + full-fetch CSV; locked-state UI;
  vault-generation remount on lock; `rev` CAS on edit with conflict UX.
- Server: top-of-controller private dispatch (before any sanitation, incl. batch/sync drains);
  §9.2 gate matrix; §8 storage branch; §12 metadata handling + privacy sweep; trash/restore
  key/manifest-row lifecycle; import-id-preservation guard (§7).
- Hardening (v3): baseline CSP, telemetry exclusions, decrypted-renderer review (§14).
- **Gate:** canary test green; two browsers (owner via vault) decrypt; DB admin (direct
  SQLite/MySQL inspection) cannot; every §9.1 precondition individually violated → enable
  blocked with the right reason; every §9.2 surface returns `private_form_encrypted`
  (matrix-driven phpunit test); plaintext-answers write to a private form rejected before
  sanitation (dispatch-order test); stale-`rev` concurrent edit → 409 via the atomic UPDATE
  (no read-then-write in the diff); offline submit queues ciphertext only; schema edit → new
  version row + new manifest row, historical responses still verify, superseded-manifest
  acceptance follows key grace exactly; storage-inspection suite (real IndexedDB, CacheStorage,
  Workbox queues, local/sessionStorage, SW cache bodies) finds no plaintext after
  submit+view+lock; account backup → restore drill preserves ids and decrypts; id-reminting
  import refuses; demo + acting-as refusals tested.

### P4 — Attachments — starts only after the §13 addendum is appended and reviewed.
**Gate:** file canary (bytes + original filename) absent server-side incl. stored names;
tampered/truncated/reordered blobs fail decrypt (`file_corrupt`); claim double-spend refused;
claim/list mismatches (both directions) rejected; response insert + claim commit proven
atomic under injected failure; previews restricted to the passive allow-list; quotas/rate
limits enforced for anonymous uploads.

### P5 — Teams, rotation, revocation; app-runtime private forms.
**Gate:** with default (strict) removal, the revoked account — replaying its old FK[e],
grants, and any retained ingestion secrets against new rows — cannot decrypt any
post-rotation submission; with the explicit grace override, the UI warning is shown and
`accept_until` bounds acceptance exactly; remaining members read old + new data with only
their new grant; concurrent rotations conflict cleanly (atomic endpoint); reciprocal
fingerprint verification shipped; app-runtime decrypt surfaces (`AppRecords`/`AppDataTable`)
join the pipeline.

### P6 — Private processing. **Minimum committed scope (decided now):** a metadata-only
trigger queue (form/response ids + event name, zero content); a browser flow-runner that
decrypts, runs the existing QuickJS flow graph client-side, and writes results back only as
new envelopes; client-computed reports for private forms; a per-form selective-disclosure
record (explicit, audited) as the only path by which any webhook/AI integration can ever see
private content. Full design lands as an addendum when P5 is done.

### P7 — Desktop/Aokie alignment (grant FK to the desktop's existing X25519 identity as an
optional worker; Rust joins the shared fixtures; Aokie private-form targets). Own doc; aokie
repo untouched until then.

### P8 — Legacy migration (§15) + hardening (§14 completion, rollback/tamper evidence) +
independent review → only then any "zero-knowledge" language (D10).

---

## 17. Test plan additions (beyond per-phase gates)

- Property tests: envelope round-trip; AAD mutation matrix (every field flip — incl. `rev`,
  `schemaVersion`, `attHash` — must fail decrypt).
- Duplicate-key corpus + fuzzing against the jsonlint-based validator (dupes at request root,
  envelope level, and nested positions that `json_decode` silently collapses).
- Nonce/DEK uniqueness assertions in the worker (dev builds).
- Vault concurrency: two tabs, stale `version` PUT → 409; response edit CAS races (two
  concurrent atomic UPDATEs — exactly one wins).
- Enable-preflight suite: each §9.1 item individually violated → blocked with that reason;
  race tests (webhook added concurrently with enable → one side loses cleanly).
- Rotation suite: leaver-replay (P5 gate), strict-vs-grace boundary at `accept_until`,
  manifest-based acceptance (schema grace ≡ key grace), atomic-rotate conflicts.
- Multi-tab: lock in tab A → tab B locked, worker terminated, decrypted DOM remounted empty.
- Storage inspection (vitest + fake-indexeddb AND a Playwright pass over the real browser):
  IndexedDB, CacheStorage, Workbox background-sync queue bodies, localStorage, sessionStorage,
  service-worker caches — no plaintext after submit + view + lock.
- Restore drills: account backup export → import on clean install → ids preserved → same vault
  decrypts; import path that would remint ids refuses private forms.
- Trash → restore → decrypt; trash purge removes key + schema + manifest rows.
- Irreversibility: no code path (API, import, clone, stale client, admin) can flip a private
  form back to plaintext or store a plaintext answer on it.
- Playwright (existing e2e workflow): full private-form journey on http://formlogic.local.
- Telemetry/logging review: crypto ops log status codes + suite ids only.

## 18. Open items for the user

1. **Plan gating:** reviewer recommendation — Private Forms broadly available during beta;
   charge later for team sharing, organization recovery, and advanced retention rather than
   for basic encryption. Confirm or adjust (`CLOUD_PLAN_ENFORCED` hook exists either way).
2. **Approve the descopes/deferrals:** sealed-box-instead-of-HPKE; SQLCipher-descope (with
   mandatory volume/snapshot/backup encryption); **DEK adoption deferred out of v1** (§6.1).
3. **Recovery stance confirmation:** mandatory recovery kit at vault creation (D5) — OK?
4. **Rotation policy (D11):** 7-day grace for routine rotation only; strict default for
   removal; strict always for compromise — OK?
5. Phase 0 of the review doc (marketing/security-claim wording) still needs a human pass
   before any public page mentions E2EE.
