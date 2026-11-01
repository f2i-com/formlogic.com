<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Database\MySQLConnection;
use PHPUnit\Framework\TestCase;

/**
 * The migrations are stamped done with a value compiled into MySQLConnection, not a hash of the file
 * on disk, so old bytecode still running after an update can't mark the new release's migrations
 * done without running them. A changed file with the old value would skip them just the same, and
 * this is what stops that.
 */
final class SchemaStampTest extends TestCase
{
    public function testTheStampIsTheFilesOwn(): void
    {
        $file = dirname(__DIR__, 2) . '/src/Database/MySQLConnection.php';
        $source = str_replace("\r\n", "\n", (string) file_get_contents($file));
        $blanked = preg_replace("/SCHEMA_STAMP = '[0-9a-f]{32}'/", "SCHEMA_STAMP = ''", $source, 1, $found);
        $this->assertSame(1, $found, 'SCHEMA_STAMP must be written as a 32-character hex string');
        $this->assertSame(md5((string) $blanked), MySQLConnection::SCHEMA_STAMP, 'MySQLConnection changed: set SCHEMA_STAMP to the expected value above');
    }

    public function testTheStampIsNotReadFromTheDisk(): void
    {
        $source = (string) file_get_contents(dirname(__DIR__, 2) . '/src/Database/MySQLConnection.php');
        $this->assertStringNotContainsString('md5_' . 'file(', $source, 'stale bytecode reads the new file: this is how migrations were skipped');
    }
}
