<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\NativeAppUploadsService;
use InvalidArgumentException;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use RuntimeException;
use Slim\Psr7\Stream;

/**
 * HTTP endpoints for sandboxed per-app file uploads on SoftN and hosted JavaScript apps.
 *
 * Owner routes (`/api/apps/{id}/native/uploads*`):
 *  - Manage sandbox policy (access, quotas, allowed categories, quarantine review), list/search
 *    all uploaded files (including quarantined ones), approve/quarantine, preview/download, and delete.
 *
 * Runtime routes (`/api/app/{slug}/native/uploads*`, gated by AppAccessGateMiddleware):
 *  - Allow authorized app visitors/members/owners to upload files, list approved uploads, stream
 *    approved files with strict sandbox headers (`nosniff`, `CSP: default-src 'none'; sandbox`),
 *    and delete their own uploads.
 */
final class NativeAppUploadsController
{
    public function __construct(
        private AppService $apps,
        private AppUserService $appUsers,
        private NativeAppService $native,
        private NativeAppUploadsService $uploads,
    ) {}

    // ── Owner management endpoints ──────────────────────────────────────────────────────────────

    /** @param array<string, string> $args */
    public function ownerList(Request $request, Response $response, array $args): Response
    {
        $app = $this->requireOwnedApp($request, (string) ($args['id'] ?? ''));
        if ($app === null) {
            return $this->json($response, ['error' => 'App not found or access denied'], 404);
        }
        $query = $request->getQueryParams();
        $policy = $this->uploads->getPolicy($app);
        $listed = $this->uploads->listUploads((string) $app['id'], (string) $app['slug'], [
            'status' => is_string($query['status'] ?? null) ? $query['status'] : null,
            'category' => is_string($query['category'] ?? null) ? $query['category'] : null,
            'folder' => is_string($query['folder'] ?? null) ? $query['folder'] : null,
            'search' => is_string($query['search'] ?? null) ? $query['search'] : null,
            'limit' => $query['limit'] ?? 100,
            'offset' => $query['offset'] ?? 0,
        ]);
        return $this->json($response, [
            'uploads' => $listed['uploads'],
            'total' => $listed['total'],
            'stats' => $this->uploads->getStats((string) $app['id'], $policy),
            'policy' => $policy,
        ]);
    }

    /** @param array<string, string> $args */
    public function ownerUpload(Request $request, Response $response, array $args): Response
    {
        $app = $this->requireOwnedApp($request, (string) ($args['id'] ?? ''));
        if ($app === null) {
            return $this->json($response, ['error' => 'App not found or access denied'], 404);
        }
        $userId = $this->requestUserId($request);
        $user = $request->getAttribute('user');
        $label = is_array($user) && is_string($user['name'] ?? null) && trim($user['name']) !== ''
            ? trim($user['name'])
            : 'Owner';

        try {
            $policy = $this->uploads->getPolicy($app);
            [$filename, $bytes, $folder] = $this->extractIncomingUpload($request, $policy['maxFileSizeMb'] * 1024 * 1024);
            $record = $this->uploads->storeBytes($app, $filename, $bytes, $folder, $userId, $label, true);
            return $this->json($response, [
                'upload' => $record,
                'url' => $record['url'],
            ], 201);
        } catch (InvalidArgumentException $e) {
            return $this->json($response, ['error' => $e->getMessage(), 'code' => 'sandbox_rejected'], 422);
        } catch (RuntimeException $e) {
            $status = $e->getCode() === 413 ? 413 : 500;
            return $this->json($response, ['error' => $e->getMessage()], $status);
        }
    }

