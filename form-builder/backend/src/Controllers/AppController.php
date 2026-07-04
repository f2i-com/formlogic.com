<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\AppService;
use FormLogic\Services\AppReportService;
use FormLogic\Services\AuditService;
use FormLogic\Helpers\IpResolver;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

class AppController
{
    use JsonResponseTrait;

    private AppService $appService;
    private LoggerInterface $logger;
    private ?AuditService $auditService;
    private ?AppReportService $reportValidator;

    public function __construct(AppService $appService, ?LoggerInterface $logger = null, ?AuditService $auditService = null, ?AppReportService $reportValidator = null)
    {
        $this->appService = $appService;
        $this->logger = $logger ?? new NullLogger();
        $this->auditService = $auditService;
        $this->reportValidator = $reportValidator;
    }

    private function authorizeAppOwnership(Request $request, string $appId): ?array
    {
        $app = $this->appService->getApp($appId);
        if (!$app) {
            return null;
        }

        $userId = $request->getAttribute('userId');
        if (!$userId || $app['ownerId'] !== $userId) {
            return null;
        }

        return $app;
    }

    /**
     * Authorize access for owner OR member (for read-only endpoints like show)
     */
    private function authorizeAppAccess(Request $request, string $appId): ?array
    {
        $app = $this->appService->getApp($appId);
        if (!$app) {
            return null;
        }

        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return null;
        }

        // Allow if owner
        if ($app['ownerId'] === $userId) {
            return $app;
        }

        // Allow if app member
        if ($this->appService->isAppMember($appId, $userId)) {
            return $app;
        }

