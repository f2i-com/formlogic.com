<?php

declare(strict_types=1);

namespace FormLogic\Services\Flows;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * SRV-404: the ArtifactRef subsystem — storage, authorization, locality, expiry, quota, cleanup.
 *
 * Flow nodes increasingly produce things that are too big to travel in-band: a generated image,
 * a recorded call, a transcribed audio file. Embedding those in node payloads would put them
 * inside every persisted flow revision, every run log, and every message between runtimes —
 * which is both a size problem and a privacy one, since run logs are read by people debugging
 * unrelated things. A node therefore emits an {@see \docs/contracts/artifact-ref.v1.schema.json}
 * ArtifactRef: an opaque handle plus enough metadata (kind, media type, size, digest) for a
 * consumer to decide whether it wants the bytes at all.
 *
 * Three properties are load-bearing:
 *
 * 1. **No local paths leak.** The wire projection is built by {@see toRef()} and contains no
 *    storage key, path, URL, or bucket — nothing that survives into a run log could be used to
 *    reach the bytes directly. Reads always go through {@see read()}, which authorizes first.
 *
 * 2. **Locality is honest.** Bytes produced on a Desktop stay on that Desktop unless someone
 *    explicitly moves them. A run on a different device gets a typed `artifact_wrong_device`
 *    refusal rather than a silent upload the owner never approved, or a handle that mysteriously
 *    resolves to nothing.
 *
 * 3. **Cleanup is deterministic.** {@see sweep()} removes exactly the rows whose `expires_at`
 *    has passed, in a defined order, and unlinks their bytes; running it twice removes nothing
 *    the second time. Expiry is a property of the ref itself, so an expired artifact refuses to
 *    resolve whether or not the sweep has run yet — the schedule can lag without widening access.
 */
class ArtifactService
{
    /** Per-owner ceiling on live artifact bytes. A producer loop cannot fill the disk. */
    public const QUOTA_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

    /** Largest single artifact. Bigger content belongs in a form upload, not a flow value. */
    public const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

    /** Default lifetime. Artifacts are working values between nodes, not durable records. */
    public const DEFAULT_TTL_SECONDS = 7 * 24 * 3600;

    public const KINDS = ['image', 'audio', 'video', 'text', 'file'];

    private PDO $mysql;
    private string $root;

    public function __construct(MySQLConnection $mysql, ?string $storageRoot = null)
    {
        $this->mysql = $mysql->getConnection();
        $this->root = rtrim($storageRoot ?? __DIR__ . '/../../../storage/artifacts', '/\\');
    }

    /**
     * Store cloud-resident bytes and return the ref.
     *
     * @param array{kind?:string,mediaType?:string,filename?:string,ttlSeconds?:int,runId?:string} $meta
     * @return array<string,mixed> the ArtifactRef wire shape
     * @throws \RuntimeException typed: artifact_invalid | artifact_too_large | artifact_quota_exceeded
     */
    public function store(string $userId, string $bytes, array $meta = []): array
    {
        $size = strlen($bytes);
        if ($size > self::MAX_ARTIFACT_BYTES) {
            throw new \RuntimeException('artifact_too_large: artifact exceeds the ' . self::MAX_ARTIFACT_BYTES . ' byte ceiling');
        }
        $this->assertQuota($userId, $size);

        $id = $this->newId();
        $key = $this->storageKeyFor($userId, $id);
        $path = $this->root . '/' . $key;
        $dir = dirname($path);
        if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) {
            throw new \RuntimeException('artifact_storage_unavailable: could not create the artifact directory');
        }
        if (file_put_contents($path, $bytes) === false) {
            throw new \RuntimeException('artifact_storage_unavailable: could not write the artifact');
        }

