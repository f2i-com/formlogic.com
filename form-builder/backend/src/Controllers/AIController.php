<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\AIService;
use FormLogic\Services\DocumentConverter;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class AIController
{
    private AIService $aiService;
    private DocumentConverter $documentConverter;

    public function __construct(AIService $aiService, DocumentConverter $documentConverter)
    {
        $this->aiService = $aiService;
        $this->documentConverter = $documentConverter;
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
            $response->getBody()->write(json_encode([
                'error' => $e->getMessage(),
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
            $response->getBody()->write(json_encode([
                'error' => 'File upload failed or no file provided',
            ]));
            return $response->withStatus(400)->withHeader('Content-Type', 'application/json');
        }

        // Validate file type
        $allowedTypes = [
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'image/jpeg',
            'image/png',
            'image/gif',
            'image/webp',
        ];

        $mimeType = $file->getClientMediaType();
        if (!in_array($mimeType, $allowedTypes)) {
            $response->getBody()->write(json_encode([
                'error' => 'Unsupported file type: ' . $mimeType,
                'allowed' => $allowedTypes,
            ]));
            return $response->withStatus(400)->withHeader('Content-Type', 'application/json');
        }

        // Save uploaded file temporarily
        $tempPath = sys_get_temp_dir() . '/' . uniqid('upload_') . '_' . $file->getClientFilename();
        $file->moveTo($tempPath);

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
            $response->getBody()->write(json_encode([
                'error' => $e->getMessage(),
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
            $response->getBody()->write(json_encode([
                'error' => $e->getMessage(),
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
            $response->getBody()->write(json_encode([
                'error' => $e->getMessage(),
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
            $response->getBody()->write(json_encode([
                'error' => $e->getMessage(),
            ]));
            return $response->withStatus(500)->withHeader('Content-Type', 'application/json');
        }
    }
}
