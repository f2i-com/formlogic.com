<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AccountBackupService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\HostedAppService;
use FormLogic\Services\HostedRecordCipher;
use FormLogic\Support\DataEncryption;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * What an app keeps on disk, in a backup and back. Hosted apps were in no backup at all, one stuck
 * app failed its owner's whole account, a large archive was written and could not be restored,
 * and after a site disaster apps could only come back as new copies under new ids.
 * Real zips and real SQLite files. Skipped without a test database.
 */
class AppStorageBackupTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static PDO $pdo;
    private static SQLiteConnection $sqlite;
    private static FormService $forms;
    private static AppService $apps;
    private static string $root = '';

    private string $userId = '';
    private string $hostedPath = '';
    private string $nativePath = '';

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        try {
            $conn = new MySQLConnection([
                'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
                'port' => $_ENV['DB_PORT'] ?? '3306',
                'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
                'username' => $_ENV['DB_USERNAME'] ?? 'root',
                'password' => $_ENV['DB_PASSWORD'] ?? '',
                'charset' => 'utf8mb4',
                'collation' => 'utf8mb4_unicode_ci',
            ]);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        self::$root = sys_get_temp_dir() . '/formlogic-app-storage-' . bin2hex(random_bytes(4));
        mkdir(self::$root . '/sqlite', 0777, true);
        mkdir(self::$root . '/uploads', 0777, true);
        self::$sqlite = new SQLiteConnection(self::$root . '/sqlite');
        self::$forms = new FormService($conn, self::$sqlite);
        self::$apps = new AppService($conn, self::$forms);
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$root !== '') {
            self::removeTree(self::$root);
        }
    }

    private static function removeTree(string $dir): void
    {
        foreach (scandir($dir) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $path = $dir . '/' . $entry;
            is_dir($path) ? self::removeTree($path) : @unlink($path);
        }
        @rmdir($dir);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u' . bin2hex(random_bytes(8));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan) VALUES (?, ?, 'x', 'T', 'personal')")
            ->execute([$this->userId, $this->userId . '@formlogic.test']);
        $this->hostedPath = self::$root . '/hosted-' . bin2hex(random_bytes(4));
        $this->nativePath = self::$root . '/native-' . bin2hex(random_bytes(4));
        mkdir($this->hostedPath, 0700, true);
        mkdir($this->nativePath, 0700, true);
    }

    private function service(array $config = [], ?NativeAppService $native = null, ?string $hostedPath = null): AccountBackupService
    {
        return new AccountBackupService(
            self::$mysql,
            self::$sqlite,
            self::$forms,
            self::$apps,
            new AppUserService(self::$mysql),
            new FlowService(self::$mysql),
            new ResponseService(self::$mysql, self::$sqlite),
            $config,
            self::$root . '/sqlite',
            self::$root . '/uploads',
            null,
            null,
            null,
            $native ?? new NativeAppService($this->nativePath),
            $hostedPath ?? $this->hostedPath,
        );
    }

    private function app(string $name = 'Kept app'): string
    {
        return self::$apps->createApp(['name' => $name], $this->userId)['id'];
    }

    /** A hosted app's database as HostedAppService lays it out. */
    private function hostedDatabase(string $appId, bool $deployed = true, ?string $root = null): void
    {
        $db = new PDO('sqlite:' . HostedAppService::databasePath($appId, $root ?? $this->hostedPath));
        $db->exec('CREATE TABLE deployment (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, package TEXT NOT NULL, updated_at TEXT NOT NULL)');
        $db->exec('CREATE TABLE records (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(collection,id))');
        if ($deployed) {
            $package = json_encode(['version' => 1, 'client' => ['manifest.json' => '{"main":"ui/main.ui"}', 'ui/main.ui' => '<Text>Kept</Text>'], 'actions' => []]);
            $db->prepare("INSERT INTO deployment VALUES (1, 3, ?, 'now')")->execute([$package]);
            $db->exec("INSERT INTO records VALUES ('orders', 'r1', '{\"total\":42}', 'now')");
        }
    }

    private function hostedRecord(string $appId, ?string $root = null): ?string
    {
        $path = HostedAppService::databasePath($appId, $root ?? $this->hostedPath);
        if (!is_file($path)) {
            return null;
        }
        $db = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $value = $db->query("SELECT data FROM records WHERE id = 'r1'")->fetchColumn();
        return $value === false ? null : HostedRecordCipher::forApp($db, $appId)->open('orders', 'r1', (string) $value);
    }

    private function entries(string $zipPath): array
    {
        $zip = new \ZipArchive();
        self::assertTrue($zip->open($zipPath) === true);
        $names = [];
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $names[] = (string) $zip->getNameIndex($i);
        }
        $zip->close();
        return $names;
    }

    private function manifest(string $zipPath): array
    {
        $zip = new \ZipArchive();
        self::assertTrue($zip->open($zipPath) === true);
        $manifest = json_decode((string) $zip->getFromName('manifest.json'), true);
        $zip->close();
        return $manifest;
    }

    private function appsOf(string $userId): array
    {
        $stmt = self::$pdo->prepare('SELECT id FROM apps WHERE owner_id = ?');
        $stmt->execute([$userId]);
        return $stmt->fetchAll(PDO::FETCH_COLUMN);
    }

    private function noBackendProject(): array
    {
        return ['access' => 'application', 'assets' => [], 'files' => [
            'manifest.json' => json_encode(['id' => 'test.storage-backup', 'version' => '1.0.0', 'main' => 'ui/main.ui']),
            'ui/main.ui' => '<Text>Kept</Text>',
        ]];
    }

    public function testAHostedAppsDatabaseIsInTheBackupAndComesBackUnderItsNewId(): void
    {
        $appId = $this->app();
        $this->hostedDatabase($appId);
        $service = $this->service();
        $zip = $service->exportAccount($this->userId);

        self::assertContains('hosted/' . $appId . '/application.sqlite', $this->entries($zip));
        self::assertSame(1, $this->manifest($zip)['counts']['hostedApps']);
        self::assertSame('ok', $this->manifest($zip)['snapshots']['hosted/' . $appId . '/application.sqlite']['quickCheck']);

        $result = $service->importAccount($zip, $this->userId);
        self::assertSame(1, $result['hostedApps']);
        $restored = array_values(array_diff($this->appsOf($this->userId), [$appId]));
        self::assertCount(1, $restored);
        self::assertSame('{"total":42}', $this->hostedRecord($restored[0]));
        self::assertSame('{"total":42}', $this->hostedRecord($appId), 'the original is untouched');
        unlink($zip);
    }

    public function testASnapshotCarriesWhatIsCommittedAndLeavesNothingBeside(): void
    {
        $appId = $this->app();
        $this->hostedDatabase($appId);
        $zip = $this->service()->exportAccount($this->userId);
        self::assertSame(['hosted/' . $appId . '/application.sqlite'], array_values(array_filter($this->entries($zip), static fn ($name) => str_starts_with($name, 'hosted/'))));
        unlink($zip);
    }

    public function testAnAppNobodyDeployedCarriesNoHostedDatabase(): void
    {
        $looked = $this->app('Only looked at');
        $this->hostedDatabase($looked, false);
        $never = $this->app('Never touched');
        $zip = $this->service()->exportAccount($this->userId);

        self::assertSame([], array_values(array_filter($this->entries($zip), static fn ($name) => str_starts_with($name, 'hosted/'))));
        self::assertSame(0, $this->manifest($zip)['counts']['hostedApps']);
        self::assertFileDoesNotExist(HostedAppService::databasePath($never, $this->hostedPath), 'a backup creates nothing');
        unlink($zip);
    }

    public function testAnUploadedDatabaseBringsItsRowsAndNotItsSchema(): void
    {
        $appId = $this->app();
        $this->hostedDatabase($appId);
        $source = HostedAppService::databasePath($appId, $this->hostedPath);
        $db = new PDO('sqlite:' . $source);
        $db->exec('CREATE TABLE stolen (value TEXT)');
        $db->exec('CREATE TRIGGER planted AFTER INSERT ON records BEGIN INSERT INTO stolen VALUES (new.data); END');
        $db = null;
        $zip = $this->service()->exportAccount($this->userId);

        $this->service()->importAccount($zip, $this->userId);
        $restored = array_values(array_diff($this->appsOf($this->userId), [$appId]));
        $copy = new PDO('sqlite:' . HostedAppService::databasePath($restored[0], $this->hostedPath));
        $names = $copy->query("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger', 'view') ORDER BY name")->fetchAll(PDO::FETCH_COLUMN);
        self::assertSame(['app_key', 'deployment', 'records'], $names);
        self::assertSame('{"total":42}', $this->hostedRecord($restored[0]));
        unlink($zip);
    }

    public function testAnEncryptedAppIsPlainInItsBackupAndEncryptedAgainWhenRestored(): void
    {
        $saved = $_ENV[DataEncryption::KEY_ENV] ?? null;
        $_ENV[DataEncryption::KEY_ENV] = str_repeat('ab', 32);
        try {
            $appId = $this->app();
            $this->hostedDatabase($appId);
            $source = HostedAppService::databasePath($appId, $this->hostedPath);
            self::assertSame(1, HostedAppService::encryptDatabase($source, DataEncryption::fromEnvironment()));
            self::assertStringNotContainsString('"total":42', (string) file_get_contents($source));

            $zipPath = $this->service()->exportAccount($this->userId);

            $name = 'hosted/' . $appId . '/application.sqlite';
            $staged = self::$root . '/from-zip-' . bin2hex(random_bytes(4)) . '.sqlite';
            $zip = new \ZipArchive();
            $zip->open($zipPath);
            file_put_contents($staged, (string) $zip->getFromName($name));
            $zip->close();
            self::assertSame(hash_file('sha256', $staged), $this->manifest($zipPath)['entries'][$name], 'the manifest describes what is in the zip');
            $copy = new PDO('sqlite:' . $staged);
            self::assertSame('{"total":42}', $copy->query('SELECT data FROM records')->fetchColumn());
            self::assertFalse($copy->query("SELECT 1 FROM sqlite_master WHERE name = 'app_key'")->fetchColumn());
            $copy = null;
            unlink($staged);

            $this->service()->importAccount($zipPath, $this->userId);
            $restored = array_values(array_diff($this->appsOf($this->userId), [$appId]));
            self::assertSame('{"total":42}', $this->hostedRecord($restored[0]));
            self::assertStringNotContainsString('"total":42', (string) file_get_contents(HostedAppService::databasePath($restored[0], $this->hostedPath)));
            unlink($zipPath);
        } finally {
            unset($_ENV[DataEncryption::KEY_ENV]);
            if ($saved !== null) {
                $_ENV[DataEncryption::KEY_ENV] = $saved;
            }
        }
    }

    public function testAnAppThatCannotBeDecryptedDoesNotCostTheRestOfANightlyBackup(): void
    {
        $saved = $_ENV[DataEncryption::KEY_ENV] ?? null;
        $_ENV[DataEncryption::KEY_ENV] = str_repeat('ab', 32);
        try {
            $appId = $this->app();
            $this->hostedDatabase($appId);
            $source = HostedAppService::databasePath($appId, $this->hostedPath);
            HostedAppService::encryptDatabase($source, DataEncryption::fromEnvironment());

            $_ENV[DataEncryption::KEY_ENV] = str_repeat('cd', 32);
            $zip = $this->service()->exportAccount($this->userId, ['includeHostSecrets' => true]);

            self::assertNotContains('hosted/' . $appId . '/application.sqlite', $this->entries($zip));
            self::assertStringContainsString('could not be decrypted', implode(' ', $this->manifest($zip)['warnings']));
            unlink($zip);
        } finally {
            unset($_ENV[DataEncryption::KEY_ENV]);
            if ($saved !== null) {
                $_ENV[DataEncryption::KEY_ENV] = $saved;
            }
        }
    }

    public function testAnUploadedDeploymentHasToPassWhatPublishingAsks(): void
    {
        $appId = $this->app();
        $this->hostedDatabase($appId);
        $db = new PDO('sqlite:' . HostedAppService::databasePath($appId, $this->hostedPath));
        $db->exec("UPDATE deployment SET package = '{\"version\":1,\"client\":{\"manifest.json\":\"{}\",\"x.html\":\"<script>\"},\"actions\":{}}'");
        $db = null;
        $zip = $this->service()->exportAccount($this->userId);
        $before = $this->appsOf($this->userId);
        try {
            $this->service()->importAccount($zip, $this->userId);
            self::fail('The import should have failed');
        } catch (\RuntimeException $refused) {
            self::assertStringContainsString('rolled back', $refused->getMessage());
        }
        self::assertSame($before, $this->appsOf($this->userId));

        // This server's own archive is not held to it: a later rule must not stop a recovery.
        self::assertSame(1, $this->service()->importAccount($zip, $this->userId, ['serverHeld' => true])['hostedApps']);
        unlink($zip);
    }

    public function testAnUndeletedAppKeepsTheDatabaseItHas(): void
    {
        $appId = $this->app();
        $this->hostedDatabase($appId);
        $other = tempnam(sys_get_temp_dir(), 'fl-other');
        self::assertFalse(HostedAppService::restoreDatabase($appId, $other, $this->hostedPath));
        self::assertSame('{"total":42}', $this->hostedRecord($appId));
        unlink($other);
    }

    public function testAHostedDatabaseThatCannotBePutBackUndoesTheWholeImport(): void
    {
        $appId = $this->app();
        $this->hostedDatabase($appId);
        $zip = $this->service()->exportAccount($this->userId);
        $before = $this->appsOf($this->userId);

        // A file where the folder should be: nothing can be written under it.
        $blocked = self::$root . '/blocked-' . bin2hex(random_bytes(4));
        file_put_contents($blocked, 'x');
        try {
            $this->service([], null, $blocked)->importAccount($zip, $this->userId);
            self::fail('The import should have failed');
        } catch (\RuntimeException $failed) {
            self::assertStringContainsString('rolled back', $failed->getMessage());
        }
        self::assertSame($before, $this->appsOf($this->userId));
        unlink($zip);
    }

    public function testAHostedEntryForAnAppNotInTheBackupIsRefused(): void
    {
        $appId = $this->app();
        $this->hostedDatabase($appId);
        $zipPath = $this->service()->exportAccount($this->userId);
        $zip = new \ZipArchive();
        self::assertTrue($zip->open($zipPath) === true);
        $manifest = json_decode((string) $zip->getFromName('manifest.json'), true);
        $bytes = (string) $zip->getFromName('hosted/' . $appId . '/application.sqlite');
        $manifest['entries']['hosted/someone-elses-app/application.sqlite'] = hash('sha256', $bytes);
        $zip->addFromString('hosted/someone-elses-app/application.sqlite', $bytes);
        $zip->addFromString('manifest.json', (string) json_encode($manifest));
        $zip->close();

        $before = $this->appsOf($this->userId);
        try {
            $this->service()->importAccount($zipPath, $this->userId);
            self::fail('The import should have failed');
        } catch (\RuntimeException $refused) {
            self::assertStringContainsString('hosted entry is malformed', $refused->getMessage());
        }
        self::assertSame($before, $this->appsOf($this->userId));
        unlink($zipPath);
    }

    private function stuckNative(string $stuckId): NativeAppService
    {
        $native = $this->createMock(NativeAppService::class);
        $native->method('describe')->willReturnCallback(static fn (string $appId): ?array => $appId !== $stuckId ? null : [
            'manifestId' => 'test.stuck', 'version' => 2, 'home' => false, 'access' => 'members', 'capabilities' => [], 'hasDatabase' => true, 'recoveryRequired' => true,
        ]);
        return $native;
    }

    public function testOneStuckAppDoesNotCostItsOwnerTheRestOfTheBackup(): void
    {
        $stuck = $this->app('Waiting on an operator');
        $healthy = $this->app('Healthy');
        $this->hostedDatabase($healthy);
        $service = $this->service([], $this->stuckNative($stuck));
        $zip = $service->exportAccount($this->userId);

        $warnings = $this->manifest($zip)['warnings'];
        self::assertCount(1, $warnings);
        self::assertStringContainsString('Waiting on an operator', $warnings[0]);
        self::assertContains('hosted/' . $healthy . '/application.sqlite', $this->entries($zip));
        self::assertSame([], array_values(array_filter($this->entries($zip), static fn ($name) => str_starts_with($name, 'native/'))));

        // A restore says so too, rather than leaving an empty app to explain itself.
        $result = $this->service()->importAccount($zip, $this->userId);
        self::assertSame($warnings, $result['warnings']);
        unlink($zip);
    }

    public function testADeleteStillRefusesToLoseAStuckApp(): void
    {
        $stuck = $this->app('Waiting on an operator');
        $this->expectExceptionMessage('needs operator recovery');
        $this->service([], $this->stuckNative($stuck))->exportScoped($this->userId, 'app', $stuck);
    }

    public function testAnArchiveThisServerKeptIsNotHeldToTheUploadLimits(): void
    {
        $this->hostedDatabase($this->app());
        $zip = $this->service()->exportAccount($this->userId);
        $tight = $this->service(['maxZipSize' => 1024, 'maxEntryBytes' => 1024, 'maxTotalUncompressed' => 1024]);

        try {
            $tight->importAccount($zip, $this->userId);
            self::fail('An upload this size is refused');
        } catch (\RuntimeException $refused) {
            self::assertStringContainsString('maximum size', $refused->getMessage());
        }
        self::assertSame(1, $tight->importAccount($zip, $this->userId, ['serverHeld' => true])['hostedApps']);
        unlink($zip);
    }

    public function testAnArchiveThisServerKeptIsStillCheckedForTampering(): void
    {
        $this->hostedDatabase($this->app());
        $zipPath = $this->service()->exportAccount($this->userId);
        $zip = new \ZipArchive();
        self::assertTrue($zip->open($zipPath) === true);
        $zip->addFromString('backup.json', '{}');
        $zip->close();
        $this->expectExceptionMessage('does not match its checksum');
        $this->service()->importAccount($zipPath, $this->userId, ['serverHeld' => true]);
    }

    public function testASiteRestoreBringsAppsBackUnderTheirOriginalIds(): void
    {
        $native = new NativeAppService($this->nativePath);
        $nativeApp = $this->app('Native');
        $native->restore($nativeApp, $this->noBackendProject(), null, null);
        $hostedApp = $this->app('Hosted');
        $this->hostedDatabase($hostedApp);
        $zip = $this->service()->exportAccount($this->userId);

        // The disk is gone; the MySQL dump has put the rows back.
        $hostedPath = self::$root . '/restored-hosted-' . bin2hex(random_bytes(4));
        $nativePath = self::$root . '/restored-native-' . bin2hex(random_bytes(4));
        mkdir($nativePath, 0700, true);
        $fresh = new NativeAppService($nativePath);
        $service = $this->service([], $fresh, $hostedPath);
        self::assertNull($fresh->describe($nativeApp));

        $result = $service->restoreAppStorage($zip);
        self::assertEqualsCanonicalizing([$nativeApp, $hostedApp], $result['restored']);
        self::assertSame([], $result['noApp']);
        self::assertNotNull($fresh->describe($nativeApp), 'the row and the app are one again');
        self::assertSame('{"total":42}', $this->hostedRecord($hostedApp, $hostedPath));
        self::assertCount(2, $this->appsOf($this->userId), 'no copies were made');

        // Running it again changes nothing, and replaces nothing.
        $again = $service->restoreAppStorage($zip);
        self::assertSame([], $again['restored']);
        self::assertEqualsCanonicalizing([$nativeApp, $hostedApp], $again['kept']);
        unlink($zip);
    }

    public function testASiteRestoreLeavesOutAnAppWithNoRow(): void
    {
        $appId = $this->app();
        $this->hostedDatabase($appId);
        $zip = $this->service()->exportAccount($this->userId);
        self::$apps->deleteApp($appId);

        $hostedPath = self::$root . '/restored-hosted-' . bin2hex(random_bytes(4));
        $result = $this->service([], null, $hostedPath)->restoreAppStorage($zip);
        self::assertSame([$appId], $result['noApp']);
        self::assertNull($this->hostedRecord($appId, $hostedPath));
        unlink($zip);
    }

    public function testARestoreReadsTheArchiveItIsGivenAndChecksIt(): void
    {
        $this->hostedDatabase($this->app());
        $zipPath = $this->service()->exportAccount($this->userId);
        $zip = new \ZipArchive();
        self::assertTrue($zip->open($zipPath) === true);
        $zip->addFromString('backup.json', '{}');
        $zip->close();
        $this->expectExceptionMessage('does not match its checksum');
        $this->service()->restoreAppStorage($zipPath);
    }
}
