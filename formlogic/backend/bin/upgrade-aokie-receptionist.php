<?php

declare(strict_types=1);

/**
 * Safely upgrade one existing Aokie Receptionist app in place.
 *
 * Usage (from backend/):
 *   php bin/upgrade-aokie-receptionist.php --app=<uuid> --dry-run
 *   php bin/upgrade-aokie-receptionist.php --app=<uuid> --apply
 */

require __DIR__ . '/../vendor/autoload.php';
date_default_timezone_set('UTC');

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AokieReceptionistUpgradeService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\FormVersionService;
use FormLogic\Services\PackService;

$usage = static function (int $exitCode): never {
    $stream = $exitCode === 0 ? STDOUT : STDERR;
    fwrite($stream, "Usage:\n");
    fwrite($stream, "  php bin/upgrade-aokie-receptionist.php --app=<uuid> --dry-run\n");
    fwrite($stream, "  php bin/upgrade-aokie-receptionist.php --app=<uuid> --apply\n");
    exit($exitCode);
};

$options = getopt('', ['app:', 'dry-run', 'apply', 'help']);
if (!is_array($options)) {
    $options = [];
}
if (isset($options['help'])) {
    $usage(0);
}
$appId = is_string($options['app'] ?? null) ? trim($options['app']) : '';
$dryRun = array_key_exists('dry-run', $options);
$apply = array_key_exists('apply', $options);
if ($appId === '' || $dryRun === $apply) {
    $usage(2);
}

try {
    if (class_exists(\Dotenv\Dotenv::class) && is_file(__DIR__ . '/../.env')) {
        \Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();
    }
    $config = require __DIR__ . '/../config/settings.php';
    $packFile = __DIR__ . '/../resources/marketplace-packs/aokie-receptionist.json';
    $raw = file_get_contents($packFile);
    $record = is_string($raw) ? json_decode($raw, true, 512, JSON_THROW_ON_ERROR) : null;
    if (!is_array($record)) {
        throw new \RuntimeException('Bundled Aokie marketplace pack could not be read');
    }

    $mysql = new MySQLConnection($config['settings']['mysql']);
    $sqlite = new SQLiteConnection($config['settings']['sqlite']['storage_path']);
    $forms = new FormService($mysql, $sqlite);
    $apps = new AppService($mysql, $forms);
    $packs = new PackService($mysql, $forms, $apps, new AppUserService($mysql));
    $service = new AokieReceptionistUpgradeService(
        $mysql,
        $forms,
        new FormVersionService($mysql, $forms),
        new FlowService($mysql),
        $packs
    );
    $result = $service->run($appId, $record, $apply);
    fwrite(STDOUT, json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n");
    exit(0);
} catch (\PDOException $e) {
    fwrite(STDERR, "Upgrade failed safely (database error). No content was printed.\n");
    exit(1);
} catch (\InvalidArgumentException | \RuntimeException $e) {
    // All expected messages are bounded and contain identifiers only; never
    // print pack contents, flow JSON, response data, credentials, or SQL.
    $message = preg_replace('/[\x00-\x1F\x7F]+/', ' ', $e->getMessage()) ?? 'Upgrade refused';
    fwrite(STDERR, 'Upgrade refused: ' . substr($message, 0, 300) . "\n");
    exit(1);
} catch (\Throwable $e) {
    fwrite(STDERR, 'Upgrade failed safely (' . get_class($e) . "). No content was printed.\n");
    exit(1);
}
