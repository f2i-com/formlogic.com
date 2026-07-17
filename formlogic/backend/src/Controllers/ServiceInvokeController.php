<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Constants\AppPermissions;
use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\AokieCompanionDeviceService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\AuditService;
use FormLogic\Services\FlowService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Typed service.invoke for pack-owned sandboxed screens (plan §8.3, APP-503).
 *
 * POST /api/app/{slug}/service-invoke/{operationId} — every operation is
 * SERVER-REGISTERED in self::OPERATIONS with an exact handler, required
 * permission, connector binding and input byte cap, and every response is an
 * explicit projection (never a raw service row). There is deliberately NO
 * generic passthrough: an unregistered operationId is a 404, so a pack screen
 * can only ever reach the operations this registry names (the §8.3 rejection
 * of raw backend.fetch / caller-selected paths).
 *
 * Read operations are owner-infrastructure snapshots the sandbox otherwise
 * cannot see. The mutating Companion-administration operations mirror
 * AokieCompanionController's own gates and audit events one-for-one (an extra
 * 'via' detail marks the service-invoke path) — never a wider surface.
 */
class ServiceInvokeController
{
    use JsonResponseTrait;

    public function __construct(
        private AppService $appService,
        private AppUserService $appUserService,
        private FlowService $flowService,
        private ?AokieCompanionDeviceService $companionDevices = null,
        private ?AuditService $audit = null,
    ) {}

    /**
     * The operation registry. Fields:
     *  - permission: 'owner' (caller must be the app owner) |
     *                'member' (any active member) |
     *                'companion_audit' (MANAGE_AOKIE_COMPANION or
     *                 AOKIE_COMPANION_AUDIT — mirrors AokieCompanionController::canAudit)
     *  - connector: when set, the CALLER must hold some connector grant for
     *               this connector id in the app (the same role-derived truth
     *               the relay/capability mint checks; the owner always passes)
     *  - inputMax:  JSON byte cap for the request's `input` object
     */
    private const OPERATIONS = [
        'aokie.companion.devices.list' => [
            'permission' => 'companion_audit',
            'connector' => 'aokie',
            'inputMax' => 2048,
        ],
        'aokie.companion.policy.get' => [
            'permission' => 'member',
            'connector' => 'aokie',
            'inputMax' => 2048,
        ],
        'desktop.connections.list' => [
            'permission' => 'owner',
            'connector' => null,
            'inputMax' => 2048,
        ],
        // ── Mutating Companion administration (mirrors AokieCompanionController's
        // gates + audit events exactly; the Device Setup pack screen drives these).
        // Revoke allows SELF-revoke (a member may cut off their own endpoint), so
        // its registry tier is 'member' and the handler enforces manage-or-self.
        'aokie.companion.devices.revoke' => [
            'permission' => 'member',
            'connector' => 'aokie',
            'inputMax' => 2048,
        ],
        'aokie.companion.devices.approve' => [
            'permission' => 'companion_manage',
            'connector' => 'aokie',
            'inputMax' => 2048,
        ],
        'aokie.companion.policy.update' => [
            'permission' => 'companion_manage',
            'connector' => 'aokie',
            'inputMax' => 4096,
        ],
    ];

