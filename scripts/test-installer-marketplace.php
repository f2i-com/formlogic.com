<?php
// Local integration smoke: creates and removes its own uniquely named MySQL database.
declare(strict_types=1);
$backend = dirname(__DIR__) . '/formlogic/backend';
require $backend . '/vendor/autoload.php';
Dotenv\Dotenv::createImmutable($backend)->safeLoad();
$env = static fn(string $name, string $fallback = ''): string => (string) ($_ENV[$name] ?? (getenv($name) ?: $fallback));
$host = $env('DB_HOST', '127.0.0.1');
$port = $env('DB_PORT', '3306');
$user = $env('DB_USERNAME', 'root');
$pass = $env('DB_PASSWORD');
$name = 'formlogic_installer_smoke_' . bin2hex(random_bytes(6));
$pdo = new PDO("mysql:host=$host;port=$port;charset=utf8mb4", $user, $pass, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$pdo->exec("CREATE DATABASE `$name` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
try {
    $childEnv = array_merge(getenv(), ['DB_HOST' => $host, 'DB_PORT' => $port, 'DB_USERNAME' => $user, 'DB_PASSWORD' => $pass, 'DB_DATABASE' => $name]);
    for ($i = 0; $i < 2; $i++) {
        $process = proc_open([PHP_BINARY, '-d', 'xdebug.mode=off', '-r', '$_ENV["DB_PASSWORD"] = getenv("DB_PASSWORD") ?: ""; require $argv[1];', $backend . '/bin/provision-demo.php', '--catalog-only'], [0 => ['pipe','r'], 1 => ['pipe','w'], 2 => ['redirect',1]], $pipes, $backend, $childEnv, ['bypass_shell' => true]);
        if (!is_resource($process)) throw new RuntimeException('Cannot launch provisioning test');
        fclose($pipes[0]);
        $output = stream_get_contents($pipes[1]);
        fclose($pipes[1]);
        $exit = proc_close($process);
        if ($exit !== 0) throw new RuntimeException('Catalogue provisioning failed: ' . $output);
        $count = (int) $pdo->query("SELECT COUNT(*) FROM `$name`.pack_catalog")->fetchColumn();
        $apps = (int) $pdo->query("SELECT COUNT(*) FROM `$name`.apps")->fetchColumn();
        $demo = $pdo->prepare("SELECT COUNT(*) FROM `$name`.users WHERE email = ?");
        $demo->execute([$env('DEMO_EMAIL', 'demo@formlogic.local')]);
        if ($count < 1 || $apps !== 0 || (int) $demo->fetchColumn() !== 0) throw new RuntimeException('Catalogue-only setup created unexpected demo data or an empty catalogue');
        if ($i === 0) $initial = $count;
        if ($count !== $initial) throw new RuntimeException('Rerun duplicated catalogue entries');
        echo 'Pass ' . ($i + 1) . ": $count installable packs; no demo apps or demo records created.\n";
    }
    // Exercise latest-version lookup with a small MySQL sort buffer in the same
    // disposable database; none of these tests use the local review database.
    $_ENV = array_merge($_ENV, $childEnv, ['DB_TEST_DATABASE' => $name]);
    $code = (new PHPUnit\TextUI\Application())->run([
        $backend . '/vendor/phpunit/phpunit/phpunit',
        '--no-configuration', '--do-not-cache-result',
        $backend . '/tests/Integration/PackCatalogVersionSyncTest.php',
    ]);
    if ($code !== 0) throw new RuntimeException('Pack-version database regression tests failed');
} finally {
    if (!preg_match('/^formlogic_installer_smoke_[a-f0-9]{12}$/', $name)) throw new RuntimeException('Invalid cleanup target');
    $pdo->exec("DROP DATABASE `$name`");
}
