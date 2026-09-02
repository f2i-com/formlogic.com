<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\AIService;
use FormLogic\Services\DocumentConverter;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

class AIController
{
    use JsonResponseTrait;

    private AIService $aiService;
    private DocumentConverter $documentConverter;
    private array $uploadSettings;
    private LoggerInterface $logger;
    private ?\FormLogic\Services\PlanService $planService;
    private ?\FormLogic\Services\UserAiSettingsService $userAiSettings;
    private ?\FormLogic\Services\ApiKeyService $apiKeyService;
    private ?\FormLogic\Services\ChatToolsService $chatTools;
    private ?\FormLogic\Services\AuditService $auditService;

    /** Hosted tool loop bound (plan Phase 6 §5.4): at most this many upstream model rounds per turn. */
    public const CHAT_TOOL_MAX_ROUNDS = 6;
    /** A tool result fed back to the model is capped (a 200-record list must not flood the context). */
    private const CHAT_TOOL_RESULT_MAX_CHARS = 30000;

    public function __construct(
        AIService $aiService,
        DocumentConverter $documentConverter,
        array $uploadSettings = [],
        ?LoggerInterface $logger = null,
        ?\FormLogic\Services\PlanService $planService = null,
        ?\FormLogic\Services\UserAiSettingsService $userAiSettings = null,
        ?\FormLogic\Services\ApiKeyService $apiKeyService = null,
        // Plan Phase 6: the shared chat tool handlers + audit sink for the hosted tool loop.
        // Optional (appended last) so older harnesses constructing this controller stay valid.
        ?\FormLogic\Services\ChatToolsService $chatTools = null,
        ?\FormLogic\Services\AuditService $auditService = null
    ) {
        $this->aiService = $aiService;
        $this->documentConverter = $documentConverter;
        $this->logger = $logger ?? new NullLogger();
        $this->planService = $planService;
        $this->userAiSettings = $userAiSettings;
        $this->apiKeyService = $apiKeyService;
        $this->chatTools = $chatTools;
        $this->auditService = $auditService;
        $this->uploadSettings = array_merge([
            'maxFileSize' => 10 * 1024 * 1024, // 10MB default
            'allowedTypes' => [
                'application/pdf',
                'application/msword',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'image/jpeg',
                'image/png',
                'image/gif',
                'image/webp',
            ],
        ], $uploadSettings);
    }

    /**
     * Check if AI service is available
     * GET /api/ai/status
     */
    public function status(Request $request, Response $response): Response
    {
        $enabled = $this->aiService->isEnabled();
        $isConfigured = $this->aiService->isConfigured();

        return $this->jsonResponse($response, [
            'available' => $isConfigured,
            'enabled' => $enabled,
            'message' => !$enabled
                ? 'The in-app AI is turned off (AI_ENABLED=false). Connect an external AI via the MCP server instead.'
                : ($isConfigured
                    ? 'AI service is configured and ready'
                    : 'AI service is not configured. Set AI_BASE_URL to a local/OpenAI-compatible server (LM Studio, Ollama, …) — add AI_API_KEY only if your provider requires one.'),
        ]);
    }

    /**
     * Generate form from text prompt
     * POST /api/ai/generate-form
     *
     * Body: { "prompt": "Create a contact form..." }
     */
    /**
     * Charge one ai_messages unit for a generator lane, or return the allowance
     * refusal. The chat lane always did this; the fixed generators (form, app
     * plan, file→form, script, improve, screen) carried only the 15/min limiter,
     * so an account whose hosted-AI allowance was exhausted could keep driving
     * 16k-token screen generations against the operator's key indefinitely.
     */
    private function meterGeneration(Request $request, Response $response): ?Response
    {
        if ($this->planService === null) {
            return null;
        }
        $userId = $request->getAttribute('userId');
        if (!is_string($userId) || $userId === '') {
            return null;
        }
        try {
            $this->planService->checkAndIncrement($userId, 'ai_messages', 1);
        } catch (\RuntimeException $e) {
            return $this->allowanceRefusal($response, $e->getMessage());
        }
        return null;
    }

