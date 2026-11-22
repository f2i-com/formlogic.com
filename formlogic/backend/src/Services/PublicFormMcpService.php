<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Controllers\ResponseController;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\Psr7\Response as SlimResponse;

/**
 * Zero-account Public Form & Interactive Login MCP service.
 *
 * Powers:
 *  - Per-form zero-account MCP endpoint: `POST /api/mcp/forms/{formId}`
 *  - General zero-account public MCP endpoint: `POST /api/mcp/public`
 *  - Public-form tools also surfaced inside authenticated `POST /api/mcp`
 *
 * Security invariants:
 *  - Only published, standalone (non-app) forms are accessible — exact same gate as
 *    `GET /api/public/forms/{id}` (`!isFormInAnyApp($formId)` && `status === 'published'`).
 *  - Never exposes `userId`, `logicScript`, `logicPrompt`, or `settings.notifications`.
 *  - E2EE private forms NEVER accept plaintext server submission: `submit_public_form`
 *    cleanly directs the AI to call `save_form_draft` so the user opens `resumeUrl` in their
 *    browser where the signed manifest is verified and sealed with libsodium.
 *  - Direct submissions go through the EXACT `ResponseController::create()` pipeline
 *    (quota, validation, conditional visibility, calculated fields, idempotency, onSubmit).
 */
class PublicFormMcpService
{
    private const NON_INPUT_TYPES = ['section', 'statement', 'welcome_screen', 'thank_you', 'calculated', 'hidden'];

    public function __construct(
        private FormService $formService,
        private AppService $appService,
        private ResponseService $responseService,
        private PublicFormDraftService $drafts,
        private McpDeviceAuthService $deviceAuth,
        private ResponseController $responseController,
        private ?FormEncryptionService $formEncryption = null,
    ) {}

