<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\ReconcileService;
use FormLogic\Services\AIService;
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
        return $this->json($response, [
            'status' => 'ok',
            'timestamp' => date('c'),
            // Public flag so the SPA can show the "free while in beta" banner + signup note pre-auth.
            'betaMode' => (bool) ($this->settings['cloud']['betaMode'] ?? false),
        ]);
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

        // Email delivery — non-critical, but launch-important: invitations + password resets depend on
        // it. Surfaces the silent traps (no from-address; SMTP set but symfony/mailer not installed).
        try {
            $email = (new \FormLogic\Services\EmailService())->deliveryStatus();
            $checks['email'] = [
                'ok' => true,
                'critical' => false,
                'detail' => $email['configured'] ? ('delivery via ' . $email['path']) : 'not configured (link-only)',
            ];
            if ($email['warning'] !== null) {
                $checks['email']['warning'] = $email['warning'];
            }
        } catch (\Throwable $e) {
            $checks['email'] = ['ok' => true, 'critical' => false, 'detail' => 'unavailable'];
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
        $aiHost = (string) parse_url($aiUrl, PHP_URL_HOST);
        $isProd = (bool) ($this->settings['isProduction'] ?? true);
        $isCustom = $aiHost !== '' && stripos($aiHost, 'openai.com') === false;
        // A custom (local/self-hosted) endpoint may run keyless; the default OpenAI endpoint needs a key.
        $configured = $aiKey !== '' || $isCustom;
        // Reuse AIService's exact guard so the diagnostic matches the runtime (incl. IPv6-loopback).
        $insecureAi = AIService::keyBlockedOverHttp($aiUrl, $aiKey, $isProd);
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

        // Signing / native-runtime trust — Ed25519 (libsodium) lets the native runtime and package
        // importers verify signed manifests/packages against the PUBLIC key. HMAC fallback works only
        // for same-server verification, so native trust is degraded. Non-critical (self-host installs
        // may not use the native runtime), but warned so an operator knows why native trust is off.
        try {
            $signing = new \FormLogic\Services\SigningService($this->db);
            $ed = $signing->isEd25519();
            $requireEd = ($_ENV['NATIVE_TRUST_REQUIRES_ED25519'] ?? '1') !== '0';
            $checks['signing'] = [
                'ok' => $ed || !$requireEd,
                'critical' => false,
                'detail' => $ed
                    ? ('Ed25519 (' . $signing->keyId() . ($signing->hasStoredKeypair() ? ', keypair present' : ', keypair generated on first use') . ')')
                    : 'HMAC fallback (HS256) — not publicly/native-verifiable',
            ];
            if (!$ed) {
                $checks['signing']['warning'] = 'libsodium/Ed25519 unavailable: the native runtime and package importers cannot verify signatures. Install ext-sodium for native-runtime trust.';
            }
        } catch (\Throwable $e) {
            $checks['signing'] = ['ok' => true, 'critical' => false, 'detail' => 'unavailable'];
        }

        // Platform tables — custom domains + the offline-sync idempotency ledger. Non-critical:
        // absence means the schema init hasn't run for these features, not an outage.
        try {
            $conn = $this->db->getConnection();
            foreach (['app_domains' => 'custom domains', 'app_submission_idempotency' => 'offline sync idempotency'] as $table => $label) {
                $stmt = $conn->query('SHOW TABLES LIKE ' . $conn->quote($table));
                $present = $stmt && $stmt->fetchColumn() !== false;
                $checks["table:$table"] = [
                    'ok' => $present,
                    'critical' => false,
                    'detail' => $present ? "present ($label)" : "missing ($label) — run schema init",
                ];
            }
        } catch (\Throwable $e) {
            $checks['platform_tables'] = ['ok' => true, 'critical' => false, 'detail' => 'unavailable'];
        }

        // Native runtime build config (informational) — the Tauri shell that hosts custom apps.
        $tauriConf = dirname($base) . '/native-runtime/src-tauri/tauri.conf.json';
        $hasNative = is_file($tauriConf);
        $checks['native_runtime'] = [
            'ok' => true,
            'critical' => false,
            'detail' => $hasNative ? 'tauri.conf.json present' : 'native runtime config not found (optional)',
        ];

        // ZipArchive (ext-zip) — application-package import/export reads/writes .fla archives. Non-critical:
        // absence just disables package import/export, not the running app.
        try {
            $hasZip = class_exists('ZipArchive');
            $checks['ziparchive'] = [
                'ok' => $hasZip,
                'critical' => false,
                'detail' => $hasZip ? 'ext-zip present (application-package import available)' : 'ext-zip missing',
            ];
            if (!$hasZip) {
                $checks['ziparchive']['warning'] = 'PHP ext-zip (ZipArchive) not installed — application-package import/export is disabled. Install ext-zip.';
            }
        } catch (\Throwable $e) {
            $checks['ziparchive'] = ['ok' => true, 'critical' => false, 'detail' => 'unavailable'];
        }

        // Signing keypair presence — surfaces whether a manifest/package signing keypair has actually been
        // generated + persisted yet (it is generated lazily on first signing use). Non-critical.
        try {
            $signingKp = new \FormLogic\Services\SigningService($this->db);
            $hasKp = $signingKp->hasStoredKeypair();
            $checks['signing_keypair'] = [
                'ok' => true,
                'critical' => false,
                'detail' => $hasKp ? 'keypair generated + stored' : 'no keypair yet (generated on first manifest/package signing)',
            ];
        } catch (\Throwable $e) {
            $checks['signing_keypair'] = ['ok' => true, 'critical' => false, 'detail' => 'unavailable'];
        }

        // app_domains per-domain config columns (native/PWA/security) — present after schema init that added
        // the multi-config columns. Non-critical: absence means the migration hasn't run for these features.
        try {
            $conn = $this->db->getConnection();
            $missingDomainCols = [];
            foreach (['native_config', 'pwa_config', 'security_config'] as $col) {
                $stmt = $conn->query('SHOW COLUMNS FROM app_domains LIKE ' . $conn->quote($col));
                if (!$stmt || $stmt->fetchColumn() === false) {
                    $missingDomainCols[] = $col;
                }
            }
            $checks['app_domains_columns'] = [
                'ok' => $missingDomainCols === [],
                'critical' => false,
                'detail' => $missingDomainCols === []
                    ? 'native_config/pwa_config/security_config present'
                    : 'missing: ' . implode(', ', $missingDomainCols) . ' — run schema init',
            ];
        } catch (\Throwable $e) {
            $checks['app_domains_columns'] = ['ok' => true, 'critical' => false, 'detail' => 'unavailable'];
        }

        // pack_catalog marketplace columns (item_type/trust_level) — present after the marketplace schema
        // migration. Non-critical: absence means catalog listings default to application_package/community.
        try {
            $conn = $this->db->getConnection();
            $missingCatalogCols = [];
            foreach (['item_type', 'trust_level'] as $col) {
                $stmt = $conn->query('SHOW COLUMNS FROM pack_catalog LIKE ' . $conn->quote($col));
                if (!$stmt || $stmt->fetchColumn() === false) {
                    $missingCatalogCols[] = $col;
                }
            }
            $checks['pack_catalog_columns'] = [
                'ok' => $missingCatalogCols === [],
                'critical' => false,
                'detail' => $missingCatalogCols === []
                    ? 'item_type/trust_level present (marketplace)'
                    : 'missing: ' . implode(', ', $missingCatalogCols) . ' — run schema init',
            ];
        } catch (\Throwable $e) {
            $checks['pack_catalog_columns'] = ['ok' => true, 'critical' => false, 'detail' => 'unavailable'];
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
