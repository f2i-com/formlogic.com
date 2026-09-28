<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\LongPollBudget;
use PHPUnit\Framework\TestCase;

/**
 * Under PHP's built-in server a long poll may hold a worker for one second per worker known to
 * be serving; elsewhere it waits as long as it asks, up to the route's maximum.
 */
final class LongPollBudgetTest extends TestCase
{
    private static function budget(int $requested, string $sapi, string $os, ?string $declared = null, ?string $forked = null): int
    {
        return LongPollBudget::forServer($requested, 25000, $sapi, $os, $declared, $forked);
    }

    public function testApacheAndFpmWaitAsAsked(): void
    {
        $this->assertSame(25000, self::budget(25000, 'apache2handler', 'Windows'));
        $this->assertSame(25000, self::budget(25000, 'fpm-fcgi', 'Linux'));
        $this->assertSame(25000, self::budget(60000, 'fpm-fcgi', 'Linux'), 'never past the route maximum');
        $this->assertSame(0, self::budget(0, 'fpm-fcgi', 'Linux'));
        $this->assertSame(0, self::budget(-5, 'fpm-fcgi', 'Linux'));
    }

    public function testOneBuiltInWorkerIsHeldForASecond(): void
    {
        $this->assertSame(1000, self::budget(25000, 'cli-server', 'Windows'));
        $this->assertSame(1000, self::budget(25000, 'cli-server', 'Linux'), 'php -S has one worker on Linux too unless it forks more');
        $this->assertSame(400, self::budget(400, 'cli-server', 'Windows'), 'a shorter ask is kept');
        $this->assertSame(0, self::budget(0, 'cli-server', 'Windows'));
    }

    public function testADeclaredPoolWaitsLonger(): void
    {
        $this->assertSame(8000, self::budget(25000, 'cli-server', 'Windows', '8'), 'eight php -S processes behind one proxy');
        $this->assertSame(25000, self::budget(25000, 'cli-server', 'Windows', '40'), 'never past the route maximum');
        $this->assertSame(8000, self::budget(25000, 'cli-server', 'Linux', '8', '2'), 'the declared pool wins over what PHP forks');
    }

    public function testForkedWorkersCountOnlyWherePhpForks(): void
    {
        $this->assertSame(4000, self::budget(25000, 'cli-server', 'Linux', null, '4'));
        $this->assertSame(4000, self::budget(25000, 'cli-server', 'Darwin', null, '4'));
        $this->assertSame(1000, self::budget(25000, 'cli-server', 'Windows', null, '4'), 'Windows ignores PHP_CLI_SERVER_WORKERS and serves with one');
    }

    public function testAnUnreadableCountIsOneWorker(): void
    {
        foreach (['', '0', '-3', 'eight', '2.5', '99999'] as $value) {
            $this->assertSame(1000, self::budget(25000, 'cli-server', 'Linux', $value, $value), "'{$value}'");
        }
    }
}
