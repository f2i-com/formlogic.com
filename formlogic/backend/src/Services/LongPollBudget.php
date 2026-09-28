<?php
declare(strict_types=1);
namespace FormLogic\Services;

use FormLogic\Support\Environment;

/**
 * How long a long poll may hold the worker that answers it.
 *
 * Under Apache or php-fpm a poll waits as long as it asks, up to its route's maximum.
 * PHP's built-in server (`php -S`) has one worker unless it is given more, and a
 * 25-second idle poll holding that one blocks login, heartbeat and the write that would
 * satisfy the poll. So there a poll may hold a worker for one second per worker known
 * to be serving: one second alone, as before, and longer when there are more.
 *
 * Workers are known from:
 *  - FORMLOGIC_DEV_SERVER_WORKERS: how many built-in servers answer this address, e.g. a
 *    pool of `php -S` processes behind one proxy (any OS);
 *  - PHP_CLI_SERVER_WORKERS: the workers `php -S` forks itself. PHP forks only where it
 *    can, so this is not read on Windows, where PHP says "forking is not supported on
 *    this platform" and serves with one.
 */
final class LongPollBudget
{
    /** How long a poll may hold a built-in server's worker, per worker known to be serving. */
    public const PER_WORKER_MS = 1000;

    public static function milliseconds(int $requested, int $maximum): int
    {
        $forked = getenv('PHP_CLI_SERVER_WORKERS');
        return self::forServer(
            $requested,
            $maximum,
            PHP_SAPI,
            PHP_OS_FAMILY,
            Environment::nonEmpty('FORMLOGIC_DEV_SERVER_WORKERS'),
            $forked === false ? null : $forked,
        );
    }

    /** milliseconds() with what it reads from the running PHP passed in. */
    public static function forServer(
        int $requested,
        int $maximum,
        string $sapi,
        string $osFamily,
        ?string $declaredWorkers,
        ?string $forkedWorkers
    ): int {
        if ($sapi === 'cli-server') {
            $workers = self::workers($declaredWorkers)
                ?? ($osFamily === 'Windows' ? null : self::workers($forkedWorkers))
                ?? 1;
            $maximum = min($maximum, $workers * self::PER_WORKER_MS);
        }
        return max(0, min($requested, $maximum));
    }

    private static function workers(?string $value): ?int
    {
        return $value !== null && preg_match('/^\s*[1-9][0-9]{0,3}\s*$/', $value) === 1 ? (int) $value : null;
    }
}
