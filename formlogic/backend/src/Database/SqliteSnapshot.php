<?php

declare(strict_types=1);

namespace FormLogic\Database;

use PDO;

/**
 * Consistent, self-contained snapshots of live SQLite databases (audit FL-01).
 *
 * WHY THIS EXISTS: "PRAGMA wal_checkpoint(FULL) then copy the main file" is not
 * a snapshot. A checkpoint is BEST-EFFORT — while any other connection holds an
 * older read transaction the checkpointer cannot move frames past that reader's
 * mark, returns (busy=1, log=N, checkpointed<N) and the caller happily copies a
 * main file that is missing committed rows still sitting in the WAL. The copy
 * passes PRAGMA integrity_check and hashes fine: it is a valid database that is
 * simply incomplete. See tests/Unit/SqliteSnapshotTest.php, which reproduces
 * that exact failure and proves this helper does not share it.
 *
 * HOW: the SQLite online backup API (SQLite3::backup, one read transaction over
 * the source for the whole copy, WAL included) when the sqlite3 extension is
 * loaded, otherwise `VACUUM INTO` through PDO (also a single consistent read
 * snapshot; SQLite >= 3.27). Neither method ever copies the WAL and the main
 * file as two separate files.
 *
 * CONTRACT
 *  - The copy is written to a private `.partial` file next to the destination,
 *    reopened, verified (`PRAGMA quick_check` = ok, expected tables present),
 *    normalised to rollback-journal mode so it is ONE self-contained file, then
 *    atomically renamed into place. Any failure removes the partial file and its
 *    journals and throws — a failed snapshot can never become a "successful"
 *    export.
 *  - Busy handling is bounded: a busy timeout on the source plus a small number
 *    of attempts with backoff. Persistent contention is an error, not a retry
 *    forever and not a silent fallback to a file copy.
 *  - The returned metadata records the method, the time the copy completed
 *    (the snapshot boundary), the verification result and the sha256 of the
 *    final file SEPARATELY, because a hash proves which bytes were archived, not
 *    that they form a complete logical snapshot.
 *
 * SCOPE: consistency is PER DATABASE. An account backup snapshots many SQLite
 * files plus MySQL metadata; each file is a consistent point-in-time copy, but
 * the set is not one global transaction across MySQL and every SQLite file.
 * Callers document that boundary rather than pretending otherwise.
 */
final class SqliteSnapshot
{
    public const METHOD_BACKUP_API = 'sqlite3-online-backup';
    public const METHOD_VACUUM_INTO = 'vacuum-into';

    /** Marker recorded beside checksums: the copy came from one read transaction. */
    public const CONSISTENCY_SNAPSHOT = 'single-read-transaction';

    /**
     * @param int $busyTimeoutMs how long each attempt waits for locks on the source
     * @param int $maxAttempts   bounded retry count for SQLITE_BUSY/LOCKED
     * @param string|null $preferredMethod force METHOD_* (tests); null = auto
     */
    public function __construct(
        private int $busyTimeoutMs = 5000,
        private int $maxAttempts = 3,
        private ?string $preferredMethod = null,
    ) {
        $this->busyTimeoutMs = max(100, $busyTimeoutMs);
        $this->maxAttempts = max(1, $maxAttempts);
    }

    /** The method this PHP build will use. */
    public function method(): string
    {
        if ($this->preferredMethod !== null) {
            return $this->preferredMethod;
        }
        return class_exists(\SQLite3::class) ? self::METHOD_BACKUP_API : self::METHOD_VACUUM_INTO;
    }

