<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Constants\AppPermissions;
use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\AokieCompanionDeviceService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
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
 * v1 is READ-ONLY (owner-infrastructure snapshots the sandbox otherwise cannot
 * see); mutating operations get their own ceremony review before registration.
 */
class ServiceInvokeController
{
    use JsonResponseTrait;

    public function __construct(
        private AppService $appService,
        private AppUserService $appUserService,
        private FlowService $flowService,
        private ?AokieCompanionDeviceService $companionDevices = null,
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

        $result = match ($operationId) {
            'aokie.companion.devices.list' => $this->companionDevicesList($app),
            'aokie.companion.policy.get' => $this->companionPolicyGet($app),
            'desktop.connections.list' => $this->desktopConnectionsList($app),
            default => null,
        };
        if ($result === null) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'operation_unavailable',
                'message' => 'This service operation is not available on this deployment',
            ], 503);
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
