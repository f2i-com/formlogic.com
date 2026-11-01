<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\MaintenanceService;
use FormLogic\Services\UpgradeService;
use FormLogic\Support\DataEncryption;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * bin/upgrade.php — the operator-grade DB upgrade CLI (docs/UPGRADING.md).
 *
 * Mirrors IdempotencyCleanupTest: the script is require-able with FORMLOGIC_UPGRADE_NO_RUN defined,
 * which skips the bottom-of-file bootstrap (env/settings/DB) and exposes only its functions. The
 * tests then drive the SAME code paths the CLI dispatches to (formlogicUpgradeRun /
 * formlogicUpgradeCheck) in-process against the TEST database — spawning a child `php bin/upgrade.php`
 * is deliberately avoided because the script's settings.php bootstrap targets the app database and
 * env plumbing through proc_open is fragile (Windows variables_order/$_ENV gotchas).
 *
 * Layers:
 *   1. Version resolution (--app-version flag > VERSION file > 'unknown'). No DB needed.
 *   2. Full run: schema ensured + migrations + core-table verification + schema_meta stamp; a second
 *      run is idempotent; --check passes read-only on the migrated DB. Skipped without a test DB.
 */
class UpgradeScriptTest extends TestCase
{
    private static ?PDO $pdo = null;
    private static ?MySQLConnection $mysql = null;

    public static function setUpBeforeClass(): void
    {
        if (!defined('FORMLOGIC_UPGRADE_NO_RUN')) {
            define('FORMLOGIC_UPGRADE_NO_RUN', true);
        }
        require_once dirname(__DIR__, 2) . '/bin/upgrade.php';

        // Best-effort test DB (same wiring as the other DB-gated integration suites); the
        // version-resolution tests don't need it, the run/check tests self-skip without it.
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        $config = [
            'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
            'port' => $_ENV['DB_PORT'] ?? '3306',
            'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
            'username' => $_ENV['DB_USERNAME'] ?? 'root',
            'password' => $_ENV['DB_PASSWORD'] ?? '',
            'charset' => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
        ];
        try {
            $conn = new MySQLConnection($config);
            $conn->getConnection()->query('SELECT 1');
            self::$mysql = $conn;
            self::$pdo = $conn->getConnection();
        } catch (\Throwable $e) {
            self::$mysql = null;
            self::$pdo = null;
        }
    }

    /**
     * Run one of the CLI's dispatch targets capturing its log lines.
     *
     * @param callable(callable):int $fn receives the $out writer, returns the exit code
     * @return array{0:int,1:string} [exitCode, joined output]
     */
    private static function capture(callable $fn): array
    {
        $lines = [];
        $out = static function (string $line) use (&$lines): void {
            $lines[] = $line;
        };
        $code = $fn($out);
        return [$code, implode("\n", $lines)];
    }

    // --- Version resolution (no DB) ----------------------------------------------------------------

    public function testAppVersionFlagWinsOverVersionFile(): void
    {
        $file = tempnam(sys_get_temp_dir(), 'flver');
        $this->assertNotFalse($file);
        file_put_contents($file, "9.9.9\n");
        try {
            $this->assertSame(
                ['1.2.3', 'flag'],
                formlogicUpgradeResolveVersion(['--app-version=1.2.3'], $file)
            );
        } finally {
            @unlink($file);
        }
    }

    public function testVersionFileFallbackIsTrimmed(): void
    {
        $file = tempnam(sys_get_temp_dir(), 'flver');
        $this->assertNotFalse($file);
        file_put_contents($file, "  2.0.1\n");
        try {
            $this->assertSame(['2.0.1', 'file'], formlogicUpgradeResolveVersion([], $file));
        } finally {
            @unlink($file);
        }
    }

    public function testUnknownWhenNoFlagAndNoFile(): void
    {
        $missing = sys_get_temp_dir() . '/formlogic-no-such-version-' . bin2hex(random_bytes(4));
        $this->assertSame(['unknown', 'none'], formlogicUpgradeResolveVersion([], $missing));
        $this->assertSame(['unknown', 'none'], formlogicUpgradeResolveVersion([], null));
    }

