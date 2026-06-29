<?php
/**
 * FormLogic Installation Wizard
 *
 * A browser-based installer for setting up FormLogic on WAMP/XAMPP/LAMP.
 * Access via your web root + this file's path, e.g.
 *   http://localhost/<your-folder>/form-builder/install.php
 * (for the default checkout: http://localhost/formlogic-app/form-builder/install.php)
 *
 * IMPORTANT: Delete this file after installation is complete.
 */

declare(strict_types=1);

// Prevent running if already installed and .env exists with a real JWT secret
$alreadyInstalled = false;
$envPath = __DIR__ . '/backend/.env';
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
// in the server environment (a deliberate opt-in for remote installs). Once installed, the
// web installer is hard-disabled regardless of origin.
$installEnabled = in_array(strtolower((string) getenv('INSTALL_ENABLE')), ['1', 'true', 'yes'], true);
$remoteAddr = $_SERVER['REMOTE_ADDR'] ?? '';
$isLocalRequest = in_array($remoteAddr, ['127.0.0.1', '::1', 'localhost'], true);

$installerDenied = null;
if ($alreadyInstalled && !$installEnabled) {
    $installerDenied = 'FormLogic is already installed. For security, delete form-builder/install.php. '
        . 'To deliberately re-run setup, set the environment variable INSTALL_ENABLE=1.';
} elseif (!$isLocalRequest && !$installEnabled) {
    $installerDenied = 'For security, run the installer from the server itself (localhost), '
        . 'or set the environment variable INSTALL_ENABLE=1 to allow remote setup.';
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
            . htmlspecialchars($installerDenied, ENT_QUOTES) . '</p></body>';
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
        'required' => '>= 8.1',
        'current' => $phpVersion,
        'pass' => version_compare($phpVersion, '8.1.0', '>='),
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
    $vendorExists = is_dir(__DIR__ . '/backend/vendor');
    $checks['composer'] = [
        'label' => 'Composer Dependencies',
        'required' => 'Installed',
        'current' => $vendorExists ? 'Installed' : 'Not installed',
        'pass' => $vendorExists,
        'help' => $vendorExists ? '' : 'Run: cd backend && composer install',
    ];

    // Write permissions
    $dirsToCheck = [
        'backend/storage/forms',
        'backend/storage/packs',
        'backend/storage/uploads',
        'backend/logs',
    ];
    foreach ($dirsToCheck as $dir) {
        $fullPath = __DIR__ . '/' . $dir;
        $exists = is_dir($fullPath);
        $writable = $exists && is_writable($fullPath);
        $checks['dir_' . str_replace('/', '_', $dir)] = [
            'label' => "Directory: $dir",
            'required' => 'Writable',
            'current' => !$exists ? 'Does not exist' : ($writable ? 'Writable' : 'Not writable'),
            'pass' => $writable,
            'auto_fix' => true,
        ];
    }

    // FormLogic qjs sandbox binary (server-side runtime)
    $qjsBin = stripos(PHP_OS, 'WIN') === 0
        ? __DIR__ . '/backend/bin/qjs/qjs-windows-x86_64.exe'
        : __DIR__ . '/backend/bin/qjs/qjs-linux-x86_64';
    $qjsExists = file_exists($qjsBin);
    $checks['qjs'] = [
        'label' => 'FormLogic qjs Runtime',
        'required' => 'Present',
        'current' => $qjsExists ? 'Present' : 'Missing',
        'pass' => $qjsExists,
        'help' => $qjsExists ? '' : 'Vendored under backend/bin/qjs; re-clone the repo or fetch qjs from github.com/quickjs-ng/quickjs',
    ];

    // Node.js (best effort)
    $nodeVersion = '';
    $npmVersion = '';
    $nodeOk = false;
    if (strtoupper(substr(PHP_OS, 0, 3)) === 'WIN') {
        exec('node -v 2>NUL', $nodeOut, $nodeRc);
        exec('npm -v 2>NUL', $npmOut, $npmRc);
    } else {
        exec('node -v 2>/dev/null', $nodeOut, $nodeRc);
        exec('npm -v 2>/dev/null', $npmOut, $npmRc);
    }
    if ($nodeRc === 0 && !empty($nodeOut[0])) {
        $nodeVersion = trim($nodeOut[0]);
        $major = (int) ltrim($nodeVersion, 'v');
        // Vite 7 requires Node 20.19+ or 22.12+ (major 20+ covers the common case).
        $nodeOk = $major >= 20;
    }
    $checks['node'] = [
        'label' => 'Node.js',
        'required' => '>= 20.19 / 22.12',
        'current' => $nodeVersion ?: 'Not found in PATH',
        'pass' => $nodeOk,
        'help' => $nodeOk ? '' : 'Install Node.js 20.19+ or 22.12+ from https://nodejs.org (required by Vite 7)',
    ];
    $checks['npm'] = [
        'label' => 'npm',
        'required' => 'Installed',
        'current' => (!empty($npmOut[0])) ? trim($npmOut[0]) : 'Not found',
        'pass' => !empty($npmOut[0]),
    ];

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
    $backendDir = __DIR__ . '/backend';
    $uiDir = __DIR__ . '/ui';

    // 1. Create storage directories
    $dirs = [
        $backendDir . '/storage/forms',
        $backendDir . '/storage/packs',
        $backendDir . '/storage/uploads',
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

    if (!ctype_digit((string) $dbPort)) {
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

    // Replace values
    $replacements = [
        '/^DB_HOST=.*/m' => "DB_HOST=$dbHost",
        '/^DB_PORT=.*/m' => "DB_PORT=$dbPort",
        '/^DB_DATABASE=.*/m' => "DB_DATABASE=$dbName",
        '/^DB_USERNAME=.*/m' => "DB_USERNAME=$dbUser",
        '/^DB_PASSWORD=.*/m' => "DB_PASSWORD=$dbPass",
        '/^JWT_SECRET=.*/m' => "JWT_SECRET=$jwtSecret",
        '/^CORS_ORIGIN=.*/m' => "CORS_ORIGIN=$corsOrigin",
        '/^# AUDIT_HMAC_KEY=.*/m' => "AUDIT_HMAC_KEY=$auditKey",
    ];
    foreach ($replacements as $pattern => $replacement) {
        $envContent = preg_replace($pattern, $replacement, $envContent);
    }

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

    // 4. Create frontend .env
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

    // 5. Create database and import schema
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
                        $steps[] = ['label' => 'Import database schema', 'status' => 'ok'];
                    } else {
                        $steps[] = ['label' => 'Import schema', 'status' => 'warn', 'message' => 'schema.sql is empty — tables will be auto-created on first request'];
                    }
                } else {
                    $steps[] = ['label' => 'Import schema', 'status' => 'warn', 'message' => 'schema.sql not found — tables will be auto-created on first request'];
                }
            } else {
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
                // Strip file paths and internal details
                $msg = preg_replace('/in \/.*$/', '', $msg);
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

    // 7. Check npm dependencies
    if (!is_dir($uiDir . '/node_modules')) {
        $steps[] = ['label' => 'npm dependencies', 'status' => 'warn', 'message' => 'Not installed. Run: cd ui && npm install'];
    } else {
        $steps[] = ['label' => 'npm dependencies', 'status' => 'ok'];
    }

    // 8. Check FormLogic qjs runtime binary
    $qjsBin = stripos(PHP_OS, 'WIN') === 0
        ? __DIR__ . '/backend/bin/qjs/qjs-windows-x86_64.exe'
        : __DIR__ . '/backend/bin/qjs/qjs-linux-x86_64';
    if (!file_exists($qjsBin)) {
        $steps[] = ['label' => 'FormLogic qjs runtime', 'status' => 'warn', 'message' => 'Binary not present at backend/bin/qjs — form logic & scripts will be disabled'];
    } else {
        $steps[] = ['label' => 'FormLogic qjs runtime', 'status' => 'ok'];
    }

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
        'message' => $hasErrors ? 'Installation completed with errors.' : 'Installation completed successfully!',
    ];
}