    /** @param array<string, string> $args */
    public function ownerUpdatePolicy(Request $request, Response $response, array $args): Response
    {
        $app = $this->requireOwnedApp($request, (string) ($args['id'] ?? ''));
        if ($app === null) {
            return $this->json($response, ['error' => 'App not found or access denied'], 404);
        }
        $body = $request->getParsedBody();
        if (!is_array($body)) {
            $decoded = json_decode((string) $request->getBody(), true);
            $body = is_array($decoded) ? $decoded : [];
        }
        try {
            $nextPolicy = $this->uploads->normalizePolicyPatch($app, $body);
            $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
            $settings['nativeUploads'] = $nextPolicy;
            $this->apps->updateApp((string) $app['id'], ['settings' => $settings]);
            return $this->json($response, ['policy' => $nextPolicy]);
        } catch (InvalidArgumentException $e) {
            return $this->json($response, ['error' => $e->getMessage()], 422);
        }
    }

    /** @param array<string, string> $args */
    public function ownerUpdateUpload(Request $request, Response $response, array $args): Response
    {
        $app = $this->requireOwnedApp($request, (string) ($args['id'] ?? ''));
        if ($app === null) {
            return $this->json($response, ['error' => 'App not found or access denied'], 404);
        }
        $body = $request->getParsedBody();
        if (!is_array($body)) {
            $decoded = json_decode((string) $request->getBody(), true);
            $body = is_array($decoded) ? $decoded : [];
        }
        try {
            $updated = $this->uploads->updateUpload((string) $app['id'], (string) $app['slug'], (string) ($args['uploadId'] ?? ''), $body);
            if ($updated === null) {
                return $this->json($response, ['error' => 'Uploaded file not found.'], 404);
            }
            return $this->json($response, ['upload' => $updated]);
        } catch (InvalidArgumentException $e) {
            return $this->json($response, ['error' => $e->getMessage()], 422);
        }
    }

    /** @param array<string, string> $args */
    public function ownerDownload(Request $request, Response $response, array $args): Response
    {
        $app = $this->requireOwnedApp($request, (string) ($args['id'] ?? ''));
        if ($app === null) {
            return $this->json($response, ['error' => 'App not found or access denied'], 404);
        }
        $row = $this->uploads->getUploadRow((string) $app['id'], (string) ($args['uploadId'] ?? ''));
        if ($row === null) {
            return $this->json($response, ['error' => 'Uploaded file not found.'], 404);
        }
        $forceDownload = ($request->getQueryParams()['download'] ?? '') === '1';
        return $this->streamSandboxedFile($response, (string) $app['id'], $row, $forceDownload, true, false);
    }

    /** @param array<string, string> $args */
    public function ownerDelete(Request $request, Response $response, array $args): Response
    {
        $app = $this->requireOwnedApp($request, (string) ($args['id'] ?? ''));
        if ($app === null) {
            return $this->json($response, ['error' => 'App not found or access denied'], 404);
        }
        $ok = $this->uploads->deleteUpload((string) $app['id'], (string) ($args['uploadId'] ?? ''));
        if (!$ok) {
            return $this->json($response, ['error' => 'Uploaded file not found.'], 404);
        }
        return $this->json($response, ['deleted' => true]);
    }

    /** @param array<string, string> $args */
    public function ownerBulkDelete(Request $request, Response $response, array $args): Response
    {
        $app = $this->requireOwnedApp($request, (string) ($args['id'] ?? ''));
        if ($app === null) {
            return $this->json($response, ['error' => 'App not found or access denied'], 404);
        }
        $body = $request->getParsedBody();
        if (!is_array($body)) {
            $decoded = json_decode((string) $request->getBody(), true);
            $body = is_array($decoded) ? $decoded : [];
        }
        $ids = is_array($body['ids'] ?? null) ? array_values(array_filter($body['ids'], 'is_string')) : [];
        if ($ids === []) {
            return $this->json($response, ['error' => 'Provide an array of upload IDs to delete.'], 422);
        }
        $deleted = $this->uploads->bulkDelete((string) $app['id'], array_slice($ids, 0, 200));
        return $this->json($response, ['deleted' => $deleted]);
    }

    // ── Runtime / visitor endpoints (gated by AppAccessGateMiddleware) ──────────────────────────

