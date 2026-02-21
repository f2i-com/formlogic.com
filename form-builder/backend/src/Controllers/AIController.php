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

        $response->getBody()->write(json_encode([
            'available' => $isConfigured,
            'message' => $isConfigured
                ? 'AI service is configured and ready'
                : 'AI service is not configured. Set OPENAI_API_KEY in environment.',
        ]));

        return $response->withHeader('Content-Type', 'application/json');
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
            $response->getBody()->write(json_encode([
                'error' => 'Prompt is required',
            ]));
            return $response->withStatus(400)->withHeader('Content-Type', 'application/json');
        }

        try {
            $result = $this->aiService->generateFormFromPrompt($prompt);

            $response->getBody()->write(json_encode([
                'success' => true,
                'data' => $result,
            ]));
            return $response->withHeader('Content-Type', 'application/json');
        } catch (\Exception $e) {
            $this->logger->error('AI form generation error', ['exception' => $e->getMessage()]);
            $response->getBody()->write(json_encode([
                'error' => 'An unexpected error occurred',
            ]));
            return $response->withStatus(500)->withHeader('Content-Type', 'application/json');
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
            $response->getBody()->write(json_encode([
                'error' => $errorMessage,
            ]));
            return $response->withStatus(400)->withHeader('Content-Type', 'application/json');
        }

        // Validate file size before processing
        $maxFileSize = $this->uploadSettings['maxFileSize'];
        $fileSize = $file->getSize();
        if ($fileSize > $maxFileSize) {
            $response->getBody()->write(json_encode([
                'error' => 'File too large. Maximum size is ' . round($maxFileSize / 1024 / 1024, 1) . 'MB',
                'maxSize' => $maxFileSize,
                'actualSize' => $fileSize,
            ]));
            return $response->withStatus(400)->withHeader('Content-Type', 'application/json');
        }

        // Create a secure temp file with restrictive permissions BEFORE writing
        $tempDir = sys_get_temp_dir();
        $safeFilename = preg_replace('/[^a-zA-Z0-9._-]/', '_', basename($file->getClientFilename()));
        $tempPath = $tempDir . '/' . bin2hex(random_bytes(16)) . '_' . $safeFilename;

        // Create an empty file with restrictive permissions first
        touch($tempPath);
        chmod($tempPath, 0600);

        // Move the uploaded file to our prepared location
        $file->moveTo($tempPath);

        // Validate file type using server-side detection (not client-supplied header)
        $allowedTypes = $this->uploadSettings['allowedTypes'];
        $mimeType = function_exists('finfo_file')
            ? finfo_file(finfo_open(FILEINFO_MIME_TYPE), $tempPath)
            : mime_content_type($tempPath);
        if (!in_array($mimeType, $allowedTypes, true)) {
            @unlink($tempPath);
            $response->getBody()->write(json_encode([
                'error' => 'Unsupported file type: ' . $mimeType,
                'allowed' => $allowedTypes,
            ]));
            return $response->withStatus(400)->withHeader('Content-Type', 'application/json');
        }

        try {
            // Convert document to images
            $images = $this->documentConverter->convertToImages($tempPath, $mimeType);

            // Generate form from images
            $result = $this->aiService->generateFormFromImages($images, $additionalPrompt);

            $response->getBody()->write(json_encode([
                'success' => true,
                'data' => $result,
                'pagesProcessed' => count($images),
            ]));
            return $response->withHeader('Content-Type', 'application/json');
        } catch (\Exception $e) {
            $this->logger->error('AI file generation error', ['exception' => $e->getMessage()]);
            $response->getBody()->write(json_encode([
                'error' => 'An unexpected error occurred',
            ]));
            return $response->withStatus(500)->withHeader('Content-Type', 'application/json');
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
            $response->getBody()->write(json_encode([
                'error' => 'At least one image is required',
            ]));
            return $response->withStatus(400)->withHeader('Content-Type', 'application/json');
        }

        // Limit number of images
        if (count($images) > 10) {
            $response->getBody()->write(json_encode([
                'error' => 'Maximum 10 images allowed',
            ]));
            return $response->withStatus(400)->withHeader('Content-Type', 'application/json');
        }

        try {
            $result = $this->aiService->generateFormFromImages($images, $additionalPrompt);

            $response->getBody()->write(json_encode([
                'success' => true,
                'data' => $result,
            ]));
            return $response->withHeader('Content-Type', 'application/json');
        } catch (\Exception $e) {
            $this->logger->error('AI image generation error', ['exception' => $e->getMessage()]);
            $response->getBody()->write(json_encode([
                'error' => 'An unexpected error occurred',
            ]));
            return $response->withStatus(500)->withHeader('Content-Type', 'application/json');
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
            $response->getBody()->write(json_encode([
                'error' => 'Prompt is required',
            ]));
            return $response->withStatus(400)->withHeader('Content-Type', 'application/json');
        }

        if (empty($fields)) {
            $response->getBody()->write(json_encode([
                'error' => 'Form fields are required for script generation',
            ]));
            return $response->withStatus(400)->withHeader('Content-Type', 'application/json');
        }

        try {
            $result = $this->aiService->generateScript($prompt, $fields);

            $response->getBody()->write(json_encode([
                'success' => true,
                'data' => $result,
            ]));
            return $response->withHeader('Content-Type', 'application/json');
        } catch (\Exception $e) {
            $this->logger->error('AI script generation error', ['exception' => $e->getMessage()]);
            $response->getBody()->write(json_encode([
                'error' => 'An unexpected error occurred',
            ]));
            return $response->withStatus(500)->withHeader('Content-Type', 'application/json');
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
            $response->getBody()->write(json_encode([
                'error' => 'Prompt is required',
            ]));
            return $response->withStatus(400)->withHeader('Content-Type', 'application/json');
        }

        if (empty($fields)) {
            $response->getBody()->write(json_encode([
                'error' => 'Form fields are required',
            ]));
            return $response->withStatus(400)->withHeader('Content-Type', 'application/json');
        }

        try {
            $result = $this->aiService->improveScript($currentScript, $prompt, $fields);

            $response->getBody()->write(json_encode([
                'success' => true,
                'data' => $result,
            ]));
            return $response->withHeader('Content-Type', 'application/json');
        } catch (\Exception $e) {
            $this->logger->error('AI script improvement error', ['exception' => $e->getMessage()]);
            $response->getBody()->write(json_encode([
                'error' => 'An unexpected error occurred',
            ]));
            return $response->withStatus(500)->withHeader('Content-Type', 'application/json');
        }
    }
}
