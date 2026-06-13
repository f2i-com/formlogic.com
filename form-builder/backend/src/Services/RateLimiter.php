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
 * Fails OPEN on storage errors (e.g. the table not yet migrated): the request is
 * allowed and the error is logged, so a missing migration degrades to the prior
 * (un-throttled) behaviour rather than bricking login / every rate-limited route.
 */
class RateLimiter
{
    public function __construct(private PDO $pdo)
    {
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

    /** Remove all counters for a key (e.g. on successful login). */
    public function clear(string $key): void
    {
        try {
            $stmt = $this->pdo->prepare('DELETE FROM rate_limits WHERE bucket = :b');
            $stmt->execute(['b' => $this->bucket($key)]);
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
        } catch (Throwable $e) {
            // Non-fatal — GC is best-effort.
        }
    }
}
