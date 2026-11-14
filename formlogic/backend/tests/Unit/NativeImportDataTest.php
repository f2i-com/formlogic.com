<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Services\NativeAppService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * An app's data brought from where it ran before: what of the earlier host's configuration is
 * taken here (the key and its domains: what it kept for the app's sign-in codes is read only where
 * the plugin sending them says, NativePhoneVerificationTest), and which databases are refused before
 * anything of the app changes. The import itself runs through install() (tested with the runner).
 */
final class NativeImportDataTest extends TestCase
{
    private const MIGRATION = "CREATE TABLE notes(id INTEGER PRIMARY KEY, text TEXT NOT NULL);\n";
    private string $storage;

    protected function setUp(): void
    {
        $this->storage = sys_get_temp_dir() . '/formlogic-native-import-' . bin2hex(random_bytes(8));
        mkdir($this->storage, 0700, true);
    }

    protected function tearDown(): void
    {
        $root = realpath($this->storage);
        if ($root === false || !str_starts_with(basename($root), 'formlogic-native-import-')) return;
        $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($iterator as $file) { if ($file->isDir() && !$file->isLink()) rmdir($file->getPathname()); else unlink($file->getPathname()); }
        rmdir($root);
    }

    /** An installed app with one migration, running as com.example.notes. */
    private function installed(): NativeAppService
    {
        $root = $this->storage . '/' . hash('sha256', 'notes-app');
        mkdir($root . '/private/data', 0700, true);
        $manifest = ['id' => 'com.example.notes', 'version' => '1.0.0', 'main' => 'ui/main.ui', 'server' => ['entry' => 'server/main.logic', 'requires' => ['apiVersion' => 1, 'capabilities' => ['sql']], 'database' => ['kind' => 'private-sqlite', 'migrations' => ['server/migrations/001.sql']], 'routes' => []]];
        file_put_contents($root . '/project.json', json_encode(['home' => false, 'version' => 1, 'access' => 'application', 'assets' => [], 'files' => [
            'manifest.json' => json_encode($manifest), 'ui/main.ui' => '<Text>Notes</Text>', 'server/main.logic' => 'function x(){}', 'server/migrations/001.sql' => self::MIGRATION,
        ]]));
        file_put_contents($root . '/private/config.json', json_encode(['appId' => 'com.example.notes', 'keyHex' => str_repeat('a', 64), 'cryptoDomains' => ['hmac' => 'com.example.notes:hmac:v1', 'seal' => 'com.example.notes:seal:v1']]));
        return new NativeAppService($this->storage, $this->storage . '/no-runtime');
    }

    /** A database made by $sql, with the migration ledger a SoftN host keeps unless $ledger says otherwise. */
    private function database(string $sql = '', ?array $ledger = null): string
    {
        $path = $this->storage . '/upload-' . bin2hex(random_bytes(4)) . '.sqlite';
        $db = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $db->exec(self::MIGRATION);
        $db->exec('CREATE TABLE _migrations(name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL)');
        $db->exec("CREATE TABLE _request_limits(ip TEXT PRIMARY KEY, minute INTEGER NOT NULL, count INTEGER NOT NULL)");
        foreach ($ledger ?? [['server/migrations/001.sql', hash('sha256', self::MIGRATION)]] as [$name, $hash]) {
            $db->prepare('INSERT INTO _migrations VALUES(?,?,?)')->execute([$name, $hash, 1]);
        }
        $db->exec("INSERT INTO notes(text) VALUES('from the old site')");
        if ($sql !== '') $db->exec($sql);
        $db = null;
        return $path;
    }

    private function refusal(callable $act): string
    {
        try { $act(); return 'taken'; } catch (\InvalidArgumentException $e) { return $e->getMessage(); }
    }

    public function testTheEarlierHostsConfigurationGivesItsKeyAndNothingElse(): void
    {
        $taken = NativeAppService::importedKey(json_encode([
            'appId' => 'com.coffeedating.app', 'keyHex' => strtoupper(str_repeat('ab', 32)), 'development' => true, 'enableRequestHook' => true,
            'cryptoDomains' => ['hmac' => 'coffee:otp:v1', 'seal' => 'coffee:outbox:v1'], 'capabilities' => ['sql', 'net'],
            'sms' => ['TWILIO_SID' => 'A' . 'C' . str_repeat('1', 32), 'TWILIO_TOKEN' => 'token', 'TWILIO_VERIFY_SERVICE_SID' => 'V' . 'A' . str_repeat('2', 32)],
        ]));
        // Its development flag, hooks and capabilities are that host's; its sign-in code details are for
        // the plugin that sends the app's codes to name, and only it reads them (NativePhoneVerification::heldIn).
        $this->assertSame(['key' => ['appId' => 'com.coffeedating.app', 'keyHex' => str_repeat('ab', 32), 'cryptoDomains' => ['hmac' => 'coffee:otp:v1', 'seal' => 'coffee:outbox:v1']]], $taken);
        $this->assertStringContainsString('holds no key', $this->refusal(fn() => NativeAppService::importedKey('{"keyHex":"short","cryptoDomains":{"hmac":"h","seal":"s"}}')));
        $this->assertStringContainsString('crypto domains', $this->refusal(fn() => NativeAppService::importedKey(json_encode(['keyHex' => str_repeat('a', 64)]))));
        $this->assertStringContainsString('not the JSON', $this->refusal(fn() => NativeAppService::importedKey('not json')));
    }

