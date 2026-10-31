<?php

declare(strict_types=1);

namespace FormLogic\Support;

/**
 * A limit on the event streams one account holds open. Each holds a PHP worker for minutes, and
 * limits on requests don't see that: enough readers of one request fill the pool for everyone. A
 * slot is a file lock, so a worker that dies gives its slot back.
 */
final class StreamSlots
{
    /**
     * @return resource|false|null the held slot, to keep until the stream ends; null when every
     *         slot is taken; false when the storage can't hold slots, which is no reason to refuse
     */
    public static function take(string $who, int $max, ?string $dir = null)
    {
        $dir ??= dirname(__DIR__, 2) . '/storage/locks/streams';
        if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
            return false;
        }
        $name = substr(hash('sha256', $who), 0, 32);
        for ($slot = 0; $slot < $max; $slot++) {
            $handle = @fopen("{$dir}/{$name}-{$slot}.lock", 'c');
            if ($handle === false) {
                return false;
            }
            if (flock($handle, LOCK_EX | LOCK_NB)) {
                return $handle;
            }
            fclose($handle);
        }
        return null;
    }
}
