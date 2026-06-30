<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\ApiKeyService;
use FormLogic\Services\AuditService;
use FormLogic\Services\FormService;
use FormLogic\Helpers\IpResolver;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class ApiKeyController
{
    use JsonResponseTrait;

    private ApiKeyService $apiKeyService;
    private FormService $formService;
    private ?AuditService $auditService;
    private IpResolver $ipResolver;

    public function __construct(ApiKeyService $apiKeyService, FormService $formService, ?AuditService $auditService = null)
    {
        $this->apiKeyService = $apiKeyService;
        $this->formService = $formService;
        $this->auditService = $auditService;
        $this->ipResolver = IpResolver::fromEnvironment();
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

        // Validate that formIds belong to the current user
        if (is_array($formIds) && !empty($formIds)) {
            foreach ($formIds as $fid) {
                if (!is_string($fid)) continue;
                $form = $this->formService->getForm($fid);
                if (!$form || $form['userId'] !== $userId) {
                    return $this->jsonResponse($response, [
                        'error' => true,
                        'message' => "Form not found or not owned by you: $fid",
                    ], 400);
                }
            }
        }

        try {
            $key = $this->apiKeyService->createKey($userId, $name, $scopes, $formIds, $expiresAt);
            $this->audit($request, 'apikey.create', 'api_key', $key['id'], [
                'name' => $name,
                'scopes' => $scopes,
            ]);
            return $this->jsonResponse($response, ['key' => $key], 201);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => $e->getMessage(),
            ], 400);
        } catch (\PDOException $e) {
            // Don't echo raw driver/SQL detail (PDOException extends RuntimeException,
            // so it must be caught before the RuntimeException branch below).
            error_log('API key creation failed (DB): ' . $e->getMessage());
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Failed to create API key',
            ], 500);
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

        $this->audit($request, 'apikey.revoke', 'api_key', $keyId);
        return $this->jsonResponse($response, ['success' => true, 'message' => 'API key revoked']);
    }

    private function audit(Request $request, string $action, string $resourceType, ?string $resourceId, array $details = []): void
    {
        if ($this->auditService === null) return;
        $ip = $this->ipResolver->getClientIp($request);
        $this->auditService->log($action, $resourceType, $resourceId, $request->getAttribute('userId'), $ip, $details);
    }
}
