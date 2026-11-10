<?php

declare(strict_types=1);

namespace FormLogic\Services;

use PDO;
use Throwable;

/**
 * Shared, persistent rate limiter backed by the `rate_limits` MySQL table.
 *
 * Uses a fixed-window counter keyed by sha256(key) + window bucket. Unlike
 * per-process in-memory counters, this survives across requests and worker
 * processes, so throttling actually works under mod_php / php-fpm.
 *
 * Storage errors (e.g. the table not yet migrated) surface as hit() returning
 * UNAVAILABLE (0 — a real increment always returns >= 1). What that means is
 * the CALLER's risk policy (audit RATE-001): low-risk endpoints degrade open
 * so a missing migration doesn't brick the site, while high-risk actions
 * (login, password reset, MFA verify, credential management) fail CLOSED —
 * an outage must not open an unlimited brute-force window.
 */
class RateLimiter
{
    /** hit()/count() sentinel: the store failed; no counting happened. */
    public const UNAVAILABLE = 0;

    public function __construct(private PDO $pdo)
    {
    }

    /**
     * Live health probe exercising the REAL write path (deep-health/Doctor):
     * a failing limiter means high-risk auth endpoints are refusing (they
     * fail closed), so operations needs to see it immediately.
     */
    public function healthy(): bool
    {
        return $this->hit('rate_limiter_health_probe', 60) !== self::UNAVAILABLE;
    }

    /** Current hit count for the key within the active window (no increment). */
    public function count(string $key, int $windowSeconds): int
    {
        try {
            $stmt = $this->pdo->prepare(
                'SELECT hits FROM rate_limits WHERE bucket = :b AND window_start = :w'
            );
            $stmt->execute(['b' => $this->bucket($key), 'w' => $this->windowStart($windowSeconds)]);
            return (int) ($stmt->fetchColumn() ?: 0);
        } catch (Throwable $e) {
            error_log('RateLimiter::count failed (failing open): ' . $e->getMessage());
            return 0;
        }
    }

    /** Atomically increment the key's counter for the active window; returns the new count. */
    public function hit(string $key, int $windowSeconds): int
    {
        $bucket = $this->bucket($key);
        $window = $this->windowStart($windowSeconds);
        try {
            $stmt = $this->pdo->prepare(
                'INSERT INTO rate_limits (bucket, window_start, hits) VALUES (:b, :w, 1)
                 ON DUPLICATE KEY UPDATE hits = hits + 1'
            );
            $stmt->execute(['b' => $bucket, 'w' => $window]);
            $this->maybeGc();
            $sel = $this->pdo->prepare('SELECT hits FROM rate_limits WHERE bucket = :b AND window_start = :w');
            $sel->execute(['b' => $bucket, 'w' => $window]);
            return (int) ($sel->fetchColumn() ?: 1);
        } catch (Throwable $e) {
            error_log('RateLimiter::hit failed (failing open): ' . $e->getMessage());
            return 0;
        }
    }

