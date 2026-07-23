<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\BlueprintMaterializeService;
use FormLogic\Services\BlueprintRevisionConflictException;
use FormLogic\Services\BlueprintService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Blueprints (extensible-flows plan §11/§14, Phase 6): owner-scoped CRUD + the
 * operation-batch commit gateway. Session auth like /api/flows; every mutation of the
 * diagram goes through commitOperations — there is deliberately no direct element PUT.
 */
class BlueprintController
{
    use JsonResponseTrait;

    public function __construct(
        private BlueprintService $blueprints,
        private ?BlueprintMaterializeService $materializer = null,
    ) {
    }

    public function list(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        return $this->jsonResponse($response, ['blueprints' => $this->blueprints->listBlueprints((string) $userId)]);
    }

    public function create(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        try {
            $blueprint = $this->blueprints->createBlueprint((string) $userId, (array) ($request->getParsedBody() ?? []));
            return $this->jsonResponse($response, ['blueprint' => $blueprint], 201);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function get(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $blueprint = $this->blueprints->getBlueprint((string) $userId, (string) ($args['blueprintId'] ?? ''));
        if ($blueprint === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Blueprint not found'], 404);
        }
        return $this->jsonResponse($response, ['blueprint' => $blueprint]);
    }

    public function rename(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $body = (array) ($request->getParsedBody() ?? []);
        try {
            $blueprint = $this->blueprints->renameBlueprint(
                (string) $userId,
                (string) ($args['blueprintId'] ?? ''),
                is_string($body['name'] ?? null) ? $body['name'] : ''
            );
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
        if ($blueprint === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Blueprint not found'], 404);
        }
        return $this->jsonResponse($response, ['blueprint' => $blueprint]);
    }

    public function delete(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        if (!$this->blueprints->deleteBlueprint((string) $userId, (string) ($args['blueprintId'] ?? ''))) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Blueprint not found'], 404);
        }
        return $this->jsonResponse($response, ['deleted' => true]);
    }

    /** §11B O3: the Build Timeline — the audited operation log grouped by change set. */
    public function history(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $limit = (int) ($request->getQueryParams()['limit'] ?? 30);
        return $this->jsonResponse($response, [
            'history' => $this->blueprints->listHistory((string) $userId, (string) ($args['blueprintId'] ?? ''), $limit),
        ]);
    }

    /** §14 undo: apply the newest change set's stored inverses as a new audited batch. */
    public function undo(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        try {
            return $this->jsonResponse(
                $response,
                $this->blueprints->undoLastChangeSet((string) $userId, (string) ($args['blueprintId'] ?? ''))
            );
        } catch (BlueprintRevisionConflictException $e) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'revision_conflict',
                'message' => 'The blueprint changed — reload and retry',
                'currentSemanticRevision' => $e->currentRevision,
            ], 409);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    /** §12: park a validated batch for approval (the canvas ghost layer reads it). */
    public function proposeChangeSet(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        try {
            $result = $this->blueprints->proposeChangeSet(
                (string) $userId,
                (string) ($args['blueprintId'] ?? ''),
                (array) ($request->getParsedBody() ?? [])
            );
            return $this->jsonResponse($response, $result, 201);
        } catch (BlueprintRevisionConflictException $e) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'revision_conflict',
                'message' => 'The blueprint changed since you loaded it — reload and retry',
                'currentSemanticRevision' => $e->currentRevision,
            ], 409);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function listChangeSets(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        return $this->jsonResponse($response, [
            'changeSets' => $this->blueprints->listProposedChangeSets((string) $userId, (string) ($args['blueprintId'] ?? '')),
        ]);
    }

    public function approveChangeSet(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        try {
            $result = $this->blueprints->approveChangeSet(
                (string) $userId,
                (string) ($args['blueprintId'] ?? ''),
                (string) ($args['changeSetId'] ?? '')
            );
            return $this->jsonResponse($response, $result);
        } catch (BlueprintRevisionConflictException $e) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'revision_conflict',
                'message' => 'The blueprint changed since this was proposed — ask for a fresh proposal',
                'currentSemanticRevision' => $e->currentRevision,
            ], 409);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function discardChangeSet(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        try {
            $this->blueprints->discardChangeSet(
                (string) $userId,
                (string) ($args['blueprintId'] ?? ''),
                (string) ($args['changeSetId'] ?? '')
            );
            return $this->jsonResponse($response, ['discarded' => true]);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    /** POST /api/blueprints/{id}/materialize — §11A D3: create the app from the diagram. */
    public function materialize(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        if ($this->materializer === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Materialisation unavailable'], 503);
        }
        try {
            $result = $this->materializer->materialize((string) $userId, (string) ($args['blueprintId'] ?? ''));
            return $this->jsonResponse($response, $result, 201);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function validateOperations(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        try {
            $result = $this->blueprints->validateOperations(
                (string) $userId,
                (string) ($args['blueprintId'] ?? ''),
                (array) ($request->getParsedBody() ?? [])
            );
            return $this->jsonResponse($response, $result);
        } catch (BlueprintRevisionConflictException $e) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'revision_conflict',
                'message' => 'The blueprint changed since you loaded it — reload and retry',
                'currentSemanticRevision' => $e->currentRevision,
            ], 409);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'valid' => false, 'message' => $e->getMessage()], 400);
        }
    }

    public function commitOperations(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        try {
            $result = $this->blueprints->commitOperations(
                (string) $userId,
                (string) ($args['blueprintId'] ?? ''),
                (array) ($request->getParsedBody() ?? [])
            );
            return $this->jsonResponse($response, $result);
        } catch (BlueprintRevisionConflictException $e) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'revision_conflict',
                'message' => 'The blueprint changed since you loaded it — reload and retry',
                'currentSemanticRevision' => $e->currentRevision,
            ], 409);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }
}
