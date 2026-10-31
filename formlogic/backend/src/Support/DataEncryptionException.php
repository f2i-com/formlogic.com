<?php

declare(strict_types=1);

namespace FormLogic\Support;

/** Its message is safe to show: it never names a key, a value or a path. */
final class DataEncryptionException extends \RuntimeException
{
}
