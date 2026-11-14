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

    public function testKeyDigestsAndApiKeysStayHiddenLikeTokens(): void
    {
        // PIT FMS keeps each operator's access-key digest in key_hash; it is a credential like a token.
        $this->db->exec("CREATE TABLE operators(id INTEGER PRIMARY KEY, display_name TEXT NOT NULL, key_hash TEXT NOT NULL DEFAULT 'digest', api_key TEXT, access_key TEXT, private_key TEXT, request_key TEXT)");
        $names = array_column($this->store->schema('operators')['fields'], 'name');
        $this->assertSame(['id', 'display_name', 'request_key'], $names);
        $this->store->operate(['action' => 'create', 'table' => 'operators', 'values' => ['display_name' => 'Night dispatcher']]);
        $values = (array) $this->store->operate(['action' => 'read', 'table' => 'operators', 'key' => ['id' => '1']])['record']['values'];
        $this->assertSame(['id', 'display_name', 'request_key'], array_keys($values));
        $this->assertSame('digest', $this->db->query('SELECT key_hash FROM operators')->fetchColumn());
        foreach (['key_hash', 'api_key', 'ACCESS_KEY', 'ssh_private_key', 'session_token', 'password_hash', 'apiKey', 'accessKey', 'keyHash', 'privateKey', 'codeHash'] as $name) $this->assertTrue(NativeRecordStore::hidden($name), $name);
        foreach (['request_key', 'primary_key', 'keyboard'] as $name) $this->assertFalse(NativeRecordStore::hidden($name), $name);
    }

    /**
     * The whole rule, by name. A credential's word hides a column wherever it stands as a whole
     * word, in snake_case or camelCase; a name that merely holds its letters is shown. What the
     * older part of the rule hid stays hidden, what it hid needlessly included.
     */
    public function testAColumnIsHiddenByACredentialsWordAndNotByItsLetters(): void
    {
        $hidden = [
            // Each word alone, in the three ways a name is cased.
            'hash', 'Hash', 'HASH', 'salt', 'Salt', 'SALT', 'otp', 'Otp', 'OTP', 'pin', 'Pin', 'PIN',
            'passcode', 'Passcode', 'PASSCODE', 'passphrase', 'Passphrase', 'PASSPHRASE', 'credential', 'Credential', 'credentials', 'CREDENTIALS',
            // snake_case, first, last or in the middle.
            'pin_hash', 'PIN_HASH', 'user_pin', 'pin_set_at', 'content_hash', 'sha256_hash', 'hash_of_row', 'pw_salt', 'salt_b64', 'otp_code', 'last_otp', 'door_passcode',
            'wallet_passphrase', 'aws_credentials', 'credential_id',
            // camelCase and PascalCase, acronyms among them.
            'pinHash', 'PinHash', 'userPin', 'userPIN', 'PINHash', 'pinSetAt', 'contentHash', 'pwSalt', 'SaltB64', 'otpCode', 'OTPCode', 'lastOtp', 'doorPasscode', 'walletPassphrase',
            'awsCredentials', 'credentialId', 'CredentialID',
            // A digit, a space or a hyphen ends a word as an underscore does.
            'pin2', 'hash256', 'pin code', 'pin-code', 'otp.code',
            // The older part, unchanged: anywhere in the name, in any case, and more than it must.
            'password', 'passWord', 'PASSWORD_HASH', 'session_token', 'tokens_used', 'TokenCount', 'client_secret', 'secretary', 'code_hash', 'codehash', 'key_hash', 'keyhash', 'api_key',
            'apikey', 'APIKEY', 'access_key', 'accesskey', 'private_key', 'privatekey', 'challenge', 'challenger', 'encrypted_body', 'unencrypted', 'sealed', 'unsealed_at',
        ];
        $shown = [
            // The coordinates of a word are not the word.
            'pinned_at', 'pinnedAt', 'Pinned', 'is_pinned', 'shipping_address', 'shippingAddress', 'opinion', 'OPINION', 'spin', 'SPIN', 'spinCount', 'pinpoint', 'pins', 'topping',
            'hashtag', 'HASHTAG', 'hashtags', 'rehash', 'hashed', 'salty', 'unsalted', 'basalt', 'option', 'options', 'optIn', 'opt_in', 'laptop', 'stop', 'accredited', 'passage',
            // Nor is a word the rule does not name.
            'request_key', 'primary_key', 'keyboard', 'id', 'title', 'notes', 'email', 'created_at', 'updatedAt', 'sha256', 'digest', 'code', 'pass', 'phrase', 'position', '',
        ];
        foreach ($hidden as $name) $this->assertTrue(NativeRecordStore::hidden($name), "$name is hidden");
        foreach ($shown as $name) $this->assertFalse(NativeRecordStore::hidden($name), "$name is shown");
    }

    /** The rule at work: what a list, a search, a filter, a sort, an export, a record and an automation's event are given of a hidden column. */
    public function testAHiddenColumnIsNowhereButInTheStructureView(): void
    {
        $this->db->exec("CREATE TABLE accounts(id INTEGER PRIMARY KEY, email TEXT, pin_hash TEXT, password TEXT, otpCode TEXT, PassSalt TEXT, pinned_at TEXT);
            INSERT INTO accounts(email, pin_hash, password, otpCode, PassSalt, pinned_at) VALUES ('ada@example.test', 'pin-digest-1', 'pw-1', '424242', 'salt-1', 'monday'), ('bo@example.test', 'pin-digest-2', 'pw-2', '171717', 'salt-2', NULL)");
        $page = $this->store->browse('accounts');
        $this->assertSame(['id', 'email', 'pinned_at'], $page['columns']);
        $this->assertSame([['id' => 1, 'email' => 'ada@example.test', 'pinned_at' => 'monday'], ['id' => 2, 'email' => 'bo@example.test', 'pinned_at' => null]], $page['rows']);
        $this->assertSame(4, $page['hiddenColumns']);
        $this->assertSame(['id', 'email', 'pinned_at'], array_column($page['schema']['fields'], 'name'));
        foreach (['pin-digest', 'pw-1', '424242', 'salt-1'] as $value) {
            $this->assertStringNotContainsString($value, json_encode($page));
            $this->assertSame(0, $this->store->browse('accounts', 0, ['q' => $value])['matching'], "$value is not searched");
        }
        $this->assertSame(1, $this->store->browse('accounts', 0, ['q' => 'monday'])['matching']);
        foreach (['pin_hash', 'password', 'otpCode', 'PassSalt'] as $column) {
            foreach ([['sort' => $column], ['filter' => [['column' => $column, 'op' => 'notEmpty']]]] as $options) {
                try { $this->store->browse('accounts', 0, $options); $this->fail("$column was sorted or filtered by"); }
                catch (\InvalidArgumentException $refused) { $this->assertStringContainsStringIgnoringCase('unknown column', $refused->getMessage()); }
            }
        }
        // Part of a row's stamp all the same: a new PIN is a changed row.
        $this->db->exec("UPDATE accounts SET pin_hash = 'pin-digest-9' WHERE id = 2");
        $this->assertSame($page['stamps'][0], $this->store->browse('accounts')['stamps'][0]);
        $this->assertNotSame($page['stamps'][1], $this->store->browse('accounts')['stamps'][1]);

        $out = fopen('php://memory', 'w+b');
        $this->store->export($out, 'accounts', 'csv');
        $this->assertSame("\xEF\xBB\xBF" . "id,email,pinned_at\r\n1,ada@example.test,monday\r\n2,bo@example.test,\r\n", stream_get_contents($out, null, 0));
        fclose($out);
        $this->assertSame(['id', 'email', 'pinned_at'], array_keys((array) $this->store->operate(['action' => 'read', 'table' => 'accounts', 'key' => ['id' => '1']])['record']['values']));
        try { $this->store->operate(['action' => 'update', 'table' => 'accounts', 'key' => ['id' => '1'], 'revision' => $this->store->operate(['action' => 'read', 'table' => 'accounts', 'key' => ['id' => '1']])['record']['revision'], 'values' => ['pin_hash' => 'mine']]); $this->fail('A hidden column was written'); }
        catch (\InvalidArgumentException $refused) { $this->assertSame('This field cannot be edited: pin_hash', $refused->getMessage()); }

        // The one place they are named: by name and type, flagged, their values and defaults left out.
        $this->assertSame([['id', false], ['email', false], ['pin_hash', true], ['password', true], ['otpCode', true], ['PassSalt', true], ['pinned_at', false]], array_map(static fn($c) => [$c['name'], $c['hidden']], $this->store->structure('accounts')['columns']));

        $this->store->operate(['action' => 'delete', 'table' => 'accounts', 'key' => ['id' => '1'], 'revision' => $this->store->operate(['action' => 'read', 'table' => 'accounts', 'key' => ['id' => '1']])['record']['revision']], [['event' => 'app.record.deleted.accounts', 'bindings' => ['binding-1']]]);
        $this->assertSame(['id' => 1, 'email' => 'ada@example.test', 'pinned_at' => 'monday'], json_decode($this->db->query('SELECT data_json FROM _formlogic_record_events')->fetchColumn(), true)['record']);
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

    /** A row added says which row it is, so the data manager can open it: by the number the database gave it, or the key it was given. */
    public function testARowAddedIsNamedByItsKey(): void
    {
        $this->db->exec("INSERT INTO notes(id, title) VALUES (41, 'Before')");
        $this->assertSame(['saved' => true, 'key' => ['id' => '42']], $this->store->operate(['action' => 'create', 'table' => 'notes', 'values' => ['title' => 'Numbered']]));
        $this->assertSame(['saved' => true, 'key' => ['id' => '7']], $this->store->operate(['action' => 'create', 'table' => 'notes', 'values' => ['id' => '7', 'title' => 'Given']]));
        $this->db->exec('CREATE TABLE pairs(a TEXT, b INTEGER, body TEXT, PRIMARY KEY(a, b)) WITHOUT ROWID');
        $this->assertSame(['saved' => true, 'key' => ['a' => 'G', 'b' => '2']], $this->store->operate(['action' => 'create', 'table' => 'pairs', 'values' => ['a' => 'G', 'b' => '2']]));
        // A text key the database fills in itself (a default) is not named: the page has nothing to open it by.
        $this->db->exec("CREATE TABLE tags(name TEXT PRIMARY KEY DEFAULT 'untitled', colour TEXT)");
        $this->assertSame(['saved' => true], $this->store->operate(['action' => 'create', 'table' => 'tags', 'values' => ['colour' => 'red']]));
        // Nor is a row of a table with no key.
        $this->db->exec('CREATE TABLE log(message TEXT)');
        $this->assertSame(['saved' => true], $this->store->operate(['action' => 'create', 'table' => 'log', 'values' => ['message' => 'hello']]));
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

    // ── deleteMany ───────────────────────────────────────────────────────────

    private function createNotes(string ...$titles): void
    {
        foreach ($titles as $title) $this->store->operate(['action' => 'create', 'table' => 'notes', 'values' => ['title' => $title]]);
    }

    /** @return list<array{key: array<string, string>|null, stamp: string|null}> each row of a list as deleteMany takes it */
    private function listed(string $table = 'notes', int $offset = 0): array
    {
        $page = $this->store->browse($table, $offset, ['limit' => 250]);
        return array_map(static fn($key, $stamp) => ['key' => $key, 'stamp' => $stamp], $page['keys'], $page['stamps']);
    }

    private function titles(): array { return $this->db->query('SELECT title FROM notes ORDER BY id')->fetchAll(PDO::FETCH_COLUMN); }

    /** @return array{0: int|string, 1: string} the refusal's code and message */
    private function refusedDelete(mixed $rows, string $table = 'notes'): array
    {
        try { $this->store->operate(['action' => 'deleteMany', 'table' => $table] + ($rows === null ? [] : ['rows' => $rows])); }
        catch (\RuntimeException|\InvalidArgumentException $refusal) { return [$refusal instanceof \InvalidArgumentException ? 400 : $refusal->getCode(), $refusal->getMessage()]; }
        $this->fail('The rows were deleted');
    }

    public function testDeleteManyRemovesTheListedRowsAndCountsARecordOnce(): void
    {
        $this->createNotes('One', 'Two', 'Three', 'Four');
        $rows = $this->listed();
        $this->assertSame(['saved' => true, 'deleted' => 2], $this->store->operate(['action' => 'deleteMany', 'table' => 'notes', 'rows' => [$rows[0], $rows[2]]]));
        $this->assertSame(['Two', 'Four'], $this->titles());
        // The same record under two spellings of its key is one record.
        $this->assertSame(['saved' => true, 'deleted' => 1], $this->store->operate(['action' => 'deleteMany', 'table' => 'notes', 'rows' => [$rows[1], ['key' => ['id' => '02'], 'stamp' => $rows[1]['stamp']]]]));
        $this->assertSame(['Four'], $this->titles());
        $this->assertSame('private', $this->db->query('SELECT session_token FROM notes')->fetchColumn());
        // A composite key, in a table with no rowid.
        $this->db->exec("CREATE TABLE pairs(a TEXT, b INTEGER, body TEXT, PRIMARY KEY(a, b)) WITHOUT ROWID; INSERT INTO pairs VALUES ('x', 1, 'p'), ('x', 2, 'q'), ('y', 1, 'r')");
        $pairs = $this->listed('pairs');
        $this->assertSame(['a' => 'x', 'b' => '2'], $pairs[1]['key']);
        $this->assertSame(['saved' => true, 'deleted' => 2], $this->store->operate(['action' => 'deleteMany', 'table' => 'pairs', 'rows' => [$pairs[1], $pairs[2]]]));
        $this->assertSame(['p'], $this->db->query('SELECT body FROM pairs')->fetchAll(PDO::FETCH_COLUMN));
    }

    public function testAStaleStampRefusesEveryRowOfADeleteMany(): void
    {
        $this->createNotes('One', 'Two', 'Three');
        $nothing = ' changed or gone since the list was loaded, so nothing was deleted. Refresh the records and try again.';

        // The app changed one of them after the list was loaded.
        $rows = $this->listed();
        $this->db->exec("UPDATE notes SET body = 'edited by the app' WHERE id = 2");
        $this->assertSame([409, '1 record has' . $nothing], $this->refusedDelete($rows));
        $this->assertSame(['One', 'Two', 'Three'], $this->titles(), 'the two unchanged rows stay too');

        // A value the owner never sees changed: the row is not the one that was listed.
        $rows = $this->listed();
        $this->db->exec("UPDATE notes SET session_token = 'rotated' WHERE id = 1");
        $this->assertSame([409, '1 record has' . $nothing], $this->refusedDelete([$rows[0], $rows[2]]));

        // A stamp is one row's: it does not vouch for another.
        $rows = $this->listed();
        $this->assertSame([409, '2 records have' . $nothing], $this->refusedDelete([['key' => $rows[0]['key'], 'stamp' => $rows[1]['stamp']], ['key' => $rows[1]['key'], 'stamp' => $rows[0]['stamp']], $rows[2]]));
        $this->assertSame([409, '1 record has' . $nothing], $this->refusedDelete([['key' => $rows[0]['key'], 'stamp' => str_repeat('0', 64)]]));
        $this->assertSame([409, '1 record has' . $nothing], $this->refusedDelete([['key' => $rows[0]['key'], 'stamp' => '']]));

        // Rows that are gone.
        $this->db->exec('DELETE FROM notes WHERE id IN (1, 3)');
        $this->assertSame([409, '2 records have' . $nothing], $this->refusedDelete($rows));
        $this->assertSame(['Two'], $this->titles());
        $this->assertSame(['saved' => true, 'deleted' => 1], $this->store->operate(['action' => 'deleteMany', 'table' => 'notes', 'rows' => [$rows[1]]]), 'the stamp of the row that did not change still deletes it');
    }

    public function testDeleteManyTakesOneToTwoHundredAndFiftyRows(): void
    {
        $this->db->exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 251) INSERT INTO notes(id, title) SELECT i, 'n' || i FROM n");
        $rows = [...$this->listed(), ...$this->listed('notes', 250)];
        $this->assertCount(251, $rows);
        $limit = [400, 'Choose between 1 and 250 records to delete.'];
        $this->assertSame($limit, $this->refusedDelete($rows));
        $this->assertSame($limit, $this->refusedDelete([]));
        $this->assertSame($limit, $this->refusedDelete(null));
        $this->assertSame($limit, $this->refusedDelete('all'));
        $this->assertSame($limit, $this->refusedDelete(['first' => $rows[0]]));
        $shape = [400, 'Each record to delete needs its key and the stamp its list gave it.'];
        $this->assertSame($shape, $this->refusedDelete([$rows[0], ['key' => $rows[1]['key']]]));
        $this->assertSame($shape, $this->refusedDelete([['key' => $rows[0]['key'], 'stamp' => null]]));
        $this->assertSame($shape, $this->refusedDelete([$rows[0]['stamp']]));
        $key = [400, 'A complete primary key is required to edit this record.'];
        $this->assertSame($key, $this->refusedDelete([$rows[0], ['stamp' => $rows[1]['stamp']]]));
        $this->assertSame($key, $this->refusedDelete([['key' => [], 'stamp' => $rows[0]['stamp']]]));
        $this->assertSame($key, $this->refusedDelete([['key' => ['id' => ['1']], 'stamp' => $rows[0]['stamp']]]));
        $this->assertSame($key, $this->refusedDelete([['key' => ['id' => '1', 'title' => 'n1'], 'stamp' => $rows[0]['stamp']]]));
        // A table with no key an owner can use has no rows deleteMany can name.
        $this->db->exec("CREATE TABLE log(line TEXT); INSERT INTO log VALUES ('a')");
        $this->assertSame($key, $this->refusedDelete([['key' => ['rowid' => '1'], 'stamp' => str_repeat('0', 64)]], 'log'));
        $this->assertSame(251, (int) $this->db->query('SELECT count(*) FROM notes')->fetchColumn(), 'no refusal deleted anything');

        $this->assertSame(['saved' => true, 'deleted' => 250], $this->store->operate(['action' => 'deleteMany', 'table' => 'notes', 'rows' => array_slice($rows, 0, 250)]));
        $this->assertSame(['n251'], $this->titles());
    }

    public function testDeleteManyQueuesAnEventForEachRowAndForWhatItCascadesTo(): void
    {
        $this->db->exec('CREATE TABLE replies(id INTEGER PRIMARY KEY, note_id INTEGER REFERENCES notes(id) ON DELETE CASCADE, text TEXT)');
        $this->createNotes('One', 'Two', 'Three');
        $this->db->exec("INSERT INTO replies(note_id, text) VALUES (1, 'to one'), (1, 'to one again'), (3, 'to three')");
        $subscriptions = [['event' => 'app.record.deleted.notes', 'bindings' => ['binding-notes']], ['event' => 'app.record.deleted.replies', 'bindings' => ['binding-replies']], ['event' => 'app.record.updated.notes', 'bindings' => ['binding-updates']]];
        $rows = $this->listed();
        $this->assertSame(['saved' => true, 'deleted' => 2], $this->store->operate(['action' => 'deleteMany', 'table' => 'notes', 'rows' => [$rows[0], $rows[1]]], $subscriptions));
        $events = array_map(static function (array $event): array {
            $data = json_decode($event['data_json'], true);
            return [$event['event_name'], $data['operation'], $data['record']['title'] ?? $data['record']['text'], json_decode($event['bindings_json'], true)];
        }, $this->db->query('SELECT * FROM _formlogic_record_events')->fetchAll());
        sort($events);
        // As one delete fires them: an event for each row that went, the replies foreign keys took with it included.
        $this->assertSame([
            ['app.record.deleted.notes', 'deleted', 'One', ['binding-notes']],
            ['app.record.deleted.notes', 'deleted', 'Two', ['binding-notes']],
            ['app.record.deleted.replies', 'deleted', 'to one', ['binding-replies']],
            ['app.record.deleted.replies', 'deleted', 'to one again', ['binding-replies']],
        ], $events);
        $this->assertStringNotContainsString('session_token', implode('', $this->db->query('SELECT data_json FROM _formlogic_record_events')->fetchAll(PDO::FETCH_COLUMN)));
        $this->assertSame(['to three'], $this->db->query('SELECT text FROM replies')->fetchAll(PDO::FETCH_COLUMN));
    }

    public function testADeleteManyTheDatabaseRejectsDeletesNothingAndQueuesNothing(): void
    {
        $this->db->exec('CREATE TABLE replies(id INTEGER PRIMARY KEY, note_id INTEGER NOT NULL REFERENCES notes(id))');
        $this->createNotes('One', 'Two');
        $this->db->exec('INSERT INTO replies(note_id) VALUES (2)');
        $rows = $this->listed();
        try { $this->store->operate(['action' => 'deleteMany', 'table' => 'notes', 'rows' => $rows], [['event' => 'app.record.deleted.notes', 'bindings' => ['binding-notes']]]); $this->fail('Expected the reply to keep its note'); }
        catch (\RuntimeException $e) { $this->assertSame(422, $e->getCode()); }
        $this->assertSame(['One', 'Two'], $this->titles(), 'the first row came back with the transaction');
        $this->assertSame(0, (int) $this->db->query("SELECT count(*) FROM sqlite_master WHERE name = '_formlogic_record_events'")->fetchColumn(), 'and its event with it');
        // The stamps are still the rows': with the reply gone, the same request deletes both.
        $this->db->exec('DELETE FROM replies');
        $this->assertSame(['saved' => true, 'deleted' => 2], $this->store->operate(['action' => 'deleteMany', 'table' => 'notes', 'rows' => $rows]));
    }
}
