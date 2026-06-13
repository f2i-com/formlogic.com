<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\FileStorageService;
use FormLogic\Services\FormService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class FileController
{
    private FileStorageService $fileStorage;
    private FormService $formService;
    private ?AppService $appService;
    private ?AppUserService $appUserService;

    public function __construct(FileStorageService $fileStorage, FormService $formService, ?AppService $appService = null, ?AppUserService $appUserService = null)
    {
        $this->fileStorage = $fileStorage;
        $this->formService = $formService;
        $this->appService = $appService;
        $this->appUserService = $appUserService;
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
        $slug = $args['slug'] ?? '';

        // Verify the user is an active member of the app and the form belongs to it
        $userId = $request->getAttribute('userId');
        if (!$userId || !$this->appService || !$this->appUserService) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $app = $this->appService->getAppBySlug($slug);
        if (!$app || $app['status'] !== 'published') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }

        $appUser = $this->appUserService->getAppUser($app['id'], $userId);
        if (!$appUser || $appUser['status'] !== 'active') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Not a member of this app'], 403);
        }

        // Verify the form belongs to this app
        $appForms = $this->appService->getAppForms($app['id']);
        $formBelongsToApp = false;
        foreach ($appForms as $af) {
            if ($af['formId'] === $formId) {
                $formBelongsToApp = true;
                break;
            }
        }
        if (!$formBelongsToApp) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found in this app'], 404);
        }

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
     * Files for standalone published forms are public (the form itself is public).
     * Files for app-scoped forms (or unpublished forms) are access-controlled:
     * only the form owner or an active member of an app containing the form may
     * fetch them — UUID secrecy alone is not relied upon, and access is revoked
     * when membership is revoked.
     */
    public function serve(Request $request, Response $response, array $args): Response
    {
        $formId = $args['formId'];
        $fileId = $args['fileId'];

        if (!$this->authorizeFileAccess($request, $formId)) {
            // Indistinguishable from a missing file so the endpoint does not
            // confirm the existence of a private form's files to outsiders.
            return $this->jsonResponse($response, ['error' => true, 'message' => 'File not found'], 404);
        }

        $filePath = $this->fileStorage->getFilePath($formId, $fileId);
        if (!$filePath || !file_exists($filePath)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'File not found'], 404);
        }

        $mimeType = $this->fileStorage->getMimeType($filePath);
        $fileSize = filesize($filePath);

        // Always use actual stored filename — ignore user-supplied filename parameter
        $filename = basename($filePath);

        $stream = fopen($filePath, 'rb');
        $body = new \Slim\Psr7\Stream($stream);

        return $response
            ->withHeader('Content-Type', $mimeType)
            ->withHeader('Content-Length', (string) $fileSize)
            ->withHeader('Content-Disposition', 'inline; filename="' . preg_replace('/[\x00-\x1f\x7f"\\\\]/', '_', $filename) . '"')
            // Prevent MIME sniffing of user-uploaded content (stored-XSS hardening)
            ->withHeader('X-Content-Type-Options', 'nosniff')
            ->withHeader('Cache-Control', 'public, max-age=31536000, immutable')
            ->withBody($body);
    }

    /**
     * Decide whether the caller may fetch files for $formId.
     * - Standalone published form  -> public (anyone).
     * - App-scoped or unpublished  -> form owner, or an active member of an app
     *   that contains the form.
     */
    private function authorizeFileAccess(Request $request, string $formId): bool
    {
        $form = $this->formService->getForm($formId);
        if (!$form) {
            return false;
        }

        $appScoped = $this->appService ? $this->appService->isFormInAnyApp($formId) : false;

        // Publicly fillable standalone form: its uploaded files are public too.
        if (!$appScoped && ($form['status'] ?? null) === 'published') {
            return true;
        }

        // Otherwise authentication is required.
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return false;
        }

        // The form owner can always access.
        if (($form['userId'] ?? null) === $userId) {
            return true;
        }

        // An active member of an app containing the form can access its files.
        if ($appScoped && $this->appService && $this->appService->userSharesActiveAppWithForm($formId, $userId)) {
            return true;
        }

        return false;
    }

    private function jsonResponse(Response $response, array $data, int $status = 200): Response
    {
        $json = json_encode($data);
        if ($json === false) {
            $json = json_encode(['error' => true, 'message' => 'Internal server error']);
            $status = 500;
        }
        $response->getBody()->write($json);
        return $response
            ->withHeader('Content-Type', 'application/json')
            ->withStatus($status);
    }
}