    /**
     * Tool definitions exposed on `/api/mcp/public` and `/api/mcp/forms/{formId}`.
     *
     * @return list<array<string, mixed>>
     */
    public static function toolDefinitions(?string $boundFormId = null, bool $includeLoginTools = true): array
    {
        $obj = static function (array $props, array $req = []): array {
            $schema = [
                'type' => 'object',
                'properties' => $props === [] ? (object) [] : $props,
            ];
            if ($req !== []) {
                $schema['required'] = $req;
            }
            return $schema;
        };

        $formIdProp = [
            'type' => 'string',
            'description' => $boundFormId !== null
                ? "Form ID (optional — defaults to bound form '{$boundFormId}')."
                : 'Published FormLogic form ID (from the /form/{formId} URL).',
        ];
        $reqFormId = $boundFormId !== null ? [] : ['formId'];

        $tools = [
            [
                'name' => 'get_public_form',
                'description' => 'Inspect a published public form: returns its title, description, ordered sections (for large multi-section forms like medical intake), every fillable field (id, label, type, required, options, validation rules, conditional logic), open/closed status, and whether E2EE privacy requires browser-side sealing via save_form_draft.',
                'inputSchema' => $obj(['formId' => $formIdProp], $reqFormId),
                'annotations' => ['readOnlyHint' => true],
            ],
            [
                'name' => 'validate_form_answers',
                'description' => 'Dry-run validation and conditional-logic evaluation on partial or complete answers without submitting. Returns per-section progress, visible fields, missing required fields, format errors, and computed calculated values — ideal for filling large multi-section forms step by step.',
                'inputSchema' => $obj([
                    'formId' => $formIdProp,
                    'answers' => ['type' => 'object', 'description' => 'Map of fieldId -> answer value.'],
                ], array_merge($reqFormId, ['answers'])),
                'annotations' => ['readOnlyHint' => true],
            ],
            [
                'name' => 'save_form_draft',
                'description' => 'Save (or update) in-progress form answers without submitting yet. Returns a private resumeUrl (/form/{formId}?draft=...), a draftToken to keep updating the same draft across turns, section progress, AND a portable formlogic-form-draft JSON object the user can download and re-import anytime. Always use this for E2EE private forms or when the user wants to review/sign before submitting.',
                'inputSchema' => $obj([
                    'formId' => $formIdProp,
                    'answers' => ['type' => 'object', 'description' => 'Map of fieldId -> answer value filled so far.'],
                    'currentSectionIndex' => ['type' => 'integer', 'description' => 'Zero-based section index the user should resume on (default 0).'],
                    'draftToken' => ['type' => 'string', 'description' => 'Existing fld_... draftToken to update in place (optional).'],
                    'label' => ['type' => 'string', 'description' => 'Optional friendly note for this draft (e.g., "Completed sections 1-3").'],
                ], array_merge($reqFormId, ['answers'])),
                'annotations' => ['readOnlyHint' => false],
            ],
            [
                'name' => 'get_form_draft',
                'description' => 'Load a previously saved draft by draftToken along with up-to-date section progress and remaining required fields.',
                'inputSchema' => $obj([
                    'formId' => $formIdProp,
                    'draftToken' => ['type' => 'string', 'description' => 'The fld_... token returned by save_form_draft.'],
                ], array_merge($reqFormId, ['draftToken'])),
                'annotations' => ['readOnlyHint' => true],
            ],
            [
                'name' => 'submit_public_form',
                'description' => 'Submit a completed public form on behalf of the user (no FormLogic account needed). Always confirm all answers with the user first and pass confirmSubmit: true. Automatically validates all visible required fields and cleans up draftToken if provided. Note: E2EE private forms cannot be submitted server-side — use save_form_draft and give the user resumeUrl instead.',
                'inputSchema' => $obj([
                    'formId' => $formIdProp,
                    'answers' => ['type' => 'object', 'description' => 'Complete map of fieldId -> answer value.'],
                    'confirmSubmit' => ['type' => 'boolean', 'description' => 'Must be true after the user confirms they want to submit.'],
                    'idempotencyKey' => ['type' => 'string', 'description' => 'Optional unique key to make retries safely idempotent.'],
                    'draftToken' => ['type' => 'string', 'description' => 'Optional fld_... draftToken to delete upon successful submission.'],
                ], array_merge($reqFormId, ['answers', 'confirmSubmit'])),
                'annotations' => ['readOnlyHint' => false],
            ],
        ];

        if ($includeLoginTools) {
            $tools[] = [
                'name' => 'start_mcp_login',
                'description' => 'Start a secure browser-approved FormLogic account login on behalf of the user (no manual token copying needed). Returns a short verificationUrl and userCode — ask the user to open the URL, sign in (or sign up), and click Approve, then call complete_mcp_login.',
                'inputSchema' => $obj([
                    'clientName' => ['type' => 'string', 'description' => 'Display name of your AI client (e.g., "Claude Desktop", "Cursor").'],
                    'scopes' => ['type' => 'array', 'items' => ['type' => 'string'], 'description' => 'Optional requested scopes (defaults to standard builder scopes; add responses:read / responses:write if needed).'],
                    'appId' => ['type' => 'string', 'description' => 'Optional app ID to confine the login to a single app.'],
                ]),
                'annotations' => ['readOnlyHint' => false],
            ];
            $tools[] = [
                'name' => 'complete_mcp_login',
                'description' => 'Check whether the user approved the sign-in started by start_mcp_login and redeem the one-time deviceCode for an authenticated FormLogic MCP Bearer token + /api/mcp endpoint URL.',
                'inputSchema' => $obj([
                    'deviceCode' => ['type' => 'string', 'description' => 'The mcpdc_... deviceCode returned by start_mcp_login.'],
                ], ['deviceCode']),
                'annotations' => ['readOnlyHint' => false],
            ];
        }

        return $tools;
    }

    /**
     * MCP resources exposed on a form-bound public endpoint (`/api/mcp/forms/{formId}`).
     *
     * @return list<array<string, mixed>>
     */
    public function listResources(?string $boundFormId): array
    {
        if ($boundFormId === null || $boundFormId === '') {
            return [];
        }
        $loaded = $this->loadPublicForm($boundFormId);
        if (!$loaded['ok']) {
            return [];
        }
        $form = $loaded['form'];
        return [[
            'uri' => "formlogic://forms/{$boundFormId}/schema",
            'name' => (string) ($form['title'] ?? 'Public Form') . ' — Form Schema & Sections',
            'description' => 'Structured sections, fields, validation rules, and filling guide for this FormLogic public form.',
            'mimeType' => 'application/json',
        ]];
    }

