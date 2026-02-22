<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\ResponseService;
use FormLogic\Services\FormService;
use FormLogic\Services\ScriptRejection;
use FormLogic\Services\AuditService;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Helpers\IpResolver;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

class ResponseController
{
    private ResponseService $responseService;
    private FormService $formService;
    private SQLiteConnection $sqlite;
    private IpResolver $ipResolver;
    private LoggerInterface $logger;
    private ?AuditService $auditService;

    public function __construct(ResponseService $responseService, FormService $formService, SQLiteConnection $sqlite, ?LoggerInterface $logger = null, ?AuditService $auditService = null)
    {
        $this->responseService = $responseService;
        $this->formService = $formService;
        $this->sqlite = $sqlite;
        $this->ipResolver = IpResolver::fromEnvironment();
        $this->logger = $logger ?? new NullLogger();
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
     * List all responses for a form
     * GET /api/forms/{formId}/responses
     */
    public function index(Request $request, Response $response, array $args): Response
    {
        $formId = $args['formId'];

        // Authorization check - user must own the form to view responses
        $form = $this->authorizeFormAccess($request, $formId);
        if (!$form) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Form not found or access denied',
            ], 404);
        }

        $queryParams = $request->getQueryParams();
        $options = [
            'status' => $queryParams['status'] ?? null,
            'from' => $queryParams['from'] ?? null,
            'to' => $queryParams['to'] ?? null,
            'limit' => max(1, min((int)($queryParams['limit'] ?? 100), 1000)),
            'offset' => max(0, (int)($queryParams['offset'] ?? 0)),
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

        // Authorization check - user must own the form
        $form = $this->authorizeFormAccess($request, $formId);
        if (!$form) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Form not found or access denied',
            ], 404);
        }

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

        // Validate answers against form fields
        $validationErrors = $this->validateAnswers($form['fields'] ?? [], $data['answers'] ?? []);
        if (!empty($validationErrors)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Validation failed',
                'errors' => $validationErrors,
            ], 400);
        }

        // Add request metadata
        $serverParams = $request->getServerParams();
        $data['ipAddress'] = $this->getClientIp($request);
        $data['userAgent'] = substr($request->getHeaderLine('User-Agent'), 0, 500); // Limit length
        $data['referrer'] = substr($request->getHeaderLine('Referer'), 0, 2000); // Limit length

        // Get the script from the form (if any)
        $script = $form['logicScript'] ?? null;

        try {
            $result = $this->responseService->createResponse($formId, $data, $script);

            // Handle rejection from script
            if ($result instanceof ScriptRejection) {
                return $this->jsonResponse($response, [
                    'error' => true,
                    'message' => $result->message,
                    'rejected' => true,
                ], 422);
            }

            $this->audit($request, 'response.create', 'response', $result['id'] ?? '', ['formId' => $formId]);
            return $this->jsonResponse($response, ['response' => $result], 201);
        } catch (\RuntimeException | \InvalidArgumentException $e) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => $e->getMessage(),
            ], 400);
        } catch (\Exception $e) {
            $this->logger->error('Response creation error', ['exception' => $e->getMessage()]);
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'An unexpected error occurred',
            ], 500);
        }
    }

    /**
     * Validate answers against form field definitions
     *
     * @param array $fields Form field definitions
     * @param array $answers Submitted answers
     * @return array Validation errors (empty if valid)
     */
    private function validateAnswers(array $fields, array $answers): array
    {
        $errors = [];

        // Create a map of field IDs to field definitions
        $fieldMap = [];
        foreach ($fields as $field) {
            if (isset($field['id'])) {
                $fieldMap[$field['id']] = $field;
            }
        }

        // Check required fields
        foreach ($fields as $field) {
            $fieldId = $field['id'] ?? null;
            if (!$fieldId) {
                continue;
            }

            $isRequired = $field['required'] ?? false;
            $fieldType = $field['type'] ?? 'short_text';

            // Skip validation for non-input field types
            if (in_array($fieldType, ['statement', 'welcome_screen', 'thank_you'], true)) {
                continue;
            }

            $value = $answers[$fieldId] ?? null;

            // Check required fields
            if ($isRequired && $this->isEmpty($value)) {
                $errors[$fieldId] = 'This field is required';
                continue;
            }

            // Skip further validation if empty and not required
            if ($this->isEmpty($value)) {
                continue;
            }

            // Type-specific validation
            $typeError = $this->validateFieldType($field, $value);
            if ($typeError) {
                $errors[$fieldId] = $typeError;
            }
        }

        // Check for unknown fields (potential injection attempt)
        foreach ($answers as $fieldId => $value) {
            if (!isset($fieldMap[$fieldId])) {
                // Unknown field - could be injection attempt, silently ignore
                // but log for monitoring
                $this->logger->warning('Unknown field submitted', ['fieldId' => $fieldId]);
            }
        }

        return $errors;
    }

    /**
     * Check if a value is considered empty
     */
    private function isEmpty($value): bool
    {
        if ($value === null || $value === '' || $value === []) {
            return true;
        }
        if (is_string($value) && trim($value) === '') {
            return true;
        }
        return false;
    }

    /**
     * Validate a field value against its type
     */
    private function validateFieldType(array $field, $value): ?string
    {
        $type = $field['type'] ?? 'short_text';

        switch ($type) {
            case 'email':
                if (!filter_var($value, FILTER_VALIDATE_EMAIL)) {
                    return 'Invalid email address';
                }
                break;

            case 'url':
                if (!filter_var($value, FILTER_VALIDATE_URL)) {
                    return 'Invalid URL';
                }
                break;

            case 'number':
                if (!is_numeric($value)) {
                    return 'Must be a number';
                }
                break;

            case 'phone':
                // Accept E.164 format (+[1-9]...) or legacy loose format
                if (!preg_match('/^\+[1-9]\d{6,14}$/', $value) &&
                    !preg_match('/^[\d\s\-\+\(\)\.]+$/', $value)) {
                    return 'Invalid phone number format';
                }
                break;

            case 'date':
            case 'datetime':
            case 'time':
                // Basic date/time validation
                if (is_string($value) && strlen($value) > 100) {
                    return 'Invalid date/time format';
                }
                break;

            case 'rating':
                $properties = $field['properties'] ?? [];
                $maxStars = $properties['maxStars'] ?? 5;
                if (!is_numeric($value) || $value < 1 || $value > $maxStars) {
                    return "Rating must be between 1 and {$maxStars}";
                }
                break;

            case 'scale':
                $properties = $field['properties'] ?? [];
                $min = $properties['scaleStart'] ?? 1;
                $max = $properties['scaleEnd'] ?? 10;
                if (!is_numeric($value) || $value < $min || $value > $max) {
                    return "Value must be between {$min} and {$max}";
                }
                break;

            case 'dropdown':
            case 'multiple_choice':
                // Validate against allowed options
                $properties = $field['properties'] ?? [];
                $options = $properties['options'] ?? [];
                $allowedValues = array_column($options, 'value');
                if (!in_array($value, $allowedValues, true)) {
                    return 'Invalid selection';
                }
                break;

            case 'checkboxes':
                // For checkboxes, value should be an array
                if (!is_array($value)) {
                    return 'Invalid selection format';
                }
                $properties = $field['properties'] ?? [];
                $options = $properties['options'] ?? [];
                $allowedValues = array_column($options, 'value');
                foreach ($value as $selected) {
                    if (!in_array($selected, $allowedValues, true)) {
                        return 'Invalid selection';
                    }
                }
                break;

            case 'short_text':
            case 'long_text':
                // Enforce reasonable length limits
                if (is_string($value)) {
                    $maxLength = $type === 'short_text' ? 1000 : 50000;
                    if (strlen($value) > $maxLength) {
                        return "Text exceeds maximum length of {$maxLength} characters";
                    }
                }
                break;
        }

        return null;
    }

    /**
     * Get client IP address from request securely.
     *
     * Uses IpResolver which only trusts X-Forwarded-For headers when the
     * request comes from a configured trusted proxy. This prevents IP spoofing
     * attacks where attackers send fake X-Forwarded-For headers.
     *
     * To configure trusted proxies, set the TRUSTED_PROXIES environment variable
     * to a comma-separated list of IP addresses or CIDR ranges.
     * Example: TRUSTED_PROXIES=10.0.0.0/8,172.16.0.1
     */
    private function getClientIp(Request $request): string
    {
        return $this->ipResolver->getClientIp($request);
    }

    /**
     * Update a response (status, answers, etc.)
     * PUT /api/forms/{formId}/responses/{id}
     */
    public function update(Request $request, Response $response, array $args): Response
    {
        $formId = $args['formId'];
        $responseId = $args['id'];

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
            $formResponse = $this->responseService->updateResponse($formId, $responseId, $data);

            if (!$formResponse) {
                return $this->jsonResponse($response, [
                    'error' => true,
                    'message' => 'Response not found',
                ], 404);
            }

            return $this->jsonResponse($response, ['response' => $formResponse]);
        } catch (\RuntimeException | \InvalidArgumentException $e) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => $e->getMessage(),
            ], 400);
        } catch (\Exception $e) {
            $this->logger->error('Response update error', ['exception' => $e->getMessage()]);
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'An unexpected error occurred',
            ], 500);
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

        // Authorization check - user must own the form
        $form = $this->authorizeFormAccess($request, $formId);
        if (!$form) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Form not found or access denied',
            ], 404);
        }

        $deleted = $this->responseService->deleteResponse($formId, $responseId);

        if (!$deleted) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Response not found',
            ], 404);
        }

        $this->audit($request, 'response.delete', 'response', $responseId, ['formId' => $formId]);

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

        // Authorization check - user must own the form
        $form = $this->authorizeFormAccess($request, $formId);
        if (!$form) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Form not found or access denied',
            ], 404);
        }

        $queryParams = $request->getQueryParams();
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

        // Authorization check - user must own the form
        $form = $this->authorizeFormAccess($request, $formId);
        if (!$form) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Form not found or access denied',
            ], 404);
        }

        $this->audit($request, 'response.export', 'form', $formId, ['format' => 'csv']);

        // Stream CSV in batches to avoid loading all responses into memory
        $filename = $this->sanitizeFilename($form['title']) . '-responses.csv';
        $stream = fopen('php://temp', 'r+');
        $this->responseService->exportResponsesStreaming($formId, $form['fields'], $stream);
        rewind($stream);

        $body = new \Slim\Psr7\Stream($stream);

        return $response
            ->withBody($body)
            ->withHeader('Content-Type', 'text/csv')
            ->withHeader('Content-Disposition', 'attachment; filename="' . $filename . '"');
    }

    /**
     * Re-run script on an existing response
     * POST /api/forms/{formId}/responses/{id}/recompute
     */
    public function recompute(Request $request, Response $response, array $args): Response
    {
        $formId = $args['formId'];
        $responseId = $args['id'];

        // Authorization check - user must own the form
        $form = $this->authorizeFormAccess($request, $formId);
        if (!$form) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Form not found or access denied',
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
            $this->logger->error('Recompute error', ['exception' => $e->getMessage()]);
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'An unexpected error occurred',
            ], 500);
        }
    }

    /**
     * Import CSV responses
     * POST /api/forms/{formId}/responses/import
     */
    public function importCsv(Request $request, Response $response, array $args): Response
    {
        $formId = $args['formId'];

        // Authorization check - user must own the form
        $form = $this->authorizeFormAccess($request, $formId);
        if (!$form) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Form not found or access denied',
            ], 404);
        }

        // Use $_FILES to access the uploaded file (Slim may not parse multipart for files)
        if (empty($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'No CSV file uploaded or upload error',
            ], 400);
        }

        $file = $_FILES['file'];

        // Validate file extension
        $extension = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
        if ($extension !== 'csv') {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Only .csv files are allowed',
            ], 400);
        }

        // Validate file size (max 5MB)
        if ($file['size'] > 5 * 1024 * 1024) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'File size exceeds 5MB limit',
            ], 400);
        }

        // Parse CSV
        $handle = fopen($file['tmp_name'], 'r');
        if ($handle === false) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Failed to open CSV file',
            ], 400);
        }

        // Strip UTF-8 BOM if present (Excel on Windows adds this)
        $bom = fread($handle, 3);
        if ($bom !== "\xEF\xBB\xBF") {
            rewind($handle);
        }

        $headers = fgetcsv($handle);
        if ($headers === false || empty($headers)) {
            fclose($handle);
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'CSV file is empty or has no headers',
            ], 400);
        }

        // Read all data rows
        $rows = [];
        while (($row = fgetcsv($handle)) !== false) {
            if (count($row) === count($headers)) {
                $rows[] = array_combine($headers, $row);
            } elseif (count($row) > 0 && !(count($row) === 1 && trim($row[0]) === '')) {
                // Pad or trim to match header count
                $padded = array_pad($row, count($headers), '');
                $rows[] = array_combine($headers, array_slice($padded, 0, count($headers)));
            }
        }
        fclose($handle);

        // Validate row count (between 1 and 1000 data rows)
        if (count($rows) === 0) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'CSV file contains no data rows',
            ], 400);
        }

        if (count($rows) > 1000) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'CSV file exceeds maximum of 1000 data rows',
            ], 400);
        }

        // Check if columnMapping is provided
        $parsedBody = $request->getParsedBody();
        $columnMappingJson = $parsedBody['columnMapping'] ?? null;

        if ($columnMappingJson === null) {
            // No mapping provided - return preview data for the frontend mapping step
            $previewRows = array_slice($rows, 0, 5);

            // Build fields array from form
            $fields = [];
            foreach ($form['fields'] as $field) {
                if (in_array($field['type'] ?? '', ['welcome_screen', 'thank_you', 'statement'], true)) {
                    continue;
                }
                $fields[] = [
                    'id' => $field['id'],
                    'label' => $field['label'] ?? $field['id'],
                    'type' => $field['type'] ?? 'short_text',
                ];
            }

            return $this->jsonResponse($response, [
                'headers' => $headers,
                'rowCount' => count($rows),
                'previewRows' => $previewRows,
                'fields' => $fields,
            ]);
        }

        // Column mapping provided - perform the import
        $columnMapping = json_decode($columnMappingJson, true);
        if (!is_array($columnMapping)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Invalid column mapping format',
            ], 400);
        }

        // Validate mapped field IDs exist in the form
        $validFieldIds = [];
        foreach ($form['fields'] as $field) {
            $validFieldIds[$field['id']] = true;
        }
        foreach ($columnMapping as $csvCol => $fieldId) {
            if ($fieldId !== 'skip' && $fieldId !== '' && !isset($validFieldIds[$fieldId])) {
                return $this->jsonResponse($response, [
                    'error' => true,
                    'message' => "Invalid field ID in column mapping: {$fieldId}",
                ], 400);
            }
        }

        try {
            $result = $this->responseService->importResponses(
                $formId,
                $rows,
                $columnMapping,
                $form['fields']
            );

            $this->audit($request, 'response.import', 'form', $formId, [
                'created' => $result['created'],
                'skipped' => $result['skipped'],
                'total' => $result['total'],
            ]);

            return $this->jsonResponse($response, $result);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => $e->getMessage(),
            ], 400);
        } catch (\Exception $e) {
            $this->logger->error('CSV import error', ['exception' => $e->getMessage()]);
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'An unexpected error occurred during import',
            ], 500);
        }
    }

    private function audit(Request $request, string $action, string $resourceType, string $resourceId, array $details = []): void
    {
        if ($this->auditService === null) return;
        $userId = $request->getAttribute('userId');
        $ip = $this->ipResolver->getClientIp($request);
        $this->auditService->log($action, $resourceType, $resourceId, $userId, $ip, $details);
    }

    /**
     * Helper to create JSON responses
     */
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

    /**
     * Sanitize filename for download
     */
    private function sanitizeFilename(string $filename): string
    {
        return preg_replace('/[^a-zA-Z0-9\-_]/', '-', $filename);
    }

    /**
     * Download SQLite database file
     * GET /api/forms/{formId}/export/sqlite
     */
    public function exportSqlite(Request $request, Response $response, array $args): Response
    {
        $formId = $args['formId'];

        // Authorization check - user must own the form
        $form = $this->authorizeFormAccess($request, $formId);
        if (!$form) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Form not found or access denied',
            ], 404);
        }

        // Check if SQLite database exists
        if (!$this->sqlite->formDatabaseExists($formId)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'No data found for this form',
            ], 404);
        }

        $dbPath = $this->sqlite->getFormDbPath($formId);
        $filename = $this->sanitizeFilename($form['title']) . '.sqlite';

        // Verify file exists and get size
        if (!is_file($dbPath)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Database file not found',
            ], 404);
        }

        $fileSize = filesize($dbPath);
        if ($fileSize === false) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Failed to read database file size',
            ], 500);
        }

        // Stream file contents to avoid memory exhaustion for large files
        $stream = fopen($dbPath, 'rb');
        if ($stream === false) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Failed to open database file',
            ], 500);
        }

        // Create a PSR-7 stream from the file handle
        $body = new \Slim\Psr7\Stream($stream);

        return $response
            ->withBody($body)
            ->withHeader('Content-Type', 'application/x-sqlite3')
            ->withHeader('Content-Disposition', 'attachment; filename="' . $filename . '"')
            ->withHeader('Content-Length', (string)$fileSize);
    }

    /**
     * Export form data as JSON
     * GET /api/forms/{formId}/export/json
     */
    public function exportJson(Request $request, Response $response, array $args): Response
    {
        $formId = $args['formId'];

        // Authorization check - user must own the form
        $form = $this->authorizeFormAccess($request, $formId);
        if (!$form) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Form not found or access denied',
            ], 404);
        }

        // Stream JSON to avoid loading all responses into memory at once
        $filename = $this->sanitizeFilename($form['title']) . '-export.json';
        $body = $response->getBody();

        $formMeta = json_encode([
            'id' => $form['id'],
            'title' => $form['title'],
            'description' => $form['description'],
            'status' => $form['status'],
            'fields' => $form['fields'],
            'settings' => $form['settings'],
            'theme' => $form['theme'],
            'createdAt' => $form['createdAt'],
            'updatedAt' => $form['updatedAt'],
        ], JSON_UNESCAPED_UNICODE);

        $body->write('{"exportedAt":' . json_encode(date('c')));
        $body->write(',"form":' . $formMeta);
        $body->write(',"responses":[');

        // Fetch responses in batches to limit memory usage
        $batchSize = 500;
        $offset = 0;
        $totalWritten = 0;
        $isFirst = true;

        do {
            $batch = $this->responseService->getFormResponses($formId, [
                'limit' => $batchSize,
                'offset' => $offset,
            ]);

            foreach ($batch as $resp) {
                if (!$isFirst) {
                    $body->write(',');
                }
                $body->write(json_encode($resp, JSON_UNESCAPED_UNICODE));
                $isFirst = false;
                $totalWritten++;
            }

            $offset += $batchSize;
        } while (count($batch) === $batchSize);

        $body->write('],"meta":' . json_encode([
            'totalResponses' => $totalWritten,
            'version' => '1.0',
        ]) . '}');

        return $response
            ->withHeader('Content-Type', 'application/json')
            ->withHeader('Content-Disposition', 'attachment; filename="' . $filename . '"');
    }
}
