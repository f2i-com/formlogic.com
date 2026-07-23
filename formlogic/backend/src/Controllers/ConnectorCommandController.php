<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\DesktopCommandService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Remote command relay (docs/API.md §connector:relay). Two surfaces:
 *   - Web (session-authed, /api/app/{slug}/connector-commands): a member ENQUEUES a connector
 *     command (member-gated AND permission-gated on connector.<connectorId>.<command>, the same
 *     grant the in-app connector client checks) and reads a command's result.
 *   - Desktop (API-key connector:relay, /api/v1/connector-commands): the runtime long-polls for
 *     pending commands, CLAIMS one (pending→claimed exactly-once) and COMPLETES it. The api-key
 *     user IS the owner whose desktop runtime services the commands their members enqueued.
 */
class ConnectorCommandController
{
    use JsonResponseTrait;

    public function __construct(
        private DesktopCommandService $commands,
        private AppService $appService,
        private AppUserService $appUserService,
        private ?\FormLogic\Database\MySQLConnection $db = null,
    ) {}

    /** Capability token lifetime — long enough to amortise minting, short enough to bound revocation lag. */
    private const CAPABILITY_TTL_SECONDS = 300;

    /**
     * Exact owner-only Desktop service pilot allow-list. Actions are safe
     * response metadata; grants are the authoritative Desktop permissions.
     */
    private const SERVICE_CAPABILITY_DEFINITIONS = [
        'openai-codex-agent' => [
            'actions' => [
                'status.read',
                'models.list',
                'assistant.chat',
            ],
            'grants' => [
                'service.openai-codex-agent.status.read',
                'service.openai-codex-agent.models.list',
                'service.openai-codex-agent.assistant.chat',
            ],
        ],
        'openai-api' => [
            'actions' => [
                'chat.complete',
                'models.list',
                'audio.transcribe',
                'audio.chat',
                'realtime.session.create',
            ],
            'grants' => [
                'service.openai-api.chat.complete',
                'service.openai-api.models.list',
                'service.openai-api.audio.transcribe',
                'service.openai-api.audio.chat',
                'service.openai-api.realtime.session.create',
            ],
        ],
    ];

    /**
     * POST /api/app/{slug}/connector-capability {connectorId} — mint a short-lived
     * capability the DESKTOP verifies before serving this member's LOCAL loopback
     * connector commands (audit SEC-001/C-08). The token encodes the member's
     * role-derived grant patterns; no grants → 403, so a Viewer's browser cannot
     * drive the phone even from a paired origin.
     */
    public function mintCapability(Request $request, Response $response, array $args): Response
    {
        [$app, $userId, $err] = $this->resolveMember($request, $response, (string) ($args['slug'] ?? ''));
        if ($err !== null) {
            return $err;
        }
        if ($this->db === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Capabilities unavailable'], 503);
        }
        $body = $request->getParsedBody() ?? [];
        $connectorId = (string) ($body['connectorId'] ?? '');
        if (!preg_match('/^[a-z0-9][a-z0-9_-]{0,63}$/', $connectorId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Invalid connector id'], 400);
        }
        $grants = $this->appUserService->getUserConnectorGrants($app['id'], (string) $userId, $connectorId);
        if ($grants === []) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Your role has no access to this connector'], 403);
        }
        $token = bin2hex(random_bytes(32));
        $ownerId = (string) ($app['ownerId'] ?? $app['owner_id'] ?? '');
        // Opportunistic hygiene: expired tokens are already unusable (introspection
        // filters on expires_at), this just stops the table growing without bound.
        $this->db->getConnection()->exec(
            "DELETE FROM connector_capabilities WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)"
        );
        $stmt = $this->db->getConnection()->prepare(
            "INSERT INTO connector_capabilities
                (id, token_hash, owner_user_id, user_id, app_id, connector_id, grants_json, expires_at)
             VALUES (:id, :h, :o, :u, :a, :c, :g, DATE_ADD(NOW(), INTERVAL :ttl SECOND))"
        );
        $stmt->execute([
            'id' => $this->uuidV4(),
            'h' => hash('sha256', $token),
            'o' => $ownerId,
            'u' => (string) $userId,
            'a' => $app['id'],
            'c' => $connectorId,
            'g' => json_encode($grants),
            'ttl' => self::CAPABILITY_TTL_SECONDS,
        ]);
        return $this->jsonResponse($response, [
            'token' => $token,
            'grants' => $grants,
            'expiresInSeconds' => self::CAPABILITY_TTL_SECONDS,
        ]);
    }

