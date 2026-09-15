<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Middleware\RateLimitMiddleware;
use FormLogic\Models\User;
use FormLogic\Services\RateLimiter;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

/**
 * Per-account limits (keyByUser) and the shared public demo: every demo visitor is the same
 * account, so the demo's reads are keyed by account AND client IP — one busy visitor must not 429
 * the rest (the demo's native records browser showed "Could not load database tables"). Every
 * other account, and the demo's few allowed writes (minting MCP tokens), stay keyed by account
 * alone, so changing IP still cannot buy a fresh budget.
 */
final class RateLimitMiddlewareTest extends TestCase
{
    /** @var array<string, int> hits per limiter key, as the shared store would count them */
    private array $hits = [];

    private function middleware(int $max): RateLimitMiddleware
    {
        $limiter = $this->createMock(RateLimiter::class);
        $limiter->method('hit')->willReturnCallback(fn (string $key) => $this->hits[$key] = ($this->hits[$key] ?? 0) + 1);
        $limiter->method('secondsUntilReset')->willReturn(30);
        return new RateLimitMiddleware($limiter, $max, 60, 'native_records', true, true);
    }

    private function answer(RateLimitMiddleware $middleware, ?string $email, string $ip, string $method = 'GET'): int
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, 'http://formlogic.local/api/apps/a1/native/records', ['REMOTE_ADDR' => $ip]);
        if ($email !== null) $request = $request->withAttribute('userId', 'account-1')->withAttribute('user', new User(id: 'account-1', email: $email));
        $handler = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface { return (new SlimResponse())->withStatus(200); }
        };
        return $middleware->process($request, $handler)->getStatusCode();
    }

    private function demoEmail(): string { return $_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local'; }

    public function testDemoVisitorsFromDifferentAddressesDoNotShareOneBudget(): void
    {
        $limit = $this->middleware(1);
        $this->assertSame(200, $this->answer($limit, $this->demoEmail(), '203.0.113.10'));
        $this->assertSame(200, $this->answer($limit, $this->demoEmail(), '203.0.113.20'), 'a second demo visitor has a budget of their own');
        $this->assertCount(2, $this->hits);
        // Still limited: the same visitor again is refused.
        $this->assertSame(429, $this->answer($limit, $this->demoEmail(), '203.0.113.10'));
    }

    public function testTheDemosAllowedWritesKeepOneSharedBudget(): void
    {
        $limit = $this->middleware(1);
        $this->assertSame(200, $this->answer($limit, $this->demoEmail(), '203.0.113.10', 'POST'));
        $this->assertSame(429, $this->answer($limit, $this->demoEmail(), '2001:db8::2', 'POST'), 'a new address is not a new write budget');
        $this->assertSame(429, $this->answer($limit, $this->demoEmail(), '2001:db8::3', 'DELETE'));
        $this->assertSame(['native_records:u:' . hash('sha256', 'account-1')], array_keys($this->hits));
    }

    public function testEveryOtherAccountIsStillKeyedByAccountAlone(): void
    {
        $limit = $this->middleware(1);
        $this->assertSame(200, $this->answer($limit, 'owner@example.com', '203.0.113.10'));
        $this->assertSame(429, $this->answer($limit, 'owner@example.com', '203.0.113.20'), 'a new address is not a new budget');
        $this->assertCount(1, $this->hits);
        $this->assertSame(['native_records:u:' . hash('sha256', 'account-1')], array_keys($this->hits));
    }

    public function testARequestWithoutAnAccountIsKeyedByAddress(): void
    {
        $limit = $this->middleware(1);
        $this->assertSame(200, $this->answer($limit, null, '203.0.113.10'));
        $this->assertSame(200, $this->answer($limit, null, '203.0.113.20'));
        $this->assertSame(429, $this->answer($limit, null, '203.0.113.10'));
        $this->assertSame(['native_records:' . hash('sha256', '203.0.113.10'), 'native_records:' . hash('sha256', '203.0.113.20')], array_keys($this->hits));
    }
}
