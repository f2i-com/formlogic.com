<?php

declare(strict_types=1);

namespace FormLogic\Support;

/** Reads a PDO error's text, which may have reached a place where only the text is left. */
final class SqlErrorText
{
    /**
     * Whether a database was too busy to answer, so the same request can work a moment later: a
     * deadlock (1213), a lock wait that ran out (1205), or SQLite's locks (5 and 6).
     */
    public static function isBusy(string $text): bool
    {
        return preg_match('/SQLSTATE\[\w+\]:[^:]*: (?:1213|1205|5|6) /', $text) === 1;
    }
}
