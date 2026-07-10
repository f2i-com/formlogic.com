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
    ) {}

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
        if (!$this->memberCanRelay($app['id'], $userId, $connectorId, $command)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'You do not have permission to run this connector command'], 403);
        }

        try {
            $result = $this->commands->enqueue($app['ownerId'], $userId, $app['id'], $body);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
        $command = $result['command'];
        $payload = ['commandId' => $command['commandId'], 'status' => $command['status']];
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
        return $this->jsonResponse($response, ['command' => $command]);
    }

    // ── Desktop surface (API-key connector:relay; userId == owner) ──────────────────────────

    /** GET /api/v1/connector-commands/pending?since=&wait=<ms> — long-poll for the owner's runtime. */
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
        $commands = $this->commands->pollPending((string) $userId, $since, $wait, $limit);
        return $this->jsonResponse($response, ['commands' => $commands]);
    }

    /** POST /api/v1/connector-commands/{id}/claim — pending→claimed exactly-once (409 if taken). */
    public function claim(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        try {
            $command = $this->commands->claim((string) ($args['id'] ?? ''), (string) $userId, $request->getParsedBody() ?? []);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'already_claimed') {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'This command was already claimed or has expired'], 409);
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
        try {
            $command = $this->commands->complete((string) ($args['id'] ?? ''), (string) $userId, $request->getParsedBody() ?? []);
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
