<?php
/**
 * FormLogic Installation Wizard
 *
 * A browser-based installer AND upgrader for FormLogic. It runs from either layout:
 *   - source checkout (WAMP/XAMPP/LAMP): http://localhost/<your-folder>/formlogic/install.php
 *     (default checkout: http://localhost/formlogic-app/formlogic/install.php)
 *   - deployed release zip: this file ships at the zip root, beside api/ —
 *     https://your-domain/install.php
 *
 * Fresh install: checks requirements and file permissions (fixing what it can and printing the
 * exact commands for what it can't — including the execute bit on the Linux qjs binary, which zip
 * extraction commonly drops), writes the backend .env with generated secrets, creates the database
 * + schema, and finishes with copy-paste cron lines for the maintenance CLIs.
 *
 * Upgrade: when a configured .env + a database with FormLogic's core tables are detected, the
 * wizard offers "Upgrade existing installation" — the same guarded, idempotent schema path as
 * api/bin/upgrade.php (MySQLConnection::initializeSchema + runMigrations), plus the schema_meta
 * stamp (upgrade_source=installer).
 *
 * IMPORTANT: Delete this file after installation is complete. It also hard-disables itself once a
 * configured .env exists — deliberately re-enable it with INSTALL_ENABLE=1 (e.g. `SetEnv
 * INSTALL_ENABLE 1` in the web-root .htaccess) to use the upgrade mode, then remove that again.
 */

declare(strict_types=1);

// Test harness: define FORMLOGIC_INSTALL_NO_RUN before requiring this file to load
// the function definitions only — every top-level wizard runtime step (guards,
// session, POST handling, HTML) is skipped. PHP hoists unconditional top-level
// function declarations at compile time, so they all remain callable.
if (defined('FORMLOGIC_INSTALL_NO_RUN')) {
    return;
}

// FormLogic installs from either layout:
//   - source checkout: this file sits beside backend/ and ui/
//   - deployed bundle:  this file sits beside api/ (the backend); the SPA is already built at the web root
// Resolve the backend accordingly. ui/ only exists in the source layout (the bundle ships a prebuilt SPA).
function flBackendDir(): string
{
    return is_dir(__DIR__ . '/api') ? __DIR__ . '/api' : __DIR__ . '/backend';
}
function flUiDir(): ?string
{
    return is_dir(__DIR__ . '/ui') ? __DIR__ . '/ui' : null;
}

// Prevent running if already installed and .env exists with a real JWT secret
$alreadyInstalled = false;
$envPath = flBackendDir() . '/.env';
if (file_exists($envPath)) {
    $envContent = file_get_contents($envPath);
    if (preg_match('/^JWT_SECRET=.{32,}/m', $envContent)) {
        $alreadyInstalled = true;
    }
}

// ---------------------------------------------------------------------------
// Installer access guard
// ---------------------------------------------------------------------------
// The installer is a powerful setup tool — lock it down so it can't be abused if it's
// accidentally left online. Allowed only from localhost, unless INSTALL_ENABLE=1 is set
// in the server environment (a deliberate opt-in for remote installs — e.g. `SetEnv
// INSTALL_ENABLE 1` in .htaccess). Once installed, the web installer is hard-disabled
// regardless of origin.
$installEnableRaw = getenv('INSTALL_ENABLE');
if ($installEnableRaw === false || $installEnableRaw === '') {
    // Apache `SetEnv INSTALL_ENABLE 1` surfaces here (mod_php / FPM) even when getenv() misses it.
    $installEnableRaw = $_SERVER['INSTALL_ENABLE'] ?? ($_SERVER['REDIRECT_INSTALL_ENABLE'] ?? '');
}
$installEnabled = in_array(strtolower((string) $installEnableRaw), ['1', 'true', 'yes'], true);
$remoteAddr = $_SERVER['REMOTE_ADDR'] ?? '';
$isLocalRequest = in_array($remoteAddr, ['127.0.0.1', '::1', 'localhost'], true);

$installerDenied = null;
$installerDeniedExtraHtml = '';
$backendRelName = basename(flBackendDir()); // 'api' (deployed zip) or 'backend' (source checkout)
if ($alreadyInstalled && !$installEnabled) {
    $installerDenied = 'FormLogic is already installed. For security the web installer disables itself '
        . 'once a configured ' . $backendRelName . '/.env exists — delete install.php now. '
        . 'To deliberately re-run it (e.g. to use the upgrade mode), set the environment variable INSTALL_ENABLE=1.';
    // The GET page gets the full upgrade story so an operator who lands here knows every path forward.
    $installerDeniedExtraHtml =
        '<h2 style="font-size:1.1rem;margin-top:1.5rem">Upgrading an existing installation?</h2>'
        . '<p>After replacing the files with a new release (keep <code>' . htmlspecialchars($backendRelName, ENT_QUOTES) . '/.env</code>'
        . ' and <code>' . htmlspecialchars($backendRelName, ENT_QUOTES) . '/storage/</code>!), any of these works:</p><ol>'
        . '<li>Recommended — the upgrade CLI, from a shell on the server:<br>'
        . '<code>php ' . htmlspecialchars($backendRelName, ENT_QUOTES) . '/bin/upgrade.php</code></li>'
        . '<li>Or just load the site once — pending schema migrations run automatically on the first request.</li>'
        . '<li>Or this wizard&#8217;s upgrade mode: temporarily add <code>SetEnv INSTALL_ENABLE 1</code> at the top of the'
        . ' web-root <code>.htaccess</code> (Apache), reload this page, run the upgrade — then'
        . ' <strong>remove that line and delete install.php</strong>.</li></ol>';
} elseif (!$isLocalRequest && !$installEnabled) {
    $installerDenied = 'For security, run the installer from the server itself (localhost), '
        . 'or set the environment variable INSTALL_ENABLE=1 to allow remote setup.';
    $installerDeniedExtraHtml =
        '<p style="margin-top:1rem">Installing over the network (e.g. a release zip uploaded to a remote host)?'
        . ' Temporarily add this line at the top of the web-root <code>.htaccess</code> (Apache), then reload:</p>'
        . '<pre style="background:#f1f5f9;padding:8px 12px;border-radius:8px"><code>SetEnv INSTALL_ENABLE 1</code></pre>'
        . '<p><strong>Remove the line and delete install.php as soon as you are done.</strong></p>';
}
if ($installerDenied !== null) {
    http_response_code(403);
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
        header('Content-Type: application/json');
        echo json_encode(['success' => false, 'message' => $installerDenied]);
    } else {
        header('Content-Type: text/html; charset=utf-8');
        echo '<!doctype html><meta charset="utf-8"><title>Installer disabled</title>'
            . '<body style="font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#0f172a">'
            . '<h1 style="font-size:1.4rem">Installer disabled</h1><p>'
            . htmlspecialchars($installerDenied, ENT_QUOTES) . '</p>'
            . $installerDeniedExtraHtml . '</body>';
    }
    exit;
}

// CSRF token
session_start();
if (empty($_SESSION['install_csrf'])) {
    $_SESSION['install_csrf'] = bin2hex(random_bytes(32));
}
$csrfToken = $_SESSION['install_csrf'];

// ---------------------------------------------------------------------------
// AJAX action handler
// ---------------------------------------------------------------------------
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['action'])) {
    header('Content-Type: application/json');

    // Verify CSRF token
    if (!isset($_POST['csrf']) || !hash_equals($csrfToken, $_POST['csrf'])) {
        echo json_encode(['success' => false, 'message' => 'Invalid security token. Please refresh the page.']);
        exit;
    }

    switch ($_POST['action']) {
        case 'check_requirements':
            echo json_encode(checkRequirements());
            exit;

        case 'test_database':
            echo json_encode(testDatabase($_POST));
            exit;

        case 'run_install':
            echo json_encode(runInstall($_POST));
            exit;

        case 'detect_install':
            echo json_encode(detectExistingInstall());
            exit;

        case 'run_upgrade':
            echo json_encode(runUpgrade());
            exit;
    }

    echo json_encode(['success' => false, 'message' => 'Unknown action']);
    exit;
}

// ---------------------------------------------------------------------------
// Input sanitization helpers
// ---------------------------------------------------------------------------
function sanitizeIdentifier(string $value): string
{
    // Only allow alphanumeric, underscore, hyphen for DB identifiers
    return preg_replace('/[^a-zA-Z0-9_\-]/', '', $value);
}

function sanitizeEnvValue(string $value): string
{
    // Strip newlines and carriage returns to prevent .env injection
    return str_replace(["\r", "\n", "\0"], '', $value);
}

/**
 * Encode a value for a .env line that vlucas/phpdotenv (used by the backend) will parse back
 * verbatim. Plain values stay bare for readability; anything with characters phpdotenv treats
 * specially — spaces (parse error), '#' (inline comment), quotes, '$' (${VAR} interpolation),
 * or trailing whitespace — is double-quoted with '\', '"' and '$' escaped. Without this, a DB
 * password like "p@ss word" or "a#b" is silently truncated or crashes the backend on boot.
 */
function envEncode(string $value): string
{
    if ($value === '') {
        return '';
    }
    // A conservative "obviously safe" charset can be written unquoted (covers hosts, ports,
    // typical CORS origins like http://localhost:5173).
    if (preg_match('#^[A-Za-z0-9_.:/@-]+$#', $value)) {
        return $value;
    }
    return '"' . str_replace(['\\', '"', '$'], ['\\\\', '\\"', '\\$'], $value) . '"';
}

/**
 * Render the generated backend .env from the shipped .env.example template.
 *
 * Replacements use preg_replace_callback so each value is treated as a LITERAL — a
 * plain preg_replace interprets '$1'/'\1' in the value as backreferences, which would
 * corrupt any password containing '$' followed by a digit (e.g. "pa$1ss" -> "pass").
 * envEncode() then makes each value safe for phpdotenv to read back exactly.
 *
 * Production-safe by default (audit DEPLOY-001): APP_ENV/APP_DEBUG are ALWAYS
 * written — production/false unless the operator explicitly selected the
 * development install mode — so a deployment can never silently inherit
 * .env.example's development defaults.
 *
 * @param array{devMode:bool,dbHost:string,dbPort:string,dbName:string,dbUser:string,dbPass:string,corsOrigin:string,jwtSecret:string,auditKey:string} $values
 */
