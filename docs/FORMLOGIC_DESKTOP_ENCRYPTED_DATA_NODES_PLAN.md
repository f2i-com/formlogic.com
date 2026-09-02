> **RETIRED (2026-09-02).** FormLogic Desktop has been removed from this
> repository; its role — local models, services, hardware and headless flows
> paired to a FormLogic account — is filled by [OAIY](https://oaiy.com), which
> speaks the same pairing, relay and event contracts the web app and backend
> still serve. This document is kept as the record of how that side of the
> contract was designed; nothing below describes code that ships from here.

# FormLogic Desktop Encrypted Data Nodes

## Architecture and Implementation Plan

**Status:** Proposed v1 working specification  
**Prepared:** 22 July 2026  
**Primary repository basis:** [f2i-com/formlogic.com at 83a7eec3](https://github.com/f2i-com/formlogic.com/commit/83a7eec3b364f3fb44c54372f7976709d6b2f15c)  
**Aokie review basis:** [f2i-com/aokie.com at 53a3539d](https://github.com/f2i-com/aokie.com/commit/53a3539d38224ecee2c40ddf750608524bdd3743)  
**Relationship to the existing E2EE plan:** This is a storage-only data-node track that complements [E2EE_PRIVATE_FORMS_PLAN.md](https://github.com/f2i-com/formlogic.com/blob/main/docs/E2EE_PRIVATE_FORMS_PLAN.md); it does not replace or weaken that design. E2EE Phase 7 is a different, optional trust model in which an explicitly granted Desktop worker may decrypt with a Form Key. A storage-only node in this plan receives no such grant and can ship independently of Phase 7.

---

## 0. Executive decision

FormLogic should model every Private form as one **encrypted logical dataset** whose ciphertext may be held by one or more authorised **replicas**:

- FormLogic Cloud;
- one FormLogic Desktop installation;
- several linked FormLogic Desktop installations;
- or a combination of Cloud and Desktop replicas.

The browser remains the normal place where an authorised person unlocks and decrypts Private-form records. FormLogic Desktop can host and replicate ciphertext without automatically receiving a Form Key or the ability to read responses.

The central rule is:

> **Storage location, encryption ownership, access authority, and backup policy are separate concerns.**

A storage change must therefore not change the existing E2EE key hierarchy, silently grant a Desktop access to plaintext, or turn a backup into a live replica.

The recommended first production topology is deliberately conservative:

1. Private/E2EE forms only.
2. One authoritative primary replica per form.
3. Zero or more read-only/live/backup replicas.
4. Logical operation replication, never live SQLite file synchronisation.
5. Explicit storage epochs, short write leases, and gateway receipt fencing to prevent two acknowledged primaries.
6. A controlled migration wizard instead of an instant Cloud/Desktop toggle.
7. Two backup types: encrypted data-only and password-protected disaster recovery.

This produces the flexibility the product needs without creating a multi-master SQLite system or weakening the E2EE work that is already implemented.

---

## 1. Product outcome

### 1.1 What customers can do

A customer can:

- keep a form in FormLogic Cloud;
- make a linked Desktop the primary data host;
- retain Cloud as an encrypted live replica or snapshot destination;
- keep Cloud out of permanent response storage while optionally using a time-limited encrypted delivery queue;
- reject public submissions while a strict Desktop-only primary is offline;
- back up Cloud data to Desktop;
- back up Desktop data to Cloud;
- move the primary from Cloud to Desktop or back again;
- link several Desktop nodes and assign each a primary, live-replica, backup, or archive role;
- see the location, size, currentness, health, and backup state of local form databases in a Desktop **Data** workspace;
- open the form in the Web App for all record CRUD;
- export an encrypted recovery bundle to the computer;
- run a non-destructive Test Restore before trusting a backup;
- revoke a node without pretending that previously exported copies can be remotely erased.

### 1.2 Recommended customer-facing promise

For a Desktop-primary Private form:

> Responses are encrypted in the submitter’s browser before transmission. Your selected FormLogic Desktop stores the primary encrypted copy. FormLogic cannot read the answers. Depending on your chosen availability policy, FormLogic Cloud may temporarily queue ciphertext or retain an encrypted replica.

For strict Desktop-only mode:

> FormLogic Cloud does not retain a permanent response-data copy. Your Desktop must be online to accept and view responses. FormLogic still hosts account, form-definition, routing, device-presence, and limited operational metadata.

Do not call this complete infrastructure self-hosting. The Web App, accounts, form definitions, device registry, public encryption manifests, and routing control plane remain hosted unless a separate fully self-hosted control-plane product is built later.

### 1.3 What E2EE still does not protect

The existing Private Forms limitations continue to apply:

- a malicious server that serves modified JavaScript to a future browser session;
- metadata such as form identity, ciphertext size, timestamps, access patterns, device availability, and IP handling;
- an unlocked or compromised authorised browser/Desktop;
- plaintext an authorised user already copied;
- denial of service, delayed delivery, or deletion by a malicious relay;
- a removed device retaining exports or keys it obtained while authorised.

The operation log adds replication integrity and stale-primary protection. It must not be marketed as proof that anonymous public submissions are authentic: anyone with the public ingestion key can create a valid encrypted submission.

---

## 2. Verified implementation baseline

The current FormLogic main branch already contains the E2EE Private Forms P1-P3 implementation. The plan must extend these seams rather than build a second encryption system.

| Existing area | Current implementation | Implication |
| --- | --- | --- |
| Cloud response store | One SQLite database per form under storage/forms, opened by backend/src/Database/SQLiteConnection.php | Desktop should preserve the logical per-form dataset boundary. |
| Private response record | A validated __flenc:1 envelope is stored verbatim in responses.answers | Replication can carry the same opaque envelope without decryption or schema translation. |
| Private create/update | ResponseService::createEncryptedResponse and updateEncryptedResponse; update uses an atomic expectedRev CAS | The storage router must preserve exact idempotency and CAS behaviour. |
| E2EE keys | Argon2id vault, wrapped UMK, X25519/Ed25519 user keys, per-form FK epochs, ingestion key epochs, response DEKs | Desktop hosting must not introduce a competing account-data key hierarchy. |
| Public submission | privateSubmit.ts verifies the signed manifest, pins the signer, and seals in the browser | Desktop-primary submission can route the resulting envelope unchanged. |
| Cloud backup | AccountBackupService checkpoints WAL and copies SQLite plus wrapped/public E2EE rows | Useful as a snapshot baseline, but not a multi-node sync protocol and not an encrypted portable archive by itself. |
| Multiple Desktops | desktop_connections has owner, device name, instance ID, API key, last seen, capabilities, trusted origins, and E2E public key | Extend this registry; do not create a separate unlinked device list. |
| Desktop OAuth | OAuth code + PKCE creates a per-connection scoped API key; Windows stores it in Credential Manager | Reuse enrolment, but add least-privilege data-node scopes and short-lived data-plane admissions. |
| Existing browser/Desktop tunnel | Browser and Rust use X25519/NaCl box, TOFU pinning, directional counters, and cross-language vectors | Reuse the crypto discipline and identity lifecycle, not the current small-message relay tables. |
| Existing relay limits | Command, AI, and flow relays have small request/result limits and short terminal retention | A separate chunked, resumable data plane is required. |
| Desktop local data root | FormLogic Desktop already has a configurable data directory, open_path, and controlled folder settings | Host databases below the existing data root and expose them in the Data workspace. |
| Desktop storage crypto | Operational journals have XChaCha protection but allow insecure fallbacks on unsupported systems | Hosted customer data must use a separate fail-closed policy. |
| Aokie | A supervised FormLogic Desktop plugin; FormLogic owns records, roles, dashboards, and flows | Data hosting belongs in FormLogic core. Aokie must never mount form databases or receive database keys. |

Important baseline constraint:

> The current Cloud SQLite file is not SQLCipher-encrypted. Private answers are E2EE envelopes, while IDs, status, timestamps, page structure, and other allowed metadata remain visible to the Cloud host. SQLCipher was de-scoped for the PHP/PDO Cloud stack. Desktop can use a different whole-file-at-rest implementation without changing the record envelope.

---

## 3. Scope and release boundaries

### 3.1 In scope

- Per-form placement policies.
- Desktop-hosted encrypted SQLite storage.
- A dedicated encrypted data relay.
- Cloud-to-Desktop and Desktop-to-Cloud migration.
- Cloud, Desktop, and multi-Desktop replicas.
- Encrypted delivery queues with explicit TTL and quota.
- Signed, idempotent logical replication operations.
- Tombstones, checkpoints, fencing, and promotion.
- Data-only and disaster-recovery backups.
- Test Restore and recovery-node enrolment.
- A Desktop Data workspace with operational actions, not record CRUD.
- Web App placement, migration, availability, and node-management UI.
- Same-account multiple Desktop nodes.
- Explicit storage-only and decryption-capable grants for organisations/cross-account sharing in a later phase.

### 3.2 Out of scope for the first release

- Raw SQLite file synchronisation through OneDrive, Dropbox, network shares, or similar.
- Active/active multi-primary writes.
- Server-side search, calculations, reports, webhooks, AI, or flows over encrypted answer content.
- Desktop CRUD screens for customer records.
- Automatic plaintext export from Desktop.
- Silent failover to Cloud when the selected policy does not include a Cloud replica.
- General non-Private-form Desktop hosting.
- Fully disconnected/self-hosted FormLogic accounts and form definitions.
- Aokie-specific database replication.

### 3.3 Eligibility

The first release supports **Private forms only**.

Routing an ordinary plaintext form directly to Desktop would either expose plaintext to Cloud or require the Rust host to reproduce PHP validation, calculated fields, scripts, webhooks, flows, file handling, filtering, and report semantics. That is a separate product project.

Feature dependencies:

- Text responses: existing E2EE P1-P3.
- Encrypted attachments: E2EE P4 plus this plan’s N8 attachment transfer/root/restore support. N0–N7 reject placement, migration, or restore for any form with attachment fields or retained attachment objects; they do not silently omit files.
- Team/app-runtime Private forms and user key grants: E2EE P5.
- Private local processing: E2EE P6/P7 explicit worker grants.
- Cross-account decryption access: E2EE P5 grant model plus this plan’s storage grants.

---

## 4. Terminology

| Term | Definition |
| --- | --- |
| Encrypted dataset | The logical records, attachments, tombstones, schema snapshots, manifests, and replication history for one Private form. datasetId equals formId in v1. |
| Data Placement Policy | The signed per-form declaration of primary, replicas, offline delivery policy, storage epoch, and protocol version. |
| Replica | An authorised storage location holding some or all encrypted objects for a dataset. |
| Primary replica | The only replica authorised to order and commit live writes for the current storage epoch. It is not the encryption authority. |
| Live replica | A continuously synchronised copy eligible for manual promotion when verified current. |
| Backup replica | A copy refreshed on a schedule and not used for normal reads or automatic promotion. |
| Archive | A read-only retained historical copy with explicit retention. |
| Snapshot | An immutable point-in-time logical backup at a named checkpoint. |
| Linked Data Node | A separately enrolled FormLogic Desktop installation with a stable public identity and scoped dataset assignments. |
| Storage epoch | A monotonically increasing routing generation. The gateway rejects an older epoch immediately; a previously authorised primary is prevented from acknowledging new work by expiring write authority and is quarantined if it reconnects with late commits. |
| Sequence | A dataset-global, monotonically increasing operation position assigned by the current primary; it does not reset at an epoch change. |
| Sync checkpoint | A signed statement of applied sequence, logical root, previous checkpoint hash, and storage epoch. |
| Delivery queue | A temporary Cloud ciphertext spool used only when explicitly selected. It is storage, even though it cannot decrypt content. |
| Move primary | A verified migration that changes the authoritative replica. |
| Replicate | Continuous copying of committed encrypted operations. |
| Restore | A deliberate verification-namespace, exact-chain merge, replacement, or recovery-node operation from a snapshot. Cloning to a new Private form is a separate decrypt-and-reseal workflow. |
| Recovery bundle | A versioned, authenticated, independently password-wrapped export containing the material required to recover the E2EE vault and key metadata. |

Avoid the frontend name storageMode: it already means browser localStorage versus API mode. Use dataPlacement and replicaPolicy.

---

## 5. Locked architecture decisions

| ID | Decision |
| --- | --- |
| D1 | The dataset boundary is one Private form; datasetId equals formId in protocol v1. |
| D2 | Existing __flenc:1 response and attachment envelopes remain the content-encryption boundary. |
| D3 | A storage-only Desktop receives no Form Key, ingestion secret, or response DEK. |
| D4 | Desktop local databases receive a separate whole-file/container encryption layer. |
| D5 | There is exactly one writable primary per dataset. |
| D6 | Replication exchanges logical operations and snapshots, never live SQLite/WAL files. |
| D7 | Every newly acknowledged write is bound to the current placement-manifest hash, storage epoch, authorised primary key, and unexpired write lease. After cutover, an old receipt may only finalise an identical pre-existing reservation already covered by the signed cutover checkpoint; it cannot append data. Other late old-epoch commits are quarantined. |
| D8 | The Web App retains the existing response API facade and performs decryption/CRUD UX. |
| D9 | Desktop’s Data workspace is operational only; no duplicate response CRUD. |
| D10 | Moving storage is a state machine with verification and rollback, not an immediate toggle. |
| D11 | Cloud queueing, Cloud replication, and Cloud backup are independent settings. |
| D12 | Strict Desktop-only mode rejects submissions while the primary is offline. |
| D13 | The recommended availability default is Desktop primary plus a seven-day encrypted Cloud delivery queue, clearly labelled as temporary ciphertext storage. |
| D14 | No automatic failover in v1. Promotion is explicit and requires a verified current checkpoint. |
| D15 | Node revocation, replica removal, decryption-key revocation, and best-effort local wipe are separate actions. |
| D16 | The current Desktop API key, tunnel identity, node signing key, local database key, Form Key, and backup wrapping key remain distinct. |
| D17 | Hosted data fails closed when secure local key storage/unlock is unavailable. Existing plaintext key fallbacks are not acceptable. |
| D18 | Backups are created with the SQLite backup/logical snapshot path; copying a live data directory is never represented as a guaranteed-consistent backup. |
| D19 | “Current” means equality with the latest verified primary-signed head checkpoint, anchored to the current owner-signed placement manifest; it never means merely a recent timestamp. |
| D20 | Cross-account storage never implies cross-account decryption. |
| D21 | Cloud and relay logs never contain request bodies, envelopes, paths, keys, or plaintext. |
| D22 | The Cloud cannot issue an operation that asks Desktop to export or return plaintext. |
| D23 | Physical SQLite file hashes are not replication truth. Canonical logical object roots are. |
| D24 | Aokie continues to use supported FormLogic APIs and cannot access hosted database files directly. |

---

## 6. Data placement model

Do not store a single Cloud/Desktop boolean. Store an epoch-stable, owner-signed placement manifest. Mutable progress is a separate primary-signed head checkpoint; otherwise every anonymous submission would require the owner to unlock their vault and re-sign placement.

~~~text
DataPlacementManifest
  datasetId
  formId
  protocolVersion
  storageEpoch
  primaryReplicaId
  replicas[]
    replicaId
    kind: cloud | desktop
    role: primary | live | backup | archive
    desiredState
    authoritySigningKey
      keyId
      generation
      ed25519PublicKey
      fingerprint
    transportKeyFingerprint
  offlineSubmissionPolicy
    mode: reject | encrypted_queue
    ttlSeconds
    maxBytes
    maxItems
  readFallbackPolicy
    mode: none | verified_live_replica
  leaseAuthority
    keyId
    generation
    ed25519PublicKey
    fingerprint
  cutoverCheckpointHash
  recoveryAuthorization nullable
    highestKnownSequence
    highestKnownOperationHash
    restoredCheckpointSequence
    restoredCheckpointHash
    snapshotLogicalRoot
    recoveredLogicalRootAfterTombstones
    abandonedRangeStart / abandonedRangeEnd
    tombstoneLedgerCoverageSequence
    tombstoneLedgerRoot
    additionalUncertainty
    reason
    approvedAt
  previousManifestHash
  ownerSignerKeyId
  ownerSignerGeneration
  ownerSignerFingerprint
  signature

PrimaryHeadCheckpoint
  datasetId
  placementManifestHash
  storageEpoch
  lastSequence
  lastOperationHash
  logicalRoot
  tombstoneLedgerCoverageSequence
  tombstoneLedgerRoot
  previousCheckpointHash
  authoritySignerKeyId
  authoritySignerGeneration
  signature
~~~

The owner’s unlocked vault signing key signs placement manifests. Every verifier checks that key against the owner/vault Ed25519 fingerprint it previously pinned during vault setup or node pairing; it never trusts a signer key merely because the same manifest or a mutable Cloud roster contains it. Each replica entry binds the replica ID, role, signing-key generation/fingerprint, and transport-key fingerprint. A Cloud primary uses a dedicated service replica signing key, preferably hardware-backed, whose fingerprint the owner also binds in placement. This prevents Cloud from silently authorising a different primary or swapping a node key; it does not stop Cloud from withholding service, serving malicious application code, or signing internally inconsistent Cloud-primary content.

The current primary signs mutable head checkpoints with the authority key authorised by the placement manifest. The separate HSM-backed Cloud lease-authority key is also fingerprinted in that owner-signed manifest, so a node never trusts an arbitrary “control-plane” lease signer. “Current” is comparison with the latest verified head checkpoint, not a mutable field in the owner-signed manifest. Replica, authority, or lease-key rotation requires a new owner-signed placement epoch. Normal owner-key rotation is cross-signed by both old and new keys and logged; if the old key is unavailable, every node must enter an explicit recovery/re-pairing flow and display the new fingerprint out of band before trusting it. Emergency loss of the lease key pauses writes until an owner-authorised replacement manifest is available; it does not fall back to unsigned leases.

Freeze canonical signing preimages and cross-language vectors before implementation:

- flplacement:1 followed by JCS of the placement manifest without signature;
- flop:1 followed by JCS of an operation without signature;
- flcheckpoint:1 followed by JCS of a checkpoint without signature;
- flbackup:1 followed by JCS of a backup manifest without signature;
- flnodecert:1 for owner-signed node-authority certificates and key rotations.

Domain strings, byte separators, Unicode rules, integer ranges, omitted/null handling, and Base64 variants are protocol constants, not library defaults.

Existing Private forms begin as legacy_cloud_primary. The first visit to Data Placement creates and signs epoch 1. No migration or replica enrolment is allowed until that signed baseline exists.

### 6.1 User-facing presets

| Preset | Primary | Live replicas | Temporary queue | Behaviour |
| --- | --- | --- | --- | --- |
| Cloud | Cloud | None | Not applicable | Existing Private-form behaviour. |
| Cloud + Desktop backup | Cloud | None; scheduled Desktop snapshots | Not applicable | Simple off-site/customer-held backup. |
| Cloud + Desktop live copy | Cloud | Selected Desktop | Not applicable | Desktop stays close to current and is promotable after verification. |
| Desktop only — strict | Selected Desktop | None | Off | No durable Cloud response copy; reject when Desktop is unavailable. |
| Desktop primary — resilient | Selected Desktop | None | Seven days by default | Cloud temporarily stores ciphertext until Desktop durably acknowledges it. |
| Desktop + Cloud replica | Selected Desktop | Cloud | Optional | Cloud has a permanent encrypted replica and can be a read fallback. |
| Multiple Desktop nodes | Selected Desktop | One or more Desktop live/backup replicas; optional Cloud | Optional | One primary, explicit replica roles. |

“Cloud backup only” and “Desktop backup only” are snapshot schedules, not placement modes.

### 6.2 Read fallback

Fallback is permitted only to a replica that:

- is included in the signed placement manifest;
- reports the same storage epoch;
- has verified the authoritative checkpoint required by the request;
- is authorised for the caller and operation;
- is not revoked, version-blocked, or integrity-blocked.

Never send a read to an arbitrary online Desktop because it is the only device currently connected.

### 6.3 Renewable write authority and stale-primary boundary

Epochs alone cannot instantly fence an offline old primary: it cannot know that a newer manifest exists. Every externally reachable write therefore traverses the FormLogic gateway and carries a short, renewable, non-overlapping write lease signed by the control plane. The lease binds:

- dataset ID, placement-manifest hash, and storage epoch;
- authorised primary replica and authority-key fingerprint;
- lease-authority key generation, dataset-wide fencing generation, lease ID, issue time, expiry, and protocol version.

The primary checks the lease at commit using a monotonic elapsed-time bound, re-checks node assignment, and refuses to reuse a lease after restart or clock uncertainty. Recommended lease lifetime is 60 seconds. A promotion revokes the old lease where possible and, before issuing the new primary a lease, either obtains a signed release or waits for the old lease plus clock-skew margin to expire. The Cloud gateway changes canonical routing atomically and rejects old-manifest data beyond the signed cutover checkpoint; it may idempotently finalise an already-covered pre-cutover reservation as defined in the migration state machine.

If an old node committed just before learning of the cutover but its receipt was not accepted, that operation is not acknowledged to the caller. On reconnect it enters quarantine for explicit reconciliation; it is never spliced automatically into the new chain. The recovery UI states the last verified checkpoint, possible unacknowledged window, and resulting RPO. Without a reachable lease/control service, a node may serve verified reads but cannot accept new writes. This is the safety/availability trade-off that makes “one writable primary” enforceable without a quorum of customer nodes. The v1 Cloud-issued lease protects against partitions, stale nodes, and implementation errors under an honest control plane; it is not a quorum proof against a malicious Cloud deliberately issuing overlapping leases.

---

## 7. Runtime architecture

### 7.1 Control plane versus data plane

~~~mermaid
flowchart TB
  Browser["Browser: encrypt/decrypt + Web CRUD"]
  Control["FormLogic control plane: auth, manifests, placement, node roster"]
  Relay["Opaque data relay / optional ciphertext queue"]
  Cloud["Cloud encrypted replica"]
  Desktop["Desktop encrypted primary or replica"]

  Browser --> Control
  Browser --> Relay
  Relay --> Cloud
  Relay --> Desktop
~~~

The **control plane** may know:

- account/workspace and form IDs;
- form definition and publication state;
- node public keys, labels, capabilities, versions, heartbeat, and assignments;
- placement policy and storage epoch;
- ciphertext sizes, operation counts, sequence/checkpoint metadata;
- queue state, backup state, and allowed abuse metadata.

The **data plane** carries:

- response envelopes;
- encrypted attachment chunks;
- tombstones;
- schema snapshots and signed public manifests;
- logical operations and checkpoint manifests;
- portable encrypted snapshot chunks.

Neither plane receives a response decryption key merely to route or store data.

### 7.2 Desktop-primary public submission

~~~mermaid
sequenceDiagram
  participant B as Public browser
  participant C as FormLogic API
  participant D as Desktop primary
  B->>B: Verify manifest and seal __flenc envelope
  B->>C: POST envelope + idempotency key
  C->>C: Validate + reserve idempotency + current lease
  C->>D: Targeted opaque command + manifest + lease
  D->>D: Revalidate envelope; CAS; persist; fsync; high-water
  D-->>C: Signed durable receipt + checkpoint
  C->>C: Persist receipt/high-water; project metadata async
  C-->>B: Stored, queued, unknown, or explicit offline error
~~~

The API must dispatch the Private-form branch before any plaintext sanitation, calculated fields, scripts, webhooks, flows, or file interpretation, preserving the current load-bearing E2EE rule. A 201 means both the primary’s signed durable commit and Cloud’s receipt/high-water record are durable; it does not wait for a rebuildable metadata projection.

### 7.3 Owner read/edit path

1. Web App authenticates the member.
2. StorageRouter resolves the signed placement.
3. The API reads ciphertext from Cloud or issues a targeted Desktop data request.
4. Desktop returns the existing response wire shape containing __flenc envelopes.
5. The browser unlocks its vault and decrypts through the existing worker.
6. An edit creates a complete new envelope with rev + 1 and sends expectedRev.
7. The primary applies one atomic CAS and emits one replication operation.

The Cloud cannot ask Desktop to decrypt, run arbitrary SQL, read arbitrary paths, or return raw key material.

### 7.4 What “E2E through the API” means

The existing __flenc:1 object is the end-to-end content channel: a submitter/authorised browser seals answers before the API, the API and relay handle only the validated envelope plus disclosed routing metadata, Desktop stores/replicates the exact envelope, and an authorised browser decrypts only after retrieval. TLS 1.3 and the authenticated Desktop data connection protect each network hop in addition; they are not substitutes for record E2EE. Desktop-to-Desktop replica sessions should also use mutually authenticated ephemeral session keys bound to the owner-certified transport fingerprints and admission, so the relay cannot alter or redirect a stream without detection. Product copy must not imply that API-visible IDs, status, timestamps, sizes, or access patterns are E2E-hidden.

---

## 8. Security and trust model

### 8.1 Security invariants

- Record and attachment content is encrypted before the FormLogic API receives it.
- Cloud storage, relay, queue, backups, and Desktop replicas hold the same E2EE objects.
- Transport authentication is not content decryption authority.
- Storage assignment is not content decryption authority.
- A Desktop link grants no dataset access by default.
- A storage-only replica can copy, hash, verify transport integrity, and delete ciphertext but cannot open it.
- FormLogic Cloud never receives Desktop’s local database/container key.
- Node private keys and local database keys never enter the WebView, plugin process, logs, crash reporting, or Cloud heartbeat.
- Plugins cannot inherit data-host secrets or database file handles.
- A replica accepts writes only for an assigned dataset and current storage epoch.
- Revoked nodes cannot renew admissions/write leases, authenticate for new sync data, or have new operations/receipts accepted as canonical. A customer-owned offline binary may still append local bytes, but after its short lease expires that history has no write authority and is quarantined on reconnect.
- No raw key is exported beside a backup.

### 8.2 Threat/mitigation summary

| Threat | Required mitigation |
| --- | --- |
| Stolen Desktop data folder | SQLCipher/encrypted container plus record E2EE; local key held outside the folder. |
| Stolen backup | Data-only pack contains only E2EE objects; disaster-recovery key bundle is independently password-wrapped. |
| Malicious/compromised Cloud relay | AEAD envelopes, signed placement, targeted node identity, epoch fencing, operation hashes/checkpoints; acknowledge remaining drop/replay/metadata risks. |
| Self-asserted device ID | Derive node identity from authenticated desktop_connection/admission; never trust a payload field. |
| Old primary rejoins | Gateway rejects data beyond cutover; only an exact receipt already covered by the signed cutover checkpoint may finalise its existing reservation. Expired lease removes write authority and other late old-epoch history is quarantined rather than merged. |
| Duplicate/retried write | At-least-once delivery with idempotent, content-bound operation IDs and atomic apply. |
| Same idempotency key, different content | Permanent collision alarm; reject and block the affected sync lane. |
| SQLite/WAL corruption | SQLCipher integrity check, SQLite backup API, WAL checkpoints, signed logical manifests, Test Restore. |
| Valid but rolled-back database copy | Compare the database head with an independently stored high-water mark in the OS secure store and control plane/live replica; block writes on regression or unexplained divergence. |
| Disk full or power loss | Preflight free space, transactional append, synchronous durability, resumable transfers, no acknowledgement before fsync. |
| Node revoked during transfer | Admission expires/revokes; in-flight commit must re-check node and placement epoch. |
| Key rotation while queue contains old envelopes | Respect ingestion-key grace; expired/retired epochs become visible dead letters and are never silently discarded or rewrapped by Cloud. |
| Malicious plugin | FormLogic core owns data service; plugin capability model exposes no database paths/keys/arbitrary SQL. |
| Cloud tells Desktop to export plaintext | Data protocol has no such command; strict schema and deny-unknown-fields. |
| Cross-account accidental exposure | Separate storage-only grants from form-key grants; explicit per-form approval and fingerprint. |

### 8.3 Metadata leakage budget

The privacy page and placement wizard must disclose that FormLogic may observe:

- account/workspace/form/dataset IDs;
- node identity, version, availability, and assigned role;
- operation and record IDs;
- revision/sequence/checkpoint values;
- approximate ciphertext and attachment sizes;
- submission and access timestamps;
- privacy-minimised tombstone continuity entries (opaque record ID, delete sequence/hash, and reason class) when Cloud is the independent recovery anchor;
- IP data subject to the existing Private-form privacy sweep;
- queue and transfer status.

Never place response values, filenames supplied by respondents, local filesystem paths, business names, field labels, or decrypted previews in sync diagnostics.

---

## 9. Key hierarchy and separation

| Key/credential | Purpose | Where it lives | Export policy |
| --- | --- | --- | --- |
| Vault passphrase-derived PUK | Unwrap UMK | Browser memory only | Never exported as a key. |
| User Master Key | Wrap user private-key bundle | Browser worker memory; wrapped form stored | Only its existing encrypted wrappers enter recovery bundle. |
| Form Key by epoch | Wrap ingestion secrets and grants | Authorised browser worker; encrypted grants at rest | Only wrapped grants. |
| Ingestion key pair | Public submission DEK wrapping / response opening | Public key is public; secret is FK-wrapped | Wrapped secret only. |
| Response/file DEK | Encrypt one response/file write | Ephemeral client memory; sealed inside envelope | Never raw. |
| Desktop OAuth/API credential | Authenticate node to FormLogic | OS credential store | Never in backups. Re-enrol instead. |
| Data-plane admission token | Short-lived session authority | Desktop memory | Never exported. |
| Cloud lease-authority key | Sign short dataset-wide write leases/fencing generations | Cloud HSM/managed signing service; owner binds public fingerprint in placement | Public certificate only; private key never leaves the signing service. |
| Data-node signing key | Sign operations/checkpoints/receipts | OS secure store; public key certified in owner-signed placement/roster | Excluded from FormLogic exports, but normally retrievable under the OS-account threat model. Use a non-exportable CNG/TPM/Keychain handle only where the platform actually provides one. |
| Desktop tunnel X25519 key | Existing browser/Desktop tunnel | OS secure store; public key in connection registry | Keep separate from node signing. |
| Node Storage Master Key | Wrap per-dataset local database keys | OS secure store or explicit headless unlock | Never enters logical/portable backups. A restored node creates a fresh NSMK and fresh per-dataset database keys. |
| Per-dataset database key | Whole-file Desktop protection | Wrapped under Node Storage Master Key | Never raw; portable restore normally generates a new one. |
| Backup wrapping key | Protect disaster-recovery .flkeys | Derived with Argon2id from a dedicated backup password | Salt/parameters stored; key never stored. |

### 9.1 Storage-only versus processing node

By default a Data Node receives:

- storage assignment;
- dataset identifiers and public manifests;
- ciphertext;
- a node signing identity;
- a local container key.

It does **not** receive:

- Form Key;
- ingestion private key;
- response DEK;
- vault passphrase;
- user private signing key.

If a future Desktop worker must decrypt Private data for an explicitly authorised local flow, that is a separate Form Key grant under the E2EE P7 worker design. The UI must display **Can process decrypted data** separately from **Stores encrypted data**.

### 9.2 Secure-store requirements

Windows may extend the current Credential Manager integration. macOS requires Keychain; Linux Desktop requires Secret Service/libsecret or an explicit passphrase unlock. Ordinary credential stores protect access under the OS account but do not make signing keys cryptographically non-exportable. Compromise of a data-node signing key can forge receipts/checkpoints and cause consistency failures or data loss even though it cannot decrypt response content.

Headless mode may use:

- interactive startup passphrase;
- a supported hardware/secret-store adapter;
- a runtime-injected passphrase or KEK delivered by a protected descriptor from an operator-managed secret service and never written in the FormLogic data tree.

If persistent operator-file support is added later, it may contain only a passphrase/KEK that wraps the NSMK—never the raw NSMK or database key—and must ship with explicit file-copy, backup, rotation, and root-compromise threat documentation. If no supported unlock source is available, data hosting is disabled with data_key_store_unavailable. Never fall back to a plaintext key beside the database.

---

## 10. Desktop encrypted storage

### 10.1 Whole-file implementation

Introduce an EncryptedDatasetStore abstraction. The recommended first driver is SQLCipher in the Rust Desktop host, subject to a packaging/licensing/cross-platform spike.

Release requirements:

- a random 256-bit database key per dataset;
- key applied before any schema access;
- encrypted main database, WAL, rollback journal, and temporary database pages;
- temp_store=MEMORY where supported;
- best-effort logical secure-delete and checkpoint policy documented, with no claim of physical erasure on SSDs, snapshots, or copy-on-write filesystems;
- cipher_integrity_check during verification and Test Restore;
- no unencrypted transient export during snapshot, migration, or restore;
- zeroisation of key buffers where practical;
- fail closed on wrong key, corrupt header, unsupported cipher parameters, or unavailable secure store.

If SQLCipher cannot meet the supported-platform gate, use an audited encrypted SQLite VFS/container that passes the same tests. Do not silently downgrade to ordinary SQLite.

Record-level E2EE remains mandatory even with SQLCipher. SQLCipher protects local metadata and copied files; the __flenc envelope is what preserves E2EE across Cloud, relay, backup, and replica boundaries.

### 10.2 Local schema

Keep an API-compatible responses representation and add replication tables:

~~~text
dataset_meta
  dataset_id, form_id, account_id, protocol_version
  role, storage_epoch, primary_replica_id
  last_sequence, last_checkpoint_hash, health

responses
  existing private-response fields, including status/timestamps/metadata
  row_version
  lifecycle_state: active | trashed
  trashed_at nullable
  answers = exact __flenc envelope

replication_operations
  operation_id, storage_epoch, sequence, kind, entity_id
  operation_hash, placement_manifest_hash, encryption_manifest_hash
  write_lease_id, fencing_generation
  base_rev, rev, expected_row_version, row_version, cipher_hash
  canonical_operation = every signed field except signature
  origin_replica_id, previous_hash
  signer_key_id, signer_key_generation, signature
  committed_at

control_artifacts
  artifact_kind, artifact_id, artifact_hash, signed_bytes
  signer_key_id, signer_key_generation, verified_at, lifecycle_state

replication_inbox
  operation_id, received_at, applied_at, result_hash

replica_checkpoints
  replica_id, storage_epoch, applied_sequence
  logical_root, checkpoint_hash, signature, verified_at

tombstones
  entity_kind, entity_id, final_row_version, final_rev, final_cipher_hash
  delete_reason, operation_id, operation_hash, ledger_entry_hash
  storage_epoch, sequence, retain_until

tombstone_ledger_state
  coverage_sequence, ledger_root, independent_anchor_verified_at

idempotency_reservations
  idempotency_key, request_hash, result_ref, created_at

attachment_objects
  file_id, chunk_count, cipher_size, cipher_hash
  committed_sequence, deleted_sequence

backup_catalog
  backup_id, type, checkpoint, manifest_hash
  location_ref, created_at, verified_at
~~~

Add row_version, lifecycle_state, and trashed_at to both the Cloud per-form schema and Desktop schema before routing these operations. Existing rows migrate to row_version=1, lifecycle_state=active, trashed_at=NULL. A hard response.delete creates a separate tombstone; it is not represented by lifecycle_state=trashed.

The primary must commit the response/tombstone and replication operation in one SQLite transaction. It sends a durable acknowledgement only after the transaction, required fsync, and external high-water update complete.

### 10.3 Rollback detection outside the dataset database

SQLCipher integrity detects corruption and wrong keys, but it does not detect replacement of the whole database with an older valid encrypted copy. Maintain a monotonic high-water record outside each dataset database:

~~~text
datasetId, storageEpoch, lastAcknowledgedSequence,
lastOperationHash, checkpointHash, placementManifestHash,
tombstoneLedgerCoverageSequence, tombstoneLedgerRoot, updatedAt
~~~

Store the local copy in the OS secure store/TPM where available and store the signed acknowledged head in the Cloud control plane and any live replica. On startup, before promotion, and before accepting writes, compare the database head with every available independent anchor:

- database behind a known anchor: block and quarantine as rollback_detected;
- same sequence with another hash: block as history_diverged;
- database ahead only by locally committed but unacknowledged operations: verify the chain and reconcile through idempotent receipts before serving writes;
- no independent anchor reachable: allow verified read/export only by default and disclose that rollback detection cannot be guaranteed offline.

Update ordering is database commit and fsync, local high-water persistence, signed receipt, then Cloud receipt/high-water persistence before a 201 response. A crash at any boundary is recovered by replaying the same idempotency key and signed receipt; it never creates a second operation. Test replacement with an old database, old database plus old WAL, cloned data directory, secure-store loss, and Cloud-anchor mismatch.

### 10.4 Managed folder layout

Use the existing Desktop data directory and add one owned subtree:

~~~text
<desktop-data>/
  data/
    node/
      public-identity.json
      wrapped-dataset-keys.json
    forms/
      <opaque-dataset-id>/
        data.sqlite3.enc
        attachments/
          <opaque-file-id>.bin
        staging/
    sync/
      transfer-state.sqlite3.enc
    backups/
      data-only/
        <backup-id>.flbackup
      disaster-recovery/
        <backup-id>.flbackup
    quarantine/
    README.txt
~~~

Rules:

- filenames are opaque IDs, not form titles, respondent names, or field values;
- private node keys remain in the OS secure store, not in this folder;
- wrapped dataset keys are unusable without the Node Storage Master Key;
- staging is encrypted and bounded;
- quarantine is encrypted and never auto-uploaded;
- cloud heartbeat never receives the absolute local path;
- the Data workspace may show the local path and invoke the existing open_path command;
- the existing generic data-directory migration must not copy live databases. Add a data-host quiesce, checkpoint, backup-API copy, verify, atomic pointer switch, and rollback path.

The active forms folder is inspectable, but the product’s **quick backup folder** is data/backups. Build each package under encrypted staging, fsync files and the parent directory, verify its manifest/root, and atomically rename it to its final backup-id.flbackup name only when complete; partial packages never appear as ready. A disaster-recovery package contains the separately password-wrapped .flkeys member inside that one copy-safe unit, never raw keys. The UI must not imply that copying a running SQLite/WAL directory is a verified backup.

---

## 11. Dedicated data relay

The command, AI, and flow relays are too small and short-lived for database pages, attachments, or snapshots. Add a separate FormLogic Data Relay.

### 11.1 Required properties

- Desktop-initiated outbound connection; no public inbound Desktop port.
- Target is derived from the authenticated desktop_connection, never a payload deviceId.
- Short-lived admission token bound to owner, connection, node public key, capability, protocol version, and allowed dataset IDs.
- Admission lifetime at most five minutes with early rotation.
- Strict versioned envelopes with deny-unknown-fields.
- Content-addressed chunks, default 256 KiB.
- Per-chunk and full-object ciphertext hashes.
- Resumable upload/download with acknowledged ranges.
- Bounded buffers, explicit backpressure, quotas, and cancellation.
- Directional sequence/counter replay checks.
- Same-carrier-domain cursor reuse only; a reconnect under a different admission/node/domain must rebootstrap.
- No arbitrary file path, SQL, shell, plugin, or plaintext command.
- At-least-once delivery with idempotent effect.

### 11.2 Relay modes

**Live relay**

- Used by strict Desktop-only mode.
- Data exists in process/broker memory only while both sides are connected.
- If the node is not available, the API rejects rather than writing a durable Cloud row.
- Production clustering must use a no-persistence broker configuration or a direct live carrier whose durability properties are documented and tested.

**Encrypted queue**

- Used only when selected by policy.
- Stores ciphertext plus routing metadata in a dedicated queue.
- Has explicit TTL, byte/item quota, retry schedule, and dead-letter visibility.
- Deletes payload only after a content-bound durable receipt from the primary.
- Server backups must honour the queue’s documented retention; “deleted” wording must account for backup expiry.

**Replica transfer**

- Transfers committed logical operations or snapshots to an authorised Cloud/Desktop replica.
- Retention follows replica policy, not delivery-queue TTL.

### 11.3 Least-privilege scopes

Add scopes rather than widening connector:relay:

- data:node:heartbeat
- data:host
- data:replicate
- data:snapshot
- data:restore

Dataset assignment and storage epoch are checked in addition to OAuth scope.

---

## 12. Logical replication protocol

### 12.1 Operation envelope and complete row semantics

Use a versioned canonical JSON contract, with RFC 8785/JCS or an equally frozen canonical subset and shared JS/PHP/Rust vectors. The contract must represent the complete logical response row; copying only answers would lose status, timestamps, trash state, and authoritative metadata.

~~~json
{
  "protocol": "formlogic-data-sync/1",
  "operationId": "uuid",
  "datasetId": "form-id",
  "placementManifestHash": "hex",
  "encryptionManifestHash": "hex-of-signed-public-form-manifest",
  "storageEpoch": 4,
  "writeLeaseId": "uuid",
  "fencingGeneration": 19,
  "sequence": 3812,
  "kind": "response.envelope.put",
  "entityId": "record-id",
  "baseRev": 7,
  "rev": 8,
  "expectedRowVersion": 11,
  "rowVersion": 12,
  "cipherHash": "sha256-of-canonical-envelope",
  "payload": {
    "envelope": {},
    "updatedAt": "RFC3339"
  },
  "originReplicaId": "node-or-cloud-replica-id",
  "previousOperationHash": "hex",
  "createdAt": "RFC3339",
  "signerKeyId": "id",
  "signature": "base64"
}
~~~

Public cipherHash is calculated over canonical ciphertext/envelope bytes, never plaintext. Any optional plaintext digest stays keyed and inside the encrypted envelope.

Freeze these v1 operation meanings:

| Operation | Required effect and CAS |
| --- | --- |
| response.create | Insert the exact envelope plus canonical record ID, status, submittedAt, updatedAt, rowVersion, and strictly allowed server metadata; record ID and rev must match the envelope. |
| response.envelope.put | Replace only the envelope and updatedAt after expectedRev/baseRev and expectedRowVersion CAS; do not overwrite status/trash metadata. |
| response.status.set | Change only status/updatedAt using expectedRowVersion; no envelope rewrite. |
| response.trash / response.restore | Change the canonical trash state and timestamps using expectedRowVersion; restore is a new row-state version, not tombstone resurrection. |
| response.delete | Create a durable tombstone with reason user, retention, bulk_clear, or form_delete; hard deletion happens only after compaction gates. |
| attachment.put / attachment.delete | Commit or tombstone the encrypted attachment object and its response claim. |
| schema.put / manifest.put | Sequence an immutable, already signed control artifact before publication. |
| dataset.retention.run / dataset.bulk_clear | Bind the policy/cutoff or authorised request to the deterministic set of response.delete operations and a final checkpoint. |
| dataset.archive / dataset.unarchive | Change routability/retention state; never move or recreate a Cloud SQLite file behind StorageRouter. |
| dataset.recovery.restore | Owner-authorised recovery-fork transition that preserves the highest known global sequence/hash anchor, names the restored checkpoint/root, records the abandoned range/RPO, and establishes the new canonical state root without pretending history was rewound. |

The canonical row schema must be generated from and tested against the current Cloud responses schema plus the explicit row_version/lifecycle_state/trashed_at migration, including status, submitted_at, updated_at, and metadata. Unknown columns are a protocol-version error, not silently dropped data. Metadata gets an explicit key/type/size allowlist and may not smuggle answer plaintext into a server-readable field.

Form-key grants and vault material remain control/recovery objects. If copied into a snapshot, they remain in their existing wrapped/signed form.

### 12.2 Independent Desktop envelope validation

The Desktop primary does not trust the Cloud to have validated a Private response. Before persistence, Rust must parse the original JSON with duplicate-key rejection and apply the same frozen __flenc:1 contract as the PHP EnvelopeValidator:

- exact top-level and nested field allowlists; deny unknown fields;
- exact suite/version values, Base64 alphabet/padding rules, integer ranges, nonce/key/tag lengths, and total size limits;
- dataset/form ID, record ID, rev/baseRev, schema version/hash, and ingestion key ID/epoch equal the signed operation and locally verified control artifacts;
- encryptionManifestHash—distinct from the storage placementManifestHash—resolves to exactly one already committed immutable signed public-form manifest whose key ID/epoch and schema version/hash equal the envelope tuple; the frozen __flenc:1 envelope itself is not claimed to contain a manifest ID;
- ingestion epoch is active or inside the signed grace window at the operation’s admitted time;
- encrypted attachment IDs, chunk claims, sizes, and final-tag commitments bind to the same record/revision after E2EE P4;
- plaintext answers, unsupported suites, expired epochs, duplicate keys, and mismatched claims are rejected before the SQLite transaction.

Share adversarial fixture corpora across TypeScript, PHP, and Rust, including duplicate-key and ambiguous-number cases. The Desktop stores the exact accepted canonical envelope bytes; it never normalises a malformed input into something acceptable.

### 12.3 Ordering and durability

- The current primary assigns sequence numbers.
- Sequence is contiguous for the dataset and does not reset at an epoch change; the first operation under a new manifest follows the cutover checkpoint’s final operation hash.
- The operation hash chain binds order.
- Every operation signature resolves to an authority signing key/generation bound by the owner-signed placement manifest; a public key carried only in the operation is never trusted.
- The placement-manifest hash and write-lease ID bind each newly accepted write; the placement chain links epochs.
- Every replica applies operations transactionally and records operationId before acknowledgement.
- Duplicate operationId plus identical hash is success/no-op.
- Duplicate operationId plus different hash is sync_integrity_collision and blocks the lane.
- A sequence gap pauses apply and requests missing operations/snapshot.
- dataset.recovery.restore is the only state-root reset: it remains at highest-known global sequence + 1, chains from the anchored lastOperationHash, and must byte-for-byte match recoveryAuthorization in the new owner-signed placement manifest. Missing historical operation bodies may be marked abandoned, but their known sequence/hash anchor is not erased.
- No operation is acknowledged before durable persistence.
- Replication payloads are retained until every required live replica acknowledges them or a verified later snapshot makes compaction safe.
- Pending data is never silently age-discarded. Repeated failure becomes blocked/dead-letter state with operator redrive.

### 12.4 Checkpoints and logical roots

A checkpoint contains:

- dataset ID;
- storage epoch;
- last sequence;
- last operation hash;
- record count;
- tombstone count;
- independently replicated tombstone-ledger coverage sequence and root;
- attachment/chunk count;
- key/schema/manifest versions represented;
- canonical Merkle/logical root over encrypted objects;
- previous checkpoint hash;
- replica/signing identity;
- timestamp and signature.

The checkpoint signer and key generation must be authorised by the owner-signed placement manifest. A public key embedded in the checkpoint is informational, never its trust anchor. Do not compare raw SQLite file hashes. Equivalent logical data can have different SQLite page layouts.

### 12.5 Single-writer conflicts

Normal browser edits use expectedRev and the current primary, so two edits from the same base revision produce one success and one 409 conflict.

Replica apply rules:

- operationId plus identical signed operation hash: duplicate/no-op; the same operationId with any different bytes blocks the lane;
- every mutation of a live row requires expectedRowVersion equal to local rowVersion and rowVersion equal to local rowVersion + 1; response.create requires no row and starts at rowVersion 1;
- response.envelope.put additionally requires baseRev equal to the local envelope rev, rev equal to local rev + 1, and the signed cipherHash to match the new canonical envelope;
- response.status.set, response.trash, and response.restore advance rowVersion while retaining the exact envelope rev/cipherHash; they are not discarded as ciphertext duplicates;
- response.delete requires the live row’s expectedRowVersion, creates a tombstone that records the final rowVersion/rev/cipherHash and delete reason, and removes/compacts the row only under tombstone policy;
- same rowVersion with different signed state, same envelope rev with different cipherHash, or any non-contiguous rowVersion is divergent history and is quarantined;
- any mutation against a hard-delete tombstone is rejected; response.restore clears only the soft lifecycle_state=trashed state and does not resurrect a tombstone;
- stale storage epoch: reject;
- future storage epoch without a verified placement manifest: reject.

Active/active merge and CRDT behaviour are deferred. Do not fabricate field-level merges because the storage layer cannot inspect encrypted answers.

### 12.6 Schema, manifest, and key-epoch publication barrier

Form publication and key rotation are Cloud control-plane operations, while the storage primary orders dataset history. Prevent a public form from advertising a schema/manifest/ingestion epoch that its Desktop primary has not accepted:

1. Build and owner-sign the new immutable schema, public manifest, and key-epoch artifacts in a prepared, non-public state.
2. Send schema.put and manifest.put to the current primary under the current placement/lease.
3. The primary independently verifies signatures, ordering, and ingestion-grace rules, durably sequences them, and returns a signed head checkpoint.
4. Cloud persists that receipt and atomically publishes the public manifest only when the checkpoint includes the exact artifact hashes.
5. Every submission names the manifest/schema/ingestion epoch; the primary accepts only versions already committed to its control stream.

During rotation, the queue accepts an old epoch only through the explicitly signed grace deadline. Strict retirement blocks new admission immediately and surfaces queued old-epoch items for owner action; Cloud never rewraps them. Crash and retry tests must cover every point between prepare, primary commit, receipt persistence, and public publish.

### 12.7 Tombstones

Tombstones prevent a stale node from resurrecting deleted data. They remain until:

- every assigned replica has acknowledged a checkpoint containing the tombstone;
- the minimum retention window has elapsed;
- a baseline snapshot containing the tombstone exists;
- no archive/restore policy requires it.

A stale node older than the compaction boundary must receive a full snapshot/re-enrolment, not an incomplete incremental log.

To prevent an older recovery snapshot from resurrecting a later acknowledged deletion, maintain a privacy-minimised, append-only **tombstone continuity ledger** outside the primary dataset. Each primary-signed entry contains only dataset ID, opaque entity kind/ID, delete sequence, delete operation hash, reason class, previous-ledger hash, and signature—never an envelope, answer, title, filename, or local path. The ledger head/coverage is anchored in every acknowledged checkpoint and Cloud high-water record. By default the Cloud control plane holds it; a policy that excludes even this metadata must place an equally current copy on another independently surviving Data Node and accepts that old-snapshot promotion is unavailable when coverage cannot be proven.

A delete is reported as successfully finalised only after Cloud or another configured independent continuity authority has durably accepted the signed ledger entry/root. Keep ledger coverage for the dataset’s authoritative lifetime and for the retention window of every FormLogic-managed restorable snapshot. Account deletion eventually removes FormLogic-held ledger state under its disclosed policy; a later offline old package then remains a non-routable recovery/export until a trustworthy newer continuity source is supplied. This metadata/availability cost must be disclosed in strict Desktop mode.

---

## 13. Node enrolment, identity, and linked accounts

### 13.1 Same-account node enrolment

Extend the existing OAuth PKCE Desktop link:

1. Desktop generates or loads a data-node Ed25519 signing key and data-plane public identity.
2. User completes the existing system-browser OAuth flow.
3. Cloud creates/updates one desktop_connections row and a data_nodes extension row.
4. Browser shows device label, fingerprint, supported protocol/capabilities, and requested storage scopes.
5. User explicitly approves Data Hosting and owner-signs a node-authority certificate binding the node/connection ID, signing-key generation/fingerprint, transport-key fingerprint, workspace, capabilities, and expiry/rotation policy.
6. Desktop pins the owner/vault signing fingerprint from the authenticated pairing ceremony; Cloud cannot replace that root through a later roster response.
7. Node receives no datasets initially.
8. Per-form placement or replica wizard assigns datasets and includes the certified authority key in placement.

Never authorise from a self-reported instanceId alone. Bind the node ID, API key, desktop_connection ID, signing public key, owner/workspace, and admission subject.

### 13.2 Recommended node fields

~~~text
data_nodes
  id
  desktop_connection_id
  owner_user_id
  workspace_id nullable
  display_name
  signing_public_key
  signing_key_id
  signing_key_generation
  fingerprint
  transport_key_fingerprint
  owner_signed_certificate
  certificate_expires_at
  protocol_min / protocol_max
  capabilities_json
  roster_revision
  last_seen_at
  last_storage_heartbeat_at
  status
  revoked_at
~~~

### 13.3 Three different sharing cases

**Several Desktops under one account**

- First supported case.
- Each node separately enrolled and revoked.
- Dataset assignments are explicit.

**Several users in one organisation/workspace**

- Storage permission follows workspace/form administration.
- Decryption permission still follows signed Form Key grants.
- A node may be storage-only for forms its operator cannot decrypt.

**Cross-account replication**

- Never inferred from “linked” accounts.
- Requires an explicit per-form storage grant naming the target account/node public identity and role.
- Grant acceptance updates the owner-signed placement/authority chain and requires the target node to pin the source owner fingerprint; a mutable account link alone is insufficient.
- Storage-only grant permits ciphertext replication, not viewing.
- Viewing requires a separate signed E2EE Form Key grant and reciprocal fingerprint verification.
- Initial release may keep this behind a feature flag until E2EE P5 team grants are complete.

### 13.4 Revocation actions

Expose separate actions:

- **Unlink connection:** revoke API/admission credentials.
- **Revoke node:** stop all new data-plane sessions and signed operations.
- **Remove replica assignment:** stop receiving dataset changes.
- **Revoke decryption access:** atomically create FK[e+1], grant it only to remaining authorised members, rewrap under FK[e+1] every retained historical ingestion secret for every epoch referenced by extant records/backups, mint a new active ingestion keypair, publish through the schema/manifest barrier, and strictly retire the old FK/active-ingestion epoch by default. Any explicitly selected grace window is a disclosed continued-access window, not immediate revocation. This prevents future access; it cannot erase plaintext or old keys already copied by the removed member.
- **Request local wipe:** best effort, acknowledged by the node; never claim guaranteed erasure.
- **Forget exported backup:** informational only; FormLogic cannot erase customer-controlled media.

---

## 14. Web API routing

### 14.1 StorageRouter

Add a StorageRouter in front of every Private response path:

~~~text
resolve(formId, operation, caller)
  -> verify Private form
  -> load and verify placement manifest
  -> select current primary or permitted verified fallback
  -> enforce storage epoch, node assignment, availability and scope
  -> CloudEncryptedStore OR DesktopDataGateway
~~~

Do not call SQLiteConnection::getFormDatabase for a Desktop-primary form except as part of an explicitly assigned Cloud replica, migration source, retained rollback copy, or cleanup job.

### 14.2 Existing routes that must keep working

- public create;
- authenticated list/get;
- create/update/delete;
- status changes and trash/restore;
- retentionDays and purgeExpiredIfDue scheduling;
- bulk clear and account/form deletion;
- form trash snapshot/restore paths that currently move or recreate Cloud SQLite files;
- batch/offline drains;
- app-runtime/external API paths;
- response counts and pagination;
- account export/restore;
- ciphertext-safe SQLite/logical exports;
- Private client-side CSV export;
- attachment claim/commit/serve after E2EE P4.

The storage backend must return one stable logical wire format so FormResponses.tsx, useDecryptedResponses, the crypto worker, and private export do not care where ciphertext lives.

### 14.3 Public create outcomes

| Result | HTTP/API behaviour | Submitter UX |
| --- | --- | --- |
| Primary durably stored | 201 with record ID and receipt | Normal success. |
| Explicit queue accepted | 202 with opaque receipt/status token and expiry | “Encrypted response received and awaiting delivery.” |
| Strict primary offline | 503 desktop_primary_offline with Retry-After | Honest retry message; no Cloud fallback. |
| Queue full | 507/503 encrypted_queue_full | Owner action required; no loss claim. |
| Ingestion epoch retired | 409 key_epoch_retired | Re-fetch form and re-enter/reseal if possible. |
| Migration brief fence | 409/503 storage_moving with Retry-After or queue according to policy | “Storage is moving; retry shortly.” |

Queue status must be content-free. A public status token cannot enumerate forms, records, or nodes.

### 14.4 Query limitations

Private-form behaviour remains:

- list/page by non-content columns;
- client-side decrypt/filter/sort/search;
- no answer-json server filters;
- no server-side calculated fields or content reports;
- no Cloud webhook/AI/flow access without future selective disclosure;
- no silent empty results when Desktop is offline.

Counts may be cached as metadata when allowed. A cached count must be labelled with its checkpoint and freshness.

### 14.5 Account exports and deletion

An account export must:

- include Desktop-hosted datasets only after the node produces a verified snapshot;
- report a blocking/partial state if an assigned node is unavailable;
- never silently omit Desktop-primary data;
- preserve IDs, epochs, manifests, grants, and checkpoint metadata.

Deleting a form with Desktop replicas must create a signed dataset retirement/tombstone operation, apply retention policy, and separately schedule Cloud/node cleanup. “Delete now” cannot promise erasure from customer exports or expired-but-not-yet-purged infrastructure backups.

For retention, the Cloud control plane owns the configured policy and schedule, while the current storage primary is the sole deletion authority. It receives an idempotent command bound to policy version and cutoff, independently selects eligible rows from canonical submittedAt metadata, emits one response.delete tombstone per row plus a dataset.retention.run marker, and returns a checkpoint. Bulk clear and form trash use the same primary-sequenced tombstone/archive path. Code such as purgeExpiredIfDue, bulk clear, and form-trash ZIP/restore must never bypass StorageRouter or create an empty Cloud database for a Desktop-primary form.

### 14.6 Distributed write finalisation and derived Cloud metadata

A Desktop-primary write spans two durability domains: the Desktop dataset and Cloud routing/idempotency/projection state. They cannot be one database transaction. Make the dataset primary the source of truth and treat MySQL response_metadata, counts, and analytics metadata as rebuildable projections.

Persist this Cloud-side state machine before dispatch:

~~~text
received
reserved
dispatched
primary_committed
projection_pending
complete
blocked
expired
~~~

The reservation is unique on dataset ID plus idempotency key and stores request hash, operation kind, placement-manifest hash, epoch, and result/receipt reference—never plaintext. Unlike the existing fail-open submission idempotency path, Desktop-primary writes fail closed if this reservation cannot be made. The primary atomically commits the row/tombstone, operation-log entry, idempotency result, and outbox item, then returns the same signed durable receipt for every identical retry. A changed payload under the same key is a permanent collision.

Cloud verifies the receipt against the owner-authorised primary key and lease, durably records primary_committed and the signed high-water head, and only then may return 201. A response.delete finalisation also persists its signed privacy-minimised tombstone-ledger entry/root to the configured independent continuity authority before success. Projection update may finish asynchronously; failure never compensates by deleting the authoritative Desktop record. A reconciler consumes the signed operation stream, repairs response_metadata/count projections, and advances complete. If Cloud loses the receipt after Desktop commit, the caller receives a retryable write_outcome_unknown/status token rather than a false failure; redelivery of the same idempotency key recovers the original receipt.

Migration uses the same reservation ledger: it finalises every operation through the signed cutover checkpoint, accepts an old-epoch delayed receipt only when already covered by that checkpoint, and drains or transactionally retargets uncommitted 202 queue reservations under their original idempotency keys.

Fault-inject and restart at each boundary: reservation commit, relay dispatch, Desktop row commit, Desktop outbox/high-water update, receipt send, Cloud receipt commit, projection commit, and HTTP response. The acceptance test is one authoritative operation and one stable user-visible result under every crash/retry ordering.

---

## 15. Offline behaviour and availability

### 15.1 Offline submission policies

**Reject**

- no durable Cloud response payload;
- deterministic 503 while primary is unavailable;
- appropriate for the strictest storage requirement;
- owner sees missed/rejected submission counters only if they can be recorded without retaining payload.

**Encrypted queue**

- default recommendation: seven days;
- TTL and quotas shown before enabling;
- ciphertext stored in Cloud until Desktop durable acknowledgement;
- queue sweeper deletes acknowledged/expired payloads and preserves content-free audit state;
- old ingestion epochs follow existing grace/retirement rules;
- expiry/dead letters are visible in Web and Desktop.

**Permanent Cloud replica**

- modelled as a live replica, not an offline-queue setting;
- continues after Desktop acknowledgement;
- provides read fallback and easier promotion when current.

### 15.2 Offline reads

- No verified fallback: return desktop_data_unavailable with last-seen and current queue policy.
- Verified Cloud/live replica: serve only up to its acknowledged checkpoint and state that it is a fallback.
- Never auto-promote a stale replica merely to make an error disappear.

### 15.3 Desktop retry model

Adapt the proven Aokie outbox discipline:

- WAL plus synchronous durability;
- write-before-send;
- stable content-bound idempotency key;
- exponential backoff with jitter;
- bounded per-attempt buffers;
- pending, retrying, blocked, and dead-letter states;
- explicit redrive;
- no age-based discard of unacknowledged dataset operations;
- attempt generation to prevent ack/retry races;
- health degradation when replay worker stalls.

Transport outbox, replication log, and backup/snapshot catalog remain separate stores.

---

## 16. Moving Cloud to Desktop or Desktop to Cloud

### 16.1 Migration state machine

~~~mermaid
stateDiagram-v2
  [*] --> Requested
  Requested --> Preflight
  Preflight --> Baseline
  Baseline --> CatchUp
  CatchUp --> Cutover
  Cutover --> Verify
  Verify --> Observe
  Observe --> Complete
  Preflight --> Failed
  Baseline --> Failed
  CatchUp --> Failed
  Cutover --> Rollback
  Verify --> Rollback
~~~

Persist a more detailed internal state:

~~~text
requested
preflight
destination_prepared
baseline_snapshotting
baseline_transferring
baseline_verified
catching_up
cutover_ready
writes_fenced
epoch_switched
post_cutover_verifying
observation
cleanup_pending
complete
rolling_back
failed
cancelled
~~~

### 16.2 Preflight

Verify:

- requester owns/administers the form and vault is unlocked;
- source and destination protocol/crypto/schema versions are compatible;
- target node is enrolled, assigned, healthy, and not revoked;
- target secure key store and encrypted database driver are available;
- sufficient target and temporary disk space;
- current source checkpoint is valid;
- current placement trust chain, authority key, high-water anchor, and write lease are valid;
- no other migration/promotion/key rotation conflicts;
- attachment support matches the form;
- queue/availability policy has been selected;
- a recent verified backup exists or the wizard creates one;
- source data is E2EE Private-form data only.

### 16.3 Baseline while writes continue

1. Source assigns baseline sequence N.
2. Source opens a consistent read transaction/SQLite backup snapshot at N.
3. New writes continue and append operations N + 1 onward.
4. Snapshot is exported as canonical encrypted logical objects and chunks.
5. Destination imports into a new encrypted staging database.
6. Destination verifies file/chunk hashes, operation range, counts, schema/manifests, and logical root.
7. Destination reports a signed baseline receipt.

### 16.4 Catch-up and cutover

1. Stream operations after N until destination is close to source.
2. Enter a brief gateway write fence; public behaviour follows the selected queue/retry policy.
3. Drain final committed operations, establish signed cutover checkpoint M with lastOperationHash H, and verify exact source/destination equality.
4. Reconcile/finalise every Cloud write reservation and known receipt through M. A delayed old-epoch receipt may be accepted after the switch only as finalisation of an existing identical reservation when its sequence/hash is already covered by (M,H); it cannot append data. Any old receipt beyond M or with another hash is rejected/quarantined.
5. Durable 202 queue items that have not become operations are not part of M. Either drain them before cutover or transactionally retarget their reservation/payload to the new manifest/epoch/primary under the same content-bound idempotency key; verify their encryption-manifest/ingestion epoch remains active or inside grace.
6. Owner signs a new placement manifest with storageEpoch + 1, cutover checkpoint (M,H), and the new primary.
7. Obtain a signed old-primary release, or revoke/wait for its write lease plus skew margin to expire; no new-primary lease overlaps it.
8. Control plane atomically changes canonical routing to the new manifest/epoch and issues the new primary a bound lease.
9. Cloud rejects any old-manifest operation/receipt not exactly covered by the cutover-finalisation exception. The old node becomes read-only/replica after learning the manifest; late history is quarantined rather than merged.
10. Execute a canary create/read/update/delete round-trip using ciphertext only and persist the new independent high-water head.
11. Leave the old source as a rollback replica for the observation period.

### 16.5 Verification

Compare:

- dataset/form/account binding;
- storage epoch and placement-manifest chain;
- response IDs, revisions, ciphertext hashes, and counts;
- tombstones;
- attachment IDs, chunks, and ciphertext hashes;
- schema versions and hashes;
- ingestion/key epochs represented;
- last operation sequence/hash;
- checkpoint logical root.

Never use the raw SQLite database hash as equivalence proof.

### 16.6 Failure and rollback

- Before epoch switch: source remains primary; discard or resume destination staging.
- After source fence but before atomic switch: un-fence source only if the signed epoch has not changed.
- After epoch switch: rollback is another signed epoch change, never a pointer rewind.
- After epoch switch, late old-epoch local commits are quarantined; they are not proof that the caller received success and they are not automatically replayed into the new chain.
- Every phase is idempotently resumable.
- Old-primary cleanup is never automatic during the observation window.
- A migration cancellation does not delete the last verified copy.

### 16.7 Source cleanup

After the default seven-day observation window:

- require at least one current primary and one verified backup;
- show exactly which replicas/snapshots/queues will remain;
- remove the source replica only after explicit confirmation;
- checkpoint/truncate local WAL and delete through the encrypted-store path;
- apply documented Cloud backup/queue retention;
- record that manually copied customer exports cannot be erased.

The reverse Desktop-to-Cloud path uses the same state machine and gates.

---

## 17. Multi-Desktop replication and promotion

### 17.1 Roles

| Role | Live writes | Continuous sync | Normal reads | Promotion |
| --- | --- | --- | --- | --- |
| Primary | Yes | Source | Yes | Already primary |
| Live replica | No | Yes | Only as verified fallback | Eligible when exactly current |
| Backup replica | No | Scheduled/batched | No | Requires catch-up/verification |
| Archive | No | No after sealed snapshot | Historical restore only | Not directly |
| Revoked | No | No | No | Never |

### 17.2 Promotion

V1 is manual:

1. Verify candidate’s epoch, sequence, checkpoint hash, logical root, and integrity status.
2. Ensure the old primary signs a lease release, or wait for its last lease plus skew margin to expire. If it is unavailable, require an explicit recovery acknowledgement showing the last verified checkpoint and unacknowledged-window RPO.
3. Owner unlocks vault and signs storageEpoch + 1 placement manifest, including the candidate authority/transport key fingerprints.
4. Cloud atomically publishes canonical routing. It rejects old-manifest operations/receipts except an exact idempotent finalisation already covered by the signed cutover checkpoint.
5. Candidate accepts writes only after verifying the signed manifest, owner trust chain, independent high-water mark, and its non-overlapping lease.
6. Other replicas rebind to the new primary/checkpoint chain; divergent/late old history is quarantined.

When the old primary is unavailable and the candidate is behind the highest independently anchored head, offer **Recover from this checkpoint** with an exact potential-data-loss boundary. Recovery is a signed fork, never a rewind:

1. Identify the highest known global sequence/hash anchor (K,H) from Cloud high-water, a live replica, or signed receipts, and the restored checkpoint (R,HR); list the abandoned range R+1…K and any additional uncertainty. Obtain an independent tombstone-continuity ledger whose signed coverage/root is proven through K; otherwise recovery remains read-only/quarantined.
2. In encrypted staging, calculate the snapshot logical root and the recovered root after all known tombstones are reapplied. Owner signs a new storage epoch/recovery placement that names both roots, both sequence/hash anchors, tombstone-ledger coverage/root, reason, actor, and acknowledged RPO; normal writes remain fenced.
3. Reapply every ledger tombstone through K that is absent from the restored state, then at global sequence K+1 commit dataset.recovery.restore with previousOperationHash=H and payload exactly matching recoveryAuthorization: (R,HR), both logical roots, ledger coverage/root, abandoned range, uncertainty, and reason. This is the sole explicit rule allowed to bridge a missing/lost range.
4. Persist the transition in independent high-water/audit state, reconcile reservations in the abandoned range as lost/unknown without fabricating success, issue the new lease, and only then clear the unpublished/write-blocked recovery state.

If K/H itself cannot be established, use the highest verifiable anchor and disclose the additional unknown range; do not claim exact RPO or seamless failover. If signed tombstone coverage through that anchor cannot be established, do not promote the restore or accept writes. Replicas holding abandoned operations preserve them in quarantine/archive for client-side recovery, not automatic merge.

Automatic failover may be added later only with:

- a delegated, narrowly scoped placement-signing mechanism;
- a reviewed lease/quorum design stronger than the v1 Cloud-issued lease;
- exact currentness proof;
- split-brain chaos tests;
- an explicit product policy.

### 17.3 Replica catch-up sources

Priority:

1. current primary;
2. verified Cloud live replica, if policy permits;
3. another verified live replica at the same checkpoint;
4. latest snapshot plus subsequent operation log.

In strict no-Cloud-log mode, the primary owns the authoritative log. If it is offline, an out-of-date backup waits; this limitation is visible.

---

## 18. Backup and recovery

### 18.1 Separate operations

- **Replicate:** continuously maintain another live copy.
- **Snapshot:** create an immutable point-in-time package.
- **Archive:** retain a historical package under a policy.
- **Move primary:** change live authority.
- **Restore:** verify in an isolated namespace, continue an exact chain, replace, or recover a node from a snapshot.

Never hide these behind one “Sync” button.

### 18.2 Encrypted data-only backup

Contains:

- canonical __flenc response envelopes;
- encrypted attachments;
- tombstones and operation/checkpoint metadata;
- exact schema snapshots and signed manifests;
- wrapped/public key metadata needed to interpret the dataset;
- signed backup manifest.

Contains no raw Form Key, ingestion secret, response DEK, node private key, API key, or local SQLCipher key.

The portable package is logical rather than a copy of the SQLCipher file. A restore generates a fresh local database key, imports ciphertext, and re-encrypts the local container. This avoids making a machine-bound SQLCipher key part of every backup.

### 18.3 Disaster-recovery backup

Contains the data-only backup plus recovery/encrypted-key-bundle.flkeys.

The .flkeys bundle is a **portable encrypted vault backup**, not backup-password-only account recovery. Its format v1 freezes:

- password preparation through one specified PRECIS OpaqueString/NFC-to-UTF-8 implementation, with no trimming and shared non-ASCII vectors;
- a random 16-byte crypto_pwhash salt and libsodium crypto_pwhash_ALG_ARGON2ID13, 32-byte output, with stored opslimit and memlimit only—no invented parallelism field;
- new-export default opslimit=3 and memlimit=64 MiB, optionally raised to a profiled 256 MiB on capable clients; import/new-export bounds opslimit=3–10 and memlimit=64–512 MiB reject weak exports and malicious resource-exhaustion files;
- domain-separated 32-byte encryption and backup-root MAC keys derived from the Argon2 root with HKDF-SHA-256 and labels formlogic-flkeys:1:enc and formlogic-flkeys:1:root;
- a fresh random 24-byte XChaCha20-Poly1305 nonce;
- JCS of the versioned clear header—account ID, vault ID, backup ID, salt, KDF parameters, nonce, key/wrapper generations, and logical backup root—as AAD;
- HMAC-SHA-256 under the derived root key over flbackup-root:1 plus backup ID and the backup logical root, in addition to the AEAD tag;
- contains the already-wrapped vault record, encrypted private-key bundle, recovery wrapper, signed grants, wrapped ingestion secrets, and required public manifests;
- contains no raw vault passphrase or raw recovery kit;
- is verified before the backup is marked complete.

Use the same libsodium-compatible construction and golden vectors in JS/PHP/Rust. If the browser worker cannot allocate the 64 MiB minimum, block export and hand off to the signed Desktop/offline recovery utility; never silently lower the KDF. Selecting another Argon2 implementation requires a separately versioned N0 crypto spike and cannot change format v1 in place.

Restoring the package and decrypting form data remain separate:

1. backup password imports the recovery bundle;
2. vault passphrase or recovery kit unlocks the E2EE vault.

Scheduled backups are data-only by default. Scheduled disaster-recovery backups require explicit opt-in and secure local retention of the backup password; manual export is preferred.

Mark an existing bundle **stale—re-export recommended** whenever the vault record version, recovery-wrapper version, owner signing-key generation, grant set, Form Key epoch, or ingestion-secret wrapper generation changes. Stale does not mean corrupt; it means the bundle may not recover the newest authority/key state.

### 18.4 Portable package layout

~~~text
FormLogic Backup/
  backup-index.json
  manifests/
    backup-manifest.json
    checkpoint.json
    placement-manifest.json
  data/
    responses.ndjson.enc
    tombstones.ndjson
    operations.ndjson
    attachments/
      <opaque-file-id>/
        <chunk>.bin
  recovery/
    encrypted-key-bundle.flkeys
~~~

The recovery directory is absent for data-only backups.

### 18.5 Backup manifest

The signed manifest includes:

- format and protocol version;
- backup type;
- backup/account/vault/source-node IDs;
- datasets and form IDs;
- creation time;
- source storage epoch, checkpoint, last sequence, and last operation hash;
- response/tombstone/attachment/chunk counts;
- schema, manifest, ingestion, and Form Key epochs represented;
- per-file ciphertext hash and size;
- canonical logical root;
- incremental parent, if any;
- signer key ID/generation, owner-signed authority-certificate/placement-chain reference, and signature;
- required restore capabilities.

The signer public key inside a package is never a sufficient trust anchor. An authenticated restore must validate the backup signature through an owner-signed node/Cloud authority certificate to an owner/vault fingerprint pinned independently of the package. A disaster-recovery package also verifies its backup-root MAC after password derivation. If a data-only package is opened offline without an independent anchor, the UI requires the expected owner fingerprint and labels the result **Integrity checked; provenance unverified** until that fingerprint/chain is verified. Do not call a self-signed package authenticated.

### 18.6 Cloud backup

Desktop-to-Cloud snapshot upload stores only the portable ciphertext package unless the user explicitly elects to upload the independently wrapped disaster-recovery bundle.

Cloud-to-Desktop backup downloads a verified logical snapshot and writes it to the copy-safe backups folder. It does not silently change placement or make Desktop a live replica.

### 18.7 Test Restore

Provide two levels:

**Structural Test Restore**

- verify manifest signature, hashes, account binding, versions, object counts, checkpoints, and import into an isolated temporary encrypted database;
- requires no response decryption key;
- never mutates live data.

**Full Recovery Test**

- additionally unlock the .flkeys bundle and vault;
- decrypt and authenticate a user-selected sample or every object inside the existing browser crypto worker or a separately signed offline recovery utility; the storage service itself is not granted a Form Key;
- verifies attachment final tags and inner hashes after E2EE P4;
- clears temporary plaintext/worker state on completion;
- records only success/failure and coverage, not data.

### 18.8 Restore choices

- Import into a non-routable verification/recovery namespace that preserves the original datasetId, formId, record IDs, and AAD bindings.
- Continue/merge into the same dataset only when the package is an exact signed hash-chain continuation of the destination checkpoint.
- Replace the current dataset after creating a safety snapshot; if the restored checkpoint is behind a known high-water anchor, use the signed dataset.recovery.restore fork procedure rather than lowering sequence/root.
- Enrol a replacement Desktop node and restore it as a replica.

A verification namespace is not a second live form. The current __flenc:1 AAD binds formId/recordId/schema, so cloning as a genuinely new form/dataset requires an authorised browser-side decrypt-and-reseal workflow with new IDs, keys, manifests, and explicit audit; it is outside automatic restore. Divergent branches are quarantined for manual, client-side comparison and resealing. They are never server-merged by timestamp, revision guess, or ciphertext overwrite.

Dataset restore must not roll back the live encryption control plane. A package may import missing immutable historical Form Key grants and ingestion-secret wrappers required to read its own checkpoint, but it cannot overwrite a newer owner-key generation, member/node revocation ledger, grant set, active/retired FK state, active ingestion epoch, or public-manifest state. If no newer authoritative control state survives and an older disaster-recovery package must become authoritative, keep the form unpublished and write-blocked until the owner creates a fresh FK, creates a fresh ingestion keypair, re-enrols current members/nodes, rewraps all retained historical ingestion secrets, and publishes a new manifest. Restoring a pre-removal backup must never make the removed member eligible to decrypt a later submission.

Restore must never:

- reduce storage epoch;
- overwrite a newer checkpoint silently;
- resurrect an acknowledged tombstone covered by the authoritative continuity ledger; unacknowledged late local deletes remain inside the explicitly disclosed uncertain/lost range;
- remint Private-form IDs;
- skip missing key epochs;
- continue after unsupported crypto/schema format;
- mutate live data after a failed verification.
- replace newer encryption-control/revocation state with an older backup copy.

---

## 19. Desktop Data workspace

Add data to DesktopSidebar.SectionId in the **Manage** group, render DataPanel.tsx from App.tsx, and follow the existing deferred-panel/polling/cache conventions.

### 19.1 Overview

Cards:

- Node identity and fingerprint.
- Cloud link and data-plane connection state.
- Locally hosted forms.
- Total encrypted records, attachments, and storage.
- Pending inbound/outbound operations.
- Temporary Cloud queued submissions.
- Last verified checkpoint.
- Independent high-water and tombstone-continuity coverage.
- Last successful backup.
- Last Structural Test Restore and Full Recovery Test.
- Secure key-store/SQLCipher status.
- Protocol/update incompatibility warning.

### 19.2 Form data table

| Column | Meaning |
| --- | --- |
| Form/App | Display name resolved locally; no title in filename. |
| File | Opaque encrypted SQLite filename. |
| Role | Primary, live replica, backup, archive. |
| Placement | User-facing policy summary. |
| Records/files | Metadata counts at the displayed checkpoint. |
| Size | Local encrypted disk usage. |
| Checkpoint | Epoch and sequence. |
| Sync | Current, syncing, behind, waiting, blocked, version-blocked, corrupt. |
| Pending | Inbound/outbound/failed operation counts. |
| Last update | Operational timestamp. |
| Backup | Age and last tested status. |

“Current” requires the node’s verified checkpoint to equal the latest primary-signed head checkpoint anchored to the current owner-signed placement manifest and independent high-water record.

Per-form actions:

- Open in Web App.
- View managed folder.
- View latest backup folder.
- Sync now.
- Verify integrity.
- Create data-only snapshot.
- Create disaster-recovery backup.
- Test latest backup.
- Change placement / Move primary.
- Disconnect replica.

No View Records, Edit, Delete Record, or response preview action is added.

### 19.3 Linked Data Nodes

Show:

- device label and fingerprint;
- connection/data-plane state;
- protocol and Desktop versions;
- per-form roles/grants;
- last seen and last checkpoint;
- lag and pending counts;
- secure-store/storage capability;
- revoke, remove replica, or promote actions when safe.

### 19.4 Keys and recovery

Show:

- vault/recovery setup state;
- E2EE epochs covered by the latest bundle;
- local database-key health without exposing keys;
- last encrypted recovery-bundle export;
- bundle freshness against vault/recovery/key generations and verified owner-signing provenance;
- last recovery verification;
- Export, Import, Test, and Replace recovery bundle actions.

Sensitive actions require reauthentication, vault unlock where needed, and a precise scope confirmation.

### 19.5 Status vocabulary

Use explicit phases:

- configured;
- connecting;
- connected;
- reconnecting;
- admission_refresh;
- syncing_baseline;
- catching_up;
- current;
- waiting_for_primary;
- primary_offline;
- queueing;
- blocked;
- version_blocked;
- integrity_failed;
- rollback_detected;
- provenance_unverified;
- write_lease_unavailable;
- storage_full;
- revoked;
- stopped.

Surface lastError, changedAt, reconnectAttempt, pending/retrying/blocked/dead counts, and an operator-safe retry/redrive action.

---

## 20. Web App UX

### 20.1 Form Settings → Data Storage

Show:

- current primary;
- replica cards;
- offline-submission policy;
- Cloud queue TTL/quota;
- latest authoritative checkpoint;
- availability/last seen;
- backup status;
- Change placement button.

Do not use an on/off toggle. Use a wizard:

1. Choose desired preset.
2. Choose node(s).
3. Choose offline and fallback policy.
4. Review what Cloud will retain.
5. Verify backup and target health.
6. Unlock vault and sign placement.
7. Show migration progress.
8. Verify and enter observation period.

### 20.2 Form and response badges

Examples:

- Cloud primary.
- Desktop primary · Online.
- Desktop primary · Queueing encrypted submissions.
- Desktop primary offline · Submissions paused.
- Cloud + Desktop current.
- Moving to Office PC · 83%.
- Replica behind · 214 operations.

### 20.3 Offline response screens

Never display an endless spinner. Show:

- which node/role is unavailable;
- last seen;
- whether encrypted submissions are queued or rejected;
- whether a verified fallback exists;
- retry action;
- owner-only link to Data Storage.

### 20.4 Destructive-action language

Differentiate:

- Remove Cloud live replica.
- Delete queued ciphertext after acknowledgement.
- Delete Cloud rollback copy after observation period.
- Revoke Desktop connection.
- Request Desktop local deletion.
- Remove recovery bundle.

Each dialog explains infrastructure backup expiry and customer-controlled copies.

---

## 21. Proposed backend/API surface

Exact paths may follow current routing style, but keep the domains separate.

### 21.1 Control plane

| Method/path | Purpose |
| --- | --- |
| GET /api/data-nodes | List authorised nodes and storage health. |
| GET /api/data-nodes/{id} | Node details, capabilities, assignments, checkpoints. |
| POST /api/data-nodes/{id}/approve | Approve data-host capability/fingerprint. |
| DELETE /api/data-nodes/{id} | Revoke node credentials; no implied data deletion. |
| POST /api/data-nodes/{id}/wipe-request | Best-effort signed local wipe request. |
| GET /api/forms/{id}/data-placement | Current signed placement and replica health. |
| PUT /api/forms/{id}/data-placement | CAS update with owner-signed manifest. |
| POST /api/forms/{id}/data-migrations | Begin a verified move/copy job. |
| GET /api/data-migrations/{id} | Progress, checks, errors, rollback window. |
| POST /api/data-migrations/{id}/cancel | Cancel before cutover where safe. |
| POST /api/data-migrations/{id}/rollback | Create a new signed rollback epoch. |
| POST /api/forms/{id}/snapshots | Create Cloud/Desktop snapshot job. |
| POST /api/snapshots/{id}/test-restore | Structural/full recovery test. |
| GET /api/data-writes/status/{opaqueToken} | Content-free finalisation state for a committed/unknown/queued idempotent write. |

### 21.2 Node API

| Method/path | Purpose |
| --- | --- |
| POST /api/v1/data-node/heartbeat | Authenticated capability/health/checkpoint heartbeat. |
| POST /api/v1/data-node/admission | Mint short-lived, node-bound data session. |
| POST /api/v1/data-node/write-leases | Mint/renew a short manifest/epoch/primary-bound write lease. |
| GET /api/v1/data-node/assignments | Signed dataset assignments/manifests. |
| GET /api/v1/data-node/requests/pending | Long-poll/live carrier bootstrap where needed. |
| POST /api/v1/data-node/requests/{id}/claim | Target- and epoch-bound claim. |
| POST /api/v1/data-node/requests/{id}/receipt | Durable content-bound completion. |
| POST /api/v1/data-node/transfers | Establish resumable object transfer. |
| PUT /api/v1/data-node/transfers/{id}/chunks/{n} | Upload an authenticated chunk. |
| GET /api/v1/data-node/transfers/{id}/chunks/{n} | Download an authenticated chunk. |
| POST /api/v1/data-node/checkpoints | Publish signed applied checkpoint. |

### 21.3 Error codes

- data_node_not_assigned
- data_node_offline
- desktop_primary_offline
- encrypted_queue_full
- encrypted_queue_expired
- storage_epoch_stale
- storage_epoch_unknown
- write_lease_expired
- write_lease_conflict
- placement_signature_invalid
- placement_conflict
- migration_in_progress
- storage_moving
- replica_not_current
- replica_integrity_failed
- sync_sequence_gap
- sync_integrity_collision
- sync_protocol_unsupported
- data_key_store_unavailable
- encrypted_store_unavailable
- backup_manifest_invalid
- backup_provenance_unverified
- backup_incomplete
- recovery_bundle_invalid
- recovery_bundle_stale
- restore_would_overwrite_newer
- rollback_detected
- history_diverged
- write_outcome_unknown
- cross_account_storage_grant_required

---

## 22. Cloud database/control schema

Conceptual additions:

~~~text
data_nodes
data_node_dataset_assignments
data_node_authority_certificates
data_placement_manifests
data_replicas
data_replica_checkpoints
data_tombstone_continuity_ledger
data_tombstone_continuity_heads
data_write_authority
data_write_leases
data_write_reservations
data_write_receipts
data_projection_reconciliation
data_migration_jobs
data_migration_events
data_delivery_queue
data_delivery_receipts
data_transfer_sessions
data_transfer_chunks
data_snapshot_catalog
data_restore_jobs
data_storage_grants
data_node_wipe_requests
data_dataset_high_water
~~~

Rules:

- foreign keys tie node to desktop_connections and authenticated owner/workspace;
- unique current primary per dataset/epoch;
- placement updates are CAS-protected;
- data_write_authority has one locked row per dataset with a monotonic fencing_generation and the current lease/manifest/epoch/primary fingerprint;
- lease issue/release uses a serialised transaction on that dataset row and permits no unexpired lease across any old/new epoch or primary; expiry is evaluated inside the transaction against trusted service time and cannot be enforced by a narrow UNIQUE constraint alone;
- write reservations fail closed, bind request hash/idempotency/manifest/epoch, and retain no plaintext;
- Cloud response_metadata/count rows are rebuildable projections, not Desktop-primary truth;
- tombstone-continuity entries are append-only, primary-signed, privacy-minimised, and their coverage/root is anchored in checkpoints/high-water before a delete reports success;
- queue idempotency is scoped by dataset and request hash;
- payload columns are opaque binary and excluded from normal ORM/debug logging;
- transfer rows have TTL and quota;
- checkpoint metadata is immutable;
- data-node deletion revokes credentials before asynchronous replica cleanup;
- all cross-account assignments require an explicit storage grant;
- no local filesystem path is stored.

---

## 23. Repository implementation map

### 23.1 FormLogic Desktop Rust

Add:

~~~text
formlogic/desktop/src-tauri/src/data/
  mod.rs
  identity.rs
  key_store.rs
  encrypted_sqlite.rs
  envelope_validator.rs
  schema.rs
  store.rs
  operations.rs
  checkpoints.rs
  relay.rs
  admissions.rs
  leases.rs
  replication.rs
  outbox.rs
  snapshots.rs
  restore.rs
  migration.rs
  integrity.rs
  high_water.rs
  status.rs
~~~

Integrate:

- lib.rs: module registration, data-root lifecycle, Tauri commands.
- formlogic_client.rs: data control/node endpoints.
- flows/dispatcher.rs: independent data runtime loop, not the connector command loop.
- secrets.rs: new fail-closed secure entries/adapters; no plaintext fallback.
- http.rs: local status/backup/integrity endpoints.
- events.rs: data status/progress events.
- Cargo.toml: SQLCipher/SQLite and canonical JSON/hash dependencies after spike.
- migrate.rs: do not add live DBs to generic copy; call the controlled data migration service.

### 23.2 FormLogic Desktop React

Add:

~~~text
formlogic/desktop/src/DataPanel.tsx
formlogic/desktop/src/data/
  DataOverview.tsx
  DatasetTable.tsx
  NodesPanel.tsx
  BackupPanel.tsx
  RecoveryPanel.tsx
  MigrationProgress.tsx
  types.ts
~~~

Integrate:

- DesktopSidebar.tsx: data SectionId and Manage navigation entry.
- App.tsx: deferred DataPanel render.
- api.ts: typed data commands/status.
- DesktopOverview.tsx: data-health card and setup action.
- panelCache.ts: prefetch lightweight data summary.
- SettingsPanel.tsx: keep global data-root settings; link to Data workspace.
- Icons.tsx/styles.css: native visual treatment.

Reuse existing open_path and open_url after validating the Web form URL and local owned path.

### 23.3 PHP backend

Add:

~~~text
Services/
  StorageRouter.php
  DataNodeService.php
  DataPlacementService.php
  DataRelayService.php
  DataReplicationService.php
  DataWriteFinalizationService.php
  DataProjectionReconciler.php
  DataWriteLeaseService.php
  DataControlPublicationService.php
  DataMigrationService.php
  DataSnapshotService.php
  DataRestoreService.php
  DataIntegrityService.php
Controllers/
  DataNodeController.php
  DataPlacementController.php
  DataRelayController.php
  DataMigrationController.php
  DataSnapshotController.php
~~~

Integrate:

- public/index.php routes and DI.
- database/schema.sql and migrate.php.
- ResponseController and every batch/app/public/external route before plaintext parsing.
- ResponseService private create/update/list/delete/count paths.
- purgeExpiredIfDue/retention, bulk clear, status/trash/restore, form trash ZIP/restore, and account/form deletion call sites.
- MySQL response_metadata/count writers become idempotent projections for Desktop-primary datasets.
- SQLiteConnection guard against accidental Desktop-primary opens.
- AccountBackupService and import/ID-preservation guards.
- form trash/restore/purge lifecycle.
- OAuth Desktop scopes and desktop_connections formatting.
- privacy sweep and queue/transfer retention jobs.

### 23.4 Web UI

Add:

~~~text
formlogic/ui/src/components/data-placement/
  DataPlacementCard.tsx
  PlacementWizard.tsx
  ReplicaList.tsx
  NodePicker.tsx
  MigrationProgress.tsx
  OfflinePolicy.tsx
  BackupStatus.tsx
formlogic/ui/src/types/dataPlacement.ts
~~~

Integrate:

- api.ts.
- form Settings and EncryptionSettings.
- FormResponses availability and fallback states.
- public FormResponse queued/offline outcomes.
- FormsList/Dashboard storage badges.
- Settings linked-Desktop inventory.
- account export/restore UX.
- existing vault unlock/signing worker for placement manifests.

### 23.5 Contracts and docs

Add:

- docs/contracts/data-operation-v1.schema.json
- docs/contracts/data-placement-v1.schema.json
- docs/contracts/data-checkpoint-v1.schema.json
- docs/contracts/data-backup-v1.schema.json
- docs/contracts/data-sync-vectors.json
- docs/FORMLOGIC_DATA_NODES.md
- docs/DATA_BACKUP_RECOVERY_RUNBOOK.md
- docs/DATA_NODE_SECURITY.md
- ADR for single-primary logical replication and control/data-plane split.

---

## 24. Aokie integration boundary

Aokie remains a normal FormLogic plugin/data consumer.

Reuse concepts from Aokie:

- stable endpoint identity and public fingerprints;
- strict deny-unknown-field security structures;
- short-lived admissions bound to subject, key, role, app/dataset, and capability;
- server-authenticated route binding rather than self-asserted device IDs;
- monotonic roster revisions and epochs;
- fencing tokens and replay caches;
- durable SQLite outbox with write-before-emit, content-bound idempotency, retry, dead letters, and redrive;
- typed connected/reconnecting/blocked status UX;
- atomic temp-write, fsync, rename, and verify-before-delete migration discipline.

Do not reuse:

- aokie-protocol v2 message dialect;
- call/media leases;
- WebRTC media channels;
- Aokie Companion mailbox as a database transport;
- plugin data directories for FormLogic form databases;
- machine-bound DPAPI blobs as portable multi-node recovery bundles.

Aokie must never:

- receive FormLogic local database keys;
- mount data/forms;
- run arbitrary database queries;
- bypass StorageRouter;
- infer a storage target from its own payload deviceId.

When Aokie writes records, it continues through FormLogic’s supported response/flow APIs. StorageRouter determines Cloud/Desktop placement. Private Aokie app forms remain gated by the E2EE app-runtime/local-worker phases; the data-node project does not silently make today’s plaintext app forms E2EE.

---

## 25. Observability, audit, and privacy

### 25.1 Safe metrics

- nodes online/offline/version-blocked;
- operation/byte throughput;
- queue item/byte count and oldest age;
- replica lag in sequences/bytes;
- checkpoint age;
- migration phase/duration;
- backup age and verification result;
- integrity-check result code;
- disk free/used buckets;
- retry/error code counts.

### 25.2 Forbidden telemetry

- envelope bodies;
- ciphertext samples;
- plaintext/canary values;
- field names/values;
- attachment original names;
- recovery-bundle/key bytes;
- local absolute paths;
- OAuth/admission credentials;
- raw device labels where not necessary;
- SQL statements containing payloads.

### 25.3 Audit events

Record content-free events for:

- node enrolled/revoked;
- storage grant added/removed;
- placement signed/changed;
- primary migrated/promoted;
- replica added/removed;
- queue policy changed;
- snapshot created/deleted;
- backup/recovery bundle exported/imported/tested;
- restore attempted/completed/failed;
- wipe requested/acknowledged;
- integrity failure and operator redrive.

Audit records bind actor, form/dataset, node, epoch, outcome, and timestamp but not response content.

---

## 26. Performance and capacity targets

Initial targets should be verified on the supported Windows Desktop and a modest headless node:

- Preserve the current 2 MB maximum response-envelope limit.
- Use 256 KiB relay/attachment chunks.
- Online Desktop-primary text submission: p95 acknowledgement under 2 seconds on a normal broadband connection, excluding public-browser crypto load.
- First response page of 100 ciphertext rows: p95 under 3 seconds while node is online.
- Resume interrupted transfer without retransmitting verified chunks.
- Support at least 100,000 response operations per dataset before mandatory compaction.
- Keep normal heartbeat/status traffic below 1 request/minute per node plus long-lived carrier traffic.
- Backpressure rather than unbounded memory for large snapshots.
- Preflight requires source size plus staging margin; never fill the disk speculatively.
- UI remains responsive while hashing/snapshotting through background tasks.

Protocol limits, timeouts, and quotas are server-advertised and versioned. Unsupported nodes pause safely; they never skip unknown operations.

---

## 27. Implementation phases

Each phase keeps the existing backend phpunit/phpstan, UI vitest/eslint/build, Desktop cargo tests, E2EE canary, and storage-inspection gates green.

### N0 — Protocol and security freeze

Deliver:

- ADR and this plan adopted.
- Threat model and exact product wording reviewed.
- Canonical operation, placement, checkpoint, and backup schemas.
- Frozen domain-separated signing preimages, owner/vault trust anchor, node/Cloud authority certificates, and cross-signed key-rotation/re-pairing procedure.
- Short non-overlapping write-lease contract, renewal/release rules, skew bounds, and late-history quarantine semantics.
- Shared JS/PHP/Rust vectors.
- SQLCipher/encrypted-VFS packaging spike on Windows and headless target.
- Secure-store capability matrix.
- Data-relay broker design for truly non-persistent live mode.
- Feature flags and migration schema skeleton.

Gate:

- no unresolved raw-file sync path;
- no plaintext/availability fallback;
- vectors agree across all three languages;
- exact distinction between strict, queue, replica, and backup is approved.

### N1 — Local encrypted store and read-only Data workspace

Deliver:

- Rust data module and encrypted SQLite driver.
- Node Storage Master Key and wrapped per-dataset keys.
- Managed folder layout.
- Local schema, integrity check, status API.
- Independent external high-water anchor and rollback/divergence blocking.
- Duplicate-key-aware Rust __flenc:1 validator with shared adversarial fixtures.
- Data navigation/workspace listing synthetic/test datasets.
- open folder/open Web actions.
- fail-closed unsupported secure-store state.

Gate:

- copied DB/WAL/temp/staging files reveal no canary or readable SQLite metadata;
- replacing the dataset with an older valid encrypted DB or old DB+WAL is detected against the independent high-water anchor;
- wrong/missing key fails closed;
- crash/power-cut tests recover transactionally;
- plugins/WebView cannot access key material;
- generic Desktop folder move cannot copy an open data database.

### N2 — Cloud-primary Desktop snapshots

Deliver:

- portable data-only backup format.
- Cloud-to-Desktop logical snapshot export.
- signed manifest and logical root.
- owner-certified backup signer chain and offline provenance/fingerprint UX.
- Desktop backup catalog.
- Structural Test Restore.
- scheduled data-only backups.

Gate:

- live Cloud DB snapshot restores consistently;
- tampered/missing/reordered files fail;
- self-contained signer-key substitution does not authenticate a backup;
- no raw data keys in package;
- copying one .flbackup is sufficient for a structural restore;
- active Cloud placement is unchanged.

### N3 — Data relay and Desktop-primary online path

Deliver:

- short-lived admissions.
- targeted chunked data relay.
- StorageRouter.
- Cloud-primary logical operation log and signed head checkpoints, so populated forms have a catch-up source.
- One-way Cloud-to-Desktop baseline/catch-up/fenced cutover for existing populated forms; an empty/new form may use the same state machine with a zero-row baseline.
- Desktop primary create/list/get/update/delete/count plus status, trash/restore, retention, bulk clear, and form-trash lifecycle routing.
- Fail-closed Cloud idempotency reservation, Desktop transactional outbox/receipt, derived response_metadata projection, and reconciler.
- Privacy-minimised independent tombstone-continuity ledger/checkpoint anchoring for every finalised delete.
- Schema/manifest/key-epoch prepare→primary commit→publish barrier.
- strict online-only policy.
- signed complete-row operations/checkpoints, owner-authorised authority keys, short write leases, and gateway stale-receipt fencing.
- Web availability UX.

Gate:

- Cloud/API/log/database canary sweep finds no plaintext;
- strict-offline path stores no durable payload and returns deterministic 503;
- old/unassigned/forged node cannot claim or complete;
- stale expectedRev, rowVersion, manifest, lease, and storage epoch fail atomically;
- crash/fault injection between Desktop commit, Cloud receipt/high-water commit, metadata projection, and HTTP response yields one operation and never a false durable acknowledgement;
- a delete cannot report success until its signed tombstone entry/root is durable on the configured independent continuity authority;
- raw duplicate-key/malformed/unknown-suite/plaintext envelopes are rejected independently by Rust;
- a populated Cloud-primary form reaches Desktop with equal logical root before its first Desktop-primary write.

### N4 — Encrypted delivery queue and resilient Desktop primary

Deliver:

- ciphertext queue with TTL/quota.
- 202 receipt/status flow.
- Desktop durable delivery receipts.
- retry/dead-letter/redrive.
- ingestion-key grace handling.
- privacy/retention sweeper.

Gate:

- queued payload deleted only after correct content-bound receipt;
- same idempotency/different ciphertext blocks;
- expiry, quota, revoked node, and key-epoch retirement are visible;
- queue does not silently become a permanent replica;
- infrastructure backup-retention wording is accurate.

### N5 — Generalised bidirectional migration and Cloud live replica

Deliver:

- full state machine and progress UI.
- baseline + catch-up + brief fence + epoch switch.
- harden the N3 Cloud-to-Desktop path and add Desktop-to-Cloud/replica destinations.
- cutover reservation reconciliation, covered delayed-receipt finalisation, and transactional 202 queue drain/retarget under the original idempotency key.
- optional Cloud live replica/read fallback.
- observation and rollback.

Gate:

- writes during migration are neither lost nor duplicated;
- fault injection at every state resumes or rolls back;
- gateway accepts no old-manifest data beyond the signed cutover checkpoint; an exact delayed receipt covered by that checkpoint may only finalise its existing reservation, while the old primary stops authorised commits after lease expiry and quarantines later history;
- no outcome-unknown reservation or accepted 202 queue item is stranded across the placement switch;
- logical roots/counts/checkpoints match; attachment roots/counts also match only when the N8 attachment capability is enabled, otherwise attachment-bearing forms are ineligible;
- cleanup cannot remove the last verified copy.

### N6 — Multiple Desktops under one account

Deliver:

- per-node assignments/roles.
- Desktop-to-Desktop logical replication through data plane.
- live and backup replicas.
- manual promotion/recovery.
- tombstone/compaction policy.
- node roster and fingerprint UI.

Gate:

- two primaries cannot hold overlapping valid write authority for the same dataset across all epochs and primaries, and only canonical-gateway receipts can be acknowledged;
- a revoked node cannot authenticate/receive new sync data or have any new operation/receipt accepted as canonical after its existing lease expires; local late history is quarantined;
- stale node does not resurrect deletions;
- currentness is checkpoint-based;
- promotion requires exact currentness or an explicit data-loss boundary;
- network partition/clock skew/sleep/reboot chaos suite passes.

### N7 — Disaster recovery and linked-account storage grants

Deliver:

- password-wrapped .flkeys bundle.
- Full Recovery Test.
- signed offline recovery utility/wizard using the browser crypto contract, without granting the storage daemon a Form Key.
- recovery-node enrolment.
- explicit same-workspace/cross-account storage-only grants.
- separate E2EE decryption grants after P5.
- optional encrypted Cloud DR bundle upload.

Gate:

- wrong password/account/vault/version fails safely;
- weak or resource-exhaustion KDF parameters are rejected and stale key bundles are visibly flagged;
- possession of backup folder alone cannot decrypt responses;
- storage-only target cannot decrypt;
- linking accounts alone grants nothing;
- revoke transport/storage/decryption actions remain distinct;
- a clean replacement Desktop can recover selected datasets.

### N8 — Attachments, app-runtime/Aokie alignment, hardening

Deliver:

- attachment operation/chunk support after E2EE P4.
- remove the earlier attachment-bearing-form eligibility block only after migration, replication, backup, restore, and logical-root coverage all pass.
- app-runtime Private forms after P5.
- optional Desktop private-processing grant after P6/P7.
- Aokie integration through standard FormLogic APIs.
- independent security review.
- recovery and disaster runbooks.

Gate:

- encrypted attachments survive move/sync/backup/restore;
- partial/reordered/truncated streams fail;
- Aokie/plugin has no database/key access;
- all server content-dependent Private-form gates remain fail-closed;
- only after review may product claims be strengthened.

---

## 28. Test plan

### 28.1 Crypto and contracts

- Cross-language canonical JSON and signature vectors.
- Every AAD/operation field mutation fails validation or signature.
- Unknown fields/versions rejected.
- Duplicate JSON keys, ambiguous numbers, invalid Base64 variants, and cross-parser differentials rejected identically in JS/PHP/Rust.
- Nonce/key uniqueness assertions in debug tests.
- Wrong storage key and recovery password tests.
- Placement-manifest chain and signer-pin tests.
- Signer-key substitution inside placement/operation/checkpoint/backup fails without the pinned owner chain; cross-signed rotation and explicit re-pairing succeed only through their defined flows.
- Domain-separation tests prove an operation signature cannot validate as a checkpoint/backup/placement signature.

### 28.2 Storage durability

- Crash before SQLite transaction.
- Crash after record write before operation append.
- Enforce atomic record + operation transaction.
- Crash after commit before response.
- Crash after response lost, then idempotent retry.
- WAL recovery and cipher integrity.
- Replace with an older valid encrypted DB, DB+WAL pair, or cloned data directory and require rollback/high-water blocking.
- Crash between DB fsync, local high-water update, signed receipt, and Cloud high-water update.
- Disk full at snapshot/import/cutover.
- Permission change and secure-store outage.
- Live data-directory relocation.

### 28.3 Relay/outbox

- Crash before upload.
- Crash after upload before durable ack.
- Crash after ack before local cleanup.
- Concurrent ack/retry race.
- Same idempotency key/different payload.
- Cloud reservation unavailable fails closed; receipt lost after Desktop commit redrives to the same operation/result.
- Projection failure and rebuild never deletes or duplicates the authoritative Desktop row.
- Forged payload deviceId.
- Target mismatch.
- Admission expiry/rotation mid-transfer.
- Reconnect into another carrier domain cannot inherit cursor.
- Backpressure and quota.
- Corrupt/wrong chunk and full-object hash.

### 28.4 Sync and partition

- Duplicate operation.
- Missing/out-of-order sequence.
- Same revision/different ciphertext.
- Status/trash/restore advances rowVersion while keeping envelope rev/hash unchanged and still applies exactly once; stale/non-contiguous rowVersion blocks.
- Stale/future storage epoch.
- Expired/replayed/overlapping write lease and manifest-hash/key-fingerprint mismatch.
- Old primary offline through promotion, then reconnects with late history; gateway accepts no operation beyond the cutover checkpoint and reconciliation quarantines it, while an exact covered delayed receipt only finalises its existing reservation.
- Primary and replica partition.
- Primary sleeps/reboots.
- Revocation during sync.
- Node offline across key rotation.
- Prepare/primary-commit/public-publish crash permutations and submissions on active, grace, retired, or never-committed ingestion epochs.
- Complete response-row convergence for status, timestamps, metadata, trash/restore, retention, bulk clear, and form trash/archive.
- Tombstone retention and stale-node re-enrolment.
- Compaction with slow/removed replicas.

### 28.5 Migration

- Fault injection in every persisted state.
- Concurrent public create/update/delete during baseline and catch-up.
- Cutover crash immediately before/after signed epoch switch.
- Delayed old-epoch receipt at/below the signed cutover hash finalises once; one above or mismatching it is quarantined.
- Crash during queued-202 drain/retarget preserves the original idempotency result and delivers exactly once to the selected primary.
- Source cannot obtain new write authority; any pre-expiry unacknowledged late commit is quarantined and never returned as success.
- Rollback creates a new epoch.
- Recovery from an older checkpoint commits an owner-authorised dataset.recovery.restore at highest-known sequence + 1, preserves the old head hash/RPO audit, and never rewinds the global sequence.
- Recovery reapplies every acknowledged deletion in the continuity ledger through the chosen anchor; missing, truncated, wrong-root, or insufficient ledger coverage blocks promotion/writes.
- Any change to the owner-signed recoveryAuthorization snapshot/recovered roots, anchor, tombstone coverage/root, abandoned range, uncertainty, or reason makes dataset.recovery.restore fail verification.
- Physical DB hashes differ but logical roots match.
- Reverse migration uses identical guarantees.

### 28.6 Backup/restore

- Snapshot while source is active.
- Missing, extra, modified, or reordered object.
- Wrong account/vault/backup password.
- Backup signer/public-key substitution, broken owner certificate chain, wrong backup-root MAC, and offline unverified-provenance state.
- Argon2 parameters below export minimum or above import maximum, non-ASCII password vectors, nonce/salt corruption, and stale-bundle detection after vault/key rotation.
- Unsupported version/cipher suite.
- Missing historical ingestion/key epoch.
- Structural and Full Recovery Test.
- Non-routable verification namespace preserving original IDs, exact-chain continuation, replace, and recovery-node paths.
- Divergent-chain merge is quarantined; clone-as-new works only through explicit browser decrypt-and-reseal.
- Restore a backup made before member removal after the removal; newer revocations/grants win, and the removed member cannot decrypt any subsequent submission.
- Safety snapshot before replace.
- No tombstone resurrection or epoch rollback.

### 28.7 Privacy canaries

Seed unique answer text, filename, and attachment bytes; assert absent from:

- Cloud MySQL/SQLite where Cloud is not a replica;
- relay/queue metadata and logs;
- Desktop filenames and logs;
- ordinary SQLite/WAL/temp/staging bytes;
- crash reports and telemetry;
- backup index/manifest;
- Cloud tombstone-continuity ledger beyond its allowed opaque IDs, sequence/hash, and reason-class fields;
- Data workspace DOM while vault is locked.

Ciphertext payload stores will naturally contain encrypted canary bytes; the test checks that the plaintext canary is absent.

### 28.8 UI

- Data workspace is operational only.
- Current badge requires checkpoint equality.
- Exact offline/queue/replica wording.
- Migration cannot be dismissed as complete before verification.
- Destructive actions show scope and retention.
- Keyboard/screen-reader progress and error handling.
- Windows long paths and non-ASCII display labels without using them as filenames.

---

## 29. Rollout, feature flags, and compatibility

Recommended flags:

- DATA_NODES
- DATA_NODE_SQLCIPHER
- DATA_PLACEMENT
- DATA_DESKTOP_PRIMARY
- DATA_ENCRYPTED_QUEUE
- DATA_CLOUD_REPLICA
- DATA_MULTI_NODE
- DATA_RECOVERY_BUNDLES
- DATA_CROSS_ACCOUNT_GRANTS

Rollout:

1. Developer-only synthetic datasets.
2. Internal Cloud-primary Desktop snapshots.
3. One-node strict Desktop primary.
4. Encrypted queue.
5. Cloud live replica and migration.
6. Same-account multi-Desktop beta.
7. Disaster recovery.
8. Cross-account/org and app-runtime integrations.

Compatibility:

- Advertise protocol min/max and feature bits.
- Placement manifest lists minimum capability.
- Unknown operation pauses the dataset with sync_protocol_unsupported.
- Rolling upgrade never silently skips an object.
- Downgrade that cannot read the local encrypted store is blocked.
- Keep old Cloud-only Private forms working throughout.

---

## 30. Operational runbooks

Create and test runbooks for:

- primary Desktop lost permanently;
- primary offline with encrypted queue filling;
- storage disk full;
- corrupt local SQLCipher database;
- valid-old-database rollback/high-water mismatch;
- Desktop committed but API returned write_outcome_unknown;
- lease authority unavailable or old primary reconnects with quarantined history;
- Cloud replica behind;
- stuck/dead-letter operation;
- node compromised/revoked;
- Form Key rotation with queued submissions;
- migration interrupted before/after cutover;
- recovery bundle password lost;
- vault passphrase lost but recovery kit present;
- both vault passphrase and recovery kit lost;
- restore to replacement hardware;
- restore of a package predating a member/node revocation;
- removing all Cloud copies;
- account deletion with offline nodes.

Runbooks must state what FormLogic can recover, what only the customer can recover, and where data loss may have occurred.

---

## 31. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Scope becomes a general distributed database | Keep one primary, opaque complete-record writes, and per-form sequence. |
| “Desktop only” claim is misleading | Separate strict, queue, and replica presets; disclose control-plane metadata. |
| SQLCipher packaging delays delivery | N0 spike and EncryptedDatasetStore interface; no insecure fallback. |
| Existing relay reused beyond its limits | Dedicated data protocol and chunk transfer. |
| Backups look valid but are unrestorable or self-authenticate a forged key | Owner-anchored signer chain, backup-root MAC for DR, Structural/Full Recovery Test, visible provenance and last-tested date. |
| Keys beside data defeat protection | Only independently password-wrapped .flkeys; no raw keys. |
| Multi-node split brain | Owner-signed placement, one authorised primary, non-overlapping short leases, gateway receipt fencing, late-history quarantine, and manual promotion. |
| Valid old encrypted DB is replayed | Independent local/Cloud high-water anchors, startup/write blocking, and old-DB fault tests. |
| Desktop commit and Cloud metadata disagree | Fail-closed reservation, idempotent primary receipt, derived projection/outbox/reconciler, and boundary fault injection. |
| Stale nodes resurrect deletes | Durable tombstones and baseline re-enrolment after compaction. |
| Queue becomes hidden permanent storage | TTL/quota, explicit UI, purge receipts, retention metrics. |
| Plugins broaden attack surface | FormLogic core owns storage and exposes no paths/keys/arbitrary SQL. |
| Cross-account link leaks data | Storage grant and decryption grant are separate and per form. |
| FormLogic API returns partial account export | Block or explicitly mark partial; never silently omit node data. |
| User copies live DB folder | Copy-safe backups folder and warnings; backup action uses snapshot API. |
| Cloud maliciously rewrites routing | Owner-signed placement manifests and node verification; availability caveat remains. |
| Anonymous submission authenticity overstated | State that public ingestion is confidential, not submitter-authenticated. |

---

## 32. Recommended defaults

- Feature available only for Private forms.
- Cloud remains the initial primary.
- First Desktop replica is a data-only scheduled backup, the lowest-risk adoption path.
- When choosing Desktop primary, default to a seven-day encrypted queue with a prominent option for strict rejection.
- No automatic read fallback unless Cloud/live replica is explicitly enabled and current.
- No automatic failover.
- Seven-day old-primary observation window after migration.
- Scheduled backups are data-only.
- Disaster-recovery bundles are manual until the user explicitly configures protected scheduling.
- Data-node assignments default to none.
- Cross-account storage grants remain off until team grant UX is complete.
- Local database hosting is disabled if secure store or whole-file encryption is unavailable.

---

## 33. Definition of done

The feature is complete only when all of the following are true:

- A Private form can move Cloud → Desktop → Cloud without plaintext reaching Cloud and without lost/duplicated writes.
- A form can independently select strict Desktop, temporary encrypted queue, Cloud replica, and Desktop replica policies.
- Web response CRUD behaves consistently through StorageRouter.
- Desktop stores record envelopes in a whole-file-encrypted local SQLite store.
- A copied local folder, backup, log, WAL, or temp file reveals no response plaintext.
- Multiple linked Desktops have explicit roles and converge through logical operations.
- At most one primary has valid write authority for the current manifest epoch; no overlapping lease is issued, and only a current-manifest receipt can be acknowledged by the gateway.
- A revoked/stale node cannot renew or claim current authority, append old-manifest data past cutover, or promote itself; only an exact already-covered receipt may finalise its existing reservation, and other pre-expiry late local history is quarantined with an explicit RPO boundary.
- Complete response rows—including status, timestamps, metadata, trash/restore, retention, bulk clear, and form archive—converge through StorageRouter and signed operations.
- Cloud idempotency/receipt finalisation and derived metadata projections recover from every injected crash boundary without duplicate operations or false success.
- Schema/public-manifest/key-epoch publication cannot precede a primary checkpoint containing the exact prepared artifacts.
- Replacing a node database with an older valid encrypted copy is detected against an independent high-water anchor before writes resume.
- Any deliberate recovery to an older snapshot uses an owner-signed recoveryAuthorization and an explicit dataset.recovery.restore transition at the next global sequence; it never rewinds history silently.
- An older recovery snapshot cannot resurrect any acknowledged deletion covered by the authoritative tombstone-continuity ledger; insufficient ledger coverage keeps the restore non-routable/read-only.
- Data workspace lists locations/files, roles, checkpoints, health, backup state, keys/recovery state, and Web links without duplicating CRUD.
- A data-only backup contains no recovery-capable raw key.
- A disaster-recovery backup is independently password-wrapped, validates to an independently pinned owner authority, and passes Full Recovery Test on a clean replacement node when the vault passphrase or recovery kit is also available.
- Cloud queue retention, replica retention, and backup retention are independently visible and enforced.
- Cross-account storage never implies decryption access.
- Aokie and other plugins cannot access form database files or keys.
- Fault-injection, privacy-canary, migration, partition, restore, and cross-language contract suites pass.
- Security/product wording has had human review and does not claim more than the implementation proves.

---

## 34. Final recommendation

This is a strong extension of the Private Forms architecture and a meaningful FormLogic differentiator. The cleanest implementation path is:

1. ship encrypted Desktop snapshots first;
2. add the Cloud operation log, verified one-way Cloud→Desktop cutover, and strict single-Desktop primary;
3. add an explicit temporary ciphertext queue;
4. add verified Cloud/Desktop migration and replicas;
5. add multi-Desktop replication and disaster recovery;
6. add cross-account and private-processing grants only after the underlying E2EE team/app phases are ready.

That sequence gives customers useful ownership early while keeping the most dangerous distributed-systems and key-recovery work behind explicit gates.
