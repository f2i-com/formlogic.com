<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\PackService;
use FormLogic\Services\AuditService;
use FormLogic\Services\PlanService;
use FormLogic\Helpers\IpResolver;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class PackController
{
    use JsonResponseTrait;

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
     * GET /api/apps/{id}/export
     * Export a whole app (forms + screens + scripts + roles) as a self-contained pack JSON.
     */
    public function exportApp(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $appId = $args['id'] ?? '';
        if (!$appId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App ID is required'], 400);
        }

        try {
            $pack = $this->packService->exportApp($appId, $userId);

            if ($this->auditService) {
                $this->auditService->log(
                    'app.export',
                    'app',
                    $appId,
                    $userId,
                    $this->ipResolver->getClientIp($request),
                    [
                        'appName' => $pack['packMeta']['name'] ?? null,
                        'formCount' => count($pack['forms'] ?? []),
                    ]
                );
            }

            return $this->jsonResponse($response, ['pack' => $pack]);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to export app'], 500);
        }
    }

    /** Directory of bundled sample-app packs (also CI-validated by PackFixturesTest). */
    private function sampleDir(): string
    {
        return dirname(__DIR__, 2) . '/resources/sample-apps';
    }

    /**
     * GET /api/sample-apps
     * List the bundled sample apps (the "Try a sample app" gallery). Public metadata only.
     */
    public function listSampleApps(Request $request, Response $response): Response
    {
        $out = [];
        foreach (glob($this->sampleDir() . '/*.json') ?: [] as $file) {
            $pack = json_decode((string) file_get_contents($file), true);
            if (!is_array($pack)) {
                continue;
            }
            $app = $pack['apps'][0] ?? [];
            $out[] = [
                'id' => basename($file, '.json'),
                'name' => $pack['packMeta']['name'] ?? ($app['name'] ?? 'Sample'),
                'description' => $pack['packMeta']['description'] ?? ($app['description'] ?? ''),
                'formCount' => count($pack['forms'] ?? []),
            ];
        }
        return $this->jsonResponse($response, ['samples' => $out]);
    }

    /**
     * POST /api/sample-apps/{id}/install
     * Import a bundled sample app into the current account (a fresh copy).
     */
    public function installSampleApp(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        // Sanitize the id to a bare filename — never let it escape the sample dir.
        $id = preg_replace('/[^a-z0-9._-]/i', '', (string) ($args['id'] ?? ''));
        $file = $this->sampleDir() . '/' . $id . '.json';
        if ($id === '' || !is_file($file)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Sample app not found'], 404);
        }
        $pack = json_decode((string) file_get_contents($file), true);
        if (!is_array($pack)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Sample app is invalid'], 500);
        }
        $incoming = is_array($pack['forms'] ?? null) ? count($pack['forms']) : 0;
        if ($incoming > 0 && $this->planService && !$this->planService->canCreateForms($userId, $incoming)) {
            return $this->jsonResponse($response, ['error' => true, 'code' => 'form_limit', 'message' => 'This sample would exceed your plan\'s form limit. Free up space or upgrade first.'], 402);
        }
        try {
            $result = $this->packService->importPack($pack, $userId);
            // Samples are "try it now" — publish the imported app(s) so they open running immediately.
            foreach ($result['apps'] as $a) {
                $this->packService->publishApp($a['id'], $userId);
            }
            if ($this->auditService) {
                $this->auditService->log('sample.install', 'pack', $id, $userId, $this->ipResolver->getClientIp($request), ['appsCreated' => count($result['apps'])]);
            }
            return $this->jsonResponse($response, ['success' => true, 'apps' => $result['apps'], 'forms' => $result['forms']], 201);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to install the sample'], 500);
        }
    }

    /**
     * GET /api/apps/{id}/export/download
     * Same as export, but streams the pack as a downloadable .formlogic-app.json attachment (for API users).
     */
    public function exportAppDownload(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $appId = $args['id'] ?? '';
        if (!$appId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App ID is required'], 400);
        }
        try {
            $pack = $this->packService->exportApp($appId, $userId);
            $slug = preg_replace('/[^a-z0-9-]/', '', strtolower((string) ($pack['apps'][0]['packAppId'] ?? 'app')));
            $slug = $slug !== '' ? $slug : 'app';
            if ($this->auditService) {
                $this->auditService->log('app.export', 'app', $appId, $userId, $this->ipResolver->getClientIp($request), ['appName' => $pack['packMeta']['name'] ?? null, 'download' => true]);
            }
            $response->getBody()->write((string) json_encode($pack, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
            return $response
                ->withHeader('Content-Type', 'application/json')
                ->withHeader('Content-Disposition', 'attachment; filename="' . $slug . '.formlogic-app.json"');
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to export app'], 500);
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
}
