<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Services\HostedAppService;
use FormLogic\Services\HostedRecordCipher;
use FormLogic\Services\SandboxRunner;
use FormLogic\Support\DataEncryption;
use FormLogic\Support\DataEncryptionException;
use PDO;
use PHPUnit\Framework\TestCase;

/** A hosted app's records on disk, on their way out of the server, and on their way back. */
final class HostedRecordEncryptionTest extends TestCase
{
    private const KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
    private const OTHER = 'ff0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
    private const PLANTED = 'planted-medical-note';

    private HostedAppService $host;
    private string $root;
    /** @var array<string, mixed> */
    private array $saved = [];

    protected function setUp(): void
    {
        ini_set('zend.exception_ignore_args', '1');
        foreach ([DataEncryption::KEY_ENV, DataEncryption::PREVIOUS_KEYS_ENV] as $name) {
            $this->saved[$name] = $_ENV[$name] ?? null;
            unset($_ENV[$name], $_SERVER[$name]);
            putenv($name);
        }
        $this->keys(self::KEY);
        $this->root = sys_get_temp_dir() . '/fl-hosted-enc-' . bin2hex(random_bytes(6));
        $this->host = new HostedAppService(new SandboxRunner(), $this->root);
    }

    protected function tearDown(): void
    {
        foreach (glob($this->root . '/*') ?: [] as $file) {
            unlink($file);
        }
        if (is_dir($this->root)) {
            rmdir($this->root);
        }
        foreach ($this->saved as $name => $value) {
            unset($_ENV[$name]);
            if ($value !== null) {
                $_ENV[$name] = $value;
            }
        }
    }

    private function keys(?string $key, ?string $previous = null): void
    {
        unset($_ENV[DataEncryption::KEY_ENV], $_ENV[DataEncryption::PREVIOUS_KEYS_ENV]);
        if ($key !== null) {
            $_ENV[DataEncryption::KEY_ENV] = $key;
        }
        if ($previous !== null) {
            $_ENV[DataEncryption::PREVIOUS_KEYS_ENV] = $previous;
        }
    }

    private function publish(string $appId = 'app-a'): void
    {
        $this->host->publish($appId, ['version' => 1, 'client' => [
            'manifest.json' => '{"main":"ui/main.ui","name":"Test"}',
            'ui/main.ui' => '<Text>Hello</Text>',
        ], 'actions' => [
            'save' => ['access' => 'owner', 'mode' => 'write', 'source' => 'function onRequest(ctx) { return ctx.db.put("notes",ctx.input.id,{text:ctx.input.text}); }'],
            'load' => ['access' => 'member', 'mode' => 'read', 'source' => 'function onRequest(ctx) { return ctx.db.get("notes",ctx.input.id); }'],
            'list' => ['access' => 'member', 'mode' => 'read', 'source' => 'function onRequest(ctx) { return ctx.db.list("notes",100,0); }'],
        ]], 0);
    }

    private function save(string $id = 'one', string $text = self::PLANTED, string $appId = 'app-a'): void
    {
        $this->host->run($appId, 'save', ['id' => $id, 'text' => $text], 'owner', true);
    }

