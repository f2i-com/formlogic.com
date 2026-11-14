<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * What an app's backend was asked lately, for its owner (the API section of the app's page): one
 * row a call, written as the call is answered (NativeAppController::runtime). It says when the
 * call came, its method and route, the status it was answered with, how long that took, the first
 * words of the error where it failed, and who called: the owner, a member or a visitor. Never a
 * body, a query, a header or an address.
 *
 * A route's path is matched exactly (SoftN's hosts have no parameters in a path), so the path of a
 * call that reached a route is that route's own. A call to a path no route has is written as it
 * was sent, with the 404 it got, when the owner made it; from anyone else, without the path (an
 * empty one), since anyone can send any words there (NativeAppController::recordCall).
 *
 * Where a call failed, the first words of the error the app's own code answered with are kept as
 * it answered them, and an app's code can repeat in an error what the call sent: the page says so.
 *
 * Each app keeps its newest KEEP calls of the last DAYS days. A call is written alone, and the
 * app's record is trimmed now and then (one call in TRIM_EVERY, by chance), so it holds about
 * TRIM_EVERY more than it shows; what is older, of an app nobody calls any more, goes at the
 * nightly sweep (bin/privacy-sweep.php), and is never shown before then. Writing is best effort: a
 * call is answered whether or not it could be written down, and a failure to write says so in the
 * log, never to the caller.
 */
class NativeAppCalls
{
    public const KEEP = 500;
    public const DAYS = 14;
    /** One call in this many, by chance, trims its app's record after it is written. */
    public const TRIM_EVERY = 25;
    /**
     * The longest a call's write waits for a lock (MySQL's own default is 50 s). A call names its app,
     * so its write waits while anything holds the app's row (a publish, a change of its settings): that
     * is short, and a write that would wait longer is given up and said in the log.
     */
    public const LOCK_WAIT_SECONDS = 2;
    /** The longest error and path kept, in characters (the columns are as long). */
    public const ERROR_LENGTH = 200;
    public const PATH_LENGTH = 200;
    public const CALLERS = ['owner', 'member', 'visitor'];
    public const METHODS = ['GET', 'POST', 'PUT', 'DELETE'];
    /** The sweep removes this many rows a statement, so no one statement holds the table long. */
    private const SWEEP_BATCH = 5000;

    /** $trimEvery: TRIM_EVERY, or 1 to trim after every call (the tests'). */
    public function __construct(private MySQLConnection $mysql, private int $trimEvery = self::TRIM_EVERY) {}

    /**
     * Write one call down. Never throws: false when it could not be written (the log says why).
     * $at is when the call came (now where not given: a call written after its answer would
     * otherwise read as coming late). $error is kept only for a failure (status 400 and over, or 0
     * for a call that was never answered), on one line and cut to ERROR_LENGTH characters. An empty
     * $path is a call to an address the app does not have, made by someone other than its owner
     * (NativeAppController).
     *
     * The call is one statement of its own, committed at once, so nothing it locks outlives it; a
     * trim, one call in $trimEvery by chance, is another (trim). By chance, not by the call's id: a
     * host's ids can step by more than one (ClearDB's by 10, a Galera cluster's by its size), and an
     * id that is never a multiple of 25 never trimmed. A transaction someone else left open on the
     * connection is theirs to end: the call is written inside it, and no trim runs there. Both wait
     * at most LOCK_WAIT_SECONDS for a lock.
     */
    public function record(string $appId, string $method, string $path, int $status, int $milliseconds, ?string $error, string $caller, ?\DateTimeImmutable $at = null): bool
    {
        if ($appId === '' || !in_array($method, self::METHODS, true) || !in_array($caller, self::CALLERS, true)) return false;
        $pdo = null;
        $bounded = false;
        try {
            $pdo = $this->mysql->getConnection();
            $utc = new \DateTimeZone('UTC');
            $now = new \DateTimeImmutable('now', $utc);
            $came = ($at ?? $now)->setTimezone($utc);
            $pdo->exec('SET SESSION innodb_lock_wait_timeout = ' . self::LOCK_WAIT_SECONDS);
            $bounded = true;
            $pdo->prepare('INSERT INTO native_app_calls (app_id, called_at, method, path, status, ms, error, caller) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')->execute([
                $appId, $came->format('Y-m-d H:i:s.v'), $method, mb_substr(self::oneLine($path), 0, self::PATH_LENGTH),
                max(0, min(65535, $status)), max(0, min(4294967295, $milliseconds)), $status >= 400 || $status === 0 ? self::shortError($error) : null, $caller,
            ]);
            if (!$pdo->inTransaction() && ($this->trimEvery <= 1 || random_int(1, $this->trimEvery) === 1)) {
                try {
                    $this->trim($pdo, $appId, $now);
                } catch (\Throwable $e) {
                    // The call is written; the next trim of this app takes what this one did not.
                    error_log('App calls not trimmed for app ' . $appId . ': ' . get_class($e) . ' ' . $e->getMessage());
                }
            }
            return true;
        } catch (\Throwable $e) {
            error_log('App call not recorded for app ' . $appId . ': ' . get_class($e) . ' ' . $e->getMessage());
            return false;
        } finally {
            // The connection is the request's: what else it runs waits as long as it always has.
            if ($bounded && $pdo !== null) {
                try { $pdo->exec('SET SESSION innodb_lock_wait_timeout = DEFAULT'); } catch (\Throwable) { /* the connection is gone */ }
            }
        }
    }

