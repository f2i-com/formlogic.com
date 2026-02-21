<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\PackService;
use FormLogic\Services\AuditService;
use FormLogic\Helpers\IpResolver;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class PackController
{
    private PackService $packService;
    private ?AuditService $auditService;
    private IpResolver $ipResolver;

    public function __construct(PackService $packService, ?AuditService $auditService = null)
    {
        $this->packService = $packService;
        $this->auditService = $auditService;
        $this->ipResolver = IpResolver::fromEnvironment();
    }

    /**
     * POST /api/packs/import
     * Import a pack (forms + apps) from JSON data
     */
    public function import(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $body = $request->getParsedBody();
        $packData = $body['pack'] ?? null;

        if (!$packData || !is_array($packData)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Pack data is required'], 400);
        }

        try {
            $result = $this->packService->importPack($packData, $userId);

            // Audit the import
            if ($this->auditService) {
                $this->auditService->log(
                    'pack.import',
                    'pack',
                    $packData['packMeta']['name'] ?? 'unknown',
                    $userId,
                    $this->ipResolver->getClientIp($request),
                    [
                        'packName' => $packData['packMeta']['name'] ?? null,
                        'formsCreated' => count($result['forms']),
                        'appsCreated' => count($result['apps']),
                    ]
                );
            }

            return $this->jsonResponse($response, [
                'success' => true,
                'message' => sprintf(
                    'Imported %d form(s) and %d app(s)',
                    count($result['forms']),
                    count($result['apps'])
                ),
                'forms' => $result['forms'],
                'apps' => $result['apps'],
            ], 201);

        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to import pack'], 500);
        }
    }

    private function jsonResponse(Response $response, array $data, int $status = 200): Response
    {
        $response->getBody()->write(json_encode($data));
        return $response
            ->withStatus($status)
            ->withHeader('Content-Type', 'application/json');
    }
}
