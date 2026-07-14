<?php

declare(strict_types=1);

/**
 * FormLogic database upgrade CLI (see docs/UPGRADING.md for the full runbook).
 *
 * The web app already self-upgrades: the DI bootstrap (public/index.php) runs
 * MySQLConnection::initializeSchema() + runMigrations() once per process, and every migration is
 * guarded + idempotent (CREATE TABLE IF NOT EXISTS / SHOW COLUMNS / SHOW INDEX before each ALTER).
 * So an existing install is migrated by the first request that hits the new code. This CLI is the
 * OPERATOR-grade version of that same path:
 *
 *   - run the migrations deliberately, BEFORE traffic hits the new code, with step logging and an
 *     exit code — instead of paying the migration cost inside a live web request (PHP-FPM time
 *     limits, no visibility, a slow first request on big tables);
 *   - verify the core tables exist afterwards;
 *   - stamp a schema_meta table (app_version / last_upgrade_at / upgrade_source) so any install can
 *     tell you what version its schema was last upgraded to;
 *   - --check: READ-ONLY drift report (core tables + recently-migrated columns/indexes), exit 0/1.
 *
 * Usage (deployed zip layout — the backend lives at <web-root>/api):
 *   php api/bin/upgrade.php --app-version=1.4.0    # migrate + stamp this version
 *   php api/bin/upgrade.php                        # version falls back to the VERSION file (api/VERSION)
 *   php api/bin/upgrade.php --check                # read-only drift report; writes nothing
 *
 * In a source checkout the backend is formlogic/backend, so:
 *   php formlogic/backend/bin/upgrade.php --check
 *
 * Exit codes: 0 = success / check passed; 1 = drift found or post-migration verification failed;
 *             2 = bad arguments, config error, or database unreachable.
 *
 * Idempotent: safe to run any number of times.
 */

require __DIR__ . '/../vendor/autoload.php';

use FormLogic\Database\MySQLConnection;

/**
 * Resolve the version string to stamp into schema_meta.
 * Precedence: --app-version=<v> flag > the VERSION file shipped next to the backend root
 * (<deploy>/api/VERSION, i.e. __DIR__/../VERSION from bin/) > 'unknown'.
 *
 * @param array<int,string> $argv
 * @return array{0:string,1:string} [version, source] where source is 'flag' | 'file' | 'none'
 */
function formlogicUpgradeResolveVersion(array $argv, ?string $versionFile): array
{
    foreach ($argv as $arg) {
        if (preg_match('/^--app-version=(.+)$/', $arg, $m)) {
            $v = trim($m[1]);
            if ($v !== '') {
                return [$v, 'flag'];
            }
        }
    }
    if ($versionFile !== null && is_file($versionFile)) {
        $v = trim((string) file_get_contents($versionFile));
        if ($v !== '') {
            return [$v, 'file'];
        }
    }
    return ['unknown', 'none'];
}

/**
 * The fixed list of core tables an upgraded install must have (a representative slice of the
 * schema: auth, forms, the app platform, offline sync, custom domains, rate limiting).
 *
 * @return array<int,string>
 */
function formlogicUpgradeCoreTables(): array
{
    return [
        'users',
        'forms',
        'apps',
        'app_forms',
        'app_users',
        'app_submission_idempotency',
        'app_domains',
        'rate_limits',
    ];
}

/**
 * Recently-migrated columns/indexes probed by --check to surface drift on an install whose schema
 * predates them (all are added by MySQLConnection::runMigrations()).
 *
 * @return array{columns: array<int,array{0:string,1:string}>, indexes: array<int,array{0:string,1:string}>}
 */
function formlogicUpgradeDriftProbes(): array
{
    return [
        'columns' => [
            ['apps', 'reports'],
            ['apps', 'custom_logic'],
            ['forms', 'custom_logic'],
            ['forms', 'custom_screen'],
            ['users', 'cloud_until'],
        ],
        'indexes' => [
            ['app_forms', 'idx_form_id'],
            ['app_submission_idempotency', 'idx_idem_created'],
        ],
    ];
}

