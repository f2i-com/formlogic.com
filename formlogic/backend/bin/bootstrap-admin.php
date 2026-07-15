<?php

declare(strict_types=1);

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\AuthService;
use FormLogic\Support\Environment;

require __DIR__ . '/../vendor/autoload.php';
Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();
Environment::bootstrap();

$email = strtolower(trim((string) ($argv[1] ?? Environment::get('ADMIN_BOOTSTRAP_EMAIL', ''))));
$expectedSecret = (string) Environment::get('ADMIN_BOOTSTRAP_SECRET', '');
$providedSecret = (string) ($argv[2] ?? Environment::get('ADMIN_BOOTSTRAP_CREDENTIAL', ''));
$password = (string) Environment::get('ADMIN_BOOTSTRAP_PASSWORD', '');
$reserved = array_values(array_filter(array_map(
    static fn (string $value): string => strtolower(trim($value)),
    explode(',', (string) Environment::get('ADMIN_EMAILS', ''))
)));

if (!filter_var($email, FILTER_VALIDATE_EMAIL) || !in_array($email, $reserved, true)) {
    fwrite(STDERR, "Pass an email reserved in ADMIN_EMAILS.\n");
    exit(2);
}
if (strlen($expectedSecret) < 32) {
    fwrite(STDERR, "ADMIN_BOOTSTRAP_SECRET must contain at least 32 characters.\n");
    exit(2);
}
if ($providedSecret === '' || !hash_equals($expectedSecret, $providedSecret)) {
    fwrite(STDERR, "Invalid administrator bootstrap credential.\n");
    exit(1);
}
if ($password !== '' && ($error = AuthService::passwordError($password)) !== null) {
    fwrite(STDERR, $error . "\n");
    exit(2);
}

$settings = require __DIR__ . '/../config/settings.php';
$mysql = new MySQLConnection($settings['settings']['mysql']);
$mysql->ensureSchemaCurrent();
$pdo = $mysql->getConnection();

try {
    $pdo->beginTransaction();
    $claim = $pdo->prepare(
        "INSERT IGNORE INTO system_meta(meta_key, meta_value)
         VALUES ('admin_bootstrap_consumed', :secret_hash)"
    );
    $claim->execute(['secret_hash' => hash('sha256', $providedSecret)]);
    if ($claim->rowCount() !== 1) {
        throw new RuntimeException('Administrator bootstrap has already been consumed.');
    }

    $adminCount = (int) $pdo->query('SELECT COUNT(*) FROM users WHERE is_admin = 1')->fetchColumn();
    if ($adminCount > 0) {
        // Permanently close bootstrap on upgraded installations that already
        // have an administrator but predate the consumption marker.
        $pdo->commit();
        throw new RuntimeException('An administrator already exists; bootstrap is now closed.');
    }

    $find = $pdo->prepare('SELECT id FROM users WHERE LOWER(email) = :email LIMIT 1 FOR UPDATE');
    $find->execute(['email' => $email]);
    $userId = $find->fetchColumn();
    if ($userId === false) {
        if ($password === '') {
            throw new RuntimeException(
                'The reserved account does not exist; set ADMIN_BOOTSTRAP_PASSWORD to create it.'
            );
        }
        $hex = bin2hex(random_bytes(16));
        $userId = sprintf('%s-%s-%s-%s-%s', substr($hex, 0, 8), substr($hex, 8, 4), substr($hex, 12, 4), substr($hex, 16, 4), substr($hex, 20));
        $create = $pdo->prepare(
            'INSERT INTO users(id, email, password_hash, name, is_admin, token_version)
             VALUES (:id, :email, :password_hash, :name, 1, 1)'
        );
        $create->execute([
            'id' => $userId,
            'email' => $email,
            'password_hash' => password_hash($password, PASSWORD_DEFAULT),
            'name' => 'Administrator',
        ]);
    } else {
        $promote = $pdo->prepare(
            'UPDATE users SET is_admin = 1, token_version = token_version + 1 WHERE id = :id'
        );
        $promote->execute(['id' => $userId]);
    }

    // Invalidate every pre-bootstrap JWT, including sessions minted while an
    // older release still treated an email string as authority.
    $revoke = $pdo->prepare('UPDATE users SET token_version = token_version + 1 WHERE id <> :id');
    $revoke->execute(['id' => $userId]);
    $pdo->commit();
    fwrite(STDOUT, "Administrator bootstrapped. Remove ADMIN_BOOTSTRAP_SECRET and ADMIN_BOOTSTRAP_PASSWORD now.\n");
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    fwrite(STDERR, $e->getMessage() . "\n");
    exit(1);
}