    private function database(string $appId = 'app-a'): PDO
    {
        return new PDO('sqlite:' . HostedAppService::databasePath($appId, $this->root), null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
    }

    private function stored(string $id = 'one', string $appId = 'app-a'): string
    {
        $stmt = $this->database($appId)->prepare("SELECT data FROM records WHERE collection = 'notes' AND id = ?");
        $stmt->execute([$id]);
        return (string) $stmt->fetchColumn();
    }

    private function fileHolds(string $text, string $appId = 'app-a'): bool
    {
        return str_contains((string) file_get_contents(HostedAppService::databasePath($appId, $this->root)), $text);
    }

    public function testRecordsAreEncryptedOnDiskAndReadBackInTheApp(): void
    {
        $this->publish();
        $this->save();

        self::assertStringStartsWith(HostedRecordCipher::PREFIX, $this->stored());
        self::assertFalse($this->fileHolds(self::PLANTED));
        self::assertSame(self::PLANTED, $this->host->run('app-a', 'load', ['id' => 'one'], 'member', false)['text']);
        self::assertSame(self::PLANTED, $this->host->run('app-a', 'list', [], 'member', false)[0]['data']['text']);
    }

    public function testWithNoKeyRecordsStayPlain(): void
    {
        $this->keys(null);
        $this->publish();
        $this->save();

        self::assertTrue($this->fileHolds(self::PLANTED));
        self::assertSame(self::PLANTED, $this->host->run('app-a', 'load', ['id' => 'one'], 'member', false)['text']);
    }

    public function testRecordsFromBeforeTheKeyStillReadAndEncryptWhenMoved(): void
    {
        $this->keys(null);
        $this->publish();
        $this->save();

        $this->keys(self::KEY);
        self::assertSame(self::PLANTED, $this->host->run('app-a', 'load', ['id' => 'one'], 'member', false)['text']);

        $moved = HostedAppService::encryptDatabase(HostedAppService::databasePath('app-a', $this->root), DataEncryption::fromEnvironment());
        self::assertSame(1, $moved);
        self::assertFalse($this->fileHolds(self::PLANTED), 'no plain text is left in the file\'s free pages');
        self::assertSame(self::PLANTED, $this->host->run('app-a', 'load', ['id' => 'one'], 'member', false)['text']);
        self::assertSame(0, HostedAppService::encryptDatabase(HostedAppService::databasePath('app-a', $this->root), DataEncryption::fromEnvironment()), 'running it twice changes nothing');
    }

    public function testMovingAnAppWithMoreRecordsThanABatch(): void
    {
        $this->keys(null);
        $this->publish();
        $db = $this->database();
        $db->exec('BEGIN');
        $insert = $db->prepare("INSERT INTO records VALUES ('notes', ?, '{\"text\":\"x\"}', 'now')");
        for ($i = 0; $i < 450; $i++) {
            $insert->execute(['r' . $i]);
        }
        $db->exec('COMMIT');
        $db = null;

        $this->keys(self::KEY);
        self::assertSame(450, HostedAppService::encryptDatabase(HostedAppService::databasePath('app-a', $this->root), DataEncryption::fromEnvironment()));
        self::assertSame(450, (int) $this->database()->query("SELECT COUNT(*) FROM records WHERE data LIKE 'flr1.%'")->fetchColumn());
    }

    public function testARecordMovedToAnotherIdDoesNotOpen(): void
    {
        $this->publish();
        $this->save('one');
        $this->save('two', 'other text');
        $db = $this->database();
        $db->prepare("UPDATE records SET data = ? WHERE id = 'two'")->execute([$this->stored('one')]);
        $db = null;

        $this->expectExceptionMessage('Stored data cannot be read');
        $this->host->run('app-a', 'load', ['id' => 'two'], 'member', false);
    }

    public function testARecordAndItsWrappedKeyMovedToAnotherAppDoNotOpen(): void
    {
        $this->publish('app-a');
        $this->publish('app-b');
        $this->save('one', self::PLANTED, 'app-a');
        $wrapped = $this->database('app-a')->query('SELECT wrapped FROM app_key')->fetchColumn();

        $thief = $this->database('app-b');
        $thief->prepare('INSERT INTO app_key VALUES (1, ?)')->execute([$wrapped]);
        $thief->prepare("INSERT INTO records VALUES ('notes', 'one', ?, 'now')")->execute([$this->stored('one', 'app-a')]);
        $thief = null;

        $this->expectExceptionMessage('Stored data cannot be read');
        $this->host->run('app-b', 'load', ['id' => 'one'], 'member', false);
    }

    public function testEveryAppHasItsOwnKey(): void
    {
        $this->publish('app-a');
        $this->publish('app-b');
        $this->save('one', 'a', 'app-a');
        $this->save('one', 'b', 'app-b');

        $wrapped = fn (string $app) => $this->database($app)->query('SELECT wrapped FROM app_key')->fetchColumn();
        self::assertNotSame($wrapped('app-a'), $wrapped('app-b'));
    }

    public function testACopyOfTheDatabaseAloneCannotBeRead(): void
    {
        $this->publish();
        $this->save();

        $this->keys(null);
        $this->expectExceptionMessage('Stored data cannot be read');
        $this->host->run('app-a', 'load', ['id' => 'one'], 'member', false);
    }

    public function testAKeyStoredInThePlainIsNotBelieved(): void
    {
        $this->publish();
        $this->save();
        $db = $this->database();
        $db->prepare('UPDATE app_key SET wrapped = ?')->execute([random_bytes(32)]);
        $db = null;

        $this->expectExceptionMessage('Stored data cannot be read');
        $this->host->run('app-a', 'load', ['id' => 'one'], 'member', false);
    }

    public function testTwoFirstWritersEndUpWithOneKey(): void
    {
        $this->publish();
        $db = $this->database();
        $crypto = DataEncryption::fromEnvironment();
        $id = hash('sha256', 'app-a');
        $first = new HostedRecordCipher($db, $id, $crypto);
        $second = new HostedRecordCipher($db, $id, $crypto);

        $a = $first->seal('notes', 'one', 'a');
        $b = $second->seal('notes', 'two', 'b');

        $reader = new HostedRecordCipher($db, $id, $crypto);
        self::assertSame('a', $reader->open('notes', 'one', $a));
        self::assertSame('b', $reader->open('notes', 'two', $b));
        self::assertSame(1, (int) $db->query('SELECT COUNT(*) FROM app_key')->fetchColumn());
    }

    public function testChangingTheMasterKeyRewrapsWithoutTouchingRecords(): void
    {
        $this->publish();
        $this->save();
        $record = $this->stored();
        $wrapped = $this->database()->query('SELECT wrapped FROM app_key')->fetchColumn();

        $this->keys(self::OTHER, self::KEY);
        self::assertSame(0, HostedAppService::encryptDatabase(HostedAppService::databasePath('app-a', $this->root), DataEncryption::fromEnvironment()));
        self::assertSame($record, $this->stored());
        self::assertNotSame($wrapped, $this->database()->query('SELECT wrapped FROM app_key')->fetchColumn());

        $this->keys(self::OTHER);
        self::assertSame(self::PLANTED, $this->host->run('app-a', 'load', ['id' => 'one'], 'member', false)['text']);
    }

    public function testADownloadIsPlainAndCarriesNoKey(): void
    {
        $this->publish();
        $this->save();

        $path = $this->host->snapshot('app-a');
        try {
            $copy = new PDO('sqlite:' . $path);
            self::assertStringContainsString(self::PLANTED, (string) $copy->query('SELECT data FROM records')->fetchColumn());
            self::assertFalse($copy->query("SELECT 1 FROM sqlite_master WHERE name = 'app_key'")->fetchColumn());
            $copy = null;
        } finally {
            unlink($path);
        }
        self::assertFalse($this->fileHolds(self::PLANTED), 'the live database stays encrypted');
    }

    public function testARestoreEncryptsUnderTheNewAppsOwnKey(): void
    {
        $this->publish();
        $this->save();
        $path = $this->host->snapshot('app-a');
        try {
            self::assertTrue(HostedAppService::restoreDatabase('app-new', $path, $this->root));
        } finally {
            unlink($path);
        }

        self::assertStringStartsWith(HostedRecordCipher::PREFIX, $this->stored('one', 'app-new'));
        self::assertFalse($this->fileHolds(self::PLANTED, 'app-new'));
        self::assertSame(self::PLANTED, $this->host->run('app-new', 'load', ['id' => 'one'], 'member', false)['text']);
    }

    public function testARestoreOnAServerWithAnotherKeyWorks(): void
    {
        $this->publish();
        $this->save();
        $path = $this->host->snapshot('app-a');
        $this->keys(self::OTHER);
        try {
            self::assertTrue(HostedAppService::restoreDatabase('app-new', $path, $this->root));
        } finally {
            unlink($path);
        }

        self::assertSame(self::PLANTED, $this->host->run('app-new', 'load', ['id' => 'one'], 'member', false)['text']);
    }

    public function testARawCopyOfEncryptedRowsIsNotRestored(): void
    {
        $this->publish();
        $this->save();

        try {
            HostedAppService::restoreDatabase('app-new', HostedAppService::databasePath('app-a', $this->root), $this->root);
            self::fail('encrypted rows were restored as if they were plain');
        } catch (\InvalidArgumentException $e) {
            self::assertStringContainsString('encrypted on another server', $e->getMessage());
        }
        self::assertFileDoesNotExist(HostedAppService::databasePath('app-new', $this->root));
    }

    public function testAPageIsMeasuredBeforeEncryption(): void
    {
        $this->publish();
        // 160 KB of records: under the 200 KB page limit, and over it once encrypted.
        for ($i = 0; $i < 10; $i++) {
            $this->save('r' . $i, str_repeat('x', 16000));
        }

        self::assertCount(10, $this->host->run('app-a', 'list', [], 'member', false));
    }

    public function testADamagedRowFailsTheExportAndLeavesTheCopyAlone(): void
    {
        $this->publish();
        $this->save();
        $db = $this->database();
        $db->exec("UPDATE records SET data = 'flr1.AAAA'");
        $db = null;

        $this->expectException(DataEncryptionException::class);
        $this->host->snapshot('app-a');
    }
}
