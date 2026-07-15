<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Support\Environment;
use PHPUnit\Framework\TestCase;

class EnvironmentTest extends TestCase
{
    private string $key;

    protected function setUp(): void
    {
        $this->key = 'FORMLOGIC_ENV_TEST_' . bin2hex(random_bytes(5));
    }

    protected function tearDown(): void
    {
        unset($_ENV[$this->key], $_SERVER[$this->key]);
        putenv($this->key);
    }

    public function testDeterministicPrecedence(): void
    {
        putenv($this->key . '=process');
        $_SERVER[$this->key] = 'server';
        $_ENV[$this->key] = 'env';
        $this->assertSame('env', Environment::get($this->key));

        unset($_ENV[$this->key]);
        $this->assertSame('server', Environment::get($this->key));

        unset($_SERVER[$this->key]);
        $this->assertSame('process', Environment::get($this->key));
    }

    public function testProcessOnlyVariablesWorkWhenEnvAndServerAreAbsent(): void
    {
        putenv($this->key . '=from-systemd');
        unset($_ENV[$this->key], $_SERVER[$this->key]);
        $this->assertSame('from-systemd', Environment::get($this->key));
    }

    public function testBootstrapPreservesServerPrecedenceOverProcess(): void
    {
        putenv($this->key . '=process');
        $_SERVER[$this->key] = 'server';
        unset($_ENV[$this->key]);
        Environment::bootstrap();
        $this->assertSame('server', $_ENV[$this->key]);
    }
}
