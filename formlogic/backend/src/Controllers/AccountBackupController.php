<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\AccountBackupService;
use FormLogic\Services\AuditService;
use FormLogic\Support\BackupEnvelope;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;

/**
 * Owner account backup endpoints (Settings → Backup & restore):
 *   GET  /api/account/backup/export  — stream the full-workspace zip
 *   POST /api/account/backup/export  — the same, sealed with a passphrase
 *   POST /api/account/backup/import  — restore a backup zip as NEW resources
 *
 * Owner-only surfaces: the shared demo account is refused, and the admin
 * acting-as mode never reaches here (/account/* is default-denied by the
 * client's actingRoute and has no admin mirror — a backup CONTAINS record
 * data, which platform admins must never obtain).
 */
final class AccountBackupController
{
    use JsonResponseTrait;

    public function __construct(
        private AccountBackupService $backup,
        private ?AuditService $auditService = null,
        private ?LoggerInterface $logger = null,
    ) {
    }

    /**
     * GET /api/account/backup/export — streams the zip (Content-Length known).
     * POST with {passphrase} streams it sealed, so the file is safe wherever it ends up. It is a
     * POST so the passphrase never sits in a URL or an access log.
     */
    public function export(Request $request, Response $response): Response
    {
        if (($refused = $this->refuseDemo($request, $response)) !== null) {
            return $refused;
        }
        $userId = (string) $request->getAttribute('userId');
        $passphrase = null;
        if ($request->getMethod() === 'POST') {
            $body = $request->getParsedBody();
            $passphrase = is_array($body) ? ($body['passphrase'] ?? null) : null;
            if (!is_string($passphrase) || mb_strlen($passphrase) < BackupEnvelope::MIN_PASSPHRASE_LENGTH) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Use a passphrase of at least ' . BackupEnvelope::MIN_PASSPHRASE_LENGTH . ' characters'], 400);
            }
        }

        try {
            $zipPath = $this->backup->exportAccount($userId);
            if ($passphrase !== null) {
                $plainPath = $zipPath;
                $zipPath = $plainPath . BackupEnvelope::EXTENSION;
                try {
                    BackupEnvelope::seal($plainPath, $zipPath, ['passphrase' => $passphrase]);
                } finally {
                    @unlink($plainPath);
                }
            }
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 500);
        }

        $size = (int) filesize($zipPath);
        $stream = fopen($zipPath, 'rb');
        if ($stream === false) {
            @unlink($zipPath);
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Could not read the backup archive'], 500);
        }

        $this->audit($request, 'account.backup_export', ['sizeBytes' => $size, 'sealed' => $passphrase !== null]);
        // Best-effort cleanup once the response has been streamed. The tmp-dir
        // age sweep inside the service is the backstop if Windows refuses the
        // unlink while the handle lingers.
        register_shutdown_function(static function () use ($zipPath): void {
            @unlink($zipPath);
        });

        return $response
            ->withBody(new \Slim\Psr7\Stream($stream))
            ->withHeader('Content-Type', $passphrase === null ? 'application/zip' : 'application/octet-stream')
            ->withHeader('Content-Disposition', 'attachment; filename="formlogic-backup-' . date('Ymd-His') . ($passphrase === null ? '.zip' : '.zip' . BackupEnvelope::EXTENSION) . '"')
            ->withHeader('Content-Length', (string) $size);
    }

    /** POST /api/account/backup/import — multipart 'file'; all-or-nothing restore. */
    public function import(Request $request, Response $response): Response
    {
        if (($refused = $this->refuseDemo($request, $response)) !== null) {
            return $refused;
        }
        $userId = (string) $request->getAttribute('userId');

        $files = $request->getUploadedFiles();
        $file = $files['file'] ?? null;
        if ($file === null || $file->getError() !== UPLOAD_ERR_OK) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Upload a backup .zip as the "file" field'], 400);
        }

        $tmpPath = (string) tempnam(sys_get_temp_dir(), 'flbakimp_');
        $openedPath = null;
        try {
            // moveTo() replaces the file, and with it tempnam()'s private mode.
            $file->moveTo($tmpPath);
            chmod($tmpPath, 0600);
            if (BackupEnvelope::isSealed($tmpPath)) {
                $body = $request->getParsedBody();
                $passphrase = is_array($body) ? (string) ($body['passphrase'] ?? '') : '';
                if ($passphrase === '') {
                    return $this->jsonResponse($response, ['error' => true, 'message' => 'This backup needs its passphrase', 'code' => 'backup_passphrase_required'], 400);
                }
                $openedPath = $this->backup->scratchFile('.zip');
                BackupEnvelope::open($tmpPath, $openedPath, ['passphrase' => $passphrase]);
            }
            $result = $this->backup->importAccount($openedPath ?? $tmpPath, $userId);
            $this->audit($request, 'account.backup_import', [
                'apps' => count($result['apps']),
                'forms' => count($result['forms']),
                'responses' => $result['responses'],
                'files' => $result['files'],
            ]);
            return $this->jsonResponse($response, $result);
        } catch (\FormLogic\Services\EncryptionRequestException $e) {
            // Typed refusal (e.g. import_remint_refused — private forms require id preservation).
            $this->audit($request, 'account.backup_import_failed', ['error' => substr($e->getMessage(), 0, 300)]);
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage(), 'code' => $e->errorCode], $e->status);
        } catch (\RuntimeException | \InvalidArgumentException $e) {
            $this->audit($request, 'account.backup_import_failed', ['error' => substr($e->getMessage(), 0, 300)]);
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Throwable $e) {
            $this->logger?->error('Backup import crashed', ['error' => $e->getMessage()]);
            $this->audit($request, 'account.backup_import_failed', ['error' => substr($e->getMessage(), 0, 300)]);
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Backup import failed unexpectedly'], 500);
        } finally {
            @unlink($tmpPath);
            if ($openedPath !== null) {
                @unlink($openedPath);
            }
        }
    }

    /** The shared demo account never exports/imports (its data is provisioning-managed + public). */
    private function refuseDemo(Request $request, Response $response): ?Response
    {
        $user = $request->getAttribute('user');
        $demoEmail = strtolower((string) ($_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local'));
        if ($user !== null && strtolower((string) ($user->email ?? '')) === $demoEmail) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Backups are not available in the demo.'], 403);
        }
        return null;
    }

    private function audit(Request $request, string $action, array $details = []): void
    {
        try {
            $sp = $request->getServerParams();
            $this->auditService?->log($action, 'account', $request->getAttribute('userId'), $request->getAttribute('userId'), \FormLogic\Helpers\IpResolver::fromEnvironment()->getClientIp($request), $details);
        } catch (\Throwable) {
            // audit is best-effort
        }
    }
}
