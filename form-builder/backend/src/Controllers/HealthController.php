<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\ReconcileService;
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

        // Webhook retry worker — non-critical (failed deliveries simply won't retry), but warn
        // when it's never run or looks stale, so an operator knows the cron isn't scheduled.
        try {
            $stmt = $this->db->getConnection()->query("SELECT meta_value FROM system_meta WHERE meta_key = 'webhook_worker_last_run'");
            $lastRun = $stmt ? $stmt->fetchColumn() : false;
            if ($lastRun === false || $lastRun === null) {
                $checks['webhook_worker'] = [
                    'ok' => true, 'critical' => false, 'detail' => 'no run recorded yet',
                    'warning' => 'webhook retry worker has not run — schedule bin/webhook-worker.php (e.g. every 5 minutes)',
                ];
            } else {
                $ageMin = (int) round((time() - strtotime((string) $lastRun)) / 60);
                $checks['webhook_worker'] = ['ok' => true, 'critical' => false, 'detail' => "last run ~{$ageMin}m ago"];
                if ($ageMin > 15) {
                    $checks['webhook_worker']['warning'] = 'webhook retry worker looks stale (>15m) — ensure its cron is running';
                }
            }
        } catch (\Throwable $e) {
            $checks['webhook_worker'] = ['ok' => true, 'critical' => false, 'detail' => 'heartbeat unavailable'];
        }

        // Dual-store (MySQL ↔ per-form SQLite) drift — cheap file-level check only (forms rows vs
        // SQLite files vs upload dirs); the full per-form count reconcile is `bin/reconcile.php`.
        try {
            $formsPath = $this->settings['sqlite']['storage_path'] ?? ($base . '/storage/forms');
            $uploadsPath = $this->settings['uploads']['storagePath'] ?? ($base . '/storage/uploads');
            $recon = new ReconcileService($this->db->getConnection(), new SQLiteConnection($formsPath), $formsPath, $uploadsPath);
            $drift = $recon->fileDrift();
            $total = count($drift['missingSqlite']) + count($drift['orphanedSqlite']) + count($drift['orphanedUploads']);
            $checks['dual_store'] = [
                'ok' => true, // non-critical: drift is a maintenance issue, not an outage
                'critical' => false,
                'detail' => $total === 0 ? 'no file-level drift' : sprintf(
                    '%d missing SQLite, %d orphaned SQLite, %d orphaned upload dirs',
                    count($drift['missingSqlite']), count($drift['orphanedSqlite']), count($drift['orphanedUploads'])
                ),
            ];
            if ($total > 0) {
                $checks['dual_store']['warning'] = 'run bin/reconcile.php to review/repair store drift';
            }
        } catch (\Throwable $e) {
            $checks['dual_store'] = ['ok' => true, 'critical' => false, 'detail' => 'unavailable'];
        }

        // AI — optional feature; report config status WITHOUT exposing the key (host/scheme only).
        // Provider-neutral AI_* names take precedence over the legacy OPENAI_* names.
        $aiKey = (string) ($_ENV['AI_API_KEY'] ?? $_ENV['OPENAI_API_KEY'] ?? '');
        $aiUrl = (string) ($_ENV['AI_BASE_URL'] ?? $_ENV['OPENAI_API_URL'] ?? 'https://api.openai.com/v1');
        $aiScheme = strtolower((string) parse_url($aiUrl, PHP_URL_SCHEME));
        $aiHost = (string) parse_url($aiUrl, PHP_URL_HOST);
        $isProd = (bool) ($this->settings['isProduction'] ?? true);
        $isCustom = $aiHost !== '' && stripos($aiHost, 'openai.com') === false;
        // A custom (local/self-hosted) endpoint may run keyless; the default OpenAI endpoint needs a key.
        $configured = $aiKey !== '' || $isCustom;
        $insecureAi = $isProd && $aiKey !== '' && $aiScheme === 'http'
            && !in_array(strtolower((string) ($_ENV['ALLOW_INSECURE_LOCAL_AI'] ?? '')), ['1', 'true', 'yes'], true);
        if (!$configured) {
            $checks['ai'] = ['ok' => true, 'critical' => false, 'detail' => 'not configured (AI features disabled)'];
        } elseif ($insecureAi) {
            $checks['ai'] = [
                'ok' => true, 'critical' => false, 'detail' => 'configured but blocked',
                'warning' => 'AI key would be sent over http:// in production — key disabled for safety. Use https, set ALLOW_INSECURE_LOCAL_AI for a loopback model, or run the local endpoint keyless.',
            ];
        } else {
            $detail = $isCustom
                ? ('configured (local/self-hosted: ' . $aiHost . ($aiKey === '' ? ', keyless' : '') . ')')
                : 'configured (OpenAI)';
            $checks['ai'] = ['ok' => true, 'critical' => false, 'detail' => $detail];
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