function formlogicUpgradeTableExists(\PDO $pdo, string $table): bool
{
    // Escape LIKE wildcards so 'app_forms' can't false-positive on e.g. 'appXforms'.
    $like = addcslashes($table, '_%');
    $stmt = $pdo->query("SHOW TABLES LIKE '{$like}'");
    return $stmt !== false && $stmt->rowCount() > 0;
}

function formlogicUpgradeColumnExists(\PDO $pdo, string $table, string $column): bool
{
    try {
        $like = addcslashes($column, '_%');
        $stmt = $pdo->query("SHOW COLUMNS FROM `{$table}` LIKE '{$like}'");
        return $stmt !== false && $stmt->rowCount() > 0;
    } catch (\Throwable $e) {
        return false; // table itself missing
    }
}

function formlogicUpgradeIndexExists(\PDO $pdo, string $table, string $index): bool
{
    try {
        $stmt = $pdo->query("SHOW INDEX FROM `{$table}` WHERE Key_name = '{$index}'");
        return $stmt !== false && $stmt->rowCount() > 0;
    } catch (\Throwable $e) {
        return false;
    }
}

/**
 * --check: read-only schema drift report. Writes NOTHING. Returns 0 when every core table and
 * every drift probe is present, 1 otherwise. The schema_meta stamp is reported informationally
 * only (web auto-migration never stamps it, so its absence is not drift).
 */
function formlogicUpgradeCheck(\PDO $pdo, callable $out): int
{
    $out('READ-ONLY check: core tables + recently-migrated columns/indexes (nothing will be written).');

    $missing = [];
    foreach (formlogicUpgradeCoreTables() as $table) {
        $ok = formlogicUpgradeTableExists($pdo, $table);
        $out(sprintf('  table   %-42s %s', $table, $ok ? 'ok' : 'MISSING'));
        if (!$ok) {
            $missing[] = "table {$table}";
        }
    }

    $probes = formlogicUpgradeDriftProbes();
    foreach ($probes['columns'] as [$table, $column]) {
        $ok = formlogicUpgradeColumnExists($pdo, $table, $column);
        $out(sprintf('  column  %-42s %s', "{$table}.{$column}", $ok ? 'ok' : 'MISSING'));
        if (!$ok) {
            $missing[] = "column {$table}.{$column}";
        }
    }
    foreach ($probes['indexes'] as [$table, $index]) {
        $ok = formlogicUpgradeIndexExists($pdo, $table, $index);
        $out(sprintf('  index   %-42s %s', "{$table}.{$index}", $ok ? 'ok' : 'MISSING'));
        if (!$ok) {
            $missing[] = "index {$table}.{$index}";
        }
    }

    // Informational: what (if anything) the CLI last stamped.
    if (formlogicUpgradeTableExists($pdo, 'schema_meta')) {
        try {
            $stmt = $pdo->query(
                "SELECT meta_key, meta_value FROM schema_meta
                 WHERE meta_key IN ('app_version', 'last_upgrade_at', 'upgrade_source')"
            );
            $meta = [];
            foreach (($stmt ? $stmt->fetchAll(\PDO::FETCH_ASSOC) : []) as $row) {
                $meta[$row['meta_key']] = $row['meta_value'];
            }
            $out(sprintf(
                '  schema_meta: app_version=%s, last_upgrade_at=%s, upgrade_source=%s',
                $meta['app_version'] ?? '(not set)',
                $meta['last_upgrade_at'] ?? '(not set)',
                $meta['upgrade_source'] ?? '(not set)'
            ));
        } catch (\Throwable $e) {
            $out('  schema_meta: present but unreadable (' . $e->getMessage() . ')');
        }
    } else {
        $out('  schema_meta: not present — this install has never been upgraded via this CLI'
            . ' (web auto-migration does not stamp it). Not counted as drift.');
    }

    if ($missing !== []) {
        $out('CHECK FAILED — schema drift detected (' . count($missing) . ' item(s) missing): '
            . implode(', ', $missing));
        $out('Run "php bin/upgrade.php" (no --check) to apply the migrations.');
        return 1;
    }
    $out('Check passed: all core tables and probed columns/indexes are present.');
    return 0;
}

