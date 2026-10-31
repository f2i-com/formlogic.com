<?php

declare(strict_types=1);

namespace FormLogic\Support;

/**
 * One run at a time of a scheduled script. The lock is in this install's storage: in the system's
 * temp folder another user could own the name, and a second site on the machine shares it, and
 * either one stops the job for good while cron sees a clean exit.
 */
final class CronLock
{
    /**
     * @return resource|null the held lock, to keep until the script ends; null when another run holds it
     * @throws \RuntimeException when the lock can't be opened, so cron hears about it
     */
    public static function take(string $name, ?string $dir = null)
    {
        $dir ??= dirname(__DIR__, 2) . '/storage/locks';
        if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
            throw new \RuntimeException("Cannot create the lock folder {$dir}: check its owner and mode");
        }
        $path = "{$dir}/{$name}.lock";
        $handle = @fopen($path, 'c');
        if ($handle === false) {
            throw new \RuntimeException("Cannot open the lock file {$path}: check its owner and mode");
        }
        return flock($handle, LOCK_EX | LOCK_NB) ? $handle : null;
    }
}
