<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\QuickJsRunner;
use FormLogic\Services\PayPalService;
use FormLogic\Services\DocumentConverter;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Health endpoints. basic() is a public heartbeat; deep() is a protected "Doctor"
 * that surfaces operational problems (broken DB, unwritable dirs, missing QuickJS,
 * billing misconfig) that would otherwise fail silently.
 */
class HealthController
{
    public function __construct(
        private MySQLConnection $db,
        private array $settings,
        private ?PayPalService $paypal = null,
        private ?DocumentConverter $docs = null
    ) {
    }

    public function basic(Request $request, Response $response): Response
    {
        return $this->json($response, ['status' => 'ok', 'timestamp' => date('c')]);
    }

    /** GET /api/health/deep — diagnostics. 200 if all critical checks pass, else 503. */
    public function deep(Request $request, Response $response): Response
    {
        $checks = [];
        $base = dirname(__DIR__, 2); // .../backend

        // Database connectivity (not just DSN).
        try {
            $this->db->getConnection()->query('SELECT 1');
            $checks['database'] = ['ok' => true, 'critical' => true, 'detail' => 'connected'];
        } catch (\Throwable $e) {
            $checks['database'] = ['ok' => false, 'critical' => true, 'detail' => 'connection failed'];
        }

        // Writable storage/log directories.
        $dirs = [
            'storage/forms' => $this->settings['sqlite']['storage_path'] ?? ($base . '/storage/forms'),
            'storage/uploads' => $base . '/storage/uploads',
            'storage/packs' => $this->settings['packs']['storagePath'] ?? ($base . '/storage/packs'),
            'logs' => dirname((string) ($this->settings['logger']['path'] ?? ($base . '/logs/app.log'))),
        ];
        foreach ($dirs as $label => $path) {
            $writable = is_dir($path) && is_writable($path);
            $checks["writable:$label"] = [
                'ok' => $writable,
                'critical' => true,
                'detail' => $writable ? 'writable' : (is_dir($path) ? 'NOT writable' : 'missing'),
            ];
        }

        // QuickJS runtime — required for scripts + calculated fields.
        $qjs = new QuickJsRunner();
        $qjsOk = $qjs->isAvailable();
        $checks['quickjs'] = [
            'ok' => $qjsOk,
            'critical' => true,
            'detail' => $qjsOk ? 'binary + harness + prelude present' : 'missing binary/harness/prelude',
        ];

        // Billing — only critical when plan enforcement is on.
        $enforced = (bool) ($this->settings['cloud']['planEnforced'] ?? false);
        $paypalOk = $this->paypal ? $this->paypal->isConfigured() : false;
        $paypalEnv = (string) ($_ENV['PAYPAL_ENV'] ?? 'sandbox');
        $paypal = [
            'ok' => $enforced ? $paypalOk : true,
            'critical' => $enforced,
            'detail' => $paypalOk ? "configured ($paypalEnv)" : 'not configured',
        ];
        if ($paypalOk && $paypalEnv !== 'live') {
            $paypal['warning'] = 'PAYPAL_ENV is sandbox — no real charges';
        } elseif ($paypalOk && empty($_ENV['PAYPAL_WEBHOOK_ID'])) {
            $paypal['warning'] = 'PAYPAL_WEBHOOK_ID not set — held/eCheck payments credit on retry only';
        }
        $checks['paypal'] = $paypal;

        // Document-conversion tools — non-critical (AI document upload degrades without them).
        // Defensive: a misconfigured temp dir makes DocumentConverter's constructor throw, which
        // must degrade the report rather than 500 the whole diagnostics endpoint.
        try {
            $docs = $this->docs ?? new DocumentConverter();
            foreach (['pdftoppm', 'gs', 'libreoffice'] as $tool) {
                $present = $docs->commandExists($tool);
                $checks["tool:$tool"] = [
                    'ok' => $present,
                    'critical' => false,
                    'detail' => $present ? 'available' : 'not found (AI document conversion limited)',
                ];
            }
        } catch (\Throwable $e) {
            $checks['document_converter'] = ['ok' => false, 'critical' => false, 'detail' => 'unavailable: ' . $e->getMessage()];
        }

        $ok = true;
        foreach ($checks as $c) {
            if (($c['critical'] ?? false) && !($c['ok'] ?? false)) {
                $ok = false;
            }
        }

        return $this->json($response, [
            'status' => $ok ? 'ok' : 'degraded',
            'checks' => $checks,
            'info' => [
                'environment' => ($this->settings['isProduction'] ?? true) ? 'production' : 'development',
                'planEnforced' => $enforced,
                'phpVersion' => PHP_VERSION,
            ],
            'timestamp' => date('c'),
        ], $ok ? 200 : 503);
    }

    private function json(Response $response, array $data, int $status = 200): Response
    {
        $response->getBody()->write(json_encode($data, JSON_PRETTY_PRINT));
        return $response->withStatus($status)->withHeader('Content-Type', 'application/json');
    }
}