    /**
     * The app's newest calls of the last DAYS days, newest first by when each came, at most $limit
     * (1 to KEEP). Throws when the record cannot be read: a read that failed is not "no calls yet".
     *
     * @return list<array{id: int, at: string, method: string, path: string, status: int, ms: int, error: ?string, caller: string}>
     */
    public function recent(string $appId, int $limit = 50): array
    {
        $limit = max(1, min(self::KEEP, $limit));
        $since = (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->modify('-' . self::DAYS . ' days')->format('Y-m-d H:i:s.v');
        // (by when each came: a long call is written after shorter ones that came after it)
        $statement = $this->mysql->getConnection()->prepare(
            'SELECT id, called_at, method, path, status, ms, error, caller FROM native_app_calls WHERE app_id = ? AND called_at >= ? ORDER BY called_at DESC, id DESC LIMIT ' . $limit
        );
        $statement->execute([$appId, $since]);
        $calls = [];
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $calls[] = [
                'id' => (int) $row['id'],
                'at' => (new \DateTimeImmutable((string) $row['called_at'], new \DateTimeZone('UTC')))->format(DATE_RFC3339_EXTENDED),
                'method' => (string) $row['method'],
                'path' => (string) $row['path'],
                'status' => (int) $row['status'],
                'ms' => (int) $row['ms'],
                'error' => $row['error'] === null ? null : (string) $row['error'],
                'caller' => (string) $row['caller'],
            ];
        }
        return $calls;
    }

    /** Every app's calls older than DAYS days, removed: what the nightly sweep does. The number removed. */
    public function sweep(): int
    {
        $old = (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->modify('-' . self::DAYS . ' days')->format('Y-m-d H:i:s.v');
        $statement = $this->mysql->getConnection()->prepare('DELETE FROM native_app_calls WHERE called_at < ? LIMIT ' . self::SWEEP_BATCH);
        $removed = 0;
        do {
            $statement->execute([$old]);
            $removed += $count = $statement->rowCount();
        } while ($count === self::SWEEP_BATCH);
        return $removed;
    }

    /**
     * The first words of what a failed call said: its `error`, or its `message` (an `error` that is
     * itself an object is read for its `message`), or the answer itself where it is text. On one
     * line, at most ERROR_LENGTH characters; null when it said nothing.
     */
    public static function errorOf(mixed $body): ?string
    {
        if (is_string($body)) return self::shortError($body);
        $read = static fn (mixed $value, string $key): mixed => is_array($value) ? ($value[$key] ?? null) : (is_object($value) ? ($value->{$key} ?? null) : null);
        $error = $read($body, 'error');
        if (!is_string($error)) $error = $read($error, 'message');
        if (!is_string($error)) $error = $read($body, 'message');
        return is_string($error) ? self::shortError($error) : null;
    }

    /** $text on one line, valid UTF-8, cut to ERROR_LENGTH characters (the last one an ellipsis when cut); null when nothing is left. */
    public static function shortError(?string $text): ?string
    {
        if ($text === null) return null;
        $line = self::oneLine($text);
        if ($line === '') return null;
        return mb_strlen($line) > self::ERROR_LENGTH ? rtrim(mb_substr($line, 0, self::ERROR_LENGTH - 1)) . '…' : $line;
    }

    private static function oneLine(string $text): string
    {
        $valid = mb_check_encoding($text, 'UTF-8') ? $text : (string) mb_convert_encoding($text, 'UTF-8', 'UTF-8');
        return trim((string) preg_replace('/[\s\p{Cc}]+/u', ' ', $valid));
    }

    /**
     * Keep the app's newest KEEP calls of the last DAYS days. One read (which locks nothing) finds
     * the newest call past either edge by its id (the one after the newest KEEP, and the newest
     * older than DAYS days), and one delete takes it and every call before it, a range at the start
     * of the app's own calls (idx_native_app_calls_app); nothing is deleted while there is nothing to.
     *
     * It runs as a statement of its own, after the call that set it off is committed, and holds no
     * other lock while it waits: a delete may wait for a call another request is writing, which never
     * waits for it. Written in one transaction with the call, two calls of a quiet app at once
     * deadlocked (each delete waited for the row the other had just written), and the call that lost
     * was not written down.
     */
    private function trim(PDO $pdo, string $appId, \DateTimeImmutable $now): void
    {
        $old = $now->modify('-' . self::DAYS . ' days')->format('Y-m-d H:i:s.v');
        $edges = $pdo->prepare('SELECT (SELECT id FROM native_app_calls WHERE app_id = ? ORDER BY id DESC LIMIT 1 OFFSET ' . self::KEEP . ') AS past_kept, '
            . '(SELECT id FROM native_app_calls WHERE app_id = ? AND called_at < ? ORDER BY id DESC LIMIT 1) AS past_days');
        $edges->execute([$appId, $appId, $old]);
        $found = $edges->fetch(PDO::FETCH_ASSOC) ?: [];
        $cut = max((int) ($found['past_kept'] ?? 0), (int) ($found['past_days'] ?? 0));
        if ($cut > 0) {
            $pdo->prepare('DELETE FROM native_app_calls WHERE app_id = ? AND id <= ?')->execute([$appId, $cut]);
        }
    }
}
