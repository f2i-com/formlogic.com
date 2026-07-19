<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Constants\AppPermissions;
use FormLogic\Database\MySQLConnection;
use PDO;

/** Durable endpoint, activity/session and deterministic routing source of truth. */
final class AokieCompanionDeviceService
{
    public const AVAILABILITY = ['available', 'busy', 'offline', 'do_not_disturb'];
    public const ROUTING_POLICIES = ['all', 'priority', 'round_robin'];

    /** @var array<string,array{mode:?string,state:?string}> */
    private const ACTIVITY_EVENTS = [
        'admission_issued' => ['mode' => null, 'state' => null],
        'monitor_joined' => ['mode' => 'monitor', 'state' => 'joined'],
        'monitor_left' => ['mode' => 'monitor', 'state' => 'left'],
        'consult_joined' => ['mode' => 'consult', 'state' => 'joined'],
        'consult_left' => ['mode' => 'consult', 'state' => 'left'],
        'takeover_prepared' => ['mode' => 'takeover', 'state' => 'prepared'],
        'takeover_joined' => ['mode' => 'takeover', 'state' => 'joined'],
        'takeover_left' => ['mode' => 'takeover', 'state' => 'left'],
        'returned_to_aokie' => ['mode' => 'takeover', 'state' => 'left'],
        'session_recovered' => ['mode' => null, 'state' => 'joined'],
        'session_revoked' => ['mode' => null, 'state' => 'revoked'],
        'endpoint_revoked' => ['mode' => null, 'state' => null],
        'call_alert_targeted' => ['mode' => null, 'state' => null],
        'assistance_targeted' => ['mode' => null, 'state' => null],
        'takeover_targeted' => ['mode' => null, 'state' => null],
    ];

    /** @var array<string,string> */
    private const GATEWAY_TO_PERMISSION = [
        'state_read' => AppPermissions::AOKIE_COMPANION_STATE,
        'participants_read' => AppPermissions::AOKIE_COMPANION_STATE,
        'participant_identity_read' => AppPermissions::AOKIE_COMPANION_STATE,
        'audio_levels_read' => AppPermissions::AOKIE_COMPANION_STATE,
        'monitor' => AppPermissions::AOKIE_COMPANION_MONITOR,
        'consult' => AppPermissions::AOKIE_COMPANION_CONSULT,
        'takeover' => AppPermissions::AOKIE_COMPANION_TAKEOVER,
        'resume_aokie' => AppPermissions::AOKIE_COMPANION_RESUME,
        'end_caller' => AppPermissions::AOKIE_COMPANION_END,
        'assistance_read' => AppPermissions::AOKIE_COMPANION_ASSISTANCE,
        'assistance_respond' => AppPermissions::AOKIE_COMPANION_ASSISTANCE,
    ];

    /** @var list<string> Exact grants that may be persisted on an endpoint. */
    private const DEVICE_GRANTS = [
        'state_read', 'caller_read', 'captions_read', 'participants_read',
        'participant_identity_read', 'audio_levels_read', 'monitor', 'consult',
        'takeover', 'resume_aokie', 'rtc_signal', 'assistance_read',
        'assistance_respond', 'end_caller',
    ];

    public function __construct(private readonly MySQLConnection $mysql) {}