    /**
     * A token bucket: $capacity calls at once, refilled evenly at $capacity every $perSeconds. One
     * call takes one token. Past the burst a caller is slowed to the sustained rate ($capacity a
     * $perSeconds, the same as a fixed window of that size allows), where a fixed window refuses
     * everything until it ends: a refused call is told how long until the next token, a second or
     * two, not the rest of the minute.
     *
     * Kept as one number a key in `rate_buckets`: the moment the bucket would next be full of
     * debt, as the generic cell rate algorithm has it (its "theoretical arrival time"). One
     * statement decides and takes, so calls at once cannot both take the last token.
     *
     * @return array{allowed: bool, retryAfter: int, remaining: int}|null null: the store failed (the
     *         caller's risk policy decides, as for hit()'s UNAVAILABLE)
     */
    public function take(string $key, int $capacity, int $perSeconds, ?float $now = null): ?array
    {
        $capacity = max(1, $capacity);
        // Milliseconds a token takes to come back, and how far ahead of now the bucket may be owed.
        $interval = max(1, (int) round(max(1, $perSeconds) * 1000 / $capacity));
        $tolerance = ($capacity - 1) * $interval;
        $nowMs = (int) floor(($now ?? microtime(true)) * 1000);
        $bucket = $this->bucket('tb:' . $key);
        try {
            // Taken when the debt (tat - now) is within the tolerance: the row moves on by one
            // token's interval. Refused: the row is set to its own value, which MySQL counts as no
            // row changed (0), where a new row counts 1 and a changed one 2.
            $take = $this->pdo->prepare(
                'INSERT INTO rate_buckets (bucket, tat_ms) VALUES (:b, :first)
                 ON DUPLICATE KEY UPDATE tat_ms = IF(GREATEST(tat_ms, :n1) - :n2 > :tolerance, tat_ms, GREATEST(tat_ms, :n3) + :interval)'
            );
            for ($try = 1; ; $try++) {
                try {
                    $take->execute(['b' => $bucket, 'first' => $nowMs + $interval, 'n1' => $nowMs, 'n2' => $nowMs, 'n3' => $nowMs, 'tolerance' => $tolerance, 'interval' => $interval]);
                    break;
                } catch (\PDOException $e) {
                    // Workers making a key's first row at once can be told to try again (a deadlock,
                    // or a lock waited for too long): nothing was taken, so they do.
                    if ($try >= 4 || !in_array((int) ($e->errorInfo[1] ?? 0), [1213, 1205], true)) throw $e;
                    usleep(random_int(2000, 15000));
                }
            }
            $allowed = $take->rowCount() > 0;
            $read = $this->pdo->prepare('SELECT tat_ms FROM rate_buckets WHERE bucket = :b');
            $read->execute(['b' => $bucket]);
            $debt = max(0, (int) $read->fetchColumn() - $nowMs);
            $this->maybeGc();
            if ($allowed) {
                return ['allowed' => true, 'retryAfter' => 0, 'remaining' => max(0, intdiv($tolerance + $interval - $debt, $interval))];
            }
            // Until the debt is back within the tolerance: the next token.
            return ['allowed' => false, 'retryAfter' => max(1, (int) ceil(($debt - $tolerance) / 1000)), 'remaining' => 0];
        } catch (Throwable $e) {
            error_log('RateLimiter::take failed: ' . $e->getMessage());
            return null;
        }
    }

    /** Remove all counters for a key (e.g. on successful login). */
    public function clear(string $key): void
    {
        try {
            $stmt = $this->pdo->prepare('DELETE FROM rate_limits WHERE bucket = :b');
            $stmt->execute(['b' => $this->bucket($key)]);
            $stmt = $this->pdo->prepare('DELETE FROM rate_buckets WHERE bucket = :b');
            $stmt->execute(['b' => $this->bucket('tb:' . $key)]);
        } catch (Throwable $e) {
            error_log('RateLimiter::clear failed: ' . $e->getMessage());
        }
    }

    /** Seconds until the current fixed window ends (i.e. the counter resets). */
    public function secondsUntilReset(int $windowSeconds): int
    {
        $w = max(1, $windowSeconds);
        return (int) ((intdiv(time(), $w) + 1) * $w - time());
    }

    private function windowStart(int $windowSeconds): int
    {
        $w = max(1, $windowSeconds);
        return intdiv(time(), $w) * $w;
    }

    private function bucket(string $key): string
    {
        // Hash so the column stays fixed-width and no raw PII (e.g. emails) is stored.
        return hash('sha256', $key);
    }

    /** Opportunistically purge old windows so the table can't grow unbounded (no cron needed). */
    private function maybeGc(): void
    {
        try {
            if (random_int(1, 200) !== 1) {
                return;
            }
            $stmt = $this->pdo->prepare('DELETE FROM rate_limits WHERE window_start < :cutoff');
            $stmt->execute(['cutoff' => time() - 86400]);
            // A bucket whose moment passed a day ago is full again: its row says nothing.
            $stmt = $this->pdo->prepare('DELETE FROM rate_buckets WHERE tat_ms < :cutoff');
            $stmt->execute(['cutoff' => (time() - 86400) * 1000]);
        } catch (Throwable $e) {
            // Non-fatal — GC is best-effort.
        }
    }
}
