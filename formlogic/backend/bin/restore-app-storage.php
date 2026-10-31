<?php

declare(strict_types=1);

// A web request never runs this. The folder can be reachable on a server without the bundle's
// rewrites, and a visit would run it with the site's credentials.
if (isset($_SERVER['REQUEST_METHOD'])) {
    http_response_code(404);
    exit;
}

/**
 * Whole-site recovery: puts native and hosted apps back on disk from a scheduled backup, under
 * their original ids (RESTORE.txt in the backup, step 2c). Run it after database.sql.gz is back.
 *
 *   php backend/bin/restore-app-storage.php storage/backups/scheduled/2026-10-31
 *
 * Safe to run again: storage already there is never replaced, and an app with no row in the
 * restored database is left out. Exits non-zero when any archive could not be restored.
 */

require __DIR__ . '/../vendor/autoload.php';

date_default_timezone_set('UTC');

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AccountBackupService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use Psr\Log\NullLogger;

$folder = rtrim((string) ($argv[1] ?? ''), '/\\');
if ($folder === '' || !is_dir($folder . '/accounts')) {
    fwrite(STDERR, "Usage: php backend/bin/restore-app-storage.php <scheduled backup folder>\n");
    exit(2);
}
if ((glob($folder . '/accounts/*.zip') ?: []) === [] && (glob($folder . '/accounts/*.flbk') ?: []) !== []) {
    fwrite(STDERR, "This backup is sealed. Open it first: php backend/bin/open-backup.php {$folder} --secret-key-file=<your secret key file>\n");
    exit(2);
}

if (class_exists(\Dotenv\Dotenv::class) && is_file(__DIR__ . '/../.env')) {
    \Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();
}
$config = require __DIR__ . '/../config/settings.php';
$settings = $config['settings'];

$mysql = new MySQLConnection($settings['mysql']);
$sqlite = new SQLiteConnection($settings['sqlite']['storage_path']);
$formService = new FormService($mysql, $sqlite);
$backup = new AccountBackupService(
    $mysql,
    $sqlite,
    $formService,
    new AppService($mysql, $formService),
    new AppUserService($mysql),
    new FlowService($mysql),
    new ResponseService($mysql, $sqlite),
    $settings['backups'] ?? [],
    $settings['sqlite']['storage_path'],
    $settings['uploads']['storagePath'] ?? __DIR__ . '/../storage/uploads',
    null,
    new NullLogger()
);

$failed = 0;
foreach (glob($folder . '/accounts/*.zip') ?: [] as $zip) {
    try {
        $result = $backup->restoreAppStorage($zip);
        printf(
            "%s: %d restored, %d already there, %d with no app\n",
            basename($zip),
            count($result['restored']),
            count($result['kept']),
            count($result['noApp'])
        );
        foreach ($result['warnings'] as $warning) {
            printf("  %s\n", $warning);
        }
    } catch (\Throwable $e) {
        $failed++;
        fwrite(STDERR, sprintf("%s: FAILED: %s\n", basename($zip), $e->getMessage()));
    }
}

exit($failed > 0 ? 1 : 0);
