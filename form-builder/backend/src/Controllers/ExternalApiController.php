<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\WebhookService;
use FormLogic\Services\ScriptRejection;
use FormLogic\Services\EmailService;
use FormLogic\Services\AuditService;
use FormLogic\Helpers\IpResolver;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

class ExternalApiController
{
    use JsonResponseTrait;

    private FormService $formService;
    private ResponseService $responseService;
    private WebhookService $webhookService;
    private IpResolver $ipResolver;
    private ?EmailService $emailService;
    private ?AuditService $auditService;
    private LoggerInterface $logger;
    /** For the submission-idempotency ledger (audit FL-001) — null disables it. */
    private ?\PDO $mysql;

    public function __construct(
        FormService $formService,
        ResponseService $responseService,
        WebhookService $webhookService,
        ?EmailService $emailService = null,
        ?AuditService $auditService = null,
        ?LoggerInterface $logger = null,
        ?\FormLogic\Database\MySQLConnection $mysql = null
    ) {
        $this->formService = $formService;
        $this->responseService = $responseService;
        $this->webhookService = $webhookService;
        $this->emailService = $emailService;
        $this->auditService = $auditService;
        $this->logger = $logger ?? new NullLogger();
        $this->ipResolver = IpResolver::fromEnvironment();
        $this->mysql = $mysql?->getConnection();
    }

    /** Best-effort "new response" email to the form owner (Notifications tab) — never fails the submit. */
    private function maybeNotifyNewResponse(array $form): void
    {
        if ($this->emailService === null) {
            return;
        }
        $notifications = $form['settings']['notifications'] ?? [];
        if (empty($notifications['emailNotifications']) || empty($notifications['notificationEmail'])) {
            return;
        }
        try {
            $rawTitle = (string) ($form['title'] ?? 'your form');
            $title = htmlspecialchars($rawTitle, ENT_QUOTES); // HTML body only
            $formId = (string) ($form['id'] ?? '');
            $html = "<p>You've received a new response on <strong>{$title}</strong> (via the API).</p>"
                . "<p>Sign in to FormLogic to view it in the form's responses.</p>"
                . ($formId !== '' ? "<p style=\"color:#888;font-size:12px\">Form ID: {$formId}</p>" : '');
            $this->emailService->send((string) $notifications['notificationEmail'], "New response: {$rawTitle}", $html);
        } catch (\Throwable $e) {
            $this->logger->warning('External-API new-response notification failed', ['error' => $e->getMessage()]);
        }
    }

    /** Audit log helper. The middleware sets `userId` to the API key's owner, so audits attribute correctly. */
    private function audit(Request $request, string $action, string $resourceId, array $details = []): void
    {
        if ($this->auditService === null) {
            return;
        }
        $userId = $request->getAttribute('userId');
        $ip = $this->ipResolver->getClientIp($request);
        $this->auditService->log($action, 'response', $resourceId, $userId, $ip, array_merge($details, [
            'via' => 'api',
            'apiKeyId' => $request->getAttribute('apiKeyId'),
        ]));
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

        // authorizeForm() already proved the API key's owner can write this form, so this is an
        // owner PROGRAMMATIC write (e.g. FormLogic Desktop populating an app's internal Calls form),
        // not a public submission. App-internal forms are typically 'draft' at the form level, so we
        // only block an explicitly ARCHIVED (retired) form here — the public/anon endpoints
        // (ResponseController, AppPublicController) still require 'published'.
        if (($form['status'] ?? '') === 'archived') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form is archived and not accepting responses'], 403);
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
        $data['answers'] = $this->responseService->normalizeAnswers($form['fields'] ?? [], $data['answers'], (string) ($form['id'] ?? ''));
        $data['answers'] = $this->responseService->applyCalculatedFields($form['fields'] ?? [], $data['answers']);
        $__fe = $this->responseService->validateFileAnswers($form['fields'] ?? [], $data['answers'], (string) ($form['id'] ?? ''));
        if (!empty($__fe)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Validation failed', 'errors' => $__fe], 400);
        }
        if ($this->responseService->answersTooLarge($data['answers'])) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Submission is too large.'], 413);
        }
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