    /**
     * Read a form schema MCP resource (`formlogic://forms/{formId}/schema`).
     *
     * @return array<string, mixed>
     */
    public function readResource(string $uri, ?string $boundFormId = null): array
    {
        if (!preg_match('#^formlogic://forms/([A-Za-z0-9_-]{1,64})/schema$#', $uri, $m)) {
            throw new \InvalidArgumentException("Unknown resource URI: {$uri}");
        }
        $formId = $m[1];
        if ($boundFormId !== null && $boundFormId !== $formId) {
            throw new \InvalidArgumentException('This MCP endpoint is bound to a different form.');
        }
        $payload = $this->getPublicFormPayload($formId);
        return [
            'contents' => [[
                'uri' => $uri,
                'mimeType' => 'application/json',
                'text' => (string) json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            ]],
        ];
    }

    /**
     * Execute one public-form or device-login MCP tool call.
     *
     * @param array<string, mixed> $args
     * @return array<string, mixed>
     */
    public function callTool(string $name, array $args, Request $request, ?string $boundFormId = null, bool $allowLoginTools = true): array
    {
        $resolveFormId = static function () use ($args, $boundFormId): string {
            $passed = is_string($args['formId'] ?? null) ? trim($args['formId']) : '';
            if ($boundFormId !== null) {
                if ($passed !== '' && $passed !== $boundFormId) {
                    throw new \InvalidArgumentException("This MCP endpoint is bound to form '{$boundFormId}'.");
                }
                return $boundFormId;
            }
            if ($passed === '') {
                throw new \InvalidArgumentException('formId is required.');
            }
            return $passed;
        };

        try {
            switch ($name) {
                case 'get_public_form':
                    return $this->toolOk($this->getPublicFormPayload($resolveFormId()));

                case 'validate_form_answers':
                    $formId = $resolveFormId();
                    $answers = is_array($args['answers'] ?? null) ? $args['answers'] : [];
                    return $this->toolOk($this->validateAnswersPayload($formId, $answers));

                case 'save_form_draft':
                    $formId = $resolveFormId();
                    $answers = is_array($args['answers'] ?? null) ? $args['answers'] : [];
                    $secIdx = is_int($args['currentSectionIndex'] ?? null) ? $args['currentSectionIndex'] : 0;
                    $existingToken = is_string($args['draftToken'] ?? null) ? trim($args['draftToken']) : null;
                    $label = is_string($args['label'] ?? null) ? $args['label'] : null;
                    return $this->toolOk($this->saveDraftPayload($formId, $answers, $secIdx, $existingToken, $label, $request));

                case 'get_form_draft':
                    $formId = $resolveFormId();
                    $token = is_string($args['draftToken'] ?? null) ? trim($args['draftToken']) : '';
                    if ($token === '') {
                        throw new \InvalidArgumentException('draftToken is required.');
                    }
                    return $this->toolOk($this->getDraftPayload($formId, $token, $request));

                case 'submit_public_form':
                    $formId = $resolveFormId();
                    $answers = is_array($args['answers'] ?? null) ? $args['answers'] : [];
                    $confirm = ($args['confirmSubmit'] ?? false) === true;
                    if (!$confirm) {
                        throw new \InvalidArgumentException('confirmSubmit must be true after confirming all answers with the user. Use save_form_draft if the user still needs to review.');
                    }
                    $idemKey = is_string($args['idempotencyKey'] ?? null) ? trim($args['idempotencyKey']) : null;
                    $draftToken = is_string($args['draftToken'] ?? null) ? trim($args['draftToken']) : null;
                    return $this->toolOk($this->submitPublicFormPayload($formId, $answers, $idemKey, $draftToken, $request));

                case 'start_mcp_login':
                    if (!$allowLoginTools) {
                        throw new \InvalidArgumentException('You are already connected with an authenticated MCP session.');
                    }
                    $clientName = is_string($args['clientName'] ?? null) ? $args['clientName'] : 'AI Assistant (MCP)';
                    $scopes = is_array($args['scopes'] ?? null)
                        ? array_values(array_filter($args['scopes'], 'is_string'))
                        : null;
                    $appId = is_string($args['appId'] ?? null) ? $args['appId'] : null;
                    $origin = McpOAuthService::publicOrigin($request);
                    $started = $this->deviceAuth->startLogin($clientName, $scopes, $appId, $origin);
                    $started['instructions'] = "Ask the user to open {$started['verificationUriComplete']} in their browser, sign in to FormLogic (or create an account), verify code {$started['userCode']}, and click Approve. Once they approve, call complete_mcp_login with the deviceCode.";
                    return $this->toolOk($started);

                case 'complete_mcp_login':
                    if (!$allowLoginTools) {
                        throw new \InvalidArgumentException('You are already connected with an authenticated MCP session.');
                    }
                    $deviceCode = is_string($args['deviceCode'] ?? null) ? trim($args['deviceCode']) : '';
                    if ($deviceCode === '') {
                        throw new \InvalidArgumentException('deviceCode is required.');
                    }
                    $mcpUrl = McpOAuthService::resourceFor($request);
                    return $this->toolOk($this->deviceAuth->pollOrRedeem($deviceCode, $mcpUrl));

                default:
                    return $this->toolError("Unknown tool: {$name}");
            }
        } catch (\Throwable $e) {
            return $this->toolError($e->getMessage());
        }
    }

