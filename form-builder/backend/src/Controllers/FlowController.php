<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\ApiKeyService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FlowService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * FormLogic Flows (docs/FORMLOGIC_FLOWS.md):
 *   - Owner CRUD under /api/apps/{id} — flow library, event bindings, run history, test runs
 *     (same ownership gate as the domains/reports admin surfaces).
 *   - Workspace scope under /api/flows, /api/flow-runs, /api/forms/{id}/flow-bindings — the
 *     user's own app-independent flows (auth like /api/forms), plus owner-wide run history,
 *     queued-run listing and claiming.
 *   - Runtime under /api/app/{slug} — enabled definitions/bindings for the browser runner and the
 *     reserve-first run log (member-gated like the runtime report endpoints; rate-limited 'flow_run').
 *   - External API mirrors under /api/v1 (flows:read / flows:write API-key scopes) reuse the SAME
 *     owner-scoped methods — ApiKeyMiddleware sets the userId attribute just like AuthMiddleware —
 *     which is what FormLogic Desktop uses headless.
 *   - Desktop connections under /api/desktop-connections — the paired-desktop registry (per-user).
 */
class FlowController
{
    use JsonResponseTrait;

    private FlowService $flows;
    private AppService $appService;
    private AppUserService $appUserService;
    private ?ApiKeyService $apiKeys;

    public function __construct(FlowService $flows, AppService $appService, AppUserService $appUserService, ?ApiKeyService $apiKeys = null)
    {
        $this->flows = $flows;
        $this->appService = $appService;
        $this->appUserService = $appUserService;
        $this->apiKeys = $apiKeys;
    }

