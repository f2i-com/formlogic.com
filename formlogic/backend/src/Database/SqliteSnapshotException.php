<?php

declare(strict_types=1);

namespace FormLogic\Database;

/** A SQLite snapshot could not be produced or verified; nothing was published. */
final class SqliteSnapshotException extends \RuntimeException
{
}
