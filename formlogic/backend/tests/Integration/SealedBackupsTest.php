<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AccountBackupController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AccountBackupService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\DataEncryptionMigrator;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\MaintenanceService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\ScheduledBackupService;
use FormLogic\Services\TrashService;
use FormLogic\Services\TrashSnapshotException;
use FormLogic\Services\UpgradeService;
use FormLogic\Support\BackupEnvelope;
use FormLogic\Support\DataEncryption;
use FormLogic\Support\DataEncryptionException;
use PDO;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;
use Slim\Psr7\UploadedFile;

/** Backups that are sealed: the recycle bin, nightly files and passphrase downloads. */
final class SealedBackupsTest extends TestCase
{
    private const KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
    private const PLANTED = 'planted-form-title';

    private static ?MySQLConnection $mysql = null;
    private static PDO $pdo;
    private static string $root = '';
    private static SQLiteConnection $sqlite;
    private static FormService $forms;
    private static AppService $apps;

    private string $userId = '';
    /** @var array<string, mixed> */
    private array $saved = [];

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
        self::$root = sys_get_temp_dir() . '/fl-sealed-' . bin2hex(random_bytes(6));
        mkdir(self::$root . '/forms', 0700, true);
        self::$sqlite = new SQLiteConnection(self::$root . '/forms');
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
        foreach ([DataEncryption::KEY_ENV, DataEncryption::PREVIOUS_KEYS_ENV, ScheduledBackupService::SEALING_KEY_ENV] as $name) {
            $this->saved[$name] = $_ENV[$name] ?? null;
            unset($_ENV[$name], $_SERVER[$name]);
            putenv($name);
        }
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->userId, $this->userId . '@test.local']);
    }

    protected function tearDown(): void
    {
        if (self::$mysql !== null && $this->userId !== '') {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
        }
        foreach ($this->saved as $name => $value) {
            unset($_ENV[$name]);
            if ($value !== null) {
                $_ENV[$name] = $value;
            }
        }
    }

    private function backups(): AccountBackupService
    {
        return new AccountBackupService(
            self::$mysql,
            self::$sqlite,
            self::$forms,
            self::$apps,
            new AppUserService(self::$mysql),
            new FlowService(self::$mysql),
            new ResponseService(self::$mysql, self::$sqlite),
            [],
            self::$root . '/forms',
            self::$root . '/uploads'
        );
    }

    private function form(): string
    {
        return self::$forms->createForm([
            'title' => self::PLANTED, 'userId' => $this->userId, 'status' => 'draft',
            'fields' => [['id' => 'q1', 'type' => 'short_text', 'label' => 'Q', 'required' => false]],
        ])['id'];
    }

    private function trash(): TrashService
    {
        return new TrashService(self::$mysql, self::$sqlite, $this->backups(), self::$forms, self::$apps, new FlowService(self::$mysql), ['retentionDays' => 7, 'dir' => self::$root . '/trash']);
    }

    private function scheduled(string $dir): ScheduledBackupService
    {
        $maintenance = new MaintenanceService(self::$root . '/maintenance-' . bin2hex(random_bytes(3)) . '.json');
        return new ScheduledBackupService(
            self::$mysql,
            $this->backups(),
            new UpgradeService(self::$root . '/nowhere', self::$mysql, $maintenance),
            ['scheduledDir' => $dir, 'retentionDays' => 7],
        );
    }

    public function testABinSnapshotIsEncryptedWhileItWaitsAndComesBack(): void
    {
        $_ENV[DataEncryption::KEY_ENV] = self::KEY;
        $formId = $this->form();
        $trash = $this->trash();

        self::assertTrue($trash->trashForm($formId, $this->userId)['trashed']);
        $row = self::$pdo->prepare('SELECT zip_path FROM trash_items WHERE user_id = ?');
        $row->execute([$this->userId]);
        $path = self::$root . '/trash/' . $row->fetchColumn();

        self::assertTrue(BackupEnvelope::isSealed($path));
        self::assertStringNotContainsString(self::PLANTED, (string) file_get_contents($path));

        $trash->restore((string) $trash->listTrash($this->userId)[0]['id'], $this->userId);
        self::assertSame(self::PLANTED, self::$forms->getForm($formId)['title']);
    }

    public function testWithNoKeyABinSnapshotStaysAZip(): void
    {
        $formId = $this->form();
        $trash = $this->trash();
        $trash->trashForm($formId, $this->userId);

        $row = self::$pdo->prepare('SELECT zip_path FROM trash_items WHERE user_id = ?');
        $row->execute([$this->userId]);
        self::assertFalse(BackupEnvelope::isSealed(self::$root . '/trash/' . $row->fetchColumn()));
    }

    public function testTheMigrationSealsPlainSnapshotsAndTheyStillRestore(): void
    {
        $formId = $this->form();
        $trash = $this->trash();
        $trash->trashForm($formId, $this->userId);
        $row = self::$pdo->prepare('SELECT zip_path FROM trash_items WHERE user_id = ?');
        $row->execute([$this->userId]);
        $path = self::$root . '/trash/' . $row->fetchColumn();

        $_ENV[DataEncryption::KEY_ENV] = self::KEY;
        $result = (new DataEncryptionMigrator(self::$pdo, self::$root . '/no-apps', self::$root . '/trash'))->run(DataEncryption::fromEnvironment());
        self::assertGreaterThanOrEqual(1, $result['snapshots']);
        self::assertTrue(BackupEnvelope::isSealed($path));

        $trash->restore((string) $trash->listTrash($this->userId)[0]['id'], $this->userId);
        self::assertSame(self::PLANTED, self::$forms->getForm($formId)['title']);
    }

    public function testAnInvalidKeyRefusesADeleteRatherThanKeepingAPlainSnapshot(): void
    {
        $formId = $this->form();
        $_ENV[DataEncryption::KEY_ENV] = 'too-short';
        try {
            $this->trash()->trashForm($formId, $this->userId);
            self::fail('a form was deleted with no way to seal its snapshot');
        } catch (DataEncryptionException $e) {
            self::assertStringContainsString('not a valid key', $e->getMessage());
        }
        unset($_ENV[DataEncryption::KEY_ENV]);
        self::assertSame(self::PLANTED, self::$forms->getForm($formId)['title'], 'nothing was deleted');
    }

    // A mistyped key stops every copy of everything. Going on would lose healthy data over a setting.
    public function testAnInvalidKeyIsNotSomethingAnUninstallGoesOnPast(): void
    {
        $formId = $this->form();
        (new ResponseService(self::$mysql, self::$sqlite))->createResponse($formId, ['answers' => []]);
        $installation = 'inst-' . bin2hex(random_bytes(8));
        self::$pdo->prepare("INSERT INTO pack_installations (id, user_id, pack_id, pack_name, form_ids, app_ids) VALUES (?, ?, 'test-pack', 'Test Pack', ?, '[]')")
            ->execute([$installation, $this->userId, json_encode([$formId])]);
        $_ENV[DataEncryption::KEY_ENV] = 'too-short';
        try {
            $this->trash()->captureRecordBearingForms($installation, $this->userId, false);
            self::fail('the uninstall went on with no way to seal its copies');
        } catch (TrashSnapshotException $e) {
            self::assertFalse($e->canGoOn());
            self::assertStringContainsString('not a valid key', $e->getMessage());
        }
        unset($_ENV[DataEncryption::KEY_ENV]);
        self::assertSame(self::PLANTED, self::$forms->getForm($formId)['title'], 'nothing was deleted');
    }

    public function testNightlyFilesAreSealedAndTheServerCannotOpenThem(): void
    {
        [$public, $secret] = BackupEnvelope::generateKeyPair();
        $_ENV[ScheduledBackupService::SEALING_KEY_ENV] = $public;
        $this->form();
        $dir = self::$root . '/nightly-' . bin2hex(random_bytes(4));

        $service = $this->scheduled($dir);
        $summary = $service->run();
        self::assertSame(0, $summary['failed']);

        $day = $dir . '/' . $summary['date'];
        self::assertSame([], glob($day . '/accounts/*.zip'), 'no plain zip is left beside the sealed one');
        self::assertFileDoesNotExist($day . '/database.sql.gz');
        self::assertFileExists($day . '/database.sql.gz.flbk');
        $sealed = $day . '/accounts/' . $this->userId . '.zip.flbk';
        self::assertTrue(BackupEnvelope::isSealed($sealed));

        $manifest = json_decode((string) file_get_contents($day . '/site-manifest.json'), true);
        self::assertTrue($manifest['sealed']);
        $mine = array_values(array_filter($manifest['usersDetail'], fn ($u) => ($u['id'] ?? null) === $this->userId));
        self::assertNull($mine[0]['email'], 'the readable manifest names nobody');
        self::assertSame(hash_file('sha256', $sealed), $mine[0]['sha256']);
        self::assertStringNotContainsString($this->userId . '@test.local', (string) file_get_contents($day . '/site-manifest.json'));
        self::assertTrue($service->listRuns()[0]['sealed']);

        try {
            $service->restoreAccount($summary['date'], $this->userId);
            self::fail('the server restored a file it cannot open');
        } catch (\RuntimeException $e) {
            self::assertStringContainsString('open-backup.php', $e->getMessage());
        }

        $opened = $day . '/accounts/' . $this->userId . '.zip';
        BackupEnvelope::open($sealed, $opened, ['secretKey' => base64_decode($secret)]);
        $restored = $service->restoreAccount($summary['date'], $this->userId);
        self::assertCount(1, $restored['forms'], 'once opened it restores like any other day');
    }

    public function testASealingKeyThatIsWrongStopsTheRunRatherThanWritingPlainFiles(): void
    {
        $_ENV[ScheduledBackupService::SEALING_KEY_ENV] = 'not-a-key';
        $dir = self::$root . '/nightly-' . bin2hex(random_bytes(4));

        try {
            $this->scheduled($dir)->run();
            self::fail('a run went ahead without its key');
        } catch (\RuntimeException $e) {
            self::assertStringContainsString('BACKUP_PUBLIC_KEY', $e->getMessage());
        }
        self::assertSame([], glob($dir . '/*/accounts/*'));
    }

    public function testNightlyFilesStayPlainWhenNoKeyIsSet(): void
    {
        $this->form();
        $dir = self::$root . '/nightly-' . bin2hex(random_bytes(4));

        $summary = $this->scheduled($dir)->run();

        self::assertFileExists($dir . '/' . $summary['date'] . '/accounts/' . $this->userId . '.zip');
        self::assertFileExists($dir . '/' . $summary['date'] . '/database.sql.gz');
    }

    private function controller(): AccountBackupController
    {
        return new AccountBackupController($this->backups());
    }

    private function user(): object
    {
        return (object) ['email' => $this->userId . '@test.local'];
    }

    public function testADownloadWithAPassphraseIsSealedAndRestoresWithIt(): void
    {
        $this->form();
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/account/backup/export')
            ->withAttribute('userId', $this->userId)->withAttribute('user', $this->user())
            ->withParsedBody(['passphrase' => 'correct horse battery']);

        $response = $this->controller()->export($request, new Response());

        self::assertSame(200, $response->getStatusCode());
        self::assertStringContainsString('.zip.flbk', $response->getHeaderLine('Content-Disposition'));
        $sealed = self::$root . '/download-' . bin2hex(random_bytes(4)) . '.flbk';
        file_put_contents($sealed, (string) $response->getBody());
        self::assertTrue(BackupEnvelope::isSealed($sealed));

        $upload = function (?string $passphrase) use ($sealed) {
            $copy = $sealed . '.upload';
            copy($sealed, $copy);
            $file = new UploadedFile($copy, 'backup.flbk', 'application/octet-stream', (int) filesize($copy), UPLOAD_ERR_OK);
            $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/account/backup/import')
                ->withAttribute('userId', $this->userId)->withAttribute('user', $this->user())
                ->withUploadedFiles(['file' => $file])
                ->withParsedBody($passphrase === null ? [] : ['passphrase' => $passphrase]);
            return $this->controller()->import($request, new Response());
        };

        $none = $upload(null);
        self::assertSame(400, $none->getStatusCode());
        self::assertSame('backup_passphrase_required', json_decode((string) $none->getBody(), true)['code']);

        $wrong = $upload('wrong horse battery');
        self::assertSame(400, $wrong->getStatusCode());
        self::assertSame('That does not open this backup', json_decode((string) $wrong->getBody(), true)['message']);

        $right = $upload('correct horse battery');
        self::assertSame(200, $right->getStatusCode());
        self::assertCount(1, json_decode((string) $right->getBody(), true)['forms']);
    }

    public function testAShortPassphraseIsRefused(): void
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/account/backup/export')
            ->withAttribute('userId', $this->userId)->withAttribute('user', $this->user())
            ->withParsedBody(['passphrase' => 'short']);

        self::assertSame(400, $this->controller()->export($request, new Response())->getStatusCode());
    }

    public function testAPostWithNoPassphraseIsRefusedNotServedPlain(): void
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/account/backup/export')
            ->withAttribute('userId', $this->userId)->withAttribute('user', $this->user())
            ->withParsedBody([]);

        self::assertSame(400, $this->controller()->export($request, new Response())->getStatusCode());
    }
}