    /**
     * Build the safe public-form schema + sections payload.
     *
     * @return array<string, mixed>
     */
    public function getPublicFormPayload(string $formId): array
    {
        $loaded = $this->loadPublicForm($formId);
        if (!$loaded['ok']) {
            throw new \RuntimeException($loaded['error']);
        }
        $form = $loaded['form'];
        $settings = is_array($form['settings'] ?? null) ? $form['settings'] : [];
        $isPrivate = $this->isPrivateForm($formId);
        $fields = is_array($form['fields'] ?? null) ? $form['fields'] : [];

        $structured = $this->structureSectionsAndFields($fields, false);
        $quotaLimit = isset($settings['quotaLimit']) && is_numeric($settings['quotaLimit']) ? (int) $settings['quotaLimit'] : null;
        $responseCount = (int) ($form['responseCount'] ?? 0);
        $quotaRemaining = ($quotaLimit !== null && $quotaLimit > 0) ? max(0, $quotaLimit - $responseCount) : null;
        $isClosed = !empty($settings['isClosed']) || ($quotaRemaining !== null && $quotaRemaining <= 0);

        return [
            'formId' => (string) $form['id'],
            'title' => (string) ($form['title'] ?? 'Untitled Form'),
            'description' => (string) ($form['description'] ?? ''),
            'isClosed' => $isClosed,
            'closedMessage' => $isClosed ? (string) ($settings['closedMessage'] ?? 'This form is no longer accepting responses.') : null,
            'quotaRemaining' => $quotaRemaining,
            'isPrivate' => $isPrivate,
            'directSubmitAllowed' => !$isPrivate && !$isClosed,
            'sectionCount' => count($structured['sections']),
            'totalQuestions' => $structured['totalQuestions'],
            'requiredQuestions' => $structured['requiredQuestions'],
            'sections' => $structured['sections'],
            'fields' => $structured['fields'],
            'fillingGuidance' => $isPrivate
                ? 'This is an end-to-end encrypted private form. Collect answers section by section, validate with validate_form_answers, then call save_form_draft and give the user resumeUrl so their browser encrypts and submits securely.'
                : 'Walk through the form section by section with the user. Use validate_form_answers to check partial progress and save_form_draft at any point to give the user a resumeUrl or downloadable .json backup. Once complete and confirmed by the user, call submit_public_form with confirmSubmit: true (or let the user review and sign at resumeUrl).',
        ];
    }