    /** @param array<string, string> $args */
    public function runtimeUpload(Request $request, Response $response, array $args): Response
    {
        [$app, $userId, $isOwner, $isMember, $userLabel, $denied] = $this->resolveRuntimeActor($request, (string) ($args['slug'] ?? ''));
        if ($denied !== null || $app === null) {
            return $this->json($response, ['error' => $denied ?? 'App not found or access denied.'], 403);
        }
        $policy = $this->uploads->getPolicy($app);
        if (!$this->canActorUpload($policy['access'], $isOwner, $isMember)) {
            $msg = match ($policy['access']) {
                'disabled' => 'File uploads are disabled for this app.',
                'owner' => 'Only the app owner may upload files to this app.',
                'members' => 'Sign in as an app member to upload files.',
                default => 'File uploads are not permitted.',
            };
            return $this->json($response, ['error' => $msg, 'code' => 'uploads_forbidden'], 403);
        }

        try {
            [$filename, $bytes, $folder] = $this->extractIncomingUpload($request, $policy['maxFileSizeMb'] * 1024 * 1024);
            $record = $this->uploads->storeBytes($app, $filename, $bytes, $folder, $userId, $userLabel, $isOwner);
            $publicRecord = $isOwner ? $record : $this->redactRuntimeRecord($record, $userId);
            return $this->json($response, [
                'upload' => $publicRecord,
                'url' => $publicRecord['url'],
                'quarantined' => $publicRecord['status'] === 'quarantined',
            ], 201);
        } catch (InvalidArgumentException $e) {
            return $this->json($response, ['error' => $e->getMessage(), 'code' => 'sandbox_rejected'], 422);
        } catch (RuntimeException $e) {
            $status = $e->getCode() === 413 ? 413 : 500;
            return $this->json($response, ['error' => $e->getMessage()], $status);
        }
    }

    /** @param array<string, string> $args */
    public function runtimeList(Request $request, Response $response, array $args): Response
    {
        [$app, $userId, $isOwner, $isMember, , $denied] = $this->resolveRuntimeActor($request, (string) ($args['slug'] ?? ''));
        if ($denied !== null || $app === null) {
            return $this->json($response, ['error' => $denied ?? 'App not found or access denied.'], 403);
        }
        $policy = $this->uploads->getPolicy($app);
        if (!$this->canActorAccessUploads($policy['access'], $isOwner, $isMember)) {
            return $this->json($response, ['error' => 'File uploads are not accessible for this app.', 'code' => 'uploads_forbidden'], 403);
        }
        $query = $request->getQueryParams();
        $listed = $this->uploads->listUploads((string) $app['id'], (string) $app['slug'], [
            'status' => $isOwner ? null : 'approved',
            'folder' => is_string($query['folder'] ?? null) ? $query['folder'] : null,
            'limit' => min(100, (int) ($query['limit'] ?? 50)),
            'offset' => max(0, (int) ($query['offset'] ?? 0)),
        ]);
        $uploads = $isOwner
            ? $listed['uploads']
            : array_map(fn(array $rec): array => $this->redactRuntimeRecord($rec, $userId), $listed['uploads']);
        return $this->json($response, [
            'uploads' => $uploads,
            'total' => $listed['total'],
            'policy' => [
                'access' => $policy['access'],
                'maxFileSizeMb' => $policy['maxFileSizeMb'],
                'allowedCategories' => $policy['allowedCategories'],
                'requireQuarantineReview' => $policy['requireQuarantineReview'],
            ],
        ]);
    }

