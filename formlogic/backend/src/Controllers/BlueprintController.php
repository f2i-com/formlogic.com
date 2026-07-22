<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
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

    public function __construct(private BlueprintService $blueprints)
    {
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