/**
 * The upgrade proper: ensure base schema, run all guarded migrations, verify the core tables, and
 * stamp schema_meta. Returns 0 on success, 1 if a core table is still missing afterwards.
 *
 * $versionSource is 'flag' | 'file' | 'none' (from formlogicUpgradeResolveVersion) — logged so the
 * operator can see where the stamped version came from.
 */
function formlogicUpgradeRun(MySQLConnection $mysql, string $version, string $versionSource, callable $out): int
{
    $pdo = $mysql->getConnection();

    // Read any prior stamp BEFORE writing, so a re-run can be called out explicitly and an
    // 'unknown' version never clobbers a previously-stamped real one.
    $previousUpgradeAt = null;
    $previousVersion = null;
    if (formlogicUpgradeTableExists($pdo, 'schema_meta')) {
        try {
            $stmt = $pdo->query(
                "SELECT meta_key, meta_value FROM schema_meta
                 WHERE meta_key IN ('app_version', 'last_upgrade_at')"
            );
            foreach (($stmt ? $stmt->fetchAll(\PDO::FETCH_ASSOC) : []) as $row) {
                $val = ($row['meta_value'] === null || $row['meta_value'] === '') ? null : (string) $row['meta_value'];
                if ($row['meta_key'] === 'last_upgrade_at') {
                    $previousUpgradeAt = $val;
                } elseif ($row['meta_key'] === 'app_version') {
                    $previousVersion = $val;
                }
            }
        } catch (\Throwable $e) {
            $previousUpgradeAt = null;
            $previousVersion = null;
        }
    }

    $mysql->initializeSchema();
    $out('Schema ensured (base tables present).');

    $mysql->runMigrations();
    $out('Migrations applied (every step is guarded — already-applied steps are no-ops).');

    $missing = [];
    foreach (formlogicUpgradeCoreTables() as $table) {
        if (!formlogicUpgradeTableExists($pdo, $table)) {
            $missing[] = $table;
        }
    }
    $total = count(formlogicUpgradeCoreTables());
    if ($missing !== []) {
        $out(sprintf(
            'ERROR: core tables still missing after migration (%d/%d present): %s',
            $total - count($missing),
            $total,
            implode(', ', $missing)
        ));
        return 1;
    }
    $out(sprintf(
        'Core tables verified: %d/%d present (%s).',
        $total,
        $total,
        implode(', ', formlogicUpgradeCoreTables())
    ));

    // Stamp schema_meta so the install records what it was upgraded to, when, and by what.
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
    // 'unknown' never overwrites a previously-stamped real version (an operator re-running the CLI
    // without --app-version in a source checkout shouldn't lose the install's version stamp).
    $keptPrevious = ($version === 'unknown' && $previousVersion !== null && $previousVersion !== 'unknown');
    $stampedVersion = $keptPrevious ? $previousVersion : $version;
    $stamp->execute(['k' => 'app_version', 'v' => $stampedVersion]);
    $stamp->execute(['k' => 'last_upgrade_at', 'v' => $now]);
    $stamp->execute(['k' => 'upgrade_source', 'v' => 'cli']);

    $sourceLabel = match (true) {
        $keptPrevious => "kept existing stamp — no --app-version flag and no VERSION file",
        $versionSource === 'flag' => 'from --app-version',
        $versionSource === 'file' => 'from the VERSION file',
        default => "no --app-version flag and no VERSION file — stamped 'unknown'",
    };
    $out(sprintf(
        'schema_meta stamped: app_version=%s (%s), last_upgrade_at=%s UTC, upgrade_source=cli.',
        $stampedVersion,
        $sourceLabel,
        $now
    ));

    if ($previousUpgradeAt !== null) {
        $out(sprintf(
            'Re-run detected (previous upgrade stamp: %s UTC) — all steps were no-ops where already'
            . ' applied; this command is idempotent and safe to repeat.',
            $previousUpgradeAt
        ));
    } else {
        $out('Upgrade complete. Running this command again is safe (idempotent).');
    }
    return 0;
}

