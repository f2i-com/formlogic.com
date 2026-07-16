<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * Server-only push registry and privacy-safe offer outbox.
 *
 * Provider tokens are envelope encrypted and are only exposed by claimPending()
 * to a trusted in-process delivery worker. Browser, native and plugin APIs only
 * receive redacted endpoint/delivery metadata. Broker deployments store an
 * opaque broker handle and never receive the provider token.
 */
final class AokieCompanionPushService
{
    public const ENDPOINT_KINDS = ['fcm', 'apns', 'apns_voip'];
    public const OFFER_KINDS = ['call_alert', 'assistance_request', 'takeover_offer'];
    private const CLAIM_LEASE_SECONDS = 30;
    private const MAX_ATTEMPTS = 3;

    public function __construct(private readonly MySQLConnection $mysql) {}

    /** @return array<string,mixed> */
    public function registerEndpoint(
        string $appId,
        string $deviceId,
        string $kind,
        array $input,
    ): array {
        if (array_diff(array_keys($input), [
            'mode', 'token', 'brokerHandle', 'environment', 'topic',
        ]) !== []) {
            throw new \InvalidArgumentException('Push endpoint contains unsupported fields');
        }
        if (!in_array($kind, self::ENDPOINT_KINDS, true)) {
            throw new \InvalidArgumentException('Push endpoint kind must be fcm, apns, or apns_voip');
        }
        $mode = is_string($input['mode'] ?? null) ? $input['mode'] : '';
        if (!in_array($mode, ['managed', 'broker'], true)) {
            throw new \InvalidArgumentException('Push endpoint mode must be managed or broker');
        }
        if (($mode === 'managed' && array_key_exists('brokerHandle', $input))
            || ($mode === 'broker' && array_key_exists('token', $input))) {
            throw new \InvalidArgumentException('Push endpoint credentials must match the selected delivery mode');
        }
        $environment = is_string($input['environment'] ?? null) ? $input['environment'] : '';
        if (!in_array($environment, ['sandbox', 'production'], true)) {
            throw new \InvalidArgumentException('Push endpoint environment must be sandbox or production');
        }
        $topic = $this->cleanText(is_string($input['topic'] ?? null) ? $input['topic'] : '', 255);
        if (str_starts_with($kind, 'apns')
            && ($topic === '' || preg_match('/^[A-Za-z0-9.-]{3,255}$/D', $topic) !== 1)) {
            throw new \InvalidArgumentException('APNs endpoints require the exact bundle topic');
        }
        if ($kind === 'fcm' && $topic !== '' && preg_match('/^[A-Za-z0-9._-]{1,255}$/D', $topic) !== 1) {
            throw new \InvalidArgumentException('FCM topic metadata is invalid');
        }

        $provider = $mode === 'managed' ? ($kind === 'fcm' ? 'fcm' : 'apns') : 'broker';
        $secret = $mode === 'managed' ? ($input['token'] ?? null) : ($input['brokerHandle'] ?? null);
        $maxSecretBytes = $mode === 'managed' ? 4096 : 512;
        if (!is_string($secret) || strlen($secret) < 16 || strlen($secret) > $maxSecretBytes
            || preg_match('/[\x00-\x1F\x7F]/', $secret)) {
            throw new \InvalidArgumentException($mode === 'managed'
                ? 'A provider token of 16 to 4096 printable bytes is required'
                : 'An opaque broker handle of 16 to 512 printable bytes is required');
        }
        $ciphertext = $mode === 'managed' ? $this->encrypt($secret) : null;
        $brokerHandle = $mode === 'broker' ? $secret : null;
        $fingerprint = hash('sha256', $secret);

        $pdo = $this->db();
        $pdo->beginTransaction();
        try {
            $device = $pdo->prepare(
                "SELECT id FROM aokie_companion_devices
                 WHERE id = :device AND app_id = :app AND role = 'mobile' AND revoked_at IS NULL
                 FOR UPDATE"
            );
            $device->execute(['device' => $deviceId, 'app' => $appId]);
            if ($device->fetchColumn() === false) {
                throw new \DomainException('Active app-bound mobile endpoint not found');
            }
            $existing = $pdo->prepare(
                'SELECT id FROM aokie_companion_push_endpoints
                 WHERE app_id = :app AND device_id = :device AND endpoint_kind = :kind FOR UPDATE'
            );
            $existing->execute(['app' => $appId, 'device' => $deviceId, 'kind' => $kind]);
            $id = $existing->fetchColumn();
            if (is_string($id)) {
                $pdo->prepare(
                    'UPDATE aokie_companion_push_endpoints
                     SET delivery_mode = :mode, provider = :provider, environment = :environment,
                         topic = :topic, endpoint_ciphertext = :ciphertext, broker_handle = :handle,
                         endpoint_fingerprint = :fingerprint, invalidated_at = NULL, rotated_at = NOW()
                     WHERE id = :id'
                )->execute([
                    'mode' => $mode,
                    'provider' => $provider,
                    'environment' => $environment,
                    'topic' => $topic !== '' ? $topic : null,
                    'ciphertext' => $ciphertext,
                    'handle' => $brokerHandle,
                    'fingerprint' => $fingerprint,
                    'id' => $id,
                ]);
            } else {
                $id = self::uuid();
                $pdo->prepare(
                    'INSERT INTO aokie_companion_push_endpoints
                        (id, app_id, device_id, endpoint_kind, delivery_mode, provider,
                         environment, topic, endpoint_ciphertext, broker_handle, endpoint_fingerprint)
                     VALUES (:id, :app, :device, :kind, :mode, :provider,
                             :environment, :topic, :ciphertext, :handle, :fingerprint)'
                )->execute([
                    'id' => $id,
                    'app' => $appId,
                    'device' => $deviceId,
                    'kind' => $kind,
                    'mode' => $mode,
                    'provider' => $provider,
                    'environment' => $environment,
                    'topic' => $topic !== '' ? $topic : null,
                    'ciphertext' => $ciphertext,
                    'handle' => $brokerHandle,
                    'fingerprint' => $fingerprint,
                ]);
            }
            $pdo->commit();
        } catch (\Throwable $error) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $error;
        }
        return $this->endpointById((string) $id)
            ?? throw new \RuntimeException('Push endpoint save failed');
    }

    public function removeEndpoint(string $appId, string $deviceId, string $kind): bool
    {
        if (!in_array($kind, self::ENDPOINT_KINDS, true)) {
            throw new \InvalidArgumentException('Push endpoint kind must be fcm, apns, or apns_voip');
        }
        $stmt = $this->db()->prepare(
            'DELETE FROM aokie_companion_push_endpoints
             WHERE app_id = :app AND device_id = :device AND endpoint_kind = :kind'
        );
        $stmt->execute(['app' => $appId, 'device' => $deviceId, 'kind' => $kind]);
        return $stmt->rowCount() === 1;
    }

    /** @return list<array<string,mixed>> */
    public function listForDevice(string $appId, string $deviceId): array
    {
        $stmt = $this->db()->prepare(
            'SELECT * FROM aokie_companion_push_endpoints
             WHERE app_id = :app AND device_id = :device ORDER BY endpoint_kind ASC'
        );
        $stmt->execute(['app' => $appId, 'device' => $deviceId]);
        return array_map([$this, 'formatEndpoint'], $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    /**
     * Persist one privacy-safe alert/offer target set. Invitation IDs remain
     * opaque; the durable payload deliberately contains only the four fields
     * allowed by the mobile privacy contract.
     *
     * @return array<string,mixed>|null
     */
    public function existingOffer(
        string $appId,
        string $routingGroupId,
        string $kind,
        string $invitationId,
        string $collapseId,
        int $expiresAt,
    ): ?array {
        [$payload, $invitationHash, $requestHash] = $this->offerIdentity(
            $appId,
            $routingGroupId,
            $kind,
            $invitationId,
            $collapseId,
            $expiresAt,
        );
        $stmt = $this->db()->prepare(
            'SELECT id, request_hash FROM aokie_companion_offers
             WHERE app_id = :app AND invitation_hash = :invitation'
        );
        $stmt->execute(['app' => $appId, 'invitation' => $invitationHash]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return null;
        }
        if (!hash_equals((string) $row['request_hash'], $requestHash)) {
            throw new \DomainException('invitationId was already used for a different offer');
        }
        return $this->offerResult($appId, (string) $row['id'], $payload, true);
    }

    /**
     * @param list<array<string,mixed>> $targets
     * @return array<string,mixed>
     */
    public function queueOffer(
        string $appId,
        string $routingGroupId,
        string $kind,
        string $invitationId,
        string $collapseId,
        int $expiresAt,
        array $targets,
    ): array {
        [$payload, $invitationHash, $requestHash] = $this->offerIdentity(
            $appId,
            $routingGroupId,
            $kind,
            $invitationId,
            $collapseId,
            $expiresAt,
        );

        $pdo = $this->db();
        $pdo->beginTransaction();
        try {
            $existing = $pdo->prepare(
                'SELECT * FROM aokie_companion_offers
                 WHERE app_id = :app AND invitation_hash = :invitation FOR UPDATE'
            );
            $existing->execute(['app' => $appId, 'invitation' => $invitationHash]);
            $offer = $existing->fetch(PDO::FETCH_ASSOC);
            if ($offer && !hash_equals((string) $offer['request_hash'], $requestHash)) {
                throw new \DomainException('invitationId was already used for a different offer');
            }
            if (!$offer) {
                $offerId = self::uuid();
                $pdo->prepare(
                    'INSERT INTO aokie_companion_offers
                        (id, app_id, routing_group_id, offer_kind, invitation_hash,
                         request_hash, collapse_hash, expires_at)
                     VALUES (:id, :app, :group, :kind, :invitation,
                             :request, :collapse, :expires)'
                )->execute([
                    'id' => $offerId,
                    'app' => $appId,
                    'group' => $routingGroupId,
                    'kind' => $kind,
                    'invitation' => $invitationHash,
                    'request' => $requestHash,
                    'collapse' => hash('sha256', $collapseId),
                    'expires' => gmdate('Y-m-d H:i:s', $expiresAt),
                ]);
            } else {
                $offerId = (string) $offer['id'];
            }

            foreach ($targets as $target) {
                $deviceId = $this->requiredSafeId($target['deviceId'] ?? null, 'target.deviceId');
                $device = $pdo->prepare(
                    "SELECT id FROM aokie_companion_devices
                     WHERE id = :device AND app_id = :app AND role = 'mobile' AND revoked_at IS NULL"
                );
                $device->execute(['device' => $deviceId, 'app' => $appId]);
                if ($device->fetchColumn() === false) {
                    throw new \DomainException('Offer target is not an active mobile endpoint in this app');
                }
                $endpoint = $this->preferredEndpoint($pdo, $appId, $deviceId, $kind);
                $deliveryId = self::uuid();
                $pdo->prepare(
                    'INSERT IGNORE INTO aokie_companion_push_deliveries
                        (id, app_id, offer_id, device_id, push_endpoint_id, status,
                         payload_json, expires_at)
                     VALUES (:id, :app, :offer, :device, :endpoint, :status, :payload, :expires)'
                )->execute([
                    'id' => $deliveryId,
                    'app' => $appId,
                    'offer' => $offerId,
                    'device' => $deviceId,
                    'endpoint' => $endpoint['id'] ?? null,
                    'status' => $endpoint === null ? 'realtime_only' : 'queued',
                    'payload' => json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR),
                    'expires' => gmdate('Y-m-d H:i:s', $expiresAt),
                ]);
            }
            $pdo->commit();
        } catch (\Throwable $error) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $error;
        }
        return $this->offerResult($appId, (string) $offerId, $payload, $offer !== false);
    }

    /**
     * Trusted worker boundary. This is intentionally not exposed by a browser,
     * native or plugin route.
     *
     * @return list<array<string,mixed>>
     */
    public function claimPending(int $limit = 50): array
    {
        $limit = max(1, min(100, $limit));
        $pdo = $this->db();
        $pdo->beginTransaction();
        try {
            $pdo->prepare(
                "UPDATE aokie_companion_push_deliveries
                 SET status = 'expired', completed_at = NOW()
                 WHERE status IN ('queued','claimed') AND expires_at <= NOW()"
            )->execute();
            // A worker can die after claiming but before reporting a provider
            // result. Requeue its expired claim; collapseId makes this an
            // intentional at-least-once boundary rather than a lost wake-up.
            $pdo->exec(
                "UPDATE aokie_companion_push_deliveries
                 SET status = 'failed', completed_at = NOW()
                 WHERE status = 'claimed' AND attempt_count >= " . self::MAX_ATTEMPTS . "
                   AND claimed_at < DATE_SUB(NOW(), INTERVAL " . self::CLAIM_LEASE_SECONDS . " SECOND)"
            );
            $pdo->exec(
                "UPDATE aokie_companion_push_deliveries
                 SET status = 'queued', claimed_at = NULL
                 WHERE status = 'claimed' AND attempt_count < " . self::MAX_ATTEMPTS . "
                   AND expires_at > NOW()
                   AND claimed_at < DATE_SUB(NOW(), INTERVAL " . self::CLAIM_LEASE_SECONDS . " SECOND)"
            );
            $rows = $pdo->query(
                "SELECT d.*, e.endpoint_kind, e.delivery_mode, e.provider, e.environment,
                        e.topic, e.endpoint_ciphertext, e.broker_handle, e.invalidated_at
                 FROM aokie_companion_push_deliveries d
                 JOIN aokie_companion_push_endpoints e ON e.id = d.push_endpoint_id
                 WHERE d.status = 'queued' AND d.expires_at > NOW() AND e.invalidated_at IS NULL
                 ORDER BY d.created_at ASC, d.id ASC LIMIT {$limit} FOR UPDATE"
            )->fetchAll(PDO::FETCH_ASSOC);
            $claim = $pdo->prepare(
                "UPDATE aokie_companion_push_deliveries
                 SET status = 'claimed', claimed_at = NOW(), attempt_count = attempt_count + 1
                 WHERE id = :id AND status = 'queued'"
            );
            $out = [];
            foreach ($rows as $row) {
                $claim->execute(['id' => $row['id']]);
                if ($claim->rowCount() !== 1) {
                    continue;
                }
                $secret = $row['delivery_mode'] === 'managed'
                    ? $this->decrypt((string) $row['endpoint_ciphertext'])
                    : (string) $row['broker_handle'];
                $out[] = [
                    'deliveryId' => (string) $row['id'],
                    'appId' => (string) $row['app_id'],
                    'deviceId' => (string) $row['device_id'],
                    'endpointKind' => (string) $row['endpoint_kind'],
                    'mode' => (string) $row['delivery_mode'],
                    'provider' => (string) $row['provider'],
                    'environment' => (string) $row['environment'],
                    'topic' => $row['topic'] !== null ? (string) $row['topic'] : null,
                    'credential' => $secret,
                    'payload' => json_decode((string) $row['payload_json'], true, 16, JSON_THROW_ON_ERROR),
                    'expiresAt' => (string) $row['expires_at'],
                ];
            }
            $pdo->commit();
            return $out;
        } catch (\Throwable $error) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $error;
        }
    }

    public function completeDelivery(
        string $deliveryId,
        bool $delivered,
        ?string $providerMessageId = null,
        bool $endpointInvalid = false,
    ): bool {
        $pdo = $this->db();
        $pdo->beginTransaction();
        try {
            $find = $pdo->prepare(
                'SELECT push_endpoint_id, attempt_count, expires_at
                 FROM aokie_companion_push_deliveries
                 WHERE id = :id AND status = \'claimed\' FOR UPDATE'
            );
            $find->execute(['id' => $deliveryId]);
            $delivery = $find->fetch(PDO::FETCH_ASSOC);
            if (!$delivery) {
                $pdo->rollBack();
                return false;
            }
            $endpointId = $delivery['push_endpoint_id'];
            $retry = !$delivered
                && !$endpointInvalid
                && (int) $delivery['attempt_count'] < self::MAX_ATTEMPTS
                && strtotime((string) $delivery['expires_at']) > time();
            $status = $delivered
                ? 'delivered'
                : ($endpointInvalid ? 'invalidated' : ($retry ? 'queued' : 'failed'));
            $pdo->prepare(
                'UPDATE aokie_companion_push_deliveries
                 SET status = :status,
                     claimed_at = CASE WHEN :retry = 1 THEN NULL ELSE claimed_at END,
                     completed_at = CASE WHEN :retry2 = 1 THEN NULL ELSE NOW() END,
                     provider_message_hash = :message
                 WHERE id = :id'
            )->execute([
                'status' => $status,
                'retry' => $retry ? 1 : 0,
                'retry2' => $retry ? 1 : 0,
                'message' => $delivered && is_string($providerMessageId) && $providerMessageId !== ''
                    ? hash('sha256', $providerMessageId) : null,
                'id' => $deliveryId,
            ]);
            if ($endpointInvalid && is_string($endpointId)) {
                $pdo->prepare(
                    'UPDATE aokie_companion_push_endpoints SET invalidated_at = NOW() WHERE id = :id'
                )->execute(['id' => $endpointId]);
                $pdo->prepare(
                    "UPDATE aokie_companion_push_deliveries
                     SET status = 'invalidated', completed_at = NOW()
                     WHERE push_endpoint_id = :id AND status = 'queued'"
                )->execute(['id' => $endpointId]);
            }
            $pdo->commit();
            return true;
        } catch (\Throwable $error) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $error;
        }
    }

    /** @return array<string,mixed>|null */
    private function preferredEndpoint(PDO $pdo, string $appId, string $deviceId, string $offerKind): ?array
    {
        $stmt = $pdo->prepare(
            'SELECT * FROM aokie_companion_push_endpoints
             WHERE app_id = :app AND device_id = :device AND invalidated_at IS NULL'
        );
        $stmt->execute(['app' => $appId, 'device' => $deviceId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $order = $offerKind === 'takeover_offer'
            ? ['apns_voip', 'fcm', 'apns']
            : ['fcm', 'apns', 'apns_voip'];
        foreach ($order as $kind) {
            foreach ($rows as $row) {
                if ($row['endpoint_kind'] === $kind) {
                    return $row;
                }
            }
        }
        return null;
    }

    /** @return array{0:array<string,string>,1:string,2:string} */
    private function offerIdentity(
        string $appId,
        string $routingGroupId,
        string $kind,
        string $invitationId,
        string $collapseId,
        int $expiresAt,
    ): array {
        if (!in_array($kind, self::OFFER_KINDS, true)) {
            throw new \InvalidArgumentException('Offer kind is not supported');
        }
        $this->requiredSafeId($appId, 'appId');
        $this->requiredSafeId($routingGroupId, 'routingGroupId');
        $this->requiredSafeId($invitationId, 'invitationId');
        $this->requiredSafeId($collapseId, 'collapseId');
        if ($expiresAt < time() + 5 || $expiresAt > time() + 300) {
            throw new \InvalidArgumentException('expiresAt must be 5 to 300 seconds in the future');
        }
        $payload = [
            'kind' => $kind,
            'invitationId' => $invitationId,
            'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $expiresAt),
            'collapseId' => $collapseId,
        ];
        $invitationHash = hash('sha256', $invitationId);
        $requestHash = hash('sha256', json_encode([
            'appId' => $appId,
            'routingGroupId' => $routingGroupId,
            'kind' => $kind,
            'invitationHash' => $invitationHash,
            'collapseHash' => hash('sha256', $collapseId),
            'expiresAt' => $expiresAt,
        ], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
        return [$payload, $invitationHash, $requestHash];
    }

    /** @return array<string,mixed> */
    private function offerResult(string $appId, string $offerId, array $payload, bool $replay): array
    {
        $stmt = $this->db()->prepare(
            'SELECT d.id, d.device_id, d.status, e.endpoint_kind, e.delivery_mode,
                    dev.subject_id
             FROM aokie_companion_push_deliveries d
             JOIN aokie_companion_devices dev ON dev.id = d.device_id AND dev.app_id = d.app_id
             LEFT JOIN aokie_companion_push_endpoints e ON e.id = d.push_endpoint_id
             WHERE d.app_id = :app AND d.offer_id = :offer ORDER BY d.device_id ASC'
        );
        $stmt->execute(['app' => $appId, 'offer' => $offerId]);
        return [
            'offerId' => $offerId,
            'idempotentReplay' => $replay,
            'payload' => $payload,
            'targets' => array_map(static fn (array $row): array => [
                'deviceId' => (string) $row['device_id'],
                'subjectId' => (string) $row['subject_id'],
                'deliveryId' => (string) $row['id'],
                'deliveryStatus' => (string) $row['status'],
                'endpointKind' => $row['endpoint_kind'] !== null ? (string) $row['endpoint_kind'] : null,
                'deliveryMode' => $row['delivery_mode'] !== null ? (string) $row['delivery_mode'] : null,
            ], $stmt->fetchAll(PDO::FETCH_ASSOC)),
        ];
    }

    /** @return array<string,mixed>|null */
    private function endpointById(string $id): ?array
    {
        $stmt = $this->db()->prepare('SELECT * FROM aokie_companion_push_endpoints WHERE id = :id');
        $stmt->execute(['id' => $id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ? $this->formatEndpoint($row) : null;
    }

    /** @param array<string,mixed> $row @return array<string,mixed> */
    private function formatEndpoint(array $row): array
    {
        return [
            'id' => (string) $row['id'],
            'appId' => (string) $row['app_id'],
            'deviceId' => (string) $row['device_id'],
            'kind' => (string) $row['endpoint_kind'],
            'mode' => (string) $row['delivery_mode'],
            'provider' => (string) $row['provider'],
            'environment' => (string) $row['environment'],
            'topic' => $row['topic'] !== null ? (string) $row['topic'] : null,
            'fingerprint' => (string) $row['endpoint_fingerprint'],
            'invalidatedAt' => self::utcTimestamp($row['invalidated_at']),
            'rotatedAt' => self::utcTimestamp($row['rotated_at']),
        ];
    }

    private static function utcTimestamp(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }
        if (!is_string($value)
            || preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/D', $value) !== 1) {
            throw new \UnexpectedValueException('Companion push timestamp is not canonical UTC');
        }
        $timestamp = \DateTimeImmutable::createFromFormat(
            '!Y-m-d H:i:s',
            $value,
            new \DateTimeZone('UTC'),
        );
        $errors = \DateTimeImmutable::getLastErrors();
        if ($timestamp === false || (is_array($errors)
            && (($errors['warning_count'] ?? 0) !== 0 || ($errors['error_count'] ?? 0) !== 0))) {
            throw new \UnexpectedValueException('Companion push timestamp is invalid');
        }
        return $timestamp->format('Y-m-d\\TH:i:s\\Z');
    }

    private function encrypt(string $plaintext): string
    {
        $key = $this->encryptionKey();
        if (function_exists('sodium_crypto_secretbox')) {
            $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
            return 's1.' . base64_encode($nonce . sodium_crypto_secretbox($plaintext, $nonce, $key));
        }
        if (!function_exists('openssl_encrypt')) {
            throw new \RuntimeException('Managed push requires libsodium or OpenSSL');
        }
        $iv = random_bytes(12);
        $tag = '';
        $cipher = openssl_encrypt($plaintext, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
        if (!is_string($cipher)) {
            throw new \RuntimeException('Could not encrypt managed push token');
        }
        return 'g1.' . base64_encode($iv . $tag . $cipher);
    }

    private function decrypt(string $ciphertext): string
    {
        $key = $this->encryptionKey();
        [$version, $encoded] = array_pad(explode('.', $ciphertext, 2), 2, '');
        $bytes = base64_decode($encoded, true);
        if (!is_string($bytes)) {
            throw new \RuntimeException('Stored push credential is corrupt');
        }
        if ($version === 's1' && function_exists('sodium_crypto_secretbox_open')) {
            $nonceBytes = SODIUM_CRYPTO_SECRETBOX_NONCEBYTES;
            $plain = sodium_crypto_secretbox_open(substr($bytes, $nonceBytes), substr($bytes, 0, $nonceBytes), $key);
            if (is_string($plain)) {
                return $plain;
            }
        }
        if ($version === 'g1' && function_exists('openssl_decrypt') && strlen($bytes) >= 28) {
            $plain = openssl_decrypt(
                substr($bytes, 28),
                'aes-256-gcm',
                $key,
                OPENSSL_RAW_DATA,
                substr($bytes, 0, 12),
                substr($bytes, 12, 16),
            );
            if (is_string($plain)) {
                return $plain;
            }
        }
        throw new \RuntimeException('Stored push credential cannot be decrypted');
    }

    private function encryptionKey(): string
    {
        $raw = trim((string) ($_ENV['AOKIE_COMPANION_PUSH_ENCRYPTION_KEY']
            ?? getenv('AOKIE_COMPANION_PUSH_ENCRYPTION_KEY') ?: ''));
        $key = strlen($raw) === 64 && ctype_xdigit($raw)
            ? hex2bin($raw)
            : base64_decode(str_starts_with($raw, 'base64:') ? substr($raw, 7) : $raw, true);
        if (!is_string($key) || strlen($key) !== 32) {
            throw new \RuntimeException('AOKIE_COMPANION_PUSH_ENCRYPTION_KEY must be a 32-byte base64 value or 64 hex characters');
        }
        return $key;
    }

    private function requiredSafeId(mixed $value, string $name): string
    {
        if (!is_string($value) || $value === '' || strlen($value) > 200
            || preg_match('/^[A-Za-z0-9_.:-]+$/D', $value) !== 1) {
            throw new \InvalidArgumentException("{$name} must be a safe identifier");
        }
        return $value;
    }

    private function cleanText(string $value, int $max): string
    {
        $value = trim(preg_replace('/[\x00-\x1F\x7F]/', '', $value) ?? '');
        return mb_substr($value, 0, $max);
    }

    private function db(): PDO
    {
        return $this->mysql->getConnection();
    }

    private static function uuid(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }
}