        // Idempotency (audit FL-001/C-04): FormLogic Desktop's app-logic effects
        // stamp deterministic keys (applogic:<event>:<script>:<effect>), so a
        // replayed connector event — crash recovery, retried delivery, a second
        // runtime — returns the ORIGINAL response instead of writing a duplicate
        // record. Reserve→complete|release against form_submission_idempotency,
        // the same pattern (and table) as the public submit path.
        $idemKey = (isset($data['idempotencyKey']) && is_string($data['idempotencyKey'])
            && $data['idempotencyKey'] !== '' && strlen($data['idempotencyKey']) <= 128)
            ? $data['idempotencyKey'] : null;
        $ownsReservation = false;
        if ($idemKey !== null) {
            $payloadHash = hash('sha256', (string) json_encode($data['answers'] ?? []));
            $userId = $request->getAttribute('userId');
            $userId = (is_string($userId) && $userId !== '') ? $userId : null;
            $reserved = $this->idempotencyReserve($args['formId'], $userId, $idemKey, $payloadHash);
            if (is_array($reserved)) {
                if (($reserved['payload_hash'] ?? '') !== $payloadHash) {
                    return $this->jsonResponse($response, ['error' => true, 'conflict' => true,
                        'message' => 'This idempotency key was already used with a different submission.'], 409);
                }
                if (is_string($reserved['response_id'] ?? null) && $reserved['response_id'] !== '') {
                    return $this->jsonResponse($response, ['response' => ['id' => $reserved['response_id']], 'idempotent' => true], 200);
                }
                // Pending: young = a concurrent duplicate in flight; stale = an abandoned
                // reservation (owner crashed mid-request) — retake atomically like the
                // public path so a retried desktop effect can't wedge on 409 forever.
                $takenOver = false;
                try {
                    $del = $this->mysql?->prepare(
                        "DELETE FROM form_submission_idempotency
                         WHERE form_id = :f AND idempotency_key = :k
                           AND status = 'pending' AND created_at < (NOW() - INTERVAL 600 SECOND)"
                    );
                    $del?->execute(['f' => $args['formId'], 'k' => $idemKey]);
                    if ($del !== null && $del->rowCount() > 0) {
                        $takenOver = ($this->idempotencyReserve($args['formId'], $userId, $idemKey, $payloadHash) === 'owner');
                    }
                } catch (\Throwable $e) {
                    // best-effort takeover
                }
                if (!$takenOver) {
                    return $this->jsonResponse($response, ['error' => true, 'processing' => true,
                        'message' => 'This submission is already being processed. Please retry in a moment.'], 409);
                }
                $reserved = 'owner';
            }
            if ($reserved === 'unavailable') {
                // Audit FL-004/C-11: the ledger is the only duplicate gate for a replay —
                // fail CLOSED and retryable, never submit unprotected.
                return $this->jsonResponse($response, ['error' => true, 'retryable' => true,
                    'message' => 'The submission ledger is temporarily unavailable — please retry.'], 503);
            }
            $ownsReservation = true;
        }

