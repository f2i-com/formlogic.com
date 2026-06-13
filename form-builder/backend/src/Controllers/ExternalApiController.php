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
    private IpResolver $ipResolver;

    public function __construct(
        FormService $formService,
        ResponseService $responseService,
        WebhookService $webhookService
    ) {
        $this->formService = $formService;
        $this->responseService = $responseService;
        $this->webhookService = $webhookService;
        $this->ipResolver = IpResolver::fromEnvironment();
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
            'limit' => max(1, min((int)($params['limit'] ?? 50), 1000)),
            'offset' => max(0, (int)($params['offset'] ?? 0)),
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

        // Check form closure and quota limits (same checks as public endpoint)
        $settings = $form['settings'] ?? [];
        if (!empty($settings['isClosed'])) {
            $closedMessage = $settings['closedMessage'] ?? 'This form is no longer accepting responses.';
            return $this->jsonResponse($response, ['error' => true, 'message' => $closedMessage], 403);
        }
        if (!empty($settings['quotaLimit'])) {
            $responseCount = $this->responseService->getResponseCount($args['formId']);
            if ($responseCount >= (int)$settings['quotaLimit']) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'This form has reached its maximum number of responses.'], 403);
            }
        }

        $data = $request->getParsedBody();
        // Sanitize answers: strip non-input fields and unknown field IDs
        $data['answers'] = $this->sanitizeAnswers($form['fields'] ?? [], $data['answers'] ?? []);
        $validationErrors = $this->validateAnswers($form['fields'] ?? [], $data['answers']);
        if (!empty($validationErrors)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Validation failed',
                'errors' => $validationErrors,
            ], 400);
        }

        $data['ipAddress'] = $this->ipResolver->getClientIp($request);
        $data['userAgent'] = htmlspecialchars(substr($request->getHeaderLine('User-Agent'), 0, 500), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        // Strip client-supplied fields that must be server-controlled
        unset($data['submittedByUserId'], $data['status']);
        $script = $form['logicScript'] ?? null;

        try {
            // Atomic quota enforcement: re-check the count under a per-form lock so
            // concurrent submissions cannot both pass the earlier check and overshoot
            // the cap (the lock fails open under contention).
            $quotaLock = null;
            if (!empty($settings['quotaLimit'])) {
                $quotaLock = $this->responseService->acquireFormLock($args['formId']);
                if ($this->responseService->getResponseCount($args['formId']) >= (int)$settings['quotaLimit']) {
                    $this->responseService->releaseFormLock($quotaLock);
                    return $this->jsonResponse($response, ['error' => true, 'message' => 'This form has reached its maximum number of responses.'], 403);
                }
            }
            try {
                $result = $this->responseService->createResponse($args['formId'], $data, $script);
            } finally {
                $this->responseService->releaseFormLock($quotaLock);
            }

            if ($result instanceof ScriptRejection) {
                return $this->jsonResponse($response, [
                    'error' => true,
                    'message' => $result->message,
                    'rejected' => true,
                ], 422);
            }

            // Write inverse linked_record links (External API submissions skipped this).
            $this->responseService->syncResponseLinks($args['formId'], $result['id'] ?? '', $form['fields'] ?? [], $data['answers'] ?? []);

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

        // Check form closure and quota limits
        $settings = $form['settings'] ?? [];
        if (!empty($settings['isClosed'])) {
            $closedMessage = $settings['closedMessage'] ?? 'This form is no longer accepting responses.';
            return $this->jsonResponse($response, ['error' => true, 'message' => $closedMessage], 403);
        }
        $quotaLimit = !empty($settings['quotaLimit']) ? (int)$settings['quotaLimit'] : 0;
        if ($quotaLimit > 0) {
            $responseCount = $this->responseService->getResponseCount($args['formId']);
            if ($responseCount >= $quotaLimit) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'This form has reached its maximum number of responses.'], 403);
            }
        }

        $data = $request->getParsedBody();
        $items = $data['responses'] ?? [];

        if (!is_array($items) || empty($items)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'responses array is required'], 400);
        }

        if (count($items) > 100) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Maximum 100 responses per batch'], 400);
        }

        $ip = $this->ipResolver->getClientIp($request);
        $userAgent = substr($request->getHeaderLine('User-Agent'), 0, 500);
        $script = $form['logicScript'] ?? null;
        $results = [];
        $createdCount = 0;

        // Hold a per-form lock across the whole batch so the count stays
        // authoritative: no other process can insert while we enforce the quota,
        // so the snapshot + createdCount can't go stale and overshoot the cap.
        // (GET_LOCK auto-releases when the request connection closes.)
        $quotaLock = ($quotaLimit > 0) ? $this->responseService->acquireFormLock($args['formId']) : null;
        if ($quotaLimit > 0) {
            $responseCount = $this->responseService->getResponseCount($args['formId']);
        }

        foreach ($items as $index => $item) {
            // Enforce quota per-item to prevent batch from exceeding limit
            if ($quotaLimit > 0 && ($responseCount + $createdCount) >= $quotaLimit) {
                $results[] = ['index' => $index, 'success' => false, 'message' => 'Quota limit reached'];
                continue;
            }

            // Sanitize answers: strip non-input fields and unknown field IDs
            $item['answers'] = $this->sanitizeAnswers($form['fields'] ?? [], $item['answers'] ?? []);
            $validationErrors = $this->validateAnswers($form['fields'] ?? [], $item['answers'] ?? []);
            if (!empty($validationErrors)) {
                $results[] = ['index' => $index, 'success' => false, 'errors' => $validationErrors];
                continue;
            }

            $item['ipAddress'] = $ip;
            $item['userAgent'] = $userAgent;
            // Strip client-supplied fields that must be server-controlled
            unset($item['submittedByUserId'], $item['status']);

            try {
                $result = $this->responseService->createResponse($args['formId'], $item, $script);
                if ($result instanceof ScriptRejection) {
                    $results[] = ['index' => $index, 'success' => false, 'message' => $result->message, 'rejected' => true];
                } else {
                    $this->responseService->syncResponseLinks($args['formId'], $result['id'] ?? '', $form['fields'] ?? [], $item['answers'] ?? []);
                    $results[] = ['index' => $index, 'success' => true, 'responseId' => $result['id'] ?? null];
                    $createdCount++;
                }
            } catch (\RuntimeException | \InvalidArgumentException $e) {
                $results[] = ['index' => $index, 'success' => false, 'message' => $e->getMessage()];
            } catch (\Exception $e) {
                $results[] = ['index' => $index, 'success' => false, 'message' => 'Internal error processing response'];
            }
        }

        $this->responseService->releaseFormLock($quotaLock);

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
            'limit' => max(1, min((int)($params['limit'] ?? 50), 1000)),
            'offset' => max(0, (int)($params['offset'] ?? 0)),
        ];

        $responses = $this->responseService->getFormResponses($args['formId'], $options);
        $responses = array_map([$this, 'sanitizeResponseData'], $responses);
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

        return $this->jsonResponse($response, ['response' => $this->sanitizeResponseData($formResponse)]);
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

        // Validate answers if provided
        if (isset($data['answers']) && is_array($data['answers'])) {
            // Drop calculated/unknown-field answers before validating/persisting.
            $data['answers'] = $this->sanitizeAnswers($form['fields'] ?? [], $data['answers']);
            $validationErrors = $this->validateAnswers($form['fields'] ?? [], $data['answers']);
            if (!empty($validationErrors)) {
                return $this->jsonResponse($response, [
                    'error' => true,
                    'message' => 'Validation failed',
                    'errors' => $validationErrors,
                ], 400);
            }
        }

        try {
            $formResponse = $this->responseService->updateResponse($args['formId'], $args['id'], $data);
            if (!$formResponse) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Response not found'], 404);
            }
            if (isset($data['answers']) && is_array($data['answers'])) {
                $this->responseService->syncResponseLinks($args['formId'], $args['id'], $form['fields'] ?? [], $data['answers']);
            }
            return $this->jsonResponse($response, ['response' => $this->sanitizeResponseData($formResponse)]);
        } catch (\RuntimeException | \InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Internal error updating response'], 500);
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
        $webhooks = array_map([$this, 'sanitizeWebhook'], $webhooks);
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

        if ($this->isBlockedWebhookHost($url)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Webhook URL host is not allowed'], 400);
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
        return $this->jsonResponse($response, ['webhook' => $this->sanitizeWebhook($webhook)], 201);
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
            $scheme = parse_url($data['url'], PHP_URL_SCHEME);
            if ($scheme !== 'https' && $scheme !== 'http') {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'URL must use http or https'], 400);
            }
            if ($this->isBlockedWebhookHost($data['url'])) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Webhook URL host is not allowed'], 400);
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

        // Only allow known fields to prevent mass-assignment
        $allowedFields = ['url', 'events', 'is_active', 'description'];
        $filtered = array_intersect_key($data, array_flip($allowedFields));
        $updated = $this->webhookService->updateWebhook($args['webhookId'], $filtered);
        return $this->jsonResponse($response, ['webhook' => $this->sanitizeWebhook($updated)]);
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
        unset($form['userId']);
        return $form;
    }

    /**
     * Strip answers for non-input field types and unknown field IDs.
     * Mirrors ResponseController::sanitizeAnswers logic.
     */
    private function sanitizeAnswers(array $fields, array $answers): array
    {
        if (!is_array($answers)) {
            return [];
        }

        $inputFieldIds = [];
        $nonInputTypes = ['calculated', 'statement', 'welcome_screen', 'thank_you'];
        foreach ($fields as $field) {
            $id = $field['id'] ?? null;
            if (!$id) {
                continue;
            }
            $type = $field['type'] ?? 'short_text';
            if (!in_array($type, $nonInputTypes, true)) {
                $inputFieldIds[$id] = true;
            }
        }

        $sanitized = [];
        foreach ($answers as $fieldId => $value) {
            if (isset($inputFieldIds[$fieldId])) {
                $sanitized[$fieldId] = $value;
            }
        }

        return $sanitized;
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
            if (in_array($fieldType, ['statement', 'welcome_screen', 'thank_you', 'calculated'], true)) continue;

            $isRequired = $field['required'] ?? false;
            $value = $answers[$fieldId] ?? null;

            $isEmpty = $value === null || $value === '' || $value === [] || (is_string($value) && trim($value) === '');

            if ($isRequired && $isEmpty) {
                $errors[$fieldId] = 'This field is required';
                continue;
            }

            if ($isEmpty) continue;

            // Scalar-typed fields must receive a scalar value; a submitted
            // array/object would otherwise reach preg_match() and throw an
            // uncaught TypeError. Reject cleanly as a validation error.
            $scalarTypes = ['short_text', 'long_text', 'email', 'url', 'number', 'phone', 'date', 'datetime', 'time'];
            if (in_array($fieldType, $scalarTypes, true) && !is_scalar($value)) {
                $errors[$fieldId] = 'Invalid value';
                continue;
            }

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

    /**
     * Strip internal fields from webhook data for external consumers.
     */
    private function sanitizeWebhook(array $webhook): array
    {
        unset($webhook['userId']);
        return $webhook;
    }

    /**
     * Strip PII (IP address, user agent) from response metadata for external consumers.
     */
    private function sanitizeResponseData(array $resp): array
    {
        if (isset($resp['metadata']) && is_array($resp['metadata'])) {
            unset($resp['metadata']['ipAddress']);
            unset($resp['metadata']['userAgent']);
        }
        return $resp;
    }

    private function isBlockedWebhookHost(string $url): bool
    {
        $host = strtolower(parse_url($url, PHP_URL_HOST) ?? '');
        $blockedHosts = [
            'localhost', '127.0.0.1', '169.254.169.254', 'metadata.google.internal',
            '0.0.0.0', '::1', '::ffff:127.0.0.1', '::ffff:0:127.0.0.1',
            '::ffff:169.254.169.254', '::ffff:0.0.0.0', 'metadata.azure.internal',
        ];
        if (in_array($host, $blockedHosts, true)) {
            return true;
        }
        // Block IP addresses in private/reserved ranges (covers both IPv4 and IPv6)
        if (filter_var($host, FILTER_VALIDATE_IP) && !filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
            return true;
        }
        // Resolve hostname and check if it points to a private/reserved IP
        if (!filter_var($host, FILTER_VALIDATE_IP)) {
            $resolved = gethostbyname($host);
            if ($resolved !== $host && filter_var($resolved, FILTER_VALIDATE_IP) && !filter_var($resolved, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
                return true;
            }
            $ipv6Records = dns_get_record($host, DNS_AAAA);
            if (is_array($ipv6Records)) {
                foreach ($ipv6Records as $record) {
                    $ip = $record['ipv6'] ?? '';
                    if ($ip !== '' && filter_var($ip, FILTER_VALIDATE_IP) && !filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
                        return true;
                    }
                }
            }
        }
        return false;
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