    /** POST /api/app/{slug}/service-invoke/{operationId} */
    public function invoke(Request $request, Response $response, array $args): Response
    {
        $slug = (string) ($args['slug'] ?? '');
        $operationId = (string) ($args['operationId'] ?? '');
        $spec = self::OPERATIONS[$operationId] ?? null;
        if ($spec === null) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'unknown_operation',
                'message' => 'Unknown service operation',
            ], 404);
        }

        [$app, $userId, $err] = $this->resolveMember($request, $response, $slug);
        if ($err !== null) {
            return $err;
        }

        if (!$this->permitted($spec, $app, $userId)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'forbidden',
                'message' => 'You do not have permission to run this service operation',
            ], 403);
        }

        $body = $request->getParsedBody() ?? [];
        $input = is_array($body['input'] ?? null) ? $body['input'] : [];
        if (strlen((string) json_encode($input)) > (int) $spec['inputMax']) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'input_too_large',
                'message' => 'Service operation input is too large',
            ], 400);
        }

        $ip = (string) ($request->getServerParams()['REMOTE_ADDR'] ?? '');
        $result = match ($operationId) {
            'aokie.companion.devices.list' => $this->companionDevicesList($app),
            'aokie.companion.policy.get' => $this->companionPolicyGet($app),
            'desktop.connections.list' => $this->desktopConnectionsList($app),
            'aokie.companion.devices.revoke' => $this->companionDeviceRevoke($app, $userId, $input, $ip),
            'aokie.companion.devices.approve' => $this->companionDeviceApprove($app, $userId, $input, $ip),
            'aokie.companion.policy.update' => $this->companionPolicyUpdate($app, $userId, $input, $ip),
            default => null,
        };
        if ($result === null) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'operation_unavailable',
                'message' => 'This service operation is not available on this deployment',
            ], 503);
        }
        // A handler-level refusal (op-specific authorization / validation).
        if (isset($result['error'])) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => (string) ($result['code'] ?? 'operation_failed'),
                'message' => (string) ($result['message'] ?? 'The operation was refused'),
            ], (int) ($result['status'] ?? 400));
        }
        return $this->jsonResponse($response, ['operationId' => $operationId, 'result' => $result]);
    }

    // ── Gates ───────────────────────────────────────────────────────────────

    /**
     * Resolve a published app + an ACTIVE member (mirrors
     * ConnectorCommandController::resolveMember — same runtime trust base).
     * @return array{0:?array,1:?string,2:?Response}
     */
    private function resolveMember(Request $request, Response $response, string $slug): array
    {
        if (!preg_match('/^[a-z0-9][a-z0-9-]{0,60}$/', $slug)) {
            return [null, null, $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404)];
        }
        $app = $this->appService->getAppBySlug($slug);
        if (!$app || ($app['status'] ?? null) !== 'published') {
            return [null, null, $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404)];
        }
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return [null, null, $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401)];
        }
        $appUser = $this->appUserService->getAppUser($app['id'], $userId);
        if (!$appUser || ($appUser['status'] ?? null) !== 'active') {
            return [null, null, $this->jsonResponse($response, ['error' => true, 'message' => 'Not a member of this app'], 403)];
        }
        return [$app, (string) $userId, null];
    }

    /** @param array{permission:string,connector:?string,inputMax:int} $spec */
    private function permitted(array $spec, array $app, string $userId): bool
    {
        $appId = (string) $app['id'];
        $isOwner = (string) ($app['ownerId'] ?? $app['owner_id'] ?? '') === $userId;
        $ok = match ($spec['permission']) {
            'owner' => $isOwner,
            'member' => true, // resolveMember already proved active membership
            'companion_audit' => $isOwner
                || $this->appUserService->hasPermission($appId, $userId, AppPermissions::MANAGE_AOKIE_COMPANION)
                || $this->appUserService->hasPermission($appId, $userId, AppPermissions::AOKIE_COMPANION_AUDIT),
            'companion_manage' => $this->canManageCompanion($appId, $userId, $isOwner),
            default => false,
        };
        if (!$ok) {
            return false;
        }
        // Connector binding: the operation belongs to a connector app — the
        // caller's role must hold SOME grant for that connector (owner → ['*']).
        $connector = $spec['connector'];
        if (is_string($connector) && $connector !== '') {
            return $this->appUserService->getUserConnectorGrants($appId, $userId, $connector) !== [];
        }
        return true;
    }

    // ── Handlers (each returns an explicit projection) ──────────────────────

    /**
     * Companion endpoints for this app — the identity/keys columns
     * (thumbprints, endpoint keys, peer roster) are DELIBERATELY not projected.
     * @return array{devices: list<array<string,mixed>>}|null
     */
    private function companionDevicesList(array $app): ?array
    {
        if ($this->companionDevices === null) {
            return null;
        }
        $devices = [];
        foreach ($this->companionDevices->listForApp((string) $app['id']) as $d) {
            $devices[] = [
                'id' => (string) ($d['id'] ?? ''),
                'role' => (string) ($d['role'] ?? ''),
                'displayName' => (string) ($d['displayName'] ?? ''),
                'grants' => is_array($d['grants'] ?? null) ? $d['grants'] : [],
                'approvedAt' => $d['approvedAt'] ?? null,
                'lastSeenAt' => $d['lastSeenAt'] ?? null,
                'revokedAt' => $d['revokedAt'] ?? null,
            ];
        }
        return ['devices' => $devices];
    }

    /**
     * The app's Companion remote-consent policy (mirrors
     * AokieCompanionController::remoteConsent — closed when unconfigured/invalid).
     * @return array<string,bool>
     */
    private function companionPolicyGet(array $app): array
    {
        $keys = ['remoteMonitoring', 'remoteConsult', 'remoteTakeover', 'remoteCaptions', 'remoteAssistance'];
        $closed = ['configured' => false] + array_fill_keys($keys, false);
        $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
        $companion = is_array($settings['aokieCompanion'] ?? null) ? $settings['aokieCompanion'] : [];
        $policy = $companion['remoteConsent'] ?? null;
        if (!is_array($policy)
            || array_diff(array_keys($policy), $keys) !== []
            || array_diff($keys, array_keys($policy)) !== []) {
            return $closed;
        }
        $out = ['configured' => true];
        foreach ($keys as $k) {
            $out[$k] = (bool) $policy[$k];
        }
        return $out;
    }

    private function canManageCompanion(string $appId, string $userId, bool $isOwner): bool
    {
        return $isOwner
            || $this->appUserService->hasPermission($appId, $userId, AppPermissions::MANAGE_AOKIE_COMPANION);
    }

    /**
     * Revoke a Companion endpoint (mirrors AokieCompanionController::revokeDevice:
     * canManage OR the device's own user; a foreign/unknown device reads as
     * not-found — never reveal cross-app existence).
     * @param array<string,mixed> $input
     * @return array<string,mixed>
     */
    private function companionDeviceRevoke(array $app, string $userId, array $input, string $ip): array
    {
        if ($this->companionDevices === null) {
            return ['error' => true, 'status' => 503, 'code' => 'operation_unavailable', 'message' => 'Companion administration is not available on this deployment'];
        }
        $deviceId = is_string($input['deviceId'] ?? null) ? $input['deviceId'] : '';
        $device = $deviceId !== '' ? $this->companionDevices->getDevice($deviceId) : null;
        $appId = (string) $app['id'];
        $isOwner = (string) ($app['ownerId'] ?? $app['owner_id'] ?? '') === $userId;
        if ($device === null
            || (string) ($device['appId'] ?? '') !== $appId
            || (!$this->canManageCompanion($appId, $userId, $isOwner) && ($device['userId'] ?? null) !== $userId)) {
            return ['error' => true, 'status' => 404, 'code' => 'device_not_found', 'message' => 'Active endpoint not found'];
        }
        if ($this->companionDevices->revokeById($userId, $deviceId) === null) {
            return ['error' => true, 'status' => 404, 'code' => 'device_not_found', 'message' => 'Active endpoint not found'];
        }
        $this->audit?->log(
            'aokie.companion.device.revoked',
            'app',
            $appId,
            $userId,
            $ip,
            ['deviceRecordId' => $deviceId, 'role' => $device['role'] ?? null, 'via' => 'service-invoke'],
        );
        return ['success' => true];
    }

    /**
     * Re-approve a revoked Companion endpoint (mirrors approveDevice: manage
     * permission; the device must sign in and authorize again).
     * @param array<string,mixed> $input
     * @return array<string,mixed>
     */
    private function companionDeviceApprove(array $app, string $userId, array $input, string $ip): array
    {
        if ($this->companionDevices === null) {
            return ['error' => true, 'status' => 503, 'code' => 'operation_unavailable', 'message' => 'Companion administration is not available on this deployment'];
        }
        $deviceId = is_string($input['deviceId'] ?? null) ? $input['deviceId'] : '';
        $device = $deviceId !== '' ? $this->companionDevices->getDevice($deviceId) : null;
        $appId = (string) $app['id'];
        if ($device === null || (string) ($device['appId'] ?? '') !== $appId) {
            return ['error' => true, 'status' => 404, 'code' => 'device_not_found', 'message' => 'Revoked endpoint not found'];
        }
        if (!$this->companionDevices->approveAgainById($deviceId)) {
            return ['error' => true, 'status' => 404, 'code' => 'device_not_found', 'message' => 'Revoked endpoint not found'];
        }
        $this->audit?->log(
            'aokie.companion.device.reapproved',
            'app',
            $appId,
            $userId,
            $ip,
            ['deviceRecordId' => $deviceId, 'reauthorizationRequired' => true, 'via' => 'service-invoke'],
        );
        return ['success' => true, 'reauthorizationRequired' => true];
    }

    /**
     * Update the app's Companion remote-consent policy (mirrors updatePolicy:
     * exactly the five boolean keys, written into app settings, audited).
     * @param array<string,mixed> $input
     * @return array<string,mixed>
     */
    private function companionPolicyUpdate(array $app, string $userId, array $input, string $ip): array
    {
        $keys = ['remoteMonitoring', 'remoteConsult', 'remoteTakeover', 'remoteCaptions', 'remoteAssistance'];
        $raw = $input['remoteConsent'] ?? null;
        if (!is_array($raw)
            || array_diff(array_keys($raw), $keys) !== []
            || array_diff($keys, array_keys($raw)) !== []) {
            return ['error' => true, 'status' => 400, 'code' => 'invalid_remote_consent', 'message' => 'remoteConsent must contain exactly remoteMonitoring, remoteConsult, remoteTakeover, remoteCaptions, and remoteAssistance'];
        }
        $policy = [];
        foreach ($keys as $k) {
            $policy[$k] = (bool) $raw[$k];
        }
        $appId = (string) $app['id'];
        $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
        $companion = is_array($settings['aokieCompanion'] ?? null) ? $settings['aokieCompanion'] : [];
        $companion['remoteConsent'] = $policy;
        $settings['aokieCompanion'] = $companion;
        $this->appService->updateApp($appId, ['settings' => $settings]);
        $this->audit?->log(
            'aokie.companion.policy.updated',
            'app',
            $appId,
            $userId,
            $ip,
            ['remoteConsent' => $policy, 'via' => 'service-invoke'],
        );
        return ['configured' => true] + $policy;
    }

    /**
     * The OWNER's paired-desktop registry, projected to display fields only
     * (no api key ids, instance ids, capabilities or trusted origins).
     * @return array{connections: list<array<string,mixed>>}
     */
    private function desktopConnectionsList(array $app): array
    {
        $ownerId = (string) ($app['ownerId'] ?? $app['owner_id'] ?? '');
        $connections = [];
        foreach ($this->flowService->listDesktopConnections($ownerId) as $c) {
            $connections[] = [
                'id' => (string) ($c['id'] ?? ''),
                'deviceName' => (string) ($c['deviceName'] ?? ''),
                'lastSeenAt' => $c['lastSeenAt'] ?? null,
                'createdAt' => $c['createdAt'] ?? null,
            ];
        }
        return ['connections' => $connections];
    }
}
