<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Middleware\RateLimitMiddleware;
use FormLogic\Models\User;
use FormLogic\Services\ApiKeyService;
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

    /**
     * One IPv6 subscriber is normally handed a whole /64 and can use any address in it, so keying
     * by the full address gave each client 2^64 budgets. Addresses are keyed by their /64; an
     * IPv4 address mapped into IPv6 is its IPv4 address.
     */
    public function testAnIpv6ClientIsKeyedByItsSlash64(): void
    {
        $limit = $this->middleware(1);
        $this->assertSame(200, $this->answer($limit, null, '2001:db8:1:2::10'));
        $this->assertSame(429, $this->answer($limit, null, '2001:db8:1:2:ffff:ffff:ffff:1'), 'another address in the same /64 is not a new budget');
        $this->assertSame(200, $this->answer($limit, null, '2001:db8:1:3::10'), 'the next /64 is another client');
        $this->assertSame(429, $this->answer($limit, null, '[2001:db8:1:2::99]:443'), 'bracketed with a port, the same /64');

        $this->assertSame(200, $this->answer($limit, null, '::ffff:198.51.100.7'));
        $this->assertSame(429, $this->answer($limit, null, '198.51.100.7'), 'an IPv4-mapped address is its IPv4 address');
    }

    /**
     * /api/ai/chat takes a session or, failing one, an flk_ key that the controller authenticates
     * itself, so the limiter saw no account for a key and counted it by address: a key used from
     * many addresses had a budget for each. Given the key service, a valid key counts against
     * its owner's account, in the bucket that account's sessions use.
     */
    public function testAnApiKeyIsCountedAgainstItsOwnersAccount(): void
    {
        $key = 'flk_' . str_repeat('a1', 20);
        $keys = $this->createMock(ApiKeyService::class);
        $keys->method('validateKey')->willReturnCallback(fn (string $k) => $k === $key ? ['id' => 'key-1', 'userId' => 'account-1', 'scopes' => ['ai:relay']] : null);
        $limiter = $this->createMock(RateLimiter::class);
        $limiter->method('hit')->willReturnCallback(fn (string $k) => $this->hits[$k] = ($this->hits[$k] ?? 0) + 1);
        $limiter->method('secondsUntilReset')->willReturn(30);
        $limit = new RateLimitMiddleware($limiter, 2, 60, 'ai_chat', true, false, $keys);
        $handler = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface { return (new SlimResponse())->withStatus(200); }
        };
        $send = function (string $ip, ?string $bearer, bool $session = false) use ($limit, $handler): int {
            $request = (new ServerRequestFactory())->createServerRequest('POST', 'http://formlogic.local/api/ai/chat', ['REMOTE_ADDR' => $ip]);
            if ($bearer !== null) $request = $request->withHeader('Authorization', 'Bearer ' . $bearer);
            if ($session) $request = $request->withAttribute('userId', 'account-1')->withAttribute('user', new User(id: 'account-1', email: 'owner@example.com'));
            return $limit->process($request, $handler)->getStatusCode();
        };

        $this->assertSame(200, $send('203.0.113.10', $key));
        $this->assertSame(200, $send('198.51.100.20', null, true), 'the account’s session draws on the same budget');
        $this->assertSame(429, $send('192.0.2.30', $key), 'a new address is not a new budget for the key');
        $this->assertSame(['ai_chat:u:' . hash('sha256', 'account-1')], array_keys($this->hits));

        // A key that does not validate is counted by address, as before; the controller refuses it.
        $this->assertSame(200, $send('192.0.2.40', 'flk_' . str_repeat('b2', 20)));
        $this->assertArrayHasKey('ai_chat:' . hash('sha256', '192.0.2.40'), $this->hits);
    }
}