        $createdId = null;
        try {
            // Atomic quota enforcement: re-check the count under a per-form lock so
            // concurrent submissions cannot both pass the earlier check and overshoot
            // the cap (the lock fails open under contention).
            $quotaLock = null;
            if (!empty($settings['quotaLimit'])) {
                $quotaLock = $this->responseService->acquireFormLock($args['formId']);
                if ($quotaLock === null) {
                    // Audit FL-004/C-11: no mutex → concurrent submissions could overshoot
                    // the hard cap. Fail closed + retryable.
                    return $this->jsonResponse($response, ['error' => true, 'retryable' => true,
                        'message' => 'The form is busy — please retry in a moment.'], 503);
                }
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

            // Parity with the public submit path: notify the owner + audit the create.
            $this->maybeNotifyNewResponse($form);
            $this->audit($request, 'response.create', $result['id'] ?? '', ['formId' => $args['formId']]);

            $createdId = is_string($result['id'] ?? null) ? $result['id'] : null;
            return $this->jsonResponse($response, ['response' => $result], 201);
        } catch (\RuntimeException | \InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Internal error processing response'], 500);
        } finally {
            if ($ownsReservation) {
                if (is_string($createdId) && $createdId !== '') {
                    $this->idempotencyComplete($args['formId'], $idemKey, $createdId);
                } else {
                    // Validation / quota / rejection / error: release so a genuine
                    // retry isn't poisoned by a stale 'pending' row.
                    $this->idempotencyRelease($args['formId'], $idemKey);
                }
            }
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

        // Owner programmatic batch write (see submitResponse): allow draft app-internal forms,
        // block only an archived form. Public endpoints still require 'published'.
        if (($form['status'] ?? '') === 'archived') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form is archived and not accepting responses'], 403);
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
        if ($quotaLimit > 0 && $quotaLock === null) {
            // Audit FL-004/C-11: the whole batch depends on this mutex for an
            // authoritative count — fail closed + retryable rather than overshoot.
            return $this->jsonResponse($response, ['error' => true, 'retryable' => true,
                'message' => 'The form is busy — please retry in a moment.'], 503);
        }
        if ($quotaLimit > 0) {
            $responseCount = $this->responseService->getResponseCount($args['formId']);
        }

        foreach ($items as $index => $item) {
            // A non-object item (e.g. a bare string/number) would throw a TypeError on
            // the array writes below — before the per-item try — and 500 the whole batch.
            // Record it as a per-item failure so valid items still process.
            if (!is_array($item)) {
                $results[] = ['index' => $index, 'success' => false, 'message' => 'Each response must be an object'];
                continue;
            }

            // Enforce quota per-item to prevent batch from exceeding limit
            if ($quotaLimit > 0 && ($responseCount + $createdCount) >= $quotaLimit) {
                $results[] = ['index' => $index, 'success' => false, 'message' => 'Quota limit reached'];
                continue;
            }

            // Sanitize answers: strip non-input fields and unknown field IDs
            $item['answers'] = $this->sanitizeAnswers($form['fields'] ?? [], $item['answers'] ?? []);
            $item['answers'] = $this->responseService->normalizeAnswers($form['fields'] ?? [], $item['answers'], (string) ($form['id'] ?? ''));
            $item['answers'] = $this->responseService->applyCalculatedFields($form['fields'] ?? [], $item['answers']);
            $itemFileErrors = $this->responseService->validateFileAnswers($form['fields'] ?? [], $item['answers'], (string) ($form['id'] ?? ''));
            if (!empty($itemFileErrors)) {
                $results[] = ['index' => $index, 'success' => false, 'errors' => $itemFileErrors];
                continue;
            }
            if ($this->responseService->answersTooLarge($item['answers'])) {
                $results[] = ['index' => $index, 'success' => false, 'errors' => ['Submission is too large.']];
                continue;
            }
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
                    $this->audit($request, 'response.create', $result['id'] ?? '', ['formId' => $args['formId'], 'batch' => true]);
                    $createdCount++;
                }
            } catch (\RuntimeException | \InvalidArgumentException $e) {
                $results[] = ['index' => $index, 'success' => false, 'message' => $e->getMessage()];
            } catch (\Exception $e) {
                $results[] = ['index' => $index, 'success' => false, 'message' => 'Internal error processing response'];
            }
        }

        $this->responseService->releaseFormLock($quotaLock);

