<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use PDO;

/**
 * E2EE Private Forms — per-form encryption state (docs/E2EE_PRIVATE_FORMS_PLAN.md §8/§9).
 *
 * The single source of truth for "is this form private?" (per-request cached), the
 * atomic §9.1 enable preflight + first key/schema/manifest/grant write, schema-version
 * publishing (owner-signed manifests, append-only), and the manifest tuples the
 * EnvelopeValidator accepts envelopes against.
 *
 * The server verifies every signature it stores (manifest + grant, Ed25519 against the
 * requester's VAULT verification key) but can never create one — signing keys live only
 * in owners' browsers. ext-sodium is a hard requirement for every verifying path: absent
 * sodium the endpoints fail closed with typed `encryption_unavailable` (plan D3).
 */
final class FormEncryptionService
{
    public const CONTENT_SUITE = EnvelopeValidator::CONTENT_SUITE;
    public const WRAP_SUITE = EnvelopeValidator::WRAP_SUITE;

    /** Exact schema-snapshot byte cap (plan §16-P3; generous for any real field set). */
    public const MAX_SCHEMA_JSON_BYTES = 1_000_000;

    public const INGESTION_PK_BYTES = 32;
    public const WRAPPED_INGESTION_SECRET_BYTES = 72;
    public const GRANT_WRAPPED_KEY_BYTES = 80;
    public const SIGNATURE_BYTES = 64;

    private const KEY_ID_RE = '/^fik_[a-zA-Z0-9_-]{1,36}$/';
    private const GRANT_ID_RE = '/^fkg_[a-zA-Z0-9_-]{1,36}$/';
    private const SIGNER_KEY_ID_RE = '/^[0-9a-f]{16}$/';
    private const SCHEMA_HASH_RE = '/^[0-9a-f]{64}$/';

    /** Field types the P3 preflight blocks outright (files wait for P4, links never). */
    public const BLOCKED_FIELD_TYPES = ['file_upload', 'camera', 'linked_record'];

    /**
     * An 'enabling' row older than this is a crashed enable (the process died
     * between the durable enabling marker and the commit) — a retry may retake
     * it instead of the form staying wedged mid-transition forever.
     */
    public const ENABLING_STALE_SECONDS = 300;

    /** @var array<string, bool> per-request isPrivate cache (plan §9.2). */
    private static array $privateCache = [];

    private PDO $mysql;
    private ?SQLiteConnection $sqlite;
    private string $uploadsPath;

    public function __construct(MySQLConnection|PDO $mysql, ?SQLiteConnection $sqlite = null, string $uploadsPath = '')
    {
        $this->mysql = $mysql instanceof MySQLConnection ? $mysql->getConnection() : $mysql;
        $this->sqlite = $sqlite;
        $this->uploadsPath = rtrim($uploadsPath !== '' ? $uploadsPath : dirname(__DIR__, 2) . '/storage/uploads', '/\\');
    }

    public static function sodiumAvailable(): bool
    {
        return function_exists('sodium_crypto_sign_verify_detached');
    }

    /** Test/lifecycle hook: drop the per-request cache (all forms, or one). */
    public static function invalidateCache(?string $formId = null): void
    {
        if ($formId === null) {
            self::$privateCache = [];
        } else {
            unset(self::$privateCache[$formId]);
        }
    }

    /**
     * True when the form has a form_encryption row — ANY row, regardless of state:
     * trashed private forms must stay gated exactly like active ones (state only
     * drives the trash lifecycle, never a plaintext re-opening).
     */
    public function isPrivate(string $formId): bool
    {
        if ($formId === '') {
            return false;
        }
        if (array_key_exists($formId, self::$privateCache)) {
            return self::$privateCache[$formId];
        }
        $stmt = $this->mysql->prepare('SELECT 1 FROM form_encryption WHERE form_id = :f LIMIT 1');
        $stmt->execute(['f' => $formId]);
        return self::$privateCache[$formId] = ($stmt->fetchColumn() !== false);
    }

    /**
     * The form's current encryption lifecycle state — 'enabling' (durable
     * transition marker), 'active', 'trashed' — or null when the form is
     * plaintext. Deliberately NOT cached: the fail-closed gates must observe a
     * state flip the moment it commits, not a request-stale snapshot.
     */
    public function encryptionState(string $formId): ?string
    {
        if ($formId === '') {
            return null;
        }
        $stmt = $this->mysql->prepare('SELECT state FROM form_encryption WHERE form_id = :f LIMIT 1');
        $stmt->execute(['f' => $formId]);
        $state = $stmt->fetchColumn();
        return $state === false ? null : (string) $state;
    }

    /**
     * Fail closed while an enable is in flight (enable-race fix): every mutation
     * surface — submissions, publish/field saves, webhook/flow/integration
     * mutations — calls this BEFORE its privacy check so nothing can interleave
     * between the enable preflight and its commit.
     *
     * @throws EncryptionEnablingException 409 encryption_enabling
     */
    public function assertNotEnabling(string $formId): void
    {
        if ($this->encryptionState($formId) === 'enabling') {
            throw new EncryptionEnablingException();
        }
    }

    /**
     * Manifest tuples currently acceptable for envelope writes (plan §8): every
     * manifest row whose ingestion key is 'active', or 'retiring' with
     * now < accept_until — superseded manifests stay acceptable exactly as long as
     * their key epoch does. Shape matches EnvelopeValidator::validateEnvelope().
     *
     * @return list<array{key_id: string, ingest_epoch: int, schema_version: int, schema_hash: string}>
     */
    public function acceptableManifests(string $formId): array
    {
        $stmt = $this->mysql->prepare("
            SELECT m.key_id, m.ingest_epoch, m.schema_version, m.schema_hash
            FROM form_manifests m
            JOIN form_ingestion_keys k
              ON k.form_id = m.form_id AND k.id = m.key_id AND k.epoch = m.ingest_epoch
            WHERE m.form_id = :f
              AND (k.state = 'active' OR (k.state = 'retiring' AND k.accept_until > NOW()))
        ");
        $stmt->execute(['f' => $formId]);
        $out = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $out[] = [
                'key_id' => (string) $row['key_id'],
                'ingest_epoch' => (int) $row['ingest_epoch'],
                'schema_version' => (int) $row['schema_version'],
                'schema_hash' => (string) $row['schema_hash'],
            ];
        }
        return $out;
    }

