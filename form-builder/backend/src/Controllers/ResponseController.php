<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

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
    // controller — idempotencyReserve() fails open (submits without idempotency protection) when null.
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
        foreach ($responses as &$resp) {
            $answers = $resp['answers'] ?? [];
            $resolved = [];
            foreach ($linkedFields as $field) {
                $targetFormId = $field['properties']['targetFormId'];
                $val = $answers[$field['id']] ?? null;
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
        $options = [
            'status' => $queryParams['status'] ?? null,
            'from' => $queryParams['from'] ?? null,
            'to' => $queryParams['to'] ?? null,
            'limit' => max(1, min((int)($queryParams['limit'] ?? 100), 1000)),
            'offset' => max(0, (int)($queryParams['offset'] ?? 0)),
        ];

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

        $reserved = $this->idempotencyReserve($formId, $userId, $key, $payloadHash);
        if (is_array($reserved)) {
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
            // (the owning request died between reserve and complete/release); retake it atomically —
            // the DELETE is guarded on status='pending' + age entirely DB-side, so two racers can't
            // both win.
            $takenOver = false;
            try {
                $del = $this->mysql->prepare(
                    "DELETE FROM form_submission_idempotency
                     WHERE form_id = :f AND idempotency_key = :k
                       AND status = 'pending' AND created_at < (NOW() - INTERVAL 600 SECOND)"
                );
                $del->execute(['f' => $formId, 'k' => $key]);
                if ($del->rowCount() > 0) {
                    $takenOver = ($this->idempotencyReserve($formId, $userId, $key, $payloadHash) === 'owner');
                }
            } catch (\Throwable $e) {
                // Takeover is best-effort; fall through to the normal processing response.
            }
            if (!$takenOver) {
                return $this->jsonResponse($response, ['error' => true, 'processing' => true,
                    'message' => 'This submission is already being processed. Please retry in a moment.'], 409);
            }
            $reserved = 'owner';
        }
        // $reserved is 'owner' (we won the reservation) or 'unavailable' (the ledger write failed for
        // a non-duplicate reason, or no MySQL connection is available) — fail OPEN and submit without
        // idempotency rather than reject a real submission.
        $ownsReservation = ($reserved === 'owner');

        $result = $this->runCreatePipeline($request, $formId, $data);

        if ($ownsReservation) {
            $respId = ($result['status'] === 201) ? ($result['payload']['response']['id'] ?? null) : null;
            if (is_string($respId) && $respId !== '') {
                $this->idempotencyComplete($formId, $key, $respId);
            } else {
                // Validation / quota / rejection / error: release the reservation so a legitimate
                // retry of a genuinely-failed submit isn't poisoned by a stale 'pending' row.
                $this->idempotencyRelease($formId, $key);
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

            // Write inverse linked_record links so "related records" lookups work
            // for standalone public submissions (the app path syncs separately).
            $this->responseService->syncResponseLinks($formId, $result['id'] ?? '', $form['fields'] ?? [], $data['answers'] ?? []);

            // Best-effort new-response notification email (form Notifications tab).
            $this->maybeNotifyNewResponse($form);

            $this->audit($request, 'response.create', 'response', $result['id'] ?? '', ['formId' => $formId]);
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
            // own — skipping the idempotencyComplete()/idempotencyRelease() call entirely and
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

    /**
     * Idempotency ledger for the CLASSIC public submission endpoint (create() above), operating on
     * form_submission_idempotency. This trio (idempotencyReserve/idempotencyComplete/
     * idempotencyRelease, plus idempotencyFind and uuidV4 below) is a DELIBERATE, hand-kept duplicate
     * of AppPublicController::idempotencyReserve/idempotencyComplete/idempotencyRelease against
     * app_submission_idempotency — same reserve-first-via-unique-constraint design, same
     * payload-hash conflict detection, same 600-second stale-pending takeover, same
     * fail-open-on-ledger-error behavior — scoped by form_id only (no app_id, since a standalone
     * form need not belong to an app). If that pattern changes, update both by hand; this is not
     * shared/extracted on purpose, to avoid risking the already-working app-runtime path.
     *
     * Returns:
     *   'owner'        — we won the reservation (caller must complete or release it),
     *   'unavailable'  — the ledger write failed for a non-duplicate reason, or there is no MySQL
     *                    connection (caller should fail open),
     *   array{response_id:?string, payload_hash:string, status:string} — an existing row (replay/conflict/in-flight).
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
            // 23000 / MySQL 1062 = duplicate key → a row already exists for this key.
            $dup = $e->getCode() === '23000' || (isset($e->errorInfo[1]) && (int) $e->errorInfo[1] === 1062);
            if ($dup) {
                // If it vanished between the failed insert and this read (a racing release), fail open.
                return $this->idempotencyFind($formId, $key) ?? 'unavailable';
            }
            // Any other DB error: fail open — idempotency is best-effort, never block a real submit.
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

    /** Mark a reservation completed, pointing it at the created response. Best-effort. */
    private function idempotencyComplete(string $formId, string $key, string $responseId): void
    {
        if ($this->mysql === null) {
            return;
        }
        try {
            $stmt = $this->mysql->prepare(
                "UPDATE form_submission_idempotency SET response_id = :r, status = 'completed'
                 WHERE form_id = :f AND idempotency_key = :k"
            );
            $stmt->execute(['r' => $responseId, 'f' => $formId, 'k' => $key]);
        } catch (\Throwable $e) {
            // ignore — the response is already persisted; a failed ledger update only risks a future
            // duplicate on replay, never data loss.
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
        if ($headers === false || empty($headers)) {
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
