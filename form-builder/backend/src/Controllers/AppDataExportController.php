<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Helpers\IpResolver;
use FormLogic\Services\AppDataExportService;
use FormLogic\Services\AppService;
use FormLogic\Services\AuditService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

/**
 * Owner data export for a custom app (Records page → "Export data"):
 * GET /api/apps/{id}/export/data?format=sqlite|mysql|mssql
 *
 * Owner-only (the app's records in full — member RBAC does not apply), and
 * refused for the shared demo account (any visitor holds that session).
 */
class AppDataExportController
{
    use JsonResponseTrait;

    private IpResolver $ipResolver;

    public function __construct(
        private AppService $appService,
        private AppDataExportService $exportService,
        private ?AuditService $auditService = null,
        private ?LoggerInterface $logger = null,
    ) {
        $this->logger = $logger ?? new NullLogger();
        $this->ipResolver = new IpResolver();
    }

    public function export(Request $request, Response $response, array $args): Response
    {
        $appId = (string) ($args['id'] ?? '');
        $app = $this->appService->getApp($appId);
        $userId = $request->getAttribute('userId');
        if (!$app || !$userId || ($app['ownerId'] ?? null) !== $userId) {
            return $this->jsonError($response, 'App not found or access denied', 404);
        }
        if ($blocked = $this->blockIfDemo($request, $response, 'Data export is disabled on the shared live demo.')) {
            return $blocked;
        }

        $format = strtolower((string) ($request->getQueryParams()['format'] ?? 'sqlite'));
        if (!in_array($format, ['sqlite', 'mysql', 'mssql'], true)) {
            return $this->jsonError($response, 'Unknown export format — use sqlite, mysql or mssql', 400);
        }

        try {
            $path = $format === 'sqlite'
                ? $this->exportService->exportSqliteBundle($app)
                : $this->exportService->exportSqlDump($app, $format);
        } catch (\Throwable $e) {
            $this->logger->error('App data export failed', [
                'appId' => $appId, 'format' => $format, 'error' => $e->getMessage(),
            ]);
            return $this->jsonError($response, 'Export failed — please try again', 500);
        }

        $stream = fopen($path, 'rb');
        if ($stream === false) {
            @unlink($path);
            return $this->jsonError($response, 'Export failed — please try again', 500);
        }

        if ($this->auditService) {
            try {
                $this->auditService->log('app.data_export', 'app', $appId, $userId, $this->ipResolver->getClientIp($request), ['format' => $format]);
            } catch (\Throwable $e) {
                // best-effort audit only
            }
        }

        // The temp file is deleted after the response body has streamed out.
        register_shutdown_function(static function () use ($path): void {
            @unlink($path);
        });

        $slug = preg_replace('/[^a-zA-Z0-9\-_]/', '-', (string) ($app['slug'] ?? 'app')) ?: 'app';
        $stamp = gmdate('Ymd-His');
        $filename = $format === 'sqlite' ? "{$slug}-data-{$stamp}.zip" : "{$slug}-{$format}-{$stamp}.sql";
        $contentType = $format === 'sqlite' ? 'application/zip' : 'application/sql';

        return $response
            ->withBody(new \Slim\Psr7\Stream($stream))
            ->withHeader('Content-Type', $contentType)
            ->withHeader('Content-Disposition', 'attachment; filename="' . $filename . '"')
            ->withHeader('Content-Length', (string) filesize($path));
    }
}
