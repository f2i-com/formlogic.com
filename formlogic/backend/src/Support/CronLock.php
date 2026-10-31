<?php

declare(strict_types=1);

namespace FormLogic\Support;

/**
 * One run at a time of a scheduled script. The lock is in this install's storage: a fixed name in
 * the system's temp folder could belong to another user, and a second site on the machine shares
 * it, and either stops the job for good while cron sees a clean exit. Cron may run as a user who
 * can't write to storage, and then the temp folder stands in, under a name only this install uses.
 */
final class CronLock
{
    /**
     * @return resource|null the held lock, to keep until the script ends; null when another run holds it
     * @throws \RuntimeException when no lock can be opened at all, so cron hears about it
     */
    public static function take(string $name, ?string $dir = null)
    {
        $dir ??= dirname(__DIR__, 2) . '/storage/locks';
        $handle = self::open($dir, $name) ?? self::open(sys_get_temp_dir(), 'formlogic-' . substr(hash('sha256', $dir), 0, 16) . '-' . $name);
        if ($handle === null) {
            throw new \RuntimeException("Cannot open a lock for {$name} in {$dir} or the temp folder: check their owner and mode");
        }
        return flock($handle, LOCK_EX | LOCK_NB) ? $handle : null;
    }

    /** @return resource|null */
    private static function open(string $dir, string $name)
    {
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            return null;
        }
        $handle = @fopen("{$dir}/{$name}.lock", 'c');
        return $handle === false ? null : $handle;
    }
}