function flRenderEnvContent(string $template, array $values): string
{
    $replacements = [
        '/^APP_ENV=.*/m' => 'APP_ENV=' . ($values['devMode'] ? 'development' : 'production'),
        '/^APP_DEBUG=.*/m' => 'APP_DEBUG=' . ($values['devMode'] ? 'true' : 'false'),
        '/^DB_HOST=.*/m' => 'DB_HOST=' . envEncode($values['dbHost']),
        '/^DB_PORT=.*/m' => 'DB_PORT=' . $values['dbPort'],             // digit-validated by the caller
        '/^DB_DATABASE=.*/m' => 'DB_DATABASE=' . envEncode($values['dbName']),
        '/^DB_USERNAME=.*/m' => 'DB_USERNAME=' . envEncode($values['dbUser']),
        '/^DB_PASSWORD=.*/m' => 'DB_PASSWORD=' . envEncode($values['dbPass']),
        '/^JWT_SECRET=.*/m' => 'JWT_SECRET=' . $values['jwtSecret'],    // generated hex
        '/^CORS_ORIGIN=.*/m' => 'CORS_ORIGIN=' . envEncode($values['corsOrigin']),
        '/^# AUDIT_HMAC_KEY=.*/m' => 'AUDIT_HMAC_KEY=' . $values['auditKey'], // generated hex
    ];
    foreach ($replacements as $pattern => $replacement) {
        $template = preg_replace_callback($pattern, static fn () => $replacement, $template, 1);
    }
    return $template;
}

// ---------------------------------------------------------------------------
// Requirement checks
// ---------------------------------------------------------------------------
function checkRequirements(): array
{
    $checks = [];

    // PHP version
    $phpVersion = PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION . '.' . PHP_RELEASE_VERSION;
    $checks['php_version'] = [
        'label' => 'PHP Version',
        'required' => '>= 8.2',
        'current' => $phpVersion,
        'pass' => version_compare($phpVersion, '8.2.0', '>='),
    ];

    // Extensions
    $requiredExtensions = ['pdo_mysql', 'pdo_sqlite', 'mbstring', 'json', 'openssl', 'fileinfo'];
    foreach ($requiredExtensions as $ext) {
        $checks['ext_' . $ext] = [
            'label' => "PHP Extension: $ext",
            'required' => 'Installed',
            'current' => extension_loaded($ext) ? 'Installed' : 'Missing',
            'pass' => extension_loaded($ext),
        ];
    }

    // Composer dependencies
    $vendorExists = is_dir(flBackendDir() . '/vendor');
    $checks['composer'] = [
        'label' => 'Composer Dependencies',
        'required' => 'Installed',
        'current' => $vendorExists ? 'Installed' : 'Not installed',
        'pass' => $vendorExists,
        'help' => $vendorExists ? '' : 'Run: cd backend && composer install',
    ];

    // Write permissions — the wizard tries to FIX what it can first (create missing dirs, loosen
    // the mode when PHP owns the dir) and prints the exact commands for anything it can't.
    $backendRel = basename(flBackendDir()); // 'api' (deployed) or 'backend' (source)
    $isWin = stripos(PHP_OS, 'WIN') === 0;
    $dirsToCheck = [
        $backendRel . '/storage/forms',
        $backendRel . '/storage/packs',
        $backendRel . '/storage/uploads',
        $backendRel . '/storage/pack-screenshots',
        $backendRel . '/logs',
    ];
    foreach ($dirsToCheck as $dir) {
        $fullPath = __DIR__ . '/' . $dir;
        $fixed = false;
        if (!is_dir($fullPath) && @mkdir($fullPath, 0750, true)) {
            $fixed = true;
        }
        if (is_dir($fullPath) && !is_writable($fullPath)) {
            @chmod($fullPath, 0770);
            $fixed = is_writable($fullPath);
        }
        $exists = is_dir($fullPath);
        $writable = $exists && is_writable($fullPath);
        $help = '';
        if (!$writable) {
            $help = $isWin
                ? 'Grant the web server user Modify rights on this folder (Properties > Security).'
                : 'Run on the server: sudo mkdir -p "' . $fullPath . '" && sudo chown -R www-data "' . $fullPath . '"'
                    . '  (web user: www-data on Debian/Ubuntu, apache on RHEL — or use: sudo chmod -R 775 "' . $fullPath . '")';
        }
        $checks['dir_' . str_replace('/', '_', $dir)] = [
            'label' => "Directory: $dir",
            'required' => 'Writable',
            'current' => !$exists ? 'Does not exist' : ($writable ? ($fixed ? 'Writable (fixed by the wizard)' : 'Writable') : 'Not writable'),
            'pass' => $writable,
            'help' => $help,
        ];
    }

    // FormLogic qjs sandbox binary (server-side script runtime). Presence on every platform; on
    // Linux/macOS ALSO the execute bit — zip extraction commonly drops it — with a chmod attempt
    // before asking the operator to do it.
    $qjsBin = $isWin
        ? flBackendDir() . '/bin/qjs/qjs-windows-x86_64.exe'
        : flBackendDir() . '/bin/qjs/qjs-linux-x86_64';
    $qjsExists = file_exists($qjsBin);
    $qjsFixed = false;
    if ($qjsExists && !$isWin && !is_executable($qjsBin)) {
        @chmod($qjsBin, 0755);
        $qjsFixed = is_executable($qjsBin);
    }
    $qjsOk = $qjsExists && ($isWin || is_executable($qjsBin));
    $checks['qjs'] = [
        'label' => 'FormLogic qjs Runtime',
        'required' => $isWin ? 'Present' : 'Present & executable',
        'current' => !$qjsExists
            ? 'Missing'
            : ($qjsOk ? ($qjsFixed ? 'Executable (execute bit restored by the wizard)' : 'Present') : 'Present but NOT executable'),
        'pass' => $qjsOk,
        'help' => !$qjsExists
            ? 'Vendored under ' . $backendRel . '/bin/qjs; re-clone the repo or fetch qjs from github.com/quickjs-ng/quickjs'
            : ($qjsOk ? '' : 'Zip extraction drops the execute bit — run on the server: chmod +x "' . $qjsBin . '"'),
    ];

    // Node.js / npm are ONLY needed to BUILD the frontend from source — the deployed bundle ships a
    // prebuilt SPA, so skip these checks entirely there (no Node required on the server).
    if (flUiDir() !== null) {
        $nodeVersion = '';
        $npmVersion = '';
        $nodeOk = false;
        // Initialize so the checks below are safe even when exec() is disabled (shared hosting),
        // which would otherwise leave these unset and emit warnings that corrupt the JSON response.
        $nodeOut = $npmOut = [];
        $nodeRc = $npmRc = 1;
        if (function_exists('exec')) {
            if (strtoupper(substr(PHP_OS, 0, 3)) === 'WIN') {
                exec('node -v 2>NUL', $nodeOut, $nodeRc);
                exec('npm -v 2>NUL', $npmOut, $npmRc);
            } else {
                exec('node -v 2>/dev/null', $nodeOut, $nodeRc);
                exec('npm -v 2>/dev/null', $npmOut, $npmRc);
            }
        }
        if ($nodeRc === 0 && !empty($nodeOut[0])) {
            $nodeVersion = trim($nodeOut[0]);
            $major = (int) ltrim($nodeVersion, 'v');
            // Vite 7 requires Node 20.19+ or 22.12+ (major 20+ covers the common case).
            $nodeOk = $major >= 20;
        }
        $checks['node'] = [
            'label' => 'Node.js (only to build the frontend)',
            'required' => '>= 20.19 / 22.12',
            'current' => $nodeVersion ?: 'Not found in PATH',
            'pass' => $nodeOk,
            'help' => $nodeOk ? '' : 'Only needed to build the UI from source. Install Node 20.19+/22.12+ from nodejs.org, or with nvm: `nvm install 22 && nvm use 22`. (The deploy bundle ships a prebuilt UI and needs no Node.)',
        ];
        $checks['npm'] = [
            'label' => 'npm',
            'required' => 'Installed',
            'current' => (!empty($npmOut[0])) ? trim($npmOut[0]) : 'Not found',
            'pass' => !empty($npmOut[0]),
        ];
    }

    $allPass = true;
    // Only PHP + extensions are hard requirements for the wizard itself
    $criticalPass = true;
    foreach ($checks as $key => $check) {
        if (!$check['pass']) {
            $allPass = false;
            if (str_starts_with($key, 'php_') || str_starts_with($key, 'ext_')) {
                $criticalPass = false;
            }
        }
    }

    return ['checks' => $checks, 'allPass' => $allPass, 'criticalPass' => $criticalPass];
}