    /**
     * Snapshot $sourcePath into $destinationPath (which must not exist yet).
     *
     * @param list<string> $requiredTables tables that must exist in the verified copy
     * @return array{
     *   path: string, method: string, startedAt: string, completedAt: string,
     *   consistency: string, quickCheck: string, pageCount: int, pageSize: int,
     *   sizeBytes: int, sha256: string, attempts: int
     * }
     * @throws SqliteSnapshotException on any failure (partial files are removed)
     */
    public function snapshot(string $sourcePath, string $destinationPath, array $requiredTables = []): array
    {
        if (!is_file($sourcePath)) {
            throw new SqliteSnapshotException("Source database does not exist: {$sourcePath}");
        }
        if (file_exists($destinationPath)) {
            throw new SqliteSnapshotException("Snapshot destination already exists: {$destinationPath}");
        }
        $dir = dirname($destinationPath);
        if (!is_dir($dir) || !is_writable($dir)) {
            throw new SqliteSnapshotException("Snapshot directory is not writable: {$dir}");
        }

        $partial = $destinationPath . '.partial';
        $this->removeSnapshotFiles($partial);

        $startedAt = gmdate('c');
        $attempts = 0;
        $lastError = null;
        $method = $this->method();

        try {
            while ($attempts < $this->maxAttempts) {
                $attempts++;
                try {
                    if ($method === self::METHOD_BACKUP_API) {
                        $this->copyWithBackupApi($sourcePath, $partial);
                    } else {
                        $this->copyWithVacuumInto($sourcePath, $partial);
                    }
                    $lastError = null;
                    break;
                } catch (\Throwable $e) {
                    $lastError = $e;
                    $this->removeSnapshotFiles($partial);
                    if (!$this->isBusy($e) || $attempts >= $this->maxAttempts) {
                        break;
                    }
                    // Bounded backoff before the next attempt (100ms, 200ms, ...).
                    usleep(100000 * $attempts);
                }
            }
            if ($lastError !== null) {
                throw new SqliteSnapshotException(
                    'SQLite snapshot failed after ' . $attempts . ' attempt(s): ' . $lastError->getMessage(),
                    0,
                    $lastError
                );
            }
            $completedAt = gmdate('c');

            // Verify by reopening the CLOSED copy — never trust the writer's own handle.
            $verified = $this->verifyAndNormalise($partial, $requiredTables);

            if (!rename($partial, $destinationPath)) {
                throw new SqliteSnapshotException('Could not publish the verified snapshot');
            }
            $this->syncFile($destinationPath);
            clearstatcache(true, $destinationPath);

            return [
                'path' => $destinationPath,
                'method' => $method,
                'startedAt' => $startedAt,
                'completedAt' => $completedAt,
                'consistency' => self::CONSISTENCY_SNAPSHOT,
                'quickCheck' => $verified['quickCheck'],
                'pageCount' => $verified['pageCount'],
                'pageSize' => $verified['pageSize'],
                'sizeBytes' => (int) filesize($destinationPath),
                'sha256' => (string) hash_file('sha256', $destinationPath),
                'attempts' => $attempts,
            ];
        } catch (\Throwable $e) {
            $this->removeSnapshotFiles($partial);
            $this->removeSnapshotFiles($destinationPath);
            if ($e instanceof SqliteSnapshotException) {
                throw $e;
            }
            throw new SqliteSnapshotException('SQLite snapshot failed: ' . $e->getMessage(), 0, $e);
        }
    }

    // ── copy strategies ───────────────────────────────────────────────────────

    private function copyWithBackupApi(string $source, string $partial): void
    {
        if (!class_exists(\SQLite3::class)) {
            throw new SqliteSnapshotException('The sqlite3 extension is not loaded');
        }
        // READWRITE (no CREATE): a WAL database needs its -shm; the backup only reads.
        $src = new \SQLite3($source, SQLITE3_OPEN_READWRITE);
        $dst = null;
        try {
            $src->enableExceptions(true);
            $src->busyTimeout($this->busyTimeoutMs);
            $dst = new \SQLite3($partial, SQLITE3_OPEN_READWRITE | SQLITE3_OPEN_CREATE);
            $dst->enableExceptions(true);
            $dst->busyTimeout($this->busyTimeoutMs);
            // One backup step of -1 pages = the whole database inside ONE read
            // transaction on the source; committed WAL frames are included.
            if (!$src->backup($dst)) {
                throw new SqliteSnapshotException('SQLite3::backup reported failure');
            }
        } finally {
            if ($dst !== null) {
                $dst->close();
            }
            $src->close();
        }
    }

