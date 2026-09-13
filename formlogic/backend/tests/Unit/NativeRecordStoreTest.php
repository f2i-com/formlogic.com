<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Services\NativeRecordStore;
use PDO;
use PHPUnit\Framework\TestCase;

final class NativeRecordStoreTest extends TestCase
{
    private PDO $db;
    private NativeRecordStore $store;
    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
        $this->db->exec("CREATE TABLE notes(id INTEGER PRIMARY KEY, title TEXT NOT NULL UNIQUE, body TEXT, count INTEGER DEFAULT 1, session_token TEXT DEFAULT 'private');");
        $this->store = new NativeRecordStore($this->db);
    }
    private function read(string $id = '1'): array { return $this->store->operate(['action' => 'read', 'table' => 'notes', 'key' => ['id' => $id]])['record']; }

    public function testCrudPreservesFullTextDefaultsNullsAndPrivateValues(): void
    {
        $body = str_repeat('Long text with emoji 😀 ', 70);
        $this->store->operate(['action' => 'create', 'table' => 'notes', 'values' => ['title' => 'First', 'body' => $body]]);
        $record = $this->read();
        $this->assertSame($body, $record['values']->body);
        $this->assertSame('1', $record['values']->count);
        $this->assertObjectNotHasProperty('session_token', $record['values']);
        $this->store->operate(['action' => 'update', 'table' => 'notes', 'key' => ['id' => '1'], 'revision' => $record['revision'], 'values' => ['title' => 'Changed', 'body' => null]]);
        $this->assertNull($this->read()['values']->body);
        $this->assertSame('private', $this->db->query('SELECT session_token FROM notes')->fetchColumn());
        $this->store->operate(['action' => 'delete', 'table' => 'notes', 'key' => ['id' => '1'], 'revision' => $this->read()['revision']]);
        $this->assertSame(0, (int) $this->db->query('SELECT count(*) FROM notes')->fetchColumn());
    }

    public function testConcurrentChangeCannotBeOverwritten(): void
    {
        $this->store->operate(['action' => 'create', 'table' => 'notes', 'values' => ['title' => 'First']]);
        $record = $this->read();
        $this->db->exec("UPDATE notes SET title='Changed by app'");
        try { $this->store->operate(['action' => 'update', 'table' => 'notes', 'key' => ['id' => '1'], 'revision' => $record['revision'], 'values' => ['title' => 'Old draft']]); $this->fail('Expected stale record conflict'); }
        catch (\RuntimeException $e) { $this->assertSame(409, $e->getCode()); }
        $this->assertSame('Changed by app', $this->read()['values']->title);
    }

    public function testConstraintsRollbackAndEventsOnlyDescribeCommittedChanges(): void
    {
        $subscriptions = array_map(static fn($operation) => ['event' => 'app.record.' . $operation . '.notes', 'bindings' => ['binding-1']], ['created', 'updated', 'deleted']);
        $this->store->operate(['action' => 'create', 'table' => 'notes', 'values' => ['title' => 'First']], $subscriptions);
        // New PDO connections are used for real requests; remove TEMP capture triggers in this fixture.
        foreach ([0,1,2] as $index) $this->db->exec('DROP TRIGGER _formlogic_admin_capture_' . $index);
        try { $this->store->operate(['action' => 'create', 'table' => 'notes', 'values' => ['title' => 'First']], $subscriptions); $this->fail('Expected unique constraint'); }
        catch (\RuntimeException $e) { $this->assertSame(422, $e->getCode()); }
        $events = $this->db->query('SELECT * FROM _formlogic_record_events')->fetchAll();
        $this->assertCount(1, $events);
        $this->assertSame('app.record.created.notes', $events[0]['event_name']);
        $this->assertStringNotContainsString('session_token', $events[0]['data_json']);
        $this->store->operate(['action' => 'update', 'table' => 'notes', 'key' => ['id' => '1'], 'revision' => $this->read()['revision'], 'values' => ['title' => 'Updated']], $subscriptions);
        $this->assertSame(2, (int) $this->db->query('SELECT count(*) FROM _formlogic_record_events')->fetchColumn());
    }

    public function testCompositeKeysLargeIntegersAndSchemaMetadata(): void
    {
        $this->db->exec("CREATE TABLE pairs(a TEXT,b INTEGER,body TEXT,total INTEGER GENERATED ALWAYS AS (b+1) VIRTUAL,PRIMARY KEY(a,b)) WITHOUT ROWID;");
        $schema = $this->store->schema('pairs');
        $this->assertSame(['a', 'b'], $schema['primaryKey']);
        $this->assertTrue($schema['fields'][3]['readOnly']);
        $this->store->operate(['action' => 'create', 'table' => 'pairs', 'values' => ['a' => 'Group', 'b' => '9007199254740993', 'body' => 'Hello']]);
        $key = ['a' => 'Group', 'b' => '9007199254740993'];
        $record = $this->store->operate(['action' => 'read', 'table' => 'pairs', 'key' => $key])['record'];
        $this->assertSame('9007199254740993', $record['values']->b);
        $this->store->operate(['action' => 'update', 'table' => 'pairs', 'key' => $key, 'revision' => $record['revision'], 'values' => ['body' => 'Updated']]);
        $this->assertSame('Updated', $this->db->query('SELECT body FROM pairs')->fetchColumn());
    }

    public function testForeignKeyRulesAreEnforced(): void
    {
        $this->db->exec('CREATE TABLE replies(id INTEGER PRIMARY KEY,note_id INTEGER REFERENCES notes(id));');
        try { $this->store->operate(['action' => 'create', 'table' => 'replies', 'values' => ['note_id' => '99']]); $this->fail('Expected foreign key constraint'); }
        catch (\RuntimeException $e) { $this->assertSame(422, $e->getCode()); }
        $this->assertSame(0, (int) $this->db->query('SELECT count(*) FROM replies')->fetchColumn());
    }

    public function testBinaryAndOversizedValuesAreNeverEditablePreviews(): void
    {
        $stmt = $this->db->prepare('INSERT INTO notes(title,body) VALUES (?,?)');
        $stmt->execute(['Large', str_repeat('x', 100001)]);
        $record = $this->read();
        $this->assertObjectNotHasProperty('body', $record['values']);
        $this->assertTrue(array_column($record['fields'], 'readOnly', 'name')['body']);
        $this->db->exec("UPDATE notes SET body=x'010203'");
        $record = $this->read();
        $this->assertObjectNotHasProperty('body', $record['values']);
        $this->assertTrue(array_column($record['fields'], 'readOnly', 'name')['body']);
        $this->store->operate(['action' => 'update', 'table' => 'notes', 'key' => ['id' => '1'], 'revision' => $record['revision'], 'values' => ['title' => 'Still binary']]);
        $this->assertSame('blob', $this->db->query('SELECT typeof(body) FROM notes')->fetchColumn());
    }

    public function testOutOfRangeIntegersDoNotSilentlyBecomeRoundedFloats(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('SQLite integer range');
        $this->store->operate(['action' => 'create', 'table' => 'notes', 'values' => ['title' => 'Number', 'count' => '9223372036854775808']]);
    }
}