// ---------------------------------------------------------------------------
// Database test
// ---------------------------------------------------------------------------
function testDatabase(array $data): array
{
    $host = $data['db_host'] ?? 'localhost';
    $port = $data['db_port'] ?? '3306';
    $user = $data['db_user'] ?? 'root';
    $pass = $data['db_pass'] ?? '';
    $name = sanitizeIdentifier($data['db_name'] ?? 'formlogic');

    if (!ctype_digit((string) $port) || (int) $port < 1 || (int) $port > 65535) {
        return ['success' => false, 'message' => 'Port must be a number between 1 and 65535.'];
    }
    if (empty($name)) {
        return ['success' => false, 'message' => 'Database name is required.'];
    }

    try {
        $dsn = "mysql:host=$host;port=$port;charset=utf8mb4";
        $pdo = new PDO($dsn, $user, $pass, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_TIMEOUT => 5,
        ]);

        // Check if database exists
        $stmt = $pdo->query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = " . $pdo->quote($name));
        $dbExists = (bool) $stmt->fetch();

        // Check MySQL version
        $versionRow = $pdo->query("SELECT VERSION() AS v")->fetch();
        $mysqlVersion = $versionRow['v'] ?? 'Unknown';

        return [
            'success' => true,
            'message' => 'Connection successful',
            'dbExists' => $dbExists,
            'mysqlVersion' => $mysqlVersion,
        ];
    } catch (\PDOException $e) {
        $msg = $e->getMessage();
        // Return safe error messages, not raw PDO exceptions
        if (str_contains($msg, 'Connection refused')) {
            return ['success' => false, 'message' => "Connection refused. Is MySQL running on $host:$port?"];
        } elseif (str_contains($msg, 'Access denied')) {
            return ['success' => false, 'message' => 'Access denied. Check your username and password.'];
        } elseif (str_contains($msg, 'getaddrinfo')) {
            return ['success' => false, 'message' => "Could not resolve host '$host'."];
        }
        return ['success' => false, 'message' => 'Connection failed. Check your database settings.'];
    }
}

