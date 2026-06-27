<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\AIService;
use FormLogic\Services\DocumentConverter;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

class AIController
{
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
                : 'AI service is not configured. Set OPENAI_API_KEY in environment.',
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

        try {
            $result = $this->aiService->generateFormFromPrompt($prompt);

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
     * Generate form from uploaded document or image
     * POST /api/ai/generate-form-from-file
     *
     * Multipart form: file (required), prompt (optional additional instructions)
     */
    public function generateFormFromFile(Request $request, Response $response): Response
    {
        $uploadedFiles = $request->getUploadedFiles();
        $body = $request->getParsedBody();

        $file = $uploadedFiles['file'] ?? null;
        $additionalPrompt = $body['prompt'] ?? null;

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
     * Generate form from base64 images
     * POST /api/ai/generate-form-from-images
     *
     * Body: { "images": ["base64...", "base64..."], "prompt": "optional" }
     */
    public function generateFormFromImages(Request $request, Response $response): Response
    {
        $body = $request->getParsedBody();
        $images = $body['images'] ?? [];
        $additionalPrompt = $body['prompt'] ?? null;

        if (empty($images) || !is_array($images)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'At least one image is required',
            ], 400);
        }

        // Limit number of images
        if (count($images) > 10) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Maximum 10 images allowed',
            ], 400);
        }

        // Each image must be a string (avoids a TypeError in the service) and is
        // size-capped (~11MB of base64) to bound token cost.
        foreach ($images as $img) {
            if (!is_string($img)) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Each image must be a base64 string'], 400);
            }
            if (strlen($img) > 15000000) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'An image exceeds the maximum size'], 400);
            }
        }

        try {
            $result = $this->aiService->generateFormFromImages($images, $additionalPrompt);

            return $this->jsonResponse($response, [
                'success' => true,
                'data' => $result,
            ]);
        } catch (\Throwable $e) {
            $this->logger->error('AI image generation error', ['exception' => $e->getMessage()]);
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'An unexpected error occurred',
            ], 500);
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
            $result = $this->aiService->generateScript($prompt, $fields);

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
}
