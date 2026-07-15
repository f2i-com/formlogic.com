<?php

declare(strict_types=1);

use Monolog\Logger;
use FormLogic\Support\Environment;

// Determine if we're in production mode.
// Safe-by-default: any value other than an explicit 'development' is treated as
// production, so a missing/typo'd APP_ENV never silently exposes debug details.
$isProduction = (Environment::get('APP_ENV', 'production') !== 'development');

// Get JWT secret - fail hard in production if using a default/placeholder value.
$jwtSecret = Environment::get('JWT_SECRET', 'formlogic-dev-jwt-secret-change!');
$jwtPlaceholders = [
    'formlogic-dev-jwt-secret-change!',
    'your-super-secret-jwt-key-change-in-production',
    'change-me', 'changeme', 'secret', 'your-secret-key',
];
$isPlaceholderSecret = in_array(strtolower($jwtSecret), array_map('strtolower', $jwtPlaceholders), true);
if ($isProduction && (strlen($jwtSecret) < 32 || $isPlaceholderSecret)) {
    throw new \RuntimeException(
        'SECURITY ERROR: JWT_SECRET must be set to a secure, non-placeholder value (minimum 32 characters) in production. ' .
        'Generate one with: openssl rand -base64 32'
    );
}

// Get DB password - fail hard in production if using default
// $_ENV first, real process env second. PHP CLIs (bin/upgrade.php, scripts/provision-demo.php)
// and `php -S` can run with a variables_order that omits E, leaving $_ENV empty even when the
// process environment (CI job env, docker -e, systemd Environment=) carries the value — and
// IMMUTABLE Dotenv skips writing a var into $_ENV when it already exists in the environment
// ($_SERVER counts), so relying on $_ENV alone silently falls back to defaults. (This exact
// interaction broke the E2E release gate's provision step.)
$envOr = static fn (string $key, ?string $default = null): ?string => Environment::nonEmpty($key, $default);
$dbPassword = $envOr('DB_PASSWORD', 'password');
if ($isProduction && $dbPassword === 'password') {
    throw new \RuntimeException(
        'SECURITY ERROR: DB_PASSWORD must be set to a secure value in production.'
    );
}

// Cloud plan enforcement (hosted SaaS only). OFF by default so self-hosters are
// unlimited. If a hosted operator turns it on in production, PayPal must be configured
// or users would hit limits with no way to pay to lift them.
$cloudPlanEnforced = filter_var(Environment::get('CLOUD_PLAN_ENFORCED', 'false'), FILTER_VALIDATE_BOOLEAN);

// Public-beta mode: free signup for a limited window, payments disabled, nothing enforced — so people
// can test without paying while the product is still maturing. New accounts get BETA_FREE_DAYS of Cloud
// (default 90 = ~3 months) as a runway for when the beta ends and enforcement is switched on. While
// BETA_MODE is on we DON'T enforce the plan (no lockouts) and don't require PayPal.
$betaMode = filter_var(Environment::get('BETA_MODE', 'false'), FILTER_VALIDATE_BOOLEAN);
$signupFreeDays = $betaMode ? max(1, (int) Environment::get('BETA_FREE_DAYS', '90')) : 30;
if ($betaMode) {
    $cloudPlanEnforced = false;
}

// Support / contact address shown to users when transactional email isn't configured yet (e.g. a
// fresh install with no SMTP) — the password-reset page points people here to reset or verify by hand.
$supportEmail = trim((string) Environment::get('SUPPORT_EMAIL', '')) ?: 'hello@formlogic.com';

if ($isProduction && $cloudPlanEnforced) {
    $missingPaypal = array_values(array_filter(
        ['PAYPAL_CLIENT_ID', 'PAYPAL_SECRET'],
        fn($k) => Environment::nonEmpty($k) === null
    ));
    if ($missingPaypal) {
        throw new \RuntimeException(
            'CONFIG ERROR: CLOUD_PLAN_ENFORCED=true requires PayPal billing to be configured (missing: ' .
            implode(', ', $missingPaypal) . '). Otherwise users would hit plan limits with no way to pay to lift them.'
        );
    }
}

// Platform-administrator bootstrap: a comma-separated email allowlist. Accounts
// matching it are treated as admins even before the users.is_admin flag is set —
// the way the FIRST admin gets into the admin panel (which can then grant the
// durable flag to itself/others).
$adminEmails = array_values(array_filter(array_map(
    'trim',
    explode(',', (string) Environment::get('ADMIN_EMAILS', ''))
)));

