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

    public function __construct(AIService $aiService, DocumentConverter $documentConverter, array $uploadSettings = [], ?LoggerInterface $logger = null)
    {
        $this->aiService = $aiService;
        $this->documentConverter = $documentConverter;
        $this->logger = $logger ?? new NullLogger();
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
        $isConfigured = $this->aiService->isConfigured();

        return $this->jsonResponse($response, [
            'available' => $isConfigured,
            'message' => $isConfigured
                ? 'AI service is configured and ready'
                : 'AI service is not configured. Set AI_BASE_URL to a local/OpenAI-compatible server (LM Studio, Ollama, …) — add AI_API_KEY only if your provider requires one.',
        ]);
    }

    /**
     * Generate form from text prompt
     * POST /api/ai/generate-form
     *
     * Body: { "prompt": "Create a contact form..." }
     */
    public function generateForm(Request $request, Response $response): Response
    {
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
        $body = $request->getParsedBody();
        $prompt = $body['prompt'] ?? '';
        if (empty($prompt) || !is_string($prompt)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Prompt is required'], 400);
        }
        if (strlen($prompt) > 10000) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Prompt must be text no longer than 10000 characters'], 400);
        }
        $maxForms = max(1, min(10, (int) ($body['maxForms'] ?? 6)));

        try {
            $plan = $this->aiService->generateAppPlan($prompt, $maxForms);
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
     * Generate form from uploaded document or image
     * POST /api/ai/generate-form-from-file
     *
     * Multipart form: file (required), prompt (optional additional instructions)
     */
    public function generateFormFromFile(Request $request, Response $response): Response
    {
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
}