    public function testADatabaseIsRefusedBeforeAnythingOfTheAppChanges(): void
    {
        $native = $this->installed();
        $import = fn(string $path, ?array $key = null) => fn() => $native->importData('notes-app', $path, $key);
        $before = file_get_contents($this->storage . '/' . hash('sha256', 'notes-app') . '/private/config.json');

        $notSqlite = $this->storage . '/not.sqlite';
        file_put_contents($notSqlite, str_repeat('x', 200));
        $this->assertSame('That file is not a SQLite database.', $this->refusal($import($notSqlite)));
        $this->assertStringContainsString('has a trigger (wipe)', $this->refusal($import($this->database("CREATE TRIGGER wipe AFTER INSERT ON notes BEGIN DELETE FROM notes; END"))));
        $this->assertStringContainsString('has a view (everything)', $this->refusal($import($this->database('CREATE VIEW everything AS SELECT * FROM notes'))));
        $this->assertStringContainsString('(_secrets), which is not a SoftN host', $this->refusal($import($this->database('CREATE TABLE _secrets(x)'))));
        $this->assertStringContainsString('no record of the migrations', $this->refusal($import($this->database('', []))));
        $this->assertStringContainsString('does not list (server/migrations/002.sql)', $this->refusal($import($this->database('', [['server/migrations/001.sql', hash('sha256', self::MIGRATION)], ['server/migrations/002.sql', 'x']]))));
        $this->assertStringContainsString('is not this version\'s file', $this->refusal($import($this->database('', [['server/migrations/001.sql', hash('sha256', 'something else')]]))));
        // A key made for another app is not this one's.
        $key = ['appId' => 'com.example.other', 'keyHex' => str_repeat('b', 64), 'cryptoDomains' => ['hmac' => 'h', 'seal' => 's']];
        $this->assertSame('That key belongs to com.example.other, and this app runs as com.example.notes.', $this->refusal($import($this->database(), $key)));
        // None of that touched the app.
        $this->assertSame($before, file_get_contents($this->storage . '/' . hash('sha256', 'notes-app') . '/private/config.json'));
        $this->assertFileDoesNotExist($this->storage . '/' . hash('sha256', 'notes-app') . '/private/data/application.sqlite');
    }

    public function testNothingInTheFileRunsWhileItIsJudged(): void
    {
        $native = $this->installed();
        // A view named as the ledger: it would run as the ledger is read (a recursive one, for as long as it likes).
        $view = $this->database('', []);
        $db = new PDO('sqlite:' . $view, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $db->exec('DROP TABLE _migrations');
        $db->exec('CREATE VIEW _migrations AS WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n) SELECT i AS name, i AS sha256 FROM n');
        $db = null;
        $started = microtime(true);
        $this->assertStringContainsString('has a view (_migrations)', $this->refusal(fn() => $native->importData('notes-app', $view, null)));
        $this->assertLessThan(2.0, microtime(true) - $started);
        // A virtual table is one with no pages of its own, however its CREATE statement is written.
        $virtual = $this->database();
        $db = new PDO('sqlite:' . $virtual, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        try { $db->exec('CREATE VIRTUAL TABLE found USING fts5(body)'); $fts = true; } catch (\PDOException) { $fts = false; }
        $db = null;
        if ($fts) $this->assertStringContainsString('virtual table (found)', $this->refusal(fn() => $native->importData('notes-app', $virtual, null)));
        // A real table that says "virtual" in a value or a comment is a real table.
        $worded = $this->database("CREATE TABLE meetings(mode TEXT CHECK(mode IN ('cafe','virtual')) -- a virtual coffee\n)");
        try { $native->importData('notes-app', $worded, null); $this->fail('installed without a runner'); }
        catch (\RuntimeException $e) { $this->assertStringContainsString('native app runtime', $e->getMessage(), 'refused for its words: ' . $e->getMessage()); }
    }


    public function testADatabaseItsHostKeptInWalModeIsReadWithoutWritingToIt(): void
    {
        $native = $this->installed();
        $wal = $this->database();
        $db = new PDO('sqlite:' . $wal, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $db->exec('PRAGMA journal_mode=WAL');
        $db = null;
        $before = hash_file('sha256', $wal);
        // Taken by every check: what stops it here is the runner this test has none of.
        try { $native->importData('notes-app', $wal, null); $this->fail('installed without a runner'); }
        catch (\RuntimeException $e) { $this->assertStringContainsString('native app runtime', $e->getMessage()); }
        $this->assertSame($before, hash_file('sha256', $wal), 'judged without a write');
    }

    public function testAnAppWithNoBackendHasNoDatabaseToBring(): void
    {
        $native = $this->installed();
        $root = $this->storage . '/' . hash('sha256', 'notes-app');
        $project = json_decode((string) file_get_contents($root . '/project.json'), true);
        $project['files']['manifest.json'] = json_encode(['id' => 'com.example.notes', 'version' => '1.0.0', 'main' => 'ui/main.ui']);
        file_put_contents($root . '/project.json', json_encode($project));
        $this->assertStringContainsString('no backend', $this->refusal(fn() => $native->importData('notes-app', $this->database(), null)));
    }
}
