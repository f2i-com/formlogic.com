<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;
use PDO;

class ResponseService
{
    private PDO $mysql;
    private SQLiteConnection $sqlite;
    private ?FormLogicRuntime $runtime;
    private ?WebhookService $webhookService;
    private ?FileStorageService $fileStorageService;
    private LoggerInterface $logger;
    private ?FormLogicService $formLogicService = null;

    public function __construct(
        MySQLConnection $mysql,
        SQLiteConnection $sqlite,
        ?FormLogicRuntime $runtime = null,
        ?LoggerInterface $logger = null,
        ?WebhookService $webhookService = null,
        ?FileStorageService $fileStorageService = null
    ) {
        $this->mysql = $mysql->getConnection();
        $this->sqlite = $sqlite;
        $this->runtime = $runtime;
        $this->logger = $logger ?? new NullLogger();
        $this->webhookService = $webhookService;
        $this->fileStorageService = $fileStorageService;
    }

    /** Lazily resolve the FormLogic engine (no-arg service). */
    private function getFormLogic(): FormLogicService
    {
        return $this->formLogicService ??= new FormLogicService();
    }

    /**
     * Compute per-field visibility & effective-required, mirroring the client's
     * useConditionalLogic hook, so the server doesn't enforce `required` (or
     * type validation) on fields the user can't see. Shared by the public and
     * External API submission paths.
     *
     * @return array<string, array{visible: bool, required: bool}>
     */
    public function computeFieldVisibility(array $fields, array $answers): array
    {
        $vis = [];
        $jobs = [];   // conditional expressions to evaluate: [['id'=>..,'expression'=>..]]
        $meta = [];   // id => ['action'=>?, 'baseRequired'=>bool]

        foreach ($fields as $field) {
            $id = $field['id'] ?? null;
            if (!$id) {
                continue;
            }
            $baseRequired = (bool)($field['required'] ?? false);
            $cond = $field['conditionalLogic'] ?? null;
            $expr = (is_array($cond) ? ($cond['expression'] ?? '') : '');

            if (!is_string($expr) || trim($expr) === '') {
                $vis[$id] = ['visible' => true, 'required' => $baseRequired];
                continue;
            }

            $jobs[] = ['id' => $id, 'expression' => $expr];
            $meta[$id] = [
                'action' => is_array($cond) ? ($cond['action'] ?? null) : null,
                'baseRequired' => $baseRequired,
            ];
        }

        if ($jobs === []) {
            return $vis;
        }

        // Default every field id to null so a condition referencing a field that
        // wasn't submitted (e.g. a partial External API payload) evaluates cleanly
        // instead of throwing -> failing open -> wrongly requiring a hidden field.
        // Mirrors the client (useConditionalLogic).
        $ctx = [];
        foreach ($fields as $field) {
            if (!empty($field['id'])) {
                $ctx[$field['id']] = null;
            }
        }
        $ctx = array_merge($ctx, $answers);

        // Evaluate ALL conditional expressions in a single qjs round-trip.
        try {
            $results = $this->getFormLogic()->evaluateBatch($jobs, $ctx);
        } catch (\Throwable $e) {
            $results = [];
        }

        foreach ($meta as $id => $m) {
            $r = $results[$id] ?? null;
            $baseRequired = $m['baseRequired'];
            if ($r === null || !($r['ok'] ?? false)) {
                // Fail OPEN to visible (matches the client) so a malformed/missing
                // result can't create an unrecoverable dead-end.
                $vis[$id] = ['visible' => true, 'required' => $baseRequired];
                continue;
            }
            $result = (bool)($r['value'] ?? false);

            switch ($m['action']) {
                case 'hide':
                case 'skip':
                    $visible = !$result;
                    $vis[$id] = ['visible' => $visible, 'required' => $baseRequired && $visible];
                    break;
                case 'require':
                    $vis[$id] = ['visible' => true, 'required' => $result || $baseRequired];
                    break;
                case 'show':
                    $visible = $result;
                    $vis[$id] = ['visible' => $visible, 'required' => $baseRequired && $visible];
                    break;
                default:
                    $vis[$id] = ['visible' => true, 'required' => $baseRequired];
                    break;
            }
        }
        return $vis;
    }

    /**
     * Recompute calculated fields server-side from their calculationExpression
     * and merge the results into answers (round-trips into storage/export/
     * analytics; recomputing prevents client tampering). Iterates to a fixed
     * point so calculated fields that depend on other calculated fields resolve
     * regardless of document order. Best-effort — a broken expression is skipped.
     */
    public function applyCalculatedFields(array $fields, array $answers): array
    {
        $jobs = [];   // [['id'=>fieldId, 'expression'=>calculationExpression]]
        foreach ($fields as $field) {
            if (($field['type'] ?? '') === 'calculated'
                && !empty($field['id'])
                && is_string($field['properties']['calculationExpression'] ?? null)
                && trim($field['properties']['calculationExpression']) !== '') {
                $jobs[] = ['id' => (string)$field['id'], 'expression' => $field['properties']['calculationExpression']];
            }
        }
        if ($jobs === []) {
            return $answers;
        }

        // Up to N passes (N = number of calculated fields) — enough to resolve any
        // acyclic dependency chain regardless of document order; stops early once
        // nothing changes. Each pass is ONE qjs round-trip for all calculated
        // fields (was one process spawn per field per pass). Best-effort — a
        // broken expression is skipped.
        $passes = count($jobs);
        for ($pass = 0; $pass < $passes; $pass++) {
            try {
                $results = $this->getFormLogic()->evaluateBatch($jobs, $answers);
            } catch (\Throwable $e) {
                break;
            }
            $changed = false;
            foreach ($jobs as $job) {
                $id = $job['id'];
                $r = $results[$id] ?? null;
                if ($r === null || !($r['ok'] ?? false)) {
                    continue;
                }
                $value = $r['value'] ?? null;
                if (!array_key_exists($id, $answers) || $answers[$id] !== $value) {
                    $answers[$id] = $value;
                    $changed = true;
                }
            }
            if (!$changed) {
                break;
            }
        }
        return $answers;
    }

    /**
     * Get all responses for a form
     */
    public function getFormResponses(string $formId, array $options = []): array
    {
        if (!$this->sqlite->formDatabaseExists($formId)) {
            return [];
        }

        $db = $this->sqlite->getFormDatabase($formId);

        $sql = "SELECT * FROM responses";
        $params = [];
        $conditions = [];

        // Status filter
        if (!empty($options['status'])) {
            $conditions[] = "status = :status";
            $params['status'] = $options['status'];
        }

        // Scope filter: restrict to responses submitted by a specific user
        if (!empty($options['submittedByUserId'])) {
            $conditions[] = "json_extract(metadata, '$.submittedByUserId') = :submitted_by";
            $params['submitted_by'] = $options['submittedByUserId'];
        }

        // Date range filter
        if (!empty($options['from'])) {
            $conditions[] = "submitted_at >= :from";
            $params['from'] = $options['from'];
        }

        if (!empty($options['to'])) {
            $conditions[] = "submitted_at <= :to";
            $params['to'] = $options['to'];
        }

        if (!empty($conditions)) {
            $sql .= " WHERE " . implode(' AND ', $conditions);
        }

        $sql .= " ORDER BY submitted_at DESC";

        // Pagination (clamp to safe ranges)
        $limit = max(1, min((int)($options['limit'] ?? 100), 1000));
        $offset = max(0, (int)($options['offset'] ?? 0));
        $sql .= " LIMIT :limit OFFSET :offset";

        $stmt = $db->prepare($sql);
        foreach ($params as $key => $value) {
            $stmt->bindValue($key, $value);
        }
        $stmt->bindValue('limit', (int)$limit, PDO::PARAM_INT);
        $stmt->bindValue('offset', (int)$offset, PDO::PARAM_INT);
        $stmt->execute();

        $rows = $stmt->fetchAll();
        return $this->formatResponses($db, $rows);
    }