    /**
     * Dry-run validation + conditional visibility + section progress.
     *
     * @param array<string, mixed> $rawAnswers
     * @return array<string, mixed>
     */
    public function validateAnswersPayload(string $formId, array $rawAnswers): array
    {
        $loaded = $this->loadPublicForm($formId);
        if (!$loaded['ok']) {
            throw new \RuntimeException($loaded['error']);
        }
        $form = $loaded['form'];
        $fields = is_array($form['fields'] ?? null) ? $form['fields'] : [];

        if (($shapeRefusal = $this->responseService->answerShapeRefusal($fields, $rawAnswers)) !== null) {
            throw new \InvalidArgumentException($shapeRefusal['message']);
        }

        $sanitized = $this->responseService->sanitizeSubmittedAnswers($fields, $rawAnswers);
        $normalized = $this->responseService->normalizeAnswers($fields, $sanitized, $formId);
        $withCalc = $this->responseService->applyCalculatedFields($fields, $normalized);
        $visibility = $this->responseService->computeFieldVisibility($fields, $withCalc);
        $errors = $this->responseService->validateSubmittedAnswers($fields, $withCalc);

        $visibleIds = [];
        $missingRequired = [];
        $calculatedValues = [];
        foreach ($fields as $field) {
            if (!is_array($field)) {
                continue;
            }
            $fid = (string) ($field['id'] ?? '');
            $type = (string) ($field['type'] ?? 'short_text');
            if ($fid === '') {
                continue;
            }
            if ($type === 'calculated' && array_key_exists($fid, $withCalc)) {
                $calculatedValues[$fid] = $withCalc[$fid];
            }
            if (in_array($type, self::NON_INPUT_TYPES, true) || $type === 'linked_record') {
                continue;
            }
            $vis = $visibility[$fid] ?? ['visible' => true, 'required' => (bool) ($field['required'] ?? false)];
            if ($vis['visible']) {
                $visibleIds[] = $fid;
                if ($vis['required'] && $this->isBlankValue($withCalc[$fid] ?? null)) {
                    $missingRequired[] = [
                        'fieldId' => $fid,
                        'label' => (string) ($field['label'] ?? $fid),
                    ];
                }
            }
        }

        $progress = $this->computeSectionProgress($fields, $withCalc, $visibility, $errors);

        return [
            'formId' => $formId,
            'valid' => $errors === [],
            'fieldErrors' => $errors === [] ? (object) [] : $errors,
            'missingRequired' => $missingRequired,
            'visibleFieldIds' => $visibleIds,
            'calculatedValues' => $calculatedValues === [] ? (object) [] : $calculatedValues,
            'sectionProgress' => $progress,
        ];
    }

    /**
     * Save/update a public draft and build both `resumeUrl` and portable `draftJson`.
     *
     * @param array<string, mixed> $rawAnswers
     * @return array<string, mixed>
     */
    public function saveDraftPayload(
        string $formId,
        array $rawAnswers,
        int $currentSectionIndex,
        ?string $existingToken,
        ?string $label,
        Request $request,
    ): array {
        $loaded = $this->loadPublicForm($formId);
        if (!$loaded['ok']) {
            throw new \RuntimeException($loaded['error']);
        }
        $form = $loaded['form'];
        $fields = is_array($form['fields'] ?? null) ? $form['fields'] : [];

        $sanitized = $this->responseService->sanitizeSubmittedAnswers($fields, $rawAnswers);
        $normalized = $this->responseService->normalizeAnswers($fields, $sanitized, $formId);
        $saved = $this->drafts->saveDraft($formId, $normalized, $currentSectionIndex, $existingToken, $label, 'mcp');
        $validation = $this->validateAnswersPayload($formId, $normalized);

        $origin = McpOAuthService::publicOrigin($request);
        $resumeUrl = $origin . '/form/' . rawurlencode($formId) . '?draft=' . rawurlencode($saved['draftToken']);

        return [
            'draftToken' => $saved['draftToken'],
            'resumeUrl' => $resumeUrl,
            'expiresAt' => $saved['expiresAt'],
            'updatedAt' => $saved['updatedAt'],
            'answeredCount' => $saved['answerCount'],
            'valid' => $validation['valid'],
            'missingRequired' => $validation['missingRequired'],
            'fieldErrors' => $validation['fieldErrors'],
            'sectionProgress' => $validation['sectionProgress'],
            'draftJson' => $this->buildPortableDraftJson($form, $normalized, $saved['currentSectionIndex']),
            'nextStep' => 'Share resumeUrl with the user so they can review all filled sections in FormLogic (or download/re-import draftJson anytime).',
        ];
    }