    /** @param array<string, string> $args */
    public function runtimeServe(Request $request, Response $response, array $args): Response
    {
        [$app, , $isOwner, $isMember, , $denied, $nativeAccess] = $this->resolveRuntimeActor($request, (string) ($args['slug'] ?? ''));
        if ($denied !== null || $app === null) {
            return $this->json($response, ['error' => $denied ?? 'App not found or access denied.'], 403);
        }
        $policy = $this->uploads->getPolicy($app);
        if (!$this->canActorAccessUploads($policy['access'], $isOwner, $isMember)) {
            return $this->json($response, ['error' => 'File uploads are not accessible for this app.', 'code' => 'uploads_forbidden'], 403);
        }
        $row = $this->uploads->getUploadRow((string) $app['id'], (string) ($args['uploadId'] ?? ''));
        if ($row === null) {
            return $this->json($response, ['error' => 'Uploaded file not found.'], 404);
        }
        if (($row['status'] ?? '') !== 'approved' && !$isOwner) {
            return $this->json($response, ['error' => 'This uploaded file is pending owner review in quarantine.'], 403);
        }
        $forceDownload = ($request->getQueryParams()['download'] ?? '') === '1';
        $isPublicRuntime = $nativeAccess === 'application' && $policy['access'] === 'anyone' && ($row['status'] ?? '') === 'approved';
        return $this->streamSandboxedFile($response, (string) $app['id'], $row, $forceDownload, $isOwner, $isPublicRuntime);
    }

    /** @param array<string, string> $args */
    public function runtimeDelete(Request $request, Response $response, array $args): Response
    {
        [$app, $userId, $isOwner, , , $denied] = $this->resolveRuntimeActor($request, (string) ($args['slug'] ?? ''));
        if ($denied !== null || $app === null) {
            return $this->json($response, ['error' => $denied ?? 'App not found or access denied.'], 403);
        }
        $row = $this->uploads->getUploadRow((string) $app['id'], (string) ($args['uploadId'] ?? ''));
        if ($row === null) {
            return $this->json($response, ['error' => 'Uploaded file not found.'], 404);
        }
        $isUploader = $userId !== null && $userId !== '' && ($row['uploaded_by'] ?? null) === $userId;
        if (!$isOwner && !$isUploader) {
            return $this->json($response, ['error' => 'Only the app owner or original uploader may delete this file.'], 403);
        }
        $this->uploads->deleteUpload((string) $app['id'], (string) $row['id']);
        return $this->json($response, ['deleted' => true]);
    }

    // ── Internals ───────────────────────────────────────────────────────────────────────────────

    private function requestUserId(Request $request): ?string
    {
        $attr = $request->getAttribute('userId');
        if (is_string($attr) && $attr !== '') {
            return $attr;
        }
        $user = $request->getAttribute('user');
        if (is_array($user) && !empty($user['id'])) {
            return (string) $user['id'];
        }
        return null;
    }

    /** @return array<string, mixed>|null */
    private function requireOwnedApp(Request $request, string $appId): ?array
    {
        $userId = $this->requestUserId($request);
        if ($userId === null || $appId === '') {
            return null;
        }
        $app = $this->apps->getApp($appId);
        if (!$app || (string) ($app['ownerId'] ?? '') !== $userId) {
            return null;
        }
        return $app;
    }

    /**
     * Resolves the app + caller admission for `/api/app/{slug}/native/uploads*`.
     *
     * @return array{0: ?array<string, mixed>, 1: ?string, 2: bool, 3: bool, 4: ?string, 5: ?string, 6: string}
     */
    private function resolveRuntimeActor(Request $request, string $slug): array
    {
        $app = $this->apps->getAppBySlug($slug);
        if (!$app) {
            return [null, null, false, false, null, 'App not found.', 'members'];
        }
        $userId = $this->requestUserId($request);
        $user = $request->getAttribute('user');
        $userLabel = is_array($user) && is_string($user['name'] ?? null) && trim($user['name']) !== ''
            ? trim($user['name'])
            : ($userId !== null ? 'Member' : 'Visitor');
        $isOwner = $userId !== null && (string) ($app['ownerId'] ?? '') === $userId;
        $membership = (!$isOwner && $userId !== null)
            ? $this->appUsers->getAppUser((string) $app['id'], $userId)
            : null;
        $isMember = $isOwner || (is_array($membership) && ($membership['status'] ?? '') === 'active');

        if (!$this->apps->isRuntimeVisible($app, $userId)) {
            return [null, $userId, false, false, $userLabel, 'App is not published.', 'members'];
        }
        $summary = $this->native->summary((string) $app['id']);
        // Fail closed to 'members' when no native bundle summary exists or access is unset.
        $nativeAccess = is_array($summary) && ($summary['access'] ?? null) === 'application'
            ? 'application'
            : 'members';
        if ($nativeAccess === 'members' && !$isMember) {
            return [null, $userId, false, false, $userLabel, 'Sign in with an active app membership to access this app\'s files.', 'members'];
        }
        // Public ('application') apps do not deanonymize ambient signed-in FormLogic accounts
        // (other than the app owner) when accessed by visitors.
        if ($nativeAccess === 'application' && !$isOwner) {
            $userId = null;
            $isMember = false;
            $userLabel = 'Visitor';
        }
        return [$app, $userId, $isOwner, $isMember, $userLabel, null, $nativeAccess];
    }