return [
    'settings' => [
        'displayErrorDetails' => !$isProduction && Environment::get('APP_DEBUG', 'false') === 'true',
        'logErrors' => true,
        'logErrorDetails' => !$isProduction,
        'supportEmail' => $supportEmail,
        'isProduction' => $isProduction,
        'adminEmails' => $adminEmails,

        'logger' => [
            'name' => 'formlogic',
            'path' => __DIR__ . '/../logs/app.log',
            'level' => $isProduction ? Logger::WARNING : Logger::DEBUG,
        ],

        'mysql' => [
            'host' => $envOr('DB_HOST', 'localhost'),
            'port' => $envOr('DB_PORT', '3306'),
            'database' => $envOr('DB_DATABASE', 'formlogic'),
            'username' => $envOr('DB_USERNAME', 'formlogic'),
            'password' => $dbPassword,
            'charset' => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
        ],

        'jwt' => [
            'secret' => $jwtSecret,
            'expiry' => (int) Environment::get('JWT_EXPIRY', '86400'),
            'algorithm' => 'HS256',
            'issuer' => Environment::get('JWT_ISSUER', 'formlogic'),
            'audience' => Environment::get('JWT_AUDIENCE', 'formlogic-api'),
        ],

        // Cookie settings for secure authentication.
        // The Secure flag is deployment policy, not a developer-diagnostics switch
        // (audit DEPLOY-001): COOKIE_SECURE=true/false pins it explicitly (e.g. an
        // HTTPS dev vhost sets true; a deliberate plain-HTTP intranet deploy sets
        // false). When unset it falls back to the safe default — Secure everywhere
        // except explicit development mode.
        'cookie' => [
            'name' => 'formlogic_auth',
            'httpOnly' => true,
            'secure' => in_array(strtolower((string) Environment::get('COOKIE_SECURE', '')), ['true', 'false'], true)
                ? strtolower((string) Environment::get('COOKIE_SECURE', '')) === 'true'
                : $isProduction,
            'sameSite' => 'Lax', // Provides CSRF protection while allowing normal navigation
            'path' => '/',
            'domain' => Environment::get('COOKIE_DOMAIN', ''), // Empty = current domain only
        ],

        'sqlite' => [
            'storage_path' => __DIR__ . '/../' . Environment::get('SQLITE_STORAGE_PATH', 'storage/forms'),
        ],

        'cors' => [
            'origin' => Environment::get('CORS_ORIGIN', 'http://localhost:5173'),
            'allowedOrigins' => array_filter(
                array_map('trim', explode(',', Environment::get('CORS_ALLOWED_ORIGINS', ''))),
                fn($o) => !empty($o)
            ) ?: null, // null means use single origin mode
        ],

        'rateLimit' => [
            'login' => [
                'maxAttempts' => (int) Environment::get('LOGIN_MAX_ATTEMPTS', '5'),
                'decayMinutes' => (int) Environment::get('LOGIN_DECAY_MINUTES', '15'),
            ],
        ],

        'uploads' => [
            'maxFileSize' => (int) Environment::get('UPLOAD_MAX_FILE_SIZE', (string) (10 * 1024 * 1024)), // 10MB default
            'allowedTypes' => [
                'application/pdf',
                'application/msword',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'image/jpeg',
                'image/png',
                'image/gif',
                'image/webp',
            ],
        ],

        'packs' => [
            'storagePath' => __DIR__ . '/../storage/packs',
            'maxZipSize' => 50 * 1024 * 1024, // 50MB
            'allowedFileTypes' => ['application/zip', 'application/x-zip-compressed'],
        ],

        // Account backups (Settings → Backup & restore): a full-workspace zip —
        // apps/forms/flows structure + per-form SQLite record databases + uploaded
        // files. The zip cap feeds the exact authenticated backup route policy
        // in public/index.php; the other caps bound the import validator.
        'backups' => [
            'maxZipSize' => (int) Environment::get('BACKUP_MAX_ZIP_SIZE', (string) (200 * 1024 * 1024)),
            'maxEntryBytes' => (int) Environment::get('BACKUP_MAX_ENTRY_BYTES', (string) (256 * 1024 * 1024)),
            'maxTotalUncompressed' => (int) Environment::get('BACKUP_MAX_TOTAL_BYTES', (string) (1024 * 1024 * 1024)),
            'maxResponsesPerForm' => (int) Environment::get('BACKUP_MAX_RESPONSES_PER_FORM', '200000'),
            'maxForms' => 500,
            'maxApps' => 100,
            'maxFlows' => 200,
            'maxBindings' => 400,
            // Scheduled nightly backups (bin/backup-accounts.php): dated folders of
            // per-account zips + a whole-site MySQL dump, pruned to retentionDays.
            'retentionDays' => max(1, (int) Environment::get('BACKUP_RETENTION_DAYS', '7')),
            'scheduledIncludeFiles' => strtolower((string) Environment::get('BACKUP_INCLUDE_FILES', 'true')) !== 'false',
        ],

        // Recycle bin: user-facing deletes of forms/apps/flows capture a restorable
        // snapshot first (hard delete unchanged); snapshots purge after retentionDays.
        'trash' => [
            'retentionDays' => max(1, (int) Environment::get('TRASH_RETENTION_DAYS', '30')),
        ],

        // Hosted-cloud plan limits. Only enforced when planEnforced is true (hosted SaaS);
        // self-hosted installs leave it false and stay unlimited.
        'cloud' => [
            'planEnforced' => $cloudPlanEnforced,
            'betaMode' => $betaMode,
            'signupFreeDays' => $signupFreeDays,
            'maxForms' => (int) Environment::get('CLOUD_MAX_FORMS', '100'),
            'maxStorageBytes' => (int) Environment::get('CLOUD_MAX_STORAGE_BYTES', (string) (1024 * 1024 * 1024)), // 1 GB
        ],
    ],
];
