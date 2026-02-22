<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\ApiKeyService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class ApiKeyController
{
    private ApiKeyService $apiKeyService;

    public function __construct(ApiKeyService $apiKeyService)
    {
        $this->apiKeyService = $apiKeyService;
    }

    /**
     * List all API keys for the authenticated user.
     * GET /api/api-keys
     */
    public function index(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $keys = $this->apiKeyService->listKeys($userId);
        return $this->jsonResponse($response, ['keys' => $keys]);
    }

    /**
     * Create a new API key.
     * POST /api/api-keys
     */
    public function create(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $data = $request->getParsedBody();

        $name = $data['name'] ?? '';
        $scopes = $data['scopes'] ?? [];
        $formIds = $data['formIds'] ?? null;
        $expiresAt = $data['expiresAt'] ?? null;

        if (!is_array($scopes)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Scopes must be an array',
            ], 400);
        }

        try {
            $key = $this->apiKeyService->createKey($userId, $name, $scopes, $formIds, $expiresAt);
            return $this->jsonResponse($response, ['key' => $key], 201);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => $e->getMessage(),
            ], 400);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => $e->getMessage(),
            ], 400);
        }
    }

    /**
     * Revoke an API key.
     * DELETE /api/api-keys/{id}
     */
    public function revoke(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        $keyId = $args['id'];

        $revoked = $this->apiKeyService->revokeKey($keyId, $userId);

        if (!$revoked) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'API key not found',
            ], 404);
        }

        return $this->jsonResponse($response, ['success' => true, 'message' => 'API key revoked']);
    }

    private function jsonResponse(Response $response, array $data, int $status = 200): Response
    {
        $response->getBody()->write(json_encode($data));
        return $response
            ->withStatus($status)
            ->withHeader('Content-Type', 'application/json');
    }
}