    /**
     * Retrieve a previously saved draft by token.
     *
     * @return array<string, mixed>
     */
    public function getDraftPayload(string $formId, string $draftToken, Request $request): array
    {
        $loaded = $this->loadPublicForm($formId);
        if (!$loaded['ok']) {
            throw new \RuntimeException($loaded['error']);
        }
        $draft = $this->drafts->getDraft($formId, $draftToken);
        if ($draft === null) {
            throw new \RuntimeException('Draft not found or expired.');
        }
        $validation = $this->validateAnswersPayload($formId, $draft['answers']);
        $origin = McpOAuthService::publicOrigin($request);
        return [
            'formId' => $formId,
            'label' => $draft['label'],
            'currentSectionIndex' => $draft['currentSectionIndex'],
            'answers' => $draft['answers'],
            'expiresAt' => $draft['expiresAt'],
            'updatedAt' => $draft['updatedAt'],
            'resumeUrl' => $origin . '/form/' . rawurlencode($formId) . '?draft=' . rawurlencode($draftToken),
            'valid' => $validation['valid'],
            'missingRequired' => $validation['missingRequired'],
            'sectionProgress' => $validation['sectionProgress'],
        ];
    }

    /**
     * Submit a public form through the exact `ResponseController::create()` pipeline.
     *
     * @param array<string, mixed> $answers
     * @return array<string, mixed>
     */
    public function submitPublicFormPayload(
        string $formId,
        array $answers,
        ?string $idempotencyKey,
        ?string $draftToken,
        Request $request,
    ): array {
        $loaded = $this->loadPublicForm($formId);
        if (!$loaded['ok']) {
            throw new \RuntimeException($loaded['error']);
        }
        if ($this->isPrivateForm($formId)) {
            throw new \RuntimeException(
                'This form uses end-to-end encryption and cannot be submitted in plaintext through the server. Call save_form_draft and give the user resumeUrl so their browser seals and submits it.'
            );
        }

        $body = ['answers' => $answers];
        if ($idempotencyKey !== null && $idempotencyKey !== '') {
            $body['idempotencyKey'] = $idempotencyKey;
        }
        $syntheticRequest = $request
            ->withParsedBody($body)
            ->withoutAttribute('userId')
            ->withoutAttribute('user');

        $res = $this->responseController->create($syntheticRequest, new SlimResponse(), ['formId' => $formId]);
        $status = $res->getStatusCode();
        $decoded = json_decode((string) $res->getBody(), true);
        if (!is_array($decoded)) {
            $decoded = [];
        }

        if ($status >= 400) {
            $msg = is_string($decoded['message'] ?? null) ? $decoded['message'] : "Submission failed (HTTP {$status}).";
            if (is_array($decoded['errors'] ?? null) && $decoded['errors'] !== []) {
                $msg .= ' Field errors: ' . json_encode($decoded['errors'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            }
            throw new \RuntimeException($msg);
        }

        if ($draftToken !== null && $draftToken !== '') {
            $this->drafts->deleteDraft($formId, $draftToken);
        }

        return [
            'submitted' => true,
            'idempotent' => ($decoded['idempotent'] ?? false) === true,
            'responseId' => $decoded['response']['id'] ?? null,
            'status' => $decoded['response']['status'] ?? 'submitted',
            'submittedAt' => $decoded['response']['submittedAt'] ?? gmdate('c'),
        ];
    }

    /**
     * Load and verify that a form is published & standalone (never app-private).
     *
     * @return array{ok: true, form: array<string, mixed>}|array{ok: false, error: string}
     */
    public function loadPublicForm(string $formId): array
    {
        $form = $this->formService->getForm($formId);
        if (!$form) {
            return ['ok' => false, 'error' => 'Form not found.'];
        }
        if ($this->appService->isFormInAnyApp($formId)) {
            return ['ok' => false, 'error' => 'This form belongs to a private app and is not publicly accessible. Sign in with start_mcp_login or use the app portal.'];
        }
        if (($form['status'] ?? '') !== 'published') {
            return ['ok' => false, 'error' => 'This form is not published yet.'];
        }
        return ['ok' => true, 'form' => $form];
    }

    /**
     * Group a flat fields array into logical sections for AI inspection & progress tracking.
     *
     * @param array<int, mixed> $fields
     * @return array{
     *   sections: list<array<string, mixed>>,
     *   fields: list<array<string, mixed>>,
     *   totalQuestions: int,
     *   requiredQuestions: int
     * }
     */
    private function structureSectionsAndFields(array $fields, bool $allowLinkedRecord): array
    {
        $sections = [];
        $currentSection = [
            'index' => 0,
            'id' => 'section_0',
            'title' => 'General',
            'description' => '',
            'fieldIds' => [],
        ];
        $hasExplicitSections = false;
        foreach ($fields as $f) {
            if (is_array($f) && ($f['type'] ?? '') === 'section') {
                $hasExplicitSections = true;
                break;
            }
        }

        $outFields = [];
        $totalQuestions = 0;
        $requiredQuestions = 0;
        $sectionStarted = !$hasExplicitSections;

        foreach ($fields as $field) {
            if (!is_array($field)) {
                continue;
            }
            $type = (string) ($field['type'] ?? 'short_text');
            $fid = (string) ($field['id'] ?? '');
            if ($fid === '' || $type === 'thank_you' || $type === 'hidden') {
                continue;
            }
            if (!$allowLinkedRecord && $type === 'linked_record') {
                continue;
            }
            if ($type === 'welcome_screen') {
                continue;
            }
            if ($type === 'section') {
                if ($sectionStarted && $currentSection['fieldIds'] !== []) {
                    $sections[] = $currentSection;
                }
                $nextIdx = count($sections);
                $currentSection = [
                    'index' => $nextIdx,
                    'id' => $fid,
                    'title' => (string) ($field['label'] ?? 'Section ' . ($nextIdx + 1)),
                    'description' => (string) ($field['description'] ?? ''),
                    'fieldIds' => [],
                ];
                $sectionStarted = true;
                continue;
            }

            if (!$sectionStarted) {
                $sectionStarted = true;
            }

            $props = is_array($field['properties'] ?? null) ? $field['properties'] : [];
            $isInput = !in_array($type, self::NON_INPUT_TYPES, true);
            $required = $isInput && !empty($field['required']);
            if ($isInput) {
                $totalQuestions++;
                if ($required) {
                    $requiredQuestions++;
                }
            }

            $entry = [
                'id' => $fid,
                'label' => (string) ($field['label'] ?? $fid),
                'type' => $type,
                'sectionIndex' => $currentSection['index'],
                'sectionTitle' => $currentSection['title'],
                'required' => $required,
            ];
            if (!empty($field['description'])) {
                $entry['description'] = (string) $field['description'];
            }
            if (!empty($field['placeholder'])) {
                $entry['placeholder'] = (string) $field['placeholder'];
            }
            if (is_array($props['options'] ?? null) && $props['options'] !== []) {
                $entry['options'] = array_map(static function ($opt): array {
                    return is_array($opt)
                        ? ['value' => (string) ($opt['value'] ?? $opt['id'] ?? ''), 'label' => (string) ($opt['label'] ?? '')]
                        : ['value' => (string) $opt, 'label' => (string) $opt];
                }, $props['options']);
            }
            foreach (['min', 'max', 'step', 'maxStars', 'scaleStart', 'scaleEnd', 'scaleStartLabel', 'scaleEndLabel'] as $k) {
                if (array_key_exists($k, $props)) {
                    $entry[$k] = $props[$k];
                }
            }
            if (is_array($field['validation'] ?? null) && $field['validation'] !== []) {
                $entry['validation'] = $field['validation'];
            }
            if (is_array($field['conditionalLogic'] ?? null)) {
                $entry['conditionalLogic'] = $field['conditionalLogic'];
            }

            $currentSection['fieldIds'][] = $fid;
            $outFields[] = $entry;
        }

        if ($sectionStarted && ($currentSection['fieldIds'] !== [] || $sections === [])) {
            $sections[] = $currentSection;
        }

        return [
            'sections' => $sections,
            'fields' => $outFields,
            'totalQuestions' => $totalQuestions,
            'requiredQuestions' => $requiredQuestions,
        ];
    }

    /**
     * @param array<int, mixed> $fields
     * @param array<string, mixed> $answers
     * @param array<string, array{visible: bool, required: bool}> $visibility
     * @param array<string, string> $errors
     * @return list<array<string, mixed>>
     */
    private function computeSectionProgress(array $fields, array $answers, array $visibility, array $errors): array
    {
        $structured = $this->structureSectionsAndFields($fields, false);
        $fieldMeta = [];
        foreach ($structured['fields'] as $f) {
            $fieldMeta[(string) $f['id']] = $f;
        }
        $progress = [];
        foreach ($structured['sections'] as $sec) {
            $total = 0;
            $answered = 0;
            $required = 0;
            $requiredAnswered = 0;
            $errCount = 0;
            foreach ($sec['fieldIds'] as $fid) {
                $meta = $fieldMeta[$fid] ?? null;
                if ($meta === null || in_array($meta['type'], self::NON_INPUT_TYPES, true)) {
                    continue;
                }
                $vis = $visibility[$fid] ?? ['visible' => true, 'required' => (bool) $meta['required']];
                if (!$vis['visible']) {
                    continue;
                }
                $total++;
                $filled = !$this->isBlankValue($answers[$fid] ?? null);
                if ($filled) {
                    $answered++;
                }
                if ($vis['required']) {
                    $required++;
                    if ($filled) {
                        $requiredAnswered++;
                    }
                }
                if (isset($errors[$fid])) {
                    $errCount++;
                }
            }
            $progress[] = [
                'index' => $sec['index'],
                'title' => $sec['title'],
                'answered' => $answered,
                'total' => $total,
                'requiredAnswered' => $requiredAnswered,
                'requiredTotal' => $required,
                'errorCount' => $errCount,
                'complete' => $errCount === 0 && $requiredAnswered >= $required,
            ];
        }
        return $progress;
    }

    /**
     * Build the portable `formlogic-form-draft` v1 JSON envelope matching `ui/src/lib/formDraft.ts`.
     *
     * @param array<string, mixed> $form
     * @param array<string, mixed> $answers
     * @return array<string, mixed>
     */
    private function buildPortableDraftJson(array $form, array $answers, int $currentSectionIndex): array
    {
        $structured = $this->structureSectionsAndFields(is_array($form['fields'] ?? null) ? $form['fields'] : [], false);
        $fieldSummaries = [];
        foreach ($structured['fields'] as $f) {
            if (in_array($f['type'], self::NON_INPUT_TYPES, true)) {
                continue;
            }
            $fieldSummaries[] = [
                'id' => $f['id'],
                'label' => $f['label'],
                'type' => $f['type'],
                'section' => $f['sectionTitle'],
                'required' => $f['required'],
            ];
        }
        return [
            'format' => 'formlogic-form-draft',
            'version' => 1,
            'formId' => (string) ($form['id'] ?? ''),
            'formTitle' => (string) ($form['title'] ?? 'Untitled Form'),
            'savedAt' => gmdate('c'),
            'currentSectionIndex' => $currentSectionIndex,
            'answers' => $answers === [] ? (object) [] : $answers,
            'fields' => $fieldSummaries,
        ];
    }

    private function isPrivateForm(string $formId): bool
    {
        return $this->formEncryption !== null && $this->formEncryption->isPrivate($formId);
    }

    private function isBlankValue(mixed $value): bool
    {
        if ($value === null || $value === '' || $value === []) {
            return true;
        }
        if (is_string($value)) {
            $trimmed = trim($value);
            return $trimmed === '' || $trimmed === 'typed:';
        }
        return false;
    }

    /** @return array<string, mixed> */
    private function toolOk(array $payload): array
    {
        return [
            'content' => [[
                'type' => 'text',
                'text' => (string) json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            ]],
        ];
    }

    /** @return array<string, mixed> */
    private function toolError(string $message): array
    {
        return [
            'content' => [['type' => 'text', 'text' => 'Error: ' . $message]],
            'isError' => true,
        ];
    }
}