    /**
     * Get responses by specific IDs (batch fetch)
     */
    public function getResponsesByIds(string $formId, array $responseIds): array
    {
        if (empty($responseIds) || !$this->sqlite->formDatabaseExists($formId)) {
            return [];
        }

        $db = $this->sqlite->getFormDatabase($formId);
        $allRows = [];

        // Chunk to stay within SQLite variable limits
        foreach (array_chunk($responseIds, 500) as $chunk) {
            $placeholders = implode(',', array_fill(0, count($chunk), '?'));
            $stmt = $db->prepare("SELECT * FROM responses WHERE id IN ($placeholders)");
            $stmt->execute($chunk);
            while ($row = $stmt->fetch()) {
                $allRows[] = $row;
            }
        }

        return $this->formatResponses($db, $allRows);
    }

    /**
     * Search responses using SQL json_extract for efficient filtering
     */
    public function getFormResponsesSearchable(
        string $formId,
        string $searchQuery,
        array $searchFieldIds,
        array $options = []
    ): array {
        if (!$this->sqlite->formDatabaseExists($formId)) {
            return ['responses' => [], 'total' => 0];
        }

        $db = $this->sqlite->getFormDatabase($formId);
        $params = [];
        $conditions = [];

        // Status filter
        if (!empty($options['status'])) {
            $conditions[] = "status = :status";
            $params['status'] = $options['status'];
        }

        // Scope filter: restrict to responses submitted by a specific user
        if (!empty($options['submittedByUserId'])) {
            $conditions[] = "json_extract(metadata, '$.submittedByUserId') = :submitted_by";
            $params['submitted_by'] = $options['submittedByUserId'];
        }

        // Build search conditions using json_extract
        if ($searchQuery !== '') {
            $searchConditions = [];
            // Escape LIKE special characters to prevent wildcard injection
            $escapedSearch = strtr($searchQuery, ['%' => '\%', '_' => '\_']);
            $searchParam = '%' . $escapedSearch . '%';

            if (!empty($searchFieldIds)) {
                foreach ($searchFieldIds as $i => $fieldId) {
                    // Sanitize field ID to prevent SQL injection (allow only alphanumeric and underscore)
                    $safeFieldId = preg_replace('/[^a-zA-Z0-9_]/', '', $fieldId);
                    if ($safeFieldId === '') continue;
                    $paramName = 'search_' . $i;
                    // json_extract path must be a literal, not a bound parameter
                    $searchConditions[] = "json_extract(answers, '\$.$safeFieldId') LIKE :val_$paramName ESCAPE '\'";
                    $params['val_' . $paramName] = $searchParam;
                }
            } else {
                // Fallback: search the entire answers JSON string
                $searchConditions[] = "answers LIKE :search_all ESCAPE '\'";
                $params['search_all'] = $searchParam;
            }

            if (!empty($searchConditions)) {
                $conditions[] = '(' . implode(' OR ', $searchConditions) . ')';
            }
        }

        $whereClause = !empty($conditions) ? " WHERE " . implode(' AND ', $conditions) : '';

        // Get total count
        $countSql = "SELECT COUNT(*) as total FROM responses" . $whereClause;
        $countStmt = $db->prepare($countSql);
        foreach ($params as $key => $value) {
            $countStmt->bindValue($key, $value);
        }
        $countStmt->execute();
        $countRow = $countStmt->fetch();
        $total = $countRow ? (int)$countRow['total'] : 0;

        // Get paginated results
        $limit = max(1, min((int)($options['limit'] ?? 20), 100));
        $offset = max(0, (int)($options['offset'] ?? 0));

        $sql = "SELECT * FROM responses" . $whereClause . " ORDER BY submitted_at DESC LIMIT :limit OFFSET :offset";
        $stmt = $db->prepare($sql);
        foreach ($params as $key => $value) {
            $stmt->bindValue($key, $value);
        }
        $stmt->bindValue('limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue('offset', $offset, PDO::PARAM_INT);
        $stmt->execute();

        $rows = $stmt->fetchAll();
        return ['responses' => $this->formatResponses($db, $rows), 'total' => $total];
    }

    /**
     * Get a single response by ID
     */
    public function getResponse(string $formId, string $responseId): ?array
    {
        if (!$this->sqlite->formDatabaseExists($formId)) {
            return null;
        }

        $db = $this->sqlite->getFormDatabase($formId);
        $stmt = $db->prepare("SELECT * FROM responses WHERE id = :id");
        $stmt->execute(['id' => $responseId]);
        $row = $stmt->fetch();

        if (!$row) {
            return null;
        }

        return $this->formatResponse($db, $row);
    }

    /** Whether a form still exists in MySQL (the source of truth for form lifecycle). */
    private function formExists(string $formId): bool
    {
        try {
            $stmt = $this->mysql->prepare('SELECT 1 FROM forms WHERE id = :id LIMIT 1');
            $stmt->execute(['id' => $formId]);
            return (bool) $stmt->fetchColumn();
        } catch (\Throwable $e) {
            // Don't block submissions on a metadata-store error — the MySQL FK on
            // the metadata insert still enforces existence. Fail open.
            $this->logger->error('formExists check failed (allowing submission)', [
                'formId' => $formId, 'error' => $e->getMessage(),
            ]);
            return true;
        }
    }

    /**
     * Create a new response (form submission)
     *
     * @param string $formId The form ID
     * @param array $data The submission data
     * @param string|null $script Optional FormLogic script to execute
     * @return array|ScriptRejection The created response or a rejection
     */
    public function createResponse(string $formId, array $data, ?string $script = null): array|ScriptRejection
    {
        // Guard against a form deleted between the controller's existence check and
        // now: getFormDatabase() would otherwise resurrect a per-form SQLite DB for
        // a form that no longer exists (orphaned file + a guaranteed MySQL FK 500).
        if (!$this->formExists($formId)) {
            throw new \RuntimeException('Form not found');
        }

        $db = $this->sqlite->getFormDatabase($formId);

        // Run migrations to ensure new tables exist
        $this->sqlite->migrateFormDatabase($db);

        // Always generate server-side ID; ignore client-supplied ID to prevent collision attacks
        $id = $this->generateUuid();
        $now = date('Y-m-d H:i:s');

        // 1. Execute script FIRST if exists (to allow rejection)
        $scriptResult = null;
        if ($this->runtime !== null && $script !== null && trim($script) !== '') {
            $scriptResult = $this->runtime->execute($script, [
                'answers' => $data['answers'] ?? [],
                'ipAddress' => $data['ipAddress'] ?? null,
                'userAgent' => $data['userAgent'] ?? null,
                'timestamp' => time(),
                'responseId' => $id,
                'formId' => $formId,
            ]);

            // Handle rejection
            if ($scriptResult->isRejected()) {
                return new ScriptRejection($scriptResult->rejectionMessage ?? 'Submission rejected');
            }
        }

        // 2. Determine initial status (may be overridden by script)
        $allowedStatuses = ['submitted', 'reviewed', 'approved', 'rejected', 'archived'];
        $status = 'submitted'; // Always default to 'submitted' — ignore client-supplied status
        if ($scriptResult !== null && $scriptResult->success && $scriptResult->status !== null) {
            $status = in_array($scriptResult->status, $allowedStatuses, true) ? $scriptResult->status : 'submitted';
        }

        // 3. Insert into SQLite
        $stmt = $db->prepare("
            INSERT INTO responses (id, answers, metadata, status, submitted_at, updated_at)
            VALUES (:id, :answers, :metadata, :status, :submitted_at, :updated_at)
        ");

        // Steps 3-5 atomically: insert the response, then apply script results and
        // log the execution in ONE SQLite transaction. Previously these ran in
        // autocommit, so a throw in applyScriptResult/logScriptExecution left a
        // committed response row with no MySQL metadata (dual-DB divergence) and a
        // 500. Now any failure rolls the whole response back.
        $db->beginTransaction();
        try {
            $stmt->execute([
                'id' => $id,
                'answers' => json_encode($data['answers'] ?? []),
                'metadata' => json_encode([
                    'userAgent' => $data['userAgent'] ?? null,
                    'referrer' => $data['referrer'] ?? null,
                    'completionTime' => $data['completionTime'] ?? null,
                    'ipAddress' => $data['ipAddress'] ?? null,
                    'submittedByUserId' => $data['submittedByUserId'] ?? null,
                ]),
                'status' => $status,
                'submitted_at' => $now,
                'updated_at' => $now,
            ]);

            // 4. Apply script results (computed fields, tags)
            if ($scriptResult !== null && $scriptResult->success) {
                $this->applyScriptResult($db, $id, $scriptResult);
            }

            // 5. Log script execution
            if ($scriptResult !== null) {
                $this->logScriptExecution($db, $id, $scriptResult);
            }

            $db->commit();
        } catch (\Throwable $e) {
            if ($db->inTransaction()) {
                $db->rollBack();
            }
            throw $e;
        }

        // 6. Also insert metadata into MySQL for global querying
        $mysqlStmt = $this->mysql->prepare("
            INSERT INTO response_metadata (id, form_id, status, submitted_at, ip_address, user_agent, completion_time)
            VALUES (:id, :form_id, :status, :submitted_at, :ip_address, :user_agent, :completion_time)
        ");

        try {
            $mysqlStmt->execute([
                'id' => $id,
                'form_id' => $formId,
                'status' => $status,
                'submitted_at' => $now,
                'ip_address' => $data['ipAddress'] ?? null,
                'user_agent' => $data['userAgent'] ?? null,
                'completion_time' => $data['completionTime'] ?? null,
            ]);
        } catch (\Exception $mysqlErr) {
            // Compensating delete on SQLite if MySQL insert fails
            $db->exec("DELETE FROM responses WHERE id = " . $db->quote($id));
            throw $mysqlErr;
        }

        // 7. Update analytics (best-effort: the response is already committed, so a
        // failure here must NOT bubble up and turn a saved submission into a 500 —
        // that would make the submitter re-submit and create a duplicate response).
        try {
            $this->updateAnalytics($formId, 'completion');
        } catch (\Throwable $analyticsErr) {
            $this->logger->error('Failed to update analytics after response create', [
                'formId' => $formId,
                'error' => $analyticsErr->getMessage(),
            ]);
        }

        // Keep the denormalized MySQL response_count in sync for list views.
        $this->syncResponseCount($formId);

        // 8. Read back + dispatch webhook, best-effort: the response is durably
        // saved in both stores by now, so a read/format/delivery error must NOT
        // bubble up and turn a saved submission into a 500 (the submitter would
        // retry and create a duplicate).
        $createdResponse = null;
        try {
            $createdResponse = $this->getResponse($formId, $id);

            if ($this->webhookService !== null && $createdResponse) {
                $webhookPayload = $createdResponse;
                unset($webhookPayload['metadata']['ipAddress'], $webhookPayload['metadata']['userAgent'], $webhookPayload['metadata']['referrer']);
                $this->webhookService->dispatch($formId, 'response.created', $webhookPayload);
            }
        } catch (\Throwable $postErr) {
            $this->logger->error('Post-persist read/webhook failed after response create', [
                'formId' => $formId,
                'responseId' => $id,
                'error' => $postErr->getMessage(),
            ]);
        }

        return $createdResponse ?? [
            'id' => $id,
            'status' => $status,
            'submittedAt' => $now,
            'updatedAt' => $now,
            'answers' => $data['answers'] ?? [],
        ];
    }

    /**
     * Sync response_links rows for a response's linked_record fields so inverse
     * "related records" lookups work for submissions made via the standalone
     * public endpoint and the External API. (The app-runtime path syncs these
     * separately in AppResponseService; deleteResponse already purges them.)
     * Best-effort: a link-sync failure must not fail an already-persisted
     * response.
     *
     * @param array $fields The form's field definitions (the caller already has the form)
     */
    public function syncResponseLinks(string $formId, string $responseId, array $fields, array $answers): void
    {
        if ($responseId === '') {
            return;
        }
        $linkedFields = [];
        foreach ($fields as $field) {
            if (($field['type'] ?? '') === 'linked_record' && !empty($field['properties']['targetFormId'])) {
                $linkedFields[] = $field;
            }
        }
        if (empty($linkedFields)) {
            return;
        }

        try {
            $this->mysql->beginTransaction();

            $del = $this->mysql->prepare("DELETE FROM response_links WHERE source_response_id = :id");
            $del->execute(['id' => $responseId]);

            $ins = $this->mysql->prepare("
                INSERT INTO response_links (id, source_form_id, source_response_id, target_form_id, target_response_id, field_id)
                VALUES (:id, :source_form_id, :source_response_id, :target_form_id, :target_response_id, :field_id)
            ");

            foreach ($linkedFields as $field) {
                $targetFormId = $field['properties']['targetFormId'];
                $val = $answers[$field['id']] ?? null;
                if ($val === null) {
                    continue;
                }
                $ids = is_array($val) ? $val : [$val];
                foreach ($ids as $targetResponseId) {
                    if (!is_string($targetResponseId) || $targetResponseId === '') {
                        continue;
                    }
                    // Verify the target actually exists under target_form_id so a
                    // client can't spoof dangling/cross-form link rows.
                    if (!$this->responseExistsInForm($targetFormId, $targetResponseId)) {
                        continue;
                    }
                    $ins->execute([
                        'id' => $this->generateUuid(),
                        'source_form_id' => $formId,
                        'source_response_id' => $responseId,
                        'target_form_id' => $targetFormId,
                        'target_response_id' => $targetResponseId,
                        'field_id' => $field['id'],
                    ]);
                }
            }

            $this->mysql->commit();
        } catch (\Throwable $e) {
            if ($this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            $this->logger->error('Failed to sync response_links', [
                'formId' => $formId,
                'responseId' => $responseId,
                'error' => $e->getMessage(),
            ]);
        }
    }

    /**
     * Whether a response id exists in a form's per-form SQLite DB. Best-effort
     * (returns false if the DB doesn't exist); used to validate linked_record
     * targets before writing inverse-link rows.
     */
    private function responseExistsInForm(string $formId, string $responseId): bool
    {
        try {
            if (!$this->sqlite->formDatabaseExists($formId)) {
                return false;
            }
            $db = $this->sqlite->getFormDatabase($formId);
            $stmt = $db->prepare("SELECT 1 FROM responses WHERE id = :id LIMIT 1");
            $stmt->execute(['id' => $responseId]);
            return $stmt->fetchColumn() !== false;
        } catch (\Throwable $e) {
            return false;
        }
    }

    /**
     * Re-run script on an existing response
     */
    public function recomputeResponse(string $formId, string $responseId, string $script): ScriptResult
    {
        $response = $this->getResponse($formId, $responseId);
        if (!$response) {
            return ScriptResult::error('Response not found');
        }

        if ($this->runtime === null) {
            return ScriptResult::error('Script runtime not available');
        }

        $result = $this->runtime->execute($script, [
            'answers' => $response['answers'],
            'responseId' => $responseId,
            'formId' => $formId,
            'timestamp' => time(),
        ]);

        if ($result->success && !$result->isRejected()) {
            $db = $this->sqlite->getFormDatabase($formId);

            // Run migrations to ensure new tables exist
            $this->sqlite->migrateFormDatabase($db);

            // Clear existing computed fields and tags
            $this->clearComputedData($db, $responseId);

            // Apply new results
            $this->applyScriptResult($db, $responseId, $result);

            // Update status if changed
            if ($result->status !== null) {
                $this->updateResponse($formId, $responseId, ['status' => $result->status]);
            }

            // Log execution
            $this->logScriptExecution($db, $responseId, $result);
        }

        return $result;
    }

    /**
     * Run a script against sample answers WITHOUT persisting anything — powers the
     * ScriptEditor "Test" button so authors can run their onSubmit before saving.
     * ctx.db operations are captured and returned (never written); ctx.http still
     * makes real, SSRF-guarded external calls so the test reflects production.
     *
     * @param array<string, mixed> $answers Sample form answers
     * @param array{ipAddress?: ?string, userAgent?: ?string, formId?: ?string} $meta
     */
    public function testScript(string $script, array $answers, array $meta = []): ScriptResult
    {
        if ($this->runtime === null) {
            return ScriptResult::error('Script runtime not available');
        }
        return $this->runtime->execute($script, [
            'answers' => $answers,
            'ipAddress' => $meta['ipAddress'] ?? null,
            'userAgent' => $meta['userAgent'] ?? null,
            'timestamp' => time(),
            'responseId' => 'test-' . $this->generateUuid(),
            'formId' => $meta['formId'] ?? null,
        ]);
    }

    /**
     * Apply script results to the database
     */
    private function applyScriptResult(PDO $db, string $responseId, ScriptResult $result): void
    {
        // Store computed fields
        foreach ($result->fields as $name => $value) {
            $stmt = $db->prepare("
                INSERT OR REPLACE INTO computed (response_id, field_name, field_value)
                VALUES (:response_id, :field_name, :field_value)
            ");
            $stmt->execute([
                'response_id' => $responseId,
                'field_name' => $name,
                'field_value' => is_scalar($value) ? (string)$value : json_encode($value),
            ]);
        }

        // Store tags
        foreach ($result->tags as $tag) {
            $stmt = $db->prepare("
                INSERT OR IGNORE INTO tags (response_id, tag)
                VALUES (:response_id, :tag)
            ");
            $stmt->execute([
                'response_id' => $responseId,
                'tag' => $tag,
            ]);
        }
    }

    /**
     * Clear computed data for a response (before recompute)
     */
    private function clearComputedData(PDO $db, string $responseId): void
    {
        $db->prepare("DELETE FROM computed WHERE response_id = :id")->execute(['id' => $responseId]);
        $db->prepare("DELETE FROM tags WHERE response_id = :id")->execute(['id' => $responseId]);
    }

    /**
     * Log script execution for debugging
     */
    private function logScriptExecution(PDO $db, string $responseId, ScriptResult $result): void
    {
        $stmt = $db->prepare("
            INSERT INTO script_logs (response_id, success, error_message, execution_time_ms, instruction_count)
            VALUES (:response_id, :success, :error_message, :execution_time_ms, :instruction_count)
        ");
        $stmt->execute([
            'response_id' => $responseId,
            'success' => $result->success ? 1 : 0,
            'error_message' => $result->error,
            'execution_time_ms' => $result->executionTimeMs,
            'instruction_count' => $result->instructionCount,
        ]);
    }

    /**
     * Update a response
     */
    public function updateResponse(string $formId, string $responseId, array $data): ?array
    {
        if (!$this->sqlite->formDatabaseExists($formId)) {
            return null;
        }

        $db = $this->sqlite->getFormDatabase($formId);

        $updates = [];
        $params = ['id' => $responseId];

        if (isset($data['answers'])) {
            $updates[] = "answers = :answers";
            $params['answers'] = json_encode($data['answers']);
        }

        if (isset($data['status'])) {
            $allowedStatuses = ['submitted', 'reviewed', 'approved', 'rejected', 'archived'];
            if (!in_array($data['status'], $allowedStatuses, true)) {
                throw new \RuntimeException('Invalid status. Allowed: ' . implode(', ', $allowedStatuses));
            }
            $updates[] = "status = :status";
            $params['status'] = $data['status'];
        }

        if (empty($updates)) {
            return $this->getResponse($formId, $responseId);
        }

        $updates[] = "updated_at = :updated_at";
        $params['updated_at'] = date('Y-m-d H:i:s');

        $sql = "UPDATE responses SET " . implode(', ', $updates) . " WHERE id = :id";
        $stmt = $db->prepare($sql);
        $stmt->execute($params);

        // Mirror the status into the MySQL metadata index AFTER the authoritative
        // SQLite row is updated. Doing MySQL first meant a failed SQLite UPDATE
        // would leave MySQL showing the new status while SQLite kept the old one,
        // permanently desyncing the global index from the per-form record.
        if (isset($data['status'])) {
            // Best-effort mirror: the authoritative SQLite update already succeeded,
            // so a metadata-index failure must not 500 the caller. Status updates
            // are idempotent, so a retry/reconciliation is safe.
            try {
                $mysqlStmt = $this->mysql->prepare("
                    UPDATE response_metadata SET status = :status WHERE id = :id
                ");
                $mysqlStmt->execute(['status' => $data['status'], 'id' => $responseId]);
            } catch (\Throwable $mirrorErr) {
                $this->logger->error('Failed to mirror response status to response_metadata', [
                    'responseId' => $responseId,
                    'error' => $mirrorErr->getMessage(),
                ]);
            }
        }

        $updatedResponse = $this->getResponse($formId, $responseId);

        // Dispatch webhook (strip sensitive metadata from payload); best-effort so a
        // delivery failure doesn't 500 a successful update.
        if ($this->webhookService !== null && $updatedResponse) {
            try {
                $webhookPayload = $updatedResponse;
                unset($webhookPayload['metadata']['ipAddress'], $webhookPayload['metadata']['userAgent'], $webhookPayload['metadata']['referrer']);
                $this->webhookService->dispatch($formId, 'response.updated', $webhookPayload);
            } catch (\Throwable $hookErr) {
                $this->logger->error('Webhook dispatch failed after response update', [
                    'formId' => $formId, 'responseId' => $responseId, 'error' => $hookErr->getMessage(),
                ]);
            }
        }

        return $updatedResponse;
    }

    /**
     * Delete a response
     */
    public function deleteResponse(string $formId, string $responseId): bool
    {
        if (!$this->sqlite->formDatabaseExists($formId)) {
            return false;
        }

        $db = $this->sqlite->getFormDatabase($formId);

        // Read answers up front (to locate uploaded files) but DON'T delete the
        // files yet: files are unrecoverable, so we remove them only AFTER the
        // authoritative record is gone. Deleting them first risked a surviving
        // response row pointing at already-deleted files on a later failure.
        $answers = null;
        if ($this->fileStorageService !== null) {
            $fetchStmt = $db->prepare("SELECT answers FROM responses WHERE id = :id");
            $fetchStmt->execute(['id' => $responseId]);
            $row = $fetchStmt->fetch(PDO::FETCH_ASSOC);
            if ($row && !empty($row['answers'])) {
                $decoded = json_decode($row['answers'], true);
                if (is_array($decoded)) {
                    $answers = $decoded;
                }
            }
        }

        // Delete the authoritative SQLite row first (source of truth).
        $stmt = $db->prepare("DELETE FROM responses WHERE id = :id");
        $stmt->execute(['id' => $responseId]);
        $deleted = $stmt->rowCount() > 0;

        if ($deleted) {
            // Cross-store cleanup is best-effort: the source-of-truth row is already
            // gone, so a MySQL hiccup must not abort the method (it would only leave
            // a reconcilable orphan metadata/link row, not corrupt data).
            try {
                $mysqlStmt = $this->mysql->prepare("DELETE FROM response_metadata WHERE id = :id");
                $mysqlStmt->execute(['id' => $responseId]);

                $linkStmt = $this->mysql->prepare(
                    "DELETE FROM response_links WHERE source_response_id = :id1 OR target_response_id = :id2"
                );
                $linkStmt->execute(['id1' => $responseId, 'id2' => $responseId]);
            } catch (\Throwable $metaErr) {
                $this->logger->error('Cross-store cleanup failed after response delete', [
                    'formId' => $formId, 'responseId' => $responseId, 'error' => $metaErr->getMessage(),
                ]);
            }

            // Now remove the (unrecoverable) uploaded files — last, after the record
            // is gone.
            if ($this->fileStorageService !== null && is_array($answers)) {
                try {
                    $this->fileStorageService->deleteResponseFiles($formId, $answers);
                } catch (\Throwable $fileErr) {
                    $this->logger->error('File cleanup failed after response delete', [
                        'formId' => $formId, 'responseId' => $responseId, 'error' => $fileErr->getMessage(),
                    ]);
                }
            }

            // Dispatch webhook (best-effort).
            if ($this->webhookService !== null) {
                try {
                    $this->webhookService->dispatch($formId, 'response.deleted', ['id' => $responseId]);
                } catch (\Throwable $hookErr) {
                    $this->logger->error('Webhook dispatch failed after response delete', [
                        'formId' => $formId, 'responseId' => $responseId, 'error' => $hookErr->getMessage(),
                    ]);
                }
            }

            // Keep the denormalized MySQL response_count in sync for list views.
            $this->syncResponseCount($formId);
        }

        return $deleted;
    }

    /**
     * Recompute the per-form response count from the source-of-truth SQLite table
     * and store it on the MySQL forms row (denormalized for list views). Recompute
     * (not increment) so the count can't drift; best-effort so a sync failure never
     * breaks the response create/delete it follows.
     */
    private function syncResponseCount(string $formId): void
    {
        try {
            $count = $this->getResponseCount($formId);
            $stmt = $this->mysql->prepare("UPDATE forms SET response_count = :cnt WHERE id = :id");
            $stmt->execute(['cnt' => $count, 'id' => $formId]);
        } catch (\Throwable $e) {
            $this->logger->error('Failed to sync response_count', ['formId' => $formId, 'error' => $e->getMessage()]);
        }
    }

    /**
     * Get response count for a form
     */
    public function getResponseCount(string $formId, ?string $submittedByUserId = null): int
    {
        if (!$this->sqlite->formDatabaseExists($formId)) {
            return 0;
        }

        $db = $this->sqlite->getFormDatabase($formId);

        if ($submittedByUserId !== null) {
            $stmt = $db->prepare("SELECT COUNT(*) as count FROM responses WHERE json_extract(metadata, '$.submittedByUserId') = :submitted_by");
            $stmt->execute(['submitted_by' => $submittedByUserId]);
        } else {
            $stmt = $db->query("SELECT COUNT(*) as count FROM responses");
        }

        $row = $stmt->fetch();
        return (int)($row['count'] ?? 0);
    }

    /**
     * Per-form advisory lock (MySQL GET_LOCK), used as a cross-process mutex so a
     * quota check + insert can be made atomic and concurrent submissions cannot
     * both pass the check and overshoot the cap. Responses live in SQLite but the
     * mutex is shared via MySQL. Fails open (returns null) so a lock hiccup never
     * blocks submissions; release with releaseFormLock().
     */
    public function acquireFormLock(string $formId, int $timeoutSeconds = 5): ?string
    {
        $name = 'fl_form_submit_' . substr(hash('sha256', $formId), 0, 40);
        try {
            $stmt = $this->mysql->prepare("SELECT GET_LOCK(:n, :t)");
            $stmt->bindValue(':n', $name);
            $stmt->bindValue(':t', $timeoutSeconds, PDO::PARAM_INT);
            $stmt->execute();
            return ((int) $stmt->fetchColumn() === 1) ? $name : null;
        } catch (\Exception $e) {
            return null;
        }
    }

    public function releaseFormLock(?string $name): void
    {
        if ($name === null) {
            return;
        }
        try {
            $stmt = $this->mysql->prepare("SELECT RELEASE_LOCK(:n)");
            $stmt->execute(['n' => $name]);
        } catch (\Exception $e) {
            // best-effort; the lock also releases on connection close
        }
    }

    /**
     * Get form analytics
     */
    public function getFormAnalytics(string $formId, array $options = []): array
    {
        // Default analytics response
        $defaultAnalytics = [
            'totalResponses' => 0,
            'totalViews' => 0,
            'totalStarts' => 0,
            'completionRate' => 0,
            'averageCompletionTime' => 0,
            'responsesByDate' => [],
        ];

        try {
            // Get response stats from SQLite
            $responseCount = $this->getResponseCount($formId);

            if (!$this->sqlite->formDatabaseExists($formId)) {
                // Try to get stats from MySQL only
                $mysqlStmt = $this->mysql->prepare("
                    SELECT
                        COALESCE(SUM(views), 0) as total_views,
                        COALESCE(SUM(starts), 0) as total_starts,
                        COALESCE(SUM(completions), 0) as total_completions
                    FROM form_analytics
                    WHERE form_id = :form_id
                ");
                $mysqlStmt->execute(['form_id' => $formId]);
                $aggregates = $mysqlStmt->fetch() ?: [];

                return [
                    'totalResponses' => 0,
                    'totalViews' => (int)($aggregates['total_views'] ?? 0),
                    'totalStarts' => (int)($aggregates['total_starts'] ?? 0),
                    'completionRate' => 0,
                    'averageCompletionTime' => 0,
                    'responsesByDate' => [],
                ];
            }

            $db = $this->sqlite->getFormDatabase($formId);

            // Average completion time: a single DB-side aggregate over ALL rows.
            // Previously fetched up to 1000 full rows via getFormResponses (which
            // also ran computed/tags batch queries + decoded answers/computed for
            // every row) just to average one metadata field — and only over the
            // most-recent 1000. json_extract is used throughout this service.
            $avgTime = 0;
            try {
                $stmt = $db->query(
                    "SELECT AVG(CAST(json_extract(metadata, '$.completionTime') AS REAL))
                     FROM responses
                     WHERE json_extract(metadata, '$.completionTime') IS NOT NULL"
                );
                $avgTime = (float)($stmt->fetchColumn() ?: 0);
            } catch (\Exception $e) {
                // Log but continue - avgTime will remain 0
                $this->logger->warning('Analytics avgTime calculation error', ['formId' => $formId, 'exception' => $e->getMessage()]);
            }

            // Responses by date (last 30 days)
            $responsesByDate = [];
            try {
                $stmt = $db->query("
                    SELECT date(submitted_at) as date, COUNT(*) as count
                    FROM responses
                    WHERE submitted_at >= date('now', '-30 days')
                    GROUP BY date(submitted_at)
                    ORDER BY date ASC
                ");

                while ($row = $stmt->fetch()) {
                    $responsesByDate[] = [
                        'date' => $row['date'],
                        'count' => (int)$row['count'],
                    ];
                }
            } catch (\Exception $e) {
                // Log but continue - responsesByDate will remain empty
                $this->logger->warning('Analytics responsesByDate error', ['formId' => $formId, 'exception' => $e->getMessage()]);
            }

            // Get aggregate stats from MySQL
            $mysqlStmt = $this->mysql->prepare("
                SELECT
                    COALESCE(SUM(views), 0) as total_views,
                    COALESCE(SUM(starts), 0) as total_starts,
                    COALESCE(SUM(completions), 0) as total_completions
                FROM form_analytics
                WHERE form_id = :form_id
            ");
            $mysqlStmt->execute(['form_id' => $formId]);
            $aggregates = $mysqlStmt->fetch() ?: [];

            $totalViews = (int)($aggregates['total_views'] ?? 0);
            $totalStarts = (int)($aggregates['total_starts'] ?? 0);
            $totalCompletions = (int)($aggregates['total_completions'] ?? 0) ?: $responseCount;

            // Completion (conversion) rate = completed submissions vs form views.
            // Capped at 100% because a single view can yield multiple completions
            // (refresh, embeds) and because completions recorded before view
            // tracking shipped have no matching view. Falls back to starts, then
            // to "100% if there are responses" when no view data exists yet.
            $denominator = $totalViews > 0 ? $totalViews : $totalStarts;
            $completionRate = $denominator > 0
                ? min(100, ($totalCompletions / $denominator) * 100)
                : ($responseCount > 0 ? 100 : 0);

            return [
                'totalResponses' => $responseCount,
                'totalViews' => $totalViews,
                'totalStarts' => $totalStarts,
                'completionRate' => round($completionRate, 2),
                'averageCompletionTime' => round((float)$avgTime, 2),
                'responsesByDate' => $responsesByDate,
            ];
        } catch (\Exception $e) {
            // Log the error but return default analytics
            $this->logger->error('Analytics error', ['formId' => $formId, 'exception' => $e->getMessage()]);
            return $defaultAnalytics;
        }
    }

    /**
     * Export responses to CSV format
     */
    /**
     * Export responses as CSV, writing to the provided stream in batches.
     * Returns headers array for Content-Disposition.
     *
     * @param resource $outputStream A writable stream (e.g. php://output)
     */
    public function exportResponsesStreaming(string $formId, array $fields, $outputStream): int
    {
        // Identify linked_record fields for display value resolution
        $linkedFields = [];
        foreach ($fields as $field) {
            if (($field['type'] ?? '') === 'linked_record' && !empty($field['properties']['targetFormId'])) {
                $linkedFields[$field['id']] = $field;
            }
        }

        // Restrict linked-record resolution to forms owned by THIS form's owner,
        // so a crafted cross-tenant targetFormId can't leak another user's data.
        $exportOwnerId = null;
        if (!empty($linkedFields)) {
            $ownerStmt = $this->mysql->prepare("SELECT user_id FROM forms WHERE id = :id");
            $ownerStmt->execute(['id' => $formId]);
            $exportOwnerId = $ownerStmt->fetchColumn() ?: null;
        }

        // Write UTF-8 BOM so Excel correctly interprets Unicode characters
        fwrite($outputStream, "\xEF\xBB\xBF");

        // Header row (sanitize against CSV formula injection)
        $headers = ['Response ID', 'Submitted At', 'Status'];
        foreach ($fields as $field) {
            $label = $field['label'] ?? $field['id'];
            // Same neutralization as the data rows below (leading whitespace/TAB/CR
            // before a formula trigger) so the header can't smuggle a formula either.
            if (is_string($label) && preg_match('/^\s*[=+\-@\t\r]/', $label)) {
                $label = "'" . $label;
            }
            $headers[] = $label;
        }
        fputcsv($outputStream, $headers);

        $batchSize = 500;
        $offset = 0;
        $totalWritten = 0;
        $maxExportRows = 100000; // Hard limit to prevent DoS

        do {
            $batch = $this->getFormResponses($formId, [
                'limit' => $batchSize,
                'offset' => $offset,
            ]);

            // Resolve linked record display values for this batch
            $linkedDisplayCache = [];
            if (!empty($linkedFields)) {
                $linkedDisplayCache = $this->resolveLinkedRecordDisplayValues($batch, $linkedFields, $exportOwnerId);
            }

            foreach ($batch as $response) {
                $row = [
                    $response['id'],
                    $response['submittedAt'],
                    $response['status'],
                ];

                foreach ($fields as $field) {
                    $value = $response['answers'][$field['id']] ?? '';

                    // Resolve linked record IDs to display text
                    if (isset($linkedFields[$field['id']]) && $value !== '' && $value !== null) {
                        $targetFormId = $linkedFields[$field['id']]['properties']['targetFormId'];
                        if (is_array($value)) {
                            $displayParts = [];
                            foreach ($value as $refId) {
                                $displayParts[] = $linkedDisplayCache[$targetFormId][$refId] ?? $refId;
                            }
                            $value = implode(', ', $displayParts);
                        } else {
                            $value = $linkedDisplayCache[$targetFormId][$value] ?? $value;
                        }
                    } elseif ($field['type'] === 'file_upload' && is_array($value)) {
                        $value = implode(', ', array_map(fn($f) => $f['originalFilename'] ?? 'File', $value));
                    } elseif ($field['type'] === 'location' && is_array($value)) {
                        $lat = $value['latitude'] ?? '';
                        $lng = $value['longitude'] ?? '';
                        $value = $lat !== '' && $lng !== '' ? "$lat, $lng" : '';
                    } elseif (is_array($value)) {
                        $value = implode(', ', array_map(fn($v) => is_array($v) ? json_encode($v) : (string)$v, $value));
                    }

                    $row[] = $value;
                }

                // Prevent CSV formula injection (also check after trimming whitespace/tabs)
                foreach ($row as &$cell) {
                    if (is_string($cell) && preg_match('/^\s*[=+\-@\t\r]/', $cell)) {
                        $cell = "'" . $cell;
                    }
                }
                unset($cell);
                fputcsv($outputStream, $row);
                $totalWritten++;
            }

            $offset += $batchSize;
        } while (count($batch) === $batchSize && $totalWritten < $maxExportRows);

        return $totalWritten;
    }

    /**
     * Resolve linked record IDs to display text for a batch of responses.
     * Returns: [targetFormId => [responseId => displayText]]
     */
    private function resolveLinkedRecordDisplayValues(array $responses, array $linkedFields, ?string $ownerId = null): array
    {
        // Collect all referenced IDs grouped by target form
        $refsByForm = []; // targetFormId => [id => true]
        foreach ($responses as $resp) {
            $answers = $resp['answers'] ?? [];
            foreach ($linkedFields as $fieldId => $field) {
                $targetFormId = $field['properties']['targetFormId'];
                $val = $answers[$fieldId] ?? null;
                if ($val === null || $val === '' || $val === []) continue;

                if (!isset($refsByForm[$targetFormId])) {
                    $refsByForm[$targetFormId] = [];
                }

                if (is_array($val)) {
                    foreach ($val as $id) {
                        if (is_string($id) && $id !== '') {
                            $refsByForm[$targetFormId][$id] = true;
                        }
                    }
                } elseif (is_string($val) && $val !== '') {
                    $refsByForm[$targetFormId][$val] = true;
                }
            }
        }

        // Cross-tenant guard: only resolve target forms owned by the exporting
        // user. A linked_record pointing at another tenant's form is skipped
        // (its column shows the raw id rather than leaking that form's data).
        // Fail CLOSED: if the owner is unknown, resolve NOTHING rather than
        // resolving every referenced form (which would leak other tenants' data).
        if (!empty($refsByForm)) {
            if ($ownerId === null) {
                $refsByForm = [];
            } else {
                $targetIds = array_keys($refsByForm);
                $placeholders = implode(',', array_fill(0, count($targetIds), '?'));
                $ownStmt = $this->mysql->prepare("SELECT id FROM forms WHERE id IN ($placeholders) AND user_id = ?");
                $ownStmt->execute(array_merge($targetIds, [$ownerId]));
                $allowed = array_flip($ownStmt->fetchAll(\PDO::FETCH_COLUMN));
                $refsByForm = array_intersect_key($refsByForm, $allowed);
            }
        }

        // Batch-fetch and build display text
        $cache = []; // targetFormId => [responseId => displayText]
        foreach ($refsByForm as $targetFormId => $idMap) {
            $cache[$targetFormId] = [];
            $targetResponses = $this->getResponsesByIds($targetFormId, array_keys($idMap));

            // Determine display field IDs from the linked field config
            $displayFieldIds = [];
            foreach ($linkedFields as $field) {
                if (($field['properties']['targetFormId'] ?? '') === $targetFormId) {
                    $displayFieldIds = $field['properties']['displayFieldIds'] ?? [];
                    break;
                }
            }

            foreach ($targetResponses as $tr) {
                $answers = $tr['answers'] ?? [];
                $parts = [];

                if (!empty($displayFieldIds)) {
                    foreach ($displayFieldIds as $dfid) {
                        $val = $answers[$dfid] ?? null;
                        if ($val !== null && $val !== '') {
                            $parts[] = is_array($val) ? implode(', ', $val) : (string)$val;
                        }
                    }
                } else {
                    // Fallback: use the first text-like values
                    $count = 0;
                    foreach ($answers as $val) {
                        if ($count >= 2) break;
                        if (is_string($val) && $val !== '') {
                            $parts[] = $val;
                            $count++;
                        }
                    }
                }

                $cache[$targetFormId][$tr['id']] = implode(' - ', $parts) ?: ('Record ' . substr($tr['id'], 0, 8));
            }
        }

        return $cache;
    }

    /**
     * @deprecated Use exportResponsesStreaming() for memory-efficient export
     */
    public function exportResponses(string $formId, array $fields): string
    {
        $output = fopen('php://temp', 'r+');
        $this->exportResponsesStreaming($formId, $fields, $output);
        rewind($output);
        $csv = stream_get_contents($output);
        fclose($output);
        return $csv;
    }

    /**
     * Record a form view for analytics. Best-effort — never throws so it can be
     * called inline from public form-serving endpoints without risking the
     * response. Powers the completion/conversion rate in form analytics.
     */
    public function recordView(string $formId): void
    {
        try {
            $this->updateAnalytics($formId, 'view');
        } catch (\Throwable $e) {
            $this->logger->warning('Failed to record form view', ['formId' => $formId, 'error' => $e->getMessage()]);
        }
    }

    /**
     * Update form analytics
     *
     * Note: Uses validated column names in SQL. The column name is strictly
     * controlled by the match statement and validated against a whitelist
     * to prevent any possibility of SQL injection.
     */
    private function updateAnalytics(string $formId, string $type): void
    {
        $today = date('Y-m-d');

        // Map type to column name - strictly controlled
        $column = match ($type) {
            'view' => 'views',
            'start' => 'starts',
            'completion' => 'completions',
            default => null,
        };

        if (!$column) {
            return;
        }

        // Whitelist validation as defense-in-depth
        // This ensures even if the match statement is extended incorrectly,
        // we won't have SQL injection
        $allowedColumns = ['views', 'starts', 'completions'];
        if (!in_array($column, $allowedColumns, true)) {
            $this->logger->warning('Invalid analytics column attempted', ['column' => $column]);
            return;
        }

        // Use separate prepared statements for each column type
        // This avoids any string interpolation in SQL entirely
        $queries = [
            'views' => "
                INSERT INTO form_analytics (id, form_id, date, views)
                VALUES (:id, :form_id, :date, 1)
                ON DUPLICATE KEY UPDATE views = views + 1
            ",
            'starts' => "
                INSERT INTO form_analytics (id, form_id, date, starts)
                VALUES (:id, :form_id, :date, 1)
                ON DUPLICATE KEY UPDATE starts = starts + 1
            ",
            'completions' => "
                INSERT INTO form_analytics (id, form_id, date, completions)
                VALUES (:id, :form_id, :date, 1)
                ON DUPLICATE KEY UPDATE completions = completions + 1
            ",
        ];

        $stmt = $this->mysql->prepare($queries[$column]);
        $stmt->execute([
            'id' => $this->generateUuid(),
            'form_id' => $formId,
            'date' => $today,
        ]);
    }

    /**
     * Batch-format multiple response rows (2 queries total instead of 2-per-row)
     */
    private function formatResponses(PDO $db, array $rows): array
    {
        if (empty($rows)) {
            return [];
        }

        $responseIds = array_column($rows, 'id');

        // Batch-load computed fields
        $computedMap = []; // responseId => [field_name => value]
        try {
            foreach (array_chunk($responseIds, 500) as $chunk) {
                $placeholders = implode(',', array_fill(0, count($chunk), '?'));
                $stmt = $db->prepare("SELECT response_id, field_name, field_value FROM computed WHERE response_id IN ($placeholders)");
                $stmt->execute($chunk);
                while ($field = $stmt->fetch()) {
                    $value = $field['field_value'];
                    $decoded = json_decode($value, true);
                    $computedMap[$field['response_id']][$field['field_name']] =
                        json_last_error() === JSON_ERROR_NONE ? $decoded : $value;
                }
            }
        } catch (\PDOException $e) {
            $this->logger->warning('Computed fields table not ready', ['exception' => $e->getMessage()]);
        }

        // Batch-load tags
        $tagsMap = []; // responseId => [tag, ...]
        try {
            foreach (array_chunk($responseIds, 500) as $chunk) {
                $placeholders = implode(',', array_fill(0, count($chunk), '?'));
                $stmt = $db->prepare("SELECT response_id, tag FROM tags WHERE response_id IN ($placeholders)");
                $stmt->execute($chunk);
                while ($tagRow = $stmt->fetch()) {
                    $tagsMap[$tagRow['response_id']][] = $tagRow['tag'];
                }
            }
        } catch (\PDOException $e) {
            $this->logger->warning('Tags table not ready', ['exception' => $e->getMessage()]);
        }

        // Assemble results
        $responses = [];
        foreach ($rows as $row) {
            $responseId = $row['id'];
            $responses[] = [
                'id' => $responseId,
                'answers' => json_decode($row['answers'], true),
                'status' => $row['status'],
                'submittedAt' => $row['submitted_at'],
                'updatedAt' => $row['updated_at'],
                'metadata' => json_decode($row['metadata'] ?? '{}', true),
                'computed' => $computedMap[$responseId] ?? [],
                'tags' => $tagsMap[$responseId] ?? [],
            ];
        }

        return $responses;
    }

    /**
     * Format a single response row for output (delegates to batch for consistency)
     */
    private function formatResponse(PDO $db, array $row): array
    {
        $result = $this->formatResponses($db, [$row]);
        return $result[0];
    }

    /**
     * Import responses from CSV data
     *
     * @param string $formId The form to import into
     * @param array $rows Array of associative arrays (CSV rows)
     * @param array $columnMapping Map of CSV column name => field ID
     * @param array $fields Form field definitions for type coercion
     * @return array { created: int, skipped: int, total: int, errors: [{row: int, errors: string[]}] }
     */
    public function importResponses(string $formId, array $rows, array $columnMapping, array $fields): array
    {
        if (count($rows) > 1000) {
            throw new \RuntimeException('Maximum 1000 rows allowed per import');
        }

        // Build field type map from fields array
        $fieldTypeMap = [];
        foreach ($fields as $field) {
            if (isset($field['id']) && isset($field['type'])) {
                $fieldTypeMap[$field['id']] = $field['type'];
            }
        }

        // Don't resurrect a per-form SQLite DB for a form that no longer exists.
        if (!$this->formExists($formId)) {
            throw new \RuntimeException('Form not found');
        }

        $db = $this->sqlite->getFormDatabase($formId);
        $this->sqlite->migrateFormDatabase($db);

        $created = 0;
        $skipped = 0;
        $errors = [];
        $total = count($rows);
        $mysqlInsertedIds = []; // Track for cleanup if SQLite commit fails

        $db->beginTransaction();

        try {
            foreach ($rows as $rowIndex => $row) {
                $rowErrors = [];
                $answers = [];

                // Map CSV columns to field IDs using columnMapping
                foreach ($columnMapping as $csvColumn => $fieldId) {
                    if ($fieldId === '' || $fieldId === 'skip') {
                        continue;
                    }

                    $value = $row[$csvColumn] ?? '';

                    // Coerce types based on field type
                    $fieldType = $fieldTypeMap[$fieldId] ?? 'short_text';
                    switch ($fieldType) {
                        case 'number':
                            if ($value !== '' && !is_numeric($value)) {
                                $rowErrors[] = "Field '{$fieldId}': non-numeric value '{$value}'";
                                continue 2; // skip this field, process remaining fields
                            }
                            $value = $value !== '' ? floatval($value) : null;
                            break;
                        case 'checkboxes':
                            $value = $value !== '' ? array_map('trim', explode(',', $value)) : [];
                            break;
                        case 'rating':
                        case 'scale':
                            if ($value !== '' && !is_numeric($value)) {
                                $rowErrors[] = "Field '{$fieldId}': non-numeric value '{$value}'";
                                continue 2;
                            }
                            $value = $value !== '' ? intval($value) : null;
                            break;
                        default:
                            // Keep as string
                            break;
                    }

                    $answers[$fieldId] = $value;
                }

                if (empty($answers)) {
                    $skipped++;
                    $rowErrors[] = 'No mapped fields had values';
                    $errors[] = ['row' => $rowIndex + 1, 'errors' => $rowErrors];
                    continue;
                }

                // Report partial validation errors even if some fields were valid
                if (!empty($rowErrors)) {
                    $errors[] = ['row' => $rowIndex + 1, 'errors' => $rowErrors];
                }

                try {
                    $id = $this->generateUuid();
                    $now = date('Y-m-d H:i:s');
                    $metadata = [
                        'source' => 'csv_import',
                        'importedAt' => $now,
                    ];

                    // Insert into SQLite responses table
                    $sqliteStmt = $db->prepare("
                        INSERT INTO responses (id, answers, metadata, status, submitted_at, updated_at)
                        VALUES (:id, :answers, :metadata, :status, :submitted_at, :updated_at)
                    ");

                    $sqliteStmt->execute([
                        'id' => $id,
                        'answers' => json_encode($answers),
                        'metadata' => json_encode($metadata),
                        'status' => 'submitted',
                        'submitted_at' => $now,
                        'updated_at' => $now,
                    ]);

                    // Also insert into MySQL response_metadata table
                    try {
                        $mysqlStmt = $this->mysql->prepare("
                            INSERT INTO response_metadata (id, form_id, status, submitted_at)
                            VALUES (:id, :form_id, :status, :submitted_at)
                        ");

                        $mysqlStmt->execute([
                            'id' => $id,
                            'form_id' => $formId,
                            'status' => 'submitted',
                            'submitted_at' => $now,
                        ]);
                        $mysqlInsertedIds[] = $id;
                    } catch (\Exception $mysqlErr) {
                        // Roll back the SQLite insert to keep databases in sync
                        $db->exec("DELETE FROM responses WHERE id = " . $db->quote($id));
                        throw $mysqlErr;
                    }

                    $created++;
                } catch (\Exception $e) {
                    $skipped++;
                    $rowErrors[] = $e->getMessage();
                    $errors[] = ['row' => $rowIndex + 1, 'errors' => $rowErrors];
                }
            }

            $db->commit();
        } catch (\Exception $e) {
            $db->rollBack();
            // Clean up orphaned MySQL rows from successful inserts before the failure
            if (!empty($mysqlInsertedIds)) {
                try {
                    $placeholders = implode(',', array_fill(0, count($mysqlInsertedIds), '?'));
                    $cleanupStmt = $this->mysql->prepare(
                        "DELETE FROM response_metadata WHERE id IN ($placeholders)"
                    );
                    $cleanupStmt->execute($mysqlInsertedIds);
                } catch (\Exception $cleanupErr) {
                    // Log but don't mask the original error
                    $this->logger->warning('Failed to clean up MySQL rows after import rollback', [
                        'formId' => $formId,
                        'orphanedIds' => count($mysqlInsertedIds),
                        'error' => $cleanupErr->getMessage(),
                    ]);
                }
            }
            $this->logger->error('Import failed', [
                'formId' => $formId,
                'error' => $e->getMessage(),
            ]);
            throw new \RuntimeException('Import failed. Please check your file format and try again.');
        }

        return [
            'created' => $created,
            'skipped' => $skipped,
            'total' => $total,
            'errors' => $errors,
        ];
    }

    /**
     * Generate a UUID v4
     */
    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