// ---------------------------------------------------------------------------
// Run installation
// ---------------------------------------------------------------------------
function runInstall(array $data): array
{
    $steps = [];
    $backendDir = flBackendDir();
    $uiDir = flUiDir(); // null in the deployed bundle (SPA is already built at the web root)

    // 1. Create storage directories
    $dirs = [
        $backendDir . '/storage/forms',
        $backendDir . '/storage/packs',
        $backendDir . '/storage/uploads',
        $backendDir . '/storage/pack-screenshots',
        $backendDir . '/logs',
    ];
    foreach ($dirs as $dir) {
        if (!is_dir($dir)) {
            if (!mkdir($dir, 0750, true)) {
                $steps[] = ['label' => 'Create ' . basename($dir), 'status' => 'error', 'message' => 'Failed to create directory. Check permissions.'];
                return ['success' => false, 'steps' => $steps, 'message' => 'Could not create storage directories. Check permissions.'];
            }
        }
    }
    $steps[] = ['label' => 'Create storage directories', 'status' => 'ok'];

    // 2. Generate secrets
    $jwtSecret = bin2hex(random_bytes(32));
    $auditKey = bin2hex(random_bytes(32));
    $steps[] = ['label' => 'Generate security keys', 'status' => 'ok'];

    // 3. Validate and sanitize inputs
    $dbHost = sanitizeEnvValue($data['db_host'] ?? 'localhost');
    $dbPort = $data['db_port'] ?? '3306';
    $dbName = sanitizeIdentifier($data['db_name'] ?? 'formlogic');
    $dbUser = sanitizeEnvValue($data['db_user'] ?? 'root');
    $dbPass = sanitizeEnvValue($data['db_pass'] ?? '');
    $corsOrigin = sanitizeEnvValue($data['cors_origin'] ?? 'http://localhost:5173');
    // Production-safe by default (audit DEPLOY-001): only the explicit, clearly
    // labelled wizard checkbox keeps development mode. Development mode relaxes
    // real security behaviour (non-Secure auth cookies, verbose errors, relaxed
    // destination validation), so a generated deployment must never inherit it
    // from .env.example silently.
    $devMode = !empty($data['dev_mode']);

    if (!ctype_digit((string) $dbPort) || (int) $dbPort < 1 || (int) $dbPort > 65535) {
        $dbPort = '3306';
    }
    if (empty($dbName)) {
        $steps[] = ['label' => 'Validate inputs', 'status' => 'error', 'message' => 'Database name is required.'];
        return ['success' => false, 'steps' => $steps, 'message' => 'Invalid database name.'];
    }

    // 4. Create backend .env
    $envContent = file_get_contents($backendDir . '/.env.example');
    if ($envContent === false) {
        $steps[] = ['label' => 'Read .env.example', 'status' => 'error', 'message' => 'Could not read backend/.env.example'];
        return ['success' => false, 'steps' => $steps, 'message' => 'Missing .env.example file'];
    }

    $envContent = flRenderEnvContent($envContent, [
        'devMode' => $devMode,
        'dbHost' => $dbHost,
        'dbPort' => $dbPort,
        'dbName' => $dbName,
        'dbUser' => $dbUser,
        'dbPass' => $dbPass,
        'corsOrigin' => $corsOrigin,
        'jwtSecret' => $jwtSecret,
        'auditKey' => $auditKey,
    ]);
    $steps[] = $devMode
        ? ['label' => 'Application mode', 'status' => 'warn',
            'message' => 'DEVELOPMENT mode selected — verbose errors and relaxed security policy. Never use this for a public site; edit APP_ENV=production in ' . basename($backendDir) . '/.env before going live.']
        : ['label' => 'Application mode', 'status' => 'ok', 'message' => 'Production (APP_ENV=production, APP_DEBUG=false)'];

    $envPath = $backendDir . '/.env';
    $envExists = file_exists($envPath);
    if ($envExists && empty($data['overwrite_env'])) {
        $steps[] = ['label' => 'Backend .env', 'status' => 'skip', 'message' => 'Already exists (not overwritten)'];
    } else {
        if (file_put_contents($envPath, $envContent) === false) {
            $steps[] = ['label' => 'Create backend .env', 'status' => 'error', 'message' => 'Could not write to backend/.env'];
            return ['success' => false, 'steps' => $steps, 'message' => 'Failed to create .env file. Check write permissions.'];
        }
        // Restrict .env file permissions (no effect on Windows, but important on Linux)
        @chmod($envPath, 0600);
        $steps[] = ['label' => 'Create backend .env', 'status' => 'ok'];
    }

    // 4. Create frontend .env (source layout only — the deployed bundle ships a prebuilt SPA that
    //    already calls /api on the same origin, so there's nothing to configure).
    if ($uiDir !== null) {
        $uiEnvPath = $uiDir . '/.env';
        if (!file_exists($uiEnvPath)) {
            $uiEnvExample = $uiDir . '/.env.example';
            if (file_exists($uiEnvExample)) {
                copy($uiEnvExample, $uiEnvPath);
            } else {
                file_put_contents($uiEnvPath, "VITE_API_URL=http://localhost:8080/api\n");
            }
            $steps[] = ['label' => 'Create frontend .env', 'status' => 'ok'];
        } else {
            $steps[] = ['label' => 'Frontend .env', 'status' => 'skip', 'message' => 'Already exists'];
        }
    }

    // 5. Create database and import schema
    $dbSchemaReady = false; // gate for the optional demo/marketplace seeding below
    if (!empty($dbPass) || $dbUser === 'root') {
        try {
            $dsn = "mysql:host=$dbHost;port=$dbPort;charset=utf8mb4";
            $pdo = new PDO($dsn, $dbUser, $dbPass, [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            ]);

            // Create database if needed (dbName is already sanitized to alphanumeric/underscore/hyphen)
            $safeName = str_replace('`', '', $dbName);
            $pdo->exec("CREATE DATABASE IF NOT EXISTS `$safeName` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
            $steps[] = ['label' => "Create database '$safeName'", 'status' => 'ok'];

            // Switch to the database
            $pdo->exec("USE `$safeName`");

            // Check if tables exist
            $stmt = $pdo->query("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = " . $pdo->quote($dbName));
            $tableCount = (int) $stmt->fetchColumn();

            if ($tableCount === 0) {
                $schemaPath = $backendDir . '/database/schema.sql';
                if (file_exists($schemaPath)) {
                    $sql = file_get_contents($schemaPath);
                    if ($sql !== false && !empty(trim($sql))) {
                        // Execute the full schema file via multi-statement exec
                        // PDO::exec handles multiple statements separated by semicolons
                        $pdo->setAttribute(PDO::ATTR_EMULATE_PREPARES, true);
                        $pdo->exec($sql);
                        $dbSchemaReady = true;
                        $steps[] = ['label' => 'Import database schema', 'status' => 'ok'];
                    } else {
                        $steps[] = ['label' => 'Import schema', 'status' => 'warn', 'message' => 'schema.sql is empty — tables will be auto-created on first request'];
                    }
                } else {
                    $steps[] = ['label' => 'Import schema', 'status' => 'warn', 'message' => 'schema.sql not found — tables will be auto-created on first request'];
                }
            } else {
                $dbSchemaReady = true;
                $steps[] = ['label' => 'Database schema', 'status' => 'skip', 'message' => "Database already has $tableCount tables"];
            }
        } catch (\PDOException $e) {
            $msg = $e->getMessage();
            // Return safe error messages
            if (str_contains($msg, 'Access denied')) {
                $msg = 'Access denied. Check your database credentials.';
            } elseif (str_contains($msg, 'Connection refused')) {
                $msg = 'Connection refused. Is MySQL running?';
            } else {
                // Strip file paths and internal details (both Unix "/path" and Windows "C:\path")
                $msg = preg_replace('#\sin\s+(?:/|[A-Za-z]:\\\\).*$#s', '', $msg);
                $msg = 'Database error: ' . trim(substr($msg, 0, 200));
            }
            $steps[] = ['label' => 'Database setup', 'status' => 'error', 'message' => $msg];
        }
    } else {
        $steps[] = ['label' => 'Database setup', 'status' => 'skip', 'message' => 'No password provided — set DB_PASSWORD in backend/.env and the schema will auto-create on first request'];
    }

    // 6. Check composer dependencies
    if (!is_dir($backendDir . '/vendor')) {
        $steps[] = ['label' => 'Composer dependencies', 'status' => 'warn', 'message' => 'Not installed. Run: cd backend && composer install'];
    } else {
        $steps[] = ['label' => 'Composer dependencies', 'status' => 'ok'];
    }

    // 7. Check npm dependencies (source layout only — the deployed bundle ships the built SPA).
    if ($uiDir !== null) {
        if (!is_dir($uiDir . '/node_modules')) {
            $steps[] = ['label' => 'npm dependencies', 'status' => 'warn', 'message' => 'Not installed. Run: cd ui && npm install'];
        } else {
            $steps[] = ['label' => 'npm dependencies', 'status' => 'ok'];
        }
    }

    // 8. Check FormLogic qjs runtime binary (on Linux: also fix/report the execute bit)
    $steps[] = flQjsStep();

    // 9. Optionally set up the demo + marketplace catalog (installable sample app packs + example
    //    data) by running the idempotent provisioning script. Best-effort: it needs a ready schema,
    //    Composer deps, and exec(); when any is missing we surface the manual command in Next steps.
    $demoManual = false;
    if (!empty($data['seed_demo'])) {
        $provision = $backendDir . '/scripts/provision-demo.php';
        $disabled = array_map('trim', explode(',', (string) ini_get('disable_functions')));
        $canExec = function_exists('exec') && !in_array('exec', $disabled, true);
        if (!$dbSchemaReady) {
            $steps[] = ['label' => 'Demo & marketplace', 'status' => 'skip', 'message' => 'Database not initialized yet — seed it once the schema exists (see next steps)'];
            $demoManual = true;
        } elseif (!is_dir($backendDir . '/vendor')) {
            $steps[] = ['label' => 'Demo & marketplace', 'status' => 'skip', 'message' => 'Composer dependencies not installed yet — seed it after `composer install` (see next steps)'];
            $demoManual = true;
        } elseif (!file_exists($provision)) {
            $steps[] = ['label' => 'Demo & marketplace', 'status' => 'warn', 'message' => 'scripts/provision-demo.php not found — cannot seed the marketplace'];
        } elseif (!$canExec) {
            $steps[] = ['label' => 'Demo & marketplace', 'status' => 'skip', 'message' => 'PHP exec() is disabled here — seed it from a shell (see next steps)'];
            $demoManual = true;
        } else {
            // Seeding the 30+ sample apps + example data can take a while; don't let PHP time out.
            @set_time_limit(0);
            $out = [];
            $rc = 1;
            exec('php ' . escapeshellarg($provision) . ' 2>&1', $out, $rc);
            if ($rc === 0) {
                // Surface the script's own summary line ("Done. Demo apps: N") when present.
                $summary = 'Installed the sample app packs into the marketplace and seeded the demo.';
                foreach (array_reverse($out) as $line) {
                    if (stripos($line, 'Demo apps') !== false) { $summary = trim($line); break; }
                }
                $steps[] = ['label' => 'Set up demo & marketplace', 'status' => 'ok', 'message' => $summary];
            } else {
                $steps[] = ['label' => 'Demo & marketplace', 'status' => 'warn', 'message' => 'Could not run automatically (is the `php` CLI on PATH?) — seed it manually (see next steps)'];
                $demoManual = true;
            }
        }
    }

    // 10. Verify the freshly-written .env is not fetchable over HTTP (where testable).
    $steps[] = flCheckEnvExposure();

    $hasErrors = false;
    foreach ($steps as $step) {
        if ($step['status'] === 'error') {
            $hasErrors = true;
            break;
        }
    }

    return [
        'success' => !$hasErrors,
        'steps' => $steps,
        'demoManual' => $demoManual,
        'message' => $hasErrors ? 'Installation completed with errors.' : 'Installation completed successfully!',
    ];
}

// ---------------------------------------------------------------------------
// Shared post-install checks
// ---------------------------------------------------------------------------
/**
 * FormLogic qjs runtime step: presence on every platform, plus the execute bit on Linux/macOS —
 * zip extraction commonly drops it, so try chmod +x first and only then ask the operator to.
 */
function flQjsStep(): array
{
    $backendDir = flBackendDir();
    $isWin = stripos(PHP_OS, 'WIN') === 0;
    $qjsBin = $isWin
        ? $backendDir . '/bin/qjs/qjs-windows-x86_64.exe'
        : $backendDir . '/bin/qjs/qjs-linux-x86_64';
    if (!file_exists($qjsBin)) {
        return ['label' => 'FormLogic qjs runtime', 'status' => 'warn',
            'message' => 'Binary not present at ' . basename($backendDir) . '/bin/qjs — form logic & scripts will be disabled'];
    }
    if (!$isWin && !is_executable($qjsBin)) {
        @chmod($qjsBin, 0755); // zip extraction drops the exec bit
        if (!is_executable($qjsBin)) {
            return ['label' => 'FormLogic qjs runtime', 'status' => 'warn',
                'message' => 'Present but not executable (and chmod from PHP failed) — run on the server: chmod +x "' . $qjsBin . '"'];
        }
        return ['label' => 'FormLogic qjs runtime', 'status' => 'ok', 'message' => 'Execute bit was missing — fixed with chmod +x'];
    }
    return ['label' => 'FormLogic qjs runtime', 'status' => 'ok'];
}

/**
 * Post-install probe: is <backend>/.env fetchable over HTTP? The shipped web-root .htaccess denies
 * it on Apache (FilesMatch ^\.env plus a rewrite [F] rule), but that only holds when AllowOverride
 * is honoured — so where a self-request is possible, VERIFY instead of assuming. Non-conclusive
 * results are reported as 'skip' with the manual check to run.
 */
function flCheckEnvExposure(): array
{
    $backendRel = basename(flBackendDir());
    $label = "Check {$backendRel}/.env is not web-readable";
    if (!file_exists(flBackendDir() . '/.env')) {
        return ['label' => $label, 'status' => 'skip', 'message' => 'No .env exists yet'];
    }
    if (PHP_SAPI === 'cli-server') {
        // php -S is single-threaded — a self-request would deadlock (and it ignores .htaccess anyway).
        return ['label' => $label, 'status' => 'skip',
            'message' => 'Not testable under the PHP built-in server — on Apache the shipped .htaccess denies .env; re-verify after deploying'];
    }
    $host = $_SERVER['HTTP_HOST'] ?? '';
    if ($host === '' || !function_exists('file_get_contents') || ini_get('allow_url_fopen') != '1') {
        return ['label' => $label, 'status' => 'skip',
            'message' => 'Could not self-test here — verify manually that /' . $backendRel . '/.env returns 403/404 (the shipped .htaccess denies it on Apache)'];
    }
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $basePath = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');
    $url = $scheme . '://' . $host . $basePath . '/' . $backendRel . '/.env';
    $ctx = stream_context_create([
        'http' => ['timeout' => 5, 'ignore_errors' => true, 'follow_location' => 0],
        // Self-signed certs are common on fresh installs; the probe sends no secrets outbound.
        'ssl' => ['verify_peer' => false, 'verify_peer_name' => false],
    ]);
    $body = @file_get_contents($url, false, $ctx);
    $status = 0;
    if (isset($http_response_header[0]) && preg_match('#^HTTP/\S+\s+(\d{3})#', $http_response_header[0], $m)) {
        $status = (int) $m[1];
    }
    if ($body === false && $status === 0) {
        return ['label' => $label, 'status' => 'skip',
            'message' => "Self-test request failed — verify manually that {$url} is NOT served (the shipped .htaccess denies it on Apache)"];
    }
    if ($status === 200 && is_string($body) && (str_contains($body, 'JWT_SECRET') || str_contains($body, 'DB_PASSWORD'))) {
        return ['label' => $label, 'status' => 'warn',
            'message' => "SECURITY: {$url} is publicly readable! The .htaccess deny rules are not being honoured — "
                . 'enable AllowOverride All for the web root (Apache) or replicate the deny rules on your web server, then re-run this check'];
    }
    return ['label' => $label, 'status' => 'ok', 'message' => "HTTP {$status} — not served"];
}

// ---------------------------------------------------------------------------
// Upgrade mode — existing-install detection + the guarded upgrade run
// ---------------------------------------------------------------------------
/** The VERSION file shipped with a release: beside the backend (api/VERSION) or at the zip root. */
function flVersionFile(): ?string
{
    foreach ([flBackendDir() . '/VERSION', __DIR__ . '/VERSION'] as $f) {
        if (is_file($f)) {
            return $f;
        }
    }
    return null;
}

/**
 * Bootstrap the backend the same way public/index.php and bin/upgrade.php do: composer autoloader
 * + .env (phpdotenv) + config/settings.php. Returns ['config' => array] or ['error' => string].
 */
function flBootstrapBackend(): array
{
    $backendDir = flBackendDir();
    $backendRel = basename($backendDir);
    if (!is_file($backendDir . '/vendor/autoload.php')) {
        return ['error' => "Composer dependencies missing ({$backendRel}/vendor). The release zip ships them; "
            . 'in a source checkout run: cd backend && composer install'];
    }
    require_once $backendDir . '/vendor/autoload.php';
    if (class_exists(\Dotenv\Dotenv::class) && is_file($backendDir . '/.env')) {
        \Dotenv\Dotenv::createImmutable($backendDir)->safeLoad();
    }
    try {
        $config = require $backendDir . '/config/settings.php';
    } catch (\Throwable $e) {
        // settings.php fails hard on unsafe production config (placeholder JWT_SECRET / default
        // DB_PASSWORD) — the app itself would refuse to boot too, so surface it.
        return ['error' => 'Configuration error: ' . $e->getMessage() . " — fix {$backendRel}/.env, then retry."];
    }
    return ['config' => $config];
}

/**
 * Load the shared helpers from bin/upgrade.php (formlogicUpgrade*). Under the web SAPI its runnable
 * tail is skipped by its own guard, so requiring it only defines the functions — the wizard and the
 * CLI literally share one implementation (core-table list, version resolution, table probes).
 */
function flLoadUpgradeHelpers(): bool
{
    $file = flBackendDir() . '/bin/upgrade.php';
    if (!is_file($file) || !is_file(flBackendDir() . '/vendor/autoload.php')) {
        return false;
    }
    // Belt-and-suspenders: the guard in bin/upgrade.php already skips its runnable tail under a
    // web SAPI, but the constant makes "definitions only" explicit in EVERY SAPI (incl. CLI tests).
    if (!defined('FORMLOGIC_UPGRADE_NO_RUN')) {
        define('FORMLOGIC_UPGRADE_NO_RUN', true);
    }
    require_once $file;
    return function_exists('formlogicUpgradeCoreTables')
        && function_exists('formlogicUpgradeTableExists')
        && function_exists('formlogicUpgradeResolveVersion');
}

/**
 * Detect an upgrade candidate: a configured .env AND a reachable database that already has
 * FormLogic's core tables. Feeds the mode chooser in the UI.
 */
function detectExistingInstall(): array
{
    $backendRel = basename(flBackendDir());
    $detect = [
        'configured' => file_exists(flBackendDir() . '/.env'),
        'backendRel' => $backendRel,
        'dbOk' => false,
        'dbName' => '',
        'dbError' => null,
        'coreTablesPresent' => 0,
        'coreTablesTotal' => 0,
        'stampedVersion' => null,
        'shippedVersion' => null,
        'isUpgrade' => false,
    ];
    $versionFile = flVersionFile();
    if ($versionFile !== null) {
        $v = trim((string) @file_get_contents($versionFile));
        $detect['shippedVersion'] = $v !== '' ? $v : null;
    }
    $boot = flBootstrapBackend();
    if (isset($boot['error'])) {
        $detect['dbError'] = $boot['error'];
        return $detect;
    }
    $detect['dbName'] = (string) ($boot['config']['settings']['mysql']['database'] ?? '');
    try {
        $mysql = new \FormLogic\Database\MySQLConnection($boot['config']['settings']['mysql']);
        $pdo = $mysql->getConnection();
        $pdo->query('SELECT 1');
        $detect['dbOk'] = true;
    } catch (\Throwable $e) {
        $detect['dbError'] = "Database unreachable with the credentials in {$backendRel}/.env"
            . ' — check DB_HOST / DB_DATABASE / DB_USERNAME / DB_PASSWORD.';
        return $detect;
    }
    if (flLoadUpgradeHelpers()) {
        $core = formlogicUpgradeCoreTables();
        $detect['coreTablesTotal'] = count($core);
        foreach ($core as $table) {
            if (formlogicUpgradeTableExists($pdo, $table)) {
                $detect['coreTablesPresent']++;
            }
        }
        if (formlogicUpgradeTableExists($pdo, 'schema_meta')) {
            try {
                $stmt = $pdo->query("SELECT meta_value FROM schema_meta WHERE meta_key = 'app_version'");
                $v = $stmt ? $stmt->fetchColumn() : false;
                if (is_string($v) && $v !== '' && $v !== 'unknown') {
                    $detect['stampedVersion'] = $v;
                }
            } catch (\Throwable $e) {
                // informational only
            }
        }
    }
    $detect['isUpgrade'] = $detect['configured'] && $detect['dbOk'] && $detect['coreTablesPresent'] > 0;
    return $detect;
}

/**
 * Upgrade an existing installation: the SAME guarded, idempotent schema path the app runs on boot
 * and bin/upgrade.php runs from a shell (MySQLConnection::initializeSchema + runMigrations),
 * followed by core-table verification and the schema_meta stamp — here with
 * upgrade_source='installer' so the install records HOW it was upgraded. Never touches .env,
 * storage/, or any user data.
 */
function runUpgrade(): array
{
    $steps = [];
    $backendDir = flBackendDir();
    $backendRel = basename($backendDir);

    if (!file_exists($backendDir . '/.env')) {
        $steps[] = ['label' => 'Load configuration', 'status' => 'error',
            'message' => "No {$backendRel}/.env found — nothing to upgrade. Run a fresh install instead."];
        return ['success' => false, 'steps' => $steps, 'message' => 'No existing configuration found.'];
    }

    $boot = flBootstrapBackend();
    if (isset($boot['error'])) {
        $steps[] = ['label' => 'Load configuration', 'status' => 'error', 'message' => $boot['error']];
        return ['success' => false, 'steps' => $steps, 'message' => 'Could not bootstrap the backend.'];
    }
    $steps[] = ['label' => "Load configuration ({$backendRel}/.env + config/settings.php)", 'status' => 'ok'];

    if (!flLoadUpgradeHelpers()) {
        $steps[] = ['label' => 'Load upgrade helpers', 'status' => 'error',
            'message' => "{$backendRel}/bin/upgrade.php is missing or incompatible — re-upload the release files, "
                . "or run from a shell: php {$backendRel}/bin/upgrade.php"];
        return ['success' => false, 'steps' => $steps, 'message' => 'Upgrade helpers unavailable.'];
    }

    $mysqlCfg = $boot['config']['settings']['mysql'];
    $mysql = new \FormLogic\Database\MySQLConnection($mysqlCfg);
    try {
        $pdo = $mysql->getConnection();
        $pdo->query('SELECT 1');
    } catch (\Throwable $e) {
        $steps[] = ['label' => 'Connect to database', 'status' => 'error',
            'message' => sprintf(
                "Database unreachable (%s:%s / '%s' as '%s') — check the DB_* values in %s/.env. "
                . 'The upgrade migrates an existing database; it does not create one.',
                $mysqlCfg['host'],
                $mysqlCfg['port'],
                $mysqlCfg['database'],
                $mysqlCfg['username'],
                $backendRel
            )];
        return ['success' => false, 'steps' => $steps, 'message' => 'Database unreachable.'];
    }
    $steps[] = ['label' => sprintf("Connect to database '%s'", $mysqlCfg['database']), 'status' => 'ok'];

    if (!formlogicUpgradeTableExists($pdo, 'users')) {
        $steps[] = ['label' => 'Existing schema', 'status' => 'warn',
            'message' => 'No core tables found — this will initialize a fresh schema in the configured database'];
    }

    // The migration proper. Big tables can take a while — don't let PHP time out mid-migration.
    @set_time_limit(0);
    try {
        $mysql->initializeSchema();
        $steps[] = ['label' => 'Ensure base schema', 'status' => 'ok', 'message' => 'MySQLConnection::initializeSchema()'];
        $mysql->runMigrations();
        $steps[] = ['label' => 'Run migrations', 'status' => 'ok',
            'message' => 'MySQLConnection::runMigrations() — every step is guarded; already-applied steps are no-ops'];
    } catch (\Throwable $e) {
        // Strip file paths and internal details (both Unix "/path" and Windows "C:\path")
        $msg = preg_replace('#\sin\s+(?:/|[A-Za-z]:\\\\).*$#s', '', $e->getMessage());
        $steps[] = ['label' => 'Schema migration', 'status' => 'error',
            'message' => 'Migration failed: ' . trim(substr((string) $msg, 0, 300))];
        return ['success' => false, 'steps' => $steps,
            'message' => 'Migration failed — check the server logs; restore your backup if needed. Re-running is safe (idempotent).'];
    }

    // Verify the same core-table list the CLI verifies.
    $coreTables = formlogicUpgradeCoreTables();
    $missing = [];
    foreach ($coreTables as $table) {
        if (!formlogicUpgradeTableExists($pdo, $table)) {
            $missing[] = $table;
        }
    }
    $total = count($coreTables);
    if ($missing !== []) {
        $steps[] = ['label' => 'Verify core tables', 'status' => 'error',
            'message' => sprintf('%d/%d present — missing: %s', $total - count($missing), $total, implode(', ', $missing))];
        return ['success' => false, 'steps' => $steps, 'message' => 'Core tables missing after migration.'];
    }
    $steps[] = ['label' => 'Verify core tables', 'status' => 'ok', 'message' => "{$total}/{$total} present"];

    // Stamp schema_meta exactly the way bin/upgrade.php does — but with upgrade_source='installer'.
    try {
        [$version, $versionSource] = formlogicUpgradeResolveVersion([], flVersionFile());
        $previousVersion = null;
        if (formlogicUpgradeTableExists($pdo, 'schema_meta')) {
            try {
                $stmt = $pdo->query("SELECT meta_value FROM schema_meta WHERE meta_key = 'app_version'");
                $v = $stmt ? $stmt->fetchColumn() : false;
                $previousVersion = (is_string($v) && $v !== '') ? $v : null;
            } catch (\Throwable $e) {
                $previousVersion = null;
            }
        }
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS schema_meta (
                meta_key VARCHAR(64) NOT NULL PRIMARY KEY,
                meta_value TEXT NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");
        $now = (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->format('Y-m-d H:i:s');
        $stamp = $pdo->prepare(
            'INSERT INTO schema_meta (meta_key, meta_value) VALUES (:k, :v)
             ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value)'
        );
        // 'unknown' never overwrites a previously-stamped real version (mirrors the CLI).
        $keptPrevious = ($version === 'unknown' && $previousVersion !== null && $previousVersion !== 'unknown');
        $stampedVersion = $keptPrevious ? $previousVersion : $version;
        $stamp->execute(['k' => 'app_version', 'v' => $stampedVersion]);
        $stamp->execute(['k' => 'last_upgrade_at', 'v' => $now]);
        $stamp->execute(['k' => 'upgrade_source', 'v' => 'installer']);
        $sourceLabel = $keptPrevious
            ? 'kept the existing stamp — no VERSION file shipped'
            : ($versionSource === 'file' ? 'from the VERSION file' : "no VERSION file — stamped 'unknown'");
        $steps[] = ['label' => 'Stamp schema_meta', 'status' => 'ok',
            'message' => sprintf('app_version=%s (%s), upgrade_source=installer', $stampedVersion, $sourceLabel)];
    } catch (\Throwable $e) {
        $steps[] = ['label' => 'Stamp schema_meta', 'status' => 'warn',
            'message' => 'Could not stamp (non-fatal — the schema itself is upgraded)'];
    }

    // Post-upgrade permission/security checks (a new zip's files may have reset them).
    $steps[] = flQjsStep();
    $steps[] = flCheckEnvExposure();

    $hasErrors = false;
    foreach ($steps as $step) {
        if ($step['status'] === 'error') {
            $hasErrors = true;
            break;
        }
    }

    return [
        'success' => !$hasErrors,
        'steps' => $steps,
        'message' => $hasErrors
            ? 'Upgrade completed with errors.'
            : "Upgrade complete — idempotent, safe to re-run. Verify from a shell with: php {$backendRel}/bin/upgrade.php --check",
    ];
}

// ---------------------------------------------------------------------------
// HTML output
// ---------------------------------------------------------------------------
// Template context.
$backendRelHtml = htmlspecialchars(basename(flBackendDir()), ENT_QUOTES);
$backendAbsHtml = htmlspecialchars(str_replace('\\', '/', flBackendDir()), ENT_QUOTES);
$isBundle = (flUiDir() === null); // deployed release zip (prebuilt SPA at the web root, backend at api/)
$canSeedDemo = file_exists(flBackendDir() . '/scripts/provision-demo.php'); // not shipped in the release zip
$defaultCors = 'http://localhost:5173';
if ($isBundle && !empty($_SERVER['HTTP_HOST'])) {
    // Single-domain deploy: the SPA calls /api on the SAME origin — default CORS to this site.
    $defaultCors = ((!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http')
        . '://' . $_SERVER['HTTP_HOST'];
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FormLogic - Installation Wizard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #1e293b; line-height: 1.6; }
  .container { max-width: 720px; margin: 0 auto; padding: 40px 20px; }
  .logo { text-align: center; margin-bottom: 32px; }
  .logo h1 { font-size: 28px; font-weight: 700; color: #4f46e5; }
  .logo p { color: #64748b; font-size: 14px; margin-top: 4px; }
  .card { background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 32px; margin-bottom: 24px; border: 1px solid #e2e8f0; }
  .card h2 { font-size: 18px; font-weight: 600; margin-bottom: 20px; display: flex; align-items: center; gap: 10px; }
  .step-num { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; background: #4f46e5; color: #fff; font-size: 13px; font-weight: 700; flex-shrink: 0; }
  table.checks { width: 100%; border-collapse: collapse; font-size: 14px; }
  table.checks th { text-align: left; padding: 8px 12px; background: #f8fafc; font-weight: 600; border-bottom: 1px solid #e2e8f0; }
  table.checks td { padding: 8px 12px; border-bottom: 1px solid #f1f5f9; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 12px; font-weight: 600; }
  .badge-ok { background: #dcfce7; color: #166534; }
  .badge-fail { background: #fee2e2; color: #991b1b; }
  .badge-warn { background: #fef9c3; color: #854d0e; }
  .badge-skip { background: #f1f5f9; color: #475569; }
  .help-text { font-size: 12px; color: #94a3b8; margin-top: 2px; }
  .form-group { margin-bottom: 16px; }
  .form-group label { display: block; font-size: 13px; font-weight: 600; color: #475569; margin-bottom: 4px; }
  .form-group input { width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; transition: border-color 0.15s; }
  .form-group input:focus { outline: none; border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79,70,229,0.1); }
  .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; border: none; transition: all 0.15s; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: #4f46e5; color: #fff; }
  .btn-primary:hover:not(:disabled) { background: #4338ca; }
  .btn-secondary { background: #f1f5f9; color: #475569; border: 1px solid #d1d5db; }
  .btn-secondary:hover:not(:disabled) { background: #e2e8f0; }
  .btn-group { display: flex; gap: 10px; margin-top: 20px; }
  .alert { padding: 12px 16px; border-radius: 8px; font-size: 14px; margin-bottom: 16px; }
  .alert-warn { background: #fef9c3; color: #854d0e; border: 1px solid #fde68a; }
  .alert-error { background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; }
  .alert-success { background: #dcfce7; color: #166534; border: 1px solid #86efac; }
  .alert-info { background: #eff6ff; color: #1e40af; border: 1px solid #bfdbfe; }
  .connection-status { margin-top: 12px; padding: 10px 14px; border-radius: 8px; font-size: 13px; display: none; }
  .steps-list { list-style: none; }
  .steps-list li { padding: 10px 0; border-bottom: 1px solid #f1f5f9; display: flex; align-items: center; gap: 10px; font-size: 14px; }
  .steps-list li:last-child { border-bottom: none; }
  .step-icon { width: 20px; height: 20px; flex-shrink: 0; }
  .spinner { display: inline-block; width: 20px; height: 20px; border: 2px solid #e2e8f0; border-top-color: #4f46e5; border-radius: 50%; animation: spin 0.6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .hidden { display: none !important; }
  .next-steps { background: #f8fafc; border-radius: 8px; padding: 16px; margin-top: 16px; }
  .next-steps h3 { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
  .next-steps ol { padding-left: 20px; font-size: 13px; }
  .next-steps li { margin-bottom: 6px; }
  .next-steps code { background: #e2e8f0; padding: 2px 6px; border-radius: 4px; font-size: 12px; font-family: 'SF Mono', Consolas, monospace; }
  .checkbox-group { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .checkbox-group input[type="checkbox"] { width: auto; }
  .checkbox-group label { font-weight: normal; margin-bottom: 0; }
</style>
</head>
<body>
<div class="container">
  <div class="logo">
    <h1>FormLogic</h1>
    <p>Installation Wizard</p>
  </div>

  <?php if ($alreadyInstalled): ?>
  <!-- Mode chooser: an existing installation was detected -->
  <div class="card" id="mode-chooser">
    <h2><span class="step-num">!</span> Existing installation detected</h2>
    <p style="font-size:14px;color:#475569;margin-bottom:12px;">
      A configured <code><?= $backendRelHtml ?>/.env</code> was found. Choose what to do:
    </p>
    <div id="detect-summary" class="alert alert-info" style="font-size:13px;">Inspecting the existing installation&hellip;</div>
    <div class="btn-group">
      <button class="btn btn-primary" id="btn-mode-upgrade" onclick="chooseMode('upgrade')">Upgrade existing installation</button>
      <button class="btn btn-secondary" id="btn-mode-fresh" onclick="chooseMode('fresh')">Fresh install / reconfigure</button>
    </div>
    <p class="help-text" style="margin-top:10px;">
      <strong>Upgrade</strong> keeps your data and configuration and only applies this release's database
      schema changes — the same guarded, idempotent migrations <code>php <?= $backendRelHtml ?>/bin/upgrade.php</code>
      runs. <strong>Fresh install</strong> walks through the full setup (database, secrets, .env).
    </p>
  </div>

  <!-- Upgrade mode -->
  <div class="card hidden" id="step-upgrade">
    <h2><span class="step-num">&uarr;</span> Upgrade</h2>
    <div class="alert alert-warn" style="font-size:13px;">
      <strong>Back up first.</strong> Dump the database and copy <code><?= $backendRelHtml ?>/.env</code> +
      <code><?= $backendRelHtml ?>/storage/</code> somewhere safe before upgrading (see docs/UPGRADING.md).
    </div>
    <p style="font-size:13px;color:#64748b;margin-bottom:16px;">
      This runs the same schema path the app itself uses on boot (<code>initializeSchema()</code> + guarded
      <code>runMigrations()</code>), verifies the core tables, and stamps <code>schema_meta</code>
      (<code>upgrade_source=installer</code>). Your <code>.env</code>, uploads, and response data are not
      touched. Idempotent — safe to run more than once.
    </p>
    <button class="btn btn-primary" onclick="runUpgrade()" id="btn-upgrade">Run Upgrade</button>
    <div id="upgrade-progress" class="hidden" style="margin-top:20px;">
      <ul class="steps-list" id="upgrade-steps"></ul>
    </div>
    <div id="upgrade-result" class="hidden" style="margin-top:16px;"></div>
  </div>
  <?php endif; ?>

  <!-- Step 1: Requirements (always shown — the permission/qjs checks matter for upgrades too) -->
  <div class="card" id="step-requirements">
    <h2><span class="step-num">1</span> System Requirements</h2>
    <div id="req-loading" style="text-align:center;padding:20px;">
      <div class="spinner"></div>
      <p style="margin-top:10px;color:#64748b;font-size:14px;">Checking requirements...</p>
    </div>
    <div id="req-results" class="hidden">
      <table class="checks">
        <thead><tr><th>Requirement</th><th>Required</th><th>Current</th><th>Status</th></tr></thead>
        <tbody id="req-tbody"></tbody>
      </table>
      <div id="req-message" style="margin-top:16px;"></div>
    </div>
  </div>

  <!-- Fresh-install flow (hidden until chosen when an existing installation was detected) -->
  <div id="fresh-flow" class="<?= $alreadyInstalled ? 'hidden' : '' ?>">

  <!-- Step 2: Database -->
  <div class="card" id="step-database">
    <h2><span class="step-num">2</span> Database Configuration</h2>
    <p style="font-size:13px;color:#64748b;margin-bottom:16px;">
      Enter your MySQL connection details. For WAMP, the default user is usually <code>root</code> with an empty password.
    </p>
    <div class="form-row">
      <div class="form-group">
        <label for="db_host">Host</label>
        <input type="text" id="db_host" value="localhost" />
      </div>
      <div class="form-group">
        <label for="db_port">Port</label>
        <input type="text" id="db_port" value="3306" />
      </div>
    </div>
    <div class="form-group">
      <label for="db_name">Database Name</label>
      <input type="text" id="db_name" value="formlogic" />
    </div>
    <div class="form-row">
      <div class="form-group">
        <label for="db_user">Username</label>
        <input type="text" id="db_user" value="root" />
      </div>
      <div class="form-group">
        <label for="db_pass">Password</label>
        <input type="password" id="db_pass" value="" placeholder="Leave empty if none" />
      </div>
    </div>
    <button class="btn btn-secondary" onclick="testDb()" id="btn-test-db">Test Connection</button>
    <div id="db-status" class="connection-status"></div>
  </div>

  <!-- Step 3: Settings -->
  <div class="card" id="step-settings">
    <h2><span class="step-num">3</span> Application Settings</h2>
    <div class="form-group">
      <label for="cors_origin">Frontend URL (CORS Origin)</label>
      <input type="text" id="cors_origin" value="<?= htmlspecialchars($defaultCors, ENT_QUOTES) ?>" />
      <p class="help-text"><?= $isBundle
          ? 'Single-domain deploy: the app calls /api on the same origin, so this site\'s own URL (pre-filled) is correct.'
          : 'The URL where the frontend dev server runs. Change if using a different port.' ?></p>
    </div>
    <?php if ($canSeedDemo): ?>
    <div class="checkbox-group">
      <input type="checkbox" id="seed_demo" checked />
      <label for="seed_demo" style="font-size:13px;">Set up the demo &amp; marketplace — installs the ready-made sample app packs and seeds example data</label>
    </div>
    <p class="help-text" style="margin-top:6px;">Recommended. Populates the marketplace with installable apps and a no-signup live demo. Needs Composer dependencies installed first; if it can't run now, you'll get a one-line command to do it later.</p>
    <?php endif; ?>
    <div class="checkbox-group" style="margin-top:10px;">
      <input type="checkbox" id="dev_mode" />
      <label for="dev_mode" style="font-size:13px;">Local <strong>development</strong> install — enables debug mode and relaxed security policy</label>
    </div>
    <p class="help-text" style="margin-top:6px;">Leave unchecked for any real deployment. The generated configuration defaults to production mode (<code>APP_ENV=production</code>, <code>APP_DEBUG=false</code>): secure cookies, no verbose errors. Check this only for a developer workstation — a public site running development mode fails its health checks.</p>
    <?php if ($alreadyInstalled): ?>
    <div class="checkbox-group">
      <input type="checkbox" id="overwrite_env" />
      <label for="overwrite_env" style="font-size:13px;">Overwrite existing <code>backend/.env</code> file</label>
    </div>
    <?php endif; ?>
  </div>

  <!-- Step 4: Install -->
  <div class="card" id="step-install">
    <h2><span class="step-num">4</span> Install</h2>
    <p style="font-size:13px;color:#64748b;margin-bottom:16px;">
      Click the button below to create configuration files, set up the database, and generate security keys.
    </p>
    <button class="btn btn-primary" onclick="runInstall()" id="btn-install">
      Run Installation
    </button>
    <div id="install-progress" class="hidden" style="margin-top:20px;">
      <ul class="steps-list" id="install-steps"></ul>
    </div>
    <div id="install-result" class="hidden" style="margin-top:16px;"></div>
  </div>

  </div><!-- /fresh-flow -->

  <!-- Final: Next Steps (shown after a successful install OR upgrade) -->
  <div class="card hidden" id="step-next">
    <h2><span class="step-num">&#10003;</span> Next Steps</h2>
    <div class="alert alert-success">
      FormLogic has been configured. Follow the steps below to finish setup.
    </div>
    <div class="next-steps">
      <h3>Complete the setup:</h3>
      <ol>
        <li id="ns-composer" class="hidden">
          Install PHP dependencies:<br>
          <code>cd backend && composer install</code>
        </li>
        <li id="ns-npm" class="hidden">
          Install frontend dependencies:<br>
          <code>cd ui && npm install</code>
        </li>
        <li id="ns-demo" class="hidden">
          Set up the demo &amp; marketplace (installs the sample app packs and seeds example data):<br>
          <code>cd <?= $backendRelHtml ?> && php scripts/provision-demo.php</code>
        </li>
        <li id="ns-wasm" class="hidden">
          The FormLogic qjs runtime binary is missing. It is vendored
          under <code><?= $backendRelHtml ?>/bin/qjs/</code> — re-upload the release files
          (or re-clone the repository), or fetch a static <code>qjs</code> build from
          <code>github.com/quickjs-ng/quickjs</code> for your platform.
        </li>
        <?php if ($isBundle): ?>
        <li>
          Verify the API: open <a href="api/health" target="_blank"><code>/api/health</code></a> on this site —
          it should report <code>"status":"ok"</code> plus storage checks.
        </li>
        <li>
          <a href="./" target="_blank">Open your site</a> and create your account — the sign-up page
          registers the first user. (Auth cookies are Secure-only: login requires HTTPS in production.)
        </li>
        <?php else: ?>
        <li>
          Start the backend API server:<br>
          <code>cd backend && php -S localhost:8080 -t public</code>
        </li>
        <li>
          Start the frontend dev server:<br>
          <code>cd ui && npm run dev</code>
        </li>
        <li>
          Open <a href="http://localhost:5173" target="_blank">http://localhost:5173</a> and create your account.
        </li>
        <?php endif; ?>
      </ol>
    </div>

    <div class="next-steps" style="margin-top:16px;">
      <h3>Scheduled tasks (optional but recommended)</h3>
      <p style="font-size:13px;color:#64748b;margin:0 0 10px;">
        Add these to the crontab on the server (<code>crontab -e</code> on Linux). If plain
        <code>php</code> isn't on cron's PATH, use the full path to the PHP <em>CLI</em> binary
        (find it with <code>which php</code> — it must be PHP 8.2+ with the same extensions as the
        web PHP). On Windows, use Task Scheduler to run the same commands.
      </p>
      <ol style="padding-left:20px;font-size:13px;">
        <li style="margin-bottom:10px;">
          <strong>Webhook retries</strong> — re-delivers failed webhook events with exponential backoff.
          Safe to run every minute (a lock file prevents overlapping runs):<br>
          <code>* * * * * php <?= $backendAbsHtml ?>/bin/webhook-worker.php &gt;&gt; /var/log/formlogic-webhooks.log 2&gt;&amp;1</code><br>
          <span class="help-text">No cron on your host? Run it continuously instead:
          <code>php <?= $backendRelHtml ?>/bin/webhook-worker.php --loop</code> (sleeps 60s between passes).</span>
        </li>
        <li style="margin-bottom:10px;">
          <strong>Offline-sync ledger cleanup</strong> — nightly prune of idempotency rows older than
          30 days (replayed offline submissions no longer need them):<br>
          <code>17 3 * * * php <?= $backendAbsHtml ?>/bin/idempotency-cleanup.php &gt;&gt; /var/log/formlogic-idempotency.log 2&gt;&amp;1</code>
        </li>
        <li style="margin-bottom:10px;">
          <strong>Desktop command relay cleanup</strong> — nightly prune of completed/expired
          desktop-command relay rows older than 7 days (also promptly expires any command a desktop
          claimed but crashed/lost connectivity before completing):<br>
          <code>23 3 * * * php <?= $backendAbsHtml ?>/bin/desktop-commands-cleanup.php &gt;&gt; /var/log/formlogic-desktop-commands.log 2&gt;&amp;1</code>
        </li>
        <li style="margin-bottom:10px;">
          <strong>Stuck flow-run reclaim</strong> — every 5 minutes, reverts any flow run left at
          'running' for more than 10 minutes (the claiming FormLogic Desktop/browser runtime crashed
          or lost connectivity) to 'error' so anything waiting on it can retry:<br>
          <code>0-59/5 * * * * php <?= $backendAbsHtml ?>/bin/flow-runs-reclaim.php &gt;&gt; /var/log/formlogic-flow-runs-reclaim.log 2&gt;&amp;1</code>
        </li>
        <li style="margin-bottom:10px;">
          <strong>Private-form privacy sweep</strong> — nightly null-out of respondent IP addresses
          on end-to-end encrypted (private) forms once they pass the 30-day abuse-forensics window
          (plan §12; skipped entirely when no private forms exist):<br>
          <code>41 3 * * * php <?= $backendAbsHtml ?>/bin/privacy-sweep.php &gt;&gt; /var/log/formlogic-privacy-sweep.log 2&gt;&amp;1</code>
        </li>
        <li>
          <strong>Data drift report</strong> — weekly read-only consistency check between MySQL and the
          per-form response databases (exit 1 = drift found; review the log, then run it manually with
          <code>--fix</code> to apply the safe repairs):<br>
          <code>0 4 * * 1 php <?= $backendAbsHtml ?>/bin/reconcile.php &gt;&gt; /var/log/formlogic-reconcile.log 2&gt;&amp;1</code>
        </li>
      </ol>
    </div>

    <div class="alert alert-warn" style="margin-top:16px;">
      <strong>Security — delete this file.</strong> Delete <code>install.php</code> from the web root now
      that setup is complete. The wizard also hard-disables itself once a configured
      <code><?= $backendRelHtml ?>/.env</code> exists (re-running it then requires deliberately setting
      <code>INSTALL_ENABLE=1</code>), but deleting the file is the guarantee. If you added
      <code>SetEnv INSTALL_ENABLE 1</code> to your <code>.htaccess</code> for this session, remove that line too.
    </div>
  </div>
</div>

<script>
const CSRF_TOKEN = <?= json_encode($csrfToken) ?>;
const ALREADY_INSTALLED = <?= json_encode($alreadyInstalled) ?>;

// Check requirements on page load; when an existing install was detected, inspect it too.
document.addEventListener('DOMContentLoaded', () => {
  checkRequirements();
  if (ALREADY_INSTALLED) detectInstall();
});

// ---- Mode chooser (existing installation only) ----------------------------
function chooseMode(mode) {
  const upgradeCard = document.getElementById('step-upgrade');
  const freshFlow = document.getElementById('fresh-flow');
  if (!upgradeCard || !freshFlow) return;
  const upgrade = mode === 'upgrade';
  upgradeCard.classList.toggle('hidden', !upgrade);
  freshFlow.classList.toggle('hidden', upgrade);
  const btnUp = document.getElementById('btn-mode-upgrade');
  const btnFresh = document.getElementById('btn-mode-fresh');
  if (btnUp) btnUp.className = 'btn ' + (upgrade ? 'btn-primary' : 'btn-secondary');
  if (btnFresh) btnFresh.className = 'btn ' + (upgrade ? 'btn-secondary' : 'btn-primary');
}

function detectInstall() {
  const el = document.getElementById('detect-summary');
  if (!el) return;
  post('detect_install').then(d => {
    const parts = [];
    parts.push('Configuration: ' + (d.configured ? esc(d.backendRel) + '/.env found' : 'no ' + esc(d.backendRel) + '/.env'));
    if (d.dbError) {
      parts.push('Database: ' + esc(d.dbError));
    } else if (d.dbOk) {
      parts.push('Database "' + esc(d.dbName) + '": reachable — ' + d.coreTablesPresent + '/' + d.coreTablesTotal + ' core tables present');
      parts.push('Installed version: ' + esc(d.stampedVersion || 'not stamped yet')
        + (d.shippedVersion ? ' &middot; this release: ' + esc(d.shippedVersion) : ''));
    }
    if (d.isUpgrade) {
      el.className = 'alert alert-success';
      parts.push('<strong>Recommended: Upgrade existing installation</strong> — keeps all data, applies only schema changes.');
      chooseMode('upgrade');
    } else {
      el.className = 'alert alert-warn';
      parts.push('<strong>No upgradable database found</strong> — a fresh install / reconfigure is probably what you want.');
      chooseMode('fresh');
    }
    el.innerHTML = parts.join('<br>');
  }).catch(() => {
    el.className = 'alert alert-warn';
    el.textContent = 'Could not inspect the existing installation — choose a mode below.';
  });
}

// ---- Shared step-list rendering (install + upgrade) ------------------------
function renderStepList(stepsList, steps) {
  stepsList.innerHTML = '';
  const flags = { needComposer: false, needNpm: false, needWasm: false };
  for (const step of steps) {
    const li = document.createElement('li');
    let icon = '';
    if (step.status === 'ok') icon = '<svg class="step-icon" viewBox="0 0 20 20" fill="#16a34a"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>';
    else if (step.status === 'error') icon = '<svg class="step-icon" viewBox="0 0 20 20" fill="#dc2626"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>';
    else if (step.status === 'warn') icon = '<svg class="step-icon" viewBox="0 0 20 20" fill="#d97706"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>';
    else icon = '<svg class="step-icon" viewBox="0 0 20 20" fill="#94a3b8"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd"/></svg>';

    let text = esc(step.label);
    if (step.message) text += ' <span style="color:#64748b;font-size:12px;">— ' + esc(step.message) + '</span>';
    li.innerHTML = icon + '<span>' + text + '</span>';
    stepsList.appendChild(li);

    if (step.label && step.label.includes('Composer') && step.status === 'warn') flags.needComposer = true;
    if (step.label && step.label.includes('npm') && step.status === 'warn') flags.needNpm = true;
    if (step.label && step.label.includes('qjs') && step.status === 'warn') flags.needWasm = true;
  }
  return flags;
}

// ---- Upgrade runner ---------------------------------------------------------
function runUpgrade() {
  const btn = document.getElementById('btn-upgrade');
  const progressDiv = document.getElementById('upgrade-progress');
  const stepsList = document.getElementById('upgrade-steps');
  const resultDiv = document.getElementById('upgrade-result');

  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px;"></div> Upgrading...';
  progressDiv.classList.remove('hidden');
  stepsList.innerHTML = '<li><div class="spinner step-icon"></div> Running the upgrade...</li>';
  resultDiv.classList.add('hidden');

  post('run_upgrade').then(result => {
    btn.disabled = false;
    btn.innerHTML = 'Run Upgrade';
    const flags = renderStepList(stepsList, result.steps || []);
    resultDiv.classList.remove('hidden');
    if (result.success) {
      resultDiv.innerHTML = '<div class="alert alert-success">' + esc(result.message) + '</div>';
      const nextCard = document.getElementById('step-next');
      if (flags.needWasm) document.getElementById('ns-wasm').classList.remove('hidden');
      nextCard.classList.remove('hidden');
      nextCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      resultDiv.innerHTML = '<div class="alert alert-error">' + esc(result.message) + '</div>';
    }
  }).catch(() => {
    btn.disabled = false;
    btn.innerHTML = 'Run Upgrade';
    resultDiv.classList.remove('hidden');
    resultDiv.innerHTML = '<div class="alert alert-error">Request failed. Check the browser console for details.</div>';
  });
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function post(action, data = {}) {
  const form = new URLSearchParams();
  form.append('action', action);
  form.append('csrf', CSRF_TOKEN);
  for (const [k, v] of Object.entries(data)) form.append(k, v);
  return fetch('install.php', { method: 'POST', body: form })
    .then(r => r.json());
}

function checkRequirements() {
  post('check_requirements').then(result => {
    const tbody = document.getElementById('req-tbody');
    tbody.innerHTML = '';
    for (const [key, check] of Object.entries(result.checks)) {
      const tr = document.createElement('tr');
      const badgeClass = check.pass ? 'badge-ok' : 'badge-fail';
      const badgeText = check.pass ? 'Pass' : 'Fail';
      tr.innerHTML = `
        <td>${esc(check.label)}</td>
        <td style="color:#64748b">${esc(check.required)}</td>
        <td>${esc(check.current)}${check.help ? '<div class="help-text">' + esc(check.help) + '</div>' : ''}</td>
        <td><span class="badge ${badgeClass}">${badgeText}</span></td>
      `;
      tbody.appendChild(tr);
    }

    const msgDiv = document.getElementById('req-message');
    if (!result.criticalPass) {
      msgDiv.innerHTML = '<div class="alert alert-error">Some critical requirements are not met. Please install the missing PHP extensions before continuing.</div>';
    } else if (!result.allPass) {
      msgDiv.innerHTML = '<div class="alert alert-info">Some optional requirements are missing. You can continue with the installation and address them later.</div>';
    } else {
      msgDiv.innerHTML = '<div class="alert alert-success">All requirements met!</div>';
    }

    document.getElementById('req-loading').classList.add('hidden');
    document.getElementById('req-results').classList.remove('hidden');
  });
}

function testDb() {
  const btn = document.getElementById('btn-test-db');
  const statusDiv = document.getElementById('db-status');
  btn.disabled = true;
  btn.textContent = 'Testing...';
  statusDiv.style.display = 'block';
  statusDiv.className = 'connection-status alert-info';
  statusDiv.textContent = 'Connecting...';

  post('test_database', {
    db_host: document.getElementById('db_host').value,
    db_port: document.getElementById('db_port').value,
    db_name: document.getElementById('db_name').value,
    db_user: document.getElementById('db_user').value,
    db_pass: document.getElementById('db_pass').value,
  }).then(result => {
    btn.disabled = false;
    btn.textContent = 'Test Connection';
    if (result.success) {
      statusDiv.className = 'connection-status alert-success';
      let msg = 'Connected to MySQL ' + result.mysqlVersion + '. ';
      msg += result.dbExists
        ? 'Database "' + document.getElementById('db_name').value + '" exists.'
        : 'Database "' + document.getElementById('db_name').value + '" will be created during installation.';
      statusDiv.textContent = msg;
    } else {
      statusDiv.className = 'connection-status alert-error';
      statusDiv.textContent = result.message;
    }
  }).catch(() => {
    btn.disabled = false;
    btn.textContent = 'Test Connection';
    statusDiv.className = 'connection-status alert-error';
    statusDiv.textContent = 'Request failed. Is PHP running?';
  });
}

function runInstall() {
  const btn = document.getElementById('btn-install');
  const progressDiv = document.getElementById('install-progress');
  const stepsList = document.getElementById('install-steps');
  const resultDiv = document.getElementById('install-result');

  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px;"></div> Installing...';
  progressDiv.classList.remove('hidden');
  stepsList.innerHTML = '<li><div class="spinner step-icon"></div> Running installation...</li>';
  resultDiv.classList.add('hidden');

  const overwriteEl = document.getElementById('overwrite_env');
  post('run_install', {
    db_host: document.getElementById('db_host').value,
    db_port: document.getElementById('db_port').value,
    db_name: document.getElementById('db_name').value,
    db_user: document.getElementById('db_user').value,
    db_pass: document.getElementById('db_pass').value,
    cors_origin: document.getElementById('cors_origin').value,
    overwrite_env: overwriteEl && overwriteEl.checked ? '1' : '',
    seed_demo: document.getElementById('seed_demo') && document.getElementById('seed_demo').checked ? '1' : '',
    dev_mode: document.getElementById('dev_mode') && document.getElementById('dev_mode').checked ? '1' : '',
  }).then(result => {
    btn.disabled = false;
    btn.innerHTML = 'Run Installation';

    const flags = renderStepList(stepsList, result.steps || []);

    // Show result
    resultDiv.classList.remove('hidden');
    if (result.success) {
      resultDiv.innerHTML = '<div class="alert alert-success">' + esc(result.message) + '</div>';
      // Show next steps
      const nextCard = document.getElementById('step-next');
      nextCard.classList.remove('hidden');
      if (flags.needComposer) document.getElementById('ns-composer').classList.remove('hidden');
      if (flags.needNpm) document.getElementById('ns-npm').classList.remove('hidden');
      if (result.demoManual) document.getElementById('ns-demo').classList.remove('hidden');
      if (flags.needWasm) document.getElementById('ns-wasm').classList.remove('hidden');
      nextCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      resultDiv.innerHTML = '<div class="alert alert-error">' + esc(result.message) + '</div>';
    }
  }).catch(() => {
    btn.disabled = false;
    btn.innerHTML = 'Run Installation';
    resultDiv.classList.remove('hidden');
    resultDiv.innerHTML = '<div class="alert alert-error">Request failed. Check the browser console for details.</div>';
  });
}
</script>
</body>
</html>
