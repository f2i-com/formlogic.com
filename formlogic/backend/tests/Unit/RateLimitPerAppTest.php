<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Middleware\RateLimitMiddleware;
use FormLogic\Services\RateLimiter;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/** A hostile frame spends a viewer's budget where it runs, not in every other app they use. */
final class RateLimitPerAppTest extends TestCase
{
    /** @return list<string> the bucket each path was counted in */
    private function buckets(bool $perApp, array $paths, string $userId = 'member-1'): array
    {
        $seen = [];
        $limiter = $this->createMock(RateLimiter::class);
        $limiter->method('hit')->willReturnCallback(function (string $key) use (&$seen): int {
            $seen[] = $key;
            return 1;
        });
        $handler = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                return new Response(204);
            }
        };
        $middleware = new RateLimitMiddleware($limiter, 10, 60, 'test', true, true, null, $perApp);
        foreach ($paths as $path) {
            $request = (new ServerRequestFactory())->createServerRequest('POST', 'https://formlogic.example' . $path);
            $middleware->process($request->withAttribute('userId', $userId), $handler);
        }
        return $seen;
    }

    public function testEachAppHasItsOwnBucket(): void
    {
        [$first, $second] = $this->buckets(true, ['/api/app/one/native/request', '/api/app/two/native/request']);
        self::assertNotSame($first, $second);
    }

    public function testOneAppIsOneBucketWhateverTheRouteOrCase(): void
    {
        $seen = $this->buckets(true, ['/api/app/shop/native', '/api/app/shop/native/request', '/api/app/SHOP/entry', '/api/app/sh%6Fp/entry']);
        self::assertCount(1, array_unique($seen));
    }

    public function testASpellingNoAppCouldHaveBuysNoBudget(): void
    {
        $seen = $this->buckets(true, ['/api/app/shop%20/native/request', '/api/app/sh%C3%B3p/native/request', '/api/app/shop%0A/entry', '/api/app/made%20up/entry']);
        self::assertCount(1, array_unique($seen));
        self::assertNotSame($this->buckets(true, ['/api/app/shop/native'])[0], $seen[0]);
    }

    public function testAnEveryAppBucketIsUntouched(): void
    {
        [$first, $second] = $this->buckets(false, ['/api/app/one/native', '/api/app/two/native']);
        self::assertSame($first, $second);
    }

    public function testStillCountsEachPersonApart(): void
    {
        [$first] = $this->buckets(true, ['/api/app/one/native'], 'member-1');
        [$second] = $this->buckets(true, ['/api/app/one/native'], 'member-2');
        self::assertNotSame($first, $second);
    }
}
