<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\FileStorageService;
use FormLogic\Services\FormService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class FileController
{
    private FileStorageService $fileStorage;
    private FormService $formService;

    public function __construct(FileStorageService $fileStorage, FormService $formService)
    {
        $this->fileStorage = $fileStorage;
        $this->formService = $formService;
    }

    /**
     * Upload a file for a form (standalone form context).
     * POST /api/forms/{formId}/upload
     *
     * No auth required because standalone forms can be public.
     * Validates that the form exists and is published.
     */
    public function upload(Request $request, Response $response, array $args): Response
    {
        $formId = $args['formId'];

        $form = $this->formService->getForm($formId);
        if (!$form) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found'], 404);
        }

        if ($form['status'] !== 'published') {
            // Allow upload if the user is the form owner (authenticated)
            $userId = $request->getAttribute('userId');
            if (!$userId || $form['userId'] !== $userId) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Form is not accepting uploads'], 403);
            }
        }

        // Get uploaded file from $_FILES
        $uploadedFiles = $request->getUploadedFiles();
        $file = $uploadedFiles['file'] ?? null;

        // Fall back to raw $_FILES if PSR-7 didn't parse it
        if (!$file && !empty($_FILES['file'])) {
            $rawFile = $_FILES['file'];
        } elseif ($file) {
            // Convert PSR-7 UploadedFile to the array format FileStorageService expects
            $rawFile = [
                'tmp_name' => $file->getStream()->getMetadata('uri'),
                'name' => $file->getClientFilename(),
                'size' => $file->getSize(),
                'type' => $file->getClientMediaType(),
                'error' => $file->getError(),
            ];
        } else {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'No file uploaded'], 400);
        }

        try {
            $metadata = $this->fileStorage->storeFile($formId, $rawFile);
            return $this->jsonResponse($response, $metadata, 201);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    /**
     * Upload a file for an app form context.
     * POST /api/app/{slug}/forms/{formId}/upload
     *
     * Requires authentication (handled by app auth middleware).
     */
    public function appUpload(Request $request, Response $response, array $args): Response
    {
        $formId = $args['formId'];

        // The form ID is validated by the app route group already
        // Just need to handle the file upload

        $uploadedFiles = $request->getUploadedFiles();
        $file = $uploadedFiles['file'] ?? null;

        if (!$file && !empty($_FILES['file'])) {
            $rawFile = $_FILES['file'];
        } elseif ($file) {
            $rawFile = [
                'tmp_name' => $file->getStream()->getMetadata('uri'),
                'name' => $file->getClientFilename(),
                'size' => $file->getSize(),
                'type' => $file->getClientMediaType(),
                'error' => $file->getError(),
            ];
        } else {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'No file uploaded'], 400);
        }

        try {
            $metadata = $this->fileStorage->storeFile($formId, $rawFile);
            return $this->jsonResponse($response, $metadata, 201);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    /**
     * Serve a stored file.
     * GET /api/files/{formId}/{fileId}/{filename}
     *
     * Public endpoint - files are keyed by UUID so not guessable.
     */
    public function serve(Request $request, Response $response, array $args): Response
    {
        $formId = $args['formId'];
        $fileId = $args['fileId'];

        $filePath = $this->fileStorage->getFilePath($formId, $fileId);
        if (!$filePath || !file_exists($filePath)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'File not found'], 404);
        }

        $mimeType = $this->fileStorage->getMimeType($filePath);
        $fileSize = filesize($filePath);

        // Determine filename for Content-Disposition
        $filename = $args['filename'] ?? basename($filePath);

        $stream = fopen($filePath, 'rb');
        $body = new \Slim\Psr7\Stream($stream);

        return $response
            ->withHeader('Content-Type', $mimeType)
            ->withHeader('Content-Length', (string) $fileSize)
            ->withHeader('Content-Disposition', 'inline; filename="' . addslashes($filename) . '"')
            ->withHeader('Cache-Control', 'public, max-age=31536000, immutable')
            ->withBody($body);
    }

    private function jsonResponse(Response $response, array $data, int $status = 200): Response
    {
        $response->getBody()->write(json_encode($data));
        return $response
            ->withHeader('Content-Type', 'application/json')
            ->withStatus($status);
    }
}
