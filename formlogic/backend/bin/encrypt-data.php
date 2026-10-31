<?php

declare(strict_types=1);

// A web request never runs this. The folder can be reachable on a server without the bundle's
// rewrites, and a visit would run it with the site's credentials.
if (isset($_SERVER['REQUEST_METHOD'])) {
    http_response_code(404);
    exit;
}

/**
 * Encrypts what is stored under DATA_ENCRYPTION_KEY, and moves it to a new key.
 *
 *   php backend/bin/encrypt-data.php --new-key   prints a new key, and changes nothing
 *   php backend/bin/encrypt-data.php             encrypts everything not yet encrypted
 *
 * To change the key: put the new one in DATA_ENCRYPTION_KEY, put the old one in
 * DATA_ENCRYPTION_KEY_PREVIOUS, run this, then remove the old one. Safe to run again.
 * Exits non-zero when anything could not be moved, and says what.
 *
 * Keep a copy of the key somewhere other than this server and its backups. Without it, what it
 * encrypted can't be read by anyone.
 */

require __DIR__ . '/../vendor/autoload.php';

date_default_timezone_set('UTC');

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\DataEncryptionMigrator;
use FormLogic\Support\DataEncryption;

if (in_array('--new-key', $argv, true)) {
    echo DataEncryption::generateKey(), "\n";
    exit(0);
}

if (class_exists(\Dotenv\Dotenv::class) && is_file(__DIR__ . '/../.env')) {
    \Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();
}
$config = require __DIR__ . '/../config/settings.php';
$mysql = new MySQLConnection($config['settings']['mysql']);
$mysql->runMigrations();

$crypto = DataEncryption::fromEnvironment();
if (!$crypto->enabled()) {
    fwrite(STDERR, "DATA_ENCRYPTION_KEY is not set to a valid key. Make one with --new-key.\n");
    exit(2);
}

$result = (new DataEncryptionMigrator($mysql->getConnection(), __DIR__ . '/../storage/hosted-apps'))->run($crypto);
printf("%d secrets and %d records in %d apps moved onto key %s\n", $result['secrets'], $result['records'], $result['apps'], $crypto->currentKeyId());
foreach ($result['failed'] as $failure) {
    fwrite(STDERR, "FAILED: {$failure}\n");
}
exit($result['failed'] === [] ? 0 : 1);
