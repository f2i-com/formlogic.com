<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Services\NativeRecordStore;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * A record's revision is what a change names to say "the record as I read it". It is made from the
 * whole row, hidden columns included, and is handed to whoever reads the record. Keyed with a
 * secret of the installation's, it says nothing about what the hidden columns hold; unkeyed, it
 * was a plain SHA-256 of the row, and a reader with no other way to a hidden four-digit PIN could
 * try all ten thousand against it.
 */
final class NativeRecordRevisionTest extends TestCase
{
    private static function database(): PDO
    {
        $db = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
        $db->exec('CREATE TABLE members(id INTEGER PRIMARY KEY, name TEXT NOT NULL, pin TEXT)');
        $db->exec("INSERT INTO members(id, name, pin) VALUES(1, 'Sam', '4821')");
        return $db;
    }

    private static function read(NativeRecordStore $store): array
    {
        return $store->operate(['action' => 'read', 'table' => 'members', 'key' => ['id' => '1']])['record'];
    }

    public function testAKeyedRevisionIsNotAHashAReaderCanTryValuesAgainst(): void
    {
        $db = self::database();
        $record = self::read(new NativeRecordStore($db, 'a secret of the installation'));
        // The hidden column is not among the values…
        $this->assertSame(['id' => '1', 'name' => 'Sam'], (array) $record['values']);
        // …and no guess at it, hashed the way the revision once was, is the revision.
        $row = $db->query('SELECT * FROM members WHERE id = 1')->fetch();
        $this->assertSame('4821', $row['pin']);
        $this->assertNotSame(hash('sha256', serialize($row)), $record['revision']);
        $this->assertSame(hash_hmac('sha256', serialize($row), 'a secret of the installation'), $record['revision']);
        // Another installation's key gives another revision for the same row.
        $this->assertNotSame($record['revision'], self::read(new NativeRecordStore($db, 'another secret'))['revision']);
        // With no installation behind it, the revision is as it always was.
        $this->assertSame(hash('sha256', serialize($row)), self::read(new NativeRecordStore($db))['revision']);
    }

    public function testAChangeNamesTheKeyedRevisionAndAStaleOrUnkeyedOneIsRefused(): void
    {
        $db = self::database();
        $store = new NativeRecordStore($db, 'a secret of the installation');
        $revision = self::read($store)['revision'];
        $unkeyed = hash('sha256', serialize($db->query('SELECT * FROM members WHERE id = 1')->fetch()));
        try {
            $store->operate(['action' => 'update', 'table' => 'members', 'key' => ['id' => '1'], 'revision' => $unkeyed, 'values' => ['name' => 'Sam B']]);
            $this->fail('took a revision made without the key');
        } catch (\RuntimeException $e) {
            $this->assertSame(409, $e->getCode());
        }
        $this->assertSame(['saved' => true], $store->operate(['action' => 'update', 'table' => 'members', 'key' => ['id' => '1'], 'revision' => $revision, 'values' => ['name' => 'Sam B']]));
        // The record changed, so the revision it was read at no longer names it…
        try {
            $store->operate(['action' => 'delete', 'table' => 'members', 'key' => ['id' => '1'], 'revision' => $revision]);
            $this->fail('deleted at a stale revision');
        } catch (\RuntimeException $e) {
            $this->assertSame(409, $e->getCode());
        }
        // …and a change to the hidden column alone is a change too.
        $now = self::read($store)['revision'];
        $db->exec("UPDATE members SET pin = '0000' WHERE id = 1");
        $this->assertNotSame($now, self::read($store)['revision']);
    }
}
