# FormLogic Data Nodes — implementation contract (v1)

Status: N0 (protocol freeze) + N1 (Desktop encrypted store, read-only Data workspace) +
N2 (Cloud-primary Desktop snapshots, §9 — scheduled backups still pending) implemented.
N3+ pending. Plan authority:
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
- **API** (`/api/v1/data-node/*`, desktop flk_ key; scope `data:snapshot` with
  `connector:relay` grandfathered until N3 enrolment): signing-key, eligible-forms,
  snapshots (create/file?path=/delete). All 403 `data_nodes_disabled` while the flag is
  off.
- Deferred from N2: scheduled data-only backups (manual "Back up now" only so far).
