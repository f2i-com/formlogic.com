<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\FormDeletionIncompleteException;
use FormLogic\Services\FormEncryptionService;
use FormLogic\Services\FormService;
use FormLogic\Services\FormVersionService;
use FormLogic\Services\AuditService;
use FormLogic\Services\PlanService;
use FormLogic\Services\AppReportService;
use FormLogic\Services\TrashService;
use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Helpers\IpResolver;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

class FormController
{
    use JsonResponseTrait;

    private FormService $formService;
    private LoggerInterface $logger;
    private ?FormVersionService $versionService;
    private ?AuditService $auditService;
    private ?PlanService $planService;
    private ?AppReportService $reportValidator;
    private ?TrashService $trashService;
    private ?FormEncryptionService $encryptionService;

    public function __construct(
        FormService $formService,
        ?LoggerInterface $logger = null,
        ?FormVersionService $versionService = null,
        ?AuditService $auditService = null,
        ?PlanService $planService = null,
        ?AppReportService $reportValidator = null,
        ?TrashService $trashService = null,
        ?FormEncryptionService $encryptionService = null
    ) {
        $this->formService = $formService;
        $this->logger = $logger ?? new NullLogger();
        $this->versionService = $versionService;
        $this->auditService = $auditService;
        $this->planService = $planService;
        $this->reportValidator = $reportValidator;
        $this->trashService = $trashService;
        $this->encryptionService = $encryptionService;
    }

