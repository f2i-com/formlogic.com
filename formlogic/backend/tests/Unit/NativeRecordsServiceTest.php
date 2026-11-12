<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Services\NativeAppService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * The data manager through NativeAppService (records, exportRecords, manageRecord, glance), over
 * an installation laid down by hand: a project.json and a database are all these read. No runtime
 * is started, so this runs where NativeAppServiceTest is skipped for want of one.
 */
final class NativeRecordsServiceTest extends TestCase
{
    private string $storage;
    private NativeAppService $service;

    private const NOTES = "CREATE TABLE notes(id INTEGER PRIMARY KEY, title TEXT, body TEXT, session_token TEXT);
        CREATE TABLE tags(name TEXT PRIMARY KEY);
        CREATE TABLE _softn_migrations(id INTEGER PRIMARY KEY);
        INSERT INTO notes(title, body, session_token) VALUES ('First', 'one', 'tok-1'), ('Second', 'two, with a comma', 'tok-2'), ('Third', NULL, 'tok-3');
        INSERT INTO tags VALUES ('red')";

    protected function setUp(): void
    {
        $this->storage = sys_get_temp_dir() . '/formlogic-native-records-' . bin2hex(random_bytes(8));
        mkdir($this->storage, 0700);
        $this->service = new NativeAppService($this->storage, $this->storage . '/no-runtime');
    }

    protected function tearDown(): void
    {
        if (!isset($this->storage) || !is_dir($this->storage)) return;
        $root = realpath($this->storage);
        $temp = realpath(sys_get_temp_dir()) . DIRECTORY_SEPARATOR;
        if ($root === false || !str_starts_with($root, $temp) || !str_starts_with(basename($root), 'formlogic-native-records-')) throw new \RuntimeException('Unexpected fixture path');
        $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($iterator as $file) { if ($file->isDir() && !$file->isLink()) rmdir($file->getPathname()); else unlink($file->getPathname()); }
        rmdir($root);
    }

    private function root(string $app): string { return $this->storage . '/' . hash('sha256', $app); }
    private function databasePath(string $app): string { return $this->root($app) . '/private/data/application.sqlite'; }

    /** An installed project at version 3, for members: with a server side and this database, or all client when $sql is null. */
    private function install(string $app, ?string $sql): void
    {
        mkdir($this->root($app) . '/private/data', 0700, true);
        $manifest = ['id' => 'test.' . $app, 'main' => 'ui/main.ui'] + ($sql === null ? [] : ['server' => ['entry' => 'server/main.logic']]);
        file_put_contents($this->root($app) . '/project.json', json_encode(['home' => false, 'version' => 3, 'files' => ['manifest.json' => json_encode($manifest), 'ui/main.ui' => '<Text>x</Text>'], 'assets' => [], 'access' => 'members']));
        if ($sql !== null && $sql !== '') $this->database($app)->exec($sql);
    }