    private function copyWithVacuumInto(string $source, string $partial): void
    {
        $pdo = new PDO('sqlite:' . $source, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        try {
            $version = (string) $pdo->query('SELECT sqlite_version()')->fetchColumn();
            if (version_compare($version, '3.27.0', '<')) {
                throw new SqliteSnapshotException("VACUUM INTO requires SQLite >= 3.27 (have {$version})");
            }
            $pdo->exec('PRAGMA busy_timeout = ' . $this->busyTimeoutMs);
            // VACUUM INTO runs inside one read transaction on the source.
            $pdo->exec('VACUUM INTO ' . $pdo->quote($partial));
        } finally {
            $pdo = null;
        }
    }

    // ── verification ─────────────────────────────────────────────────────────

    /** @return array{quickCheck:string, pageCount:int, pageSize:int} */
    private function verifyAndNormalise(string $partial, array $requiredTables): array
    {
        clearstatcache(true, $partial);
        if (!is_file($partial) || (int) filesize($partial) === 0) {
            throw new SqliteSnapshotException('Snapshot produced no data');
        }
        // The copy carries the source's WAL header flag. Make it a single
        // self-contained file: no -wal/-shm sidecars can be "forgotten" later.
        $rows = $this->readRows($partial, [
            'mode' => 'PRAGMA journal_mode = DELETE',
            'check' => 'PRAGMA quick_check',
            'tables' => "SELECT name FROM sqlite_master WHERE type = 'table'",
            'pageCount' => 'PRAGMA page_count',
            'pageSize' => 'PRAGMA page_size',
        ]);
        $mode = strtolower((string) ($rows['mode'][0] ?? ''));
        if ($mode !== 'delete') {
            throw new SqliteSnapshotException("Could not normalise snapshot journal mode (got '{$mode}')");
        }
        $check = (string) ($rows['check'][0] ?? 'missing');
        if ($check !== 'ok') {
            throw new SqliteSnapshotException("Snapshot failed verification: {$check}");
        }
        foreach ($requiredTables as $table) {
            if (!in_array($table, $rows['tables'], true)) {
                throw new SqliteSnapshotException("Snapshot is missing the '{$table}' table");
            }
        }
        clearstatcache();
        foreach (['-wal', '-shm', '-journal'] as $suffix) {
            if (file_exists($partial . $suffix)) {
                throw new SqliteSnapshotException('Snapshot left a journal sidecar behind: ' . basename($partial . $suffix));
            }
        }
        return [
            'quickCheck' => $check,
            'pageCount' => (int) ($rows['pageCount'][0] ?? 0),
            'pageSize' => (int) ($rows['pageSize'][0] ?? 0),
        ];
    }

    /** `PRAGMA quick_check` of a closed database file through an explicitly-closed handle. */
    public function quickCheck(string $path): string
    {
        try {
            return (string) ($this->readRows($path, ['check' => 'PRAGMA quick_check'])['check'][0] ?? 'missing');
        } catch (SqliteSnapshotException $e) {
            return 'error: ' . $e->getMessage();
        }
    }

    /**
     * Number of rows in $table of a closed snapshot (0 when the table is absent).
     * Reads through the same explicitly-closed handle path as verification.
     */
    public function countRows(string $path, string $table): int
    {
        if (!preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $table)) {
            throw new SqliteSnapshotException("Invalid table name: {$table}");
        }
        $rows = $this->readRows($path, [
            'exists' => "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '{$table}'",
        ]);
        if ((int) ($rows['exists'][0] ?? 0) === 0) {
            return 0;
        }
        $rows = $this->readRows($path, ['count' => "SELECT COUNT(*) FROM \"{$table}\""]);
        return (int) ($rows['count'][0] ?? 0);
    }

    /**
     * Run single-column read statements against a database and return the first
     * column of every row, keyed like $statements. The handle is closed
     * EXPLICITLY before this returns or throws: on PHP for Windows a PDO handle
     * that is merely dereferenced while an exception is in flight stays open and
     * pins the file, which would defeat partial-file cleanup. SQLite3::close()
     * releases deterministically, so it is preferred whenever the extension is
     * loaded.
     *
     * @param array<string,string> $statements
     * @return array<string,list<string>>
     */
    private function readRows(string $path, array $statements): array
    {
        $out = [];
        if (class_exists(\SQLite3::class)) {
            $db = new \SQLite3($path, SQLITE3_OPEN_READWRITE);
            $error = null;
            try {
                $db->enableExceptions(true);
                $db->busyTimeout($this->busyTimeoutMs);
                foreach ($statements as $key => $sql) {
                    $out[$key] = [];
                    $result = $db->query($sql);
                    if ($result === false) {
                        throw new SqliteSnapshotException('Snapshot query failed: ' . $sql);
                    }
                    while (($row = $result->fetchArray(SQLITE3_NUM)) !== false) {
                        $out[$key][] = (string) $row[0];
                    }
                    $result->finalize();
                }
            } catch (\Throwable $e) {
                $error = $e;
            } finally {
                $db->close();
            }
            if ($error !== null) {
                throw $error instanceof SqliteSnapshotException ? $error : new SqliteSnapshotException($error->getMessage(), 0, $error);
            }
            return $out;
        }

        $pdo = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $error = null;
        try {
            $pdo->exec('PRAGMA busy_timeout = ' . $this->busyTimeoutMs);
            foreach ($statements as $key => $sql) {
                $out[$key] = array_map('strval', $pdo->query($sql)->fetchAll(PDO::FETCH_COLUMN));
            }
        } catch (\Throwable $e) {
            $error = $e;
        }
        $pdo = null;
        if ($error !== null) {
            throw new SqliteSnapshotException($error->getMessage(), 0, $error);
        }
        return $out;
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    private function isBusy(\Throwable $e): bool
    {
        $m = strtolower($e->getMessage());
        return str_contains($m, 'busy') || str_contains($m, 'locked');
    }

    private function removeSnapshotFiles(string $base): void
    {
        foreach (['', '-wal', '-shm', '-journal'] as $suffix) {
            if (file_exists($base . $suffix)) {
                @unlink($base . $suffix);
            }
        }
    }

    private function syncFile(string $path): void
    {
        $h = @fopen($path, 'rb');
        if ($h === false) {
            return;
        }
        if (function_exists('fsync')) {
            @fsync($h);
        }
        fclose($h);
    }
}