        return $this->insert($userId, $id, $key, $size, hash('sha256', $bytes), 'cloud', null, $meta);
    }

    /**
     * Register bytes that live on a DEVICE. No content is transferred here — the row records
     * where the artifact is so consumers elsewhere fail honestly instead of silently.
     *
     * @param array{kind?:string,mediaType?:string,filename?:string,ttlSeconds?:int,runId?:string,byteSize?:int,digest?:string} $meta
     * @return array<string,mixed>
     */
    public function registerDeviceArtifact(string $userId, string $deviceId, array $meta = []): array
    {
        if ($deviceId === '' || strlen($deviceId) > 64) {
            throw new \RuntimeException('artifact_invalid: a device artifact requires a device id');
        }
        $size = (int) ($meta['byteSize'] ?? 0);
        if ($size < 0 || $size > self::MAX_ARTIFACT_BYTES) {
            throw new \RuntimeException('artifact_too_large: artifact exceeds the ' . self::MAX_ARTIFACT_BYTES . ' byte ceiling');
        }
        // Device bytes do not consume cloud storage, but they DO count toward the owner's
        // artifact budget: the ceiling is about how much a flow may accumulate, not about disk.
        $this->assertQuota($userId, $size);

        $digest = is_string($meta['digest'] ?? null) && preg_match('/^[a-f0-9]{64}$/', $meta['digest']) === 1
            ? $meta['digest']
            : null;
        return $this->insert($userId, $this->newId(), null, $size, $digest, 'device', $deviceId, $meta);
    }

    /**
     * Resolve a ref for a consumer. `$deviceId` is the device asking (null = cloud/browser).
     *
     * @return array{ok:true,ref:array<string,mixed>}|array{ok:false,code:string,message:string}
     */
    public function resolve(string $userId, string $artifactId, ?string $deviceId = null): array
    {
        $row = $this->row($userId, $artifactId);
        if ($row === null) {
            // Missing and foreign are the SAME answer: a probe cannot learn that an id exists
            // under another account.
            return ['ok' => false, 'code' => 'artifact_not_found', 'message' => 'No such artifact'];
        }
        if ($this->isExpired($row)) {
            return ['ok' => false, 'code' => 'artifact_expired', 'message' => 'This artifact has expired'];
        }
        if ($row['locality'] === 'device' && (string) $row['device_id'] !== (string) $deviceId) {
            return [
                'ok' => false,
                'code' => 'artifact_wrong_device',
                'message' => 'This artifact lives on another device and was not transferred here',
            ];
        }
        return ['ok' => true, 'ref' => $this->toRef($row)];
    }

    /**
     * Read the bytes. Cloud artifacts return content; device artifacts never do — the bytes are
     * not here, and pretending otherwise would return an empty file that looks like data.
     *
     * @return array{ok:true,bytes:string,ref:array<string,mixed>}|array{ok:false,code:string,message:string}
     */
    public function read(string $userId, string $artifactId, ?string $deviceId = null): array
    {
        $resolved = $this->resolve($userId, $artifactId, $deviceId);
        if ($resolved['ok'] !== true) {
            return $resolved;
        }
        $row = $this->row($userId, $artifactId);
        if ($row === null) {
            return ['ok' => false, 'code' => 'artifact_not_found', 'message' => 'No such artifact'];
        }
        if ($row['locality'] === 'device') {
            return [
                'ok' => false,
                'code' => 'artifact_remote',
                'message' => 'This artifact is stored on a device and must be fetched from it',
            ];
        }
        $path = $this->root . '/' . (string) $row['storage_key'];
        $bytes = is_file($path) ? file_get_contents($path) : false;
        if ($bytes === false) {
            // The row outlived its bytes. Say so rather than returning an empty artifact.
            return ['ok' => false, 'code' => 'artifact_missing_content', 'message' => 'The artifact content is no longer available'];
        }
        $this->mysql->prepare('UPDATE flow_artifacts SET last_accessed_at = NOW() WHERE id = ?')->execute([$artifactId]);
        return ['ok' => true, 'bytes' => $bytes, 'ref' => $this->toRef($row)];
    }

    /** Delete one artifact (owner only). Idempotent: deleting twice is not an error. */
    public function delete(string $userId, string $artifactId): bool
    {
        $row = $this->row($userId, $artifactId);
        if ($row === null) {
            return false;
        }
        $this->unlink($row);
        $stmt = $this->mysql->prepare('DELETE FROM flow_artifacts WHERE id = ? AND user_id = ?');
        $stmt->execute([$artifactId, $userId]);
        return $stmt->rowCount() > 0;
    }

    /**
     * Deterministic cleanup: remove exactly the artifacts whose expiry has passed, oldest first,
     * unlinking their bytes. Returns what it did. Running it again immediately removes nothing.
     *
     * @return array{removed:int,bytesFreed:int,orphanFilesRemoved:int}
     */
    public function sweep(int $limit = 1000): array
    {
        $stmt = $this->mysql->prepare('
            SELECT id, user_id, storage_key, byte_size, locality
            FROM flow_artifacts
            WHERE expires_at IS NOT NULL AND expires_at <= NOW()
            ORDER BY expires_at ASC, id ASC
            LIMIT ' . max(1, min(10000, $limit))
        );
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $removed = 0;
        $bytesFreed = 0;
        foreach ($rows as $row) {
            $this->unlink($row);
            $del = $this->mysql->prepare('DELETE FROM flow_artifacts WHERE id = ?');
            $del->execute([(string) $row['id']]);
            if ($del->rowCount() > 0) {
                $removed++;
                $bytesFreed += (int) $row['byte_size'];
            }
        }
        return ['removed' => $removed, 'bytesFreed' => $bytesFreed, 'orphanFilesRemoved' => 0];
    }

    /** @return array{bytes:int,count:int,quota:int} */
    public function usage(string $userId): array
    {
        $stmt = $this->mysql->prepare('
            SELECT COALESCE(SUM(byte_size), 0) AS bytes, COUNT(*) AS n
            FROM flow_artifacts
            WHERE user_id = ? AND (expires_at IS NULL OR expires_at > NOW())
        ');
        $stmt->execute([$userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: ['bytes' => 0, 'n' => 0];
        return ['bytes' => (int) $row['bytes'], 'count' => (int) $row['n'], 'quota' => self::QUOTA_BYTES];
    }

    /**
     * The WIRE projection. Everything a consumer may see, and nothing that could be used to
     * reach the bytes without passing through authorization: no storage key, no path, no URL.
     *
     * @param array<string,mixed> $row
     * @return array<string,mixed>
     */
    public function toRef(array $row): array
    {
        $ref = [
            '$artifact' => (string) $row['id'],
            'kind' => (string) $row['kind'],
            'mediaType' => (string) $row['media_type'],
            'byteSize' => (int) $row['byte_size'],
            'locality' => (string) $row['locality'],
        ];
        if (is_string($row['digest'] ?? null) && $row['digest'] !== '') {
            $ref['digest'] = (string) $row['digest'];
        }
        if ($row['locality'] === 'device' && is_string($row['device_id'] ?? null) && $row['device_id'] !== '') {
            $ref['deviceId'] = (string) $row['device_id'];
        }
        if (is_string($row['expires_at'] ?? null) && $row['expires_at'] !== '') {
            $ref['expiresAt'] = str_replace(' ', 'T', (string) $row['expires_at']) . 'Z';
        }
        if (is_string($row['filename'] ?? null) && $row['filename'] !== '') {
            $ref['filename'] = (string) $row['filename'];
        }
        return $ref;
    }

    /** Is this value an ArtifactRef? Used by runtimes to spot refs inside node payloads. */
    public static function isRef(mixed $value): bool
    {
        return is_array($value)
            && is_string($value['$artifact'] ?? null)
            && preg_match('/^art_[a-z0-9]{24}$/', $value['$artifact']) === 1;
    }

    // ── internals ───────────────────────────────────────────────────────────────────────────

    /** @param array<string,mixed> $meta @return array<string,mixed> */
    private function insert(
        string $userId,
        string $id,
        ?string $storageKey,
        int $size,
        ?string $digest,
        string $locality,
        ?string $deviceId,
        array $meta
    ): array {
        $kind = is_string($meta['kind'] ?? null) && in_array($meta['kind'], self::KINDS, true) ? $meta['kind'] : 'file';
        $mediaType = is_string($meta['mediaType'] ?? null) && $meta['mediaType'] !== ''
            ? substr($meta['mediaType'], 0, 190)
            : 'application/octet-stream';
        // ~ delimiters: a media type may legally contain '#', which would end a #-delimited pattern.
        if (preg_match('~^[a-zA-Z0-9][\w!#$&^.+-]*/[a-zA-Z0-9][\w!#$&^.+-]*$~', $mediaType) !== 1) {
            throw new \RuntimeException('artifact_invalid: mediaType is not a media type');
        }
        // A filename is DISPLAY only — it never contributes to the storage key, so a crafted
        // name cannot escape the artifact directory. Stripped to a leaf regardless.
        $filename = is_string($meta['filename'] ?? null) && $meta['filename'] !== ''
            ? substr(basename(str_replace('\\', '/', $meta['filename'])), 0, 190)
            : null;
        $ttl = (int) ($meta['ttlSeconds'] ?? self::DEFAULT_TTL_SECONDS);
        $ttl = max(60, min(90 * 24 * 3600, $ttl));
        $runId = is_string($meta['runId'] ?? null) && $meta['runId'] !== '' ? substr($meta['runId'], 0, 36) : null;

        $this->mysql->prepare('
            INSERT INTO flow_artifacts
                (id, user_id, run_id, kind, media_type, filename, byte_size, digest, locality, device_id, storage_key, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? SECOND))
        ')->execute([$id, $userId, $runId, $kind, $mediaType, $filename, $size, $digest, $locality, $deviceId, $storageKey, $ttl]);

        $row = $this->row($userId, $id);
        return $row === null ? [] : $this->toRef($row);
    }

    private function assertQuota(string $userId, int $incoming): void
    {
        $usage = $this->usage($userId);
        if ($usage['bytes'] + $incoming > self::QUOTA_BYTES) {
            throw new \RuntimeException(
                'artifact_quota_exceeded: this account is holding ' . $usage['bytes'] . ' of ' . self::QUOTA_BYTES
                . ' artifact bytes — delete artifacts or wait for expiry'
            );
        }
    }

    /** @return array<string,mixed>|null */
    private function row(string $userId, string $artifactId): ?array
    {
        if (preg_match('/^art_[a-z0-9]{24}$/', $artifactId) !== 1) {
            return null;
        }
        $stmt = $this->mysql->prepare('SELECT * FROM flow_artifacts WHERE id = ? AND user_id = ?');
        $stmt->execute([$artifactId, $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }

    /** @param array<string,mixed> $row */
    private function isExpired(array $row): bool
    {
        $expires = $row['expires_at'] ?? null;
        return is_string($expires) && $expires !== '' && strtotime($expires . ' UTC') <= time();
    }

    /** @param array<string,mixed> $row */
    private function unlink(array $row): void
    {
        $key = $row['storage_key'] ?? null;
        if (!is_string($key) || $key === '') {
            return; // device artifacts hold no cloud bytes
        }
        $path = $this->root . '/' . $key;
        // The key is machine-generated, but re-check containment anyway: a corrupted row must
        // never be able to unlink outside the artifact tree.
        $realRoot = realpath($this->root);
        $realPath = realpath($path);
        if ($realRoot !== false && $realPath !== false && str_starts_with($realPath, $realRoot) && is_file($realPath)) {
            @unlink($realPath);
        }
    }

    /** Storage layout is derived from ids only — never from a filename or media type. */
    private function storageKeyFor(string $userId, string $id): string
    {
        return substr(hash('sha256', $userId), 0, 2) . '/' . hash('sha256', $userId) . '/' . $id . '.bin';
    }

    private function newId(): string
    {
        $alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
        $out = '';
        for ($i = 0; $i < 24; $i++) {
            $out .= $alphabet[random_int(0, 35)];
        }
        return 'art_' . $out;
    }
}