    /**
     * POST /api/app/{slug}/service-capability {serviceId} — mint the
     * owner-only capability used by a website to call an allowed OpenAI service
     * through the owner's linked FormLogic Desktop.
     *
     * This deliberately requires BOTH app ownership and an active membership;
     * it cannot be delegated to a role. The token carries only that service's
     * exact action grants, so it cannot authorize a connector, flow capability,
     * or another service.
     */
    public function mintServiceCapability(Request $request, Response $response, array $args): Response
    {
        [$app, $userId, $err] = $this->resolveMember($request, $response, (string) ($args['slug'] ?? ''));
        if ($err !== null) {
            return $err;
        }

        $ownerId = (string) ($app['ownerId'] ?? $app['owner_id'] ?? '');
        if ($ownerId === '' || !hash_equals($ownerId, (string) $userId)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Only the active app owner may use this Desktop service',
            ], 403);
        }
        if ($this->db === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Capabilities unavailable'], 503);
        }

        return $this->issueServiceCapability(
            $request,
            $response,
            $ownerId,
            (string) $userId,
            (string) $app['id']
        );
    }

    /**
     * POST /api/service-capability {serviceId} — account/workspace variant for
     * Form/App builders that do not have an app slug yet. The authenticated
     * account is both subject and Desktop owner; app_id intentionally stays NULL.
     */
    public function mintWorkspaceServiceCapability(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $principal = $request->getAttribute('user');
        if (
            !is_string($userId)
            || $userId === ''
            || !is_object($principal)
            || !isset($principal->id)
            || !is_string($principal->id)
            || !hash_equals($userId, $principal->id)
        ) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        // AuthMiddleware currently exposes only active users. Preserve an
        // explicit fail-closed seam if account suspension is added to User.
        if (property_exists($principal, 'status') && $principal->status !== 'active') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Account is not active'], 403);
        }
        if ($this->db === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Capabilities unavailable'], 503);
        }
        // Re-resolve the principal from durable storage. This prevents a stale
        // session-shaped request from minting after account deletion and also
        // honors a future users.status column without widening this endpoint.
        $stmt = $this->db->getConnection()->prepare('SELECT * FROM users WHERE id = :id LIMIT 1');
        $stmt->execute(['id' => $userId]);
        $user = $stmt->fetch();
        if (!$user) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        if (array_key_exists('status', $user) && $user['status'] !== 'active') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Account is not active'], 403);
        }

        return $this->issueServiceCapability($request, $response, $userId, $userId, null);
    }

    private function issueServiceCapability(
        Request $request,
        Response $response,
        string $ownerId,
        string $userId,
        ?string $appId
    ): Response
    {
        $body = $request->getParsedBody();
        // No caller-selected actions, grants, owners, or targets in the pilot.
        // Reject unknown fields instead of silently accepting a misleading
        // request that appears to select a different capability set.
        if (!is_array($body) || count($body) !== 1 || !array_key_exists('serviceId', $body)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'serviceId is required and is the only supported field',
            ], 400);
        }
        $serviceId = $body['serviceId'];
        if (
            !is_string($serviceId)
            || strlen($serviceId) > 64
            || !array_key_exists($serviceId, self::SERVICE_CAPABILITY_DEFINITIONS)
        ) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Unsupported service id',
            ], 400);
        }
        $definition = self::SERVICE_CAPABILITY_DEFINITIONS[$serviceId];

        // Transitional storage: Desktop already introspects this short-lived,
        // owner-scoped opaque-token table. The identifier records which pilot
        // service issued the token; Desktop uses only the verified grants/TTL.
        $token = $this->storeCapability(
            $ownerId,
            $userId,
            $appId,
            $serviceId,
            $definition['grants']
        );

        return $this->jsonResponse($response, [
            'token' => $token,
            'serviceId' => $serviceId,
            'actions' => $definition['actions'],
            'expiresInSeconds' => self::CAPABILITY_TTL_SECONDS,
        ])->withHeader('Cache-Control', 'no-store');
    }

    /**
     * GET /api/v1/connector-capabilities/{token} — Desktop introspection (flows:read),
     * owner-scoped: a Desktop can verify only capabilities minted for its owner
     * account (optionally scoped to one app).
     */
    public function introspectCapability(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        if ($this->db === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Capabilities unavailable'], 503);
        }
        $token = (string) ($args['token'] ?? '');
        if (!preg_match('/^[a-f0-9]{64}$/', $token)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Capability not found'], 404);
        }
        $stmt = $this->db->getConnection()->prepare(
            "SELECT user_id, app_id, connector_id, grants_json,
                    TIMESTAMPDIFF(SECOND, NOW(), expires_at) AS ttl
             FROM connector_capabilities
             WHERE token_hash = :h AND owner_user_id = :o AND expires_at > NOW()
             LIMIT 1"
        );
        $stmt->execute(['h' => hash('sha256', $token), 'o' => (string) $userId]);
        $row = $stmt->fetch();
        if (!$row) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Capability not found'], 404);
        }
        return $this->jsonResponse($response, [
            'userId' => $row['user_id'],
            'appId' => $row['app_id'],
            'connectorId' => $row['connector_id'],
            'grants' => json_decode((string) $row['grants_json'], true) ?: [],
            'expiresInSeconds' => max(0, (int) $row['ttl']),
        ]);
    }

    /** @param list<string> $grants */
    private function storeCapability(
        string $ownerId,
        string $userId,
        ?string $appId,
        string $identifier,
        array $grants
    ): string {
        if ($this->db === null) {
            throw new \LogicException('Capability storage is unavailable');
        }
        $token = bin2hex(random_bytes(32));
        // Expired rows cannot introspect; pruning prevents unbounded growth.
        $this->db->getConnection()->exec(
            "DELETE FROM connector_capabilities WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)"
        );
        $stmt = $this->db->getConnection()->prepare(
            "INSERT INTO connector_capabilities
                (id, token_hash, owner_user_id, user_id, app_id, connector_id, grants_json, expires_at)
             VALUES (:id, :h, :o, :u, :a, :c, :g, DATE_ADD(NOW(), INTERVAL :ttl SECOND))"
        );
        $stmt->execute([
            'id' => $this->uuidV4(),
            'h' => hash('sha256', $token),
            'o' => $ownerId,
            'u' => $userId,
            'a' => $appId,
            'c' => $identifier,
            'g' => json_encode($grants, JSON_THROW_ON_ERROR),
            'ttl' => self::CAPABILITY_TTL_SECONDS,
        ]);
        return $token;
    }

    private function uuidV4(): string
    {
        $d = random_bytes(16);
        $d[6] = chr((ord($d[6]) & 0x0f) | 0x40);
        $d[8] = chr((ord($d[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
    }

    // ── Web surface (member-gated) ──────────────────────────────────────────────────────────

    /**
     * Resolve a published app by slug + an ACTIVE member (mirrors FlowController::resolveRuntime).
     * @return array{0:?array,1:?string,2:?Response} [app, userId, errorResponse]
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

    /**
     * The permission a member needs to enqueue connector.<connectorId>.<command> — the SAME
     * grant model the in-app connector client applies. Accepts an exact grant, a per-connector
     * wildcard (connector.<id>.*) or the bare connector grant (connector.<id>). The app OWNER
     * always passes (hasPermission short-circuits on apps.owner_id).
     */
    private function memberCanRelay(string $appId, string $userId, string $connectorId, string $command): bool
    {
        foreach ([
            'connector.' . $connectorId . '.' . $command,
            'connector.' . $connectorId . '.*',
            'connector.' . $connectorId,
        ] as $permission) {
            if ($this->appUserService->hasPermission($appId, $userId, $permission)) {
                return true;
            }
        }
        return false;
    }

    /** POST /api/app/{slug}/connector-commands — member + connector-grant gated enqueue. */
    public function enqueue(Request $request, Response $response, array $args): Response
    {
        [$app, $userId, $error] = $this->resolveMember($request, $response, (string) ($args['slug'] ?? ''));
        if ($error) {
            return $error;
        }

        $body = $request->getParsedBody() ?? [];
        $connectorId = is_string($body['connectorId'] ?? null) ? (string) $body['connectorId'] : '';
        $command = is_string($body['command'] ?? null) ? (string) $body['command'] : '';
        if ($connectorId === '' || $command === '') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'connectorId and command are required'], 400);
        }
        // Private Aokie realtime/bootstrap commands are never public relay
        // capabilities. Deny before consulting exact/wildcard/bare grants or
        // resolving a desktop target, and let the service repeat the guard
        // immediately before persistence for defense in depth.
        if (DesktopCommandService::isPrivateAokieRelayCommand($connectorId, $command)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'private_connector_command',
                'message' => DesktopCommandService::PRIVATE_AOKIE_RELAY_MESSAGE,
            ], 403);
        }
        if (!$this->memberCanRelay($app['id'], $userId, $connectorId, $command)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'You do not have permission to run this connector command'], 403);
        }

        // ROUTE-001: the SERVER picks the target machine (connector assignment /
        // implicit single fresh desktop). A member-supplied targetInstanceId is
        // discarded — members must not aim commands past the owner's routing.
        unset($body['targetInstanceId']);
        $resolved = $this->commands->resolveTargetInstance($app['ownerId'], $connectorId);
        if ($resolved['error'] === 'ambiguous_desktop') {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'ambiguous_desktop',
                'message' => 'More than one FormLogic Desktop is online for this workspace — the owner must assign the connector to one machine before remote commands can be routed.',
                'desktops' => $resolved['desktops'],
            ], 409);
        }
        if ($resolved['target'] !== null) {
            $body['targetInstanceId'] = $resolved['target'];
        }

        try {
            $result = $this->commands->enqueue($app['ownerId'], $userId, $app['id'], $body);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
        $command = $result['command'];
        $payload = ['commandId' => $command['commandId'], 'status' => $command['status']];
        if (($command['targetInstanceId'] ?? null) !== null) {
            $payload['targetInstanceId'] = $command['targetInstanceId'];
        }
        if ($result['created']) {
            return $this->jsonResponse($response, $payload, 201);
        }
        return $this->jsonResponse($response, $payload + ['idempotent' => true], 200);
    }

    /** GET /api/app/{slug}/connector-commands/{id} — member reads the outcome. */
    public function getCommand(Request $request, Response $response, array $args): Response
    {
        [$app, , $error] = $this->resolveMember($request, $response, (string) ($args['slug'] ?? ''));
        if ($error) {
            return $error;
        }
        // Commands are owned by the app owner (whose desktop services them); a member may read any
        // command for THIS app.
        $command = $this->commands->get((string) ($args['id'] ?? ''), $app['ownerId']);
        if (!$command || ($command['appId'] ?? null) !== $app['id']) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Command not found'], 404);
        }
        // ROUTE-001: name the machine(s) involved so the UI can show "handled by
        // <device>" instead of an opaque instance id.
        $devices = $this->commands->describeInstances($app['ownerId'], array_filter([
            $command['targetInstanceId'] ?? null,
            $command['claimedBy'] ?? null,
        ]));
        if (($command['targetInstanceId'] ?? null) !== null && isset($devices[$command['targetInstanceId']])) {
            $command['targetDeviceName'] = $devices[$command['targetInstanceId']];
        }
        if (($command['claimedBy'] ?? null) !== null && isset($devices[$command['claimedBy']])) {
            $command['claimedByDeviceName'] = $devices[$command['claimedBy']];
        }
        return $this->jsonResponse($response, ['command' => $command]);
    }

    // ── Desktop surface (API-key connector:relay; userId == owner) ──────────────────────────

    /**
     * Server-derived caller identity for the desktop surface (audit FL-01): the API key's
     * connection binding is the authority — a claimed instanceId that belongs to a sibling
     * key is refused BEFORE any service call. @return array{0: ?string, 1: ?Response}
     */
    private function resolveCallerInstance(Request $request, Response $response, string $ownerUserId, ?string $claimed): array
    {
        $apiKeyId = $request->getAttribute('apiKeyId');
        try {
            $resolved = $this->commands->resolveDesktopIdentity(
                $ownerUserId,
                is_string($apiKeyId) && $apiKeyId !== '' ? $apiKeyId : null,
                $claimed
            );
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'instance_mismatch') {
                return [null, $this->jsonResponse($response, [
                    'error' => true,
                    'code' => 'instance_mismatch',
                    'message' => 'This desktop instance identity belongs to a different API key',
                ], 403)];
            }
            throw $e;
        }
        return [$resolved, null];
    }

    /**
     * GET /api/v1/connector-commands/pending?since=&wait=<ms>&instanceId= — long-poll for the
     * owner's runtime. ROUTE-001: instanceId identifies the polling desktop, which then also
     * receives commands TARGETED at it; without it only untargeted (legacy fan-out) rows show.
     * The effective identity is server-derived from the API key binding (audit FL-01).
     */
    public function pending(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $q = $request->getQueryParams();
        $since = isset($q['since']) && $q['since'] !== '' ? (string) $q['since'] : null;
        $wait = (int) ($q['wait'] ?? 0);
        $limit = (int) ($q['limit'] ?? 50);
        $claimed = isset($q['instanceId']) && $q['instanceId'] !== '' ? (string) $q['instanceId'] : null;
        [$instanceId, $identityError] = $this->resolveCallerInstance($request, $response, (string) $userId, $claimed);
        if ($identityError !== null) {
            return $identityError;
        }
        $commands = $this->commands->pollPending((string) $userId, $since, $wait, $limit, $instanceId);
        return $this->jsonResponse($response, ['commands' => $commands]);
    }

    /** POST /api/v1/connector-commands/{id}/claim — pending→claimed exactly-once (409 if taken). */
    public function claim(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $body = $request->getParsedBody() ?? [];
        $claimed = is_array($body) && is_string($body['instanceId'] ?? null) && $body['instanceId'] !== '' ? (string) $body['instanceId'] : null;
        [$resolvedInstance, $identityError] = $this->resolveCallerInstance($request, $response, (string) $userId, $claimed);
        if ($identityError !== null) {
            return $identityError;
        }
        if (is_array($body)) {
            $body['instanceId'] = $resolvedInstance;
        }
        try {
            $command = $this->commands->claim((string) ($args['id'] ?? ''), (string) $userId, is_array($body) ? $body : []);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'already_claimed') {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'This command was already claimed or has expired'], 409);
            }
            if ($e->getMessage() === 'targeted_elsewhere') {
                // ROUTE-001: this command is pinned to a DIFFERENT desktop instance.
                // The claimer should treat this as "not mine" and move on, not retry.
                return $this->jsonResponse($response, [
                    'error' => true,
                    'code' => 'targeted_elsewhere',
                    'message' => 'This command is targeted at a different desktop instance',
                ], 409);
            }
            throw $e;
        }
        if (!$command) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Command not found'], 404);
        }
        return $this->jsonResponse($response, ['command' => $command, 'claimed' => true]);
    }

    /** POST /api/v1/connector-commands/{id}/complete — claimed→done|failed with result/error. */
    public function complete(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $body = $request->getParsedBody() ?? [];
        $claimed = is_array($body) && is_string($body['instanceId'] ?? null) && $body['instanceId'] !== '' ? (string) $body['instanceId'] : null;
        [$resolvedInstance, $identityError] = $this->resolveCallerInstance($request, $response, (string) $userId, $claimed);
        if ($identityError !== null) {
            return $identityError;
        }
        if (is_array($body)) {
            $body['instanceId'] = $resolvedInstance;
        }
        try {
            $command = $this->commands->complete((string) ($args['id'] ?? ''), (string) $userId, is_array($body) ? $body : []);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'not_claimed') {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'This command is not in a claimed state'], 409);
            }
            if ($e->getMessage() === 'claimed_elsewhere') {
                // Audit INT-005/C-14: the completing desktop is NOT the claimant.
                return $this->jsonResponse($response, ['error' => true, 'message' => 'This command was claimed by a different desktop instance'], 409);
            }
            throw $e;
        }
        if (!$command) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Command not found'], 404);
        }
        return $this->jsonResponse($response, ['command' => $command]);
    }
}
