<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\FormService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

class FormController
{
    private FormService $formService;
    private LoggerInterface $logger;

    public function __construct(FormService $formService, ?LoggerInterface $logger = null)
    {
        $this->formService = $formService;
        $this->logger = $logger ?? new NullLogger();
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

        $options = [
            'status' => $queryParams['status'] ?? null,
            'limit' => (int)($queryParams['limit'] ?? 50),
            'offset' => (int)($queryParams['offset'] ?? 0),
        ];

        $forms = $this->formService->getAllForms($userId, $options);

        return $this->jsonResponse($response, [
            'forms' => $forms,
            'count' => count($forms),
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

        if (empty($data['title'])) {
            $data['title'] = 'Untitled Form';
        }

        $data['userId'] = $userId;

        try {
            $form = $this->formService->createForm($data);
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

        try {
            $updatedForm = $this->formService->updateForm($formId, $data);

            if (!$updatedForm) {
                return $this->jsonResponse($response, [
                    'error' => true,
                    'message' => 'Form not found',
                ], 404);
            }

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