    private function database(string $app): PDO
    {
        return new PDO('sqlite:' . $this->databasePath($app), null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
    }

    public function testACallerThatAsksNothingNewIsAnsweredAsBefore(): void
    {
        $this->install('notes', self::NOTES);
        $this->assertSame(['installed' => true, 'tables' => ['notes', 'tags']], $this->service->records('notes'));
        // The AI's tool and the tests before the data manager call this way: not one field more.
        $page = $this->service->records('notes', 'notes');
        $this->assertSame(['tables', 'columns', 'rows', 'hasMore', 'end', 'schema', 'keys', 'offset', 'limit', 'offsetLimit'], array_keys($page));
        $this->assertSame([['id' => 1, 'title' => 'First', 'body' => 'one'], ['id' => 2, 'title' => 'Second', 'body' => 'two, with a comma'], ['id' => 3, 'title' => 'Third', 'body' => null]], $page['rows']);
        $this->assertSame([['id' => '1'], ['id' => '2'], ['id' => '3']], $page['keys']);
        $this->assertSame([0, 50, 100000, 'end', false], [$page['offset'], $page['limit'], $page['offsetLimit'], $page['end'], $page['hasMore']]);
        $this->assertSame(['id', 'title', 'body'], array_column($page['schema']['fields'], 'name'));
        $this->assertSame([NativeAppService::RECORD_PAGE, NativeAppService::RECORD_OFFSET_LIMIT], [50, 100000]);

        // The page asks with options, if only an empty list of them, and is given the rest.
        $asked = $this->service->records('notes', 'notes', 0, null, []);
        $this->assertSame($page, array_slice($asked, 0, 10, true));
        $this->assertSame(['total', 'matching', 'sort', 'hiddenColumns', 'stamps', 'cut'], array_slice(array_keys($asked), 10));
        $this->assertSame([3, 3, null, 1, 3], [$asked['total'], $asked['matching'], $asked['sort'], $asked['hiddenColumns'], count($asked['stamps'])]);
    }

    public function testTheTableListCarriesASummaryWhenAskedForOne(): void
    {
        $this->install('notes', self::NOTES);
        $this->install('client', null);
        $this->assertSame([
            'installed' => true,
            'tables' => ['notes', 'tags'],
            'summary' => [
                'tables' => [['name' => 'notes', 'rows' => 3, 'columns' => 3], ['name' => 'tags', 'rows' => 1, 'columns' => 1]],
                'bytes' => filesize($this->databasePath('notes')),
                'hiddenTables' => 1,
            ],
        ], $this->service->records('notes', null, 0, null, ['summary' => true]));
        $this->assertGreaterThan(0, filesize($this->databasePath('notes')));
        $this->assertArrayNotHasKey('summary', $this->service->records('notes', null, 0, null, []));
        $this->assertArrayNotHasKey('summary', $this->service->records('notes', 'notes', 0, null, ['summary' => true]), 'a summary is the table list\'s');
        // No database, so nothing to sum up: the answer a client-only app always had.
        $this->assertSame(['installed' => true, 'tables' => [], 'backend' => false], $this->service->records('client', null, 0, null, ['summary' => true]));
    }

    public function testABrowseWithOptionsAndTheStructureViewGoThroughTheService(): void
    {
        $this->install('notes', self::NOTES);
        $this->install('client', null);
        $page = $this->service->records('notes', 'notes', 1, null, ['sort' => 'title', 'dir' => 'desc', 'q' => 'i', 'filter' => '[{"column":"body","op":"notEmpty"}]', 'limit' => 25]);
        // 'First' and 'Second' pass (Third has no body); by title descending, from the second row.
        $this->assertSame([['id' => 1, 'title' => 'First', 'body' => 'one']], $page['rows']);
        $this->assertSame([3, 2, 25, 1, ['column' => 'title', 'dir' => 'desc']], [$page['total'], $page['matching'], $page['limit'], $page['offset'], $page['sort']]);

        $structure = $this->service->records('notes', 'notes', 0, null, ['view' => 'structure']);
        $this->assertSame(['table', 'rows', 'columns', 'indexes', 'foreignKeys', 'referencedBy'], array_keys($structure));
        $this->assertSame(['notes', 3], [$structure['table'], $structure['rows']]);
        $this->assertSame([['id', false], ['title', false], ['body', false], ['session_token', true]], array_map(static fn($c) => [$c['name'], $c['hidden']], $structure['columns']));

        foreach ([['sort' => 'session_token'], ['filter' => '[{"column":"session_token","op":"notEmpty"}]'], ['filter' => 'not json'], ['q' => str_repeat('x', 201)]] as $options) {
            try { $this->service->records('notes', 'notes', 0, null, $options); $this->fail('Accepted ' . json_encode($options)); }
            catch (\InvalidArgumentException $refused) { $this->assertNotSame('', $refused->getMessage()); }
        }
        foreach ([['notes', 'nowhere', []], ['notes', '_softn_migrations', ['view' => 'structure']], ['client', 'notes', []], ['client', 'notes', ['view' => 'structure']]] as [$app, $table, $options]) {
            try { $this->service->records($app, $table, 0, null, $options); $this->fail("$app.$table was read"); }
            catch (\RuntimeException $missing) { $this->assertSame(404, $missing->getCode()); }
        }
    }

    /** Every read is `PRAGMA query_only` in one transaction: the file is the same bytes afterwards, and nobody is kept out. */
    public function testReadingChangesNothingAndHoldsNothing(): void
    {
        $this->install('notes', self::NOTES);
        $before = hash_file('sha256', $this->databasePath('notes'));
        $this->service->records('notes', null, 0, null, ['summary' => true]);
        $this->service->records('notes', 'notes', 0, null, ['q' => 'First', 'sort' => 'title']);
        $this->service->records('notes', 'notes', 0, null, ['view' => 'structure']);
        fclose($this->service->exportRecords('notes', null, 'json')['stream']);
        $this->service->glance('notes');
        $this->assertSame($before, hash_file('sha256', $this->databasePath('notes')));
        $this->assertSame([], glob($this->databasePath('notes') . '-*') ?: [], 'no journal left beside it');
        // The management lock is free again, and so is the file (Windows refuses to move one that is open).
        $lock = fopen($this->root('notes') . '/private/manage.lock', 'c');
        $this->assertTrue(flock($lock, LOCK_EX | LOCK_NB));
        flock($lock, LOCK_UN);
        fclose($lock);
        $this->assertTrue(rename($this->databasePath('notes'), $this->databasePath('notes') . '.moved'));
        $this->assertTrue(rename($this->databasePath('notes') . '.moved', $this->databasePath('notes')));
    }

    public function testAnExportIsAStreamAtItsStartAndSaysWhetherItWasCut(): void
    {
        $this->install('notes', self::NOTES);
        $this->install('client', null);
        $csv = $this->service->exportRecords('notes', 'notes', 'csv', ['sort' => 'id', 'dir' => 'desc']);
        $this->assertSame(['stream', 'truncated'], array_keys($csv));
        $this->assertFalse($csv['truncated']);
        $this->assertSame(0, ftell($csv['stream']));
        $this->assertSame("\xEF\xBB\xBF" . "id,title,body\r\n3,Third,\r\n2,Second,\"two, with a comma\"\r\n1,First,one\r\n", stream_get_contents($csv['stream']));
        fclose($csv['stream']);

        $all = $this->service->exportRecords('notes', null, 'json');
        $this->assertSame('{"tables":{"notes":[{"id":1,"title":"First","body":"one"},{"id":2,"title":"Second","body":"two, with a comma"},{"id":3,"title":"Third","body":null}],"tags":[{"name":"red"}]}}', stream_get_contents($all['stream']));
        fclose($all['stream']);

        foreach ([['notes', 'nowhere', 'csv', 404, 'Table not found'], ['notes', '_softn_migrations', 'json', 404, 'Table not found'], ['client', 'notes', 'csv', 404, 'This app has no database'], ['client', null, 'json', 404, 'This app has no database'], ['missing', 'notes', 'csv', 404, 'Native app not found']] as [$app, $table, $format, $code, $message]) {
            try { $this->service->exportRecords($app, $table, $format); $this->fail("$app exported"); }
            catch (\RuntimeException $refused) { $this->assertSame([$code, $message], [$refused->getCode(), $refused->getMessage()]); }
        }
        foreach ([['notes', 'xml', []], [null, 'csv', []], ['notes', 'csv', ['sort' => 'session_token']], [null, 'json', ['q' => 'First']]] as [$table, $format, $options]) {
            try { $this->service->exportRecords('notes', $table, $format, $options); $this->fail('Exported ' . json_encode([$table, $format, $options])); }
            catch (\InvalidArgumentException $refused) { $this->assertNotSame('', $refused->getMessage()); }
        }
    }

    public function testDeleteManyThroughTheServiceQueuesTheEventsADeleteDoes(): void
    {
        $this->install('notes', self::NOTES);
        $subscriptions = [['event' => 'app.record.deleted.notes', 'bindings' => ['binding-1']]];
        $page = $this->service->records('notes', 'notes', 0, null, []);
        $rows = array_map(static fn($key, $stamp) => ['key' => $key, 'stamp' => $stamp], $page['keys'], $page['stamps']);

        // Stale: the app wrote to one of the rows since.
        $this->database('notes')->exec("UPDATE notes SET body = 'changed' WHERE id = 2");
        try { $this->service->manageRecord('notes', ['table' => 'notes', 'action' => 'deleteMany', 'rows' => $rows], $subscriptions); $this->fail('Stale rows were deleted'); }
        catch (\RuntimeException $stale) { $this->assertSame(409, $stale->getCode()); }
        $this->assertSame(0, $this->service->dispatchRecordEvents('notes', fn() => $this->fail('A refused delete queued an event')));
        $this->assertCount(3, $this->service->records('notes', 'notes')['rows']);

        $this->assertSame(['saved' => true, 'deleted' => 2], $this->service->manageRecord('notes', ['table' => 'notes', 'action' => 'deleteMany', 'rows' => [$rows[0], $rows[2]]], $subscriptions));
        $delivered = [];
        $this->assertSame(2, $this->service->dispatchRecordEvents('notes', function ($id, $event, $data, $bindings) use (&$delivered): void { $delivered[] = [$event, $data['operation'], $data['record'], $bindings]; }));
        sort($delivered);
        $this->assertSame([
            ['app.record.deleted.notes', 'deleted', ['id' => 1, 'title' => 'First', 'body' => 'one'], ['binding-1']],
            ['app.record.deleted.notes', 'deleted', ['id' => 3, 'title' => 'Third', 'body' => null], ['binding-1']],
        ], $delivered);
        $this->assertSame([['id' => 2, 'title' => 'Second', 'body' => 'changed']], $this->service->records('notes', 'notes')['rows']);
    }

    public function testAGlanceIsWhatTheAppsListShowsOfAnInstallation(): void
    {
        $this->assertNull($this->service->glance('nothing-here'));
        $this->install('notes', self::NOTES);
        $this->install('client', null);
        $this->install('unmigrated', '');
        // The shown tables only, and the file's size as the records summary gives it.
        $this->assertEquals(['version' => 3, 'access' => 'members', 'backend' => true, 'tables' => 2, 'bytes' => filesize($this->databasePath('notes'))], $this->service->glance('notes'));
        $this->assertSame($this->service->records('notes', null, 0, null, ['summary' => true])['summary']['bytes'], $this->service->glance('notes')['bytes']);
        $this->assertEquals(['version' => 3, 'access' => 'members', 'backend' => false, 'tables' => null, 'bytes' => null], $this->service->glance('client'));
        $this->assertEquals(['version' => 3, 'access' => 'members', 'backend' => true, 'tables' => null, 'bytes' => null], $this->service->glance('unmigrated'), 'a server side whose database is not there yet');
        $this->assertFileDoesNotExist($this->databasePath('unmigrated'), 'a glance does not make one');

        // Being updated: what the project says is still shown, and the database is left alone.
        $lock = fopen($this->root('notes') . '/private/manage.lock', 'c');
        $this->assertTrue(flock($lock, LOCK_EX | LOCK_NB));
        try { $this->assertEquals(['version' => 3, 'access' => 'members', 'backend' => true, 'tables' => null, 'bytes' => null], $this->service->glance('notes')); }
        finally { flock($lock, LOCK_UN); fclose($lock); }

        // A file that is no database is not a reason to fail a list of apps.
        file_put_contents($this->databasePath('unmigrated'), str_repeat('not a database ', 400));
        $this->assertEquals(['version' => 3, 'access' => 'members', 'backend' => true, 'tables' => null, 'bytes' => null], $this->service->glance('unmigrated'));
    }
}