    /**
     * Enforce the account's form-count quota. Returns an error Response if the user is
     * at their plan limit, else null. No-op unless plan enforcement is on.
     */
    private function checkFormQuota(Response $response, string $userId, int $additional = 1): ?Response
    {
        if ($this->planService && !$this->planService->canCreateForms($userId, $additional)) {
            $limit = $this->planService->formLimit($userId);
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'form_limit',
                'message' => 'You\'ve reached your plan\'s limit of ' . $limit . ' forms. Delete a form or upgrade to add more.',
            ], 402);
        }
        return null;
    }

    /**
     * When saving a section-screen widget dashboard, sanitize its specs against the form's own fields
     * (+ linked targets) so no widget can query outside them. Mutates $data in place. Execution is
     * independently re-validated at run time; this hardens the save boundary (mirrors app dashboards).
     */
    private function sanitizeDashboardScreen(array &$data, string $formId): void
    {
        if (!$this->reportValidator || !isset($data['customScreen']) || !is_array($data['customScreen'])) {
            return;
        }
        if (($data['customScreen']['kind'] ?? '') !== 'dashboard' || !is_array($data['customScreen']['dashboard'] ?? null)) {
            return;
        }
        $data['customScreen']['dashboard'] = $this->reportValidator->sanitizeDashboard(
            $data['customScreen']['dashboard'],
            $this->reportValidator->formFieldMap($formId)
        );
    }

    /**
     * Validate size limits for large form fields to prevent abuse.
     * Returns an error message string or null if valid.
     */
    private function validateFieldSizes(array $data): ?string
    {
        if (isset($data['logicScript']) && is_string($data['logicScript']) && strlen($data['logicScript']) > 102400) {
            return 'Logic script must be 100KB or smaller';
        }
        if (isset($data['logicPrompt']) && is_string($data['logicPrompt']) && strlen($data['logicPrompt']) > 10240) {
            return 'Logic prompt must be 10KB or smaller';
        }
        if (isset($data['fields']) && is_array($data['fields'])) {
            $fieldsJson = json_encode($data['fields']);
            if ($fieldsJson !== false && strlen($fieldsJson) > 512000) {
                return 'Fields data must be 500KB or smaller';
            }
        }
        if (isset($data['settings'])) {
            $settingsJson = json_encode($data['settings']);
            if ($settingsJson !== false && strlen($settingsJson) > 10240) {
                return 'Settings must be 10KB or smaller';
            }
        }
        if (isset($data['theme'])) {
            $themeJson = json_encode($data['theme']);
            if ($themeJson !== false && strlen($themeJson) > 10240) {
                return 'Theme must be 10KB or smaller';
            }
        }
        if (isset($data['customScreen'])) {
            if (!is_array($data['customScreen'])) {
                return 'Custom screen must be an object';
            }
            $screenJson = json_encode($data['customScreen']);
            // 2MB: screens may carry image assets as data: URIs in `files` (base64 inflates ~4/3).
            if ($screenJson !== false && strlen($screenJson) > 2097152) {
                return 'Custom screen must be 2MB or smaller';
            }
        }
        if (isset($data['customLogic'])) {
            if (!is_array($data['customLogic'])) {
                return 'Custom logic must be an object';
            }
            if (!\FormLogic\Helpers\CustomLogicSanitizer::withinSizeCap($data['customLogic'])) {
                return 'Custom logic must be 100KB or smaller';
            }
        }
        return null;
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
            $this->logger->warning('Authorization denied: user does not own form', [
                'userId' => $userId,
                'formId' => $formId,
            ]);
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
        // ($limit is clamped >= 1 above, so count === $limit implies non-empty).
        $nextCursor = null;
        if (count($forms) === $limit) {
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

        // E2EE (plan §8): private forms carry their signed manifest on the OWNER
        // payload too — the builder verifies signer keys and renders the exact
        // schema snapshot. Served no-store like the public manifest.
        if ($this->encryptionService !== null && $this->encryptionService->isPrivate($formId)) {
            $form['encryption'] = $this->encryptionService->publicManifest($formId);
            return $this->jsonResponse($response, ['form' => $form])
                ->withHeader('Cache-Control', 'no-store');
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
        if (isset($data['icon']) && (!is_string($data['icon']) || mb_strlen($data['icon']) > 100)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Icon must be a string of 100 characters or fewer'], 422);
        }
        $sizeError = $this->validateFieldSizes($data);
        if ($sizeError !== null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $sizeError], 422);
        }

        if (empty($data['title'])) {
            $data['title'] = 'Untitled Form';
        }

        $data['userId'] = $userId;

        if ($overQuota = $this->checkFormQuota($response, $userId)) {
            return $overQuota;
        }

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
        if (isset($data['icon']) && (!is_string($data['icon']) || mb_strlen($data['icon']) > 100)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Icon must be a string of 100 characters or fewer'], 422);
        }
        $sizeError = $this->validateFieldSizes($data);
        if ($sizeError !== null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $sizeError], 422);
        }
        $this->sanitizeDashboardScreen($data, $formId);
        if (isset($data['customLogic']) && is_array($data['customLogic'])) {
            $data['customLogic'] = \FormLogic\Helpers\CustomLogicSanitizer::sanitize($data['customLogic']);
        }

        try {
            // Snapshot current state before updating (non-blocking: version failure should not prevent saving)
            $changelog = $data['_changelog'] ?? null;
            unset($data['_changelog']);
            if ($this->versionService !== null) {
                try {
                    // form_versions.created_by names the TRUE actor (the admin when
                    // this edit arrives via the acting-as mirror, else the owner).
                    $this->versionService->createVersion(
                        $formId,
                        $request->getAttribute('adminActorId') ?? $request->getAttribute('userId'),
                        $changelog
                    );
                } catch (\Exception $versionErr) {
                    $this->logger->warning('Version creation failed', [
                        'formId' => $formId,
                        'error' => $versionErr->getMessage(),
                    ]);
                }
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
        } catch (\FormLogic\Services\PrivateFormEncryptedException $e) {
            // E2EE §9.2: blocked field types / private-form violations — typed refusal.
            return $this->jsonError($response, $e->getMessage(), 409, \FormLogic\Services\PrivateFormEncryptedException::ERROR_CODE);
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
        if ($blocked = $this->blockIfDemo($request, $response, 'This is a shared live demo — forms can\'t be deleted here.')) {
            return $blocked;
        }
        $formId = $args['id'];

        // Authorization check - user must own the form
        $form = $this->authorizeFormAccess($request, $formId);
        if (!$form) {
            // The metadata row may already be gone from a previous delete whose disk
            // cleanup failed (durable pending deletion, audit FL-DATA-001). Let the
            // SAME user resume it instead of dead-ending their retry on a 404.
            $userId = $request->getAttribute('userId');
            $resumed = $userId ? $this->formService->resumePendingDeletion($formId, (string) $userId) : null;
            if ($resumed === true) {
                $this->audit($request, 'form.delete', 'form', $formId);
                return $this->jsonResponse($response, [
                    'success' => true,
                    'message' => 'Form deleted successfully',
                ]);
            }
            if ($resumed === false) {
                return $this->jsonResponse($response, [
                    'error' => true,
                    'retryable' => true,
                    'message' => 'The form is deleted, but its stored data could not be fully removed yet — please retry.',
                ], 503);
            }
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Form not found or access denied',
            ], 404);
        }

        try {
            // Recycle bin: snapshot before the hard delete (30-day restore).
            // Empty drafts skip the snapshot (trashed=false). The resume path
            // above never captures — the metadata row is already gone.
            if ($this->trashService !== null) {
                $result = $this->trashService->trashForm($formId, (string) $request->getAttribute('userId'));
                $deleted = $result['deleted'];
                $trashed = $result['trashed'];
            } else {
                $deleted = $this->formService->deleteForm($formId);
                $trashed = false;
            }
        } catch (FormDeletionIncompleteException $e) {
            // Metadata removed but the on-disk stores still disagree — truthful,
            // retryable failure instead of fake success (the deletion intent is
            // durably recorded; a retry resumes the cleanup).
            $this->audit($request, 'form.delete_incomplete', 'form', $formId);
            return $this->jsonResponse($response, [
                'error' => true,
                'retryable' => true,
                'message' => $e->getMessage(),
            ], 503);
        }

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
            'trashed' => $trashed,
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

        if ($overQuota = $this->checkFormQuota($response, $userId)) {
            return $overQuota;
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

        // Warn if restoring over a published form unless explicitly forced
        if ($form['status'] === 'published') {
            $body = $request->getParsedBody();
            if (empty($body['force'])) {
                return $this->jsonResponse($response, [
                    'error' => true,
                    'message' => 'This form is currently published. Restoring will immediately change the live form. Send { "force": true } to confirm.',
                    'requiresForce' => true,
                ], 409);
            }
        }

        $restoredForm = $this->versionService->restoreVersion($formId, $version, $userId);

        if (!$restoredForm) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Version not found'], 404);
        }

        $this->audit($request, 'form.version.restore', 'form', $formId, ['restoredFromVersion' => $version]);

        return $this->jsonResponse($response, ['form' => $restoredForm]);
    }

    /**
     * Log an audit event (silently fails if audit service unavailable)
     */
    private function audit(Request $request, string $action, string $resourceType, string $resourceId, array $details = []): void
    {
        if ($this->auditService === null) return;
        $userId = $request->getAttribute('userId');
        // A platform admin acting on the owner's behalf (AdminActAsMiddleware
        // swapped the effective user) is the TRUE actor: attribute the event to
        // the admin and record who it was done for.
        $adminActorId = $request->getAttribute('adminActorId');
        if (is_string($adminActorId) && $adminActorId !== '') {
            $details['onBehalfOf'] = $userId;
            $userId = $adminActorId;
        }
        $ip = IpResolver::fromEnvironment()->getClientIp($request);
        $this->auditService->log($action, $resourceType, $resourceId, $userId, $ip, $details);
    }
}
