<?php

declare(strict_types=1);

namespace FormLogic\Support;

/**
 * Keeps other accounts on this machine out of the data folders. Databases, backups (which hold
 * host keys and the site's SQL) and logs are written at the server's default mode, usually
 * readable by everyone, so these folders are what protects them.
 *
 * A folder rather than a umask: PHP also writes the site's own files during an upgrade, and on
 * shared hosting the web server reads those as another account.
 */
final class StorageAccess
{
    /** Takes away what "others" may do in these folders, leaving owner and group as they are. */
    public static function closeToOthers(string ...$directories): void
    {
        if (DIRECTORY_SEPARATOR !== '/') {
            return; // No such bits on Windows.
        }
        foreach ($directories as $directory) {
            clearstatcache(true, $directory);
            $mode = @fileperms($directory);
            if ($mode !== false && ($mode & 0007) !== 0) {
                @chmod($directory, $mode & 07770);
            }
        }
    }
}