    public function testEmptyFlagOrEmptyFileFallsThrough(): void
    {
        // '--app-version=' (no value) and a whitespace-only VERSION file both fall through to 'unknown'.
        $file = tempnam(sys_get_temp_dir(), 'flver');
        $this->assertNotFalse($file);
        file_put_contents($file, "   \n");
        try {
            $this->assertSame(['unknown', 'none'], formlogicUpgradeResolveVersion(['--app-version='], $file));
        } finally {
            @unlink($file);
        }
    }

    // --- Full run + idempotency + check (needs a test DB) -------------------------------------------

    public function testRunMigratesVerifiesAndStampsSchemaMetaThenReRunsIdempotently(): void
    {
        if (self::$mysql === null || self::$pdo === null) {
            $this->markTestSkipped('No test database available');
        }

        [$code, $output] = self::capture(
            fn (callable $out): int => formlogicUpgradeRun(self::$mysql, '9.9.9-test', 'flag', $out)
        );
        $this->assertSame(0, $code, "first run should exit 0; output:\n" . $output);
        $this->assertStringContainsString('Schema ensured', $output);
        $this->assertStringContainsString('Migrations applied', $output);
        $this->assertStringContainsString('Core tables verified: 8/8', $output);
        $this->assertStringContainsString('app_version=9.9.9-test', $output);

        $meta = $this->fetchSchemaMeta();
        $this->assertSame('9.9.9-test', $meta['app_version'] ?? null, 'app_version should be stamped');
        $this->assertSame('cli', $meta['upgrade_source'] ?? null, 'upgrade_source should be cli');
        $this->assertMatchesRegularExpression(
            '/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/',
            $meta['last_upgrade_at'] ?? '',
            'last_upgrade_at should be a UTC datetime stamp'
        );

        // Second run: still exit 0, calls out the re-run, and re-stamps the (new) version.
        [$code2, $output2] = self::capture(
            fn (callable $out): int => formlogicUpgradeRun(self::$mysql, '9.9.10-test', 'flag', $out)
        );
        $this->assertSame(0, $code2, "second run should exit 0; output:\n" . $output2);
        $this->assertStringContainsString('Re-run detected', $output2);
        $this->assertStringContainsString('idempotent', $output2);

        $meta2 = $this->fetchSchemaMeta();
        $this->assertSame('9.9.10-test', $meta2['app_version'] ?? null, 're-run should update the stamp');

        // A versionless re-run (no flag, no VERSION file → 'unknown') must NOT clobber the stamp.
        [$code3, $output3] = self::capture(
            fn (callable $out): int => formlogicUpgradeRun(self::$mysql, 'unknown', 'none', $out)
        );
        $this->assertSame(0, $code3, "versionless re-run should exit 0; output:\n" . $output3);
        $this->assertStringContainsString('kept existing stamp', $output3);
        $meta3 = $this->fetchSchemaMeta();
        $this->assertSame(
            '9.9.10-test',
            $meta3['app_version'] ?? null,
            "an 'unknown' version must not overwrite a previously-stamped real version"
        );
    }

    public function testCheckPassesReadOnlyOnMigratedDatabase(): void
    {
        if (self::$mysql === null || self::$pdo === null) {
            $this->markTestSkipped('No test database available');
        }
        // Make sure the schema is migrated regardless of test ordering (both calls are idempotent).
        self::$mysql->initializeSchema();
        self::$mysql->runMigrations();

        [$code, $output] = self::capture(
            fn (callable $out): int => formlogicUpgradeCheck(self::$pdo, $out)
        );
        $this->assertSame(0, $code, "--check should pass on a migrated DB; output:\n" . $output);
        $this->assertStringContainsString('Check passed', $output);
        // The drift probes named in the runbook actually get reported.
        $this->assertStringContainsString('apps.reports', $output);
        $this->assertStringContainsString('apps.custom_logic', $output);
        $this->assertStringContainsString('app_forms.idx_form_id', $output);
        // Read-only contract: every core table is listed, none as missing.
        $this->assertStringNotContainsString('MISSING', $output);
    }

