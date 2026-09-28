<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Middleware\ApiKeyMiddleware;
use FormLogic\Middleware\RateLimitMiddleware;
use FormLogic\Services\ApiKeyService;
use FormLogic\Services\RateLimiter;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

/**
 * One flk_ key, two per-key budgets: the data API's (`apikey:<id>`, as it always was) and the
 * desktop link's (`apikey:desktop_link:<id>`). Spending either leaves the other whole, and a
 * refusal says when to come back (Retry-After), also through the per-address limiter around it.
 */
final class ApiKeyMiddlewareBucketTest extends TestCase
{
    private const KEY = 'flk_' . 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12';

    /** @var array<string, int> hits per counter, as the shared store would count them */
    private array $hits = [];
    private RateLimiter $limiter;
    private ApiKeyService $keys;

    protected function setUp(): void
    {
        $this->limiter = $this->createMock(RateLimiter::class);
        $this->limiter->method('hit')->willReturnCallback(fn (string $key) => $this->hits[$key] = ($this->hits[$key] ?? 0) + 1);
        $this->limiter->method('secondsUntilReset')->willReturn(17);
        $this->keys = $this->createMock(ApiKeyService::class);
        $this->keys->method('validateKey')->willReturn(['id' => 'key-1', 'userId' => 'user-1', 'scopes' => ['connector:relay', 'responses:manage'], 'formIds' => null]);
    }

    private function data(int $limit): ApiKeyMiddleware
    {
        return new ApiKeyMiddleware($this->keys, ['responses:manage'], $this->limiter, $limit, 60);
    }

    private function link(int $limit): ApiKeyMiddleware
    {
        return new ApiKeyMiddleware($this->keys, ['connector:relay'], $this->limiter, $limit, 60, 'desktop_link');
    }

    private function send(MiddlewareInterface $middleware, ?MiddlewareInterface $outer = null): ResponseInterface
    {
        $request = (new ServerRequestFactory())
            ->createServerRequest('GET', 'http://formlogic.local/api/v1/connector-commands/pending', ['REMOTE_ADDR' => '203.0.113.9'])
            ->withHeader('Authorization', 'Bearer ' . self::KEY);
        $ok = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface { return (new SlimResponse())->withStatus(200); }
        };
        if ($outer === null) {
            return $middleware->process($request, $ok);
        }
        $inner = new class($middleware, $ok) implements RequestHandlerInterface {
            public function __construct(private MiddlewareInterface $m, private RequestHandlerInterface $h) {}
            public function handle(ServerRequestInterface $request): ResponseInterface { return $this->m->process($request, $this->h); }
        };
        return $outer->process($request, $inner);
    }

    public function testTheDataBudgetKeepsItsCounterAndTheLinkHasItsOwn(): void
    {
        $this->assertSame(200, $this->send($this->data(120))->getStatusCode());
        $this->assertSame(200, $this->send($this->link(600))->getStatusCode());
        $this->assertSame(['apikey:key-1' => 1, 'apikey:desktop_link:key-1' => 1], $this->hits);
    }

    public function testSpentDataBudgetLeavesTheLanesAnswering(): void
    {
        $data = $this->data(2);
        $this->assertSame(200, $this->send($data)->getStatusCode());
        $this->assertSame(200, $this->send($data)->getStatusCode());
        $refused = $this->send($data);
        $this->assertSame(429, $refused->getStatusCode(), 'a sync burst past the data budget is refused');

        $link = $this->link(2);
        $this->assertSame(200, $this->send($link)->getStatusCode(), 'while the relay lane still answers');
        $this->assertSame(200, $this->send($link)->getStatusCode());
    }

    public function testBusyLanesLeaveTheDataBudgetWhole(): void
    {
        $link = $this->link(3);
        for ($i = 0; $i < 3; $i++) {
            $this->assertSame(200, $this->send($link)->getStatusCode());
        }
        $this->assertSame(429, $this->send($link)->getStatusCode(), 'the lanes are still bounded');
        $this->assertSame(200, $this->send($this->data(1))->getStatusCode(), 'and a record write still goes through');
    }

    public function testARefusalSaysWhenToComeBack(): void
    {
        $link = $this->link(1);
        $this->send($link);
        $refused = $this->send($link);

        $this->assertSame(429, $refused->getStatusCode());
        $this->assertSame('17', $refused->getHeaderLine('Retry-After'));
        $this->assertSame('1', $refused->getHeaderLine('X-RateLimit-Limit'));
        $this->assertSame('0', $refused->getHeaderLine('X-RateLimit-Remaining'));
        $body = json_decode((string) $refused->getBody(), true);
        $this->assertTrue($body['error']);
        $this->assertSame('rate_limited', $body['code']);
        $this->assertSame(17, $body['retryAfter']);
        $this->assertSame('API key rate limit exceeded. Try again in 17s.', $body['message'], 'the message clients already read is unchanged');
    }

    public function testThePerAddressLimiterAroundItKeepsTheRefusalsHeaders(): void
    {
        // As in index.php: the group's per-address limiter wraps the route's key check.
        $outer = new RateLimitMiddleware($this->limiter, 1200, 60, 'desktop_link');
        $link = $this->link(1);
        $this->assertSame('1200', $this->send($link, $outer)->getHeaderLine('X-RateLimit-Limit'), 'an answered request carries the address budget');

        $refused = $this->send($link, $outer);
        $this->assertSame(429, $refused->getStatusCode());
        $this->assertSame('17', $refused->getHeaderLine('Retry-After'));
        $this->assertSame('1', $refused->getHeaderLine('X-RateLimit-Limit'), 'the budget that ran out, not the address budget with room left');
        $this->assertSame('0', $refused->getHeaderLine('X-RateLimit-Remaining'));
    }
}