    /**
     * OAuth consent or the linked Desktop key is the approval ceremony. A revoked
     * endpoint cannot silently re-enrol with an old refresh/API token.
     * @param list<string> $grants
     * @param array<string,mixed> $endpointIdentity
     * @return array<string,mixed>
     */
    public function enrollOrTouch(
        string $userId,
        string $appId,
        string $subjectId,
        string $role,
        string $displayName,
        array $grants,
        array $endpointIdentity,
    ): array {
        $this->requiredSafeId($appId, 'appId');
        $this->requiredSafeId($subjectId, 'subjectId');
        if (!in_array($role, ['mobile', 'plugin'], true)) {
            throw new \InvalidArgumentException('role must be mobile or plugin');
        }
        $displayName = $this->cleanText($displayName, 120);
        if ($displayName === '') {
            $displayName = $role === 'plugin' ? 'Aokie Desktop' : 'Aokie Companion';
        }
        if (!array_is_list($grants) || count($grants) > 16) {
            throw new \InvalidArgumentException('grants must be a list of at most 16 exact capabilities');
        }
        foreach ($grants as $grant) {
            if (!is_string($grant) || !in_array($grant, self::DEVICE_GRANTS, true)) {
                throw new \InvalidArgumentException('grants contains an unsupported capability');
            }
        }
        $grants = array_values(array_unique($grants));
        $endpointIdentity = $this->validateEndpointIdentity($role, $endpointIdentity);
        $holderKeyThumbprint = $endpointIdentity['holderKeyThumbprint'];
        $pdo = $this->db();
        $installationLock = null;
        if ($role === 'mobile') {
            // Row locks cannot protect the "no row exists yet" case across two
            // different apps because the installation identity is intentionally
            // user-global. A bounded advisory lock serializes that first bind.
            $installationLock = 'aokie_install_' . substr(hash('sha256', $subjectId), 0, 48);
            $lock = $pdo->prepare('SELECT GET_LOCK(:name, 5)');
            $lock->execute(['name' => $installationLock]);
            if ((int) $lock->fetchColumn() !== 1) {
                throw new \RuntimeException('Could not lock Companion installation identity');
            }
        }
        try {
            $pdo->beginTransaction();
            if ($role === 'mobile') {
                // Installation identity is user-scoped, not app-scoped. The
                // same installation may join several apps owned by its user,
                // but another account can never silently take it over merely
                // by reusing the public device identifier.
                $installation = $pdo->prepare(
                    "SELECT user_id, holder_key_thumbprint FROM aokie_companion_devices
                     WHERE subject_id = :subject AND role = 'mobile'
                     FOR UPDATE"
                );
                $installation->execute(['subject' => $subjectId]);
                foreach ($installation->fetchAll(PDO::FETCH_ASSOC) as $installed) {
                    if (!hash_equals((string) $installed['user_id'], $userId)) {
                        throw new \DomainException('This Companion installation is already bound to another account');
                    }
                    if (is_string($installed['holder_key_thumbprint'] ?? null)
                        && !hash_equals($installed['holder_key_thumbprint'], $holderKeyThumbprint)) {
                        throw new \DomainException('This Companion installation is pinned to another endpoint key; revoke and re-authorize it before key rotation');
                    }
                }
            }
            $existing = $pdo->prepare(
                'SELECT id, user_id, approved_at, revoked_at, holder_key_thumbprint,
                        endpoint_public_key, approved_peer_key_thumbprints,
                        peer_roster_revision, peer_roster_hash, desktop_connection_id
                 FROM aokie_companion_devices
                 WHERE app_id = :app AND subject_id = :subject AND role = :role FOR UPDATE'
            );
            $existing->execute(['app' => $appId, 'subject' => $subjectId, 'role' => $role]);
            $row = $existing->fetch(PDO::FETCH_ASSOC);
            if ($row && $row['revoked_at'] !== null) {
                throw new \DomainException('This Aokie Companion endpoint was revoked and must be approved again by an app administrator');
            }
            if ($row && !hash_equals((string) $row['user_id'], $userId)) {
                throw new \DomainException('This Companion endpoint belongs to another account');
            }
            if ($row && is_string($row['holder_key_thumbprint'] ?? null)
                && !hash_equals($row['holder_key_thumbprint'], $holderKeyThumbprint)) {
                throw new \DomainException('This endpoint key cannot be substituted silently; revoke and explicitly re-authorize the endpoint first');
            }
            if ($row && $role === 'plugin' && is_string($row['holder_key_thumbprint'] ?? null)) {
                $this->validatePluginRosterTransition($row, $endpointIdentity);
            }
            $now = gmdate('Y-m-d H:i:s');
            if ($row) {
                $id = (string) $row['id'];
                $approvedAt = (string) $row['approved_at'];
                $pdo->prepare(
                    'UPDATE aokie_companion_devices
                     SET user_id = :user, display_name = :name, grants = :grants,
                         holder_key_thumbprint = :holder,
                         endpoint_public_key = :endpoint_key,
                         approved_peer_key_thumbprints = :approved_peers,
                         peer_roster_revision = :roster_revision,
                         peer_roster_hash = :roster_hash,
                         desktop_connection_id = :desktop_connection,
                         last_seen_at = :seen
                     WHERE id = :id'
                )->execute([
                    'user' => $userId,
                    'name' => $displayName,
                    'grants' => json_encode($grants, JSON_THROW_ON_ERROR),
                    'holder' => $holderKeyThumbprint,
                    'endpoint_key' => $endpointIdentity['endpointPublicKeyJson'],
                    'approved_peers' => $endpointIdentity['approvedPeerKeyThumbprintsJson'],
                    'roster_revision' => $endpointIdentity['peerRosterRevision'],
                    'roster_hash' => $endpointIdentity['peerRosterHash'],
                    'desktop_connection' => $endpointIdentity['desktopConnectionId'],
                    'seen' => $now,
                    'id' => $id,
                ]);
            } else {
                $id = self::uuid();
                $approvedAt = $now;
                $pdo->prepare(
                    'INSERT INTO aokie_companion_devices
                        (id, user_id, app_id, subject_id, role, display_name, grants,
                         holder_key_thumbprint, endpoint_public_key,
                         approved_peer_key_thumbprints, peer_roster_revision,
                         peer_roster_hash, desktop_connection_id, approved_at, last_seen_at)
                     VALUES (:id, :user, :app, :subject, :role, :name, :grants,
                             :holder, :endpoint_key, :approved_peers, :roster_revision,
                             :roster_hash, :desktop_connection, :approved, :seen)'
                )->execute([
                    'id' => $id,
                    'user' => $userId,
                    'app' => $appId,
                    'subject' => $subjectId,
                    'role' => $role,
                    'name' => $displayName,
                    'grants' => json_encode($grants, JSON_THROW_ON_ERROR),
                    'holder' => $holderKeyThumbprint,
                    'endpoint_key' => $endpointIdentity['endpointPublicKeyJson'],
                    'approved_peers' => $endpointIdentity['approvedPeerKeyThumbprintsJson'],
                    'roster_revision' => $endpointIdentity['peerRosterRevision'],
                    'roster_hash' => $endpointIdentity['peerRosterHash'],
                    'desktop_connection' => $endpointIdentity['desktopConnectionId'],
                    'approved' => $now,
                    'seen' => $now,
                ]);
            }
            $pdo->commit();
        } catch (\Throwable $error) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $error;
        } finally {
            if ($installationLock !== null) {
                try {
                    $release = $pdo->prepare('SELECT RELEASE_LOCK(:name)');
                    $release->execute(['name' => $installationLock]);
                } catch (\Throwable) {
                    // Connection-scoped locks release automatically on disconnect.
                }
            }
        }
        $device = [
            'id' => $id,
            'appId' => $appId,
            'subjectId' => $subjectId,
            'role' => $role,
            'displayName' => $displayName,
            'grants' => $grants,
            'approvedAt' => self::utcTimestamp($approvedAt),
            'lastSeenAt' => self::utcTimestamp($now),
        ];
        if ($role === 'plugin') {
            $device['holderKeyThumbprint'] = $holderKeyThumbprint;
            $device['endpointPublicKey'] = $endpointIdentity['endpointPublicKey'];
            $device['approvedPeerKeyThumbprints'] = $endpointIdentity['approvedPeerKeyThumbprints'];
            $device['peerRosterRevision'] = $endpointIdentity['peerRosterRevision'];
            $device['peerRosterHash'] = $endpointIdentity['peerRosterHash'];
        }
        return $device;
    }

    /** @return list<array<string,mixed>> */
    public function listForApp(string $appId): array
    {
        $stmt = $this->db()->prepare(
            'SELECT id, user_id, app_id, subject_id, role, display_name, grants,
                    holder_key_thumbprint, endpoint_public_key,
                    approved_peer_key_thumbprints, peer_roster_revision,
                    peer_roster_hash, desktop_connection_id,
                    approved_at, last_seen_at, revoked_at
             FROM aokie_companion_devices WHERE app_id = :app ORDER BY last_seen_at DESC, id ASC'
        );
        $stmt->execute(['app' => $appId]);
        return array_map([$this, 'formatDevice'], $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    /** @return list<array<string,mixed>> */
    public function listForOwner(string $userId, ?string $appId = null): array
    {
        $sql = 'SELECT id, user_id, app_id, subject_id, role, display_name, grants,
                       holder_key_thumbprint, endpoint_public_key,
                       approved_peer_key_thumbprints, peer_roster_revision,
                       peer_roster_hash, desktop_connection_id,
                       approved_at, last_seen_at, revoked_at
                FROM aokie_companion_devices WHERE user_id = :user';
        $params = ['user' => $userId];
        if ($appId !== null) {
            $sql .= ' AND app_id = :app';
            $params['app'] = $appId;
        }
        $sql .= ' ORDER BY last_seen_at DESC, id ASC';
        $stmt = $this->db()->prepare($sql);
        $stmt->execute($params);
        return array_map([$this, 'formatDevice'], $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    /** @return array<string,mixed>|null */
    public function getDevice(string $id): ?array
    {
        $stmt = $this->db()->prepare(
            'SELECT id, user_id, app_id, subject_id, role, display_name, grants,
                    holder_key_thumbprint, endpoint_public_key,
                    approved_peer_key_thumbprints, peer_roster_revision,
                    peer_roster_hash, desktop_connection_id,
                    approved_at, last_seen_at, revoked_at
             FROM aokie_companion_devices WHERE id = :id'
        );
        $stmt->execute(['id' => $id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ? $this->formatDevice($row) : null;
    }

    /** @return array<string,mixed>|null */
    public function activeBySubject(string $appId, string $subjectId, string $role): ?array
    {
        $stmt = $this->db()->prepare(
            'SELECT id, user_id, app_id, subject_id, role, display_name, grants,
                    holder_key_thumbprint, endpoint_public_key,
                    approved_peer_key_thumbprints, peer_roster_revision,
                    peer_roster_hash, desktop_connection_id,
                    approved_at, last_seen_at, revoked_at
             FROM aokie_companion_devices
             WHERE app_id = :app AND subject_id = :subject AND role = :role AND revoked_at IS NULL'
        );
        $stmt->execute(['app' => $appId, 'subject' => $subjectId, 'role' => $role]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ? $this->formatDevice($row) : null;
    }

    /**
     * Resolve the package-gated plugin identity currently pinned to the
     * app's assigned, live Desktop. The package verification itself happens
     * inside Desktop before it may call the broker; this join makes that
     * brokered key useless after assignment changes or the Desktop goes stale.
     * @return array<string,mixed>|null
     */
    public function activeAssignedPluginIdentity(string $appId): ?array
    {
        $stmt = $this->db()->prepare(
            "SELECT d.id, d.user_id, d.app_id, d.subject_id, d.role,
                    d.display_name, d.grants, d.holder_key_thumbprint,
                    d.endpoint_public_key, d.approved_peer_key_thumbprints,
                    d.peer_roster_revision, d.peer_roster_hash,
                    d.desktop_connection_id, d.approved_at, d.last_seen_at,
                    d.revoked_at, dc.last_seen_at AS desktop_last_seen_at,
                    dc.capabilities_json AS desktop_capabilities
             FROM aokie_companion_devices d
             JOIN connector_assignments ca
               ON ca.app_id = d.app_id
              AND ca.owner_user_id = d.user_id
              AND ca.connector_id = 'aokie'
              AND ca.desktop_connection_id = d.desktop_connection_id
             JOIN desktop_connections dc
               ON dc.id = ca.desktop_connection_id
              AND dc.owner_user_id = ca.owner_user_id
             WHERE d.app_id = :app AND d.subject_id = 'aokie'
               AND d.role = 'plugin' AND d.revoked_at IS NULL
               AND d.holder_key_thumbprint IS NOT NULL
             LIMIT 1"
        );
        $stmt->execute(['app' => $appId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return null;
        }
        $lastSeen = strtotime((string) ($row['desktop_last_seen_at'] ?? ''));
        $pluginLastSeen = strtotime((string) ($row['last_seen_at'] ?? ''));
        $capabilities = is_string($row['desktop_capabilities'] ?? null)
            ? json_decode($row['desktop_capabilities'], true)
            : null;
        if ($lastSeen === false || $lastSeen < time() - 90
            || $pluginLastSeen === false || $pluginLastSeen < time() - 330
            || !is_array($capabilities)
            || (!in_array('aokie', $capabilities, true)
                && !in_array('companion.admission', $capabilities, true))) {
            return null;
        }
        return $this->formatDevice($row);
    }

    /** Revoke one endpoint and every OAuth descendant/live Companion session. */
    public function revokeById(string $actorUserId, string $id): ?array
    {
        $pdo = $this->db();
        $pdo->beginTransaction();
        try {
            $find = $pdo->prepare(
                'SELECT * FROM aokie_companion_devices WHERE id = :id AND revoked_at IS NULL FOR UPDATE'
            );
            $find->execute(['id' => $id]);
            $row = $find->fetch(PDO::FETCH_ASSOC);
            if (!$row) {
                $pdo->rollBack();
                return null;
            }
            $now = gmdate('Y-m-d H:i:s');
            $eventId = 'revoke:' . $id . ':' . bin2hex(random_bytes(8));
            $pdo->prepare('UPDATE aokie_companion_devices SET revoked_at = :now WHERE id = :id')
                ->execute(['now' => $now, 'id' => $id]);
            $pdo->prepare(
                'UPDATE mcp_sessions SET revoked_at = :now
                 WHERE user_id = :user AND oauth_client_id = :client AND device_id = :subject
                    AND app_id = :app AND revoked_at IS NULL'
            )->execute([
                'now' => $now,
                'user' => $row['user_id'],
                'client' => McpOAuthService::AOKIE_COMPANION_CLIENT_ID,
                'subject' => $row['subject_id'],
                'app' => $row['app_id'],
            ]);
            $pdo->prepare(
                'UPDATE mcp_oauth_refresh_tokens SET revoked_at = :now
                 WHERE user_id = :user AND client_id = :client AND device_id = :subject
                    AND app_id = :app AND revoked_at IS NULL'
            )->execute([
                'now' => $now,
                'user' => $row['user_id'],
                'client' => McpOAuthService::AOKIE_COMPANION_CLIENT_ID,
                'subject' => $row['subject_id'],
                'app' => $row['app_id'],
            ]);
            $pdo->prepare(
                'UPDATE aokie_companion_push_endpoints
                 SET invalidated_at = COALESCE(invalidated_at, :now)
                 WHERE device_id = :device'
            )->execute(['now' => $now, 'device' => $id]);
            $pdo->prepare(
                "UPDATE aokie_companion_push_deliveries
                 SET status = 'invalidated', completed_at = COALESCE(completed_at, :now)
                 WHERE device_id = :device AND status IN ('queued','claimed')"
            )->execute(['now' => $now, 'device' => $id]);
            $pdo->prepare(
                "UPDATE aokie_companion_routing_members
                 SET availability = 'offline', availability_updated_at = :now,
                     availability_expires_at = NULL
                 WHERE device_id = :device"
            )->execute(['now' => $now, 'device' => $id]);
            $pdo->prepare(
                "UPDATE aokie_companion_sessions
                 SET state = 'revoked', ended_at = COALESCE(ended_at, :now),
                     end_reason = 'endpoint_revoked', last_event_id = :event, last_event_at = :now2
                 WHERE device_id = :device AND state IN ('prepared','joined')"
            )->execute([
                'now' => $now,
                'event' => $eventId,
                'now2' => $now,
                'device' => $id,
            ]);
            $requestHash = hash('sha256', json_encode([
                'actorUserId' => $actorUserId,
                'appId' => (string) $row['app_id'],
                'subjectId' => (string) $row['subject_id'],
                'deviceId' => $id,
                'eventType' => 'endpoint_revoked',
                'occurredAt' => strtotime($now),
                'reason' => 'endpoint_revoked',
            ], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
            $pdo->prepare(
                'INSERT INTO aokie_companion_activity
                    (id, app_id, idempotency_key, request_hash, device_id, actor_user_id,
                     subject_id, event_type, reason, occurred_at)
                 VALUES (:id, :app, :event, :request_hash, :device, :actor,
                         :subject, \'endpoint_revoked\', \'endpoint_revoked\', :occurred)'
            )->execute([
                'id' => self::uuid(),
                'app' => $row['app_id'],
                'event' => $eventId,
                'request_hash' => $requestHash,
                'device' => $id,
                'actor' => $actorUserId,
                'subject' => $row['subject_id'],
                'occurred' => $now,
            ]);
            $pdo->commit();
            $row['revoked_at'] = $now;
            return $this->formatDevice($row);
        } catch (\Throwable $error) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $error;
        }
    }

    public function approveAgainById(string $id): bool
    {
        $stmt = $this->db()->prepare(
            'UPDATE aokie_companion_devices
             SET revoked_at = NULL, approved_at = NOW(),
                 holder_key_thumbprint = NULL, endpoint_public_key = NULL,
                 approved_peer_key_thumbprints = NULL, peer_roster_revision = NULL,
                 peer_roster_hash = NULL, desktop_connection_id = NULL
             WHERE id = :id AND revoked_at IS NOT NULL'
        );
        $stmt->execute(['id' => $id]);
        return $stmt->rowCount() === 1;
    }

    /** Backward-compatible owner-only wrappers used by older internal callers. */
    public function revoke(string $userId, string $id): bool
    {
        $device = $this->getDevice($id);
        return $device !== null && $device['userId'] === $userId && $this->revokeById($userId, $id) !== null;
    }

    public function approveAgain(string $userId, string $id): bool
    {
        $device = $this->getDevice($id);
        return $device !== null && $device['userId'] === $userId && $this->approveAgainById($id);
    }

    /**
     * Verify exact aokie assignment -> pinned, fresh Desktop -> calling API key.
     * @return array{ok:bool,code:?string,message:?string,connection:?array}
     */
    public function verifyPluginBinding(string $ownerUserId, string $appId, string $apiKeyId): array
    {
        $stmt = $this->db()->prepare(
            "SELECT ca.desktop_connection_id, dc.desktop_instance_id, dc.device_name,
                    dc.api_key_id, dc.last_seen_at, dc.capabilities_json
             FROM connector_assignments ca
             LEFT JOIN desktop_connections dc ON dc.id = ca.desktop_connection_id
             WHERE ca.owner_user_id = :owner AND ca.connector_id = 'aokie' AND ca.app_id = :app
             LIMIT 1"
        );
        $stmt->execute(['owner' => $ownerUserId, 'app' => $appId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return $this->bindingError('aokie_assignment_required', 'Assign the Aokie connector to this exact app and Desktop before requesting admission');
        }
        if (!is_string($row['desktop_connection_id'] ?? null) || $row['desktop_connection_id'] === '') {
            return $this->bindingError('desktop_pin_required', 'The Aokie connector assignment must pin one linked Desktop connection');
        }
        if (!is_string($row['api_key_id'] ?? null) || !hash_equals($row['api_key_id'], $apiKeyId)) {
            return $this->bindingError('desktop_binding_mismatch', 'This key does not belong to the Desktop pinned to the Aokie assignment');
        }
        $lastSeen = strtotime((string) ($row['last_seen_at'] ?? ''));
        if ($lastSeen === false || $lastSeen < time() - 90) {
            return $this->bindingError('desktop_offline', 'The assigned Desktop has not sent a fresh linked heartbeat');
        }
        $caps = is_string($row['capabilities_json'] ?? null)
            ? json_decode($row['capabilities_json'], true)
            : null;
        if (!is_array($caps) || (!in_array('aokie', $caps, true) && !in_array('companion.admission', $caps, true))) {
            return $this->bindingError('desktop_capability_missing', 'The assigned Desktop heartbeat does not advertise Aokie Companion capability');
        }
        return [
            'ok' => true,
            'code' => null,
            'message' => null,
            'connection' => [
                'id' => (string) $row['desktop_connection_id'],
                'desktopInstanceId' => (string) $row['desktop_instance_id'],
                'deviceName' => (string) $row['device_name'],
                'lastSeenAt' => self::utcTimestamp($row['last_seen_at']),
            ],
        ];
    }

    /** @param array<string,mixed> $event @return array<string,mixed> */
    public function recordActivity(
        string $actorUserId,
        string $appId,
        string $subjectId,
        ?string $deviceId,
        array $event,
    ): array {
        $allowedKeys = [
            'appId', 'deviceId', 'pluginId', 'eventId', 'eventType',
            'sessionId', 'callId', 'ownerEpoch', 'occurredAt', 'reason',
        ];
        if (array_diff(array_keys($event), $allowedKeys) !== []) {
            throw new \InvalidArgumentException('Activity contains unsupported or sensitive fields');
        }
        $eventId = $this->requiredSafeId($event['eventId'] ?? null, 'eventId');
        $eventType = is_string($event['eventType'] ?? null) ? $event['eventType'] : '';
        if (!isset(self::ACTIVITY_EVENTS[$eventType])) {
            throw new \InvalidArgumentException('eventType is not a supported Companion activity');
        }
        $definition = self::ACTIVITY_EVENTS[$eventType];
        $sessionId = $event['sessionId'] ?? null;
        $callId = $event['callId'] ?? null;
        if ($definition['state'] !== null) {
            $sessionId = $this->requiredSafeId($sessionId, 'sessionId');
            $callId = $this->requiredSafeId($callId, 'callId');
        } else {
            $sessionId = is_string($sessionId) && $sessionId !== '' ? $this->requiredSafeId($sessionId, 'sessionId') : null;
            $callId = is_string($callId) && $callId !== '' ? $this->requiredSafeId($callId, 'callId') : null;
        }
        $ownerEpoch = $event['ownerEpoch'] ?? null;
        if ($ownerEpoch !== null && (!is_int($ownerEpoch) || $ownerEpoch < 0)) {
            throw new \InvalidArgumentException('ownerEpoch must be a non-negative integer');
        }
        $occurredUnix = $event['occurredAt'] ?? time();
        if (!is_int($occurredUnix) || $occurredUnix < time() - 86400 || $occurredUnix > time() + 300) {
            throw new \InvalidArgumentException('occurredAt must be a Unix timestamp within the accepted activity window');
        }
        $occurredAt = gmdate('Y-m-d H:i:s', $occurredUnix);
        $reason = $this->cleanText(is_string($event['reason'] ?? null) ? $event['reason'] : '', 120);
        $requestHash = hash('sha256', json_encode([
            'actorUserId' => $actorUserId,
            'appId' => $appId,
            'subjectId' => $subjectId,
            'deviceId' => $deviceId,
            'eventType' => $eventType,
            'sessionId' => $sessionId,
            'callId' => $callId,
            'ownerEpoch' => $ownerEpoch,
            'occurredAt' => $occurredUnix,
            'reason' => $reason,
        ], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
        $pdo = $this->db();
        $pdo->beginTransaction();
        try {
            $prior = $pdo->prepare(
                'SELECT * FROM aokie_companion_activity WHERE app_id = :app AND idempotency_key = :event FOR UPDATE'
            );
            $prior->execute(['app' => $appId, 'event' => $eventId]);
            $existing = $prior->fetch(PDO::FETCH_ASSOC);
            if ($existing) {
                if (!is_string($existing['request_hash'] ?? null)
                    || !hash_equals($existing['request_hash'], $requestHash)) {
                    throw new \InvalidArgumentException('eventId was already used for different activity');
                }
                $pdo->commit();
                $formatted = $this->formatActivity($existing);
                $formatted['idempotentReplay'] = true;
                return $formatted;
            }
            $internalSessionId = null;
            if ($definition['state'] !== null && is_string($sessionId) && is_string($callId)) {
                $internalSessionId = $this->applySessionEvent(
                    $pdo,
                    $appId,
                    $sessionId,
                    $callId,
                    $deviceId,
                    $subjectId,
                    $definition['mode'],
                    $definition['state'],
                    $eventId,
                    $occurredAt,
                    $reason,
                );
            }
            $id = self::uuid();
            $pdo->prepare(
                'INSERT INTO aokie_companion_activity
                    (id, app_id, idempotency_key, request_hash, session_id, call_id, device_id,
                     actor_user_id, subject_id, event_type, mode, reason, owner_epoch, occurred_at)
                 VALUES (:id, :app, :event, :request_hash, :session, :call, :device,
                          :actor, :subject, :type, :mode, :reason, :epoch, :occurred)'
            )->execute([
                'id' => $id,
                'app' => $appId,
                'event' => $eventId,
                'request_hash' => $requestHash,
                'session' => $internalSessionId,
                'call' => $callId,
                'device' => $deviceId,
                'actor' => $actorUserId,
                'subject' => $subjectId,
                'type' => $eventType,
                'mode' => $definition['mode'],
                'reason' => $reason !== '' ? $reason : null,
                'epoch' => $ownerEpoch,
                'occurred' => $occurredAt,
            ]);
            $pdo->commit();
            $row = $this->activityById($id);
            return $row ?? throw new \RuntimeException('Companion activity insert failed');
        } catch (\Throwable $error) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $error;
        }
    }

    /** @return array{activity:list<array<string,mixed>>,sessions:list<array<string,mixed>>} */
    public function history(string $appId, int $limit = 100, ?int $before = null): array
    {
        $limit = max(1, min(200, $limit));
        $params = ['app' => $appId];
        $where = '';
        if ($before !== null) {
            $where = ' AND occurred_at < :before';
            $params['before'] = gmdate('Y-m-d H:i:s', $before);
        }
        $stmt = $this->db()->prepare(
            "SELECT * FROM aokie_companion_activity
             WHERE app_id = :app{$where} ORDER BY occurred_at DESC, id DESC LIMIT {$limit}"
        );
        $stmt->execute($params);
        $sessions = $this->db()->prepare(
            'SELECT * FROM aokie_companion_sessions WHERE app_id = :app
             ORDER BY updated_at DESC, id DESC LIMIT 200'
        );
        $sessions->execute(['app' => $appId]);
        return [
            'activity' => array_map([$this, 'formatActivity'], $stmt->fetchAll(PDO::FETCH_ASSOC)),
            'sessions' => array_map([$this, 'formatSession'], $sessions->fetchAll(PDO::FETCH_ASSOC)),
        ];
    }

    /** @return list<array<string,mixed>> */
    public function auditHistory(string $appId, int $limit = 100, ?int $before = null): array
    {
        $limit = max(1, min(200, $limit));
        $params = ['app' => $appId];
        $beforeSql = '';
        if ($before !== null) {
            $beforeSql = ' AND created_at < :before';
            $params['before'] = gmdate('Y-m-d H:i:s', $before);
        }
        $stmt = $this->db()->prepare(
            "SELECT id, user_id, action, details, created_at
             FROM audit_log
             WHERE resource_type = 'app' AND resource_id = :app
               AND action LIKE 'aokie.companion.%'{$beforeSql}
             ORDER BY created_at DESC, sequence_number DESC LIMIT {$limit}"
        );
        $stmt->execute($params);
        return array_map(static function (array $row): array {
            $details = is_string($row['details'] ?? null) ? json_decode($row['details'], true) : null;
            return [
                'id' => (string) $row['id'],
                'actorUserId' => $row['user_id'] !== null ? (string) $row['user_id'] : null,
                'action' => (string) $row['action'],
                'details' => is_array($details) ? $details : [],
                'occurredAt' => self::utcTimestamp($row['created_at']),
            ];
        }, $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    /** @param array<string,mixed> $data @return array<string,mixed> */
    public function saveRoutingGroup(string $actorUserId, string $appId, array $data, ?string $id = null): array
    {
        $name = $this->cleanText(is_string($data['name'] ?? null) ? $data['name'] : '', 120);
        $policy = is_string($data['policy'] ?? null) ? $data['policy'] : '';
        $members = $data['members'] ?? null;
        if ($name === '' || !in_array($policy, self::ROUTING_POLICIES, true)) {
            throw new \InvalidArgumentException('name and a policy of all, priority, or round_robin are required');
        }
        if (!is_array($members) || !array_is_list($members) || count($members) > 200) {
            throw new \InvalidArgumentException('members must be a list of at most 200 endpoints');
        }
        $normalized = [];
        foreach ($members as $member) {
            if (!is_array($member)) {
                throw new \InvalidArgumentException('Each routing member must be an object');
            }
            $device = $this->requiredSafeId($member['deviceId'] ?? null, 'deviceId');
            $priority = $member['priority'] ?? 100;
            if (!is_int($priority) || $priority < 0 || $priority > 10000) {
                throw new \InvalidArgumentException('Routing priority must be an integer from 0 to 10000');
            }
            $normalized[$device] = [
                'priority' => $priority,
                'enabled' => !array_key_exists('enabled', $member) || $member['enabled'] === true,
            ];
        }
        $pdo = $this->db();
        $pdo->beginTransaction();
        try {
            if ($id === null) {
                $id = self::uuid();
                $pdo->prepare(
                    'INSERT INTO aokie_companion_routing_groups
                        (id, app_id, name, policy, enabled, created_by_user_id)
                     VALUES (:id, :app, :name, :policy, :enabled, :actor)'
                )->execute([
                    'id' => $id,
                    'app' => $appId,
                    'name' => $name,
                    'policy' => $policy,
                    'enabled' => ($data['enabled'] ?? true) === true ? 1 : 0,
                    'actor' => $actorUserId,
                ]);
            } else {
                $id = $this->requiredSafeId($id, 'routingGroupId');
                $stmt = $pdo->prepare(
                    'UPDATE aokie_companion_routing_groups
                     SET name = :name, policy = :policy, enabled = :enabled
                     WHERE id = :id AND app_id = :app'
                );
                $stmt->execute([
                    'name' => $name,
                    'policy' => $policy,
                    'enabled' => ($data['enabled'] ?? true) === true ? 1 : 0,
                    'id' => $id,
                    'app' => $appId,
                ]);
                if ($stmt->rowCount() === 0) {
                    $exists = $pdo->prepare('SELECT 1 FROM aokie_companion_routing_groups WHERE id = :id AND app_id = :app');
                    $exists->execute(['id' => $id, 'app' => $appId]);
                    if ($exists->fetchColumn() === false) {
                        throw new \DomainException('Routing group not found');
                    }
                }
            }
            $available = [];
            $old = $pdo->prepare(
                'SELECT device_id, availability FROM aokie_companion_routing_members WHERE group_id = :group'
            );
            $old->execute(['group' => $id]);
            foreach ($old->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $available[(string) $row['device_id']] = (string) $row['availability'];
            }
            $pdo->prepare('DELETE FROM aokie_companion_routing_members WHERE group_id = :group')
                ->execute(['group' => $id]);
            $check = $pdo->prepare(
                "SELECT id FROM aokie_companion_devices
                 WHERE id = :device AND app_id = :app AND role = 'mobile' AND revoked_at IS NULL"
            );
            $insert = $pdo->prepare(
                'INSERT INTO aokie_companion_routing_members
                    (group_id, device_id, priority_value, enabled, availability)
                 VALUES (:group, :device, :priority, :enabled, :availability)'
            );
            foreach ($normalized as $device => $member) {
                $check->execute(['device' => $device, 'app' => $appId]);
                if ($check->fetchColumn() === false) {
                    throw new \InvalidArgumentException('Every routing member must be an active mobile endpoint in this app');
                }
                $insert->execute([
                    'group' => $id,
                    'device' => $device,
                    'priority' => $member['priority'],
                    'enabled' => $member['enabled'] ? 1 : 0,
                    'availability' => $available[$device] ?? 'available',
                ]);
            }
            $pdo->commit();
        } catch (\Throwable $error) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $error;
        }
        foreach ($this->listRoutingGroups($appId) as $group) {
            if ($group['id'] === $id) {
                return $group;
            }
        }
        throw new \RuntimeException('Routing group save failed');
    }

    /** @return list<array<string,mixed>> */
    public function listRoutingGroups(string $appId): array
    {
        $groups = $this->db()->prepare(
            'SELECT * FROM aokie_companion_routing_groups
             WHERE app_id = :app ORDER BY name ASC, id ASC LIMIT 200'
        );
        $groups->execute(['app' => $appId]);
        $rows = $groups->fetchAll(PDO::FETCH_ASSOC);
        if ($rows === []) {
            return [];
        }
        $ids = array_column($rows, 'id');
        $ph = implode(',', array_fill(0, count($ids), '?'));
        $members = $this->db()->prepare(
            "SELECT rm.*, d.subject_id, d.display_name, d.user_id,
                    au.id AS staff_id, u.name AS staff_display_name, ar.name AS role_name
             FROM aokie_companion_routing_members rm
             JOIN aokie_companion_devices d ON d.id = rm.device_id AND d.revoked_at IS NULL
             JOIN app_users au
               ON au.app_id = d.app_id AND au.user_id = d.user_id AND au.status = 'active'
             JOIN users u ON u.id = au.user_id
             JOIN app_roles ar ON ar.id = au.role_id AND ar.app_id = au.app_id
             WHERE rm.group_id IN ({$ph}) ORDER BY rm.priority_value ASC, rm.device_id ASC"
        );
        $members->execute($ids);
        $byGroup = [];
        foreach ($members->fetchAll(PDO::FETCH_ASSOC) as $member) {
            $byGroup[$member['group_id']][] = $this->formatRoutingMember($member);
        }
        return array_map(static fn (array $row): array => [
            'id' => (string) $row['id'],
            'appId' => (string) $row['app_id'],
            'name' => (string) $row['name'],
            'policy' => (string) $row['policy'],
            'enabled' => (bool) $row['enabled'],
            'members' => $byGroup[$row['id']] ?? [],
            'createdAt' => self::utcTimestamp($row['created_at']),
            'updatedAt' => self::utcTimestamp($row['updated_at']),
        ], $rows);
    }

    public function deleteRoutingGroup(string $appId, string $id): bool
    {
        $stmt = $this->db()->prepare('DELETE FROM aokie_companion_routing_groups WHERE id = :id AND app_id = :app');
        $stmt->execute(['id' => $id, 'app' => $appId]);
        return $stmt->rowCount() === 1;
    }

    public function setAvailability(string $appId, string $deviceId, string $status, ?int $expiresAt = null): bool
    {
        if (!in_array($status, self::AVAILABILITY, true)) {
            throw new \InvalidArgumentException('availability must be available, busy, offline, or do_not_disturb');
        }
        if ($expiresAt !== null && ($expiresAt < time() + 60 || $expiresAt > time() + 86400)) {
            throw new \InvalidArgumentException('availability expiry must be 60 seconds to 24 hours in the future');
        }
        $stmt = $this->db()->prepare(
            'UPDATE aokie_companion_routing_members rm
             JOIN aokie_companion_routing_groups rg ON rg.id = rm.group_id
             JOIN aokie_companion_devices d ON d.id = rm.device_id AND d.app_id = rg.app_id
             JOIN apps a ON a.id = rg.app_id
             LEFT JOIN app_users au ON au.app_id = d.app_id AND au.user_id = d.user_id AND au.status = \'active\'
             SET rm.availability = :status, rm.availability_updated_at = NOW(),
                 rm.availability_expires_at = :expires
             WHERE rg.app_id = :app AND rm.device_id = :device AND d.revoked_at IS NULL
               AND (a.owner_id = d.user_id OR au.id IS NOT NULL)'
        );
        $stmt->execute([
            'status' => $status,
            'expires' => $expiresAt !== null ? gmdate('Y-m-d H:i:s', $expiresAt) : null,
            'app' => $appId,
            'device' => $deviceId,
        ]);
        if ($stmt->rowCount() > 0) {
            return true;
        }
        // MySQL reports zero changed rows when the same status is written twice;
        // availability updates are intentionally idempotent, not false 404s.
        $exists = $this->db()->prepare(
            'SELECT 1 FROM aokie_companion_routing_members rm
             JOIN aokie_companion_routing_groups rg ON rg.id = rm.group_id
             JOIN aokie_companion_devices d ON d.id = rm.device_id AND d.app_id = rg.app_id
             JOIN apps a ON a.id = rg.app_id
             LEFT JOIN app_users au ON au.app_id = d.app_id AND au.user_id = d.user_id AND au.status = \'active\'
             WHERE rg.app_id = :app AND rm.device_id = :device AND d.revoked_at IS NULL
               AND (a.owner_id = d.user_id OR au.id IS NOT NULL) LIMIT 1'
        );
        $exists->execute(['app' => $appId, 'device' => $deviceId]);
        return $exists->fetchColumn() !== false;
    }

    /** @return array<string,mixed>|null */
    public function getAvailability(string $appId, string $deviceId): ?array
    {
        $stmt = $this->db()->prepare(
            'SELECT rm.availability, rm.availability_updated_at, rm.availability_expires_at
             FROM aokie_companion_routing_members rm
             JOIN aokie_companion_routing_groups rg ON rg.id = rm.group_id
             WHERE rg.app_id = :app AND rm.device_id = :device
             ORDER BY rm.availability_updated_at DESC LIMIT 1'
        );
        $stmt->execute(['app' => $appId, 'device' => $deviceId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return null;
        }
        $expired = $row['availability_expires_at'] !== null
            && strtotime((string) $row['availability_expires_at']) <= time();
        return [
            'availability' => $expired ? 'offline' : (string) $row['availability'],
            'updatedAt' => self::utcTimestamp($row['availability_updated_at']),
            'expiresAt' => self::utcTimestamp($row['availability_expires_at']),
        ];
    }

    /**
     * Whether one relay-addressed mobile may receive a fresh assistance or
     * transfer request right now.
     *
     * The holder key is the server-authenticated mailbox address, not a field
     * read from the opaque frame. Availability remains transient routing
     * policy: this read deliberately never rewrites the endpoint's durable
     * grants. A member must still have the current stored grant and current
     * app-role permission, so revocation or role suspension takes effect even
     * while an older plugin admission is alive.
     */
    public function canReceiveRelayAssistance(string $appId, string $holderKeyThumbprint): bool
    {
        if (!AokieCompanionAdmissionSigner::validThumbprint($holderKeyThumbprint)) {
            return false;
        }
        $stmt = $this->db()->prepare(
            "SELECT 1
             FROM aokie_companion_devices d
             JOIN apps a ON a.id = d.app_id AND a.status = 'published'
             JOIN aokie_companion_routing_members rm ON rm.device_id = d.id
             JOIN aokie_companion_routing_groups rg
               ON rg.id = rm.group_id AND rg.app_id = d.app_id AND rg.enabled = 1
             LEFT JOIN app_users au
               ON au.app_id = d.app_id AND au.user_id = d.user_id AND au.status = 'active'
             WHERE d.app_id = :app AND d.role = 'mobile'
               AND d.holder_key_thumbprint = :holder AND d.revoked_at IS NULL
               AND JSON_CONTAINS(d.grants, JSON_QUOTE('state_read')) = 1
               AND JSON_CONTAINS(d.grants, JSON_QUOTE('assistance_read')) = 1
               AND rm.enabled = 1 AND rm.availability = 'available'
               AND (rm.availability_expires_at IS NULL OR rm.availability_expires_at > NOW())
               AND (a.owner_id = d.user_id OR (
                   au.id IS NOT NULL AND EXISTS (
                       SELECT 1 FROM app_role_permissions arp
                       WHERE arp.role_id = au.role_id AND arp.form_id IS NULL
                         AND arp.permission = :permission
                   )
               ))
             LIMIT 1"
        );
        $stmt->execute([
            'app' => $appId,
            'holder' => $holderKeyThumbprint,
            'permission' => AppPermissions::AOKIE_COMPANION_ASSISTANCE,
        ]);
        return $stmt->fetchColumn() !== false;
    }

    /** Atomically resolve and, for round-robin, advance one deterministic group. */
    public function resolveRoutingGroup(string $appId, string $id, ?string $requiredGrant = null): array
    {
        $requiredPermission = null;
        if ($requiredGrant !== null) {
            $requiredPermission = self::GATEWAY_TO_PERMISSION[$requiredGrant] ?? null;
            if ($requiredPermission === null) {
                throw new \InvalidArgumentException('Routing grant is not supported');
            }
        }
        $pdo = $this->db();
        $pdo->beginTransaction();
        try {
            $group = $pdo->prepare(
                'SELECT * FROM aokie_companion_routing_groups
                 WHERE id = :id AND app_id = :app AND enabled = 1 FOR UPDATE'
            );
            $group->execute(['id' => $id, 'app' => $appId]);
            $row = $group->fetch(PDO::FETCH_ASSOC);
            if (!$row) {
                throw new \DomainException('Enabled routing group not found');
            }
            $grantSql = $requiredGrant !== null
                ? ' AND JSON_CONTAINS(d.grants, JSON_QUOTE(:grant)) = 1
                    AND (a.owner_id = d.user_id OR EXISTS (
                        SELECT 1 FROM app_role_permissions arp
                        WHERE arp.role_id = au.role_id AND arp.form_id IS NULL AND arp.permission = :permission
                    ))'
                : '';
            $members = $pdo->prepare(
                "SELECT rm.*, d.subject_id, d.display_name, d.user_id,
                        au.id AS staff_id, u.name AS staff_display_name, ar.name AS role_name
                  FROM aokie_companion_routing_members rm
                  JOIN aokie_companion_devices d ON d.id = rm.device_id
                  JOIN apps a ON a.id = d.app_id AND a.id = :member_app AND a.status = 'published'
                  JOIN app_users au ON au.app_id = d.app_id AND au.user_id = d.user_id AND au.status = 'active'
                  JOIN users u ON u.id = au.user_id
                  JOIN app_roles ar ON ar.id = au.role_id AND ar.app_id = au.app_id
                  WHERE rm.group_id = :group AND rm.enabled = 1
                    AND rm.availability = 'available' AND d.revoked_at IS NULL
                    AND (rm.availability_expires_at IS NULL OR rm.availability_expires_at > NOW())
                    {$grantSql}
                  ORDER BY rm.priority_value ASC, rm.device_id ASC"
            );
            $memberParams = ['group' => $id, 'member_app' => $appId];
            if ($requiredGrant !== null) {
                $memberParams['grant'] = $requiredGrant;
                $memberParams['permission'] = $requiredPermission;
            }
            $members->execute($memberParams);
            $candidates = $members->fetchAll(PDO::FETCH_ASSOC);
            $selected = [];
            if ($candidates !== []) {
                if ($row['policy'] === 'all') {
                    $selected = $candidates;
                } elseif ($row['policy'] === 'priority') {
                    $selected = [$candidates[0]];
                } else {
                    $index = (int) $row['round_robin_cursor'] % count($candidates);
                    $selected = [$candidates[$index]];
                    $pdo->prepare(
                        'UPDATE aokie_companion_routing_groups
                         SET round_robin_cursor = round_robin_cursor + 1 WHERE id = :id'
                    )->execute(['id' => $id]);
                }
            }
            $pdo->commit();
            return [
                'groupId' => $id,
                'policy' => (string) $row['policy'],
                'members' => array_map([$this, 'formatRoutingMember'], $selected),
            ];
        } catch (\Throwable $error) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $error;
        }
    }

    private function applySessionEvent(
        PDO $pdo,
        string $appId,
        string $externalSessionId,
        string $callId,
        ?string $deviceId,
        string $subjectId,
        ?string $mode,
        string $state,
        string $eventId,
        string $occurredAt,
        string $reason,
    ): string {
        $find = $pdo->prepare(
            'SELECT * FROM aokie_companion_sessions
             WHERE app_id = :app AND external_session_id = :session FOR UPDATE'
        );
        $find->execute(['app' => $appId, 'session' => $externalSessionId]);
        $row = $find->fetch(PDO::FETCH_ASSOC);
        $ended = in_array($state, ['left', 'revoked'], true);
        if (!$row) {
            $id = self::uuid();
            $pdo->prepare(
                'INSERT INTO aokie_companion_sessions
                    (id, app_id, external_session_id, call_id, device_id, subject_id, mode,
                     state, joined_at, ended_at, end_reason, last_event_id, last_event_at)
                 VALUES (:id, :app, :session, :call, :device, :subject, :mode,
                         :state, :joined, :ended, :reason, :event, :event_at)'
            )->execute([
                'id' => $id,
                'app' => $appId,
                'session' => $externalSessionId,
                'call' => $callId,
                'device' => $deviceId,
                'subject' => $subjectId,
                'mode' => $mode ?? 'monitor',
                'state' => $state,
                'joined' => $state === 'joined' ? $occurredAt : null,
                'ended' => $ended ? $occurredAt : null,
                'reason' => $ended && $reason !== '' ? $reason : null,
                'event' => $eventId,
                'event_at' => $occurredAt,
            ]);
            return $id;
        }
        $id = (string) $row['id'];
        if (strtotime($occurredAt) >= (strtotime((string) $row['last_event_at']) ?: 0)) {
            $pdo->prepare(
                'UPDATE aokie_companion_sessions
                 SET call_id = :call, device_id = :device, subject_id = :subject,
                     mode = :mode, state = :state,
                     joined_at = CASE WHEN :is_joined = 1 THEN COALESCE(joined_at, :joined) ELSE joined_at END,
                     ended_at = :ended, end_reason = :reason,
                     last_event_id = :event, last_event_at = :event_at
                 WHERE id = :id'
            )->execute([
                'call' => $callId,
                'device' => $deviceId,
                'subject' => $subjectId,
                'mode' => $mode ?? (string) $row['mode'],
                'state' => $state,
                'is_joined' => $state === 'joined' ? 1 : 0,
                'joined' => $occurredAt,
                'ended' => $ended ? $occurredAt : null,
                'reason' => $ended && $reason !== '' ? $reason : null,
                'event' => $eventId,
                'event_at' => $occurredAt,
                'id' => $id,
            ]);
        }
        return $id;
    }

    /** @return array<string,mixed>|null */
    private function activityById(string $id): ?array
    {
        $stmt = $this->db()->prepare('SELECT * FROM aokie_companion_activity WHERE id = :id');
        $stmt->execute(['id' => $id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ? $this->formatActivity($row) : null;
    }

    /**
     * @param array<string,mixed> $identity
     * @return array{holderKeyThumbprint:string,endpointPublicKey:?array,endpointPublicKeyJson:?string,approvedPeerKeyThumbprints:list<string>,approvedPeerKeyThumbprintsJson:?string,peerRosterRevision:?int,peerRosterHash:?string,desktopConnectionId:?string}
     */
    private function validateEndpointIdentity(string $role, array $identity): array
    {
        if ($role === 'mobile') {
            if (array_diff(array_keys($identity), ['holderKeyThumbprint']) !== []
                || !array_key_exists('holderKeyThumbprint', $identity)) {
                throw new \InvalidArgumentException('mobile endpoint identity must contain only holderKeyThumbprint');
            }
            return [
                'holderKeyThumbprint' => AokieCompanionAdmissionSigner::requireThumbprint(
                    $identity['holderKeyThumbprint'],
                    'holderKeyThumbprint',
                ),
                'endpointPublicKey' => null,
                'endpointPublicKeyJson' => null,
                'approvedPeerKeyThumbprints' => [],
                'approvedPeerKeyThumbprintsJson' => null,
                'peerRosterRevision' => null,
                'peerRosterHash' => null,
                'desktopConnectionId' => null,
            ];
        }

        $expected = [
            'holderKeyThumbprint',
            'endpointPublicKey',
            'approvedPeerKeyThumbprints',
            'peerRosterRevision',
            'peerRosterHash',
            'desktopConnectionId',
        ];
        if (array_diff(array_keys($identity), $expected) !== []
            || array_diff($expected, array_keys($identity)) !== []) {
            throw new \InvalidArgumentException('plugin endpoint identity is incomplete or contains unknown fields');
        }
        $endpointPublicKey = AokieCompanionAdmissionSigner::validateEndpointPublicKey(
            $identity['endpointPublicKey'],
        );
        $holder = AokieCompanionAdmissionSigner::requireThumbprint(
            $identity['holderKeyThumbprint'],
            'holderKeyThumbprint',
        );
        if (!hash_equals($endpointPublicKey['thumbprint'], $holder)) {
            throw new \InvalidArgumentException('holderKeyThumbprint must equal endpointPublicKey.thumbprint');
        }
        $approvedPeers = AokieCompanionAdmissionSigner::validatePluginPeerPolicy(
            $identity['approvedPeerKeyThumbprints'],
            $identity['peerRosterRevision'],
            $identity['peerRosterHash'],
        );
        $desktopConnectionId = $this->requiredSafeId(
            $identity['desktopConnectionId'],
            'desktopConnectionId',
        );
        return [
            'holderKeyThumbprint' => $holder,
            'endpointPublicKey' => $endpointPublicKey,
            'endpointPublicKeyJson' => json_encode($endpointPublicKey, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR),
            'approvedPeerKeyThumbprints' => $approvedPeers,
            'approvedPeerKeyThumbprintsJson' => json_encode($approvedPeers, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR),
            'peerRosterRevision' => $identity['peerRosterRevision'],
            'peerRosterHash' => $identity['peerRosterHash'],
            'desktopConnectionId' => $desktopConnectionId,
        ];
    }

    /**
     * A stable key may advance its roster. Replaying an older revision, or
     * presenting different peers/hash under the same revision, fails closed.
     * @param array<string,mixed> $row
     * @param array<string,mixed> $identity
     */
    private function validatePluginRosterTransition(array $row, array $identity): void
    {
        if ($row['peer_roster_revision'] === null) {
            return;
        }
        $storedRevision = (int) $row['peer_roster_revision'];
        $requestedRevision = (int) $identity['peerRosterRevision'];
        if ($requestedRevision < $storedRevision) {
            throw new \DomainException('A stale Desktop peer roster cannot replace the current revision');
        }
        if ($requestedRevision > $storedRevision) {
            return;
        }
        $storedPeers = is_string($row['approved_peer_key_thumbprints'] ?? null)
            ? json_decode($row['approved_peer_key_thumbprints'], true)
            : null;
        $storedEndpointKey = is_string($row['endpoint_public_key'] ?? null)
            ? json_decode($row['endpoint_public_key'], true)
            : null;
        if (!is_array($storedPeers)
            || !is_array($storedEndpointKey)
            || $storedPeers !== $identity['approvedPeerKeyThumbprints']
            || $storedEndpointKey !== $identity['endpointPublicKey']
            || !is_string($row['peer_roster_hash'] ?? null)
            || !hash_equals($row['peer_roster_hash'], (string) $identity['peerRosterHash'])) {
            throw new \DomainException('Desktop peer roster revision reuse does not match its previously approved contents');
        }
    }

    /** @param array<string,mixed> $row @return array<string,mixed> */
    private function formatDevice(array $row): array
    {
        return [
            'id' => (string) $row['id'],
            'userId' => (string) $row['user_id'],
            'appId' => (string) $row['app_id'],
            'subjectId' => (string) $row['subject_id'],
            'role' => (string) $row['role'],
            'displayName' => (string) $row['display_name'],
            'grants' => is_string($row['grants']) ? (json_decode($row['grants'], true) ?: []) : [],
            'holderKeyThumbprint' => is_string($row['holder_key_thumbprint'] ?? null)
                ? $row['holder_key_thumbprint'] : null,
            'endpointPublicKey' => is_string($row['endpoint_public_key'] ?? null)
                ? json_decode($row['endpoint_public_key'], true) : null,
            'approvedPeerKeyThumbprints' => is_string($row['approved_peer_key_thumbprints'] ?? null)
                ? (json_decode($row['approved_peer_key_thumbprints'], true) ?: []) : [],
            'peerRosterRevision' => $row['peer_roster_revision'] !== null
                ? (int) $row['peer_roster_revision'] : null,
            'peerRosterHash' => is_string($row['peer_roster_hash'] ?? null)
                ? $row['peer_roster_hash'] : null,
            'desktopConnectionId' => is_string($row['desktop_connection_id'] ?? null)
                ? $row['desktop_connection_id'] : null,
            'approvedAt' => self::utcTimestamp($row['approved_at']),
            'lastSeenAt' => self::utcTimestamp($row['last_seen_at']),
            'revokedAt' => self::utcTimestamp($row['revoked_at']),
        ];
    }

    /** @param array<string,mixed> $row @return array<string,mixed> */
    private function formatActivity(array $row): array
    {
        return [
            'id' => (string) $row['id'],
            'eventId' => (string) $row['idempotency_key'],
            'appId' => (string) $row['app_id'],
            'sessionRecordId' => $row['session_id'] !== null ? (string) $row['session_id'] : null,
            'callId' => $row['call_id'] !== null ? (string) $row['call_id'] : null,
            'deviceId' => $row['device_id'] !== null ? (string) $row['device_id'] : null,
            'actorUserId' => $row['actor_user_id'] !== null ? (string) $row['actor_user_id'] : null,
            'subjectId' => (string) $row['subject_id'],
            'eventType' => (string) $row['event_type'],
            'mode' => $row['mode'] !== null ? (string) $row['mode'] : null,
            'reason' => $row['reason'] !== null ? (string) $row['reason'] : null,
            'ownerEpoch' => $row['owner_epoch'] !== null ? (int) $row['owner_epoch'] : null,
            'occurredAt' => self::utcTimestamp($row['occurred_at']),
        ];
    }

    /** @param array<string,mixed> $row @return array<string,mixed> */
    private function formatSession(array $row): array
    {
        return [
            'id' => (string) $row['id'],
            'sessionId' => (string) $row['external_session_id'],
            'callId' => (string) $row['call_id'],
            'deviceId' => $row['device_id'] !== null ? (string) $row['device_id'] : null,
            'subjectId' => (string) $row['subject_id'],
            'mode' => (string) $row['mode'],
            'state' => (string) $row['state'],
            'joinedAt' => self::utcTimestamp($row['joined_at']),
            'endedAt' => self::utcTimestamp($row['ended_at']),
            'endReason' => $row['end_reason'] !== null ? (string) $row['end_reason'] : null,
            'lastEventId' => (string) $row['last_event_id'],
            'lastEventAt' => self::utcTimestamp($row['last_event_at']),
        ];
    }

    /** @param array<string,mixed> $row @return array<string,mixed> */
    private function formatRoutingMember(array $row): array
    {
        $expired = $row['availability_expires_at'] !== null
            && strtotime((string) $row['availability_expires_at']) <= time();
        return [
            'deviceId' => (string) $row['device_id'],
            'userId' => (string) $row['user_id'],
            'subjectId' => (string) $row['subject_id'],
            'displayName' => (string) $row['display_name'],
            'staffId' => isset($row['staff_id']) ? (string) $row['staff_id'] : null,
            'staffDisplayName' => isset($row['staff_display_name'])
                ? (string) $row['staff_display_name'] : null,
            'roleName' => isset($row['role_name']) ? (string) $row['role_name'] : null,
            'priority' => (int) $row['priority_value'],
            'enabled' => (bool) $row['enabled'],
            'availability' => $expired ? 'offline' : (string) $row['availability'],
            'availabilityUpdatedAt' => self::utcTimestamp($row['availability_updated_at']),
            'availabilityExpiresAt' => self::utcTimestamp($row['availability_expires_at']),
        ];
    }

    /** Convert the UTC DATETIME/TIMESTAMP wire source to unambiguous RFC 3339. */
    private static function utcTimestamp(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }
        if (!is_string($value)
            || preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/D', $value) !== 1) {
            throw new \UnexpectedValueException('Companion timestamp is not a canonical UTC database value');
        }
        $timestamp = \DateTimeImmutable::createFromFormat(
            '!Y-m-d H:i:s',
            $value,
            new \DateTimeZone('UTC'),
        );
        $errors = \DateTimeImmutable::getLastErrors();
        if ($timestamp === false || (is_array($errors)
            && (($errors['warning_count'] ?? 0) !== 0 || ($errors['error_count'] ?? 0) !== 0))) {
            throw new \UnexpectedValueException('Companion timestamp is invalid');
        }
        return $timestamp->format('Y-m-d\\TH:i:s\\Z');
    }

    /** @return array{ok:false,code:string,message:string,connection:null} */
    private function bindingError(string $code, string $message): array
    {
        return ['ok' => false, 'code' => $code, 'message' => $message, 'connection' => null];
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
