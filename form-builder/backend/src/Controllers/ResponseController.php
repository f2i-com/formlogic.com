<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\ResponseService;
use FormLogic\Services\FormService;
use FormLogic\Services\ScriptRejection;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class ResponseController
{
    private ResponseService $responseService;
    private FormService $formService;

    public function __construct(ResponseService $responseService, FormService $formService)
    {
        $this->responseService = $responseService;
        $this->formService = $formService;
    }

    /**
     * List all responses for a form
     * GET /api/forms/{formId}/responses
     */
    public function index(Request $request, Response $response, array $args): Response
    {
        $formId = $args['formId'];
        $queryParams = $request->getQueryParams();

        // Check form exists
        $form = $this->formService->getForm($formId);
        if (!$form) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Form not found',
            ], 404);
        }

        $options = [
            'status' => $queryParams['status'] ?? null,
            'from' => $queryParams['from'] ?? null,
            'to' => $queryParams['to'] ?? null,
            'limit' => (int)($queryParams['limit'] ?? 100),
            'offset' => (int)($queryParams['offset'] ?? 0),
        ];

        $responses = $this->responseService->getFormResponses($formId, $options);

        return $this->jsonResponse($response, [
            'responses' => $responses,
            'count' => count($responses),
        ]);
    }

    /**
     * Get a single response
     * GET /api/forms/{formId}/responses/{id}
     */
    public function show(Request $request, Response $response, array $args): Response
    {
        $formId = $args['formId'];
        $responseId = $args['id'];

        $formResponse = $this->responseService->getResponse($formId, $responseId);

        if (!$formResponse) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Response not found',
            ], 404);
        }

        return $this->jsonResponse($response, ['response' => $formResponse]);
    }

    /**
     * Submit a new response (public endpoint)
     * POST /api/forms/{formId}/responses
     */
    public function create(Request $request, Response $response, array $args): Response
    {
        $formId = $args['formId'];
        $data = $request->getParsedBody();

        // Check form exists and is published
        $form = $this->formService->getForm($formId);
        if (!$form) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Form not found',
            ], 404);
        }

        if ($form['status'] !== 'published') {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Form is not accepting responses',
            ], 403);
        }

        // Add request metadata
        $serverParams = $request->getServerParams();
        $data['ipAddress'] = $serverParams['REMOTE_ADDR'] ?? null;
        $data['userAgent'] = $request->getHeaderLine('User-Agent');
        $data['referrer'] = $request->getHeaderLine('Referer');

        // Get the script from the form (if any)
        $script = $form['logicScript'] ?? null;

        try {
            $result = $this->responseService->createResponse($formId, $data, $script);

            // Handle rejection from script
            if ($result instanceof ScriptRejection) {
                return $this->jsonResponse($response, [
                    'error' => 'submission_rejected',
                    'message' => $result->message,
                ], 422);
            }

            return $this->jsonResponse($response, ['response' => $result], 201);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => $e->getMessage(),
            ], 400);
        }
    }

    /**
     * Update a response (status, answers, etc.)
     * PUT /api/forms/{formId}/responses/{id}
     */
    public function update(Request $request, Response $response, array $args): Response
    {
        $formId = $args['formId'];
        $responseId = $args['id'];
        $data = $request->getParsedBody();

        try {
            $formResponse = $this->responseService->updateResponse($formId, $responseId, $data);

            if (!$formResponse) {
                return $this->jsonResponse($response, [
                    'error' => true,
                    'message' => 'Response not found',
                ], 404);
            }

            return $this->jsonResponse($response, ['response' => $formResponse]);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => $e->getMessage(),
            ], 400);
        }
    }

    /**
     * Delete a response
     * DELETE /api/forms/{formId}/responses/{id}
     */
    public function delete(Request $request, Response $response, array $args): Response
    {
        $formId = $args['formId'];
        $responseId = $args['id'];

        $deleted = $this->responseService->deleteResponse($formId, $responseId);

        if (!$deleted) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Response not found',
            ], 404);
        }

        return $this->jsonResponse($response, [
            'success' => true,
            'message' => 'Response deleted successfully',
        ]);
    }

    /**
     * Get form analytics
     * GET /api/forms/{formId}/analytics
     */
    public function analytics(Request $request, Response $response, array $args): Response
    {
        $formId = $args['formId'];
        $queryParams = $request->getQueryParams();

        // Check form exists
        $form = $this->formService->getForm($formId);
        if (!$form) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Form not found',
            ], 404);
        }

        $options = [
            'from' => $queryParams['from'] ?? null,
            'to' => $queryParams['to'] ?? null,
        ];

        $analytics = $this->responseService->getFormAnalytics($formId, $options);

        return $this->jsonResponse($response, ['analytics' => $analytics]);
    }

    /**
     * Export responses as CSV
     * GET /api/forms/{formId}/responses/export
     */
    public function export(Request $request, Response $response, array $args): Response
    {
        $formId = $args['formId'];

        // Get form with fields
        $form = $this->formService->getForm($formId);
        if (!$form) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Form not found',
            ], 404);
        }

        $csv = $this->responseService->exportResponses($formId, $form['fields']);

        $response->getBody()->write($csv);

        return $response
            ->withHeader('Content-Type', 'text/csv')
            ->withHeader('Content-Disposition', 'attachment; filename="' . $this->sanitizeFilename($form['title']) . '-responses.csv"');
    }

    /**
     * Re-run script on an existing response
     * POST /api/forms/{formId}/responses/{id}/recompute
     */
    public function recompute(Request $request, Response $response, array $args): Response
    {
        $formId = $args['formId'];
        $responseId = $args['id'];

        // Check form exists
        $form = $this->formService->getForm($formId);
        if (!$form) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Form not found',
            ], 404);
        }

        // Get script from form
        $script = $form['logicScript'] ?? null;
        if (!$script) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'No script configured for this form',
            ], 400);
        }

        try {
            $result = $this->responseService->recomputeResponse($formId, $responseId, $script);

            return $this->jsonResponse($response, [
                'success' => $result->success,
                'computed' => $result->computed,
                'fields' => $result->fields,
                'status' => $result->status,
                'tags' => $result->tags,
                'error' => $result->error,
                'executionTimeMs' => $result->executionTimeMs,
                'instructionCount' => $result->instructionCount,
            ]);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => $e->getMessage(),
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

    /**
     * Sanitize filename for download
     */
    private function sanitizeFilename(string $filename): string
    {
        return preg_replace('/[^a-zA-Z0-9\-_]/', '-', $filename);
    }
}
