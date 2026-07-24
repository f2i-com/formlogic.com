<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\FileStorageService;
use FormLogic\Services\FormService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\PlanService;
use FormLogic\Services\ResponseService;
use FormLogic\Constants\AppPermissions;
use FormLogic\Controllers\Concerns\JsonResponseTrait;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class FileController
{
    use JsonResponseTrait;

    private FileStorageService $fileStorage;
    private FormService $formService;
    private ?AppService $appService;
    private ?AppUserService $appUserService;
    private ?PlanService $planService;
    private ?ResponseService $responseService;

    public function __construct(FileStorageService $fileStorage, FormService $formService, ?AppService $appService = null, ?AppUserService $appUserService = null, ?PlanService $planService = null, ?ResponseService $responseService = null)
    {
        $this->fileStorage = $fileStorage;
        $this->formService = $formService;
        $this->appService = $appService;
        $this->appUserService = $appUserService;
        $this->planService = $planService;
        $this->responseService = $responseService;
    }

    /**
     * Enforce the account-level storage quota for a form's owner before storing a file.
     * No-op unless plan enforcement is on. Returns an error Response if over quota, else null.
     */
    private function checkStorageQuota(Response $response, array $form, array $rawFile): ?Response
    {
        if (!$this->planService) {
            return null;
        }
        $ownerId = (string) ($form['userId'] ?? '');
        $incoming = (int) (@filesize($rawFile['tmp_name'] ?? '') ?: 0);
        if ($ownerId !== '' && !$this->planService->canUpload($ownerId, $incoming)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'storage_limit',
                'message' => 'Account storage limit reached. Free up space or add cloud storage to upload more.',
            ], 402);
        }
        return null;
    }

    /**
     * Derive upload constraints from a form's file_upload fields. Returns null if
     * the form has NO file_upload field (uploads must be rejected outright).
     * The constraints are the union across all upload fields (we can't know which
     * field a given upload targets), capped server-side against the global limits.
     *
     * @return array{maxFileSize: ?int, acceptedTypes: string[]}|null
     */
    private function fileUploadConstraints(array $form, ?string $fieldId = null): ?array
    {
        // Field-aware path: when the client names the target field, enforce ONLY that
        // field's constraints (not the union), and reject if it isn't a real upload field.
        if ($fieldId !== null && $fieldId !== '') {
            $target = null;
            foreach ($form['fields'] ?? [] as $f) {
                if (($f['id'] ?? null) === $fieldId) {
                    $target = $f;
                    break;
                }
            }
            if ($target === null || ($target['type'] ?? '') !== 'file_upload') {
                return null; // unknown field or not a file_upload target → reject
            }
            $uploadFields = [$target];
        } else {
            // Legacy/union path (client didn't name the field): widest constraints across
            // all upload fields. Submission-time re-validation still pins each file to its field.
            $uploadFields = array_filter(
                $form['fields'] ?? [],
                fn ($f) => ($f['type'] ?? '') === 'file_upload'
            );
            if (empty($uploadFields)) {
                return null;
            }
        }

        $maxFileSize = 0;
        $acceptedTypes = [];
        $anyUnrestricted = false;
        foreach ($uploadFields as $f) {
            $props = $f['properties'] ?? [];
            $fs = (int) ($props['maxFileSize'] ?? 0);
            // maxFileSize is stored in BYTES by the builder/AI, but form TEMPLATES
            // and PACKS ship it in MEGABYTES (e.g. 5, 10). A value under 1 KiB
            // cannot be a real per-file byte limit, so treat it as megabytes —
            // otherwise min(global, 5) = 5 BYTES rejects every upload to
            // template/pack-created forms.
            if ($fs > 0 && $fs < 1024) {
                $fs *= 1024 * 1024;
            }
            if ($fs > $maxFileSize) {
                $maxFileSize = $fs;
            }
            $types = $props['acceptedFileTypes'] ?? [];
            if (empty($types) || !is_array($types)) {
                $anyUnrestricted = true; // a field that accepts anything relaxes the union
            } else {
                foreach ($types as $t) {
                    $acceptedTypes[] = (string) $t;
                }
            }
        }

        return [
            'maxFileSize' => $maxFileSize > 0 ? $maxFileSize : null,
            'acceptedTypes' => $anyUnrestricted ? [] : array_values(array_unique($acceptedTypes)),
        ];
    }

    /** The target file_upload field id, from the multipart body or query string (optional). */
    private function uploadFieldId(Request $request): ?string
    {
        $body = $request->getParsedBody();
        $fid = (is_array($body) ? ($body['fieldId'] ?? null) : null) ?? ($request->getQueryParams()['fieldId'] ?? null);
        return (is_string($fid) && $fid !== '') ? $fid : null;
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

        // App-scoped forms upload through the authenticated app route
        // (/api/app/{slug}/forms/{formId}/upload), which enforces membership + the
        // SUBMIT permission. Refuse the standalone endpoint so it can't be used to
        // push files into an app's storage anonymously (mirrors serve()).
        if ($this->appService && $this->appService->isFormInAnyApp($formId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found'], 404);
        }

        if ($form['status'] !== 'published') {
            // Allow upload if the user is the form owner (authenticated)
            $userId = $request->getAttribute('userId');
            if (!$userId || $form['userId'] !== $userId) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Form is not accepting uploads'], 403);
            }
        }

        // Reject uploads to forms with no file_upload field — otherwise any
        // published form is an anonymous file-storage endpoint. When the client names the
        // target field, only THAT field's type/size constraints apply.
        $constraints = $this->fileUploadConstraints($form, $this->uploadFieldId($request));
        if ($constraints === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'This form does not accept file uploads at the requested field'], 400);
        }

        try {
            $rawFile = $this->resolveUploadedFile($request);
            if ($overQuota = $this->checkStorageQuota($response, $form, $rawFile)) {
                return $overQuota;
            }
            // Bind the upload to its uploader (FILE-PRIV-001): the authenticated user id
            // when present, plus the claim token storeFile mints for anonymous fillers.
            $metadata = $this->fileStorage->storeFile($formId, $rawFile, $constraints, $request->getAttribute('userId'));
            // File GC (audit FL-006 + FILE-PRIV-001): the uploader pays for the
            // sweep — internally throttled to once an hour per form.
            $this->sweepFileGarbage($formId);
            return $this->jsonResponse($response, $metadata, 201);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    /**
     * Run the throttled file GC for a form — reference-checked when a ResponseService is
     * wired (never deletes a file a response still points at), plain abandoned-upload
     * sweep otherwise (unit-test construction without a response store).
     */
    private function sweepFileGarbage(string $formId): void
    {
        if ($this->responseService !== null) {
            $this->responseService->sweepFileGarbage($formId);
        } else {
            $this->fileStorage->sweepAbandonedUploads($formId);
        }
    }

    /**
     * Resolve the uploaded file into the array FileStorageService expects. Maps a
     * failed PHP upload (e.g. size beyond upload_max_filesize, where the PSR-7 file
     * has no readable stream) to a clean RuntimeException instead of letting
     * getStream() throw an unhandled 500.
     */
    private function resolveUploadedFile(Request $request): array
    {
        $uploadedFiles = $request->getUploadedFiles();
        $file = $uploadedFiles['file'] ?? null;

        // Fall back to raw $_FILES if PSR-7 didn't parse it.
        if (!$file && !empty($_FILES['file'])) {
            return $_FILES['file'];
        }
        if (!$file) {
            throw new \RuntimeException('No file uploaded');
        }

        $err = $file->getError();
        if ($err !== UPLOAD_ERR_OK) {
            throw new \RuntimeException(
                ($err === UPLOAD_ERR_INI_SIZE || $err === UPLOAD_ERR_FORM_SIZE)
                    ? 'File is too large'
                    : 'File upload failed'
            );
        }

        return [
            'tmp_name' => $file->getStream()->getMetadata('uri'),
            'name' => $file->getClientFilename(),
            'size' => $file->getSize(),
            'type' => $file->getClientMediaType(),
            'error' => $err,
        ];
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
        // Drafts stay reachable for the OWNER (studio "Use app" preview).
        if (!$app || !$this->appService->isRuntimeVisible($app, $userId)) {
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

        // Require submit permission on this form — a read-only member must not be
        // able to push files into a form they can't submit to.
        if (!$this->appUserService->hasPermission($app['id'], $userId, AppPermissions::SUBMIT_RESPONSES, $formId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'You do not have permission to upload to this form'], 403);
        }

        // Reject uploads to forms with no file_upload field, and derive the
        // per-field type/size constraints to enforce server-side.
        $form = $this->formService->getForm($formId);
        $constraints = $form ? $this->fileUploadConstraints($form, $this->uploadFieldId($request)) : null;
        if ($constraints === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'This form does not accept file uploads at the requested field'], 400);
        }

        try {
            $rawFile = $this->resolveUploadedFile($request);
            if ($overQuota = $this->checkStorageQuota($response, $form, $rawFile)) {
                return $overQuota;
            }
            // Bind the upload to the authenticated member (FILE-PRIV-001).
            $metadata = $this->fileStorage->storeFile($formId, $rawFile, $constraints, $userId);
            // File GC (audit FL-006 + FILE-PRIV-001): the uploader pays for the
            // sweep — internally throttled to once an hour per form.
            $this->sweepFileGarbage($formId);
            return $this->jsonResponse($response, $metadata, 201);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    /**
     * Serve a stored file.
     * GET /api/files/{formId}/{fileId}/{filename}
     *
     * Response uploads are PRIVATE BY DEFAULT (FILE-PRIV-001) — knowing the URL is not enough.
     * Access requires one of:
     *  - the form owner (any scope);
     *  - on app-scoped forms, a member with VIEW_ALL_RESPONSES on the form (any file) or
     *    VIEW_OWN_RESPONSES (only files on their OWN responses) — mere membership is NOT enough;
     *  - on standalone forms, a short-lived `?rt=` receipt token bound to this exact file
     *    (minted for webhook payloads / anonymous-submitter retrieval);
     *  - the EXPLICIT public-asset policy: the owner enabled customScreen.publicRecords and the
     *    file is attached under one of the whitelisted publicRecordFields — the only case that
     *    is publicly cacheable, and publicity is an owner opt-in, never inferred from the form
     *    being published.
     * UUID secrecy is not relied upon, and access is revoked with membership/permission. See
     * authorizeFileAccess().
     */
    public function serve(Request $request, Response $response, array $args): Response
    {
        $formId = $args['formId'];
        $fileId = $args['fileId'];

        $access = $this->authorizeFileAccess($request, $formId, $fileId);
        if ($access === null) {
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

        // Only explicitly-public assets (owner-whitelisted public-records fields) may be
        // stored by shared caches — bounded, NOT immutable, so revoking publicity (unshare,
        // response delete) converges within the hour. Everything else: private, no-store.
        $cacheControl = $access === 'public' ? 'public, max-age=3600' : 'private, no-store';

        // Render images inline (safe, expected), but force download for PDFs/Office/
        // unknown binaries so the browser never executes active document content.
        $disposition = in_array($mimeType, ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], true) ? 'inline' : 'attachment';
        $safeName = preg_replace('/[\x00-\x1f\x7f"\\\\]/', '_', $filename);

        return $response
            ->withHeader('Content-Type', $mimeType)
            ->withHeader('Content-Length', (string) $fileSize)
            ->withHeader('Content-Disposition', $disposition . '; filename="' . $safeName . '"')
            // Prevent MIME sniffing of user-uploaded content (stored-XSS hardening)
            ->withHeader('X-Content-Type-Options', 'nosniff')
            ->withHeader('Cache-Control', $cacheControl)
            ->withBody($body);
    }

    /**
     * Decide whether the caller may fetch file $fileId of $formId (FILE-PRIV-001:
     * private by default). Returns the access class — 'private' (per-caller, never
     * shared-cacheable), 'public' (explicit owner-opt-in public asset) — or null (deny).
     *
     * - Form owner → private access, any scope.
     * - App-scoped form → member with an explicit form permission:
     *     · VIEW_ALL_RESPONSES  → any of the form's files.
     *     · VIEW_OWN_RESPONSES  → only files attached to the caller's OWN submitted responses.
     *   Mere app membership is NOT enough (files are often sensitive: invoices, IDs, signatures).
     * - Standalone form → a valid short-lived `?rt=` receipt token for this exact file, or the
     *   explicit public-asset policy (published + customScreen.publicRecords + the file attached
     *   under a whitelisted publicRecordFields id). Form publication alone exposes NOTHING.
     */
    private function authorizeFileAccess(Request $request, string $formId, string $fileId): ?string
    {
        $form = $this->formService->getForm($formId);
        if (!$form) {
            return null;
        }

        $userId = $request->getAttribute('userId');

        // The form owner can always access.
        if ($userId !== null && $userId !== '' && ($form['userId'] ?? null) === $userId) {
            return 'private';
        }

        $appScoped = $this->appService ? $this->appService->isFormInAnyApp($formId) : false;

        // App-scoped files: require an explicit response permission on THIS form (checked per app the
        // form belongs to, since permissions are per-app). VIEW_ALL sees every file; VIEW_OWN sees
        // only files on the caller's own responses. Receipt tokens are NOT honored here — a leaked
        // token must never widen an app's membership boundary.
        if ($appScoped) {
            if (!$userId || !$this->appService || !$this->appUserService) {
                return null;
            }
            foreach ($this->appService->activeAppIdsContainingForm($formId, $userId) as $appId) {
                if ($this->appUserService->hasPermission($appId, $userId, AppPermissions::VIEW_ALL_RESPONSES, $formId)) {
                    return 'private';
                }
                if ($this->appUserService->hasPermission($appId, $userId, AppPermissions::VIEW_OWN_RESPONSES, $formId)
                    && $this->fileBelongsToOwnResponse($formId, $fileId, $userId)) {
                    return 'private';
                }
            }
            return null;
        }

        // Standalone form, non-owner caller. 1: file-bound receipt token (upload receipt /
        // webhook attachment fetch) — time-limited capability, private delivery.
        $receipt = $request->getQueryParams()['rt'] ?? null;
        if (is_string($receipt) && $receipt !== ''
            && $this->fileStorage->verifyReceiptToken($formId, $fileId, $receipt)) {
            return 'private';
        }

        // 2: explicit public-asset policy — the owner opted this form's records into public
        // display (customScreen.publicRecords) AND whitelisted the answer field this file is
        // attached under. The only way a response upload is ever public (FILE-PRIV-001).
        if (($form['status'] ?? null) === 'published' && !empty($form['customScreen']['publicRecords'])) {
            $publicFields = array_values(array_filter(
                is_array($form['customScreen']['publicRecordFields'] ?? null) ? $form['customScreen']['publicRecordFields'] : [],
                'is_string'
            ));
            if ($publicFields !== [] && $this->responseService !== null
                && array_intersect($publicFields, $this->responseService->fileAttachedFieldIds($formId, $fileId)) !== []) {
                return 'public';
            }
        }

        return null;
    }

    /**
     * True if $fileId is attached to one of $userId's OWN submitted responses on $formId — the linkage
     * that lets a view-own member fetch their own upload but not another member's. Uses an unbounded
     * lookup (ResponseService::userOwnsFile), so it works regardless of how many responses the user has.
     * Conservative: with no ResponseService wired, returns false.
     */
    private function fileBelongsToOwnResponse(string $formId, string $fileId, string $userId): bool
    {
        return $this->responseService !== null
            && $this->responseService->userOwnsFile($formId, $fileId, $userId);
    }
}
