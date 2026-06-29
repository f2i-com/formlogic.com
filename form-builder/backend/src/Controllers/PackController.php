<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\PackService;
use FormLogic\Services\AuditService;
use FormLogic\Services\PlanService;
use FormLogic\Helpers\IpResolver;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class PackController
{
    private PackService $packService;
    private ?AuditService $auditService;
    private ?PlanService $planService;
    private IpResolver $ipResolver;

    public function __construct(PackService $packService, ?AuditService $auditService = null, ?PlanService $planService = null)
    {
        $this->packService = $packService;
        $this->auditService = $auditService;
        $this->planService = $planService;
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
        // catalogId/versionId come from the trusted download endpoint so the
        // installation is linked to its marketplace entry (drives "Installed"
        // state and update checks).
        $catalogId = isset($body['catalogId']) && is_string($body['catalogId']) ? $body['catalogId'] : null;
        $versionId = isset($body['versionId']) && is_string($body['versionId']) ? $body['versionId'] : null;

        if (!$packData || !is_array($packData)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Pack data is required'], 400);
        }

        // Enforce the form-count quota for the whole pack up front.
        $incomingForms = is_array($packData['forms'] ?? null) ? count($packData['forms']) : 0;
        if ($incomingForms > 0 && $this->planService && !$this->planService->canCreateForms($userId, $incomingForms)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'form_limit',
                'message' => 'This pack would exceed your plan\'s form limit (' . $this->planService->formLimit($userId) . '). Free up space or upgrade first.',
            ], 402);
        }

        try {
            $result = $this->packService->importPack($packData, $userId, $catalogId, $versionId);

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
                        'installationId' => $result['installationId'],
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
                'installationId' => $result['installationId'],
                'forms' => $result['forms'],
                'apps' => $result['apps'],
            ], 201);

        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to import pack'], 500);
        }
    }

    /**
     * POST /api/packs/adopt
     * Retroactively register an existing pack installation by matching form titles
     */
    public function adopt(Request $request, Response $response): Response
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
            $result = $this->packService->adoptExistingPack($packData, $userId);

            if ($this->auditService) {
                $this->auditService->log(
                    'pack.adopt',
                    'pack',
                    $packData['packMeta']['name'] ?? 'unknown',
                    $userId,
                    $this->ipResolver->getClientIp($request),
                    [
                        'packName' => $packData['packMeta']['name'] ?? null,
                        'installationId' => $result['installationId'],
                        'formsMatched' => $result['formsMatched'],
                        'appsMatched' => $result['appsMatched'],
                    ]
                );
            }

            return $this->jsonResponse($response, [
                'success' => true,
                'installationId' => $result['installationId'],
                'formsMatched' => $result['formsMatched'],
                'appsMatched' => $result['appsMatched'],
            ]);

        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to adopt pack'], 500);
        }
    }

    /**
     * GET /api/packs/installed
     * List all installed packs for the authenticated user
     */
    public function listInstalled(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        try {
            $installations = $this->packService->getInstalledPacks($userId);
            return $this->jsonResponse($response, ['installations' => $installations]);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to fetch installations'], 500);
        }
    }

    /**
     * DELETE /api/packs/{installationId}
     * Uninstall a pack — deletes all forms and apps it created
     */
    public function uninstall(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $installationId = $args['installationId'] ?? '';
        if (!$installationId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Installation ID is required'], 400);
        }

        try {
            $result = $this->packService->uninstallPack($installationId, $userId);

            // Audit the uninstall
            if ($this->auditService) {
                $this->auditService->log(
                    'pack.uninstall',
                    'pack',
                    $installationId,
                    $userId,
                    $this->ipResolver->getClientIp($request),
                    [
                        'formsDeleted' => $result['formsDeleted'],
                        'appsDeleted' => $result['appsDeleted'],
                    ]
                );
            }

            return $this->jsonResponse($response, [
                'success' => true,
                'message' => sprintf(
                    'Uninstalled: %d form(s) and %d app(s) removed',
                    $result['formsDeleted'],
                    $result['appsDeleted']
                ),
                'formsDeleted' => $result['formsDeleted'],
                'appsDeleted' => $result['appsDeleted'],
            ]);

        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 404);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to uninstall pack'], 500);
        }
    }

    private function jsonResponse(Response $response, array $data, int $status = 200): Response
    {
        $json = json_encode($data);
        if ($json === false) {
            $json = json_encode(['error' => true, 'message' => 'Internal server error']);
            $status = 500;
        }
        $response->getBody()->write($json);
        return $response
            ->withStatus($status)
            ->withHeader('Content-Type', 'application/json');
    }
}