// ---------------------------------------------------------------------------
// HTML output
// ---------------------------------------------------------------------------
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
  <div class="alert alert-warn">
    <strong>FormLogic appears to be already installed.</strong> A configured <code>backend/.env</code> file was found.
    You can continue to reconfigure, or delete this file (<code>install.php</code>) for security.
  </div>
  <?php endif; ?>

  <!-- Step 1: Requirements -->
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
      <input type="text" id="cors_origin" value="http://localhost:5173" />
      <p class="help-text">The URL where the frontend dev server runs. Change if using a different port.</p>
    </div>
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

  <!-- Step 5: Next Steps (shown after install) -->
  <div class="card hidden" id="step-next">
    <h2><span class="step-num">5</span> Next Steps</h2>
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
        <li id="ns-wasm" class="hidden">
          The FormLogic qjs runtime binary is missing. It is vendored in the repo
          under <code>backend/bin/qjs/</code> — re-clone the repository, or fetch a
          static <code>qjs</code> build from
          <code>github.com/quickjs-ng/quickjs</code> for your platform.
        </li>
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
      </ol>
    </div>
    <div class="alert alert-warn" style="margin-top:16px;">
      <strong>Security:</strong> Delete <code>install.php</code> after you're done to prevent unauthorized reconfiguration.
    </div>
  </div>
</div>

<script>
const CSRF_TOKEN = <?= json_encode($csrfToken) ?>;

// Check requirements on page load
document.addEventListener('DOMContentLoaded', checkRequirements);

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
  }).then(result => {
    btn.disabled = false;
    btn.innerHTML = 'Run Installation';

    // Render steps
    stepsList.innerHTML = '';
    let needComposer = false, needNpm = false, needWasm = false;
    for (const step of result.steps) {
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

      if (step.label && step.label.includes('Composer') && step.status === 'warn') needComposer = true;
      if (step.label && step.label.includes('npm') && step.status === 'warn') needNpm = true;
      if (step.label && step.label.includes('qjs') && step.status === 'warn') needWasm = true;
    }

    // Show result
    resultDiv.classList.remove('hidden');
    if (result.success) {
      resultDiv.innerHTML = '<div class="alert alert-success">' + esc(result.message) + '</div>';
      // Show next steps
      const nextCard = document.getElementById('step-next');
      nextCard.classList.remove('hidden');
      if (needComposer) document.getElementById('ns-composer').classList.remove('hidden');
      if (needNpm) document.getElementById('ns-npm').classList.remove('hidden');
      if (needWasm) document.getElementById('ns-wasm').classList.remove('hidden');
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
