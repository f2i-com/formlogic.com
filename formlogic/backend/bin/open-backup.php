<?php

declare(strict_types=1);

// A web request never runs this. The folder can be reachable on a server without the bundle's
// rewrites, and a visit would run it with the site's credentials.
if (isset($_SERVER['REQUEST_METHOD'])) {
    http_response_code(404);
    exit;
}

/**
 * Sealed backups (.flbk). Needs no database and no .env, so it works on any machine with PHP and
 * this folder's vendor directory, which is where the secret key should be kept anyway.
 *
 *   php backend/bin/open-backup.php --new-key-pair <secret key file>
 *       Makes a key pair. Writes the secret key to the file and prints the public key, which goes
 *       in BACKUP_PUBLIC_KEY. Keep the secret key away from the server: that is the whole point.
 *
 *   php backend/bin/open-backup.php <file or folder> --secret-key-file=<secret key file>
 *       Opens a sealed file, or every .flbk under a nightly backup folder, next to itself. The
 *       sealed copy is kept. Then RESTORE.txt in the folder applies as written.
 *
 *   php backend/bin/open-backup.php <file> --passphrase
 *       Opens a passphrase-protected account download. The passphrase is read from standard input.
 *
 * Exits non-zero when anything could not be opened.
 */

require __DIR__ . '/../vendor/autoload.php';

use FormLogic\Support\BackupEnvelope;
use FormLogic\Support\DataEncryptionException;

$options = [];
$paths = [];
foreach (array_slice($argv, 1) as $arg) {
    if (str_starts_with($arg, '--')) {
        [$name, $value] = array_pad(explode('=', $arg, 2), 2, '');
        $options[$name] = $value;
    } else {
        $paths[] = $arg;
    }
}

if (isset($options['--new-key-pair'])) {
    $file = (string) ($paths[0] ?? '');
    if ($file === '' || file_exists($file)) {
        fwrite(STDERR, "Name a secret key file that does not exist yet.\n");
        exit(2);
    }
    [$public, $secret] = BackupEnvelope::generateKeyPair();
    $oldUmask = umask(0077);
    try {
        $handle = @fopen($file, 'x');
    } finally {
        umask($oldUmask);
    }
    if ($handle === false) {
        if (function_exists('sodium_memzero')) {
            sodium_memzero($secret);
        }
        fwrite(STDERR, "Could not create {$file}\n");
        exit(1);
    }
    if (PHP_OS_FAMILY !== 'Windows' && !@chmod($file, 0600)) {
        fclose($handle);
        @unlink($file);
        if (function_exists('sodium_memzero')) {
            sodium_memzero($secret);
        }
        fwrite(STDERR, "Could not restrict permissions on {$file}\n");
        exit(1);
    }
    fwrite($handle, $secret . "\n");
    fclose($handle);
    if (function_exists('sodium_memzero')) {
        sodium_memzero($secret);
    }
    echo "Secret key written to {$file}. Keep it off this server, and keep a second copy: nothing else opens these backups.\n";
    echo "BACKUP_PUBLIC_KEY={$public}\n";
    exit(0);
}

$with = [];
if (isset($options['--secret-key-file'])) {
    $rawKeyText = trim((string) @file_get_contents($options['--secret-key-file']));
    $secret = base64_decode($rawKeyText, true);
    if (function_exists('sodium_memzero')) {
        sodium_memzero($rawKeyText);
    }
    if (!is_string($secret) || strlen($secret) !== SODIUM_CRYPTO_BOX_SECRETKEYBYTES) {
        if (is_string($secret) && function_exists('sodium_memzero')) {
            sodium_memzero($secret);
        }
        fwrite(STDERR, "That is not a secret key file.\n");
        exit(2);
    }
    $with['secretKey'] = $secret;
} elseif (isset($options['--passphrase'])) {
    $with['passphrase'] = rtrim((string) fgets(STDIN), "\r\n");
}

$target = rtrim((string) ($paths[0] ?? ''), '/\\');
if ($with === [] || $target === '' || !file_exists($target)) {
    if (function_exists('sodium_memzero')) {
        if (isset($with['secretKey']) && is_string($with['secretKey'])) sodium_memzero($with['secretKey']);
        if (isset($with['passphrase']) && is_string($with['passphrase'])) sodium_memzero($with['passphrase']);
    }
    fwrite(STDERR, "Usage: php backend/bin/open-backup.php <file or folder> --secret-key-file=<file> | --passphrase\n");
    exit(2);
}

$listWithExt = static function (string $dir, string $ext): array {
    if (!is_dir($dir)) return [];
    $entries = @scandir($dir);
    if (!is_array($entries)) return [];
    $out = [];
    foreach ($entries as $entry) {
        if ($entry === '.' || $entry === '..' || !str_ends_with($entry, $ext)) continue;
        $full = $dir . DIRECTORY_SEPARATOR . $entry;
        if (is_file($full)) $out[] = $full;
    }
    sort($out);
    return $out;
};

$sealed = is_dir($target)
    ? [...$listWithExt($target, BackupEnvelope::EXTENSION), ...$listWithExt($target . DIRECTORY_SEPARATOR . 'accounts', BackupEnvelope::EXTENSION)]
    : [$target];
if ($sealed === []) {
    if (function_exists('sodium_memzero')) {
        if (isset($with['secretKey']) && is_string($with['secretKey'])) sodium_memzero($with['secretKey']);
        if (isset($with['passphrase']) && is_string($with['passphrase'])) sodium_memzero($with['passphrase']);
    }
    fwrite(STDERR, "No sealed files there.\n");
    exit(2);
}

$failed = 0;
try {
    foreach ($sealed as $path) {
        $opened = str_ends_with($path, BackupEnvelope::EXTENSION) ? substr($path, 0, -strlen(BackupEnvelope::EXTENSION)) : $path . '.opened';
        try {
            BackupEnvelope::open($path, $opened, $with);
            echo "Opened {$opened}\n";
        } catch (DataEncryptionException $e) {
            $failed++;
            fwrite(STDERR, basename($path) . ': ' . $e->getMessage() . "\n");
        }
    }
} finally {
    if (function_exists('sodium_memzero')) {
        if (isset($with['secretKey']) && is_string($with['secretKey'])) sodium_memzero($with['secretKey']);
        if (isset($with['passphrase']) && is_string($with['passphrase'])) sodium_memzero($with['passphrase']);
    }
}
exit($failed > 0 ? 1 : 0);
