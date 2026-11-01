<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\AppDomainController;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppService;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

/**
 * Nobody signs in on a custom domain, so the domain has to be told where FormLogic is. A site set up
 * with the wizard had only CORS_ORIGIN, and with no address its members got a password form the
 * server refuses: found by updating a real v0.1.17 site with a domain connected.
 */
final class DomainSignInAddressTest extends TestCase
{
    private const KEYS = ['APP_URL', 'CORS_ORIGIN', 'CORS_ALLOWED_ORIGINS', 'APP_ENV'];
    /** @var array<string, array{0:string|false,1:mixed}> */
    private array $saved = [];

    protected function setUp(): void
    {
        foreach (self::KEYS as $key) {
            $this->saved[$key] = [getenv($key), $_ENV[$key] ?? null];
            putenv($key);
            unset($_ENV[$key], $_SERVER[$key]);
        }
    }

    protected function tearDown(): void
    {
        foreach ($this->saved as $key => [$env, $server]) {
            putenv($env === false ? $key : "{$key}={$env}");
            unset($_SERVER[$key]);
            if ($server === null) {
                unset($_ENV[$key]);
            } else {
                $_ENV[$key] = $server;
            }
        }
    }

    private function set(string $key, string $value): void
    {
        putenv("{$key}={$value}");
        $_ENV[$key] = $value;
    }

    private function platformUrl(): mixed
    {
        $domains = $this->createMock(AppDomainService::class);
        $domains->method('resolveLaunchConfig')->willReturn(['domain' => 'shop.example.org']);
        $request = (new ServerRequestFactory())->createServerRequest('GET', 'https://shop.example.org/api/public/launch/by-host?host=shop.example.org')
            ->withQueryParams(['host' => 'shop.example.org']);
        $response = (new AppDomainController($domains, $this->createMock(AppService::class)))->resolveByHost($request, new SlimResponse());
        return json_decode((string) $response->getBody(), true)['platformUrl'] ?? null;
    }

    public function testAppUrlIsWhereADomainsVisitorsSignIn(): void
    {
        $this->set('APP_URL', 'https://forms.example.com/');
        $this->set('CORS_ORIGIN', 'https://other.example.com');

        $this->assertSame('https://forms.example.com', $this->platformUrl());
    }

    public function testASiteFromTheWizardKnowsItsAddressFromCorsOrigin(): void
    {
        $this->set('CORS_ORIGIN', 'https://forms.example.com/');

        $this->assertSame('https://forms.example.com', $this->platformUrl());
    }

    public function testTheRequestNeverChoosesTheAddress(): void
    {
        $this->assertNull($this->platformUrl(), 'nothing configured: no address, not the domain\'s own');
    }

    public function testTheExampleCorsOriginIsNotALiveSitesAddress(): void
    {
        foreach (['http://localhost:5173', 'http://127.0.0.1:8080', 'http://[::1]:5173', 'http://app.localhost'] as $origin) {
            $this->set('CORS_ORIGIN', $origin);
            $this->assertNull($this->platformUrl(), $origin);
        }
        $this->set('APP_ENV', 'production');
        $this->assertNull($this->platformUrl());
    }

    public function testALoopbackOriginStepsAsideForARealOne(): void
    {
        $this->set('CORS_ORIGIN', 'http://localhost:5173');
        $this->set('CORS_ALLOWED_ORIGINS', 'http://localhost:3000,https://forms.example.com');
        $this->assertNull($this->platformUrl(), 'only the first listed origin was ever the fallback');

        $this->set('CORS_ALLOWED_ORIGINS', 'https://forms.example.com,http://localhost:3000');
        $this->assertSame('https://forms.example.com', $this->platformUrl());
    }

    public function testDevelopmentKeepsItsLoopbackAddress(): void
    {
        $this->set('APP_ENV', 'development');
        $this->set('CORS_ORIGIN', 'http://localhost:5173');
        $this->assertSame('http://localhost:5173', $this->platformUrl());
    }

    public function testAnAddressTheOperatorSetIsTakenAsItIs(): void
    {
        $this->set('APP_URL', 'http://localhost:8080');
        $this->assertSame('http://localhost:8080', $this->platformUrl());
    }
}