    public function generateForm(Request $request, Response $response): Response
    {
        if (($refused = $this->meterGeneration($request, $response)) !== null) {
            return $refused;
        }
        $body = $request->getParsedBody();
        $prompt = $body['prompt'] ?? '';

        if (empty($prompt)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Prompt is required',
            ], 400);
        }

        if (!is_string($prompt) || strlen($prompt) > 50000) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Prompt must be text no longer than 50000 characters',
            ], 400);
        }

        // Optional context for EDITING an existing form: the current fields + script. Sanitized and
        // bounded — only id/label/type/required are used to ground the model's modification.
        $existingFields = [];
        if (is_array($body['existingFields'] ?? null)) {
            foreach (array_slice($body['existingFields'], 0, 300) as $f) {
                if (!is_array($f)) {
                    continue;
                }
                $existingFields[] = [
                    'id' => substr((string) ($f['id'] ?? ''), 0, 120),
                    'label' => substr((string) ($f['label'] ?? ''), 0, 300),
                    'type' => substr((string) ($f['type'] ?? ''), 0, 40),
                    'required' => !empty($f['required']),
                ];
            }
        }
        $existingScript = is_string($body['existingScript'] ?? null) ? substr($body['existingScript'], 0, 20000) : '';

        try {
            $result = $this->aiService->generateFormFromPrompt($prompt, $existingFields, $existingScript);

            return $this->jsonResponse($response, [
                'success' => true,
                'data' => $result,
            ]);
        } catch (\Throwable $e) {
            $this->logger->error('AI form generation error', ['exception' => $e->getMessage()]);
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'An unexpected error occurred',
            ], 500);
        }
    }

    /**
     * Generate a multi-form APP PLAN from a prompt (AI App Builder).
     * POST /api/ai/generate-app-plan  Body: { "prompt": "...", "maxForms"?: number }
     */
    public function generateAppPlan(Request $request, Response $response): Response
    {
        if (($refused = $this->meterGeneration($request, $response)) !== null) {
            return $refused;
        }
        $body = $request->getParsedBody();
        $prompt = $body['prompt'] ?? '';
        if (empty($prompt) || !is_string($prompt)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Prompt is required'], 400);
        }
        if (strlen($prompt) > 10000) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Prompt must be text no longer than 10000 characters'], 400);
        }
        $maxForms = max(1, min(10, (int) ($body['maxForms'] ?? 6)));
        $image = is_string($body['image'] ?? null) ? $body['image'] : null;
        if ($image !== null && strlen($image) > 8_000_000) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Image is too large (max ~6MB)'], 400);
        }

        try {
            $plan = $this->aiService->generateAppPlan($prompt, $maxForms, $image);
            return $this->jsonResponse($response, ['success' => true, 'data' => $plan]);
        } catch (\Throwable $e) {
            $this->logger->error('AI app-plan error', ['exception' => $e->getMessage()]);
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Could not generate an app plan — try rephrasing your description.',
            ], 500);
        }
    }

    /**
     * Generate a CUSTOM SCREEN ({ html, css, js }) for a form.
     * POST /api/ai/generate-screen  Body: { "prompt": "...", "fields"?: [{id,label,type}], "existing"?: "{json}" }
     */
    public function generateScreen(Request $request, Response $response): Response
    {
        if (($refused = $this->meterGeneration($request, $response)) !== null) {
            return $refused;
        }
        $body = $request->getParsedBody();
        $prompt = $body['prompt'] ?? '';
        if (empty($prompt) || !is_string($prompt) || strlen($prompt) > 10000) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Prompt is required (max 10000 chars)'], 400);
        }
        $fields = is_array($body['fields'] ?? null) ? array_slice($body['fields'], 0, 200) : [];
        $existing = is_string($body['existing'] ?? null) ? substr($body['existing'], 0, 200000) : '';
        $appForms = is_array($body['appForms'] ?? null) ? array_slice($body['appForms'], 0, 50) : [];
        // 'record' switches to the per-record widget prompt (record()/related() SDK, bounded card).
        $screenType = ($body['screenType'] ?? '') === 'record' ? 'record' : 'section';

        try {
            $screen = $this->aiService->generateCustomScreen($prompt, $fields, $existing, $appForms, $screenType);
            return $this->jsonResponse($response, ['success' => true, 'data' => $screen]);
        } catch (\Throwable $e) {
            $this->logger->error('AI screen generation error', ['exception' => $e->getMessage()]);
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Could not generate the screen — try rephrasing.',
            ], 500);
        }
    }

    /**
     * Generate form from uploaded document or image
     * POST /api/ai/generate-form-from-file
     *
     * Multipart form: file (required), prompt (optional additional instructions)
     */
    public function generateFormFromFile(Request $request, Response $response): Response
    {
        if (($refused = $this->meterGeneration($request, $response)) !== null) {
            return $refused;
        }
        // Opportunistically purge temp PNGs left by failed PDF/doc conversions (~5% of
        // requests), so the converter's scratch dir can't grow unbounded.
        if (random_int(1, 20) === 1) {
            $this->documentConverter->cleanupTempFiles();
        }

        $uploadedFiles = $request->getUploadedFiles();
        $body = $request->getParsedBody();

        $file = $uploadedFiles['file'] ?? null;
        // Guard the optional prompt like the text endpoint: a multipart prompt[]=x would otherwise be
        // an array → TypeError (strict_types) → noisy 500. Coerce to a capped string or null.
        $rawPrompt = $body['prompt'] ?? null;
        $additionalPrompt = is_string($rawPrompt) ? substr($rawPrompt, 0, 50000) : null;

        if (!$file || $file->getError() !== UPLOAD_ERR_OK) {
            $errorMessage = 'File upload failed or no file provided';
            if ($file && $file->getError() === UPLOAD_ERR_INI_SIZE) {
                $errorMessage = 'File exceeds maximum upload size';
            }
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => $errorMessage,
            ], 400);
        }

        // Validate file size before processing
        $maxFileSize = $this->uploadSettings['maxFileSize'];
        $fileSize = $file->getSize();
        if ($fileSize === false || $fileSize === null || $fileSize > $maxFileSize) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'File too large. Maximum size is ' . round($maxFileSize / 1024 / 1024, 1) . 'MB',
                'maxSize' => $maxFileSize,
                'actualSize' => $fileSize,
            ], 400);
        }

        // Create a secure temp file with restrictive permissions BEFORE writing
        $tempDir = sys_get_temp_dir();
        $clientFilename = $file->getClientFilename() ?? 'upload';
        $safeFilename = preg_replace('/[^a-zA-Z0-9._-]/', '_', basename($clientFilename));
        $tempPath = $tempDir . '/' . bin2hex(random_bytes(16)) . '_' . $safeFilename;

        // Move the uploaded file into place, THEN restrict permissions: moveTo()
        // (move_uploaded_file/rename) replaces the destination inode, so a chmod
        // applied before the move is discarded.
        $file->moveTo($tempPath);
        chmod($tempPath, 0600);

        // Validate file type using server-side detection (not client-supplied header)
        $allowedTypes = $this->uploadSettings['allowedTypes'];
        $mimeType = null;
        if (function_exists('finfo_open')) {
            $finfo = finfo_open(FILEINFO_MIME_TYPE);
            if ($finfo !== false) {
                $mimeType = finfo_file($finfo, $tempPath);
                finfo_close($finfo);
            }
        }
        if (!$mimeType) {
            $mimeType = mime_content_type($tempPath) ?: 'application/octet-stream';
        }
        if (!in_array($mimeType, $allowedTypes, true)) {
            @unlink($tempPath);
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Unsupported file type: ' . $mimeType,
                'allowed' => $allowedTypes,
            ], 400);
        }

        try {
            // Convert document to images
            $images = $this->documentConverter->convertToImages($tempPath, $mimeType);

            // Generate form from images
            $result = $this->aiService->generateFormFromImages($images, $additionalPrompt);

            return $this->jsonResponse($response, [
                'success' => true,
                'data' => $result,
                'pagesProcessed' => count($images),
            ]);
        } catch (\Throwable $e) {
            $this->logger->error('AI file generation error', ['exception' => $e->getMessage()]);
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'An unexpected error occurred',
            ], 500);
        } finally {
            // Clean up temp file
            if (file_exists($tempPath)) {
                unlink($tempPath);
            }
        }
    }

    /**
     * Generate script from prompt
     * POST /api/ai/generate-script
     *
     * Body: { "prompt": "Reject if age < 18...", "fields": [...] }
     */
    public function generateScript(Request $request, Response $response): Response
    {
        if (($refused = $this->meterGeneration($request, $response)) !== null) {
            return $refused;
        }
        $body = $request->getParsedBody();
        $prompt = $body['prompt'] ?? '';
        $fields = $body['fields'] ?? [];
        // Optional field-grounded starter script the client passes as a reference.
        $example = is_string($body['example'] ?? null) ? substr($body['example'], 0, 20000) : '';

        if (empty($prompt)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Prompt is required',
            ], 400);
        }

        if (empty($fields)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Form fields are required for script generation',
            ], 400);
        }

        if (!is_string($prompt) || strlen($prompt) > 50000) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Prompt must be text no longer than 50000 characters'], 400);
        }
        if (!$this->isValidFieldsArray($fields)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Each field must be an object with id, label and type'], 400);
        }

        try {
            $result = $this->aiService->generateScript($prompt, $fields, $example);

            return $this->jsonResponse($response, [
                'success' => true,
                'data' => $result,
            ]);
        } catch (\Throwable $e) {
            $this->logger->error('AI script generation error', ['exception' => $e->getMessage()]);
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'An unexpected error occurred',
            ], 500);
        }
    }

    /**
     * Improve existing script based on prompt
     * POST /api/ai/improve-script
     *
     * Body: { "script": "current script...", "prompt": "Add validation for...", "fields": [...] }
     */
    public function improveScript(Request $request, Response $response): Response
    {
        if (($refused = $this->meterGeneration($request, $response)) !== null) {
            return $refused;
        }
        $body = $request->getParsedBody();
        $currentScript = $body['script'] ?? '';
        $prompt = $body['prompt'] ?? '';
        $fields = $body['fields'] ?? [];

        if (empty($prompt)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Prompt is required',
            ], 400);
        }

        if (empty($fields)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Form fields are required',
            ], 400);
        }

        if (!is_string($prompt) || strlen($prompt) > 50000) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Prompt must be text no longer than 50000 characters'], 400);
        }
        if (!is_string($currentScript) || strlen($currentScript) > 120000) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Script is too long'], 400);
        }
        if (!$this->isValidFieldsArray($fields)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Each field must be an object with id, label and type'], 400);
        }

        try {
            $result = $this->aiService->improveScript($currentScript, $prompt, $fields);

            return $this->jsonResponse($response, [
                'success' => true,
                'data' => $result,
            ]);
        } catch (\Throwable $e) {
            $this->logger->error('AI script improvement error', ['exception' => $e->getMessage()]);
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'An unexpected error occurred',
            ], 500);
        }
    }

    /**
     * Each fields entry must be an object with id/label/type — guards the AI
     * service against a TypeError on type-confused input (e.g. ["x"]).
     */
    private function isValidFieldsArray(mixed $fields): bool
    {
        if (!is_array($fields)) {
            return false;
        }
        foreach ($fields as $f) {
            if (!is_array($f) || !isset($f['id'], $f['label'], $f['type'])) {
                return false;
            }
        }
        return true;
    }

    // ── Hosted Site AI chat + per-user AI preferences (plan Phase 2) ───────────

    /**
     * POST /api/ai/chat {messages, stream?} — hosted chat over the env-configured upstream.
     * Authed by session JWT OR a scoped flk_ key (plan §5.6 — the desktop flow runner calls
     * this route, metered to the account owner); allowance-checked (one message = one
     * ai_messages unit) and metered into usage_meter (message count + tokens). stream=true
     * takes over the connection as SSE (AokieCompanionRelayController pattern: no
     * buffering/gzip, X-Accel-Buffering: no, heartbeat comments, clean end marker);
     * validation/allowance failures answer with ordinary JSON BEFORE any stream starts.
     */
    public function chat(Request $request, Response $response): Response
    {
        $sessionUserId = $request->getAttribute('userId');
        $userId = $sessionUserId;
        if (!$userId) {
            // No session: the desktop flow runner authenticates with its flk_ key instead
            // (plan §5.6 — the owner is metered for their runner's hosted calls).
            [$userId, $authError] = $this->flkUser($request, $response);
            if ($authError !== null) {
                return $authError;
            }
        }
        $body = $request->getParsedBody() ?? [];
        if (!is_array($body)) {
            $body = [];
        }
        $messages = $body['messages'] ?? null;
        if (!is_array($messages)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'messages is required'], 400);
        }
        $stream = ($body['stream'] ?? false) === true;
        $tools = ($body['tools'] ?? false) === true;

        // Validate up front: after SSE headers go out, status codes are no longer possible.
        try {
            $messages = AIService::validateChatMessages($messages);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }

        // Hosted tool loop (plan Phase 6 §5.4): tools run server-side AS THE SESSION USER,
        // so all three refusals answer BEFORE the allowance charges a unit.
        if ($tools) {
            if ($sessionUserId === null) {
                // flk_-authed callers (the desktop) run their OWN tool loop against
                // /api/ai/chat-tools/execute — the hosted loop is a browser-session surface.
                return $this->jsonError($response, 'Chat tools require a signed-in session — flk_-authenticated callers run their own tool loop.', 400, 'tools_unsupported');
            }
            if ($this->isDemoRequest($request)) {
                return $this->jsonError($response, 'Tool actions are disabled in the shared demo.', 403, 'demo_readonly');
            }
            if ($this->chatTools === null) {
                return $this->jsonError($response, 'Chat tools are not available on this server.', 503);
            }
        }

        // Refuse before charging an allowance unit for a request that can never run.
        if (!$this->aiService->isEnabled() || !$this->aiService->isConfigured()) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'AI service is not configured. Set AI_BASE_URL (and AI_API_KEY if your provider requires one).'], 503);
        }

        // Allowance gate: one hosted message = one unit — including a tool turn, no matter
        // how many internal rounds the loop runs. A started request consumes it even on
        // failure (same honesty rule as the cloud credit lifecycle); usage is always
        // recorded, and the check is a no-op when plan enforcement is off.
        if ($this->planService !== null) {
            try {
                $this->planService->checkAndIncrement((string) $userId, 'ai_messages', 1);
            } catch (\RuntimeException $e) {
                return $this->allowanceRefusal($response, $e->getMessage());
            }
        }

        if ($tools) {
            $ip = $this->clientIp($request);
            if ($stream) {
                $this->emitChatToolsStream((string) $userId, $messages, $ip);
            }
            try {
                $result = $this->runChatToolLoop((string) $userId, $messages, null, $ip);
            } catch (\Throwable $e) {
                $this->logger->error('AI chat tool loop error', ['exception' => $e->getMessage()]);
                return $this->jsonResponse($response, ['error' => true, 'message' => 'The AI request failed'], 502);
            }
            $this->recordChatTokens((string) $userId, $result['usage']);
            return $this->jsonResponse($response, ['data' => ['content' => $result['content'], 'usage' => $result['usage']]]);
        }

        if ($stream) {
            $this->emitChatStream((string) $userId, $messages);
        }

        try {
            $result = $this->aiService->chat($messages, false);
        } catch (\Throwable $e) {
            $this->logger->error('AI chat error', ['exception' => $e->getMessage()]);
            return $this->jsonResponse($response, ['error' => true, 'message' => 'The AI request failed'], 502);
        }
        $this->recordChatTokens((string) $userId, $result['usage'] ?? []);
        return $this->jsonResponse($response, ['data' => ['content' => $result['content'], 'usage' => $result['usage']]]);
    }

    /**
     * GET /api/ai/preferences — the session user's AI source settings (defaults when never
     * saved), plus the current month's hosted-AI usage ({used, limit}; limit null = unlimited).
     * The `data` envelope is what both consumers (web settings card, desktop runner) parse.
     */
    public function getPreferences(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $data = $this->preferencesFor((string) $userId);
        if ($this->planService !== null) {
            $meter = $this->planService->usageMeter((string) $userId);
            $allowance = $this->planService->allowance($this->planService->planFor((string) $userId), 'ai_messages');
            $data['usage'] = [
                'used' => (int) ($meter['metrics']['ai_messages']['count'] ?? 0),
                'limit' => $allowance['monthlyValue'] >= 0 ? $allowance['monthlyValue'] : null,
            ];
        }
        return $this->jsonResponse($response, ['data' => $data]);
    }

    /** PUT /api/ai/preferences — full-replace the session user's AI source settings. */
    public function putPreferences(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        if ($this->userAiSettings === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'AI preferences are not available'], 503);
        }
        $body = $request->getParsedBody() ?? [];
        if (!is_array($body)) {
            $body = [];
        }
        try {
            $prefs = $this->userAiSettings->put((string) $userId, $body);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
        return $this->jsonResponse($response, ['data' => $prefs]);
    }

    /**
     * GET /api/v1/ai/preferences — flk_ key surface for the desktop flow runner: the ACCOUNT
     * OWNER's settings (the key's owner), same shape as the session GET. Scope: ai:relay,
     * with legacy connector:relay keys grandfathered (plan §7) — checked here per request
     * because ApiKeyMiddleware's required-scope list is AND-ed and these routes accept EITHER.
     */
    public function preferencesV1(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $scopes = $request->getAttribute('apiKeyScopes');
        $scopes = is_array($scopes) ? $scopes : [];
        if (!in_array('ai:relay', $scopes, true) && !in_array('connector:relay', $scopes, true)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'insufficient_scope',
                'message' => 'Insufficient scope. Required: ai:relay — relink FormLogic Desktop to grant it.',
            ], 403);
        }
        return $this->jsonResponse($response, ['data' => $this->preferencesFor((string) $userId)]);
    }

    /**
     * Encode one streamed content delta as an SSE event.
     *
     * @internal Public only so the SSE wire format has a deterministic regression test.
     */
    public static function sseChatDelta(string $delta): string
    {
        return 'event: delta' . "\n"
            . 'data: ' . json_encode(['content' => $delta], JSON_UNESCAPED_SLASHES) . "\n\n";
    }

    /**
     * Encode the terminal usage summary as an SSE event.
     *
     * @internal Public only so the SSE wire format has a deterministic regression test.
     */
    public static function sseChatDone(array $usage): string
    {
        return 'event: done' . "\n"
            . 'data: ' . json_encode(['usage' => $usage], JSON_UNESCAPED_SLASHES) . "\n\n";
    }

    /**
     * Encode a mid-stream failure as an SSE event (headers are already out, so an upstream
     * error after streaming began can only be signalled in-band).
     *
     * @internal Public only so the SSE wire format has a deterministic regression test.
     */
    public static function sseChatError(string $message): string
    {
        return 'event: error' . "\n"
            . 'data: ' . json_encode(['message' => $message], JSON_UNESCAPED_SLASHES) . "\n\n";
    }

    // ── Hosted tool loop (plan Phase 6 §5.4) ───────────────────────────────────

    /**
     * Encode a "tool starting" activity marker as a data-only SSE event (no `event:` line —
     * the browser parser dispatches on the payload's `type`, between content deltas).
     *
     * @internal Public only so the SSE wire format has a deterministic regression test.
     */
    public static function sseToolCall(string $id, string $name): string
    {
        return 'data: ' . json_encode(['type' => 'tool_call', 'id' => $id, 'name' => $name, 'status' => 'running'], JSON_UNESCAPED_SLASHES) . "\n\n";
    }

    /**
     * Encode a finished tool execution (status done, result verbatim) as a data-only SSE event.
     *
     * @internal Public only so the SSE wire format has a deterministic regression test.
     */
    public static function sseToolResult(string $id, string $name, mixed $result): string
    {
        $payload = json_encode(['type' => 'tool_result', 'id' => $id, 'name' => $name, 'status' => 'done', 'result' => $result], JSON_UNESCAPED_SLASHES);
        if ($payload === false) {
            $payload = (string) json_encode(['type' => 'tool_result', 'id' => $id, 'name' => $name, 'status' => 'done', 'result' => null]);
        }
        return 'data: ' . $payload . "\n\n";
    }

    /**
     * Encode a failed tool execution as a data-only SSE event.
     *
     * @internal Public only so the SSE wire format has a deterministic regression test.
     */
    public static function sseToolFailure(string $id, string $name, string $error): string
    {
        return 'data: ' . json_encode(['type' => 'tool_result', 'id' => $id, 'name' => $name, 'status' => 'failed', 'error' => $error], JSON_UNESCAPED_SLASHES) . "\n\n";
    }

    /**
     * The bounded agentic loop over the v1 chat tool subset (plan Phase 6 §5.4): up to
     * CHAT_TOOL_MAX_ROUNDS upstream model rounds; each round may request tool calls, which
     * execute server-side AS $userId (account-wide, subset-restricted, audited) and feed
     * back as role:"tool" messages. $emit (when streaming) receives fully-encoded SSE
     * frames for tool activity (sseToolCall / sseToolResult / sseToolFailure).
     *
     * V1 streaming model (per the plan's "simplest honest implementation" allowance): every
     * round — including the final one — is a NON-streaming upstream call; the caller emits
     * the final round's text as one SSE delta after the loop. If the round cap is hit while
     * the model still wants tools, the pending calls are NOT executed and the loop returns
     * whatever text the last round produced (or an honest note).
     *
     * @param callable(string):void|null $emit
     * @return array{content: string, usage: array{promptTokens:int, completionTokens:int, totalTokens:int}}
     * @internal Public only so the loop's wire behavior (frames, rounds cap) has deterministic tests.
     */
    public function runChatToolLoop(string $userId, array $messages, ?callable $emit = null, ?string $ip = null): array
    {
        if ($this->chatTools === null) {
            throw new \RuntimeException('Chat tools are not available on this server.');
        }
        $catalog = \FormLogic\Services\ChatToolsService::chatCatalog();
        $ctx = $this->chatToolsContext($userId, $ip);
        $usage = ['promptTokens' => 0, 'completionTokens' => 0, 'totalTokens' => 0];
        $convo = $messages;
        $content = '';
        for ($round = 1; $round <= self::CHAT_TOOL_MAX_ROUNDS; $round++) {
            $res = $this->aiService->chatToolsRound($convo, $catalog);
            foreach (['promptTokens', 'completionTokens', 'totalTokens'] as $k) {
                $usage[$k] += (int) ($res['usage'][$k] ?? 0);
            }
            $content = (string) ($res['content'] ?? '');
            $calls = is_array($res['toolCalls'] ?? null) ? $res['toolCalls'] : [];
            if ($calls === []) {
                return ['content' => $content, 'usage' => $usage];
            }
            if ($round === self::CHAT_TOOL_MAX_ROUNDS) {
                break; // cap reached with tools still pending: don't execute, answer honestly
            }
            // Feed the assistant's tool request back verbatim, then one role:"tool" reply per call.
            $convo[] = [
                'role' => 'assistant',
                'content' => $content !== '' ? $content : null,
                'tool_calls' => array_map(static fn (array $c) => [
                    'id' => $c['id'],
                    'type' => 'function',
                    'function' => ['name' => $c['name'], 'arguments' => $c['argumentsRaw']],
                ], $calls),
            ];
            foreach ($calls as $call) {
                if ($emit !== null) {
                    $emit(self::sseToolCall($call['id'], $call['name']));
                }
                try {
                    if (!is_array($call['arguments'])) {
                        throw new \Exception('The tool call arguments were not valid JSON');
                    }
                    $result = $this->chatTools->callChatTool($call['name'], $call['arguments'], $ctx);
                    if ($emit !== null) {
                        $emit(self::sseToolResult($call['id'], $call['name'], $result));
                    }
                    $feedback = $this->encodeToolFeedback($result);
                } catch (\Exception $e) {
                    // Denials + validation failures carry deliberately user-safe messages
                    // (the ChatToolsService convention) — honest to surface and feed back.
                    if ($emit !== null) {
                        $emit(self::sseToolFailure($call['id'], $call['name'], $e->getMessage()));
                    }
                    $feedback = json_encode(['error' => $e->getMessage()], JSON_UNESCAPED_SLASHES) ?: '{"error":"tool failed"}';
                } catch (\Throwable $e) {
                    // Anything else was never crafted to be user-facing — log, don't echo.
                    $this->logger->error('Chat tool execution failed unexpectedly', ['tool' => $call['name'], 'error' => $e->getMessage()]);
                    if ($emit !== null) {
                        $emit(self::sseToolFailure($call['id'], $call['name'], 'The tool failed unexpectedly.'));
                    }
                    $feedback = '{"error":"The tool failed unexpectedly."}';
                }
                $convo[] = ['role' => 'tool', 'tool_call_id' => $call['id'], 'content' => $feedback];
            }
        }
        if ($content === '') {
            $content = 'I reached the tool-use limit for this turn before finishing — the actions shown above are what completed.';
        }
        return ['content' => $content, 'usage' => $usage];
    }

    /** Chat-surface execution context: account-wide as $userId, audited under 'chat.<action>'. */
    private function chatToolsContext(string $userId, ?string $ip): \FormLogic\Services\ChatToolsContext
    {
        return new \FormLogic\Services\ChatToolsContext(
            userId: $userId,
            audit: function (string $action, array $details) use ($userId, $ip): void {
                $this->auditService?->log('chat.' . $action, 'chat-tools', $details['appId'] ?? $details['formId'] ?? null, $userId, $ip, $details);
            },
            ip: $ip,
            userAgent: 'chat',
            source: 'chat',
        );
    }

    /** A tool result as role:"tool" content, bounded so one big read can't flood the context. */
    private function encodeToolFeedback(mixed $result): string
    {
        $json = json_encode($result, JSON_UNESCAPED_SLASHES);
        if ($json === false) {
            return '{"error":"The tool result could not be encoded"}';
        }
        if (strlen($json) > self::CHAT_TOOL_RESULT_MAX_CHARS) {
            return json_encode([
                'truncated' => true,
                'note' => 'The full result was too large for the chat context — ask for a narrower query (e.g. a lower limit).',
                'preview' => mb_substr($json, 0, 4000),
            ], JSON_UNESCAPED_SLASHES) ?: '{"truncated":true}';
        }
        return $json;
    }

    private function clientIp(Request $request): ?string
    {
        $sp = $request->getServerParams();
        return is_string($sp['REMOTE_ADDR'] ?? null) ? $sp['REMOTE_ADDR'] : null;
    }

    /**
     * Raw SSE loop for a streamed TOOL turn (same boilerplate as emitChatStream): tool
     * activity frames stream as the loop executes; the final round's text goes out as ONE
     * delta (v1 — see runChatToolLoop's docblock), then the done/end frames.
     */
    private function emitChatToolsStream(string $userId, array $messages, ?string $ip): never
    {
        set_time_limit(600); // up to CHAT_TOOL_MAX_ROUNDS sequential upstream calls
        ignore_user_abort(false);
        header('Content-Type: text/event-stream; charset=utf-8');
        header('Cache-Control: no-store');
        header('X-Accel-Buffering: no');
        // Raw takeover bypasses CorsMiddleware — re-emit the allowlisted headers, or a
        // cross-origin (api.<host>) fetch reader is blocked despite a passing preflight.
        \FormLogic\Middleware\CorsMiddleware::active()?->emitRawSseHeaders();
        // Defeat server-side buffering/compression: gzip would buffer events.
        if (function_exists('apache_setenv')) {
            @apache_setenv('no-gzip', '1');
        }
        @ini_set('zlib.output_compression', '0');
        while (ob_get_level() > 0) {
            @ob_end_flush();
        }
        echo 'retry: 2000' . "\n\n";
        echo ': connected' . "\n\n";
        flush();

        $usage = ['promptTokens' => 0, 'completionTokens' => 0, 'totalTokens' => 0];
        try {
            $result = $this->runChatToolLoop($userId, $messages, static function (string $frame): void {
                echo $frame;
                flush();
            }, $ip);
            $usage = $result['usage'];
            if ($result['content'] !== '') {
                echo self::sseChatDelta($result['content']);
            }
            echo self::sseChatDone($usage);
        } catch (\Throwable $e) {
            $this->logger->error('AI chat tool stream error', ['exception' => $e->getMessage()]);
            echo self::sseChatError('The AI request failed');
        }
        $this->recordChatTokens($userId, $usage);
        echo 'event: end' . "\n" . 'data: {}' . "\n\n";
        flush();
        exit;
    }

    private function preferencesFor(string $userId): array
    {
        return $this->userAiSettings !== null
            ? $this->userAiSettings->get($userId)
            : \FormLogic\Services\UserAiSettingsService::DEFAULTS + ['updatedAt' => null];
    }

    /**
     * Desktop-surface auth for POST /api/ai/chat (plan §5.6): when no session authenticated
     * the request, accept a valid flk_ key carrying ai:relay — or the grandfathered
     * connector:relay (plan §7, same either-scope rule as the relay surfaces) — and meter
     * the call to the ACCOUNT OWNER (the key's owner).
     *
     * @return array{0:?string, 1:?Response} [ownerUserId, errorResponse]
     */
    private function flkUser(Request $request, Response $response): array
    {
        if ($this->apiKeyService !== null
            && preg_match('/^Bearer\s+(flk_[a-f0-9]{40})$/i', $request->getHeaderLine('Authorization'), $m)
        ) {
            $keyData = $this->apiKeyService->validateKey($m[1]);
            if ($keyData === null) {
                return [null, $this->jsonResponse($response, ['error' => true, 'message' => 'Invalid, expired, or revoked API key'], 401)];
            }
            $scopes = is_array($keyData['scopes'] ?? null) ? $keyData['scopes'] : [];
            if (!in_array('ai:relay', $scopes, true) && !in_array('connector:relay', $scopes, true)) {
                return [null, $this->jsonResponse($response, [
                    'error' => true,
                    'code' => 'insufficient_scope',
                    'message' => 'Insufficient scope. Required: ai:relay — relink FormLogic Desktop to grant it.',
                ], 403)];
            }
            return [(string) $keyData['userId'], null];
        }
        return [null, $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401)];
    }

    private function allowanceRefusal(Response $response, string $code): Response
    {
        return $this->jsonResponse($response, [
            'error' => true,
            'code' => $code,
            'message' => 'You have used this month\'s hosted AI allowance — switch Settings → AI to your desktop provider, or wait for the new month.',
        ], 402);
    }

    /** Token usage arrives only after the upstream answers; meter it post-hoc (never gated). */
    private function recordChatTokens(string $userId, array $usage): void
    {
        if ($this->planService === null) {
            return;
        }
        $in = (int) ($usage['promptTokens'] ?? 0);
        $out = (int) ($usage['completionTokens'] ?? 0);
        if ($in > 0 || $out > 0) {
            $this->planService->recordUsage($userId, 'ai_messages', 0, $in, $out);
        }
    }

    /**
     * Raw SSE loop for streamed chat (the AokieCompanionRelayController pattern): deltas
     * echo as they arrive from the upstream, heartbeat comments ride the service's
     * quiet-upstream hook, a done frame carries the final usage, and an error frame is the
     * only honest signal once headers are out. Bypasses the Slim emitter and exits.
     */
    private function emitChatStream(string $userId, array $messages): never
    {
        set_time_limit(240); // outlives the service's 180s stream timeout
        ignore_user_abort(false);
        header('Content-Type: text/event-stream; charset=utf-8');
        header('Cache-Control: no-store');
        header('X-Accel-Buffering: no');
        // Raw takeover bypasses CorsMiddleware — re-emit the allowlisted headers (see
        // emitChatToolsStream).
        \FormLogic\Middleware\CorsMiddleware::active()?->emitRawSseHeaders();
        // Defeat server-side buffering/compression: gzip would buffer events.
        if (function_exists('apache_setenv')) {
            @apache_setenv('no-gzip', '1');
        }
        @ini_set('zlib.output_compression', '0');
        while (ob_get_level() > 0) {
            @ob_end_flush();
        }
        echo 'retry: 2000' . "\n\n";
        echo ': connected' . "\n\n";
        flush();

        $usage = ['promptTokens' => 0, 'completionTokens' => 0, 'totalTokens' => 0];
        try {
            $result = $this->aiService->chat(
                $messages,
                true,
                static function (string $delta): void {
                    echo self::sseChatDelta($delta);
                    flush();
                },
                static function (): void {
                    echo ': keepalive' . "\n\n";
                    flush();
                }
            );
            $usage = is_array($result['usage'] ?? null) ? $result['usage'] : $usage;
            echo self::sseChatDone($usage);
        } catch (\Throwable $e) {
            $this->logger->error('AI chat stream error', ['exception' => $e->getMessage()]);
            echo self::sseChatError('The AI request failed');
        }
        $this->recordChatTokens($userId, $usage);
        echo 'event: end' . "\n" . 'data: {}' . "\n\n";
        flush();
        exit;
    }
}
