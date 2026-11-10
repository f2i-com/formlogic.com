<?php

declare(strict_types=1);

namespace FormLogic\Support;

/**
 * A fingerprint of FormLogic's server code as it is on disk now, for a process that runs for a long
 * time to tell that the code it loaded has since been replaced (bin/app-ai-worker.php), and for the
 * web to tell that such a process still runs what was there before an update.
 *
 * It is made of every PHP file under src/ and config/, the scripts in bin/, and Composer's record of
 * what is installed: each one's path, size and time of change. Any ordinary update changes it,
 * whether or not the database's schema changed; an update of the browser's files alone does not, and
 * need not. Reading it costs a few hundred `stat` calls and opens no file.
 */
final class CodeFingerprint
{
    /** Folders read all the way down. */
    private const TREES = ['src', 'config'];
    /** bin/ holds the scripts, and beside them the native runtime's own files, which are not this code. */
    private const SCRIPTS = 'bin';
    private const INSTALLED = 'vendor/composer/installed.php';

    /** Sixteen hex characters for the code under $backend (this installation's, by default). */
    public static function onDisk(?string $backend = null): string
    {
        $backend = rtrim(str_replace('\\', '/', $backend ?? dirname(__DIR__, 2)), '/');
        // A process that asks again must see the files as they are now, not as PHP remembers them.
        clearstatcache();
        $paths = array_merge(glob($backend . '/' . self::SCRIPTS . '/*.php') ?: [], is_file($backend . '/' . self::INSTALLED) ? [$backend . '/' . self::INSTALLED] : []);
        foreach (self::TREES as $tree) {
            if (!is_dir($backend . '/' . $tree)) continue;
            $files = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($backend . '/' . $tree, \FilesystemIterator::SKIP_DOTS));
            foreach ($files as $file) {
                if ($file->isFile() && $file->getExtension() === 'php') $paths[] = $file->getPathname();
            }
        }
        $lines = [];
        foreach ($paths as $path) {
            $path = str_replace('\\', '/', (string) $path);
            $lines[] = substr($path, strlen($backend) + 1) . '|' . (int) @filesize($path) . '|' . (int) @filemtime($path);
        }
        // A folder is read in no promised order.
        sort($lines, SORT_STRING);
        return substr(hash('sha256', implode("\n", $lines)), 0, 16);
    }
}