    /**
     * The served manifest block for public/owner form payloads (plan §8): the LATEST
     * non-superseded form_manifests row joined to its ingestion key + exact schema
     * snapshot bytes. Null when the form is not private (or, pathologically, has no
     * manifest — callers fail closed on that).
     *
     * @return array<string,mixed>|null
     */
    public function publicManifest(string $formId): ?array
    {
        $stmt = $this->mysql->prepare("
            SELECT m.key_id, m.ingest_epoch, m.schema_version, m.schema_hash,
                   m.content_suite, m.wrap_suite, m.signer_key_id, m.signer_pk,
                   m.signature, m.expires_at, k.public_key, s.schema_json
            FROM form_manifests m
            JOIN form_ingestion_keys k
              ON k.form_id = m.form_id AND k.id = m.key_id AND k.epoch = m.ingest_epoch
            JOIN form_schema_versions s
              ON s.form_id = m.form_id AND s.version = m.schema_version
            WHERE m.form_id = :f AND m.superseded_at IS NULL
            ORDER BY m.manifest_seq DESC
            LIMIT 1
        ");
        $stmt->execute(['f' => $formId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            return null;
        }
        return [
            'mode' => 'private',
            'keyId' => (string) $row['key_id'],
            'epoch' => (int) $row['ingest_epoch'],
            'publicKey' => (string) $row['public_key'],
            'content' => (string) $row['content_suite'],
            'wrap' => (string) $row['wrap_suite'],
            'schemaVersion' => (int) $row['schema_version'],
            'schemaHash' => (string) $row['schema_hash'],
            'schemaJson' => (string) $row['schema_json'],
            'signerKeyId' => (string) $row['signer_key_id'],
            'signerPk' => (string) $row['signer_pk'],
            'expiresAt' => $row['expires_at'] !== null ? (string) $row['expires_at'] : null,
            'sig' => base64_encode((string) $row['signature']),
        ];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Enable (plan §9.1 — one transaction, full preflight re-verified at commit)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Enable private mode on a form: durable plaintext → enabling → private.
     *
     * Phase 1 commits the 'enabling' marker in its OWN short transaction, so
     * every gated surface (submissions, publish/field saves, integration
     * mutations) fails closed with 409 encryption_enabling for the WHOLE
     * enable — the preflight can no longer race a plaintext write that lands
     * between check and commit. Phase 2 then takes the forms-row lock
     * (serializing against publish/field saves, which take the same lock),
     * re-runs the full §9.1 preflight at commit-time state, verifies the
     * owner's manifest + self-grant signatures, and writes the first
     * key/schema/manifest/grant rows + the enabling → active flip in ONE
     * transaction. ANY failure deletes the enabling marker (the form is left
     * plaintext); a crashed enable leaves a stale marker a retry may retake
     * after ENABLING_STALE_SECONDS. Irreversible once active (plan D8).
     *
     * @param array<string,mixed> $body
     * @return array{enabled: bool, manifestSeq: int}
     * @throws EncryptionRequestException
     */
    public function enable(string $formId, string $userId, array $body): array
    {
        if (!self::sodiumAvailable()) {
            throw new EncryptionRequestException('encryption_unavailable', 'Server-side signature verification (ext-sodium) is unavailable — private forms cannot be enabled.', 503);
        }

        // Shape validation first — cheap, and no reason to open a transaction for a
        // malformed request.
        $req = $this->validateEnableBody($body);

        $vault = $this->vaultRow($userId);

        // ── Phase 1: the durable enabling marker (committed on its own) ──
        $this->beginEnable($formId, $userId);

        try {
            $this->mysql->beginTransaction();
            try {
                // Serialize against publish/field saves: FormService::updateForm
                // takes the same forms-row lock for its gated writes.
                $lock = $this->mysql->prepare('SELECT id FROM forms WHERE id = :f FOR UPDATE');
                $lock->execute(['f' => $formId]);

                $reasons = $this->preflightReasons($formId, $userId, $vault !== null);
                if ($reasons !== []) {
                    throw new EncryptionRequestException('private_enable_blocked', 'This form cannot be made private: ' . implode(', ', $reasons), 409, ['reasons' => $reasons]);
                }
                /** @var array{ed25519_pk_raw: string, x25519_pk_raw: string, ed25519_pk_b64: string, x25519_pk_b64: string} $vault */

                // ── Cryptographic write-time verification (plan §8/§11) ──
                $signerKeyId = substr(hash('sha256', $vault['ed25519_pk_raw']), 0, 16);
                if (!hash_equals($signerKeyId, $req['manifest']['signerKeyId'])) {
                    throw new EncryptionRequestException('manifest_invalid', 'manifest signerKeyId does not match the requester vault signing key', 400);
                }
                $canonical = $this->manifestCanonical($formId, $req['keyId'], 1, $req['ingestionPublicKeyB64'], 1, $req['schema']['schemaHash'], $signerKeyId, null);
                if (!sodium_crypto_sign_verify_detached($req['manifest']['signatureRaw'], $canonical, $vault['ed25519_pk_raw'])) {
                    throw new EncryptionRequestException('manifest_invalid', 'manifest signature verification failed', 400);
                }

                $grantCanonical = $this->grantCanonical(
                    $req['grant']['grantId'],
                    $formId,
                    1,
                    $userId,
                    $userId,
                    $vault['x25519_pk_raw'],
                    $req['grant']['wrappedKeyRaw'],
                    null
                );
                if (!sodium_crypto_sign_verify_detached($req['grant']['signatureRaw'], $grantCanonical, $vault['ed25519_pk_raw'])) {
                    throw new EncryptionRequestException('grant_invalid', 'grant signature verification failed', 400);
                }

                // ── Writes (phase 1's enabling row was the atomic enable gate) ──
                $now = date('Y-m-d H:i:s');
                $this->mysql->prepare("
                    INSERT INTO form_schema_versions (id, form_id, version, schema_json, schema_hash, created_at)
                    VALUES (:id, :f, 1, :json, :hash, :now)
                ")->execute([
                    'id' => 'fsv_' . bin2hex(random_bytes(16)),
                    'f' => $formId,
                    'json' => $req['schema']['schemaJson'],
                    'hash' => $req['schema']['schemaHash'],
                    'now' => $now,
                ]);

                $this->mysql->prepare("
                    INSERT INTO form_ingestion_keys (id, form_id, epoch, public_key, wrapped_secret, fk_epoch, state, accept_until, created_at)
                    VALUES (:id, :f, 1, :pk, :sk, 1, 'active', NULL, :now)
                ")->execute([
                    'id' => $req['keyId'],
                    'f' => $formId,
                    'pk' => $req['ingestionPublicKeyB64'],
                    'sk' => $req['wrappedIngestionSecretRaw'],
                    'now' => $now,
                ]);

                $this->mysql->prepare("
                    INSERT INTO form_manifests
                        (id, form_id, manifest_seq, key_id, ingest_epoch, schema_version, schema_hash,
                         content_suite, wrap_suite, signer_key_id, signer_pk, signed_bytes, signature,
                         created_at, expires_at, superseded_at)
                    VALUES
                        (:id, :f, 1, :key, 1, 1, :hash, :content, :wrap, :skid, :spk, :bytes, :sig, :now, NULL, NULL)
                ")->execute([
                    'id' => 'fm_' . bin2hex(random_bytes(16)),
                    'f' => $formId,
                    'key' => $req['keyId'],
                    'hash' => $req['schema']['schemaHash'],
                    'content' => self::CONTENT_SUITE,
                    'wrap' => self::WRAP_SUITE,
                    'skid' => $signerKeyId,
                    'spk' => $vault['ed25519_pk_b64'],
                    'bytes' => $canonical,
                    'sig' => $req['manifest']['signatureRaw'],
                    'now' => $now,
                ]);

                $this->mysql->prepare("
                    INSERT INTO form_key_grants
                        (id, form_id, user_id, fk_epoch, wrapped_key, wrap_suite, role, grantor_user_id,
                         grantor_key_id, grantee_pk, sig_version, signature, expires_at, state, created_at)
                    VALUES
                        (:id, :f, :u, 1, :wk, :wrap, 'owner', :gu, :gkid, :gpk, 1, :sig, NULL, 'active', :now)
                ")->execute([
                    'id' => $req['grant']['grantId'],
                    'f' => $formId,
                    'u' => $userId,
                    'wk' => $req['grant']['wrappedKeyRaw'],
                    'wrap' => self::WRAP_SUITE,
                    'gu' => $userId,
                    'gkid' => $signerKeyId,
                    'gpk' => $vault['x25519_pk_b64'],
                    'sig' => $req['grant']['signatureRaw'],
                    'now' => $now,
                ]);

                // The transition commit: enabling → active (same transaction as the
                // key material, so the form is never active without its keys).
                $this->mysql->prepare("
                    UPDATE form_encryption SET state = 'active', enabled_at = :now
                    WHERE form_id = :f AND state = 'enabling'
                ")->execute(['now' => $now, 'f' => $formId]);

                $this->mysql->commit();
            } catch (\Throwable $e) {
                if ($this->mysql->inTransaction()) {
                    $this->mysql->rollBack();
                }
                throw $e;
            }
        } catch (\Throwable $e) {
            // Any failure AFTER the marker was committed removes it — the form is
            // left plaintext, never wedged mid-transition (a stale marker from a
            // hard crash is retaken by beginEnable after ENABLING_STALE_SECONDS).
            $this->abortEnable($formId);
            throw $e;
        }

        self::invalidateCache($formId);
        return ['enabled' => true, 'manifestSeq' => 1];
    }

