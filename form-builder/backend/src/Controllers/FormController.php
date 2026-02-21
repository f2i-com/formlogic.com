<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\FormService;
use FormLogic\Services\FormVersionService;
use FormLogic\Services\AuditService;
use FormLogic\Helpers\IpResolver;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

class FormController
{
    private FormService $formService;
    private LoggerInterface $logger;
    private ?FormVersionService $versionService;
    private ?AuditService $auditService;

    public function __construct(
        FormService $formService,
        ?LoggerInterface $logger = null,
        ?FormVersionService $versionService = null,
        ?AuditService $auditService = null
    ) {
        $this->formService = $formService;
        $this->logger = $logger ?? new NullLogger();
        $this->versionService = $versionService;
        $this->auditService = $auditService;
    }

    /**
     * Check if the current user owns the form
     * Returns the form if authorized, null otherwise
     */
    private function authorizeFormAccess(Request $request, string $formId): ?array
    {
        $form = $this->formService->getForm($formId);
        if (!$form) {
            return null;
        }

        $userId = $request->getAttribute('userId');

        // If no user is authenticated, deny access
        if (!$userId) {
            return null;
        }

        // Check ownership
        if ($form['userId'] !== $userId) {
            return null;
        }

        return $form;
    }

    /**
     * List all forms
     * GET /api/forms
     */
    public function index(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');

        // Require authentication for listing forms
        if (!$userId) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Authentication required',
            ], 401);
        }

        $queryParams = $request->getQueryParams();

        $limit = max(1, min((int)($queryParams['limit'] ?? 50), 1000));

        $options = [
            'status' => $queryParams['status'] ?? null,
            'limit' => $limit,
            'offset' => max(0, (int)($queryParams['offset'] ?? 0)),
            'cursor' => $queryParams['cursor'] ?? null,
        ];

        $forms = $this->formService->getAllForms($userId, $options);

        // Build next cursor from the last form in the result set
        $nextCursor = null;
        if (count($forms) === $limit && !empty($forms)) {
            $last = $forms[count($forms) - 1];
            $nextCursor = ($last['updatedAt'] ?? '') . '|' . ($last['id'] ?? '');
        }

        return $this->jsonResponse($response, [
            'forms' => $forms,
            'count' => count($forms),
            'nextCursor' => $nextCursor,
        ]);
    }

    /**
     * Get a single form
     * GET /api/forms/{id}
     */
    public function show(Request $request, Response $response, array $args): Response
    {
        $formId = $args['id'];
        $form = $this->authorizeFormAccess($request, $formId);

        if (!$form) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Form not found or access denied',
            ], 404);
        }

        return $this->jsonResponse($response, ['form' => $form]);
    }

    /**
     * Create a new form
     * POST /api/forms
     */
    public function create(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');

        // Require authentication to create forms
        if (!$userId) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Authentication required',
            ], 401);
        }

        $data = $request->getParsedBody();

        if (!is_array($data)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Invalid request body'], 422);
        }

        // Validate input types
        if (isset($data['title']) && !is_string($data['title'])) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Title must be a string'], 422);
        }
        if (isset($data['title']) && mb_strlen($data['title']) > 500) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Title must be 500 characters or fewer'], 422);
        }
        if (isset($data['description']) && !is_string($data['description'])) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Description must be a string'], 422);
        }
        if (isset($data['status']) && !in_array($data['status'], ['draft', 'published', 'archived'], true)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Invalid status value'], 422);
        }
        if (isset($data['fields']) && !is_array($data['fields'])) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Fields must be an array'], 422);
        }

        if (empty($data['title'])) {
            $data['title'] = 'Untitled Form';
        }

        $data['userId'] = $userId;

        try {
            $form = $this->formService->createForm($data);
            $this->audit($request, 'form.create', 'form', $form['id'] ?? '');
            return $this->jsonResponse($response, ['form' => $form], 201);
        } catch (\RuntimeException | \InvalidArgumentException $e) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => $e->getMessage(),
            ], 400);
        } catch (\Exception $e) {
            $this->logger->error('Form creation error', ['exception' => $e->getMessage()]);
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'An unexpected error occurred',
            ], 500);
        }
    }

    /**
     * Update a form
     * PUT /api/forms/{id}
     */
    public function update(Request $request, Response $response, array $args): Response
    {
        $formId = $args['id'];

        // Authorization check - user must own the form
        $form = $this->authorizeFormAccess($request, $formId);
        if (!$form) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Form not found or access denied',
            ], 404);
        }

        $data = $request->getParsedBody();

        if (!is_array($data)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Invalid request body'], 422);
        }

        // Validate input types
        if (isset($data['title']) && !is_string($data['title'])) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Title must be a string'], 422);
        }
        if (isset($data['title']) && mb_strlen($data['title']) > 500) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Title must be 500 characters or fewer'], 422);
        }
        if (isset($data['description']) && !is_string($data['description'])) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Description must be a string'], 422);
        }
        if (isset($data['status']) && !in_array($data['status'], ['draft', 'published', 'archived'], true)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Invalid status value'], 422);
        }
        if (isset($data['fields']) && !is_array($data['fields'])) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Fields must be an array'], 422);
        }

        try {
            // Snapshot current state before updating
            $changelog = $data['_changelog'] ?? null;
            unset($data['_changelog']);
            if ($this->versionService !== null) {
                $this->versionService->createVersion($formId, $request->getAttribute('userId'), $changelog);
            }

            $updatedForm = $this->formService->updateForm($formId, $data);

            if (!$updatedForm) {
                return $this->jsonResponse($response, [
                    'error' => true,
                    'message' => 'Form not found',
                ], 404);
            }

            $action = (isset($data['status']) && $data['status'] === 'published') ? 'form.publish' : 'form.update';
            $this->audit($request, $action, 'form', $formId);

            return $this->jsonResponse($response, ['form' => $updatedForm]);
        } catch (\RuntimeException | \InvalidArgumentException $e) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => $e->getMessage(),
            ], 400);
        } catch (\Exception $e) {
            $this->logger->error('Form update error', ['exception' => $e->getMessage()]);
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'An unexpected error occurred',
            ], 500);
        }
    }

    /**
     * Delete a form
     * DELETE /api/forms/{id}
     */
    public function delete(Request $request, Response $response, array $args): Response
    {
        $formId = $args['id'];

        // Authorization check - user must own the form
        $form = $this->authorizeFormAccess($request, $formId);
        if (!$form) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Form not found or access denied',
            ], 404);
        }

        $deleted = $this->formService->deleteForm($formId);

        if (!$deleted) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Form not found',
            ], 404);
        }

        $this->audit($request, 'form.delete', 'form', $formId);

        return $this->jsonResponse($response, [
            'success' => true,
            'message' => 'Form deleted successfully',
        ]);
    }

    /**
     * Duplicate a form
     * POST /api/forms/{id}/duplicate
     */
    public function duplicate(Request $request, Response $response, array $args): Response
    {
        $formId = $args['id'];
        $userId = $request->getAttribute('userId');

        // Require authentication
        if (!$userId) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Authentication required',
            ], 401);
        }

        // Authorization check - user must own the form to duplicate it
        $form = $this->authorizeFormAccess($request, $formId);
        if (!$form) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Form not found or access denied',
            ], 404);
        }

        try {
            $duplicatedForm = $this->formService->duplicateForm($formId, $userId);

            if (!$duplicatedForm) {
                return $this->jsonResponse($response, [
                    'error' => true,
                    'message' => 'Failed to duplicate form',
                ], 400);
            }

            $this->audit($request, 'form.duplicate', 'form', $duplicatedForm['id'] ?? '', ['sourceFormId' => $formId]);
            return $this->jsonResponse($response, ['form' => $duplicatedForm], 201);
        } catch (\RuntimeException | \InvalidArgumentException $e) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => $e->getMessage(),
            ], 400);
        } catch (\Exception $e) {
            $this->logger->error('Form duplication error', ['exception' => $e->getMessage()]);
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'An unexpected error occurred',
            ], 500);
        }
    }

    /**
     * List form versions
     * GET /api/forms/{id}/versions
     */
    public function listVersions(Request $request, Response $response, array $args): Response
    {
        $formId = $args['id'];
        $form = $this->authorizeFormAccess($request, $formId);
        if (!$form) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }

        if (!$this->versionService) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Versioning not available'], 501);
        }

        $queryParams = $request->getQueryParams();
        $limit = max(1, min((int)($queryParams['limit'] ?? 50), 100));
        $offset = max(0, (int)($queryParams['offset'] ?? 0));

        $versions = $this->versionService->getVersions($formId, $limit, $offset);
        return $this->jsonResponse($response, ['versions' => $versions]);
    }

    /**
     * Get a specific form version
     * GET /api/forms/{id}/versions/{version}
     */
    public function getVersion(Request $request, Response $response, array $args): Response
    {
        $formId = $args['id'];
        $form = $this->authorizeFormAccess($request, $formId);
        if (!$form) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }

        if (!$this->versionService) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Versioning not available'], 501);
        }

        $version = (int)$args['version'];
        $versionData = $this->versionService->getVersion($formId, $version);
        if (!$versionData) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Version not found'], 404);
        }

        return $this->jsonResponse($response, ['version' => $versionData]);
    }

    /**
     * Restore a form to a specific version
     * POST /api/forms/{id}/versions/{version}/restore
     */
    public function restoreVersion(Request $request, Response $response, array $args): Response
    {
        $formId = $args['id'];
        $form = $this->authorizeFormAccess($request, $formId);
        if (!$form) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }

        if (!$this->versionService) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Versioning not available'], 501);
        }

        $version = (int)$args['version'];
        $userId = $request->getAttribute('userId');
        $restoredForm = $this->versionService->restoreVersion($formId, $version, $userId);

        if (!$restoredForm) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Version not found'], 404);
        }

        $this->audit($request, 'form.update', 'form', $formId, ['restoredFromVersion' => $version]);

        return $this->jsonResponse($response, ['form' => $restoredForm]);
    }

    /**
     * Log an audit event (silently fails if audit service unavailable)
     */
    private function audit(Request $request, string $action, string $resourceType, string $resourceId, array $details = []): void
    {
        if ($this->auditService === null) return;
        $userId = $request->getAttribute('userId');
        $ip = IpResolver::fromEnvironment()->getClientIp($request);
        $this->auditService->log($action, $resourceType, $resourceId, $userId, $ip, $details);
    }

    /**
     * Helper to create JSON responses
     */
    private function jsonResponse(Response $response, array $data, int $status = 200): Response
    {
        $response->getBody()->write(json_encode($data));
        return $response
            ->withStatus($status)
            ->withHeader('Content-Type', 'application/json');
    }
}
