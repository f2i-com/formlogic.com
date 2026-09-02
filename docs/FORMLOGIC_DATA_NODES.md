> **RETIRED (2026-09-02).** FormLogic Desktop has been removed from this
> repository; its role — local models, services, hardware and headless flows
> paired to a FormLogic account — is filled by [OAIY](https://oaiy.com), which
> speaks the same pairing, relay and event contracts the web app and backend
> still serve. This document is kept as the record of how that side of the
> contract was designed; nothing below describes code that ships from here.

# FormLogic Data Nodes — implementation contract (v1)

Status: N0 (protocol freeze) + N1 (Desktop encrypted store, read-only Data workspace) +
N2 (Cloud-primary Desktop snapshots §9, account backups §10, scheduler) + N3a (node
enrolment/approval + placement baseline, §11) + N3b (Cloud-primary signed op log, §12)
implemented. N3c+ (leases, reservations, relay, StorageRouter, cutover, tombstone
ledger) pending. Plan authority:
[FORMLOGIC_DESKTOP_ENCRYPTED_DATA_NODES_PLAN.md](FORMLOGIC_DESKTOP_ENCRYPTED_DATA_NODES_PLAN.md).

This document pins the *implementation-level* constants that the plan leaves to N0:
canonical JSON, signing preimages, hash/signature encodings, logical roots, key naming,
and the managed folder layout. Cross-language vectors live in
[contracts/data-sync-vectors.json](contracts/data-sync-vectors.json) and are asserted by
vitest (`ui/src/lib/data/vectors.test.ts`), phpunit (`backend/tests/Unit/DataSyncVectorsTest.php`),
and cargo (`desktop/src-tauri/src/data/canonical.rs` tests). Changing any rule here is a
protocol version bump, not an edit.

## 1. Canonical JSON — `flcanon/1`

`flcanon/1` is RFC 8785 (JCS) restricted to an integer-only subset. All signed or hashed
data-node structures (placement manifests, operations, checkpoints, backup manifests,
node certificates, logical roots) are serialized with it before hashing/signing.

Rules (frozen):

1. Value types: object, array, string, integer, boolean, null. Nothing else.
2. Numbers MUST be integers with |n| ≤ 9007199254740991 (2^53−1). Fractions, exponents,
   `NaN`, `Infinity`, and `-0` are invalid. Zero serializes as `0`.
3. Object keys are sorted by UTF-16 code units (the exact JCS rule — NOT Unicode
   code-point order; they differ for non-BMP keys). Duplicate keys are invalid.
4. String escaping is exactly JCS: `\"` `\\` `\b` `\f` `\n` `\r` `\t`, other control
   characters < 0x20 as `\u00xx` with lowercase hex, everything else (including all
   non-ASCII) as raw UTF-8. Lone surrogates are invalid.
5. No insignificant whitespace. `null`/`true`/`false` literal.
6. The top level of a signed structure is always an object.

Verification never re-parses leniently: a verifier parses the received bytes, re-serializes
with `flcanon/1`, and requires byte equality. (This inherently rejects duplicate keys,
floats, `-0`, and whitespace variants without a bespoke strict parser in JS/PHP; the Rust
store additionally uses a strict duplicate-key-rejecting parser for envelope validation.)

## 2. Signing preimages and domains

    preimage = ASCII(domain) || 0x0A || flcanon(structure-without-"signature")

Frozen domains (plan §6):

| Domain | Structure |
| --- | --- |
| `flplacement:1` | DataPlacementManifest |
| `flop:1` | Replication operation |
| `flcheckpoint:1` | Checkpoint / primary head checkpoint |
| `flbackup:1` | Backup manifest |
| `flnodecert:1` | Owner-signed node-authority certificate / key rotation |
| `flroot:1` | Logical root preimage (hash only, never signed directly) |
| `flhw:1` | Independent high-water record (hash only) |

- Hash fields (`…Hash`, `logicalRoot`, `operationHash`) = SHA-256 over the domain-separated
  preimage, lowercase hex (64 chars).
- Signatures = Ed25519 detached (libsodium `crypto_sign_detached` / ed25519-dalek /
  `sodium_crypto_sign_detached`) over the preimage bytes, encoded standard base64 WITH
  padding (88 chars). Same convention as the E2EE manifest signatures.
- The `signature` field is removed before canonicalization; every other field signs.
- A signature under one domain MUST NOT verify under another (asserted by vectors).

Key identity conventions (match E2EE):

- `keyId` = first 16 lowercase hex chars of SHA-256(raw 32-byte Ed25519 public key).
- `fingerprint` = full SHA-256 lowercase hex (64 chars) of the raw public key.
- Display fingerprint = first 24 hex chars in groups of 4 (UI-only).
- Public keys on the wire = standard base64 with padding (44 chars for 32 bytes).

## 3. Logical root — `flroot:1`

The v1 logical root is a flat deterministic hash (not a Merkle tree; upgradeable via
`protocolVersion`):

    entries = [
      ["response", id, rowVersion, rev, cipherHash]        // live rows
      ["tombstone", entityId, sequence, operationHash]      // tombstones
      ["artifact", artifactKind, artifactId, artifactHash]  // schema/manifest artifacts
      ["attachment", fileId, cipherHash]                    // committed attachment objects
    ]
    sorted lexicographically by flcanon serialization of each entry
    logicalRoot = sha256hex("flroot:1" || 0x0A || flcanon({"v":1,"datasetId":…,"entries":entries}))

`cipherHash` for a response = SHA-256 lowercase hex of the exact stored canonical
`__flenc:1` envelope bytes (the bytes persisted verbatim, not a re-encode).

## 4. Desktop key hierarchy (N1)

All entries live in Windows Credential Manager service `com.formlogic.desktop`.
**Fail-closed policy (plan D17): if the credential store is unavailable, data hosting is
disabled with `data_key_store_unavailable`. There is NO plaintext key-file fallback** —
this deliberately diverges from the journal/consent key tiering.

| Credential name | Content |
| --- | --- |
| `data-node-signing-key` | 32-byte Ed25519 seed, base64 |
| `data-nsmk` | 32-byte Node Storage Master Key, base64 |
| `data-high-water:<datasetId>` | JSON high-water record (see §6) |

- Per-dataset database key: random 32 bytes, wrapped with XChaCha20-Poly1305 under the
  NSMK, AAD `fldbkey:1|<datasetId>`, blob = `nonce(24)||ct`, stored base64 in
  `data/node/wrapped-dataset-keys.json`. Never in the dataset folder in raw form.
- SQLCipher key applied as `PRAGMA key = "x'<64 hex>'"` before any schema access;
  `PRAGMA cipher_integrity_check` + `PRAGMA integrity_check` are the verify path.
- A restored/portable dataset always mints a fresh database key (plan §9).

## 5. Managed folder layout (under the Desktop data root)

    <data-root>/data/
      node/ (public-identity.json, wrapped-dataset-keys.json)
      forms/<datasetId>/data.sqlite3.enc [+ attachments/, staging/]
      sync/
      backups/data-only/   backups/disaster-recovery/
      quarantine/
      README.txt

Filenames are opaque IDs. The generic data-dir migration (`migrate.rs`) MUST NOT copy
`data/` (live encrypted DBs); dataset relocation is a controlled quiesce+backup-API path
(N5). `data/` is therefore excluded from `MIGRATE_SUBDIRS`.

## 6. Independent high-water record — `flhw:1`

Stored outside every dataset database (Credential Manager locally; Cloud/live replicas
in later phases). Shape (canonicalized for hashing with domain `flhw:1`):

    { "v": 1, "datasetId", "storageEpoch", "lastAcknowledgedSequence",
      "lastOperationHash", "checkpointHash", "placementManifestHash",
      "tombstoneLedgerCoverageSequence", "tombstoneLedgerRoot", "updatedAt" }

Startup / pre-write comparison (plan §10.3): DB behind anchor → `rollback_detected`
(writes blocked); same sequence, different hash → `history_diverged` (writes blocked);
DB ahead by locally committed but unacknowledged operations → verify chain, reconcile;
no anchor reachable → verified read-only, disclosed in status.

## 7. Feature flags

Backend: `DATA_NODES` (bool env, default false) → `settings['cloud']['dataNodes']` →
`/api/health` `dataNodes`. All future data-node Cloud mutations 403
`data_nodes_disabled` when off (same pattern as `PRIVATE_FORMS`). Desktop N1 is local-only
and always available in the workspace, labelled beta.

## 8. Error codes added in N0/N1

`data_key_store_unavailable`, `encrypted_store_unavailable`, `rollback_detected`,
`history_diverged`, `replica_integrity_failed`, `data_nodes_disabled`. The full catalog is
plan §21.3.

## 9. N2 — Cloud snapshot package (`.flbackup`) pins

A `.flbackup` is a ZIP of the plan §18.4 layout (backup-index.json,
manifests/{backup-manifest,checkpoint}.json, data/{responses.ndjson.enc, control.ndjson,
tombstones.ndjson, operations.ndjson}; no recovery/ member — data-only). Built by
`backend DataSnapshotService`, pulled + verified + assembled by
`desktop src/data/snapshots.rs`; staged Cloud copies live under
`<storage>/data-snapshots/<id>/` with a 1-hour TTL.

Frozen pins:

- **responses.ndjson.enc** line: `{id, status, submittedAt, updatedAt, rowVersion,
  lifecycleState, trashedAt, rev, cipherHash, answersRaw}`. `answersRaw` is the EXACT
  stored envelope string (opaque, so no re-encode can drift `cipherHash =
  sha256(answersRaw)`). Until N3 adds the row-version columns to the Cloud schema,
  `rowVersion=1 / lifecycleState=active / trashedAt=null` are derived defaults.
- **control.ndjson** line: `{kind: manifest|schema|ingestion|grant, id, …}` — every
  secret stays in its existing wrapped/signed form. An artifact's logical-root hash is
  sha256 over the EXACT line bytes (no trailing newline).
- **flroot:1 entries**: `["response", id, rowVersion, rev, cipherHash]` and
  `["artifact", kind, id, lineSha256]` — identical to what a restored desktop store
  recomputes from its own tables (that equality IS the Structural Test Restore gate).
- **legacy_cloud_primary** (no signed placement yet): `storageEpoch 0`, checkpoint
  `placementManifestHash null`, no placement-manifest.json in the package.
- **Cloud signer**: `DataCloudSigner` (seed at `<storage>/keys/data-cloud-signing.key`,
  env override `DATA_CLOUD_SIGNING_SEED`; a malformed key file fails closed rather than
  silently rotating). Desktops pin its public identity TOFU over the authenticated API
  channel (`data/node/cloud-signer.json`) and REFUSE a changed key. Until N3 placement
  binds the fingerprint under the owner's vault signature, provenance is
  `cloud_signed_tofu` ("Cloud-signed · owner chain pending") — never "authenticated".
- **API** (`/api/v1/data-node/*`, desktop flk_ key): signing-key, eligible-forms,
  snapshots (create/file?path=/delete), account-backups. All 403 `data_nodes_disabled`
  while the flag is off. Two authority tiers (review FL-001):
  - *Enrolment tier* (register/self/signing-key/eligible-forms): scope `data:snapshot`
    (`connector:relay` grandfathered during migration only).
  - *Data-plane tier* (snapshot build/download/delete, whole-account backup): the key
    must ALSO resolve — via its desktop connection — to an **approved** data node with
    an unexpired owner-signed `flnodecert:1` granting `storage`. Every failure mode
    (no node, pending, revoked, expired, foreign key) is the same opaque 403
    `data_node_unauthorized`. A legacy relay key alone can never export data;
    `connector:relay` on this tier is a migration shim slated for removal once
    enrolment mints least-privilege `data:snapshot` keys.
  - Certificate timestamps are strict RFC 3339 UTC (`YYYY-MM-DDTHH:MM:SSZ`); approval
    refuses malformed/expired/future-issued certs and validity windows over 10 years.
  - Account-backup requests carry a node-signed transfer-key challenge: Ed25519 over
    `flaccountreq:1|<requestedAt>|<ephemeralPk>` by the enrolled node signing key,
    ±600 s freshness — an arbitrary (attacker-supplied) X25519 key is refused
    (`account_backup_key_unbound`).
  - Staged artifacts (snapshots + sealed account backups) are owner-bound in
    `data_staged_artifacts` (review FL-002): GET/DELETE of a foreign artifact ID is
    indistinguishable from a missing ID, and deletion is a crash-resumable
    active→deleting→gone state machine finished by the TTL sweep.
- Scheduled data-only backups: `data/node/backup-schedule.json`, one desktop loop
  (15-min tick, hour-granular intervals; UI offers daily); after each successful run the
  catalog is pruned to the newest 5 backups per target (logged, never silent).

## 10. Sealed whole-account backups (`.flaccount`)

The account-backup lane covers EVERYTHING on the account — including plaintext
(non-Private) forms, apps, and flows — because users want a desktop-held copy of all
their data. It is NOT record-level E2EE (the Cloud can read plaintext forms by
definition); instead the transfer and local storage are sealed:

- The desktop mints a fresh **ephemeral X25519 key per request** and sends the public
  half over the authenticated API channel. The Cloud builds the existing
  AccountBackupService archive, then — before the bytes leave the service — wraps a
  random 32-byte file key to that ephemeral key (`crypto_box`, Cloud-side ephemeral
  sender key) and chunk-encrypts the zip with XChaCha20-Poly1305
  (nonce = 16-byte base || 64-bit BE chunk index; AAD `flaccount:1|backupId|i|count`,
  so truncation/reorder/tamper fail closed). The plaintext zip is deleted after sealing.
- The header (chunking, hashes, wrapped key, Cloud ephemeral pk) is signed by the
  DataCloudSigner under `flbackup:1` with `kind: "account-backup"` — verifiers dispatch
  on the signed kind, so an account header can never pass as a snapshot manifest.
- The desktop verifies the header against the TOFU-pinned signer, decrypts chunk-by-chunk
  in memory, checks size + SHA-256 (+ deep zip validation up to 64 MiB), and immediately
  RE-encrypts each chunk under an NSMK-wrapped per-backup key
  (AAD `flaccount-local:1|…`) — decrypted archive bytes never touch this disk. The
  copy-safe `data/backups/account/<backupId>.flaccount` is a ZIP of
  { local.json (incl. the original signed Cloud header, for provenance re-checks),
  payload.bin }.
- Consequence, disclosed in the UI: the local copy is readable ONLY by this desktop's
  key store; the Cloud original remains the primary. Restore = the existing account
  import (Cloud), or a future N7 recovery path.
- API: `POST /api/v1/data-node/account-backups` {ephemeralPk} → signed header;
  `GET …/{id}/payload` (streamed); `DELETE …/{id}`; staged copies sweep after 1h.
- Errors: `account_backup_bad_ephemeral_key`, `account_backup_too_large`,
  `account_backup_not_found`.

## 11. N3a — node enrolment, owner approval, placement baseline

- **Enrolment** (`POST /api/v1/data-node/register`, desktop flk_ channel; also the
  heartbeat, hourly): the server derives keyId/fingerprint FROM the raw Ed25519 key
  (client-sent values are ignored) and binds the node to the desktop_connections row
  owning the API key — never a self-reported instance id. One node per connection.
  A changed signing key = rotation: status drops to `pending`, the certificate is
  cleared, the key generation increments — owner re-approval is mandatory.
- **Approval** (`POST /api/data-nodes/{id}/approve`, session): the browser vault worker
  signs an **flnodecert:1** node-authority certificate (op `signDataStructure`, domain
  ALLOWLISTED to flnodecert:1/flplacement:1 so the vault can never mint an
  operation/checkpoint/backup signature, and the worker refuses ownerSigner* fields
  that do not match the vault). Frozen cert fields: protocol, kind `node-authority`,
  nodeId, connectionId, ownerUserId, signingKeyId, signingKeyGeneration,
  signingPublicKey, fingerprint, capabilities, issuedAt, expiresAt (nullable),
  ownerSignerKeyId, ownerSignerFingerprint, signature. The server re-verifies every
  field against the node row AND the signature against the vault public key. The web
  approval dialog shows the node fingerprint for out-of-band comparison with the
  desktop's Data page.
- **Placement baseline** (`PUT /api/forms/{id}/data-placement`, session): the epoch-1
  flplacement:1 manifest for a Private form — Cloud as the single primary replica with
  the DataCloudSigner identity bound as `authoritySigningKey` AND `leaseAuthority`
  (owner-anchoring the Cloud signer). Structure is fully pinned server-side (every
  signed field must equal the expected baseline; epoch 1 only in N3a); CAS =
  UNIQUE(dataset, storage_epoch). `GET` returns `legacyCloudPrimary: true` until it
  exists. Errors: `placement_conflict`, `placement_signature_invalid`,
  `placement_form_ineligible`, `signed_structure_mismatch`, `vault_required`,
  `data_node_cert_signature`, `data_node_revoked`, `data_node_no_connection`.
- UI: web Settings → Linked Desktops → "Data nodes" (approve/revoke, fingerprint
  confirm); Form Settings → Access → "Data storage" card (sign baseline); desktop Data
  workspace shows its Cloud enrolment state ("Awaiting approval in web Settings").

## 12. N3b — Cloud-primary signed operation log

For a Private form WITH the §11 signed placement, every envelope write appends an
flop:1 operation (`DataOperationLogService`, injected into ResponseService — injection
ONLY, so the Cloud signing key resolves through one configured path):

- Row mutation + operation land in ONE per-form-SQLite transaction (plan §10.2):
  `replication_operations` (desktop-compatible columns) + a single-row `op_log_state`
  (last sequence/hash + the signed head checkpoint). The MySQL mirror gate stays after
  commit; a gate refusal compensates row + op + state atomically (the op was never
  acknowledged or served). `responses` gains row_version / lifecycle_state / trashed_at
  (guarded ALTER; the CAS update bumps row_version in the same statement).
- Ops are signed by the placement-bound Cloud authority, hash-chained
  (previousOperationHash), sequence-contiguous, and carry
  `encryptionManifestHash = sha256(exact form_manifests.signed_bytes of the accepted
  tuple)`. CAS misses append NOTHING. **v1 caveat:** the pre-lease Cloud primary uses a
  random per-op writeLeaseId + fencingGeneration 1 until the N3c lease service;
  lease enforcement begins when a second primary becomes possible.
- After each write the signed flcheckpoint:1 HEAD is rebuilt (flroot recomputed O(n) —
  incremental root queued for N5) and the Cloud anchor row
  (`data_dataset_high_water`) is upserted best-effort.
- Artifact root entries hash the EXACT control.ndjson line bytes, built by the shared
  `DataControlArtifacts` (used by BOTH snapshots and head checkpoints — never rebuild
  those lines independently). A control-artifact publish (schema/key rotation) does not
  yet refresh the head — that sequencing is the N3c publication barrier; the snapshot
  manifest's own logicalRoot is always packaged truth.
- Snapshots of placed forms now carry the REAL history: operations.ndjson = the
  canonical op lines, checkpoint.json = the stored signed head (verbatim), and the
  backup manifest's storageEpoch/lastSequence/lastOperationHash come from it.
  legacy_cloud_primary forms are byte-for-byte untouched (no schema change, no ops).