    private function canActorUpload(string $policyAccess, bool $isOwner, bool $isMember): bool
    {
        return match ($policyAccess) {
            'disabled' => false,
            'owner' => $isOwner,
            'members' => $isOwner || $isMember,
            'anyone' => true,
            default => false,
        };
    }

    private function canActorAccessUploads(string $policyAccess, bool $isOwner, bool $isMember): bool
    {
        return match ($policyAccess) {
            'disabled' => $isOwner,
            'owner' => $isOwner,
            'members' => $isOwner || $isMember,
            'anyone' => true,
            default => false,
        };
    }

    /**
     * Strips owner-internal moderation notes and user PII (UUIDs/emails) from non-owner runtime responses.
     *
     * @param array<string, mixed> $record
     * @return array<string, mixed>
     */
    private function redactRuntimeRecord(array $record, ?string $callerUserId): array
    {
        $canDelete = $callerUserId !== null && $callerUserId !== '' && ($record['uploadedBy'] ?? null) === $callerUserId;
        unset($record['notes'], $record['uploadedBy']);
        if (is_string($record['uploaderLabel'] ?? null) && str_contains($record['uploaderLabel'], '@')) {
            $record['uploaderLabel'] = null;
        }
        $record['canDelete'] = $canDelete;
        return $record;
    }

    /**
     * Supports both `multipart/form-data` (field `file`) and JSON `{ filename, contentBase64, folder? }`.
     * Enforces `$maxBytes` before buffering/decoding into memory to prevent worker OOM DoS.
     *
     * @return array{0: string, 1: string, 2: string}
     */
    private function extractIncomingUpload(Request $request, int $maxBytes = 26214400): array
    {
        $uploadedFiles = $request->getUploadedFiles();
        if (isset($uploadedFiles['file'])) {
            $file = $uploadedFiles['file'];
            if ($file->getError() !== UPLOAD_ERR_OK) {
                throw new InvalidArgumentException('File upload did not complete cleanly.');
            }
            $reportedSize = $file->getSize();
            if ($reportedSize !== null && $reportedSize > $maxBytes) {
                throw new InvalidArgumentException(sprintf('File exceeds this app\'s %d MB per-file upload limit.', (int) ceil($maxBytes / (1024 * 1024))));
            }
            $stream = $file->getStream();
            if ($stream->isSeekable()) {
                $stream->rewind();
            }
            $bytes = '';
            $remaining = $maxBytes + 1;
            while (!$stream->eof() && $remaining > 0) {
                $chunk = $stream->read(min(65536, $remaining));
                if ($chunk === '') {
                    break;
                }
                $bytes .= $chunk;
                $remaining -= strlen($chunk);
            }
            if (strlen($bytes) > $maxBytes) {
                throw new InvalidArgumentException(sprintf('File exceeds this app\'s %d MB per-file upload limit.', (int) ceil($maxBytes / (1024 * 1024))));
            }
            $body = $request->getParsedBody();
            $folder = is_array($body) && is_string($body['folder'] ?? null) ? $body['folder'] : '';
            return [(string) ($file->getClientFilename() ?? 'upload.bin'), $bytes, $folder];
        }

        $body = $request->getParsedBody();
        if (!is_array($body)) {
            $decoded = json_decode((string) $request->getBody(), true);
            $body = is_array($decoded) ? $decoded : [];
        }
        $filename = is_string($body['filename'] ?? null) ? $body['filename'] : '';
        $b64 = is_string($body['contentBase64'] ?? null) ? $body['contentBase64'] : '';
        $folder = is_string($body['folder'] ?? null) ? $body['folder'] : '';
        if ($filename === '' || $b64 === '') {
            throw new InvalidArgumentException('Provide a multipart "file" upload or JSON { filename, contentBase64 }.');
        }
        if (str_contains($b64, ',')) {
            $b64 = substr($b64, strpos($b64, ',') + 1);
        }
        $maxEncodedLen = (int) ceil($maxBytes * 4 / 3) + 128;
        if (strlen($b64) > $maxEncodedLen) {
            throw new InvalidArgumentException(sprintf('File exceeds this app\'s %d MB per-file upload limit.', (int) ceil($maxBytes / (1024 * 1024))));
        }
        $bytes = base64_decode($b64, true);
        if ($bytes === false || $bytes === '') {
            throw new InvalidArgumentException('Invalid base64 upload content.');
        }
        return [$filename, $bytes, $folder];
    }

