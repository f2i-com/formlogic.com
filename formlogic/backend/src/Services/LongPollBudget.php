<?php
declare(strict_types=1);
namespace FormLogic\Services;

/** PHP's built-in Windows server has one worker. A 25-second idle poll
 * otherwise blocks login, heartbeat and the writes that would satisfy it. */
final class LongPollBudget
{
    public static function milliseconds(int $requested, int $maximum): int
    {
        if (PHP_SAPI === 'cli-server' && PHP_OS_FAMILY === 'Windows') {
            $maximum = min($maximum, 1000);
        }
        return max(0, min($requested, $maximum));
    }
}