        return null;
    }

    public function index(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $apps = $this->appService->getAllApps($userId);
        // Don't expose the owner's platform UUID to non-owner members (mirrors the
        // runtime AppPublicController::getApp stripping).
        foreach ($apps as &$a) {
            if (is_array($a) && ($a['ownerId'] ?? null) !== $userId) {
                unset($a['ownerId']);
            }
        }
        unset($a);
        return $this->jsonResponse($response, ['apps' => $apps, 'count' => count($apps)]);
    }

    public function create(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $data = $request->getParsedBody();
        if (empty($data['name'])) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App name is required'], 400);
        }

        try {
            $app = $this->appService->createApp($data, $userId);
            $this->audit($request, 'app.create', 'app', $app['id'] ?? '');
            return $this->jsonResponse($response, ['app' => $app], 201);
        } catch (\RuntimeException | \InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            $this->logger->error('App creation error', ['exception' => $e->getMessage()]);
            return $this->jsonResponse($response, ['error' => true, 'message' => 'An unexpected error occurred'], 500);
        }
    }

    public function show(Request $request, Response $response, array $args): Response
    {
        $app = $this->authorizeAppAccess($request, $args['id']);
        if (!$app) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }

        // Don't expose the owner's platform UUID to non-owner members (mirrors the
        // runtime AppPublicController::getApp stripping).
        $userId = $request->getAttribute('userId');
        if (($app['ownerId'] ?? null) !== $userId) {
            unset($app['ownerId']);
        }

        return $this->jsonResponse($response, ['app' => $app]);
    }

    public function update(Request $request, Response $response, array $args): Response
    {
        $app = $this->authorizeAppOwnership($request, $args['id']);
        if (!$app) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }

        $data = $request->getParsedBody() ?? [];

        // If the name is being changed, it must be non-blank (mirrors create + the
        // client-side guard) so an app can't be saved with an empty title.
        if (array_key_exists('name', $data) && trim((string)($data['name'] ?? '')) === '') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App name is required'], 400);
        }

        if (isset($data['customScreen'])) {
            if (!is_array($data['customScreen'])) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Custom home must be an object'], 400);
            }
            // A widget dashboard is data, not code — sanitize its specs against this app so no widget can
            // query a form/field outside it (the same save boundary as reports).
            if (($data['customScreen']['kind'] ?? '') === 'dashboard' && is_array($data['customScreen']['dashboard'] ?? null) && $this->reportValidator !== null) {
                $data['customScreen']['dashboard'] = $this->reportValidator->sanitizeDashboardForApp($data['customScreen']['dashboard'], $args['id']);
            }
            $screenJson = json_encode($data['customScreen']);
            if ($screenJson !== false && strlen($screenJson) > 524288) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Custom home must be 512KB or smaller'], 400);
            }
        }

        if (isset($data['reports'])) {
            if (!is_array($data['reports'])) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Reports must be an array'], 400);
            }
            $reportsJson = json_encode($data['reports']);
            if ($reportsJson !== false && strlen($reportsJson) > 262144) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Reports data is too large'], 400);
            }
            // Sanitize against this app: drop reports/joins/field-refs that point outside the app or at
            // non-existent fields, and documents whose blocks reference a missing chart.
            if ($this->reportValidator !== null) {
                $data['reports'] = $this->reportValidator->sanitizeReports($data['reports'], $args['id']);
            }
        }

        try {
            $updatedApp = $this->appService->updateApp($args['id'], $data);
            $this->audit($request, 'app.update', 'app', $args['id']);
            return $this->jsonResponse($response, ['app' => $updatedApp]);
        } catch (\RuntimeException | \InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            $this->logger->error('App update error', ['exception' => $e->getMessage()]);
            return $this->jsonResponse($response, ['error' => true, 'message' => 'An unexpected error occurred'], 500);
        }
    }

    public function delete(Request $request, Response $response, array $args): Response
    {
        if ($blocked = $this->blockIfDemo($request, $response, 'This is a shared live demo — apps can\'t be deleted here.')) {
            return $blocked;
        }
        $app = $this->authorizeAppOwnership($request, $args['id']);
        if (!$app) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }

        try {
            $this->appService->deleteApp($args['id']);
            $this->audit($request, 'app.delete', 'app', $args['id']);
            return $this->jsonResponse($response, ['success' => true, 'message' => 'App deleted successfully']);
        } catch (\Exception $e) {
            $this->logger->error('App delete error', ['exception' => $e->getMessage()]);
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to delete app'], 500);
        }
    }

    // Form management

    public function listForms(Request $request, Response $response, array $args): Response
    {
        $app = $this->authorizeAppOwnership($request, $args['id']);
        if (!$app) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }

        $forms = $this->appService->getAppForms($args['id']);
        return $this->jsonResponse($response, ['forms' => $forms]);
    }

    public function addForm(Request $request, Response $response, array $args): Response
    {
        $app = $this->authorizeAppOwnership($request, $args['id']);
        if (!$app) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }

        $data = $request->getParsedBody();
        if (empty($data['formId'])) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form ID is required'], 400);
        }

        $userId = $request->getAttribute('userId');
        if (!$this->appService->isFormOwnedByUser($data['formId'], $userId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }

        try {
            $forms = $this->appService->addFormToApp($args['id'], $data['formId'], $data['displayName'] ?? null);
            return $this->jsonResponse($response, ['forms' => $forms], 201);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function updateForm(Request $request, Response $response, array $args): Response
    {
        $app = $this->authorizeAppOwnership($request, $args['id']);
        if (!$app) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }

        $data = $request->getParsedBody() ?? [];

        try {
            $this->appService->updateAppForm($args['id'], $args['formId'], $data);
            $forms = $this->appService->getAppForms($args['id']);
            return $this->jsonResponse($response, ['forms' => $forms]);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function removeForm(Request $request, Response $response, array $args): Response
    {
        if ($blocked = $this->blockIfDemo($request, $response, 'This is a shared live demo — forms can\'t be removed here.')) {
            return $blocked;
        }
        $app = $this->authorizeAppOwnership($request, $args['id']);
        if (!$app) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }

        $this->appService->removeFormFromApp($args['id'], $args['formId']);
        return $this->jsonResponse($response, ['success' => true, 'message' => 'Form removed from app']);
    }

    public function reorderForms(Request $request, Response $response, array $args): Response
    {
        $app = $this->authorizeAppOwnership($request, $args['id']);
        if (!$app) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }

        $data = $request->getParsedBody();
        if (empty($data['formIds']) || !is_array($data['formIds'])) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'formIds array is required'], 400);
        }

        $this->appService->reorderAppForms($args['id'], $data['formIds']);
        $forms = $this->appService->getAppForms($args['id']);
        return $this->jsonResponse($response, ['forms' => $forms]);
    }

    private function audit(Request $request, string $action, string $resourceType, string $resourceId, array $details = []): void
    {
        if ($this->auditService === null) return;
        $userId = $request->getAttribute('userId');
        $ip = IpResolver::fromEnvironment()->getClientIp($request);
        $this->auditService->log($action, $resourceType, $resourceId, $userId, $ip, $details);
    }
}