    /** @param array<string, mixed> $row */
    private function streamSandboxedFile(Response $response, string $appId, array $row, bool $forceDownload, bool $isOwner, bool $isPublicRuntime = false): Response
    {
        $path = $this->uploads->resolveFilePath($appId, (string) $row['stored_filename']);
        if ($path === null) {
            return $this->json($response, ['error' => 'Uploaded file payload is missing from sandbox storage.'], 404);
        }
        $stream = @fopen($path, 'rb');
        if ($stream === false) {
            return $this->json($response, ['error' => 'Could not read uploaded file.'], 500);
        }

        $mime = (string) ($row['mime_type'] ?? 'application/octet-stream');
        $inline = !$forceDownload && NativeAppUploadsService::isInlineSafeMime($mime) && ($row['status'] ?? '') === 'approved';
        $disposition = $inline ? 'inline' : 'attachment';
        $rawName = (string) $row['original_filename'];
        $cleanName = preg_replace('/[\x00-\x1F\x7F"\\\\;]+/', '_', $rawName) ?? 'download.bin';
        $asciiFallback = preg_replace('/[^\x20-\x7E]/', '_', $cleanName) ?? 'download.bin';
        $asciiFallback = trim($asciiFallback) !== '' ? $asciiFallback : 'download.bin';
        $encodedName = rawurlencode($cleanName !== '' ? $cleanName : $asciiFallback);
        $cacheControl = ($row['status'] ?? '') === 'quarantined' || $isOwner
            ? 'private, no-store'
            : 'private, max-age=3600';

        $out = $response
            ->withBody(new Stream($stream))
            ->withHeader('Content-Type', $mime)
            ->withHeader('Content-Length', (string) filesize($path))
            ->withHeader('Content-Disposition', sprintf('%s; filename="%s"; filename*=UTF-8\'\'%s', $disposition, $asciiFallback, $encodedName))
            ->withHeader('X-Content-Type-Options', 'nosniff')
            ->withHeader('Content-Security-Policy', \FormLogic\Middleware\SecurityHeadersMiddleware::SANDBOXED_IMAGE)
            ->withHeader('X-Frame-Options', 'DENY')
            ->withHeader('Cache-Control', $cacheControl);
        if ($isPublicRuntime) {
            $out = $out
                ->withHeader('Cross-Origin-Resource-Policy', 'cross-origin')
                ->withHeader('Access-Control-Allow-Origin', '*');
        } else {
            $out = $out->withHeader('Cross-Origin-Resource-Policy', 'same-origin');
        }
        return $out;
    }

    /** @param array<string, mixed> $payload */
    private function json(Response $response, array $payload, int $status = 200): Response
    {
        $response->getBody()->write((string) json_encode($payload, JSON_UNESCAPED_SLASHES));
        return $response->withStatus($status)->withHeader('Content-Type', 'application/json');
    }
}
