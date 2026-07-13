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
    private ?FlowService $flowService;
    private LoggerInterface $logger;
    private ?FormLogicService $formLogicService = null;

    public function __construct(
        MySQLConnection $mysql,
        SQLiteConnection $sqlite,
        ?FormLogicRuntime $runtime = null,
        ?LoggerInterface $logger = null,
        ?WebhookService $webhookService = null,
        ?FileStorageService $fileStorageService = null,
        ?FlowService $flowService = null
    ) {
        $this->mysql = $mysql->getConnection();
        $this->sqlite = $sqlite;
        $this->runtime = $runtime;
        $this->logger = $logger ?? new NullLogger();
        $this->webhookService = $webhookService;
        $this->fileStorageService = $fileStorageService;
        $this->flowService = $flowService;
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
     *
     * Also seeds static defaults for hidden fields (type 'hidden', no calc expression)
     * when the client didn't supply a value — so programmatic/API submits get the
     * default the form author configured, not an empty field (the UI seeds it client-side).
     */
    public function applyCalculatedFields(array $fields, array $answers): array
    {
        // Seed static hidden-field defaults BEFORE computing, so a hidden field with a
        // calc expression still overrides, and a calc that references the hidden field
        // sees the default. Only fills when the value is genuinely absent/empty.
        foreach ($fields as $field) {
            if (($field['type'] ?? '') !== 'hidden' || empty($field['id'])) {
                continue;
            }
            $expr = $field['properties']['calculationExpression'] ?? null;
            if (is_string($expr) && trim($expr) !== '') {
                continue; // calc-driven hidden field — handled below
            }
            $default = $field['properties']['defaultValue'] ?? null;
            $id = (string) $field['id'];
            $hasValue = array_key_exists($id, $answers) && $answers[$id] !== null && $answers[$id] !== '';
            if (!$hasValue && $default !== null && $default !== '') {
                $answers[$id] = $default;
            }
        }

        $jobs = [];   // [['id'=>fieldId, 'expression'=>calculationExpression]]
        foreach ($fields as $field) {
            // Calculated fields AND hidden fields can carry a calculationExpression that is
            // computed server-side (authoritative) from the submitted answers.
            if (in_array($field['type'] ?? '', ['calculated', 'hidden'], true)
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

    /** Aggregate answer-size cap (~2 MB) — bounds DB rows + script/runtime memory. */
    public const MAX_ANSWER_BYTES = 2_000_000;

    /** True if the answers payload exceeds the size cap. */
    public function answersTooLarge(array $answers): bool
    {
        return strlen((string) json_encode($answers)) > self::MAX_ANSWER_BYTES;
    }

    /**
     * Normalize answers before persistence — shared by every write path (public form,
     * app runtime, external API):
     *  - Re-derive each file_upload answer's `url` from the trusted formId + id + filename,
     *    so a submitter can't store an attacker-chosen link later rendered to reviewers.
     *  - De-duplicate multi-select (checkboxes) answer arrays.
     */
    public function normalizeAnswers(array $fields, array $answers, string $formId): array
    {
        $fileFieldIds = [];
        $checkboxFieldIds = [];
        foreach ($fields as $field) {
            $id = $field['id'] ?? null;
            if ($id === null) {
                continue;
            }
            $type = $field['type'] ?? '';
            if ($type === 'file_upload') {
                $fileFieldIds[$id] = true;
            } elseif ($type === 'checkboxes') {
                $checkboxFieldIds[$id] = true;
            }
        }
        if (empty($fileFieldIds) && empty($checkboxFieldIds)) {
            return $answers;
        }
        foreach ($answers as $fieldId => $value) {
            // De-duplicate multi-select answers so a crafted payload can't double-count
            // an option in analytics/exports.
            if (isset($checkboxFieldIds[$fieldId]) && is_array($value)) {
                $answers[$fieldId] = array_values(array_unique($value));
                continue;
            }
            if (!isset($fileFieldIds[$fieldId]) || !is_array($value)) {
                continue;
            }
            foreach ($value as $i => $item) {
                if (!is_array($item) || !isset($item['id'], $item['originalFilename'])) {
                    continue;
                }
                $answers[$fieldId][$i]['url'] = '/api/files/' . rawurlencode($formId)
                    . '/' . rawurlencode((string) $item['id'])
                    . '/' . rawurlencode((string) $item['originalFilename']);
            }
        }
        return $answers;
    }

    /**
     * Strip non-input answers (calculated/statement/welcome/thank-you/hidden fields and unknown
     * field ids) from a programmatic submission. Shared by the External API and MCP write paths —
     * one implementation so the two owner-programmatic surfaces can't drift.
     */
    public function sanitizeSubmittedAnswers(array $fields, mixed $answers): array
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
     * Validate answers against the form's field definitions: conditional required/visibility,
     * per-type shape checks, and builder-configured rules. Returns fieldId → error message
     * (empty = valid). Shared by the External API and MCP write paths (the same checks the
     * public submit path applies in ResponseController::validateAnswers).
     */
    public function validateSubmittedAnswers(array $fields, array $answers): array
    {
        $errors = [];

        // Honor conditional visibility (same as the public path) so a
        // conditionally-hidden required field doesn't reject a valid submission.
        $visibility = $this->computeFieldVisibility($fields, $answers);

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
                $ruleError = $this->validateFieldRules($field, $value);
                if ($ruleError) {
                    $errors[$fieldId] = $ruleError;
                }
            }
        }

        return $errors;
    }

    /**
     * Enforce builder-configured validation server-side. The client enforces these rules,
     * but the External API and any crafted POST bypass the client — so every write path
     * must re-check. Returns an error message, or null if the value passes. Call with a
     * non-empty value (required/empty handling lives in each controller's validateAnswers).
     *
     * @param mixed $value
     */
    public function validateFieldRules(array $field, $value): ?string
    {
        $type = $field['type'] ?? 'short_text';
        $p = $field['properties'] ?? [];

        // Number: min/max from properties (the builder only emits these as native input attrs).
        if ($type === 'number' && is_numeric($value)) {
            $n = (float) $value;
            if (isset($p['min']) && $p['min'] !== '' && is_numeric($p['min']) && $n < (float) $p['min']) {
                return 'Minimum value is ' . $p['min'];
            }
            if (isset($p['max']) && $p['max'] !== '' && is_numeric($p['max']) && $n > (float) $p['max']) {
                return 'Maximum value is ' . $p['max'];
            }
        }

        // Date/time/datetime: reject malformed strings rather than storing junk.
        if (is_string($value) && $value !== '') {
            if ($type === 'date' && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $value)) {
                return 'Invalid date format';
            }
            if ($type === 'time' && !preg_match('/^\d{1,2}:\d{2}(:\d{2})?$/', $value)) {
                return 'Invalid time format';
            }
            if ($type === 'datetime' && !preg_match('/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/', $value)) {
                return 'Invalid date/time format';
            }
        }

        // Builder validation-rules array (minLength/maxLength/min/max/pattern).
        $rules = $field['validation'] ?? null;
        if (!is_array($rules)) {
            return null;
        }
        foreach ($rules as $rule) {
            if (!is_array($rule)) {
                continue;
            }
            $msg = (isset($rule['message']) && $rule['message'] !== '') ? (string) $rule['message'] : 'Invalid value';
            $rval = $rule['value'] ?? null;
            switch ($rule['type'] ?? '') {
                case 'minLength':
                    if (is_string($value) && $value !== '' && mb_strlen($value) < (int) $rval) {
                        return $msg;
                    }
                    break;
                case 'maxLength':
                    if (is_string($value) && mb_strlen($value) > (int) $rval) {
                        return $msg;
                    }
                    break;
                case 'min':
                    if (is_numeric($value) && (float) $value < (float) $rval) {
                        return $msg;
                    }
                    break;
                case 'max':
                    if (is_numeric($value) && (float) $value > (float) $rval) {
                        return $msg;
                    }
                    break;
                case 'pattern':
                    if (is_string($value) && $value !== '' && is_string($rval) && $rval !== '') {
                        // ReDoS guard (mirrors the client): cap length + reject nested quantifiers.
                        if (strlen($rval) > 500
                            || preg_match('/(\+|\*|\{[^}]*\})\s*(\+|\*|\{[^}]*\})/', $rval)
                            || preg_match('/\([^)]*\|[^)]*\)\+/', $rval)) {
                            return $msg;
                        }
                        $ok = @preg_match('/' . str_replace('/', '\\/', $rval) . '/', $value);
                        if ($ok !== 1) {
                            return $msg; // fail closed on no-match or an uncompilable pattern
                        }
                    }
                    break;
            }
        }
        return null;
    }

    /**
     * Re-validate each submitted file_upload answer against the constraints of the SPECIFIC
     * field it's attached to, by re-reading the stored file (server-detected MIME + real size).
     * This pins a file to its field at submission time, so a file accepted by a lax upload
     * field can't be reused under a stricter field, and forged/cross-form file ids are rejected.
     * Returns a map of fieldId => error message (empty when all files pass).
     *
     * FILE-PRIV-001 — attachment ownership. $answers is BY REF because every file item's
     * transient `claimToken` (echoed back from the upload response) is verified here and then
     * STRIPPED so it never persists. A referenced file must be attachable by THIS caller:
     *  - still PENDING: the authenticated submitter must be its uploader, or the caller must
     *    present the upload claim token, or be the form owner (who can read every file of the
     *    form anyway). Pre-claim markers ("legacy") stay attachable until the TTL sweeps them.
     *  - already COMMITTED (attached to some response): only re-attachable when kept on the
     *    SAME response being updated ($context['existingResponseId']), by the form owner, or
     *    by the authenticated submitter it already belongs to — so one submitter can never
     *    graft another submitter's file onto their own response.
     * Unauthorized ids get the same message as missing files (no existence oracle).
     *
     * @param array<string,mixed> $answers
     * @param array{submitterUserId?: ?string, isOwner?: bool, existingResponseId?: ?string}|null $context
     *   null = fully anonymous caller (claim tokens only).
     * @return array<string, string>
     */
    public function validateFileAnswers(array $fields, array &$answers, string $formId, ?array $context = null): array
    {
        $errors = [];
        if ($this->fileStorageService === null) {
            return $errors; // no storage access here; the upload-time check already ran
        }
        $submitterUserId = isset($context['submitterUserId']) && is_string($context['submitterUserId']) && $context['submitterUserId'] !== ''
            ? $context['submitterUserId'] : null;
        $isOwner = (bool) ($context['isOwner'] ?? false);
        $existingFileIds = null;
        if (is_string($context['existingResponseId'] ?? null) && $context['existingResponseId'] !== '') {
            $existing = $this->getResponse($formId, $context['existingResponseId']);
            $existingFileIds = is_array($existing['answers'] ?? null) ? $this->fileUploadIds($existing['answers']) : [];
        }
        foreach ($fields as $field) {
            $id = $field['id'] ?? null;
            if (($field['type'] ?? '') !== 'file_upload' || !$id) {
                continue;
            }
            $value = $answers[$id] ?? null;
            if (!is_array($value) || $value === []) {
                continue;
            }
            $props = $field['properties'] ?? [];
            $accepted = is_array($props['acceptedFileTypes'] ?? null) ? $props['acceptedFileTypes'] : [];
            $maxSize = (int) ($props['maxFileSize'] ?? 0);
            // maxFileSize is bytes from the builder but MB from templates/packs (same heuristic
            // as FileController::fileUploadConstraints).
            if ($maxSize > 0 && $maxSize < 1024) {
                $maxSize *= 1024 * 1024;
            }
            $label = (string) ($field['label'] ?? 'File');
            foreach ($value as $i => $item) {
                if (!is_array($item) || empty($item['id'])) {
                    continue; // metadata shape is validated separately
                }
                // Pull + strip the transient claim token before anything can persist it.
                $claimToken = is_string($item['claimToken'] ?? null) ? $item['claimToken'] : null;
                unset($answers[$id][$i]['claimToken']);
                $fileId = (string) $item['id'];
                $path = $this->fileStorageService->getFilePath($formId, $fileId);
                if ($path === null) {
                    $errors[$id] = "$label: uploaded file could not be found";
                    break;
                }
                if (!$this->mayAttachFile($formId, $fileId, $claimToken, $submitterUserId, $isOwner, $existingFileIds)) {
                    $errors[$id] = "$label: uploaded file could not be found";
                    break;
                }
                $size = @filesize($path);
                if ($maxSize > 0 && $size !== false && $size > $maxSize) {
                    $errors[$id] = "$label: file exceeds the size limit for this field";
                    break;
                }
                if (!empty($accepted)) {
                    $mime = $this->fileStorageService->getMimeType($path);
                    $name = (string) ($item['originalFilename'] ?? '');
                    if (!$this->fileStorageService->matchesAcceptedType($mime, $name, $accepted)) {
                        $errors[$id] = "$label: file type is not allowed for this field";
                        break;
                    }
                }
            }
        }
        return $errors;
    }

    /**
     * The FILE-PRIV-001 attachment decision for one file id (see validateFileAnswers).
     *
     * @param string[]|null $existingFileIds file ids already on the response being updated
     */
    private function mayAttachFile(
        string $formId,
        string $fileId,
        ?string $claimToken,
        ?string $submitterUserId,
        bool $isOwner,
        ?array $existingFileIds
    ): bool {
        if ($isOwner) {
            return true;
        }
        $info = $this->fileStorageService?->uploadClaimInfo($formId, $fileId);
        if ($info === null) {
            return false; // file vanished between checks
        }
        if ($info['pending']) {
            if ($info['legacy']) {
                return true; // pre-claim upload still in its TTL window (deploy grandfather)
            }
            if ($info['uploader'] !== null && $submitterUserId !== null && $info['uploader'] === $submitterUserId) {
                return true;
            }
            return $info['claimHash'] !== null
                && $claimToken !== null
                && hash_equals($info['claimHash'], hash('sha256', $claimToken));
        }
        // Committed file: keeping it on the same response, or re-attaching one's own.
        if ($existingFileIds !== null && in_array($fileId, $existingFileIds, true)) {
            return true;
        }
        return $submitterUserId !== null && $this->userOwnsFile($formId, $fileId, $submitterUserId);
    }

    /**
     * Get all responses for a form
     */
    /**
     * Indexed answer-equality lookups (audit AOK-FLOW-001): flow list nodes
     * and the app-logic upsert matcher push their eq filters here so a match
     * BEYOND the row limit is found by the database, never silently missed by
     * a client-side scan of the newest N rows. CAST-to-TEXT mirrors the flow
     * node's loose equality (a numeric answer still matches its string form).
     */
    private function applyAnswersEq(array $options, array &$conditions, array &$params): void
    {
        if (empty($options['answersEq']) || !is_array($options['answersEq'])) {
            return;
        }
        $i = 0;
        foreach ($options['answersEq'] as $field => $value) {
            if (!preg_match('/^[A-Za-z0-9_]{1,64}$/', (string) $field)) {
                continue; // field ids are machine keys; ignore anything else
            }
            $i++;
            $conditions[] = "CAST(json_extract(answers, '$.\"" . $field . "\"') AS TEXT) = :ans_eq_{$i}";
            $params["ans_eq_{$i}"] = (string) $value;
        }
    }

    /**
     * Server-side grid sorting: build the ORDER BY for a responses list from
     * `$options['sort']` (a built-in column — 'submittedAt'/'submitted_at',
     * 'status' — or an answer-field machine key) and `$options['sortDir']`
     * ('asc'|'desc', default desc). Sorting happens in the DATABASE so it
     * composes with LIMIT/OFFSET pagination — a grid never has to load every
     * row and sort client-side.
     *
     * SQL-injection posture: ORDER BY cannot take bound parameters, so both
     * interpolated pieces are strictly constrained — the direction collapses
     * to the literal ASC/DESC, and a field key must pass the SAME
     * `[A-Za-z0-9_]{1,64}` allowlist as the answersEq pushdown (anything else
     * falls back to the default order). Answer sorting uses the raw
     * `json_extract` value, so numeric answers sort numerically and text
     * answers sort case-insensitively; `submitted_at` breaks ties for a
     * stable pagination order across pages.
     */
    public static function buildResponsesOrderBy(array $options): string
    {
        $dir = strtolower((string) ($options['sortDir'] ?? 'desc')) === 'asc' ? 'ASC' : 'DESC';
        $sort = (string) ($options['sort'] ?? '');
        if ($sort === 'submittedAt' || $sort === 'submitted_at') {
            return " ORDER BY submitted_at {$dir}, id {$dir}";
        }
        if ($sort === 'status') {
            return " ORDER BY status COLLATE NOCASE {$dir}, submitted_at DESC";
        }
        if ($sort !== '' && preg_match('/^[A-Za-z0-9_]{1,64}$/', $sort)) {
            return " ORDER BY json_extract(answers, '$.\"" . $sort . "\"') COLLATE NOCASE {$dir}, submitted_at DESC";
        }
        return " ORDER BY submitted_at DESC";
    }

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

        // Indexed answer-equality lookups (audit AOK-FLOW-001).
        $this->applyAnswersEq($options, $conditions, $params);
        // Phone-normalized lookups (flow filter op `phone_eq`): a coarse
        // ordered-digit LIKE narrows in SQL, the exact digits check runs below.
        $this->applyAnswersPhoneEq($options, $conditions, $params);

        if (!empty($conditions)) {
            $sql .= " WHERE " . implode(' AND ', $conditions);
        }

        $sql .= self::buildResponsesOrderBy($options);

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
        // Exact phone check over the coarse SQL candidates (see applyAnswersPhoneEq).
        if (!empty($options['answersPhoneEq']) && is_array($options['answersPhoneEq'])) {
            $rows = array_values(array_filter($rows, function (array $row) use ($options): bool {
                $answers = json_decode((string) ($row['answers'] ?? ''), true);
                if (!is_array($answers)) {
                    return false;
                }
                foreach ($options['answersPhoneEq'] as $field => $wanted) {
                    if (!self::phoneDigitsMatch((string) ($answers[$field] ?? ''), (string) $wanted)) {
                        return false;
                    }
                }
                return true;
            }));
        }
        return $this->formatResponses($db, $rows);
    }

    /**
     * Phone-normalized equality (flow filter op `phone_eq`): both sides reduced
     * to digits, compared on their last-9-digit suffix — the SAME rule the
     * Aokie caller-lookup logic has always used, so '+61 491 570 156' matches
     * '0491570156'. Short numbers (fewer than 6 digits either side) never
     * match: a 3-digit fragment matching everything would be worse than no
     * filter at all.
     */
    public static function phoneDigitsMatch(string $stored, string $wanted): bool
    {
        $a = preg_replace('/\D+/', '', $stored) ?? '';
        $b = preg_replace('/\D+/', '', $wanted) ?? '';
        if (strlen($a) < 6 || strlen($b) < 6) {
            return false;
        }
        return substr($a, -9) === substr($b, -9);
    }

    /**
     * Coarse SQL narrowing for `answersPhoneEq`: the stored value may be
     * formatted arbitrarily ('0491 570 156', '(04) 9157-0156'), so equality
     * can't push down directly. Instead the last four digits of the wanted
     * number, in order with anything between ('%2%4%3%…'), prefilter the rows
     * cheaply; the exact digits comparison runs in PHP over the survivors.
     * False positives just cost a decode — false NEGATIVES are impossible
     * (the true match always contains its own last four digits in order).
     */
    private function applyAnswersPhoneEq(array $options, array &$conditions, array &$params): void
    {
        if (empty($options['answersPhoneEq']) || !is_array($options['answersPhoneEq'])) {
            return;
        }
        $i = 0;
        foreach ($options['answersPhoneEq'] as $field => $value) {
            if (!preg_match('/^[A-Za-z0-9_]{1,64}$/', (string) $field)) {
                continue;
            }
            $digits = preg_replace('/\D+/', '', (string) $value) ?? '';
            if (strlen($digits) < 6) {
                continue; // too short to filter meaningfully; exact check rejects anyway
            }
            $i++;
            $last4 = substr($digits, -4);
            $pattern = '%' . implode('%', str_split($last4)) . '%';
            $conditions[] = "CAST(json_extract(answers, '$.\"" . $field . "\"') AS TEXT) LIKE :ans_ph_{$i}";
            $params["ans_ph_{$i}"] = $pattern;
        }
    }

    /**
     * True if $fileId is attached to a response submitted by $userId on $formId — an UNBOUNDED lookup
     * (no pagination) so a view-own member can reach their own upload no matter how many responses they
     * have (getFormResponses caps at 100).
     *
     * The LIKE is only a cheap PREFILTER: the caller-supplied id could appear as a plain text answer, so
     * a raw substring match would let a view-own member grant themselves access to another user's file by
     * typing its id into a text field. We therefore decode each candidate and require the id to appear as
     * a real file-upload metadata object ({ id, storedFilename }) — exact ownership, not substring.
     */
    public function userOwnsFile(string $formId, string $fileId, string $userId): bool
    {
        if ($fileId === '' || !$this->sqlite->formDatabaseExists($formId)) {
            return false;
        }
        $db = $this->sqlite->getFormDatabase($formId);
        $needle = '%' . strtr($fileId, ['\\' => '\\\\', '%' => '\\%', '_' => '\\_']) . '%';
        $stmt = $db->prepare(
            "SELECT answers FROM responses
             WHERE json_extract(metadata, '$.submittedByUserId') = :uid
               AND answers LIKE :needle ESCAPE '\\'"
        );
        $stmt->bindValue('uid', $userId);
        $stmt->bindValue('needle', $needle);
        $stmt->execute();
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $answersJson) {
            $answers = json_decode((string) $answersJson, true);
            if (is_array($answers) && in_array($fileId, $this->fileUploadIds($answers), true)) {
                return true;
            }
        }
        return false;
    }

    /**
     * True if ANY response of $formId still references $fileId as a real file-upload attachment —
     * the authoritative check behind the deferred file GC (FILE-PRIV-001): a physical file may
     * only be deleted once this says no. Same LIKE-prefilter + exact-object-match discipline as
     * userOwnsFile (a bare id in a text answer is not a reference).
     */
    public function fileIsReferenced(string $formId, string $fileId): bool
    {
        if ($fileId === '' || !$this->sqlite->formDatabaseExists($formId)) {
            return false;
        }
        $db = $this->sqlite->getFormDatabase($formId);
        $needle = '%' . strtr($fileId, ['\\' => '\\\\', '%' => '\\%', '_' => '\\_']) . '%';
        $stmt = $db->prepare("SELECT answers FROM responses WHERE answers LIKE :needle ESCAPE '\\'");
        $stmt->bindValue('needle', $needle);
        $stmt->execute();
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $answersJson) {
            $answers = json_decode((string) $answersJson, true);
            if (is_array($answers) && in_array($fileId, $this->fileUploadIds($answers), true)) {
                return true;
            }
        }
        return false;
    }

    /**
     * The answer-field ids under which $fileId is attached across the form's responses —
     * powers the EXPLICIT public-asset policy (FILE-PRIV-001): a file is only publicly
     * servable when one of these ids is on the form's customScreen.publicRecordFields
     * whitelist. Empty when the file is attached nowhere.
     *
     * @return string[]
     */
    public function fileAttachedFieldIds(string $formId, string $fileId): array
    {
        if ($fileId === '' || !$this->sqlite->formDatabaseExists($formId)) {
            return [];
        }
        $db = $this->sqlite->getFormDatabase($formId);
        $needle = '%' . strtr($fileId, ['\\' => '\\\\', '%' => '\\%', '_' => '\\_']) . '%';
        $stmt = $db->prepare("SELECT answers FROM responses WHERE answers LIKE :needle ESCAPE '\\'");
        $stmt->bindValue('needle', $needle);
        $stmt->execute();
        $fieldIds = [];
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $answersJson) {
            $answers = json_decode((string) $answersJson, true);
            if (!is_array($answers)) {
                continue;
            }
            foreach ($answers as $fieldId => $value) {
                if (!is_array($value)) {
                    continue;
                }
                foreach ($value as $item) {
                    if (is_array($item) && ($item['id'] ?? null) === $fileId && isset($item['storedFilename'])) {
                        $fieldIds[(string) $fieldId] = true;
                    }
                }
            }
        }
        return array_keys($fieldIds);
    }

    /**
     * Run the file garbage collectors for one form (FILE-PRIV-001): reclaim abandoned
     * pending uploads and orphan-marked files, both guarded by fileIsReferenced() so
     * neither sweep can ever delete a file a persisted response still points at.
     * Best-effort and internally hour-throttled (pass $ignoreThrottle from the nightly
     * job). Returns how many physical files were reclaimed.
     */
    public function sweepFileGarbage(string $formId, bool $ignoreThrottle = false): int
    {
        if ($this->fileStorageService === null) {
            return 0;
        }
        $reclaimed = 0;
        try {
            $isReferenced = fn (string $fileId): bool => $this->fileIsReferenced($formId, $fileId);
            $reclaimed += $this->fileStorageService->sweepAbandonedUploads(
                $formId,
                FileStorageService::PENDING_TTL_SECONDS,
                $isReferenced,
                $ignoreThrottle
            );
            $reclaimed += $this->fileStorageService->sweepOrphanedFiles(
                $formId,
                $isReferenced,
                FileStorageService::ORPHAN_GRACE_SECONDS,
                $ignoreThrottle
            );
        } catch (\Throwable $e) {
            $this->logger->error('File garbage sweep failed', ['formId' => $formId, 'error' => $e->getMessage()]);
        }
        return $reclaimed;
    }

    /**
     * Decorate a webhook payload's file-upload answer urls with short-lived receipt tokens
     * (FILE-PRIV-001): response uploads are private now, so an integration that downloads
     * attachments from a webhook needs a bearer credential — the `?rt=` token grants that
     * one file for RECEIPT_TTL_SECONDS. Standalone forms only: app-scoped files were always
     * access-controlled and their webhook consumers never could fetch anonymously, so no
     * new anonymous window is opened there. Best-effort — any failure returns the payload
     * with clean (auth-required) urls.
     */
    private function withFileReceiptUrls(string $formId, array $payload): array
    {
        if ($this->fileStorageService === null || !is_array($payload['answers'] ?? null)) {
            return $payload;
        }
        try {
            $stmt = $this->mysql->prepare('SELECT 1 FROM app_forms WHERE form_id = :id LIMIT 1');
            $stmt->execute(['id' => $formId]);
            if ($stmt->fetchColumn() !== false) {
                return $payload; // app-scoped: keep auth-required urls
            }
            foreach ($payload['answers'] as $fieldId => $value) {
                if (!is_array($value)) {
                    continue;
                }
                foreach ($value as $i => $item) {
                    if (!is_array($item) || !isset($item['id'], $item['storedFilename']) || !is_string($item['url'] ?? null)) {
                        continue;
                    }
                    $token = $this->fileStorageService->mintReceiptToken($formId, (string) $item['id']);
                    if ($token !== null && !str_contains($item['url'], '?')) {
                        $payload['answers'][$fieldId][$i]['url'] = $item['url'] . '?rt=' . $token;
                    }
                }
            }
        } catch (\Throwable $e) {
            $this->logger->warning('Failed to mint webhook file receipt urls', [
                'formId' => $formId, 'error' => $e->getMessage(),
            ]);
        }
        return $payload;
    }

    /**
     * The stored ids of files actually attached via file_upload fields in $answers — a file_upload answer
     * is an array of { id, storedFilename, … } objects. Mirrors FileStorageService::extractFileIds so a
     * bare id sitting in an unrelated text answer is NOT treated as an attached file.
     *
     * @param array<string,mixed> $answers
     * @return string[]
     */
    private function fileUploadIds(array $answers): array
    {
        $ids = [];
        foreach ($answers as $value) {
            if (!is_array($value)) {
                continue;
            }
            foreach ($value as $item) {
                if (is_array($item) && isset($item['id'], $item['storedFilename']) && is_string($item['id'])) {
                    $ids[] = $item['id'];
                }
            }
        }
        return $ids;
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
    /**
     * IDs of a form's responses whose answers contain $term (whole-answers substring match). Used to
     * resolve a search term against a LINKED form so the parent grid can match by the linked record's
     * display/content, not just its stored id. Optionally restricted to a specific submitter (own-scope).
     *
     * @return string[]
     */
    public function findMatchingResponseIds(string $formId, string $term, ?string $ownerUserId = null, int $limit = 2000): array
    {
        $term = trim($term);
        if ($term === '' || !$this->sqlite->formDatabaseExists($formId)) {
            return [];
        }
        $db = $this->sqlite->getFormDatabase($formId);
        $conditions = ["answers LIKE :q ESCAPE '\'"];
        $params = ['q' => '%' . strtr($term, ['%' => '\%', '_' => '\_']) . '%'];
        if ($ownerUserId !== null) {
            $conditions[] = "json_extract(metadata, '$.submittedByUserId') = :owner";
            $params['owner'] = $ownerUserId;
        }
        $stmt = $db->prepare("SELECT id FROM responses WHERE " . implode(' AND ', $conditions) . " LIMIT :lim");
        foreach ($params as $k => $v) { $stmt->bindValue($k, $v); }
        $stmt->bindValue('lim', max(1, $limit), PDO::PARAM_INT);
        $stmt->execute();
        return array_map('strval', $stmt->fetchAll(PDO::FETCH_COLUMN) ?: []);
    }

    /**
     * @param array $extraMatches Extra OR-conditions so search matches resolved values (linked-record
     *   display / choice labels): each ['field'=>id, 'values'=>string[], 'multi'=>bool]. A row matches if
     *   its answer for that field equals one of the values (or, for multi, contains one via json_each).
     */
    public function getFormResponsesSearchable(
        string $formId,
        string $searchQuery,
        array $searchFieldIds,
        array $options = [],
        array $extraMatches = []
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

        // Indexed answer-equality lookups (audit AOK-FLOW-001) — same
        // semantics as getFormResponses, so the app-scoped browser runner
        // gets identical pushdown behaviour.
        $this->applyAnswersEq($options, $conditions, $params);
        // Phone-normalized lookups (flow filter op `phone_eq`) — coarse SQL
        // narrowing; the exact digits check runs over the fetched page below.
        $this->applyAnswersPhoneEq($options, $conditions, $params);

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

            // Extra matches (linked-record display / choice labels resolved to stored values by the caller).
            foreach ($extraMatches as $mi => $m) {
                $mfid = preg_replace('/[^a-zA-Z0-9_]/', '', (string)($m['field'] ?? ''));
                $vals = array_values(array_filter((array)($m['values'] ?? []), static fn ($v) => is_string($v) || is_int($v)));
                if ($mfid === '' || empty($vals)) {
                    continue;
                }
                $placeholders = [];
                foreach ($vals as $vi => $v) {
                    $p = "em_{$mi}_{$vi}";
                    $placeholders[] = ":$p";
                    $params[$p] = (string) $v;
                }
                $inList = implode(', ', $placeholders);
                $searchConditions[] = !empty($m['multi'])
                    ? "EXISTS (SELECT 1 FROM json_each(answers, '\$.$mfid') WHERE value IN ($inList))"
                    : "json_extract(answers, '\$.$mfid') IN ($inList)";
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

        $sql = "SELECT * FROM responses" . $whereClause
            . self::buildResponsesOrderBy($options)
            . " LIMIT :limit OFFSET :offset";
        $stmt = $db->prepare($sql);
        foreach ($params as $key => $value) {
            $stmt->bindValue($key, $value);
        }
        $stmt->bindValue('limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue('offset', $offset, PDO::PARAM_INT);
        $stmt->execute();

        $rows = $stmt->fetchAll();
        // Exact phone check over the coarse SQL candidates (mirrors
        // getFormResponses; the total stays the coarse count — the flow
        // runners only consume `responses`, and a rare LIKE false positive
        // over-counting is harmless there).
        if (!empty($options['answersPhoneEq']) && is_array($options['answersPhoneEq'])) {
            $rows = array_values(array_filter($rows, function (array $row) use ($options): bool {
                $answers = json_decode((string) ($row['answers'] ?? ''), true);
                if (!is_array($answers)) {
                    return false;
                }
                foreach ($options['answersPhoneEq'] as $field => $wanted) {
                    if (!self::phoneDigitsMatch((string) ($answers[$field] ?? ''), (string) $wanted)) {
                        return false;
                    }
                }
                return true;
            }));
        }
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

            // Script opted out of storage ({store:false}): the submission is
            // ACCEPTED — the respondent sees the normal thank-you — but nothing
            // persists anywhere: no SQLite row, no MySQL mirror, no links,
            // webhooks or flow runs, and uploaded files stay uncommitted (the
            // abandoned-upload sweeper reclaims them). The script owns the data
            // (typically forwarded via ctx.http). Completion analytics still
            // count, so the owner sees the form being used.
            if ($scriptResult->success && !$scriptResult->store) {
                try {
                    $this->updateAnalytics($formId, 'completion');
                } catch (\Throwable $analyticsErr) {
                    $this->logger->error('Failed to update analytics after store:false submission', [
                        'formId' => $formId,
                        'error' => $analyticsErr->getMessage(),
                    ]);
                }
                return [
                    'id' => $id,
                    'status' => 'submitted',
                    'submittedAt' => $now,
                    'updatedAt' => $now,
                    'answers' => $data['answers'] ?? [],
                    'stored' => false,
                ];
            }
        }

        // 2. Determine initial status (may be overridden by script)
        $allowedStatuses = ['submitted', 'reviewed', 'approved', 'rejected', 'spam', 'archived'];
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
                    'language' => $data['language'] ?? null,
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
            // Compensating delete on SQLite if MySQL insert fails. Step 4/5 may
            // already have written child rows (computed/tags/script_logs) keyed
            // by this response id — remove them too, or the failed submission
            // leaves orphaned computed values, tags and a script log with no
            // parent response (SQLite FKs are not enforced by default).
            $qid = $db->quote($id);
            $db->exec("DELETE FROM computed WHERE response_id = $qid");
            $db->exec("DELETE FROM tags WHERE response_id = $qid");
            $db->exec("DELETE FROM script_logs WHERE response_id = $qid");
            $db->exec("DELETE FROM responses WHERE id = $qid");
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

        // Upload staging (audit FL-006): the response is durably saved, so its
        // files are now REFERENCED — commit them (remove pending markers) so
        // the abandoned-upload sweeper never reclaims them.
        if ($this->fileStorageService !== null) {
            try {
                $this->fileStorageService->commitResponseFiles($formId, $data['answers'] ?? []);
            } catch (\Throwable $commitErr) {
                $this->logger->error('Failed to commit uploaded files after response create', [
                    'formId' => $formId, 'responseId' => $id, 'error' => $commitErr->getMessage(),
                ]);
            }
        }

        // Records retention (audit PRIV-001): every write path funnels through
        // here, so this is where expired rows age out. Hour-throttled, capped,
        // and internally best-effort.
        $this->purgeExpiredIfDue($formId);

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
                $webhookPayload = $this->withFileReceiptUrls($formId, $webhookPayload);
                $this->webhookService->dispatch($formId, 'response.created', $webhookPayload);
            }
        } catch (\Throwable $postErr) {
            $this->logger->error('Post-persist read/webhook failed after response create', [
                'formId' => $formId,
                'responseId' => $id,
                'error' => $postErr->getMessage(),
            ]);
        }

        // 9. FormLogic Flows: enqueue 'queued' runs for enabled form.submitted bindings (app +
        // workspace) and for ctx.flows.run() intents the onSubmit script recorded. Best-effort —
        // the response is durably saved, so a flow-enqueue failure must never surface as a 500
        // (and the UNIQUE idempotency keys make any retry-driven replay a no-op).
        if ($this->flowService !== null) {
            try {
                $this->flowService->enqueueSubmissionBindings($formId, $id, $data['answers'] ?? []);
                if ($scriptResult !== null && $scriptResult->success && $scriptResult->flowRuns !== []) {
                    $this->flowService->enqueueScriptFlowRuns($formId, $id, $scriptResult->flowRuns);
                }
            } catch (\Throwable $flowErr) {
                $this->logger->error('Flow enqueue failed after response create', [
                    'formId' => $formId,
                    'responseId' => $id,
                    'error' => $flowErr->getMessage(),
                ]);
            }
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
     * How many responses hold a non-empty value for a field. Powers the builder's
     * delete-field warning ("N records have data in this field"). Counts 0/false
     * as data (they ARE values); empty string / empty array / missing key are not.
     */
    public function countResponsesWithFieldValue(string $formId, string $fieldId): int
    {
        if (!$this->sqlite->formDatabaseExists($formId)) {
            return 0;
        }
        $db = $this->sqlite->getFormDatabase($formId);
        $stmt = $db->prepare(
            "SELECT COUNT(*) FROM responses
             WHERE json_extract(answers, :path) IS NOT NULL
               AND json_extract(answers, :path2) NOT IN ('', '[]')"
        );
        $path = '$."' . str_replace('"', '', $fieldId) . '"';
        $stmt->execute(['path' => $path, 'path2' => $path]);
        return (int) $stmt->fetchColumn();
    }

    /**
     * Permanently remove one field's data from every response of a form (the
     * builder's "delete field AND its data" option — the structure save alone
     * only orphans the values inside the answers JSON). Also removes
     * script-computed values stored under the same name, deletes uploaded files
     * the values reference (file-upload/photo answers), and drops the field's
     * response_links rows. The field definition itself is the caller's concern
     * (already deleted via the normal structure save). Returns how many
     * responses were touched.
     */
    public function purgeFieldData(string $formId, string $fieldId): int
    {
        if (!$this->sqlite->formDatabaseExists($formId)) {
            return 0;
        }
        $db = $this->sqlite->getFormDatabase($formId);
        $path = '$."' . str_replace('"', '', $fieldId) . '"';

        // Collect uploaded-file ids the doomed values reference BEFORE removing
        // them (shape-sniffed via extractFileIds — the field definition is gone
        // by now, so the value shape is the only signal it was a file field).
        $fileIds = [];
        if ($this->fileStorageService !== null) {
            $sel = $db->prepare("SELECT answers FROM responses WHERE json_extract(answers, :path) IS NOT NULL");
            $sel->execute(['path' => $path]);
            while (($raw = $sel->fetchColumn()) !== false) {
                $answers = json_decode((string) $raw, true);
                $value = is_array($answers) ? ($answers[$fieldId] ?? null) : null;
                if ($value !== null) {
                    foreach ($this->fileStorageService->extractFileIds([$fieldId => $value]) as $fid) {
                        $fileIds[$fid] = true;
                    }
                }
            }
        }

        $db->beginTransaction();
        try {
            $upd = $db->prepare(
                "UPDATE responses SET answers = json_remove(answers, :path)
                 WHERE json_extract(answers, :path2) IS NOT NULL"
            );
            $upd->execute(['path' => $path, 'path2' => $path]);
            $purged = $upd->rowCount();
            $db->prepare('DELETE FROM computed WHERE field_name = :f')->execute(['f' => $fieldId]);
            $db->commit();
        } catch (\Throwable $e) {
            if ($db->inTransaction()) {
                $db->rollBack();
            }
            throw $e;
        }

        // Inverse-link index rows for this field (no-op unless it was a linked_record).
        try {
            $this->mysql->prepare('DELETE FROM response_links WHERE source_form_id = :form AND field_id = :field')
                ->execute(['form' => $formId, 'field' => $fieldId]);
        } catch (\Throwable $e) {
            $this->logger->error('Failed to remove response_links during field purge', [
                'formId' => $formId, 'fieldId' => $fieldId, 'error' => $e->getMessage(),
            ]);
        }

        // Physical files last — the purged values no longer reference them. Purge is an
        // explicit owner erasure action, so unreferenced files go immediately; a file that
        // is STILL attached elsewhere (another field/response sharing the id) is kept —
        // deleting it would break that surviving attachment (FILE-PRIV-001).
        if ($this->fileStorageService !== null) {
            foreach (array_keys($fileIds) as $fid) {
                try {
                    if (!$this->fileIsReferenced($formId, (string) $fid)) {
                        $this->fileStorageService->deleteFile($formId, (string) $fid);
                    }
                } catch (\Throwable $e) {
                    $this->logger->warning('Failed to delete file during field purge', [
                        'formId' => $formId, 'fileId' => $fid, 'error' => $e->getMessage(),
                    ]);
                }
            }
        }

        return $purged;
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

            // Persist computed data atomically: clear + re-apply + log in one SQLite
            // transaction so a mid-apply failure can't leave the response with
            // partially-cleared / partially-rewritten computed fields or tags.
            $db->beginTransaction();
            try {
                $this->clearComputedData($db, $responseId);
                $this->applyScriptResult($db, $responseId, $result);
                $this->logScriptExecution($db, $responseId, $result);
                $db->commit();
            } catch (\Throwable $e) {
                if ($db->inTransaction()) {
                    $db->rollBack();
                }
                throw $e;
            }

            // Update status if changed — does its own MySQL mirror + webhook, so keep
            // it outside the SQLite transaction.
            if ($result->status !== null) {
                $this->updateResponse($formId, $responseId, ['status' => $result->status]);
            }
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
                // JSON-encode ALL values (not (string)$value for scalars) so the type
                // round-trips through the json_decode read path — otherwise a bool becomes
                // 1/'' and a leading-zero/"true"-like string is reinterpreted on read.
                'field_value' => json_encode($value),
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

        // If the answers are being replaced and uploads are in play, snapshot the
        // existing answers BEFORE the UPDATE so we can delete any files this update
        // drops/replaces — nothing else garbage-collects them.
        $oldAnswersForFiles = null;
        if (isset($data['answers']) && $this->fileStorageService !== null) {
            $fetchAns = $db->prepare("SELECT answers FROM responses WHERE id = :id");
            $fetchAns->execute(['id' => $responseId]);
            $ansRow = $fetchAns->fetch(PDO::FETCH_ASSOC);
            if ($ansRow && !empty($ansRow['answers'])) {
                $decodedOld = json_decode($ansRow['answers'], true);
                if (is_array($decodedOld)) {
                    $oldAnswersForFiles = $decodedOld;
                }
            }
        }

        $updates = [];
        $params = ['id' => $responseId];

        if (isset($data['answers'])) {
            $updates[] = "answers = :answers";
            $params['answers'] = json_encode($data['answers']);
        }

        if (isset($data['status'])) {
            $allowedStatuses = ['submitted', 'reviewed', 'approved', 'rejected', 'spam', 'archived'];
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

        // Handle files removed/replaced by this update (best-effort; the authoritative
        // row is already updated). FILE-PRIV-001: dropped files are NOT deleted inline —
        // they are orphan-MARKED and reclaimed later by the reference-checked GC, so a
        // concurrent update that raced this one (or a second response sharing the id)
        // can never lose its attachment to this mutation.
        if ($oldAnswersForFiles !== null && $this->fileStorageService !== null) {
            try {
                $newAnswers = is_array($data['answers'] ?? null) ? $data['answers'] : [];
                // Files newly referenced by this update are committed (FL-006)…
                $this->fileStorageService->commitResponseFiles($formId, $newAnswers);
                // …and files the update dropped are handed to the deferred GC.
                $orphaned = array_diff(
                    $this->fileStorageService->extractFileIds($oldAnswersForFiles),
                    $this->fileStorageService->extractFileIds($newAnswers)
                );
                foreach ($orphaned as $orphanId) {
                    $this->fileStorageService->markOrphaned($formId, $orphanId);
                }
                $this->sweepFileGarbage($formId);
            } catch (\Throwable $fileErr) {
                $this->logger->error('Failed to clean up orphaned files after response update', [
                    'formId' => $formId, 'responseId' => $responseId, 'error' => $fileErr->getMessage(),
                ]);
            }
        }

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
                $webhookPayload = $this->withFileReceiptUrls($formId, $webhookPayload);
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
    /**
     * Opportunistic records-retention purge (audit PRIV-001): when the form's
     * settings carry a positive `retentionDays`, responses older than the TTL
     * are removed THROUGH deleteResponse — so MySQL metadata/link rows and
     * uploaded files go with the authoritative SQLite row. Throttled to once
     * per hour per form (a `form_data` marker), capped per sweep, and never
     * fails the caller: a purge problem must not reject a live submission.
     */
    public function purgeExpiredIfDue(string $formId): int
    {
        try {
            $db = $this->sqlite->getFormDatabase($formId);
            $hour = (string) intdiv(time(), 3600);
            $stmt = $db->prepare("SELECT value FROM form_data WHERE key = 'retention_purged_hour'");
            $stmt->execute();
            if ((string) $stmt->fetchColumn() === $hour) {
                return 0;
            }

            // Read the retention setting BEFORE claiming this hour's slot: if the
            // settings read fails transiently, the throttle marker is NOT burned, so
            // the next submission retries this hour rather than letting expired PII
            // linger an extra hour. (deleteResponse tolerates a concurrent
            // double-purge, so reading before claiming introduces no race.)
            $settingsStmt = $this->mysql->prepare("SELECT settings FROM forms WHERE id = :id");
            $settingsStmt->execute(['id' => $formId]);
            $settings = json_decode((string) ($settingsStmt->fetchColumn() ?: '{}'), true);
            $days = (int) (is_array($settings) ? ($settings['retentionDays'] ?? 0) : 0);

            // Claim this hour's slot now — concurrent submitters skip the work below.
            $claim = $db->prepare(
                "INSERT OR REPLACE INTO form_data (key, value, updated_at) VALUES ('retention_purged_hour', :h, datetime('now'))"
            );
            $claim->execute(['h' => $hour]);

            if ($days <= 0) {
                return 0;
            }

            $cutoff = date('Y-m-d H:i:s', time() - $days * 86400);
            $sel = $db->prepare("SELECT id FROM responses WHERE submitted_at < :cutoff LIMIT 500");
            $sel->execute(['cutoff' => $cutoff]);
            $ids = $sel->fetchAll(PDO::FETCH_COLUMN) ?: [];
            $deleted = 0;
            foreach ($ids as $rid) {
                if ($this->deleteResponse($formId, (string) $rid)) {
                    $deleted++;
                }
            }
            if ($deleted > 0) {
                $this->logger->info('Retention purge removed expired responses', [
                    'formId' => $formId,
                    'deleted' => $deleted,
                    'retentionDays' => $days,
                ]);
            }
            return $deleted;
        } catch (\Throwable $e) {
            $this->logger->error('Retention purge failed', [
                'formId' => $formId,
                'error' => $e->getMessage(),
            ]);
            return 0;
        }
    }

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

            // Hand the response's uploaded files to the deferred GC — last, after the
            // record is gone. FILE-PRIV-001: no inline physical delete; the sweep
            // re-proves each file unreferenced first, so a second response that shares
            // a file id (restore/duplicate/legacy data) keeps its attachment.
            if ($this->fileStorageService !== null && is_array($answers)) {
                try {
                    foreach ($this->fileStorageService->extractFileIds($answers) as $fileId) {
                        $this->fileStorageService->markOrphaned($formId, $fileId);
                    }
                    $this->sweepFileGarbage($formId);
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
            // Preserve updated_at: submitting/deleting a response is not a form edit,
            // and forms.updated_at is ON UPDATE CURRENT_TIMESTAMP (would otherwise
            // bump the form's "Last Modified" on every submission).
            $stmt = $this->mysql->prepare("UPDATE forms SET response_count = :cnt, updated_at = updated_at WHERE id = :id");
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
            'lastResponseAt' => null,
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
                    'lastResponseAt' => null,
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

            // Responses by date (last 30 days), bucketed by the CALLER'S local calendar day.
            //
            // tzOffsetMinutes = minutes AHEAD of UTC for the caller's local timezone
            // (e.g. Australia AEST/UTC+10 = +600, US Eastern EST/UTC-5 = -300). NOTE the sign:
            // this is the OPPOSITE convention from JavaScript's Date.prototype.getTimezoneOffset(),
            // which returns minutes BEHIND UTC — callers must negate that value before sending it.
            //
            // Validated/clamped here (never trust raw input): must be numeric and within
            // -840..840 (±14h, covers every real-world UTC offset). Missing, non-numeric, or
            // out-of-range values default to 0 (UTC) — i.e. byte-identical to the pre-fix behavior
            // for every existing caller that doesn't send this parameter.
            $tzOffsetMinutesRaw = $options['tzOffsetMinutes'] ?? null;
            $tzOffsetMinutes = is_numeric($tzOffsetMinutesRaw) ? (int)$tzOffsetMinutesRaw : 0;
            if ($tzOffsetMinutes < -840 || $tzOffsetMinutes > 840) {
                $tzOffsetMinutes = 0;
            }
            // Built server-side from the validated integer ONLY — never accept a raw SQLite
            // modifier string from the caller. sprintf('%+d', ...) always emits an explicit sign,
            // so 0 becomes '+0 minutes', a harmless no-op. Still passed as a BOUND parameter
            // (not concatenated into the SQL) for consistency with every other bound value here.
            $tzModifier = sprintf('%+d minutes', $tzOffsetMinutes);

            // The exact most-recent submission time (UTC, full precision). responsesByDate
            // is DAY-granular, so consumers ranking forms by "last activity" (the dashboard)
            // were comparing midnight-of-day against full-precision edit timestamps and
            // losing to any same-day edit.
            $lastResponseAt = null;
            try {
                $lastResponseAt = $db->query('SELECT MAX(submitted_at) FROM responses')->fetchColumn() ?: null;
            } catch (\Exception $e) {
                $this->logger->warning('Analytics lastResponseAt error', ['formId' => $formId, 'exception' => $e->getMessage()]);
            }

            $responsesByDate = [];
            try {
                // The WHERE window must compare LOCAL calendar dates on both sides, not a raw
                // UTC column against a tz-shifted-then-truncated threshold — otherwise the two
                // are in inconsistent frames and the boundary is off by exactly the tz offset
                // (confirmed: e.g. UTC+10 silently drops the first 10 local hours of the window;
                // UTC-5 silently includes 5 extra stale hours). So `submitted_at` is shifted by
                // the same modifier in the WHERE clause too, matching the GROUP BY bucket exactly.
                $stmt = $db->prepare("
                    SELECT date(submitted_at, :tzOffset) as date, COUNT(*) as count
                    FROM responses
                    WHERE date(submitted_at, :tzOffset) >= date('now', :tzOffset, '-30 days')
                    GROUP BY date(submitted_at, :tzOffset)
                    ORDER BY date ASC
                ");
                $stmt->bindValue(':tzOffset', $tzModifier, PDO::PARAM_STR);
                $stmt->execute();

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
                'lastResponseAt' => $lastResponseAt,
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

        // Pre-build value->label maps for choice fields so exports show readable labels
        // (e.g. "Sales Question") instead of stored option values (e.g. "option_3").
        $choiceLabelMaps = [];
        foreach ($fields as $field) {
            if (in_array($field['type'] ?? '', ['dropdown', 'multiple_choice', 'checkboxes'], true)) {
                $map = [];
                foreach ($field['properties']['options'] ?? [] as $opt) {
                    if (isset($opt['value'])) {
                        $map[(string) $opt['value']] = (string) ($opt['label'] ?? $opt['value']);
                    }
                }
                if ($map) {
                    $choiceLabelMaps[$field['id']] = $map;
                }
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
            // Display-only layout fields carry no data — don't emit empty columns for them.
            if (in_array($field['type'] ?? '', ['statement', 'welcome_screen', 'thank_you'], true)) {
                continue;
            }
            $label = $field['label'] ?? $field['id'];
            // Same neutralization as the data rows below (leading whitespace/TAB/CR
            // before a formula trigger) so the header can't smuggle a formula either.
            if (is_string($label) && preg_match('/^\s*[=+\-@\t\r]/', $label)) {
                $label = "'" . $label;
            }
            $headers[] = $label;
        }
        // Pass the $escape arg explicitly: PHP 8.4 deprecates the implicit default, and ''
        // (no backslash escaping) is the RFC-4180-correct behavior spreadsheets expect.
        fputcsv($outputStream, $headers, ',', '"', '');

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
                    // Skip display-only layout fields so row columns stay aligned with the header.
                    if (in_array($field['type'] ?? '', ['statement', 'welcome_screen', 'thank_you'], true)) {
                        continue;
                    }
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
                    } elseif (isset($choiceLabelMaps[$field['id']])) {
                        $map = $choiceLabelMaps[$field['id']];
                        $value = is_array($value)
                            ? implode(', ', array_map(fn($v) => $map[(string) $v] ?? (string) $v, $value))
                            : ($map[(string) $value] ?? (string) $value);
                    } elseif ($field['type'] === 'signature' && is_string($value)) {
                        if (str_starts_with($value, 'data:')) {
                            $value = '[signature]';
                        } elseif (str_starts_with($value, 'typed:')) {
                            $value = substr($value, 6);
                        }
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
                fputcsv($outputStream, $row, ',', '"', '');
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
     * Record a form "start" (first interaction) for analytics. Best-effort — never
     * throws. Powers the view → start → completion funnel in form analytics.
     */
    public function recordStart(string $formId): void
    {
        try {
            $this->updateAnalytics($formId, 'start');
        } catch (\Throwable $e) {
            $this->logger->warning('Failed to record form start', ['formId' => $formId, 'error' => $e->getMessage()]);
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

        // Build field type + label maps from fields array (label used in errors so
        // they name the field the user recognizes, not the internal id).
        $fieldTypeMap = [];
        $fieldLabelMap = [];
        foreach ($fields as $field) {
            if (isset($field['id']) && isset($field['type'])) {
                $fieldTypeMap[$field['id']] = $field['type'];
                $fieldLabelMap[$field['id']] = $field['label'] ?? $field['id'];
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
                                $rowErrors[] = "Field '" . ($fieldLabelMap[$fieldId] ?? $fieldId) . "': non-numeric value '{$value}'";
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
                                $rowErrors[] = "Field '" . ($fieldLabelMap[$fieldId] ?? $fieldId) . "': non-numeric value '{$value}'";
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

                // Skip rows where every mapped field is blank. $answers always has
                // the mapped keys (with possibly-empty values), so empty($answers)
                // never catches a blank row — check the VALUES instead.
                $hasValue = false;
                foreach ($answers as $v) {
                    if ($v !== '' && $v !== null && $v !== []) { $hasValue = true; break; }
                }
                if (!$hasValue) {
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
            // Keep the denormalized forms.response_count current after a bulk import
            // (the per-row insert path above bypasses createResponse's own sync).
            if ($created > 0) {
                $this->syncResponseCount($formId);
            }
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
     * Account-backup restore: insert fully-formed response rows into a form's
     * stores with ids/timestamps/status/metadata/computed/tags PRESERVED, and
     * with NO side effects — no onSubmit script, webhooks, flow enqueue,
     * analytics, retention purge, or file commit (createResponse must never be
     * used for restores; it fires all of those and regenerates ids).
     *
     * The caller (AccountBackupService) has already remapped linked_record
     * answers and rewritten file urls for the NEW form id, and compensates by
     * deleting the whole form on failure — so this throws loudly rather than
     * skipping rows. The MySQL response_metadata mirror stays strict (per-row
     * compensating delete; bulk cleanup on rollback) so the Doctor's dual-store
     * countDrift check holds after a restore.
     *
     * @param array<int, array{
     *   id: string, answers: array, metadata: array, status: string,
     *   submittedAt: string, updatedAt: string,
     *   computed?: array<int, array{name: string, rawValue: string, createdAt?: ?string}>,
     *   tags?: array<int, array{tag: string, createdAt?: ?string}>
     * }> $rows chunked by the caller (<= 1000 per call)
     * @return int rows created
     */
    public function restoreResponses(string $formId, array $rows): int
    {
        if (count($rows) > 1000) {
            throw new \RuntimeException('Maximum 1000 rows allowed per restore chunk');
        }
        if (!$this->formExists($formId)) {
            throw new \RuntimeException('Form not found');
        }

        // The SQLite side accepts 'spam' but the MySQL response_metadata ENUM
        // does not — mirror it as 'archived' (both are closed, report-excluded
        // states) instead of failing the strict-mode insert.
        $allowedStatuses = ['draft', 'submitted', 'reviewed', 'approved', 'rejected', 'spam', 'archived'];
        $mysqlEnum = ['draft', 'submitted', 'reviewed', 'approved', 'rejected', 'archived'];
        foreach ($rows as $i => $row) {
            $status = (string) ($row['status'] ?? '');
            if (!in_array($status, $allowedStatuses, true)) {
                // A tampered/incompatible backup fails LOUDLY, never coerces silently.
                throw new \RuntimeException("Restore row {$i} has invalid status '{$status}'");
            }
            if (!is_string($row['id'] ?? null) || $row['id'] === '') {
                throw new \RuntimeException("Restore row {$i} is missing an id");
            }
        }

        $db = $this->sqlite->getFormDatabase($formId);
        $this->sqlite->migrateFormDatabase($db);

        $created = 0;
        $mysqlInsertedIds = [];

        $db->beginTransaction();
        try {
            $respStmt = $db->prepare("
                INSERT INTO responses (id, answers, metadata, status, submitted_at, updated_at)
                VALUES (:id, :answers, :metadata, :status, :submitted_at, :updated_at)
            ");
            $computedStmt = $db->prepare("
                INSERT OR REPLACE INTO computed (response_id, field_name, field_value, created_at)
                VALUES (:rid, :name, :value, COALESCE(:created_at, datetime('now')))
            ");
            $tagStmt = $db->prepare("
                INSERT OR IGNORE INTO tags (response_id, tag, created_at)
                VALUES (:rid, :tag, COALESCE(:created_at, datetime('now')))
            ");
            $mysqlStmt = $this->mysql->prepare("
                INSERT INTO response_metadata (id, form_id, status, submitted_at, ip_address, user_agent, completion_time)
                VALUES (:id, :form_id, :status, :submitted_at, :ip_address, :user_agent, :completion_time)
            ");

            foreach ($rows as $row) {
                $metadata = is_array($row['metadata'] ?? null) ? $row['metadata'] : [];
                $respStmt->execute([
                    'id' => $row['id'],
                    'answers' => json_encode(is_array($row['answers'] ?? null) ? $row['answers'] : []),
                    'metadata' => json_encode($metadata),
                    'status' => $row['status'],
                    'submitted_at' => $row['submittedAt'],
                    'updated_at' => $row['updatedAt'],
                ]);

                foreach ($row['computed'] ?? [] as $c) {
                    // field_value is the RAW TEXT from the source db (already
                    // json-encoded) — re-encoding would double-encode it.
                    $computedStmt->execute([
                        'rid' => $row['id'],
                        'name' => (string) $c['name'],
                        'value' => (string) $c['rawValue'],
                        'created_at' => $c['createdAt'] ?? null,
                    ]);
                }
                foreach ($row['tags'] ?? [] as $t) {
                    $tagStmt->execute([
                        'rid' => $row['id'],
                        'tag' => (string) $t['tag'],
                        'created_at' => $t['createdAt'] ?? null,
                    ]);
                }

                try {
                    $completion = $metadata['completionTime'] ?? null;
                    $mysqlStmt->execute([
                        'id' => $row['id'],
                        'form_id' => $formId,
                        'status' => in_array($row['status'], $mysqlEnum, true) ? $row['status'] : 'archived',
                        'submitted_at' => $row['submittedAt'],
                        'ip_address' => isset($metadata['ipAddress']) && is_string($metadata['ipAddress']) ? substr($metadata['ipAddress'], 0, 45) : null,
                        'user_agent' => isset($metadata['userAgent']) && is_string($metadata['userAgent']) ? $metadata['userAgent'] : null,
                        'completion_time' => is_numeric($completion) ? (int) $completion : null,
                    ]);
                    $mysqlInsertedIds[] = $row['id'];
                } catch (\Exception $mysqlErr) {
                    // Keep the stores in sync: drop this row's SQLite side, then fail the chunk.
                    $db->exec("DELETE FROM responses WHERE id = " . $db->quote($row['id']));
                    throw $mysqlErr;
                }

                $created++;
            }

            $db->commit();
            if ($created > 0) {
                $this->syncResponseCount($formId);
            }
        } catch (\Exception $e) {
            $db->rollBack();
            if (!empty($mysqlInsertedIds)) {
                try {
                    $placeholders = implode(',', array_fill(0, count($mysqlInsertedIds), '?'));
                    $this->mysql->prepare("DELETE FROM response_metadata WHERE id IN ($placeholders)")
                        ->execute($mysqlInsertedIds);
                } catch (\Exception $cleanupErr) {
                    $this->logger->warning('Failed to clean up MySQL rows after restore rollback', [
                        'formId' => $formId,
                        'orphanedIds' => count($mysqlInsertedIds),
                        'error' => $cleanupErr->getMessage(),
                    ]);
                }
            }
            throw $e instanceof \RuntimeException
                ? $e
                : new \RuntimeException('Restore failed: ' . $e->getMessage(), 0, $e);
        }

        return $created;
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
