<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Database\SqliteSnapshot;
use FormLogic\Database\SqliteSnapshotException;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Audit FL-01 regression: "checkpoint then copy the main file" is not a
 * consistent snapshot, and the replacement helper must be.
 *
 * The first test reproduces the audit's isolated SQLite experiment inside PHP:
 * one committed row lives only in the WAL while another connection holds an
 * older read snapshot; PRAGMA wal_checkpoint(FULL) reports busy and copies
 * nothing; a raw copy of the main file passes integrity_check yet is MISSING
 * the committed row. Both snapshot strategies must contain it.
 */
final class SqliteSnapshotTest extends TestCase
{
    private string $dir;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/fl-snapshot-' . bin2hex(random_bytes(6));
        mkdir($this->dir, 0700, true);
    }

    protected function tearDown(): void
    {
        foreach (glob($this->dir . '/*') ?: [] as $f) {
            @unlink($f);
        }
        foreach (glob($this->dir . '/.*') ?: [] as $f) {
            if (is_file($f)) {
                @unlink($f);
            }
        }
        @rmdir($this->dir);
    }

    /** @return array{0: PDO, 1: string} writer connection + path, WAL mode, one checkpointed row */
    private function seedWalDatabase(): array
    {
        $path = $this->dir . '/live.sqlite';
        $writer = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $writer->exec('PRAGMA journal_mode = WAL');
        $writer->exec('PRAGMA busy_timeout = 1000');
        $writer->exec('CREATE TABLE responses (id INTEGER PRIMARY KEY, answers TEXT NOT NULL)');
        $writer->exec("INSERT INTO responses (id, answers) VALUES (1, 'first')");
        $writer->exec('PRAGMA wal_checkpoint(TRUNCATE)');
        return [$writer, $path];
    }

    /** @return list<int> */
    private function ids(string $path): array
    {
        $pdo = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        return array_map('intval', $pdo->query('SELECT id FROM responses ORDER BY id')->fetchAll(PDO::FETCH_COLUMN));
    }

    /** @return list<string> the methods this PHP build can exercise */
    public static function methods(): array
    {
        $methods = [[SqliteSnapshot::METHOD_VACUUM_INTO]];
        if (class_exists(\SQLite3::class)) {
            $methods[] = [SqliteSnapshot::METHOD_BACKUP_API];
        }
        return $methods;
    }

    /** @dataProvider methods */
    public function testCommittedWalRowSurvivesWhileAnOldReaderBlocksTheCheckpoint(string $method): void
    {
        [$writer, $path] = $this->seedWalDatabase();

        // An older reader pins the WAL: its read transaction started before row 2.
        $reader = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $reader->exec('BEGIN');
        self::assertSame([1], array_map('intval', $reader->query('SELECT id FROM responses')->fetchAll(PDO::FETCH_COLUMN)));

        $writer->exec("INSERT INTO responses (id, answers) VALUES (2, 'committed-only-in-wal')");
        self::assertSame([1, 2], $this->ids($path), 'a fresh connection sees both committed rows');

        // ── the OLD behaviour, reproduced ────────────────────────────────────
        $checkpoint = $writer->query('PRAGMA wal_checkpoint(FULL)')->fetch(PDO::FETCH_NUM);
        self::assertSame(1, (int) $checkpoint[0], 'checkpoint reports busy while the old reader holds its snapshot');
        self::assertLessThan((int) $checkpoint[1], (int) $checkpoint[2], 'not every WAL frame was checkpointed');

        $rawCopy = $this->dir . '/raw-copy.sqlite';
        self::assertTrue(copy($path, $rawCopy));
        $raw = new PDO('sqlite:' . $rawCopy, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        self::assertSame('ok', $raw->query('PRAGMA integrity_check')->fetchColumn(), 'the raw copy LOOKS healthy…');
        self::assertSame([1], array_map('intval', $raw->query('SELECT id FROM responses ORDER BY id')->fetchAll(PDO::FETCH_COLUMN)), '…but silently lost the committed row');
        $raw = null;

        // ── the new helper ───────────────────────────────────────────────────
        $snapshotter = new SqliteSnapshot(1000, 2, $method);
        $dest = $this->dir . '/snapshot-' . $method . '.sqlite';
        $meta = $snapshotter->snapshot($path, $dest, ['responses']);

        self::assertSame([1, 2], $this->ids($dest), 'the snapshot contains the row that was only in the WAL');
        self::assertSame($method, $meta['method']);
        self::assertSame(SqliteSnapshot::CONSISTENCY_SNAPSHOT, $meta['consistency']);
        self::assertSame('ok', $meta['quickCheck']);
        self::assertSame(hash_file('sha256', $dest), $meta['sha256']);
        self::assertGreaterThan(0, $meta['pageCount']);
        self::assertFileDoesNotExist($dest . '.partial');
        self::assertFileDoesNotExist($dest . '-wal');
        self::assertFileDoesNotExist($dest . '-shm');
        $copy = new PDO('sqlite:' . $dest);
        self::assertSame('delete', strtolower((string) $copy->query('PRAGMA journal_mode')->fetchColumn()), 'self-contained single file');
        $copy = null;

        // The live database and its reader were not disturbed.
        self::assertSame([1], array_map('intval', $reader->query('SELECT id FROM responses')->fetchAll(PDO::FETCH_COLUMN)));
        $reader->exec('COMMIT');
        self::assertSame([1, 2], $this->ids($path));
    }

    /** @dataProvider methods */
    public function testFailureLeavesNoPartialFilesAndNoDestination(string $method): void
    {
        [, $path] = $this->seedWalDatabase();
        $snapshotter = new SqliteSnapshot(300, 1, $method);

        // Required table missing → verification failure AFTER the copy was written.
        $dest = $this->dir . '/verify-fail.sqlite';
        try {
            $snapshotter->snapshot($path, $dest, ['responses', 'does_not_exist']);
            self::fail('expected a verification failure');
        } catch (SqliteSnapshotException $e) {
            self::assertStringContainsString("missing the 'does_not_exist' table", $e->getMessage());
        }
        self::assertFileDoesNotExist($dest);
        self::assertFileDoesNotExist($dest . '.partial');
        self::assertSame([], glob($this->dir . '/verify-fail*') ?: [], 'no partial or journal files left behind');

        // Unwritable destination directory → refused up front.
        try {
            $snapshotter->snapshot($path, $this->dir . '/missing-dir/x.sqlite');
            self::fail('expected a directory failure');
        } catch (SqliteSnapshotException $e) {
            self::assertStringContainsString('not writable', $e->getMessage());
        }

        // Existing destination is never overwritten.
        file_put_contents($this->dir . '/exists.sqlite', 'keep me');
        try {
            $snapshotter->snapshot($path, $this->dir . '/exists.sqlite');
            self::fail('expected an overwrite refusal');
        } catch (SqliteSnapshotException $e) {
            self::assertStringContainsString('already exists', $e->getMessage());
        }
        self::assertSame('keep me', file_get_contents($this->dir . '/exists.sqlite'));

        // Missing source.
        $this->expectException(SqliteSnapshotException::class);
        $snapshotter->snapshot($this->dir . '/nope.sqlite', $this->dir . '/nope-copy.sqlite');
    }

    /** @dataProvider methods */
    public function testSnapshotMatchesOneBoundaryUnderConcurrentWrites(string $method): void
    {
        [$writer, $path] = $this->seedWalDatabase();
        for ($i = 2; $i <= 200; $i++) {
            $writer->exec("INSERT INTO responses (id, answers) VALUES ({$i}, 'row {$i}')");
        }
        $writer->exec('UPDATE responses SET answers = \'updated\' WHERE id % 7 = 0');
        $writer->exec('DELETE FROM responses WHERE id % 13 = 0');
        $expected = $this->ids($path);

        $snapshotter = new SqliteSnapshot(1000, 2, $method);
        $dest = $this->dir . '/boundary-' . $method . '.sqlite';
        $snapshotter->snapshot($path, $dest, ['responses']);

        // More writes AFTER the boundary must not appear; everything before must.
        $writer->exec("INSERT INTO responses (id, answers) VALUES (999, 'after boundary')");
        self::assertSame($expected, $this->ids($dest));
        $copy = new PDO('sqlite:' . $dest, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        self::assertSame('updated', $copy->query('SELECT answers FROM responses WHERE id = 14')->fetchColumn());
        self::assertSame('ok', $copy->query('PRAGMA integrity_check')->fetchColumn());
    }

    public function testMethodSelectionPrefersTheOnlineBackupApiWhenAvailable(): void
    {
        $auto = new SqliteSnapshot();
        if (class_exists(\SQLite3::class)) {
            self::assertSame(SqliteSnapshot::METHOD_BACKUP_API, $auto->method());
        } else {
            self::assertSame(SqliteSnapshot::METHOD_VACUUM_INTO, $auto->method());
        }
        self::assertSame(SqliteSnapshot::METHOD_VACUUM_INTO, (new SqliteSnapshot(100, 1, SqliteSnapshot::METHOD_VACUUM_INTO))->method());
    }
}