/** @param resource $stream */
function formlogicUpgradeUsage($stream): void
{
    fwrite($stream, <<<'USAGE'
FormLogic database upgrade CLI

Usage:
  php bin/upgrade.php [--app-version=<v>]  Ensure schema + run all migrations, verify core tables,
                                           stamp schema_meta. Idempotent — safe to re-run.
  php bin/upgrade.php --check              Read-only: report which core tables / recently-migrated
                                           columns and indexes exist. Writes nothing.
  php bin/upgrade.php --help               This help.

Version stamped into schema_meta: the --app-version flag, else the VERSION file next to the backend
root (<deploy>/api/VERSION), else 'unknown'.

Exit codes:
  0  success / check passed
  1  drift found (--check) or post-migration verification failed
  2  bad arguments, config error, or database unreachable

Back up first — see docs/UPGRADING.md for the full upgrade runbook.

USAGE);
}

// Guard so this file is require-able from tests (which exercise the functions above in-process
// against the test DB). With FORMLOGIC_UPGRADE_NO_RUN defined — or outside the CLI SAPI — everything
// below (env/settings load + DB work) is skipped. Mirrors bin/idempotency-cleanup.php.
if (PHP_SAPI !== 'cli' || (defined('FORMLOGIC_UPGRADE_NO_RUN') && FORMLOGIC_UPGRADE_NO_RUN)) {
    return;
}

// Match the web app: PHP timezone UTC so stamped timestamps align with the DB session (+00:00).
date_default_timezone_set('UTC');

$argvSafe = is_array($argv ?? null) ? $argv : [];
$args = array_slice($argvSafe, 1);

$check = false;
foreach ($args as $arg) {
    if ($arg === '--check') {
        $check = true;
        continue;
    }
    if ($arg === '--help' || $arg === '-h') {
        formlogicUpgradeUsage(STDOUT);
        exit(0);
    }
    if (preg_match('/^--app-version=./', $arg)) {
        continue;
    }
    fwrite(STDERR, "Unknown or malformed argument: {$arg}\n\n");
    formlogicUpgradeUsage(STDERR);
    exit(2);
}

// Load environment + settings exactly the way the web app does (mirrors public/index.php).
if (class_exists(\Dotenv\Dotenv::class) && is_file(__DIR__ . '/../.env')) {
    \Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();
}
try {
    $config = require __DIR__ . '/../config/settings.php';
} catch (\Throwable $e) {
    // settings.php fails hard on unsafe production config (placeholder JWT_SECRET / default
    // DB_PASSWORD) — the app itself would refuse to boot too, so surface it and stop.
    fwrite(STDERR, sprintf(
        "Config error: %s\nFix the .env next to the backend root (api/.env in a deployed install), then re-run.\n",
        $e->getMessage()
    ));
    exit(2);
}

$mysql = new MySQLConnection($config['settings']['mysql']);
try {
    $pdo = $mysql->getConnection();
    $pdo->query('SELECT 1');
} catch (\Throwable $e) {
    $mysqlCfg = $config['settings']['mysql'];
    fwrite(STDERR, sprintf(
        "Database unreachable: %s\n"
        . "Tried %s:%s / database '%s' as user '%s' (from DB_HOST / DB_PORT / DB_DATABASE / DB_USERNAME /"
        . " DB_PASSWORD in the backend .env — api/.env in a deployed install).\n"
        . "Check that MySQL is running, the credentials are correct, and the database exists — this tool"
        . " upgrades an existing FormLogic database, it does not create it.\n",
        $e->getMessage(),
        $mysqlCfg['host'],
        $mysqlCfg['port'],
        $mysqlCfg['database'],
        $mysqlCfg['username']
    ));
    exit(2);
}

$out = static function (string $line): void {
    fwrite(STDOUT, sprintf("[%s] %s\n", date('c'), $line));
};

if ($check) {
    exit(formlogicUpgradeCheck($pdo, $out));
}

[$version, $versionSource] = formlogicUpgradeResolveVersion($args, __DIR__ . '/../VERSION');
exit(formlogicUpgradeRun($mysql, $version, $versionSource, $out));
