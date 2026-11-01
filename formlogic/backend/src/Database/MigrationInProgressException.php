<?php

declare(strict_types=1);

namespace FormLogic\Database;

/** Another worker is migrating the database and did not finish while this request waited for it. */
final class MigrationInProgressException extends \RuntimeException
{
}