    // The one way back when the admin panel can't run, so it asks what the panel asks.
    public function testARollbackBelowDataEncryptionTakesTheFlagAndSaysWhich(): void
    {
        if (self::$mysql === null || self::$pdo === null) {
            $this->markTestSkipped('No test database available');
        }
        self::$mysql->initializeSchema();
        self::$mysql->runMigrations();
        $web = sys_get_temp_dir() . '/formlogic-upgrade-cli-' . bin2hex(random_bytes(4));
        $api = $web . '/api';
        $snapshot = $api . '/storage/backups/20260101-000000-aaaaaa';
        mkdir($snapshot . '/api', 0777, true);
        mkdir($snapshot . '/web');
        file_put_contents($web . '/index.html', 'new');
        file_put_contents($api . '/VERSION', "0.1.20\n");
        file_put_contents($snapshot . '/web/index.html', 'old');
        file_put_contents($snapshot . '/api/VERSION', "0.1.17\n");
        file_put_contents($snapshot . '/backup-info.json', json_encode(['id' => basename($snapshot), 'version' => '0.1.17']));
        $maintenance = new MaintenanceService($api . '/storage/maintenance.json');
        $upgrade = new UpgradeService($api, self::$mysql, $maintenance, '');
        $saved = $_ENV[DataEncryption::KEY_ENV] ?? null;
        $_ENV[DataEncryption::KEY_ENV] = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
        try {
            $errors = [];
            $toStderr = static function (string $line) use (&$errors): void {
                $errors[] = $line;
            };
            [$code, $output] = self::capture(fn (callable $out): int => formlogicUpgradeRollback($upgrade, $maintenance, basename($snapshot), false, $out, $toStderr));
            $this->assertSame(1, $code);
            $this->assertSame('', $output, 'a refusal goes to stderr, as a failure always did');
            $this->assertCount(1, $errors);
            $this->assertStringContainsString('authenticator', $errors[0]);
            $this->assertStringEndsWith('Add --allow-downgrade to go ahead.', $errors[0]);
            $this->assertStringNotContainsString('reload this page', $errors[0], 'there is no page here');
            $this->assertSame('new', file_get_contents($web . '/index.html'));

            $errors = [];
            [$code, $output] = self::capture(fn (callable $out): int => formlogicUpgradeRollback($upgrade, $maintenance, 'no-such-backup', false, $out, $toStderr));
            $this->assertSame(1, $code);
            $this->assertSame(['Rollback failed: Backup not found'], $errors);

            [$code, $output] = self::capture(fn (callable $out): int => formlogicUpgradeRollback($upgrade, $maintenance, basename($snapshot), true, $out, $toStderr));
            $this->assertSame(0, $code, $output);
            $this->assertStringContainsString('Restored version 0.1.17', $output);
            $this->assertSame('old', file_get_contents($web . '/index.html'));
        } finally {
            unset($_ENV[DataEncryption::KEY_ENV]);
            if ($saved !== null) {
                $_ENV[DataEncryption::KEY_ENV] = $saved;
            }
            self::removeTree($web);
        }
    }

    private static function removeTree(string $dir): void
    {
        if (!str_starts_with(basename($dir), 'formlogic-upgrade-cli-') || !str_starts_with($dir, sys_get_temp_dir())) {
            throw new \LogicException("Not this test's folder: {$dir}");
        }
        $entries = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($entries as $entry) {
            $entry->isDir() ? rmdir($entry->getPathname()) : unlink($entry->getPathname());
        }
        rmdir($dir);
    }

    /** @return array<string,string> meta_key => meta_value */
    private function fetchSchemaMeta(): array
    {
        $stmt = self::$pdo->query(
            "SELECT meta_key, meta_value FROM schema_meta
             WHERE meta_key IN ('app_version', 'last_upgrade_at', 'upgrade_source')"
        );
        $meta = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $meta[$row['meta_key']] = (string) $row['meta_value'];
        }
        return $meta;
    }
}
