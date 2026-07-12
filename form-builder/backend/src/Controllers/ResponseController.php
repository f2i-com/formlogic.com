<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\SubmissionIdempotencyService;

use FormLogic\Helpers\RelatedRecords;
use FormLogic\Services\ResponseService;
use FormLogic\Services\FormService;
use FormLogic\Services\AppService;
use FormLogic\Services\EmailService;
use FormLogic\Services\ScriptRejection;
use FormLogic\Services\AuditService;
use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Helpers\IpResolver;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;
use PDO;

class ResponseController
{
    use JsonResponseTrait;

    // Hard ceiling on the serialized answers of a single submission, so an
    // unauthenticated client can't write arbitrarily large blobs into the per-form
    // SQLite store (disk-exhaustion DoS). Generous for any real form.
    private const MAX_ANSWER_BYTES = 2_000_000; // ~2 MB

    private ResponseService $responseService;
    private FormService $formService;
    private SQLiteConnection $sqlite;
    private IpResolver $ipResolver;
    private LoggerInterface $logger;
    private ?AuditService $auditService;
    private ?EmailService $emailService;
    private ?AppService $appService;
    // Idempotency ledger connection for the classic public submission endpoint (create()). Nullable
    // so a caller that can't supply a MySQLConnection (e.g. a narrow unit test) still gets a working
    // controller — the idempotency ledger (SubmissionIdempotencyService) fails open when null.
    private ?PDO $mysql;

    public function __construct(ResponseService $responseService, FormService $formService, SQLiteConnection $sqlite, ?LoggerInterface $logger = null, ?AuditService $auditService = null, ?EmailService $emailService = null, ?AppService $appService = null, ?MySQLConnection $mysql = null)
    {
        $this->responseService = $responseService;
        $this->formService = $formService;
        $this->sqlite = $sqlite;
        $this->ipResolver = IpResolver::fromEnvironment();
        $this->logger = $logger ?? new NullLogger();
        $this->auditService = $auditService;
        $this->emailService = $emailService;
        $this->appService = $appService;
        $this->mysql = $mysql?->getConnection();
    }

