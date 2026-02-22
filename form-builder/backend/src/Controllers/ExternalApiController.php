<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\WebhookService;
use FormLogic\Services\ScriptRejection;
use FormLogic\Helpers\IpResolver;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class ExternalApiController
{
    private FormService $formService;
    private ResponseService $responseService;
    private WebhookService $webhookService;

    public function __construct(
        FormService $formService,
        ResponseService $responseService,
        WebhookService $webhookService
    ) {
        $this->formService = $formService;
        $this->responseService = $responseService;
        $this->webhookService = $webhookService;
    }

    // ── Forms ────────────────────────────────────────────────

    /**
     * GET /api/v1/forms
     */
    public function listForms(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $params = $request->getQueryParams();

        $options = [
            'status' => $params['status'] ?? null,
            'limit' => $params['limit'] ?? 50,
            'offset' => $params['offset'] ?? 0,
        ];

        $forms = $this->formService->getAllForms($userId, $options);

        // Filter by form_ids restriction if set
        $forms = $this->filterByAllowedForms($request, $forms);

        // Strip sensitive fields
        $forms = array_map([$this, 'sanitizeForm'], $forms);

        return $this->jsonResponse($response, ['forms' => array_values($forms)]);
    }

    /**
     * GET /api/v1/forms/{formId}
     */
    public function getForm(Request $request, Response $response, array $args): Response
    {
        $form = $this->authorizeForm($request, $args['formId']);
        if (!$form) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }

        return $this->jsonResponse($response, ['form' => $this->sanitizeForm($form)]);
    }

    /**
     * GET /api/v1/forms/{formId}/fields
     */
    public function getFormFields(Request $request, Response $response, array $args): Response
    {
        $form = $this->authorizeForm($request, $args['formId']);
        if (!$form) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }

        return $this->jsonResponse($response, ['fields' => $form['fields'] ?? []]);
    }

    // ── Responses ────────────────────────────────────────────

    /**
     * POST /api/v1/forms/{formId}/responses
     */
    public function submitResponse(Request $request, Response $response, array $args): Response
    {
        $form = $this->authorizeForm($request, $args['formId']);
        if (!$form) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }

        if ($form['status'] !== 'published') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form is not accepting responses'], 403);
        }

        $data = $request->getParsedBody();
        $validationErrors = $this->validateAnswers($form['fields'] ?? [], $data['answers'] ?? []);
        if (!empty($validationErrors)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Validation failed',
                'errors' => $validationErrors,
            ], 400);
        }

        $data['ipAddress'] = IpResolver::fromEnvironment()->getClientIp($request);
        $data['userAgent'] = substr($request->getHeaderLine('User-Agent'), 0, 500);
        $script = $form['logicScript'] ?? null;

        try {
            $result = $this->responseService->createResponse($args['formId'], $data, $script);

            if ($result instanceof ScriptRejection) {
                return $this->jsonResponse($response, [
                    'error' => true,
                    'message' => $result->message,
                    'rejected' => true,
                ], 422);
            }

            return $this->jsonResponse($response, ['response' => $result], 201);
        } catch (\RuntimeException | \InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Internal error processing response'], 500);
        }
    }

    /**
     * POST /api/v1/forms/{formId}/responses/batch
     */
    public function batchSubmitResponses(Request $request, Response $response, array $args): Response
    {
        $form = $this->authorizeForm($request, $args['formId']);
        if (!$form) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }

        if ($form['status'] !== 'published') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form is not accepting responses'], 403);
        }

        $data = $request->getParsedBody();
        $items = $data['responses'] ?? [];

        if (!is_array($items) || empty($items)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'responses array is required'], 400);
        }

        if (count($items) > 100) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Maximum 100 responses per batch'], 400);
        }

        $ip = IpResolver::fromEnvironment()->getClientIp($request);
        $userAgent = substr($request->getHeaderLine('User-Agent'), 0, 500);
        $script = $form['logicScript'] ?? null;
        $results = [];

        foreach ($items as $index => $item) {
            $validationErrors = $this->validateAnswers($form['fields'] ?? [], $item['answers'] ?? []);
            if (!empty($validationErrors)) {
                $results[] = ['index' => $index, 'success' => false, 'errors' => $validationErrors];
                continue;
            }

            $item['ipAddress'] = $ip;
            $item['userAgent'] = $userAgent;

            try {
                $result = $this->responseService->createResponse($args['formId'], $item, $script);
                if ($result instanceof ScriptRejection) {
                    $results[] = ['index' => $index, 'success' => false, 'message' => $result->message, 'rejected' => true];
                } else {
                    $results[] = ['index' => $index, 'success' => true, 'responseId' => $result['id'] ?? null];
                }
            } catch (\Exception $e) {
                $results[] = ['index' => $index, 'success' => false, 'message' => $e->getMessage()];
            }
        }

        $succeeded = count(array_filter($results, fn($r) => $r['success']));
        return $this->jsonResponse($response, [
            'total' => count($items),
            'succeeded' => $succeeded,
            'failed' => count($items) - $succeeded,
            'results' => $results,
        ], 200);
    }

    /**
     * GET /api/v1/forms/{formId}/responses
     */
    public function listResponses(Request $request, Response $response, array $args): Response
    {
        $form = $this->authorizeForm($request, $args['formId']);
        if (!$form) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }

        $params = $request->getQueryParams();
        $options = [
            'status' => $params['status'] ?? null,
            'from' => $params['from'] ?? null,
            'to' => $params['to'] ?? null,
            'limit' => $params['limit'] ?? 50,
            'offset' => $params['offset'] ?? 0,
        ];

        $responses = $this->responseService->getFormResponses($args['formId'], $options);
        return $this->jsonResponse($response, ['responses' => $responses]);
    }

    /**
     * GET /api/v1/forms/{formId}/responses/{id}
     */
    public function getResponse(Request $request, Response $response, array $args): Response
    {
        $form = $this->authorizeForm($request, $args['formId']);
        if (!$form) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }

        $formResponse = $this->responseService->getResponse($args['formId'], $args['id']);
        if (!$formResponse) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Response not found'], 404);
        }

        return $this->jsonResponse($response, ['response' => $formResponse]);
    }

    /**
     * PUT /api/v1/forms/{formId}/responses/{id}
     */
    public function updateResponse(Request $request, Response $response, array $args): Response
    {
        $form = $this->authorizeForm($request, $args['formId']);
        if (!$form) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }

        $data = $request->getParsedBody();

        try {
            $formResponse = $this->responseService->updateResponse($args['formId'], $args['id'], $data);
            if (!$formResponse) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Response not found'], 404);
            }
            return $this->jsonResponse($response, ['response' => $formResponse]);
        } catch (\RuntimeException | \InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    /**
     * DELETE /api/v1/forms/{formId}/responses/{id}
     */
    public function deleteResponse(Request $request, Response $response, array $args): Response
    {
        $form = $this->authorizeForm($request, $args['formId']);
        if (!$form) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }

        $deleted = $this->responseService->deleteResponse($args['formId'], $args['id']);
        if (!$deleted) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Response not found'], 404);
        }

        return $this->jsonResponse($response, ['success' => true, 'message' => 'Response deleted']);
    }

    // ── Analytics ────────────────────────────────────────────

    /**
     * GET /api/v1/forms/{formId}/analytics
     */
    public function analytics(Request $request, Response $response, array $args): Response
    {
        $form = $this->authorizeForm($request, $args['formId']);
        if (!$form) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }

        $params = $request->getQueryParams();
        $options = [
            'from' => $params['from'] ?? null,
            'to' => $params['to'] ?? null,
        ];

        $analytics = $this->responseService->getFormAnalytics($args['formId'], $options);
        return $this->jsonResponse($response, ['analytics' => $analytics]);
    }

    // ── Webhooks ─────────────────────────────────────────────

    /**
     * GET /api/v1/forms/{formId}/webhooks
     */
    public function listWebhooks(Request $request, Response $response, array $args): Response
    {
        $form = $this->authorizeForm($request, $args['formId']);
        if (!$form) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }

        $webhooks = $this->webhookService->getWebhooksForForm($args['formId']);
        return $this->jsonResponse($response, ['webhooks' => $webhooks]);
    }

    /**
     * POST /api/v1/forms/{formId}/webhooks
     */
    public function createWebhook(Request $request, Response $response, array $args): Response
    {
        $form = $this->authorizeForm($request, $args['formId']);
        if (!$form) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }

        $userId = $request->getAttribute('userId');
        $data = $request->getParsedBody();
        $url = $data['url'] ?? '';
        $events = $data['events'] ?? [];
        $description = $data['description'] ?? null;

        if (empty($url) || !filter_var($url, FILTER_VALIDATE_URL)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'A valid URL is required'], 400);
        }

        $scheme = parse_url($url, PHP_URL_SCHEME);
        if ($scheme !== 'https' && $scheme !== 'http') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'URL must use http or https'], 400);
        }

        if (empty($events) || !is_array($events)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'At least one event is required'], 400);
        }

        $allowedEvents = ['response.created', 'response.updated', 'response.deleted', 'form.published'];
        foreach ($events as $event) {
            if (!in_array($event, $allowedEvents, true)) {
                return $this->jsonResponse($response, ['error' => true, 'message' => "Invalid event: $event"], 400);
            }
        }

        $webhook = $this->webhookService->createWebhook($args['formId'], $userId, $url, $events, $description);
        return $this->jsonResponse($response, ['webhook' => $webhook], 201);
    }

    /**
     * PUT /api/v1/forms/{formId}/webhooks/{webhookId}
     */
    public function updateWebhook(Request $request, Response $response, array $args): Response
    {
        $form = $this->authorizeForm($request, $args['formId']);
        if (!$form) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }

        $webhook = $this->webhookService->getWebhook($args['webhookId']);
        if (!$webhook || $webhook['formId'] !== $args['formId']) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Webhook not found'], 404);
        }

        $data = $request->getParsedBody();

        if (isset($data['url'])) {
            if (!filter_var($data['url'], FILTER_VALIDATE_URL)) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'A valid URL is required'], 400);
            }
        }

        if (isset($data['events'])) {
            if (!is_array($data['events']) || empty($data['events'])) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Events must be a non-empty array'], 400);
            }
            $allowedEvents = ['response.created', 'response.updated', 'response.deleted', 'form.published'];
            foreach ($data['events'] as $event) {
                if (!in_array($event, $allowedEvents, true)) {
                    return $this->jsonResponse($response, ['error' => true, 'message' => "Invalid event: $event"], 400);
                }
            }
        }

        $updated = $this->webhookService->updateWebhook($args['webhookId'], $data);
        return $this->jsonResponse($response, ['webhook' => $updated]);
    }

    /**
     * DELETE /api/v1/forms/{formId}/webhooks/{webhookId}
     */
    public function deleteWebhook(Request $request, Response $response, array $args): Response
    {
        $form = $this->authorizeForm($request, $args['formId']);
        if (!$form) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }

        $webhook = $this->webhookService->getWebhook($args['webhookId']);
        if (!$webhook || $webhook['formId'] !== $args['formId']) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Webhook not found'], 404);
        }

        $this->webhookService->deleteWebhook($args['webhookId']);
        return $this->jsonResponse($response, ['success' => true, 'message' => 'Webhook deleted']);
    }

    // ── Helpers ──────────────────────────────────────────────

    /**
     * Authorize form access: checks ownership + form_ids restriction.
     */
    private function authorizeForm(Request $request, string $formId): ?array
    {
        $userId = $request->getAttribute('userId');
        $form = $this->formService->getForm($formId);

        if (!$form || $form['userId'] !== $userId) {
            return null;
        }

        // Check form_ids restriction from API key
        $allowedFormIds = $request->getAttribute('apiKeyFormIds');
        if ($allowedFormIds !== null && !in_array($formId, $allowedFormIds, true)) {
            return null;
        }

        return $form;
    }

    /**
     * Filter a list of forms by the API key's form_ids restriction.
     */
    private function filterByAllowedForms(Request $request, array $forms): array
    {
        $allowedFormIds = $request->getAttribute('apiKeyFormIds');
        if ($allowedFormIds === null) {
            return $forms;
        }

        return array_filter($forms, fn($form) => in_array($form['id'], $allowedFormIds, true));
    }

    /**
     * Remove sensitive fields from form data for external consumers.
     */
    private function sanitizeForm(array $form): array
    {
        unset($form['logicScript']);
        unset($form['logicPrompt']);
        return $form;
    }

    /**
     * Validate answers against form field definitions.
     * Mirrors ResponseController::validateAnswers logic.
     */
    private function validateAnswers(array $fields, array $answers): array
    {
        $errors = [];
        $fieldMap = [];
        foreach ($fields as $field) {
            if (isset($field['id'])) {
                $fieldMap[$field['id']] = $field;
            }
        }

        foreach ($fields as $field) {
            $fieldId = $field['id'] ?? null;
            if (!$fieldId) continue;

            $fieldType = $field['type'] ?? 'short_text';
            if (in_array($fieldType, ['statement', 'welcome_screen', 'thank_you'], true)) continue;

            $isRequired = $field['required'] ?? false;
            $value = $answers[$fieldId] ?? null;

            if ($isRequired && ($value === null || $value === '' || $value === [])) {
                $errors[$fieldId] = 'This field is required';
                continue;
            }

            if ($value === null || $value === '' || $value === []) continue;

            // Type-specific validation (mirrors ResponseController::validateFieldType)
            switch ($fieldType) {
                case 'email':
                    if (!filter_var($value, FILTER_VALIDATE_EMAIL)) {
                        $errors[$fieldId] = 'Invalid email address';
                    }
                    break;
                case 'url':
                    if (!filter_var($value, FILTER_VALIDATE_URL)) {
                        $errors[$fieldId] = 'Invalid URL';
                    }
                    break;
                case 'number':
                    if (!is_numeric($value)) {
                        $errors[$fieldId] = 'Must be a number';
                    }
                    break;
                case 'phone':
                    // Accept E.164 format (+[1-9]...) or legacy loose format (must contain at least 6 digits)
                    if (!preg_match('/^\+[1-9]\d{6,14}$/', $value) &&
                        !preg_match('/^[\d\s\-\+\(\)\.]+$/', $value)) {
                        $errors[$fieldId] = 'Invalid phone number format';
                    }
                    // Require at least 6 actual digits in loose format
                    if (!isset($errors[$fieldId]) && !preg_match('/^\+[1-9]\d{6,14}$/', $value)) {
                        $digitCount = preg_match_all('/\d/', $value);
                        if ($digitCount < 6) {
                            $errors[$fieldId] = 'Phone number must contain at least 6 digits';
                        }
                    }
                    break;
                case 'date':
                case 'datetime':
                case 'time':
                    if (is_string($value) && strlen($value) > 100) {
                        $errors[$fieldId] = 'Invalid date/time format';
                    }
                    break;
                case 'rating':
                    $properties = $field['properties'] ?? [];
                    $maxStars = $properties['maxStars'] ?? 5;
                    if (!is_numeric($value) || $value < 1 || $value > $maxStars) {
                        $errors[$fieldId] = "Rating must be between 1 and {$maxStars}";
                    }
                    break;
                case 'scale':
                    $properties = $field['properties'] ?? [];
                    $min = $properties['scaleStart'] ?? 1;
                    $max = $properties['scaleEnd'] ?? 10;
                    if (!is_numeric($value) || $value < $min || $value > $max) {
                        $errors[$fieldId] = "Value must be between {$min} and {$max}";
                    }
                    break;
                case 'dropdown':
                case 'multiple_choice':
                    $properties = $field['properties'] ?? [];
                    $options = $properties['options'] ?? [];
                    $allowedValues = array_column($options, 'value');
                    if (!in_array($value, $allowedValues, true)) {
                        $errors[$fieldId] = 'Invalid selection';
                    }
                    break;
                case 'checkboxes':
                    if (!is_array($value)) {
                        $errors[$fieldId] = 'Invalid selection format';
                    } else {
                        $properties = $field['properties'] ?? [];
                        $options = $properties['options'] ?? [];
                        $allowedValues = array_column($options, 'value');
                        foreach ($value as $selected) {
                            if (!in_array($selected, $allowedValues, true)) {
                                $errors[$fieldId] = 'Invalid selection';
                                break;
                            }
                        }
                    }
                    break;
                case 'short_text':
                case 'long_text':
                    if (is_string($value)) {
                        $maxLength = $fieldType === 'short_text' ? 1000 : 50000;
                        if (strlen($value) > $maxLength) {
                            $errors[$fieldId] = "Text exceeds maximum length of {$maxLength} characters";
                        }
                    }
                    break;
            }
        }

        return $errors;
    }

    private function jsonResponse(Response $response, array $data, int $status = 200): Response
    {
        $response->getBody()->write(json_encode($data));
        return $response
            ->withStatus($status)
            ->withHeader('Content-Type', 'application/json');
    }
}