    /** @return array{0:?string,1:?array} [userId, app] when the caller owns the app; else nulls. */
    private function requireOwner(Request $request, string $appId): array
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return [null, null];
        }
        $app = $this->appService->getApp($appId);
        if (!$app || ($app['ownerId'] ?? null) !== $userId) {
            return [null, null];
        }
        return [$userId, $app];
    }

    /**
     * Resolve a runtime request: published app by slug + an ACTIVE member (flows execute with the
     * viewer's session; every formlogic.* write still goes through the normal permission-checked API).
     * @return array{0:?array,1:?string,2:?Response} [app, userId, errorResponse]
     */
    private function resolveRuntime(Request $request, Response $response, string $slug): array
    {
        if (!preg_match('/^[a-z0-9][a-z0-9-]{0,60}$/', $slug)) {
            return [null, null, $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404)];
        }
        $app = $this->appService->getAppBySlug($slug);
        if (!$app || $app['status'] !== 'published') {
            return [null, null, $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404)];
        }
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return [null, null, $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401)];
        }
        $appUser = $this->appUserService->getAppUser($app['id'], $userId);
        if (!$appUser || $appUser['status'] !== 'active') {
            return [null, null, $this->jsonResponse($response, ['error' => true, 'message' => 'Not a member of this app'], 403)];
        }
        return [$app, $userId, null];
    }

    // ── Owner: flow definitions ──────────────────────────────────────────────────────────────

    public function listFlows(Request $request, Response $response, array $args): Response
    {
        [$userId] = $this->requireOwner($request, $args['id']);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }
        return $this->jsonResponse($response, ['flows' => $this->flows->listFlows($args['id'])]);
    }

    public function createFlow(Request $request, Response $response, array $args): Response
    {
        [$userId] = $this->requireOwner($request, $args['id']);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }
        try {
            $flow = $this->flows->createFlow($args['id'], $userId, $request->getParsedBody() ?? []);
            return $this->jsonResponse($response, ['flow' => $flow], 201);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function getFlow(Request $request, Response $response, array $args): Response
    {
        [$userId] = $this->requireOwner($request, $args['id']);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }
        $flow = $this->flows->getFlow($args['id'], $args['flowId']);
        if (!$flow) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Flow not found'], 404);
        }
        return $this->jsonResponse($response, ['flow' => $flow]);
    }

    public function updateFlow(Request $request, Response $response, array $args): Response
    {
        [$userId] = $this->requireOwner($request, $args['id']);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }
        try {
            $flow = $this->flows->updateFlow($args['id'], $args['flowId'], $request->getParsedBody() ?? []);
            if (!$flow) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Flow not found'], 404);
            }
            return $this->jsonResponse($response, ['flow' => $flow]);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function deleteFlow(Request $request, Response $response, array $args): Response
    {
        [$userId] = $this->requireOwner($request, $args['id']);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }
        $ok = $this->flows->deleteFlow($args['id'], $args['flowId']);
        if (!$ok) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Flow not found'], 404);
        }
        return $this->jsonResponse($response, ['success' => true]);
    }

    /** Records a 'running' run log with trigger_event 'test'; execution happens client-side. */
    public function testRun(Request $request, Response $response, array $args): Response
    {
        [$userId] = $this->requireOwner($request, $args['id']);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }
        $run = $this->flows->createTestRun($args['id'], $args['flowId']);
        if (!$run) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Flow not found'], 404);
        }
        return $this->jsonResponse($response, ['run' => $run], 201);
    }

    // ── Owner: bindings ──────────────────────────────────────────────────────────────────────

    public function listBindings(Request $request, Response $response, array $args): Response
    {
        [$userId] = $this->requireOwner($request, $args['id']);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }
        return $this->jsonResponse($response, ['bindings' => $this->flows->listBindings($args['id'])]);
    }

    public function createBinding(Request $request, Response $response, array $args): Response
    {
        [$userId] = $this->requireOwner($request, $args['id']);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }
        try {
            $binding = $this->flows->createBinding($args['id'], $request->getParsedBody() ?? []);
            return $this->jsonResponse($response, ['binding' => $binding], 201);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function updateBinding(Request $request, Response $response, array $args): Response
    {
        [$userId] = $this->requireOwner($request, $args['id']);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }
        try {
            $binding = $this->flows->updateBinding($args['id'], $args['bindingId'], $request->getParsedBody() ?? []);
            if (!$binding) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Binding not found'], 404);
            }
            return $this->jsonResponse($response, ['binding' => $binding]);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function deleteBinding(Request $request, Response $response, array $args): Response
    {
        [$userId] = $this->requireOwner($request, $args['id']);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }
        $ok = $this->flows->deleteBinding($args['id'], $args['bindingId']);
        if (!$ok) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Binding not found'], 404);
        }
        return $this->jsonResponse($response, ['success' => true]);
    }

    // ── Owner: run history ───────────────────────────────────────────────────────────────────

    public function listRuns(Request $request, Response $response, array $args): Response
    {
        [$userId] = $this->requireOwner($request, $args['id']);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }
        $q = $request->getQueryParams();
        $result = $this->flows->listRuns(
            $args['id'],
            [
                'flowId' => isset($q['flowId']) ? (string) $q['flowId'] : null,
                'bindingId' => isset($q['bindingId']) ? (string) $q['bindingId'] : null,
                'status' => isset($q['status']) ? (string) $q['status'] : null,
            ],
            (int) ($q['page'] ?? 1),
            (int) ($q['limit'] ?? 50)
        );
        return $this->jsonResponse($response, $result);
    }

    // ── Workspace flows (owner-scoped, app-independent — /api/flows) ────────────────────────

    public function listWorkspaceFlows(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        return $this->jsonResponse($response, ['flows' => $this->flows->listWorkspaceFlows($userId)]);
    }

    public function createWorkspaceFlow(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        try {
            $flow = $this->flows->createWorkspaceFlow($userId, $request->getParsedBody() ?? []);
            return $this->jsonResponse($response, ['flow' => $flow], 201);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function getWorkspaceFlow(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $flow = $this->flows->getWorkspaceFlow($userId, (string) ($args['flowId'] ?? ''));
        if (!$flow) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Flow not found'], 404);
        }
        return $this->jsonResponse($response, ['flow' => $flow]);
    }

    public function updateWorkspaceFlow(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        try {
            $flow = $this->flows->updateWorkspaceFlow($userId, (string) ($args['flowId'] ?? ''), $request->getParsedBody() ?? []);
            if (!$flow) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Flow not found'], 404);
            }
            return $this->jsonResponse($response, ['flow' => $flow]);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function deleteWorkspaceFlow(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $ok = $this->flows->deleteWorkspaceFlow($userId, (string) ($args['flowId'] ?? ''));
        if (!$ok) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Flow not found'], 404);
        }
        return $this->jsonResponse($response, ['success' => true]);
    }

    public function listFlowBindingsForFlow(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $bindings = $this->flows->listBindingsForFlow($userId, (string) ($args['flowId'] ?? ''));
        if ($bindings === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Flow not found'], 404);
        }
        return $this->jsonResponse($response, ['bindings' => $bindings]);
    }

    // ── Owner-wide reads (session AND /api/v1 API-key routes) ──────────────────────────────

    /** Every flow the user owns; ?appId= narrows to one app, ?workspace=1 to workspace-only. */
    public function listOwnerFlows(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $q = $request->getQueryParams();
        $flows = $this->flows->listOwnerFlows(
            $userId,
            isset($q['appId']) ? (string) $q['appId'] : null,
            !empty($q['workspace'])
        );
        return $this->jsonResponse($response, ['flows' => $flows]);
    }

    /** Every binding whose flow the user owns; ?formId= narrows to one form. */
    public function listOwnerBindings(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $q = $request->getQueryParams();
        $bindings = $this->flows->listOwnerBindings($userId, isset($q['formId']) ? (string) $q['formId'] : null);
        return $this->jsonResponse($response, ['bindings' => $bindings]);
    }

    // ── Owner run history + queue (across every flow the user owns — /api/flow-runs) ────────

    public function listOwnerRuns(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $q = $request->getQueryParams();
        $result = $this->flows->listOwnerRuns(
            $userId,
            [
                'flowId' => isset($q['flowId']) ? (string) $q['flowId'] : null,
                'status' => isset($q['status']) ? (string) $q['status'] : null,
                'appId' => isset($q['appId']) ? (string) $q['appId'] : null,
            ],
            (int) ($q['page'] ?? 1),
            (int) ($q['limit'] ?? 50),
            isset($q['offset']) ? (int) $q['offset'] : null
        );
        return $this->jsonResponse($response, $result);
    }

    public function listOwnerQueuedRuns(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $q = $request->getQueryParams();
        return $this->jsonResponse($response, ['runs' => $this->flows->listOwnerQueuedRuns($userId, (int) ($q['limit'] ?? 50))]);
    }

    /**
     * Owner-scoped reserve (POST /api/v1/flow-runs — the surface FormLogic Desktop uses over an
     * API key). 201 {run, created:true} | 200 {run, created:false, idempotent:true} on a replay.
     */
    public function reserveOwnerRun(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        try {
            $result = $this->flows->reserveOwnerRun($userId, $request->getParsedBody() ?? []);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
        if ($result['created']) {
            return $this->jsonResponse($response, ['run' => $result['run'], 'created' => true], 201);
        }
        return $this->jsonResponse($response, ['run' => $result['run'], 'created' => false, 'idempotent' => true]);
    }

    /**
     * Owner app custom-logic bundles (GET /api/v1/app-logic[?app=<id|slug>]) — lets FormLogic
     * Desktop apply onConnectorEvent scripts headless. flows:read scoped.
     */
    public function ownerAppLogic(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $q = $request->getQueryParams();
        $selector = isset($q['app']) ? (string) $q['app'] : null;
        return $this->jsonResponse($response, ['apps' => $this->flows->getOwnerAppLogic($userId, $selector)]);
    }

    /**
     * Connector→app assignments (GET /api/v1/connector-assignments — audit INT-004).
     * Returns the owner's explicit assignments plus per-connector candidate apps so
     * runtimes and future UI can route/reject deterministically. flows:read scoped.
     */
    public function listConnectorAssignments(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        return $this->jsonResponse($response, $this->flows->getConnectorAssignments($userId));
    }

    /**
     * Assign a connector to one app / clear the assignment
     * (PUT /api/v1/connector-assignments {connectorId, appId|null}). flows:write scoped.
     */
    public function putConnectorAssignment(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $body = $request->getParsedBody() ?? [];
        $connectorId = (string) ($body['connectorId'] ?? '');
        $appId = array_key_exists('appId', $body) && $body['appId'] !== null ? (string) $body['appId'] : null;
        try {
            $result = $this->flows->setConnectorAssignment($userId, $connectorId, $appId);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
        return $this->jsonResponse($response, $result);
    }

    /** Claim a queued run (queued→running exactly once): 200 {run, claimed:true} | 409 when taken. */
    public function claimOwnerRun(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        try {
            $run = $this->flows->claimOwnerRun($userId, (string) ($args['runId'] ?? ''), $request->getParsedBody() ?? []);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'already_claimed') {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'This run was already claimed'], 409);
            }
            throw $e;
        }
        if (!$run) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Run not found'], 404);
        }
        return $this->jsonResponse($response, ['run' => $run, 'claimed' => true]);
    }

    /** Owner-scoped complete — the workspace/API-key counterpart of the app-runtime PATCH. */
    public function completeOwnerRun(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        try {
            $run = $this->flows->completeOwnerRun($userId, (string) ($args['runId'] ?? ''), $request->getParsedBody() ?? []);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'already_finalized') {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'This run is already finalized'], 409);
            }
            throw $e;
        }
        if (!$run) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Run not found'], 404);
        }
        return $this->jsonResponse($response, ['run' => $run]);
    }

    // ── Form flow-bindings (workspace scope on standalone forms — /api/forms/{id}) ──────────

    /** @return ?string userId when the caller owns the form; null otherwise. */
    private function requireFormOwner(Request $request, string $formId): ?string
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return null;
        }
        $owner = $this->flows->getFormOwner($formId);
        return ($owner !== null && $owner === $userId) ? $userId : null;
    }

    public function listFormBindings(Request $request, Response $response, array $args): Response
    {
        $formId = (string) ($args['id'] ?? '');
        $userId = $this->requireFormOwner($request, $formId);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }
        return $this->jsonResponse($response, ['bindings' => $this->flows->listFormBindings($userId, $formId)]);
    }

    public function createFormBinding(Request $request, Response $response, array $args): Response
    {
        $formId = (string) ($args['id'] ?? '');
        $userId = $this->requireFormOwner($request, $formId);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }
        try {
            $binding = $this->flows->createFormBinding($userId, $formId, $request->getParsedBody() ?? []);
            return $this->jsonResponse($response, ['binding' => $binding], 201);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function updateFormBinding(Request $request, Response $response, array $args): Response
    {
        $formId = (string) ($args['id'] ?? '');
        $userId = $this->requireFormOwner($request, $formId);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }
        try {
            $binding = $this->flows->updateFormBinding($userId, $formId, (string) ($args['bindingId'] ?? ''), $request->getParsedBody() ?? []);
            if (!$binding) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Binding not found'], 404);
            }
            return $this->jsonResponse($response, ['binding' => $binding]);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function deleteFormBinding(Request $request, Response $response, array $args): Response
    {
        $formId = (string) ($args['id'] ?? '');
        $userId = $this->requireFormOwner($request, $formId);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }
        $ok = $this->flows->deleteFormBinding($userId, $formId, (string) ($args['bindingId'] ?? ''));
        if (!$ok) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Binding not found'], 404);
        }
        return $this->jsonResponse($response, ['success' => true]);
    }

    // ── Runtime (member-gated) ──────────────────────────────────────────────────────────────

    /** Enabled flow definitions + bindings for the app runtime (no owner-only fields). */
    public function runtimeFlows(Request $request, Response $response, array $args): Response
    {
        [$app, , $error] = $this->resolveRuntime($request, $response, $args['slug'] ?? '');
        if ($error) {
            return $error;
        }
        return $this->jsonResponse($response, $this->flows->getRuntimeFlows($app['id']));
    }

    /**
     * Reserve a run BEFORE executing it (the UNIQUE idempotency key is the cross-tab dedupe gate):
     * 201 {runId} when this caller won the reservation, 200 {runId, idempotent:true} on a replay.
     */
    public function reserveRun(Request $request, Response $response, array $args): Response
    {
        [$app, $userId, $error] = $this->resolveRuntime($request, $response, $args['slug'] ?? '');
        if ($error) {
            return $error;
        }
        try {
            $result = $this->flows->reserveRun($app['id'], $userId, $request->getParsedBody() ?? []);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
        if ($result['created']) {
            return $this->jsonResponse($response, ['runId' => $result['run']['runId'], 'run' => $result['run']], 201);
        }
        return $this->jsonResponse($response, ['runId' => $result['run']['runId'], 'idempotent' => true, 'run' => $result['run']], 200);
    }

    /** Complete a run (status/result/error per flow-run-result.schema.json); only from running/queued. */
    public function completeRun(Request $request, Response $response, array $args): Response
    {
        [$app, , $error] = $this->resolveRuntime($request, $response, $args['slug'] ?? '');
        if ($error) {
            return $error;
        }
        try {
            $run = $this->flows->completeRun($app['id'], (string) ($args['runId'] ?? ''), $request->getParsedBody() ?? []);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'already_finalized') {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'This run is already finalized'], 409);
            }
            throw $e;
        }
        if (!$run) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Run not found'], 404);
        }
        return $this->jsonResponse($response, ['run' => $run]);
    }

    /** Claimable queued runs for this app (member-gated), oldest first. */
    public function queuedRuns(Request $request, Response $response, array $args): Response
    {
        [$app, , $error] = $this->resolveRuntime($request, $response, $args['slug'] ?? '');
        if ($error) {
            return $error;
        }
        $q = $request->getQueryParams();
        return $this->jsonResponse($response, ['runs' => $this->flows->listQueuedRuns($app['id'], (int) ($q['limit'] ?? 50))]);
    }

    /**
     * Claim a queued run for this app's runtime (queued→running exactly once via the atomic
     * UPDATE): 200 {run, claimed:true} | 409 when another runtime got there first.
     */
    public function claimRun(Request $request, Response $response, array $args): Response
    {
        [$app, , $error] = $this->resolveRuntime($request, $response, $args['slug'] ?? '');
        if ($error) {
            return $error;
        }
        try {
            $run = $this->flows->claimRun($app['id'], (string) ($args['runId'] ?? ''), $request->getParsedBody() ?? []);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'already_claimed') {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'This run was already claimed'], 409);
            }
            throw $e;
        }
        if (!$run) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Run not found'], 404);
        }
        return $this->jsonResponse($response, ['run' => $run, 'claimed' => true]);
    }

    // ── Desktop connections (per-user registry) ─────────────────────────────────────────────

    public function listDesktopConnections(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        return $this->jsonResponse($response, ['connections' => $this->flows->listDesktopConnections($userId)]);
    }

    /** Upsert on desktop_instance_id (per user): re-pairing the same install refreshes it. */
    public function upsertDesktopConnection(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        try {
            $connection = $this->flows->upsertDesktopConnection($userId, $request->getParsedBody() ?? []);
            return $this->jsonResponse($response, ['connection' => $connection], 201);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function deleteDesktopConnection(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        // Revoking an OAuth-linked connection revokes the scoped flk_ key it was minted with, so the
        // desktop install is fully cut off. Read the row first (for the key id), then delete.
        $connectionId = (string) ($args['id'] ?? '');
        $connection = $this->flows->getDesktopConnection($connectionId, $userId);
        $ok = $this->flows->deleteDesktopConnection($connectionId, $userId);
        if (!$ok) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Connection not found'], 404);
        }
        $apiKeyId = $connection['apiKeyId'] ?? null;
        if ($apiKeyId !== null && $this->apiKeys !== null) {
            try {
                $this->apiKeys->revokeKey((string) $apiKeyId, $userId);
            } catch (\Throwable) { /* best-effort: the connection is already gone */ }
        }
        return $this->jsonResponse($response, ['success' => true]);
    }

    /**
     * Desktop self-unlink over /api/v1 (API-key auth). FormLogic Desktop holds only its scoped flk_
     * key, so it can't reach the session-auth delete above; this lets it cut itself off server-side
     * when the user clicks Unlink. The calling key identifies exactly one install, so it removes only
     * its OWN connection row (never a sibling's) and, when it does, revokes that key so the install is
     * fully cut off. A key with no connection row (e.g. a hand-entered one via Advanced) matches
     * nothing and is left untouched — not ours to revoke. Idempotent: once the key is revoked a repeat
     * call 401s at the middleware.
     */
    public function deleteOwnDesktopConnection(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $apiKeyId = (string) ($request->getAttribute('apiKeyId') ?? '');
        if (!$userId || $apiKeyId === '') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $connectionRemoved = $this->flows->deleteDesktopConnectionForKey($userId, $apiKeyId);
        if ($connectionRemoved && $this->apiKeys !== null) {
            try {
                $this->apiKeys->revokeKey($apiKeyId, $userId);
            } catch (\Throwable) { /* best-effort: local key clears regardless */ }
        }
        return $this->jsonResponse($response, ['success' => true, 'connectionRemoved' => $connectionRemoved]);
    }
}