    /**
     * Send a best-effort "new response" email to the form's configured
     * notification address when the Notifications tab has it enabled. Never
     * throws — a notification failure must not affect the submission.
     */
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
            $to = (string) $notifications['notificationEmail'];
            $rawTitle = (string) ($form['title'] ?? 'your form');
            $title = htmlspecialchars($rawTitle, ENT_QUOTES); // for the HTML body only
            $formId = (string) ($form['id'] ?? '');
            $html = "<p>You've received a new response on <strong>{$title}</strong>.</p>"
                . "<p>Sign in to FormLogic to view it in the form's responses.</p>"
                . ($formId !== '' ? "<p style=\"color:#888;font-size:12px\">Form ID: {$formId}</p>" : '');
            // Subject is plaintext (EmailService strips CR/LF) — use the raw title so HTML entities
            // don't show literally (e.g. "Tom &amp; Jerry").
            $this->emailService->send($to, "New response: {$rawTitle}", $html);
        } catch (\Throwable $e) {
            $this->logger->warning('New-response notification failed', ['error' => $e->getMessage()]);
        }
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
     * Resolve linked_record fields into human-readable display labels for the owner-scoped
     * responses view. Injects `_resolved[fieldId] = {id, display}` (or an array for multi-link)
     * so the UI can show the referenced record's name instead of a raw UUID / "[linked record]".
     *
     * Owner-scoped: the target form must belong to the SAME user (a cross-tenant guard in case a
     * field's targetFormId was tampered) — no app RBAC applies here since the owner sees all their
     * own data. Records are batch-loaded per target form to avoid an N+1.
     *
     * @param array<int,array<string,mixed>> $responses
     * @param array<string,mixed> $form
     * @return array<int,array<string,mixed>>
     */
    private function resolveLinkedRecords(array $responses, array $form, string $userId): array
    {
        $linkedFields = [];
        foreach ($form['fields'] ?? [] as $field) {
            if (($field['type'] ?? '') === 'linked_record' && !empty($field['properties']['targetFormId'])) {
                $linkedFields[] = $field;
            }
        }
        if (empty($linkedFields) || empty($responses)) {
            return $responses;
        }

        // Collect referenced response ids, grouped by target form.
        $refsByForm = []; // targetFormId => [responseId => true]
        foreach ($responses as $resp) {
            $answers = $resp['answers'] ?? [];
            foreach ($linkedFields as $field) {
                $targetFormId = $field['properties']['targetFormId'];
                $val = $answers[$field['id']] ?? null;
                if ($val === null || $val === '') {
                    continue;
                }
                foreach ((array) $val as $id) {
                    if (is_string($id) && $id !== '') {
                        $refsByForm[$targetFormId][$id] = true;
                    }
                }
            }
        }

        // Match-based FORWARD resolution (single-record detail only, to keep list
        // payloads cheap — parity with the app runtime's resolver): a linked_record
        // field with properties.matchField whose stored answer is EMPTY — flow-/
        // logic-written rows never set the picker value — resolves its target by the
        // shared join key (e.g. a transcript turn's call_id → its Call), so the child
        // record links back to its parent. Newest match wins; the synthesized target
        // goes into _resolved only, the stored answer stays empty.
        $matchResolved = []; // respIndex => fieldId => targetResponseId
        if (count($responses) === 1) {
            foreach ($responses as $ri => $resp) {
                $answers = $resp['answers'] ?? [];
                foreach ($linkedFields as $field) {
                    $props = $field['properties'] ?? [];
                    $targetFormId = (string) $props['targetFormId'];
                    $matchField = $props['matchField'] ?? null;
                    if (!is_string($matchField) || $matchField === '') {
                        continue;
                    }
                    $existing = $answers[$field['id']] ?? null;
                    if ($existing !== null && $existing !== '' && $existing !== []) {
                        continue;
                    }
                    $key = $answers[$matchField] ?? null;
                    if (!is_scalar($key)) {
                        continue;
                    }
                    $key = trim((string) $key);
                    if ($key === '') {
                        continue;
                    }
                    // Cross-tenant guard BEFORE the lookup — never query a foreign form.
                    $targetForm = $this->formService->getForm($targetFormId);
                    if (!$targetForm || ($targetForm['userId'] ?? null) !== $userId) {
                        continue;
                    }
                    $tmf = $props['targetMatchField'] ?? null;
                    $tmf = is_string($tmf) && $tmf !== '' ? $tmf : $matchField;
                    $matches = $this->responseService->getFormResponses($targetFormId, ['answersEq' => [$tmf => $key], 'limit' => 1]);
                    $mid = $matches[0]['id'] ?? null;
                    if (!is_string($mid) || $mid === '') {
                        continue;
                    }
                    $matchResolved[$ri][$field['id']] = $mid;
                    $refsByForm[$targetFormId][$mid] = true; // label loads through the normal batch
                }
            }
        }

        // Batch-load + build a display string per referenced record.
        $displayCache = []; // targetFormId => responseId => ['id' => .., 'display' => ..]
        foreach ($refsByForm as $targetFormId => $idMap) {
            $displayCache[$targetFormId] = [];
            $targetForm = $this->formService->getForm($targetFormId);
            // Cross-tenant guard: never resolve a form the requester doesn't own.
            if (!$targetForm || ($targetForm['userId'] ?? null) !== $userId) {
                continue;
            }

            // The display fields chosen on the linking field, else fall back to the first couple
            // of text-ish fields on the target form.
            $displayFieldIds = [];
            foreach ($linkedFields as $field) {
                if ($field['properties']['targetFormId'] === $targetFormId) {
                    $displayFieldIds = $field['properties']['displayFieldIds'] ?? [];
                    break;
                }
            }

            $targetResponses = $this->responseService->getResponsesByIds($targetFormId, array_keys($idMap));
            foreach ($targetResponses as $tr) {
                $answers = $tr['answers'] ?? [];
                $parts = [];
                if (!empty($displayFieldIds)) {
                    foreach ($displayFieldIds as $dfid) {
                        $v = $answers[$dfid] ?? null;
                        if ($v !== null && $v !== '') {
                            $parts[] = is_array($v) ? implode(', ', $v) : (string) $v;
                        }
                    }
                } else {
                    // No display fields configured — derive a smart label (prefers name fields,
                    // first+last concat, etc.), falling back to the first text field.
                    $guess = \FormLogic\Helpers\RecordLabel::guess($targetForm['fields'], $answers);
                    if ($guess !== null && $guess !== '') {
                        $parts[] = $guess;
                    }
                }
                $displayCache[$targetFormId][$tr['id']] = [
                    'id' => $tr['id'],
                    'display' => implode(' - ', $parts) ?: ('Record ' . substr($tr['id'], 0, 8)),
                ];
            }
        }

        // Inject _resolved into each response.
        foreach ($responses as $ri => &$resp) {
            $answers = $resp['answers'] ?? [];
            $resolved = [];
            foreach ($linkedFields as $field) {
                $targetFormId = $field['properties']['targetFormId'];
                $val = $answers[$field['id']] ?? null;
                // Empty answer resolved through the match join (detail view only, above).
                if (($val === null || $val === '' || $val === []) && isset($matchResolved[$ri][$field['id']])) {
                    $val = $matchResolved[$ri][$field['id']];
                }
                if ($val === null || $val === '') {
                    continue;
                }
                $miss = fn ($id) => ['id' => $id, 'display' => 'Record not found', 'targetFormId' => $targetFormId];
                if (is_array($val)) {
                    $resolved[$field['id']] = array_map(
                        fn ($id) => ($displayCache[$targetFormId][$id] ?? $miss($id)) + ['targetFormId' => $targetFormId],
                        $val
                    );
                } else {
                    $resolved[$field['id']] = ($displayCache[$targetFormId][$val] ?? $miss($val)) + ['targetFormId' => $targetFormId];
                }
            }
            if (!empty($resolved)) {
                $resp['_resolved'] = $resolved;
            }
        }
        unset($resp);

        return $responses;
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
        // Server-side answer-equality filters (audit AOK-FLOW-001):
        // ?answers.<fieldId>=<value>, ANDed. PHP parses '.' in query keys
        // to '_', so both spellings arrive here.
        $answersEq = [];
        foreach ($queryParams as $qk => $qv) {
            if (is_string($qv) && (str_starts_with((string) $qk, 'answers.') || str_starts_with((string) $qk, 'answers_'))) {
                $answersEq[substr((string) $qk, 8)] = $qv;
            }
        }
        $options = [
            'status' => $queryParams['status'] ?? null,
            'from' => $queryParams['from'] ?? null,
            'to' => $queryParams['to'] ?? null,
            'answersEq' => $answersEq,
            'limit' => max(1, min((int)($queryParams['limit'] ?? 100), 1000)),
            'offset' => max(0, (int)($queryParams['offset'] ?? 0)),
        ];
        // Server-side column sorting (?sort=<fieldKey|submittedAt|status>&dir=asc|desc) —
        // owner-API parity with the app-scoped list; validated in buildResponsesOrderBy.
        if (is_string($queryParams['sort'] ?? null) && $queryParams['sort'] !== '') {
            $options['sort'] = (string) $queryParams['sort'];
            $options['sortDir'] = (string) ($queryParams['dir'] ?? 'desc');
        }

        $responses = $this->responseService->getFormResponses($formId, $options);
        $responses = $this->resolveLinkedRecords($responses, $form, $form['userId']);

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

        $resolved = $this->resolveLinkedRecords([$formResponse], $form, $form['userId']);
        $formResponse = $resolved[0];

        return $this->jsonResponse($response, ['response' => $formResponse]);
    }

    /**
     * Submit a new response (public endpoint)
     * POST /api/forms/{formId}/responses
     *
     * Idempotency (additive, opt-in): mirrors AppPublicController::processSubmission's design —
     * reserve the client's idempotencyKey BEFORE doing any work, complete it on success, release it
     * on failure. See form_submission_idempotency (MySQLConnection::runMigrations) and the
     * idempotency* helpers below, which are a deliberate hand-kept duplicate of
     * AppPublicController's app_submission_idempotency pattern, scoped by form_id only (a standalone
     * form has no app_id). A request that omits idempotencyKey takes the exact same path as before
     * this feature existed — see runCreatePipeline(), extracted byte-for-byte from the prior body of
     * this method.
     */
    public function create(Request $request, Response $response, array $args): Response
    {
        $formId = $args['formId'];
        $data = $request->getParsedBody();

        $key = (is_array($data) && isset($data['idempotencyKey']) && is_string($data['idempotencyKey']) && $data['idempotencyKey'] !== '')
            ? $data['idempotencyKey'] : null;

        // No key: run the pipeline directly — no idempotency guarantees, and no behavior change
        // from before idempotency support existed.
        if ($key === null) {
            $result = $this->runCreatePipeline($request, $formId, $data);
            return $this->jsonResponse($response, $result['payload'], $result['status']);
        }

        // Reserve the key BEFORE any work, using the table's UNIQUE(form_id, idempotency_key)
        // constraint as the atomic gate (closes the check-then-act race). The hash is over the RAW
        // client answers so an exact replay matches and a reused key with a different body is a
        // conflict. Classic public submissions are almost always anonymous; userId is best-effort
        // metadata only (this route carries no auth middleware).
        $userId = $request->getAttribute('userId');
        $userId = (is_string($userId) && $userId !== '') ? $userId : null;
        $answersForHash = (is_array($data) && isset($data['answers'])) ? $data['answers'] : [];
        $payloadHash = hash('sha256', (string) json_encode($answersForHash));

        $scope = ['form_id' => $formId];
        $reserved = $this->idem()->reserve('form_submission_idempotency', $scope, $userId, $key, $payloadHash);
        if ($reserved['state'] === 'existing') {
            // A row already exists for this (form, key).
            if (($reserved['payload_hash'] ?? '') !== $payloadHash) {
                return $this->jsonResponse($response, ['error' => true, 'conflict' => true,
                    'message' => 'This idempotency key was already used with a different submission.'], 409);
            }
            if (is_string($reserved['response_id'] ?? null) && $reserved['response_id'] !== '') {
                // Completed replay — return the original response, create nothing new.
                return $this->jsonResponse($response, ['response' => ['id' => $reserved['response_id']], 'idempotent' => true], 200);
            }
            // Same payload, reservation still 'pending'. A YOUNG row means a concurrent submit is
            // genuinely in flight — ask the caller to retry. A STALE row is an ABANDONED reservation
            // (the owning request died between reserve and complete/release); the service retakes it
            // atomically and hands US a fresh lease when we win.
            $newLease = $this->idem()->takeOver('form_submission_idempotency', $scope, $userId, $key, $payloadHash);
            if ($newLease === null) {
                return $this->jsonResponse($response, ['error' => true, 'processing' => true,
                    'message' => 'This submission is already being processed. Please retry in a moment.'], 409);
            }
            $reserved = ['state' => 'owner', 'lease' => $newLease];
        }
        // 'owner' (we won the reservation) or 'unavailable' (the ledger write failed for a
        // non-duplicate reason, or no MySQL connection is available) — fail OPEN and submit without
        // idempotency rather than reject a real submission.
        $ownsReservation = ($reserved['state'] === 'owner');
        $lease = $ownsReservation ? $reserved['lease'] : '';

        $result = $this->runCreatePipeline($request, $formId, $data);

        if ($ownsReservation) {
            $respId = ($result['status'] === 201) ? ($result['payload']['response']['id'] ?? null) : null;
            if (is_string($respId) && $respId !== '') {
                $this->idem()->complete('form_submission_idempotency', $scope, $key, $lease, $respId);
            } else {
                // Validation / quota / rejection / error: release the reservation so a legitimate
                // retry of a genuinely-failed submit isn't poisoned by a stale 'pending' row.
                $this->idem()->release('form_submission_idempotency', $scope, $key, $lease);
            }
        }
        return $this->jsonResponse($response, $result['payload'], $result['status']);
    }

    /**
     * The server-authoritative submission pipeline for the classic public endpoint (validation,
     * quota, persistence, onSubmit script) — independent of idempotency. This is the body that used
     * to live directly in create() before idempotency support was added, extracted verbatim (not
     * rewritten) so the no-idempotencyKey path is unaffected: same checks, same order, same
     * exception handling, same status codes and payload shapes.
     *
     * @param mixed $data
     * @return array{status:int, payload:array<string,mixed>}
     */
    private function runCreatePipeline(Request $request, string $formId, $data): array
    {
        // Check form exists and is published
        $form = $this->formService->getForm($formId);
        if (!$form) {
            return ['status' => 404, 'payload' => [
                'error' => true,
                'message' => 'Form not found',
            ]];
        }

        if ($form['status'] !== 'published') {
            return ['status' => 403, 'payload' => [
                'error' => true,
                'message' => 'Form is not accepting responses',
            ]];
        }

        // App-scoped forms must be submitted through the authenticated app runtime
        // (/api/app/{slug}/...), which enforces membership + the SUBMIT permission.
        // Mirror FileController::serve so the standalone public path can't bypass app
        // RBAC and poison app data anonymously.
        if ($this->appService && $this->appService->isFormInAnyApp($formId)) {
            return ['status' => 404, 'payload' => [
                'error' => true,
                'message' => 'Form not found',
            ]];
        }

        // Check if form is closed
        $settings = $form['settings'] ?? [];
        if (!empty($settings['isClosed'])) {
            $closedMessage = $settings['closedMessage'] ?? 'This form is no longer accepting responses.';
            return ['status' => 403, 'payload' => ['error' => true, 'message' => $closedMessage]];
        }

        // Check quota limit
        if (!empty($settings['quotaLimit'])) {
            $responseCount = $this->responseService->getResponseCount($formId);
            if ($responseCount >= (int)$settings['quotaLimit']) {
                $closedMessage = $settings['closedMessage'] ?? 'This form has reached its maximum number of responses.';
                return ['status' => 403, 'payload' => ['error' => true, 'message' => $closedMessage]];
            }
        }

        // Sanitize answers: strip non-input fields and unknown field IDs
        $data['answers'] = $this->sanitizeAnswers($form['fields'] ?? [], $data['answers'] ?? []);

        // Re-derive file URLs server-side so a submitter can't store an attacker-chosen
        // link that later renders as a clickable anchor to reviewers.
        $data['answers'] = $this->responseService->normalizeAnswers($form['fields'] ?? [], $data['answers'], $formId);

        // Recompute calculated fields server-side and merge them in so they
        // round-trip into storage/export/analytics and are available to
        // conditional-logic evaluation during validation.
        $data['answers'] = $this->responseService->applyCalculatedFields($form['fields'] ?? [], $data['answers']);
        $__fe = $this->responseService->validateFileAnswers($form['fields'] ?? [], $data['answers'], (string) ($form['id'] ?? ''));
        if (!empty($__fe)) {
            return ['status' => 400, 'payload' => ['error' => true, 'message' => 'Validation failed', 'errors' => $__fe]];
        }

        // Hard-cap the total serialized answer size before we persist it (defends the
        // unauthenticated endpoint against disk-exhaustion via oversized answers).
        if (strlen((string) json_encode($data['answers'])) > self::MAX_ANSWER_BYTES) {
            return ['status' => 413, 'payload' => [
                'error' => true,
                'message' => 'Submission is too large.',
            ]];
        }

        // Validate answers against form fields (honors conditional visibility)
        $validationErrors = $this->validateAnswers($form['fields'] ?? [], $data['answers']);
        if (!empty($validationErrors)) {
            return ['status' => 400, 'payload' => [
                'error' => true,
                'message' => 'Validation failed',
                'errors' => $validationErrors,
            ]];
        }

        // Add request metadata
        $serverParams = $request->getServerParams();
        $data['ipAddress'] = $this->getClientIp($request);
        $data['userAgent'] = htmlspecialchars(substr($request->getHeaderLine('User-Agent'), 0, 500), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $data['referrer'] = substr($request->getHeaderLine('Referer'), 0, 2000); // Limit length
        // Strip client-supplied fields that must be server-controlled
        unset($data['submittedByUserId'], $data['status']);

        // Get the script from the form (if any)
        $script = $form['logicScript'] ?? null;

        try {
            // Atomic quota enforcement: re-check the count under a per-form lock so
            // concurrent submissions cannot both pass the earlier check and push the
            // stored count past quotaLimit (the lock fails open under contention).
            $quotaLock = null;
            if (!empty($settings['quotaLimit'])) {
                $quotaLock = $this->responseService->acquireFormLock($formId);
                if ($quotaLock === null) {
                    // Audit FL-004/C-11: no mutex → concurrent submissions could overshoot
                    // the hard cap. Fail closed + retryable.
                    return ['status' => 503, 'payload' => ['error' => true, 'retryable' => true,
                        'message' => 'The form is busy — please retry in a moment.']];
                }
                if ($this->responseService->getResponseCount($formId) >= (int)$settings['quotaLimit']) {
                    $this->responseService->releaseFormLock($quotaLock);
                    $closedMessage = $settings['closedMessage'] ?? 'This form has reached its maximum number of responses.';
                    return ['status' => 403, 'payload' => ['error' => true, 'message' => $closedMessage]];
                }
            }
            try {
                $result = $this->responseService->createResponse($formId, $data, $script);
            } finally {
                $this->responseService->releaseFormLock($quotaLock);
            }

            // Handle rejection from script
            if ($result instanceof ScriptRejection) {
                return ['status' => 422, 'payload' => [
                    'error' => true,
                    'message' => $result->message,
                    'rejected' => true,
                ]];
            }

            // {store:false} scripts persist nothing — no links to index, no record
            // to notify about (the audit trail still records the submission event).
            $stored = ($result['stored'] ?? true) !== false;
            if ($stored) {
                // Write inverse linked_record links so "related records" lookups work
                // for standalone public submissions (the app path syncs separately).
                $this->responseService->syncResponseLinks($formId, $result['id'] ?? '', $form['fields'] ?? [], $data['answers'] ?? []);

                // Best-effort new-response notification email (form Notifications tab).
                $this->maybeNotifyNewResponse($form);
            }

            $this->audit($request, 'response.create', 'response', $result['id'] ?? '', ['formId' => $formId, 'stored' => $stored]);
            return ['status' => 201, 'payload' => ['response' => $result]];
        } catch (\RuntimeException | \InvalidArgumentException $e) {
            return ['status' => 400, 'payload' => [
                'error' => true,
                'message' => $e->getMessage(),
            ]];
        } catch (\Exception $e) {
            $this->logger->error('Response creation error', ['exception' => $e->getMessage()]);
            return ['status' => 500, 'payload' => [
                'error' => true,
                'message' => 'An unexpected error occurred',
            ]];
        } catch (\Throwable $e) {
            // \Throwable (not just \Exception): an \Error (TypeError, DivisionByZeroError, etc.)
            // escaping here would propagate past create()'s call site, which has no try/catch of its
            // own — skipping the ledger complete()/release() call entirely and
            // stranding a 'pending' row in form_submission_idempotency for up to 600s (every retry
            // in that window gets 409 "processing" even though nothing ever actually succeeded).
            // AppPublicController::runSubmissionPipeline guards against exactly this for the
            // app-runtime path; mirror it here so this path fails the SAME way (a clean 500 that
            // still releases the reservation) instead of leaking the reservation.
            $this->logger->error('Response creation error', ['exception' => $e->getMessage()]);
            return ['status' => 500, 'payload' => [
                'error' => true,
                'message' => 'An unexpected error occurred',
            ]];
        }
    }


    /** Lazily built — the shared submission-idempotency ledger (audit FL-IDEM-001). */
    private ?SubmissionIdempotencyService $idempotencyLedger = null;

    private function idem(): SubmissionIdempotencyService
    {
        return $this->idempotencyLedger ??= new SubmissionIdempotencyService($this->mysql);
    }

    private function uuidV4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }

    /**
     * Strip answers for non-input field types and unknown field IDs.
     * Prevents clients from injecting values into calculated, statement,
     * welcome_screen, or thank_you fields, and discards any field IDs
     * that don't exist in the form definition.
     */
    private function sanitizeAnswers(array $fields, array $answers): array
    {
        if (!is_array($answers)) {
            return [];
        }

        // Build map of valid input field IDs
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
     * Re-derive each file_upload item's `url` from trusted parts (form id + file id +
     * filename). The client uploads via /upload (which returns the canonical url), but
     * the submission could carry a tampered `url`; rebuilding it here ensures reviewers
     * only ever see links that point at this form's own file-serving route — never an
     * attacker-supplied phishing or `javascript:` link.
     */
    // normalizeAnswers moved to ResponseService (shared across all write paths).

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

        // Resolve conditional visibility from the submitted answers so we don't
        // enforce required (or type validation) on fields the user couldn't see.
        $visibility = $this->responseService->computeFieldVisibility($fields, $answers);

        // Check required fields
        foreach ($fields as $field) {
            $fieldId = $field['id'] ?? null;
            if (!$fieldId) {
                continue;
            }

            $fieldType = $field['type'] ?? 'short_text';

            // Skip validation for non-input field types
            if (in_array($fieldType, ['statement', 'welcome_screen', 'thank_you', 'calculated', 'hidden'], true)) {
                continue;
            }

            // Skip fields hidden by conditional logic — they can't be filled in,
            // so requiring them would be an unrecoverable dead-end.
            $fieldVis = $visibility[$fieldId] ?? ['visible' => true, 'required' => (bool)($field['required'] ?? false)];
            if (!$fieldVis['visible']) {
                continue;
            }
            $isRequired = $fieldVis['required'];

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
                continue;
            }
            // Builder-configured rules (min/maxLength, min/max, pattern, number bounds, date format)
            $ruleError = $this->responseService->validateFieldRules($field, $value);
            if ($ruleError) {
                $errors[$fieldId] = $ruleError;
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

        // Scalar-typed fields must receive a scalar value. A client submitting an
        // array/object for e.g. a phone field would otherwise reach preg_match()
        // and throw an uncaught TypeError (HTTP 500). Reject it cleanly as a 400.
        $scalarTypes = ['short_text', 'long_text', 'email', 'url', 'number', 'phone', 'date', 'datetime', 'time'];
        if (in_array($type, $scalarTypes, true)) {
            if (!is_scalar($value)) {
                return 'Invalid value';
            }
            // Cap scalar size before the per-type validators run, so a giant value
            // can't bloat per-form SQLite storage or feed ReDoS into the regex checks
            // below. (short_text/long_text apply tighter caps further down.)
            if (strlen((string) $value) > 100000) {
                return 'Value is too long';
            }
        }

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
                // A legitimate number is never thousands of digits long.
                if (strlen((string) $value) > 64) {
                    return 'Number is too long';
                }
                break;

            case 'phone':
                // Accept E.164 format (+[1-9]...) or legacy loose format (must contain at least 6 digits)
                if (!preg_match('/^\+[1-9]\d{6,14}$/', $value) &&
                    !preg_match('/^[\d\s\-\+\(\)\.]+$/', $value)) {
                    return 'Invalid phone number format';
                }
                // Require at least 6 actual digits in loose format
                if (!preg_match('/^\+[1-9]\d{6,14}$/', $value)) {
                    $digitCount = preg_match_all('/\d/', $value);
                    if ($digitCount < 6) {
                        return 'Phone number must contain at least 6 digits';
                    }
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
                // Limit array size to number of available options (prevent payload bloat)
                if (count($value) > max(count($allowedValues), 1)) {
                    return 'Too many selections';
                }
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

            case 'location':
                if (!is_array($value)) {
                    return 'Invalid location format';
                }
                if (!isset($value['latitude']) || !isset($value['longitude'])) {
                    return 'Location must include latitude and longitude';
                }
                if (!is_numeric($value['latitude']) || !is_numeric($value['longitude'])) {
                    return 'Latitude and longitude must be numbers';
                }
                if ($value['latitude'] < -90 || $value['latitude'] > 90) {
                    return 'Latitude must be between -90 and 90';
                }
                if ($value['longitude'] < -180 || $value['longitude'] > 180) {
                    return 'Longitude must be between -180 and 180';
                }
                break;

            case 'file_upload':
                if (!is_array($value)) {
                    return 'Invalid file upload format';
                }
                // Honor the field's allowMultiple setting server-side.
                if (empty($field['properties']['allowMultiple']) && count($value) > 1) {
                    return 'Only one file is allowed for this field';
                }
                // Limit file count to prevent payload bloat
                $maxFiles = $field['properties']['maxFiles'] ?? 20;
                if (count($value) > $maxFiles) {
                    return "Maximum of {$maxFiles} files allowed";
                }
                foreach ($value as $item) {
                    if (!is_array($item) || !isset($item['id']) || !isset($item['originalFilename'])) {
                        return 'Invalid file metadata';
                    }
                    // Bound the filename so a client can't smuggle a multi-megabyte
                    // string into storage via file metadata.
                    if (!is_string($item['originalFilename']) || strlen($item['originalFilename']) > 255) {
                        return 'Invalid file name';
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

        // Normalize: an empty/non-JSON body parses to null, which would raise an
        // uncaught \TypeError (HTTP 500) when passed to the array-typed service.
        $data = $request->getParsedBody() ?? [];

        // Drop calculated/unknown-field answers so they can't be tampered on update,
        // then re-derive calculated fields — otherwise editing any answer would
        // permanently wipe every stored calculated value (create recomputes; the
        // update path previously stripped without recomputing).
        if (isset($data['answers']) && is_array($data['answers'])) {
            $data['answers'] = $this->sanitizeAnswers($form['fields'] ?? [], $data['answers']);
            $data['answers'] = $this->responseService->normalizeAnswers($form['fields'] ?? [], $data['answers'], $formId);
            $data['answers'] = $this->responseService->applyCalculatedFields($form['fields'] ?? [], $data['answers']);
            $__fe = $this->responseService->validateFileAnswers($form['fields'] ?? [], $data['answers'], (string) ($form['id'] ?? ''));
            if (!empty($__fe)) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Validation failed', 'errors' => $__fe], 400);
            }
            if ($this->responseService->answersTooLarge($data['answers'])) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Submission is too large.'], 413);
            }
        }

        try {
            $formResponse = $this->responseService->updateResponse($formId, $responseId, $data);

            if (!$formResponse) {
                return $this->jsonResponse($response, [
                    'error' => true,
                    'message' => 'Response not found',
                ], 404);
            }

            // Re-sync inverse linked_record links if answers changed.
            if (isset($data['answers']) && is_array($data['answers'])) {
                $this->responseService->syncResponseLinks($formId, $responseId, $form['fields'] ?? [], $data['answers']);
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
     * Owner-scoped linked-record lookup: fetch selectable records from a target form for a
     * linked_record field, WITHOUT an app context. Powers linked records on standalone / pack forms
     * (e.g. a form installed by a pack but not placed in an app, which previously showed
     * "available in published apps only"). Safe: it only ever returns the caller's OWN data — the
     * caller must own BOTH the source and target forms, and the source form must actually declare a
     * linked_record pointing at the target.
     *
     * GET /api/forms/{formId}/lookup?targetFormId=&q=&displayFieldIds=&searchFieldIds=&ids=&limit=&offset=
     */
    public function lookupOwnedRecords(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $formId = $args['formId'] ?? '';
        $q = $request->getQueryParams();
        $targetFormId = $q['targetFormId'] ?? '';
        if ($targetFormId === '') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'targetFormId is required'], 400);
        }

        // Ownership: the caller must own BOTH forms (no cross-tenant access).
        $sourceForm = $this->formService->getForm($formId);
        if (!$sourceForm || ($sourceForm['userId'] ?? null) !== $userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found'], 404);
        }
        $targetForm = $this->formService->getForm($targetFormId);
        if (!$targetForm || ($targetForm['userId'] ?? null) !== $userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Target form not found'], 404);
        }

        // The source form must actually link to the target (prevents using this as a generic reader).
        $declared = false;
        foreach ($sourceForm['fields'] ?? [] as $f) {
            if (($f['type'] ?? '') === 'linked_record' && ($f['properties']['targetFormId'] ?? '') === $targetFormId) {
                $declared = true;
                break;
            }
        }
        if (!$declared) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'This form does not link to the requested form'], 403);
        }

        $displayFieldIds = !empty($q['displayFieldIds']) ? explode(',', (string)$q['displayFieldIds']) : [];
        $searchFieldIds = !empty($q['searchFieldIds']) ? explode(',', (string)$q['searchFieldIds']) : [];
        $searchQuery = (string)($q['q'] ?? '');
        $idsParam = (string)($q['ids'] ?? '');
        $limit = max(1, min((int)($q['limit'] ?? 20), 100));
        $offset = max(0, (int)($q['offset'] ?? 0));

        // Validate requested field ids belong to the target form
        $validFieldIds = array_column($targetForm['fields'] ?? [], 'id');
        if (!empty($displayFieldIds)) {
            $displayFieldIds = array_values(array_intersect($displayFieldIds, $validFieldIds));
        }
        if (!empty($searchFieldIds)) {
            $searchFieldIds = array_values(array_intersect($searchFieldIds, $validFieldIds));
        }

        // Owner sees ALL records of their own target form.
        if ($idsParam !== '') {
            $requestedIds = array_slice(array_values(array_filter(array_map('trim', explode(',', $idsParam)), fn($id) => $id !== '')), 0, 500);
            $matched = $this->responseService->getResponsesByIds($targetFormId, $requestedIds);
            $totalCount = count($matched);
        } elseif ($searchQuery !== '') {
            $result = $this->responseService->getFormResponsesSearchable($targetFormId, $searchQuery, $searchFieldIds, ['limit' => $limit, 'offset' => $offset]);
            $matched = $result['responses'];
            $totalCount = $result['total'];
        } else {
            $matched = $this->responseService->getFormResponses($targetFormId, ['limit' => $limit, 'offset' => $offset]);
            $totalCount = $this->responseService->getResponseCount($targetFormId, null);
        }

        $records = [];
        foreach ($matched as $resp) {
            $answers = $resp['answers'] ?? [];
            if (!empty($displayFieldIds)) {
                $displayParts = [];
                foreach ($displayFieldIds as $fid) {
                    $val = $answers[$fid] ?? null;
                    if ($val !== null && $val !== '') {
                        $displayParts[] = is_array($val) ? implode(', ', $val) : (string)$val;
                    }
                }
                $display = implode(' - ', $displayParts);
            } else {
                // Smart single-name label (name fields → first+last → any name → first text), matching
                // how linked records read elsewhere in the app.
                $display = \FormLogic\Helpers\RecordLabel::guess($targetForm['fields'] ?? [], $answers) ?? '';
            }
            $fieldData = [];
            foreach ($displayFieldIds as $fid) {
                $fieldData[$fid] = $answers[$fid] ?? null;
            }
            $records[] = [
                'id' => $resp['id'],
                'display' => $display !== '' ? $display : ('Record ' . substr((string)$resp['id'], 0, 8)),
                'fields' => $fieldData,
                'submittedAt' => $resp['submittedAt'] ?? '',
            ];
        }

        return $this->jsonResponse($response, ['records' => array_values($records), 'count' => $totalCount]);
    }

    /**
     * Owner-scoped inverse related-records (linked-records feature): the records in the
     * owner's OTHER forms that link to this response through a linked_record field. Mirrors
     * AppPublicController::getRelatedRecords but scoped by ownership (the owner owns all their
     * forms — no app/role permissions); only source forms owned by the SAME user are included.
     * GET /api/forms/{formId}/responses/{id}/related?limit=&offset=
     */
    public function getRelatedRecords(Request $request, Response $response, array $args): Response
    {
        $formId = $args['formId'];
        $responseId = $args['id'];
        $form = $this->authorizeFormAccess($request, $formId);
        if (!$form) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }
        $userId = $request->getAttribute('userId');
        if ($this->mysql === null) {
            return $this->jsonResponse($response, ['related' => []]);
        }
        $targetResp = $this->responseService->getResponse($formId, $responseId);
        if (!$targetResp) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Response not found'], 404);
        }

        // One bounded pass, grouped by RELATIONSHIP (source form + field) — see
        // AppPublicController::getRelatedRecords for the rationale. No cross-group paging.
        $linkCap = 2000;
        $stmt = $this->mysql->prepare(
            "SELECT source_form_id, source_response_id, field_id FROM response_links WHERE target_form_id = :tf AND target_response_id = :tr ORDER BY source_form_id, field_id, source_response_id LIMIT :lim"
        );
        $stmt->bindValue('tf', $formId);
        $stmt->bindValue('tr', $responseId);
        $stmt->bindValue('lim', $linkCap, PDO::PARAM_INT);
        $stmt->execute();
        $links = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $groups = [];
        foreach ($links as $link) {
            $key = $link['source_form_id'] . '|' . $link['field_id'];
            if (!isset($groups[$key])) {
                $groups[$key] = ['formId' => $link['source_form_id'], 'fieldId' => $link['field_id'], 'ids' => []];
            }
            $groups[$key]['ids'][$link['source_response_id']] = true;
        }

        $formCache = [];

        // Match-based relations (RelatedRecords::matchRelations): candidate source forms are
        // the ones sharing an app with this form — the bounded universe where a join-key
        // relationship can be declared. Ownership is enforced by the group loop below.
        $targetAnswers = is_array($targetResp['answers'] ?? null) ? $targetResp['answers'] : [];
        $cand = $this->mysql->prepare(
            "SELECT DISTINCT af2.form_id FROM app_forms af1 JOIN app_forms af2 ON af1.app_id = af2.app_id WHERE af1.form_id = :f"
        );
        $cand->bindValue('f', $formId);
        $cand->execute();
        foreach ($cand->fetchAll(PDO::FETCH_COLUMN) as $sfId) {
            $sfId = (string) $sfId;
            if (!array_key_exists($sfId, $formCache)) {
                $formCache[$sfId] = $this->formService->getForm($sfId) ?: null;
            }
            $sourceForm = $formCache[$sfId];
            if (!$sourceForm || ($sourceForm['userId'] ?? null) !== $userId) {
                continue;
            }
            RelatedRecords::mergeMatchGroups(
                $groups,
                $sourceForm,
                $sfId,
                $formId,
                $responseId,
                $targetAnswers,
                fn (string $fid, string $field, string $value) =>
                    $this->responseService->getFormResponses($fid, ['answersEq' => [$field => $value], 'limit' => 500])
            );
        }

        if (empty($groups)) {
            return $this->jsonResponse($response, ['related' => []]);
        }
        $related = [];
        foreach ($groups as $key => $g) {
            $sourceFormId = $g['formId'];
            $fieldId = $g['fieldId'];
            if (!array_key_exists($sourceFormId, $formCache)) {
                $formCache[$sourceFormId] = $this->formService->getForm($sourceFormId) ?: null;
            }
            $sourceForm = $formCache[$sourceFormId];
            // Cross-tenant guard: only forms the same owner holds.
            if (!$sourceForm || ($sourceForm['userId'] ?? null) !== $userId) { continue; }

            [$cfg, $columns] = RelatedRecords::fieldConfig($sourceForm, (string) $fieldId);
            if ($cfg['hidden']) { continue; }

            $sourceResponses = $this->responseService->getResponsesByIds($sourceFormId, array_keys($g['ids']));
            $records = RelatedRecords::buildRecords($sourceResponses, $sourceForm, $cfg['displayFieldIds'], $cfg['columnFieldIds']);
            if (empty($records)) { continue; }

            $related[$key] = [
                'key' => $key,
                'formId' => $sourceFormId,
                'displayName' => $sourceForm['title'] ?? $sourceFormId,
                'fieldLabel' => $cfg['fieldLabel'],
                'fieldId' => $fieldId,
                'allowMultiple' => $cfg['allowMultiple'],
                'allowAdd' => $cfg['allowAdd'],
                'allowDelete' => $cfg['allowDelete'],
                'pageSize' => $cfg['pageSize'],
                'columns' => $columns,
                'records' => $records,
                'count' => count($records),
            ];
        }

        return $this->jsonResponse($response, ['related' => $related]);
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
            // Raw pass-through — getFormAnalytics() itself validates/clamps this
            // (numeric, -840..840, defaults to 0/UTC), so no duplicate validation here.
            'tzOffsetMinutes' => $queryParams['tzOffsetMinutes'] ?? null,
        ];

        $analytics = $this->responseService->getFormAnalytics($formId, $options);

        return $this->jsonResponse($response, ['analytics' => $analytics]);
    }

    /**
     * How many responses hold a value for one field — powers the builder's
     * delete-field warning. GET /api/forms/{formId}/fields/{fieldId}/usage
     */
    public function fieldUsage(Request $request, Response $response, array $args): Response
    {
        $form = $this->authorizeFormAccess($request, (string) $args['formId']);
        if (!$form) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }
        $fieldId = (string) ($args['fieldId'] ?? '');
        if (preg_match('/^[A-Za-z0-9_\-]{1,100}$/', $fieldId) !== 1) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Invalid field id'], 400);
        }
        return $this->jsonResponse($response, [
            'fieldId' => $fieldId,
            'responsesWithValue' => $this->responseService->countResponsesWithFieldValue((string) $args['formId'], $fieldId),
        ]);
    }

    /**
     * Permanently remove one field's data from every response (the builder's
     * "delete field AND its data" choice, invoked AFTER the structure save
     * removed the definition). POST /api/forms/{formId}/fields/{fieldId}/purge-data
     */
    public function purgeFieldData(Request $request, Response $response, array $args): Response
    {
        $form = $this->authorizeFormAccess($request, (string) $args['formId']);
        if (!$form) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }
        $fieldId = (string) ($args['fieldId'] ?? '');
        if (preg_match('/^[A-Za-z0-9_\-]{1,100}$/', $fieldId) !== 1) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Invalid field id'], 400);
        }
        // Refuse while the field still exists — the purge is the follow-up to a
        // structure save that deleted it; purging a live field would silently
        // wipe data the form still collects.
        foreach ($form['fields'] ?? [] as $f) {
            if (($f['id'] ?? '') === $fieldId) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Field still exists on the form — remove it first'], 409);
            }
        }
        $purged = $this->responseService->purgeFieldData((string) $args['formId'], $fieldId);
        $this->audit($request, 'response.field_data_purge', 'form', (string) $args['formId'], ['fieldId' => $fieldId, 'purged' => $purged]);
        return $this->jsonResponse($response, ['purged' => $purged]);
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
            ->withHeader('Content-Type', 'text/csv; charset=utf-8')
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
     * Test an onSubmit script against sample answers WITHOUT persisting anything.
     * Powers the ScriptEditor "Test" button. Auth + form ownership required.
     * POST /api/forms/{formId}/script/test  body: { script, answers? }
     */
    public function testScript(Request $request, Response $response, array $args): Response
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

        $data = $request->getParsedBody();
        if (!is_array($data)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Invalid request body'], 422);
        }

        $script = $data['script'] ?? null;
        if (!is_string($script) || trim($script) === '') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'A script is required'], 422);
        }
        if (strlen($script) > 102400) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Script must be 100KB or smaller'], 422);
        }

        $answers = (isset($data['answers']) && is_array($data['answers'])) ? $data['answers'] : [];

        $scriptHash = hash('sha256', $script);
        try {
            $result = $this->responseService->testScript($script, $answers, [
                'ipAddress' => $this->getClientIp($request),
                'userAgent' => substr($request->getHeaderLine('User-Agent'), 0, 500),
                'formId' => $formId,
            ]);
            $this->audit($request, 'script.test', 'form', $formId, [
                'scriptSha256' => $scriptHash,
                'scriptBytes' => strlen($script),
                'outcome' => $result->success ? ($result->isRejected() ? 'rejected' : 'ok') : 'error',
            ]);
            return $this->jsonResponse($response, ['result' => $result->toArray()]);
        } catch (\Throwable $e) {
            $this->logger->error('Script test error', ['formId' => $formId, 'exception' => $e->getMessage()]);
            // Audit the failed run too so aborted/error attempts are attributable.
            $this->audit($request, 'script.test', 'form', $formId, ['scriptSha256' => $scriptHash, 'outcome' => 'exception']);
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to run script test'], 500);
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

        // Validate file extension and MIME type
        $extension = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
        if ($extension !== 'csv') {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Only .csv files are allowed',
            ], 400);
        }
        $finfo = new \finfo(FILEINFO_MIME_TYPE);
        $mimeType = $finfo->file($file['tmp_name']);
        if ($mimeType !== false && !in_array($mimeType, ['text/csv', 'text/plain', 'application/csv', 'application/octet-stream'], true)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Invalid file type. Only CSV files are allowed.',
            ], 400);
        }

        // Validate file size (max 5MB)
        if ($file['size'] > 5 * 1024 * 1024) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'File size exceeds 5MB limit',
            ], 400);
        }

        // Verify this is a genuine upload (prevents path traversal)
        if (!is_uploaded_file($file['tmp_name'])) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Invalid file upload',
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

        // Match the export's RFC-4180 escaping (fputcsv with '' escape) so export→edit→re-import
        // round-trips symmetrically, and pass the arg explicitly to silence the PHP 8.4 deprecation.
        $headers = fgetcsv($handle, 0, ',', '"', '');
        // fgetcsv returns a non-empty array or false, so `empty($headers)`
        // was dead code (a blank first line is [null], which is not empty()
        // either — it falls through to column mapping exactly as before).
        if ($headers === false) {
            fclose($handle);
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'CSV file is empty or has no headers',
            ], 400);
        }

        // Read all data rows
        $rows = [];
        while (($row = fgetcsv($handle, 0, ',', '"', '')) !== false) {
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
            if (!is_string($fieldId)) {
                return $this->jsonResponse($response, [
                    'error' => true,
                    'message' => 'Column mapping values must be strings',
                ], 400);
            }
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

        // Flush WAL to the main database file so the download is self-contained
        try {
            $db = $this->sqlite->getFormDatabase($formId);
            $db->exec('PRAGMA wal_checkpoint(FULL)');
        } catch (\Exception $e) {
            // Non-fatal — the DB is still readable, just may be missing recent WAL data
            $this->logger->warning('WAL checkpoint failed before SQLite export', ['formId' => $formId, 'error' => $e->getMessage()]);
        }

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
        // Hard cap (mirrors the CSV export) so one request cannot stream an
        // unbounded table and monopolize a PHP worker.
        $maxExportRows = 100000;
        $truncated = false;

        do {
            $batch = $this->responseService->getFormResponses($formId, [
                'limit' => $batchSize,
                'offset' => $offset,
            ]);

            foreach ($batch as $resp) {
                if ($totalWritten >= $maxExportRows) {
                    $truncated = true;
                    break;
                }
                if (!$isFirst) {
                    $body->write(',');
                }
                $body->write(json_encode($resp, JSON_UNESCAPED_UNICODE));
                $isFirst = false;
                $totalWritten++;
            }

            $offset += $batchSize;
        } while (count($batch) === $batchSize && $totalWritten < $maxExportRows);

        $body->write('],"meta":' . json_encode([
            'totalResponses' => $totalWritten,
            'truncated' => $truncated,
            'maxRows' => $maxExportRows,
            'version' => '1.0',
        ]) . '}');

        return $response
            ->withHeader('Content-Type', 'application/json')
            ->withHeader('Content-Disposition', 'attachment; filename="' . $filename . '"');
    }
}
