<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\AppDomainService;
use PHPUnit\Framework\TestCase;

/**
 * Custom-domain normalization + validation. Pure — the service is instantiated WITHOUT its constructor
 * (which would open a DB connection) since these methods never touch the DB.
 */
class AppDomainServiceTest extends TestCase
{
    private AppDomainService $svc;

    protected function setUp(): void
    {
        $this->svc = (new \ReflectionClass(AppDomainService::class))->newInstanceWithoutConstructor();
    }

    public function testNormalizeStripsSchemePortPathAndLowercases(): void
    {
        $this->assertSame('example.com', $this->svc->normalizeDomain('HTTPS://Example.com:443/launch?x=1'));
        $this->assertSame('app.co', $this->svc->normalizeDomain('app.co.'));
        $this->assertSame('app.co', $this->svc->normalizeDomain('  App.CO  '));
    }

    public function testValidDomainRequiresFqdn(): void
    {
        $this->assertTrue($this->svc->isValidDomain('app.yourcompany.com'));
        $this->assertFalse($this->svc->isValidDomain('nodot'));
        $this->assertFalse($this->svc->isValidDomain('-bad.com'));
        $this->assertFalse($this->svc->isValidDomain(''));
    }

    public function testPublicDomainRejectsReservedAndRawIp(): void
    {
        $this->assertTrue($this->svc->isPublicDomain('app.acme.com'));
        $this->assertFalse($this->svc->isPublicDomain('localhost'));
        $this->assertFalse($this->svc->isPublicDomain('service.local'));
        $this->assertFalse($this->svc->isPublicDomain('stage.test'));
        $this->assertFalse($this->svc->isPublicDomain('10.0.0.5'));
        $this->assertFalse($this->svc->isPublicDomain('127.0.0.1'));
    }

    public function testAssertReturnsNormalizedForValidPublicDomain(): void
    {
        $this->assertSame('app.acme.com', $this->svc->assertValidPublicDomain('https://App.Acme.com/x'));
    }

    public function testAssertThrowsOnLocalhost(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->svc->assertValidPublicDomain('localhost');
    }

    public function testAssertThrowsOnPrivateIp(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->svc->assertValidPublicDomain('192.168.0.1');
    }

    /**
     * The TLS probe connects to the address its safety check approved, with the domain kept as the
     * certificate and SNI name, so a second lookup (the one a rebinding name answers) never
     * happens. Literal addresses here, so no DNS is needed and nothing is connected.
     */
    public function testTheTlsProbeConnectsToTheApprovedAddress(): void
    {
        $spy = new class extends AppDomainService {
            /** @var list<string> */
            public array $targets = [];
            public function __construct()
            {
            }
            protected function openTls(string $target, $context)
            {
                $this->targets[] = $target . ' as ' . stream_context_get_options($context)['ssl']['peer_name'];
                return false;
            }
        };
        $probe = new \ReflectionMethod(AppDomainService::class, 'probeTls');
        $this->assertSame('pending', $probe->invoke($spy, '8.8.8.8'));
        $this->assertSame('pending', $probe->invoke($spy, '2001:4860:4860::8888'));
        $this->assertSame('external', $probe->invoke($spy, '10.0.0.5'));
        $this->assertSame(['ssl://8.8.8.8:443 as 8.8.8.8', 'ssl://[2001:4860:4860::8888]:443 as 2001:4860:4860::8888'], $spy->targets);
    }
}