        // One owner notification for the whole batch (avoids N emails for N responses).
        if ($createdCount > 0) {
            $this->maybeNotifyNewResponse($form);
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
        // Server-side answer-equality filters (audit AOK-FLOW-001):
        // ?answers.<fieldId>=<value> — ANDed; used by the flow runners so an
        // exact lookup (call_id, phone, …) is a database query, not a scan of
        // the newest N rows. NOTE: PHP parses '.' in query keys to '_', so
        // accept both spellings ('answers.call_id' arrives as 'answers_call_id').
        $answersEq = [];
        foreach ($params as $k => $v) {
            if (is_string($v) && (str_starts_with((string) $k, 'answers.') || str_starts_with((string) $k, 'answers_'))) {
                $answersEq[substr((string) $k, 8)] = $v;
            }
        }
        $options = [
            'status' => $params['status'] ?? null,
            'from' => $params['from'] ?? null,
            'to' => $params['to'] ?? null,
            'answersEq' => $answersEq,
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

        // Normalize: an empty/non-JSON body parses to null, which would raise an
        // uncaught \TypeError (HTTP 500) when passed to the array-typed service.
        $data = $request->getParsedBody() ?? [];

        // Validate answers if provided
        if (isset($data['answers']) && is_array($data['answers'])) {
            // PATCH semantics: callers (API clients, FormLogic Desktop app-logic + flow output
            // actions) send only the fields they change. Merge the patch over the STORED answers
            // before validating so a partial update like {status, ended_at} isn't rejected for
            // omitting an unrelated required field. Mirrors AppPublicController::updateResponseById.
            $existing = $this->responseService->getResponse($args['formId'], $args['id']);
            $existingAnswers = is_array($existing['answers'] ?? null) ? $existing['answers'] : [];
            $data['answers'] = array_merge($existingAnswers, $data['answers']);
            // Drop calculated/unknown-field answers before validating/persisting.
            $data['answers'] = $this->sanitizeAnswers($form['fields'] ?? [], $data['answers']);
            $data['answers'] = $this->responseService->normalizeAnswers($form['fields'] ?? [], $data['answers'], (string) ($form['id'] ?? ''));
            $data['answers'] = $this->responseService->applyCalculatedFields($form['fields'] ?? [], $data['answers']);
            $__fe = $this->responseService->validateFileAnswers($form['fields'] ?? [], $data['answers'], (string) ($form['id'] ?? ''));
            if (!empty($__fe)) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Validation failed', 'errors' => $__fe], 400);
            }
            if ($this->responseService->answersTooLarge($data['answers'])) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Submission is too large.'], 413);
            }
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
            // Only echo the full record (response contents / PII) when the key ALSO holds
            // responses:read. A responses:manage-only key gets just an acknowledgement, so the update
            // endpoint can't be used to read content that would otherwise require responses:read.
            $scopes = $request->getAttribute('apiKeyScopes');
            $canRead = is_array($scopes) && in_array('responses:read', $scopes, true);
            return $this->jsonResponse($response, $canRead
                ? ['response' => $this->sanitizeResponseData($formResponse)]
                : ['success' => true, 'id' => $args['id']]);
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
        // The owner's private notification settings (e.g. notificationEmail) are
        // not for external consumers.
        if (isset($form['settings']) && is_array($form['settings'])) {
            unset($form['settings']['notifications']);
        }
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
        $nonInputTypes = ['calculated', 'statement', 'welcome_screen', 'thank_you', 'hidden'];
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

        // Honor conditional visibility (same as the public path) so a
        // conditionally-hidden required field doesn't reject a valid submission.
        $visibility = $this->responseService->computeFieldVisibility($fields, $answers);

        foreach ($fields as $field) {
            $fieldId = $field['id'] ?? null;
            if (!$fieldId) continue;

            $fieldType = $field['type'] ?? 'short_text';
            if (in_array($fieldType, ['statement', 'welcome_screen', 'thank_you', 'calculated', 'hidden'], true)) continue;

            $fieldVis = $visibility[$fieldId] ?? ['visible' => true, 'required' => (bool)($field['required'] ?? false)];
            if (!$fieldVis['visible']) continue;

            $isRequired = $fieldVis['required'];
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

            // Generic oversized-scalar guard (mirrors the public path's 100k cap).
            if (is_scalar($value) && strlen((string) $value) > 100000) {
                $errors[$fieldId] = 'Value is too long';
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
                    } elseif (strlen((string) $value) > 64) {
                        $errors[$fieldId] = 'Number is too long';
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
                        if (count($value) > max(count($allowedValues), 1)) {
                            $errors[$fieldId] = 'Too many selections';
                        } else {
                            foreach ($value as $selected) {
                                if (!in_array($selected, $allowedValues, true)) {
                                    $errors[$fieldId] = 'Invalid selection';
                                    break;
                                }
                            }
                        }
                    }
                    break;
                case 'location':
                    if (!is_array($value)) {
                        $errors[$fieldId] = 'Invalid location format';
                    } elseif (!isset($value['latitude'], $value['longitude'])) {
                        $errors[$fieldId] = 'Location must include latitude and longitude';
                    } elseif (!is_numeric($value['latitude']) || !is_numeric($value['longitude'])) {
                        $errors[$fieldId] = 'Latitude and longitude must be numbers';
                    } elseif ($value['latitude'] < -90 || $value['latitude'] > 90) {
                        $errors[$fieldId] = 'Latitude must be between -90 and 90';
                    } elseif ($value['longitude'] < -180 || $value['longitude'] > 180) {
                        $errors[$fieldId] = 'Longitude must be between -180 and 180';
                    }
                    break;
                case 'file_upload':
                    if (!is_array($value)) {
                        $errors[$fieldId] = 'Invalid file upload format';
                    } else {
                        $props = $field['properties'] ?? [];
                        $maxFiles = $props['maxFiles'] ?? 20;
                        if (empty($props['allowMultiple']) && count($value) > 1) {
                            $errors[$fieldId] = 'Only one file is allowed for this field';
                        } elseif (count($value) > $maxFiles) {
                            $errors[$fieldId] = "Maximum of {$maxFiles} files allowed";
                        } else {
                            foreach ($value as $item) {
                                if (!is_array($item) || !isset($item['id']) || !isset($item['originalFilename'])) {
                                    $errors[$fieldId] = 'Invalid file metadata';
                                    break;
                                }
                                // Filename must be a string within the 255-char cap (mirrors the public path).
                                if (!is_string($item['originalFilename']) || strlen($item['originalFilename']) > 255) {
                                    $errors[$fieldId] = 'Invalid file name';
                                    break;
                                }
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

            // Builder-configured rules (min/maxLength, min/max, pattern, number bounds, date format)
            if (!isset($errors[$fieldId])) {
                $ruleError = $this->responseService->validateFieldRules($field, $value);
                if ($ruleError) {
                    $errors[$fieldId] = $ruleError;
                }
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
    /**
     * Submission-idempotency trio (audit FL-001): a DELIBERATE hand-kept duplicate of
     * ResponseController's form_submission_idempotency helpers (which in turn mirror
     * AppPublicController's app-scoped set) — same reserve-first-via-unique-constraint
     * design, same payload-hash conflict detection, same 600-second stale takeover.
     * If the pattern changes, update all three by hand (kept unshared on purpose).
     *
     * @return string|array<string,mixed>
     */
    private function idempotencyReserve(string $formId, ?string $userId, string $key, string $payloadHash)
    {
        if ($this->mysql === null) {
            return 'unavailable';
        }
        try {
            $stmt = $this->mysql->prepare(
                "INSERT INTO form_submission_idempotency (id, form_id, user_id, idempotency_key, response_id, payload_hash, status, created_at)
                 VALUES (:id, :f, :u, :k, NULL, :h, 'pending', NOW())"
            );
            $stmt->execute([
                'id' => $this->uuidV4(),
                'f' => $formId, 'u' => $userId, 'k' => $key, 'h' => $payloadHash,
            ]);
            return 'owner';
        } catch (\PDOException $e) {
            $dup = $e->getCode() === '23000' || (isset($e->errorInfo[1]) && (int) $e->errorInfo[1] === 1062);
            if ($dup) {
                return $this->idempotencyFind($formId, $key) ?? 'unavailable';
            }
            return 'unavailable';
        }
    }

    /** @return array{response_id:?string, payload_hash:string, status:string}|null */
    private function idempotencyFind(string $formId, string $key): ?array
    {
        $stmt = $this->mysql->prepare(
            "SELECT response_id, payload_hash, status FROM form_submission_idempotency
             WHERE form_id = :f AND idempotency_key = :k LIMIT 1"
        );
        $stmt->execute(['f' => $formId, 'k' => $key]);
        $row = $stmt->fetch(\PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            return null;
        }
        return [
            'response_id' => is_string($row['response_id'] ?? null) ? $row['response_id'] : null,
            'payload_hash' => (string) ($row['payload_hash'] ?? ''),
            'status' => (string) ($row['status'] ?? ''),
        ];
    }

    /** Mark a reservation completed, pointing it at the created response. Best-effort.
     *  Only completes a row we still hold ('pending'): if a slow original ran past the
     *  600s window and another runtime took the reservation over and already completed
     *  it, the original must NOT regress the ledger back to its (duplicate) response. */
    private function idempotencyComplete(string $formId, string $key, string $responseId): void
    {
        if ($this->mysql === null) {
            return;
        }
        try {
            $stmt = $this->mysql->prepare(
                "UPDATE form_submission_idempotency SET response_id = :r, status = 'completed'
                 WHERE form_id = :f AND idempotency_key = :k AND status = 'pending'"
            );
            $stmt->execute(['r' => $responseId, 'f' => $formId, 'k' => $key]);
        } catch (\Throwable $e) {
            // ignore — the response is already persisted.
        }
    }

    /** Release an unfulfilled reservation (only our own 'pending' row) so a retry can proceed. */
    private function idempotencyRelease(string $formId, string $key): void
    {
        if ($this->mysql === null) {
            return;
        }
        try {
            $stmt = $this->mysql->prepare(
                "DELETE FROM form_submission_idempotency
                 WHERE form_id = :f AND idempotency_key = :k AND status = 'pending'"
            );
            $stmt->execute(['f' => $formId, 'k' => $key]);
        } catch (\Throwable $e) {
            // ignore
        }
    }

    private function uuidV4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
