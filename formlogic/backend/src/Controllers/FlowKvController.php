<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FlowKvService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Flow KV storage (docs/FORMLOGIC_FLOWS.md §9):
 *   - Owner surface: GET/PUT/DELETE /api/flow-kv (session auth) and the /api/v1/flow-kv mirrors
 *     (flows:read / flows:write API keys). appId (optional) must be an app the caller OWNS;
 *     omitted appId addresses the caller's workspace store.
 *   - Runtime surface: GET/PUT /api/app/{slug}/flow-kv — member-gated like flow-runs and
 *     rate-limited 'flow_run'. Rows are keyed by the APP OWNER + app id, so every member of an
 *     app reads/writes the same shared store (flows are app-level state, not per-member).
 */
class FlowKvController
{
    use JsonResponseTrait;

    private FlowKvService $kv;
    private AppService $appService;
    private AppUserService $appUserService;

    public function __construct(FlowKvService $kv, AppService $appService, AppUserService $appUserService)
    {
        $this->kv = $kv;
        $this->appService = $appService;
        $this->appUserService = $appUserService;
    }

    // ── Owner surface (/api/flow-kv + /api/v1/flow-kv) ─────────────────────────────────────

    /** GET ?scope=&k=&appId= — one entry when k is given, else the (scope-filtered) list. */
    public function ownerGet(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $q = $request->getQueryParams();
        $appId = $this->resolveOwnedAppId($userId, isset($q['appId']) ? (string) $q['appId'] : null);
        if ($appId === false) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }
        try {
            if (isset($q['k']) && $q['k'] !== '') {
                $entry = $this->kv->get($userId, $appId, (string) ($q['scope'] ?? ''), (string) $q['k']);
                if (!$entry) {
                    return $this->jsonResponse($response, ['error' => true, 'message' => 'Key not found'], 404);
                }
                return $this->jsonResponse($response, ['entry' => $entry]);
            }
            $scope = isset($q['scope']) ? (string) $q['scope'] : null;
            return $this->jsonResponse($response, ['entries' => $this->kv->list($userId, $appId, $scope)]);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    /** PUT {scope, k, v, appId?} — upsert one key. */
    public function ownerPut(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $body = $request->getParsedBody() ?? [];
        $appId = $this->resolveOwnedAppId($userId, isset($body['appId']) ? (string) $body['appId'] : null);
        if ($appId === false) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }
        try {
            $entry = $this->kv->put($userId, $appId, (string) ($body['scope'] ?? ''), (string) ($body['k'] ?? ''), $body['v'] ?? null);
            return $this->jsonResponse($response, ['entry' => $entry]);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    /** DELETE ?scope=&k=&appId= — remove one key. */
    public function ownerDelete(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $q = $request->getQueryParams();
        $appId = $this->resolveOwnedAppId($userId, isset($q['appId']) ? (string) $q['appId'] : null);
        if ($appId === false) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }
        try {
            $ok = $this->kv->delete($userId, $appId, (string) ($q['scope'] ?? ''), (string) ($q['k'] ?? ''));
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
        if (!$ok) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Key not found'], 404);
        }
        return $this->jsonResponse($response, ['success' => true]);
    }

    // ── Runtime surface (/api/app/{slug}/flow-kv — member-gated, app-shared store) ──────────

    public function runtimeGet(Request $request, Response $response, array $args): Response
    {
        [$app, $error] = $this->resolveRuntime($request, $response, (string) ($args['slug'] ?? ''));
        if ($error) {
            return $error;
        }
        $q = $request->getQueryParams();
        try {
            if (isset($q['k']) && $q['k'] !== '') {
                $entry = $this->kv->get($app['ownerId'], $app['id'], (string) ($q['scope'] ?? ''), (string) $q['k']);
                if (!$entry) {
                    return $this->jsonResponse($response, ['error' => true, 'message' => 'Key not found'], 404);
                }
                return $this->jsonResponse($response, ['entry' => $entry]);
            }
            $scope = isset($q['scope']) ? (string) $q['scope'] : null;
            return $this->jsonResponse($response, ['entries' => $this->kv->list($app['ownerId'], $app['id'], $scope)]);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function runtimePut(Request $request, Response $response, array $args): Response
    {
        [$app, $error] = $this->resolveRuntime($request, $response, (string) ($args['slug'] ?? ''));
        if ($error) {
            return $error;
        }
        $body = $request->getParsedBody() ?? [];
        try {
            $entry = $this->kv->put($app['ownerId'], $app['id'], (string) ($body['scope'] ?? ''), (string) ($body['k'] ?? ''), $body['v'] ?? null);
            return $this->jsonResponse($response, ['entry' => $entry]);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────────

    /**
     * Map an optional appId to the KV app scope: null stays null (workspace); a non-empty id
     * must be an app the caller owns (else FALSE → 404, never a cross-tenant read).
     * @return string|null|false
     */
    private function resolveOwnedAppId(string $userId, ?string $appId): string|null|false
    {
        if ($appId === null || $appId === '') {
            return null;
        }
        $app = $this->appService->getApp($appId);
        if (!$app || ($app['ownerId'] ?? null) !== $userId) {
            return false;
        }
        return $appId;
    }

    /**
     * Published app by slug + ACTIVE member holding execute_flows — the same runtime gate as
     * FlowController (audit FL-AUTH-001: the shared flow-KV store is flow-execution state, so
     * membership alone must not read or write it).
     * @return array{0: ?array, 1: ?Response} [app, errorResponse]
     */
    private function resolveRuntime(Request $request, Response $response, string $slug): array
    {
        if (!preg_match('/^[a-z0-9][a-z0-9-]{0,60}$/', $slug)) {
            return [null, $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404)];
        }
        $app = $this->appService->getAppBySlug($slug);
        if (!$app || $app['status'] !== 'published') {
            return [null, $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404)];
        }
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return [null, $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401)];
        }
        $appUser = $this->appUserService->getAppUser($app['id'], $userId);
        if (!$appUser || $appUser['status'] !== 'active') {
            return [null, $this->jsonResponse($response, ['error' => true, 'message' => 'Not a member of this app'], 403)];
        }
        // hasPermission() returns true for the app owner unconditionally.
        if (!$this->appUserService->hasPermission($app['id'], $userId, \FormLogic\Constants\AppPermissions::EXECUTE_FLOWS)) {
            return [null, $this->jsonResponse($response, ['error' => true, 'message' => 'You do not have permission to run flows in this app'], 403)];
        }
        return [$app, null];
    }
}
