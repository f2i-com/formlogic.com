<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * Whatever runs from cron during a deploy meets a web worker migrating at the same moment. Both
 * saw a column missing and both ran the ALTER, and the loser failed, so a script takes the schema
 * through ensureSchemaCurrent, under the lock the web app holds.
 */
final class CronSchemaLockTest extends TestCase
{
    public function testNoScriptMigratesOutsideTheSchemaLock(): void
    {
        $scripts = glob(dirname(__DIR__, 2) . '/bin/*.php') ?: [];
        self::assertNotEmpty($scripts);
        foreach ($scripts as $script) {
            $source = (string) file_get_contents($script);
            self::assertDoesNotMatchRegularExpression('/->(initializeSchema|runMigrations)\(\)/', $source, basename($script));
        }
    }
}