    /**
     * Phase 1 of enable(): insert the durable 'enabling' marker and COMMIT it on
     * its own, so gated surfaces fail closed for the entire enable. The PK
     * insert is the atomic gate: an existing row means the form is already
     * private (active/trashed), mid-enable (fresh enabling), or has a STALE
     * enabling marker from a crashed attempt — the last is deleted and retaken
     * exactly once so a crash never wedges the form.
     *
     * @throws EncryptionRequestException private_enable_blocked (already_enabled / enable_in_progress)
     */
    private function beginEnable(string $formId, string $userId): void
    {
        $now = date('Y-m-d H:i:s');
        $insert = function () use ($formId, $userId, $now): void {
            $this->mysql->prepare("
                INSERT INTO form_encryption (form_id, mode, current_ingest_epoch, current_fk_epoch, state, enabled_by, enabled_at)
                VALUES (:f, 'private', 1, 1, 'enabling', :u, :now)
            ")->execute(['f' => $formId, 'u' => $userId, 'now' => $now]);
        };
        try {
            $insert();
        } catch (\PDOException $e) {
            if (!$this->isDuplicateKey($e)) {
                throw $e;
            }
            $stmt = $this->mysql->prepare('SELECT state, enabled_at FROM form_encryption WHERE form_id = :f');
            $stmt->execute(['f' => $formId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (is_array($row) && $row['state'] === 'enabling') {
                $enabledAt = strtotime((string) $row['enabled_at']);
                if ($enabledAt !== false && $enabledAt < time() - self::ENABLING_STALE_SECONDS) {
                    // Crashed enable: retake the stale marker, then retry the gate
                    // insert once — a concurrent retry that beat us to it surfaces
                    // as the in-progress refusal below.
                    $this->mysql->prepare("DELETE FROM form_encryption WHERE form_id = :f AND state = 'enabling'")
                        ->execute(['f' => $formId]);
                    self::invalidateCache($formId);
                    try {
                        $insert();
                        self::invalidateCache($formId);
                        return;
                    } catch (\PDOException $retry) {
                        if (!$this->isDuplicateKey($retry)) {
                            throw $retry;
                        }
                    }
                }
                throw new EncryptionRequestException('private_enable_blocked', 'Encryption is already being enabled for this form — retry in a moment.', 409, ['reasons' => ['enable_in_progress']]);
            }
            throw new EncryptionRequestException('private_enable_blocked', 'This form is already private.', 409, ['reasons' => ['already_enabled']]);
        }
        self::invalidateCache($formId);
    }

    /**
     * Phase 2 failed (or the request died): delete the enabling marker so the
     * form is left plaintext. Best-effort — a marker that outlives even this
     * cleanup is retaken as stale by the next beginEnable.
     */
    private function abortEnable(string $formId): void
    {
        try {
            $this->mysql->prepare("DELETE FROM form_encryption WHERE form_id = :f AND state = 'enabling'")
                ->execute(['f' => $formId]);
        } catch (\Throwable) {
            // The stale-marker retake in beginEnable covers a wedged row.
        }
        self::invalidateCache($formId);
    }

    /**
     * The §9.1 preflight, listing EVERY violated item. Runs inside the enable
     * transaction so the write is checked against commit-time state.
     *
     * @return list<string>
     */
    private function preflightReasons(string $formId, string $userId, bool $hasVault): array
    {
        $reasons = [];

        $stmt = $this->mysql->prepare('SELECT ever_published_at FROM forms WHERE id = :f');
        $stmt->execute(['f' => $formId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            $reasons[] = 'form_not_found';
        } elseif ($row['ever_published_at'] !== null) {
            $reasons[] = 'ever_published';
        }

        // Our own 'enabling' marker (phase 1) is expected — anything ELSE with a
        // form_encryption row means the form is already private.
        $stmt = $this->mysql->prepare('SELECT state FROM form_encryption WHERE form_id = :f');
        $stmt->execute(['f' => $formId]);
        $encState = $stmt->fetchColumn();
        if ($encState !== false && $encState !== 'enabling') {
            $reasons[] = 'already_enabled';
        }

        // Zero responses: BOTH stores must agree (per-form SQLite is authoritative,
        // response_metadata is the MySQL mirror — a divergent mirror still blocks).
        $responseCount = 0;
        if ($this->sqlite !== null && $this->sqlite->formDatabaseExists($formId)) {
            try {
                $responseCount = (int) $this->sqlite->getFormDatabase($formId)->query('SELECT COUNT(*) FROM responses')->fetchColumn();
            } catch (\Throwable) {
                $reasons[] = 'response_store_unreadable'; // fail closed — cannot prove zero
            }
        }
        $stmt = $this->mysql->prepare('SELECT COUNT(*) FROM response_metadata WHERE form_id = :f');
        $stmt->execute(['f' => $formId]);
        if ($responseCount > 0 || (int) $stmt->fetchColumn() > 0) {
            $reasons[] = 'has_responses';
        }

        // No pending uploads: storage/uploads/<formId>/.pending must be empty or absent.
        $pendingDir = $this->uploadsPath . '/' . $formId . '/.pending';
        if (is_dir($pendingDir)) {
            foreach (scandir($pendingDir) ?: [] as $entry) {
                if ($entry !== '.' && $entry !== '..') {
                    $reasons[] = 'pending_uploads';
                    break;
                }
            }
        }

        $stmt = $this->mysql->prepare('SELECT COUNT(*) FROM webhooks WHERE form_id = :f');
        $stmt->execute(['f' => $formId]);
        if ((int) $stmt->fetchColumn() > 0) {
            $reasons[] = 'has_webhooks';
        }

        $stmt = $this->mysql->prepare('SELECT COUNT(*) FROM app_flow_bindings WHERE form_id = :f');
        $stmt->execute(['f' => $formId]);
        if ((int) $stmt->fetchColumn() > 0) {
            $reasons[] = 'has_flow_bindings';
        }

        // No flow NODES referencing the form either (§9.1 item 5): a trigger-less
        // flow can still read/write the form via formlogic_* nodes (the form id
        // lives inside flow_json) or via binding output actions. LIKE over the
        // owner's flows is sufficient — the id is a UUID, false positives are
        // practically impossible, and enable is a rare operation.
        $stmt = $this->mysql->prepare("
            SELECT COUNT(*) FROM flow_definitions
            WHERE owner_user_id = :u AND flow_json LIKE :needle
        ");
        $stmt->execute(['u' => $userId, 'needle' => '%' . $formId . '%']);
        if ((int) $stmt->fetchColumn() > 0) {
            $reasons[] = 'has_flow_nodes';
        }
        $stmt = $this->mysql->prepare("
            SELECT COUNT(*) FROM app_flow_bindings
            WHERE output_actions_json LIKE :needle OR input_map_json LIKE :needle2
        ");
        $stmt->execute(['needle' => '%' . $formId . '%', 'needle2' => '%' . $formId . '%']);
        if ((int) $stmt->fetchColumn() > 0) {
            $reasons[] = 'has_flow_nodes';
        }

        // No report/widget specs referencing the form (§9.1 item 5): app-level
        // reports/dashboards aggregate answers. apps.reports / apps.custom_screen
        // are JSON blobs — LIKE on the form id (same argument as flow_json).
        $stmt = $this->mysql->prepare("
            SELECT COUNT(*) FROM apps
            WHERE (reports LIKE :needle OR custom_screen LIKE :needle2)
        ");
        $stmt->execute(['needle' => '%' . $formId . '%', 'needle2' => '%' . $formId . '%']);
        if ((int) $stmt->fetchColumn() > 0) {
            $reasons[] = 'has_report_specs';
        }

        // No custom screen of its own (§9.1 item 5): a form with a public
        // records screen / custom screen leaks or renders answer content.
        $stmt = $this->mysql->prepare("SELECT custom_screen FROM forms WHERE id = :f");
        $stmt->execute(['f' => $formId]);
        $screen = $stmt->fetchColumn();
        if (is_string($screen) && $screen !== '' && $screen !== 'null' && $screen !== '{}') {
            $reasons[] = 'has_custom_screen';
        }

        $stmt = $this->mysql->prepare('SELECT COUNT(*) FROM response_links WHERE source_form_id = :f1 OR target_form_id = :f2');
        $stmt->execute(['f1' => $formId, 'f2' => $formId]);
        if ((int) $stmt->fetchColumn() > 0) {
            $reasons[] = 'has_response_links';
        }

        // No related-record coupling in EITHER direction (§9.1 item 6): the form's
        // own linked_record fields are caught by the field-type allowlist below;
        // here, no OTHER form of the owner's may declare a linked_record/matchField
        // targeting THIS form. Field definitions live in per-form SQLite files, so
        // each of the owner's forms is probed (enable is a rare operation).
        if ($this->sqlite !== null) {
            $stmt = $this->mysql->prepare('SELECT id FROM forms WHERE user_id = :u AND id <> :f');
            $stmt->execute(['u' => $userId, 'f' => $formId]);
            foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $otherFormId) {
                $otherFormId = (string) $otherFormId;
                if (!$this->sqlite->formDatabaseExists($otherFormId)) {
                    continue;
                }
                try {
                    $probe = $this->sqlite->getFormDatabase($otherFormId)
                        ->prepare("SELECT COUNT(*) FROM fields WHERE type = 'linked_record' AND properties LIKE :needle");
                    $probe->execute(['needle' => '%' . $formId . '%']);
                    if ((int) $probe->fetchColumn() > 0) {
                        $reasons[] = 'targeted_by_linked_record';
                        break;
                    }
                } catch (\Throwable) {
                    $reasons[] = 'field_store_unreadable'; // fail closed
                    break;
                }
            }
        }

        // Field-type allowlist (P3): no file/camera fields until P4, no linked_record
        // ever in v1. Field definitions live in the per-form SQLite fields table.
        if ($this->sqlite !== null && $this->sqlite->formDatabaseExists($formId)) {
            try {
                $types = $this->sqlite->getFormDatabase($formId)
                    ->query('SELECT DISTINCT type FROM fields')
                    ->fetchAll(PDO::FETCH_COLUMN);
                foreach ($types as $type) {
                    if (in_array((string) $type, self::BLOCKED_FIELD_TYPES, true)) {
                        $reasons[] = 'blocked_field_types';
                        break;
                    }
                }
            } catch (\Throwable) {
                $reasons[] = 'field_store_unreadable'; // fail closed
            }
        }

        // Standalone forms only in P3 — app-runtime private forms arrive in P5.
        $stmt = $this->mysql->prepare('SELECT COUNT(*) FROM app_forms WHERE form_id = :f');
        $stmt->execute(['f' => $formId]);
        if ((int) $stmt->fetchColumn() > 0) {
            $reasons[] = 'attached_to_app';
        }

        if (!$hasVault) {
            $reasons[] = 'no_vault';
        }

        return $reasons;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Owner state + schema publishing
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * The owner's full encryption state (GET /api/forms/{id}/encryption). Byte fields
     * base64; signed_bytes as the exact canonical string. Null when not private.
     *
     * @return array<string,mixed>|null
     */
    public function getState(string $formId, string $userId): ?array
    {
        $stmt = $this->mysql->prepare('SELECT * FROM form_encryption WHERE form_id = :f');
        $stmt->execute(['f' => $formId]);
        $enc = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($enc)) {
            return null;
        }

        $stmt = $this->mysql->prepare("
            SELECT * FROM form_key_grants
            WHERE form_id = :f AND user_id = :u AND state <> 'revoked'
            ORDER BY fk_epoch DESC LIMIT 1
        ");
        $stmt->execute(['f' => $formId, 'u' => $userId]);
        $grantRow = $stmt->fetch(PDO::FETCH_ASSOC);
        $grant = is_array($grantRow) ? [
            'grantId' => (string) $grantRow['id'],
            'wrappedKey' => base64_encode((string) $grantRow['wrapped_key']),
            'fkEpoch' => (int) $grantRow['fk_epoch'],
            'grantorUserId' => (string) $grantRow['grantor_user_id'],
            'granteeUserId' => (string) $grantRow['user_id'],
            'granteePk' => (string) $grantRow['grantee_pk'],
            'signature' => base64_encode((string) $grantRow['signature']),
            'role' => (string) $grantRow['role'],
            'sigVersion' => (int) $grantRow['sig_version'],
        ] : null;

        $stmt = $this->mysql->prepare('SELECT * FROM form_ingestion_keys WHERE form_id = :f ORDER BY epoch ASC');
        $stmt->execute(['f' => $formId]);
        $keys = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $k) {
            $keys[] = [
                'id' => (string) $k['id'],
                'epoch' => (int) $k['epoch'],
                'publicKey' => (string) $k['public_key'],
                'wrappedSecret' => base64_encode((string) $k['wrapped_secret']),
                'fkEpoch' => (int) $k['fk_epoch'],
                'state' => (string) $k['state'],
            ];
        }

        $stmt = $this->mysql->prepare('SELECT * FROM form_manifests WHERE form_id = :f ORDER BY manifest_seq ASC');
        $stmt->execute(['f' => $formId]);
        $manifests = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $m) {
            $manifests[] = [
                'manifestSeq' => (int) $m['manifest_seq'],
                'keyId' => (string) $m['key_id'],
                'ingestEpoch' => (int) $m['ingest_epoch'],
                'schemaVersion' => (int) $m['schema_version'],
                'schemaHash' => (string) $m['schema_hash'],
                'contentSuite' => (string) $m['content_suite'],
                'wrapSuite' => (string) $m['wrap_suite'],
                'signerKeyId' => (string) $m['signer_key_id'],
                'signerPk' => (string) $m['signer_pk'],
                'signedBytes' => (string) $m['signed_bytes'],
                'signature' => base64_encode((string) $m['signature']),
                'expiresAt' => $m['expires_at'] !== null ? (string) $m['expires_at'] : null,
                'supersededAt' => $m['superseded_at'] !== null ? (string) $m['superseded_at'] : null,
            ];
        }

        $stmt = $this->mysql->prepare('SELECT version, schema_hash, schema_json FROM form_schema_versions WHERE form_id = :f ORDER BY version ASC');
        $stmt->execute(['f' => $formId]);
        $schemaVersions = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $s) {
            $schemaVersions[] = [
                'version' => (int) $s['version'],
                'schemaHash' => (string) $s['schema_hash'],
                'schemaJson' => (string) $s['schema_json'],
            ];
        }

        return [
            'encryption' => [
                'mode' => (string) $enc['mode'],
                'state' => (string) $enc['state'],
                'currentIngestEpoch' => (int) $enc['current_ingest_epoch'],
                'currentFkEpoch' => (int) $enc['current_fk_epoch'],
            ],
            'grant' => $grant,
            'ingestionKeys' => $keys,
            'manifests' => $manifests,
            'schemaVersions' => $schemaVersions,
        ];
    }

    /**
     * PHP-canonical fields hash of the latest non-superseded manifest's schema snapshot,
     * derived by decoding the stored schema_json and re-encoding it with the SAME flags
     * FormService::canonicalFieldsHash() uses. The manifest's stored schema_hash is the
     * CLIENT's sha256 over JSON.stringify(fields) — JS serializes empty objects as {}
     * where PHP json_encode() emits [], so comparing the client hash against a PHP
     * re-encoding would call every unchanged save "changed" (spurious 409
     * manifest_required). Both sides of the fields-changed comparison must use
     * PHP-canonical bytes; the client hash stays authoritative only for signatures/AAD.
     */
    public function latestManifestSchemaHash(string $formId): ?string
    {
        $stmt = $this->mysql->prepare("
            SELECT sv.schema_json FROM form_manifests m
            JOIN form_schema_versions sv
              ON sv.form_id = m.form_id AND sv.version = m.schema_version
            WHERE m.form_id = :f AND m.superseded_at IS NULL
            ORDER BY m.manifest_seq DESC LIMIT 1
        ");
        $stmt->execute(['f' => $formId]);
        $json = $stmt->fetchColumn();
        if ($json === false) {
            return null;
        }
        $fields = json_decode((string) $json, true);
        if (!is_array($fields)) {
            return null;
        }
        return hash('sha256', (string) json_encode($fields, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    }

    /**
     * Publish a new schema version (plan §8): appends form_schema_versions vN+1 and a
     * manifest row (seq M+1) binding the CURRENT active ingestion key + the new
     * version, signed by the owner's vault key; the previous manifest is superseded.
     * The client signs the same canonical string it expects the server to rebuild —
     * a version disagreement simply fails verification.
     *
     * @param array<string,mixed> $body {schemaJson, schemaHash, manifest:{signature, signerKeyId, expiresAt:null}}
     * @return array{schemaVersion: int, manifestSeq: int}
     * @throws EncryptionRequestException
     */
    public function publishSchemaVersion(string $formId, string $userId, array $body): array
    {
        if (!self::sodiumAvailable()) {
            throw new EncryptionRequestException('encryption_unavailable', 'Server-side signature verification (ext-sodium) is unavailable.', 503);
        }
        if (!$this->isPrivate($formId)) {
            throw new EncryptionRequestException('private_form_not_encrypted', 'This form is not a private form.', 404);
        }

        $this->mysql->beginTransaction();
        try {
            $result = $this->applySchemaPublishInTx($formId, $userId, $body);
            $this->mysql->commit();
            return $result;
        } catch (\Throwable $e) {
            if ($this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            throw $e;
        }
    }

    /**
     * The transactional core of schema publishing, shared by publishSchemaVersion
     * and the atomic form publish (FormService::updateForm's encryptionSchema
     * body key — same {schema, manifest} shape, same vault-signature
     * verification). REQUIRES an already-open transaction on the shared
     * connection; the caller owns commit/rollback so the schema version +
     * manifest land in the SAME transaction as the surrounding field/status save.
     *
     * @param array<string,mixed> $body {schema:{schemaJson,schemaHash}, manifest:{signature,signerKeyId,expiresAt:null}}
     * @return array{schemaVersion: int, manifestSeq: int}
     * @throws EncryptionRequestException
     */
    public function applySchemaPublishInTx(string $formId, string $userId, array $body): array
    {
        if (!self::sodiumAvailable()) {
            throw new EncryptionRequestException('encryption_unavailable', 'Server-side signature verification (ext-sodium) is unavailable.', 503);
        }
        $schema = $this->validateSchemaBlock($body['schema'] ?? $body);
        $manifest = $this->validateManifestBlock($body['manifest'] ?? null);
        $vault = $this->vaultRow($userId);
        if ($vault === null) {
            throw new EncryptionRequestException('vault_not_found', 'No vault exists for this account.', 404);
        }

        $stmt = $this->mysql->prepare('SELECT current_ingest_epoch FROM form_encryption WHERE form_id = :f FOR UPDATE');
        $stmt->execute(['f' => $formId]);
        $currentEpoch = (int) $stmt->fetchColumn();

        $stmt = $this->mysql->prepare('SELECT id, public_key FROM form_ingestion_keys WHERE form_id = :f AND epoch = :e');
        $stmt->execute(['f' => $formId, 'e' => $currentEpoch]);
        $keyRow = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($keyRow)) {
            throw new EncryptionRequestException('encryption_unavailable', 'The form has no current ingestion key.', 503);
        }

        $stmt = $this->mysql->prepare('SELECT COALESCE(MAX(version), 0) FROM form_schema_versions WHERE form_id = :f');
        $stmt->execute(['f' => $formId]);
        $newVersion = ((int) $stmt->fetchColumn()) + 1;

        $stmt = $this->mysql->prepare('SELECT COALESCE(MAX(manifest_seq), 0) FROM form_manifests WHERE form_id = :f');
        $stmt->execute(['f' => $formId]);
        $newSeq = ((int) $stmt->fetchColumn()) + 1;

        $signerKeyId = substr(hash('sha256', $vault['ed25519_pk_raw']), 0, 16);
        if (!hash_equals($signerKeyId, $manifest['signerKeyId'])) {
            throw new EncryptionRequestException('manifest_invalid', 'manifest signerKeyId does not match the requester vault signing key', 400);
        }
        $canonical = $this->manifestCanonical(
            $formId,
            (string) $keyRow['id'],
            $currentEpoch,
            (string) $keyRow['public_key'],
            $newVersion,
            $schema['schemaHash'],
            $signerKeyId,
            null
        );
        if (!sodium_crypto_sign_verify_detached($manifest['signatureRaw'], $canonical, $vault['ed25519_pk_raw'])) {
            throw new EncryptionRequestException('manifest_invalid', 'manifest signature verification failed', 400);
        }

        $now = date('Y-m-d H:i:s');
        $this->mysql->prepare("
            INSERT INTO form_schema_versions (id, form_id, version, schema_json, schema_hash, created_at)
            VALUES (:id, :f, :v, :json, :hash, :now)
        ")->execute([
            'id' => 'fsv_' . bin2hex(random_bytes(16)),
            'f' => $formId,
            'v' => $newVersion,
            'json' => $schema['schemaJson'],
            'hash' => $schema['schemaHash'],
            'now' => $now,
        ]);

        $this->mysql->prepare("
            UPDATE form_manifests SET superseded_at = :now WHERE form_id = :f AND superseded_at IS NULL
        ")->execute(['now' => $now, 'f' => $formId]);

        $this->mysql->prepare("
            INSERT INTO form_manifests
                (id, form_id, manifest_seq, key_id, ingest_epoch, schema_version, schema_hash,
                 content_suite, wrap_suite, signer_key_id, signer_pk, signed_bytes, signature,
                 created_at, expires_at, superseded_at)
            VALUES
                (:id, :f, :seq, :key, :epoch, :v, :hash, :content, :wrap, :skid, :spk, :bytes, :sig, :now, NULL, NULL)
        ")->execute([
            'id' => 'fm_' . bin2hex(random_bytes(16)),
            'f' => $formId,
            'seq' => $newSeq,
            'key' => (string) $keyRow['id'],
            'epoch' => $currentEpoch,
            'v' => $newVersion,
            'hash' => $schema['schemaHash'],
            'content' => self::CONTENT_SUITE,
            'wrap' => self::WRAP_SUITE,
            'skid' => $signerKeyId,
            'spk' => $vault['ed25519_pk_b64'],
            'bytes' => $canonical,
            'sig' => $manifest['signatureRaw'],
            'now' => $now,
        ]);

        return ['schemaVersion' => $newVersion, 'manifestSeq' => $newSeq];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Trash lifecycle (plan §7 rules — rows survive trash, purge deletes them)
    // ─────────────────────────────────────────────────────────────────────────

    /** Park a trashed form's encryption rows ('active' → 'trashed'). */
    public function markFormTrashed(string $formId): void
    {
        $this->mysql->prepare("UPDATE form_encryption SET state = 'trashed' WHERE form_id = :f AND state = 'active'")->execute(['f' => $formId]);
        $this->mysql->prepare("UPDATE form_ingestion_keys SET state = 'trashed' WHERE form_id = :f AND state = 'active'")->execute(['f' => $formId]);
        $this->mysql->prepare("UPDATE form_key_grants SET state = 'trashed' WHERE form_id = :f AND state = 'active'")->execute(['f' => $formId]);
        // form_manifests are append-only and carry no state — they stay put.
    }

    /** Reverse of markFormTrashed on restore ('trashed' → 'active'; 'revoked'/'retired' stay). */
    public function markFormRestored(string $formId): void
    {
        $this->mysql->prepare("UPDATE form_encryption SET state = 'active' WHERE form_id = :f AND state = 'trashed'")->execute(['f' => $formId]);
        $this->mysql->prepare("UPDATE form_ingestion_keys SET state = 'active' WHERE form_id = :f AND state = 'trashed'")->execute(['f' => $formId]);
        $this->mysql->prepare("UPDATE form_key_grants SET state = 'active' WHERE form_id = :f AND state = 'trashed'")->execute(['f' => $formId]);
        self::invalidateCache($formId);
    }

    /** Hard-delete every encryption row for a purged form (trash expiry / delete forever). */
    public function purgeFormRows(string $formId): void
    {
        foreach (['form_encryption', 'form_ingestion_keys', 'form_key_grants', 'form_manifests', 'form_schema_versions'] as $table) {
            $this->mysql->prepare("DELETE FROM {$table} WHERE form_id = :f")->execute(['f' => $formId]);
        }
        self::invalidateCache($formId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Metadata minimization (plan §12)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * The §12 privacy sweep: response_metadata rows belonging to PRIVATE forms keep
     * ip_address only for abuse/rate-limit forensics — after the retention window
     * (30 days) it is nulled out. user_agent/completion_time are never written for
     * private forms (createEncryptedResponse), so ip_address is the only column to
     * age out. Non-private forms are untouched (their metadata posture is unchanged).
     *
     * @return int number of rows nulled (or, with $dryRun, that WOULD be nulled)
     */
    public function runPrivacySweep(int $retentionDays = 30, bool $dryRun = false): int
    {
        $days = max(1, $retentionDays);
        $cutoff = (new \DateTimeImmutable("-{$days} days"))->format('Y-m-d H:i:s');
        if ($dryRun) {
            $stmt = $this->mysql->prepare("
                SELECT COUNT(*) FROM response_metadata rm
                JOIN form_encryption fe ON fe.form_id = rm.form_id
                WHERE rm.ip_address IS NOT NULL AND rm.submitted_at < :cutoff
            ");
            $stmt->execute(['cutoff' => $cutoff]);
            return (int) $stmt->fetchColumn();
        }
        $stmt = $this->mysql->prepare("
            UPDATE response_metadata rm
            JOIN form_encryption fe ON fe.form_id = rm.form_id
            SET rm.ip_address = NULL
            WHERE rm.ip_address IS NOT NULL AND rm.submitted_at < :cutoff
        ");
        $stmt->execute(['cutoff' => $cutoff]);
        return $stmt->rowCount();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Canonical strings (plan §8/§11 — byte-exact, pipe-delimited, '-' for absent)
    // ─────────────────────────────────────────────────────────────────────────

    private function manifestCanonical(string $formId, string $keyId, int $ingestEpoch, string $publicKeyB64, int $schemaVersion, string $schemaHash, string $signerKeyId, ?string $expiresAt): string
    {
        return 'flmanifest:1|' . $formId . '|' . $keyId . '|' . $ingestEpoch . '|' . $publicKeyB64
            . '|' . self::CONTENT_SUITE . '|' . self::WRAP_SUITE
            . '|' . $schemaVersion . '|' . $schemaHash . '|' . $signerKeyId . '|' . ($expiresAt ?: '-');
    }

    private function grantCanonical(string $grantId, string $formId, int $fkEpoch, string $grantorUserId, string $granteeUserId, string $granteeX25519PkRaw, string $wrappedKeyRaw, ?string $expiresAt): string
    {
        return 'flgrant:1|' . $grantId . '|' . $formId . '|' . $fkEpoch . '|' . $grantorUserId . '|' . $granteeUserId
            . '|' . hash('sha256', $granteeX25519PkRaw) . '|' . hash('sha256', $wrappedKeyRaw)
            . '|' . self::WRAP_SUITE . '|owner|' . ($expiresAt ?: '-');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Body validation helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @param array<string,mixed> $body
     * @return array{
     *   keyId: string, ingestionPublicKeyB64: string, wrappedIngestionSecretRaw: string,
     *   grant: array{grantId: string, wrappedKeyRaw: string, signatureRaw: string},
     *   schema: array{schemaJson: string, schemaHash: string},
     *   manifest: array{signatureRaw: string, signerKeyId: string}
     * }
     * @throws EncryptionRequestException
     */
    private function validateEnableBody(array $body): array
    {
        $fail = static function (string $message): never {
            throw new EncryptionRequestException('encryption_payload_invalid', $message, 400);
        };

        $keyId = $body['keyId'] ?? null;
        if (!is_string($keyId) || preg_match(self::KEY_ID_RE, $keyId) !== 1) {
            $fail('keyId malformed');
        }
        if (($body['ingestEpoch'] ?? null) !== 1 || ($body['fkEpoch'] ?? null) !== 1) {
            $fail('ingestEpoch and fkEpoch must both be 1 at enable time');
        }
        $ingestionPkRaw = $this->decodeExactB64($body['ingestionPublicKey'] ?? null, self::INGESTION_PK_BYTES);
        if ($ingestionPkRaw === null) {
            $fail('ingestionPublicKey must be canonical base64 of exactly 32 bytes');
        }
        $wrappedSecretRaw = $this->decodeExactB64($body['wrappedIngestionSecret'] ?? null, self::WRAPPED_INGESTION_SECRET_BYTES);
        if ($wrappedSecretRaw === null) {
            $fail('wrappedIngestionSecret must be canonical base64 of exactly 72 bytes');
        }

        $grant = $body['grant'] ?? null;
        if (!is_array($grant)) {
            $fail('grant is required');
        }
        $grantId = $grant['grantId'] ?? null;
        if (!is_string($grantId) || preg_match(self::GRANT_ID_RE, $grantId) !== 1) {
            $fail('grant.grantId malformed');
        }
        $wrappedKeyRaw = $this->decodeExactB64($grant['wrappedKey'] ?? null, self::GRANT_WRAPPED_KEY_BYTES);
        if ($wrappedKeyRaw === null) {
            $fail('grant.wrappedKey must be canonical base64 of exactly 80 bytes');
        }
        $grantSigRaw = $this->decodeExactB64($grant['signature'] ?? null, self::SIGNATURE_BYTES);
        if ($grantSigRaw === null) {
            $fail('grant.signature must be canonical base64 of exactly 64 bytes');
        }
        if (($grant['role'] ?? null) !== 'owner' || ($grant['sigVersion'] ?? null) !== 1) {
            $fail('grant.role must be owner with sigVersion 1');
        }

        $schema = $this->validateSchemaBlock($body['schema'] ?? null);
        $manifest = $this->validateManifestBlock($body['manifest'] ?? null);

        return [
            'keyId' => $keyId,
            'ingestionPublicKeyB64' => base64_encode($ingestionPkRaw),
            'wrappedIngestionSecretRaw' => $wrappedSecretRaw,
            'grant' => ['grantId' => $grantId, 'wrappedKeyRaw' => $wrappedKeyRaw, 'signatureRaw' => $grantSigRaw],
            'schema' => $schema,
            'manifest' => $manifest,
        ];
    }

    /**
     * @return array{schemaJson: string, schemaHash: string}
     * @throws EncryptionRequestException
     */
    private function validateSchemaBlock(mixed $schema): array
    {
        if (!is_array($schema)) {
            throw new EncryptionRequestException('encryption_payload_invalid', 'schema is required', 400);
        }
        $json = $schema['schemaJson'] ?? null;
        if (!is_string($json) || $json === '' || strlen($json) > self::MAX_SCHEMA_JSON_BYTES) {
            throw new EncryptionRequestException('encryption_payload_invalid', 'schemaJson must be a non-empty string of at most 1 MB', 400);
        }
        $hash = $schema['schemaHash'] ?? null;
        if (!is_string($hash) || preg_match(self::SCHEMA_HASH_RE, $hash) !== 1) {
            throw new EncryptionRequestException('encryption_payload_invalid', 'schemaHash must be 64 lowercase hex chars', 400);
        }
        // The hash is verified against the EXACT bytes — the server never re-encodes.
        if (!hash_equals(hash('sha256', $json), $hash)) {
            throw new EncryptionRequestException('manifest_invalid', 'schemaHash does not match schemaJson bytes', 400);
        }
        return ['schemaJson' => $json, 'schemaHash' => $hash];
    }

    /**
     * @return array{signatureRaw: string, signerKeyId: string}
     * @throws EncryptionRequestException
     */
    private function validateManifestBlock(mixed $manifest): array
    {
        if (!is_array($manifest)) {
            throw new EncryptionRequestException('encryption_payload_invalid', 'manifest is required', 400);
        }
        $sigRaw = $this->decodeExactB64($manifest['signature'] ?? null, self::SIGNATURE_BYTES);
        if ($sigRaw === null) {
            throw new EncryptionRequestException('encryption_payload_invalid', 'manifest.signature must be canonical base64 of exactly 64 bytes', 400);
        }
        $signerKeyId = $manifest['signerKeyId'] ?? null;
        if (!is_string($signerKeyId) || preg_match(self::SIGNER_KEY_ID_RE, $signerKeyId) !== 1) {
            throw new EncryptionRequestException('encryption_payload_invalid', 'manifest.signerKeyId must be 16 lowercase hex chars', 400);
        }
        if (array_key_exists('expiresAt', $manifest) && $manifest['expiresAt'] !== null) {
            throw new EncryptionRequestException('encryption_payload_invalid', 'manifest.expiresAt must be null in v1', 400);
        }
        return ['signatureRaw' => $sigRaw, 'signerKeyId' => $signerKeyId];
    }

    /**
     * @return array{ed25519_pk_raw: string, x25519_pk_raw: string, ed25519_pk_b64: string, x25519_pk_b64: string}|null
     */
    private function vaultRow(string $userId): ?array
    {
        $stmt = $this->mysql->prepare('SELECT x25519_pk, ed25519_pk FROM user_vaults WHERE user_id = :u');
        $stmt->execute(['u' => $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            return null;
        }
        $ed = base64_decode((string) $row['ed25519_pk'], true);
        $x = base64_decode((string) $row['x25519_pk'], true);
        if ($ed === false || strlen($ed) !== 32 || $x === false || strlen($x) !== 32) {
            return null; // corrupt vault row — treat as absent, fail closed
        }
        return [
            'ed25519_pk_raw' => $ed,
            'x25519_pk_raw' => $x,
            'ed25519_pk_b64' => (string) $row['ed25519_pk'],
            'x25519_pk_b64' => (string) $row['x25519_pk'],
        ];
    }

    /** Canonical padded base64: strict decode + re-encode round-trip + exact length. */
    private function decodeExactB64(mixed $value, int $expectedBytes): ?string
    {
        if (!is_string($value) || $value === '' || strlen($value) % 4 !== 0) {
            return null;
        }
        $decoded = base64_decode($value, true);
        if ($decoded === false || base64_encode($decoded) !== $value || strlen($decoded) !== $expectedBytes) {
            return null;
        }
        return $decoded;
    }

    private function isDuplicateKey(\PDOException $e): bool
    {
        return $e->getCode() === '23000' || (isset($e->errorInfo[1]) && (int) $e->errorInfo[1] === 1062);
    }
}
