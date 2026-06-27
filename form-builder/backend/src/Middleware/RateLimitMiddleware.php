<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

use FormLogic\Helpers\IpResolver;
use FormLogic\Services\RateLimiter;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;
use Slim\Psr7\Response as SlimResponse;

/**
 * Per-IP rate limiting backed by a shared, persistent store (RateLimiter), so
 * limits hold across requests AND worker processes under mod_php / php-fpm.
 * (The previous per-process in-memory counters reset every request and were a
 * no-op in production.)
 */
class RateLimitMiddleware implements MiddlewareInterface
{
    private int $maxRequests;
    private int $windowSeconds;
    private string $keyPrefix;
    private bool $keyByUser;
    private IpResolver $ipResolver;
    private RateLimiter $limiter;

    /**
     * @param RateLimiter $limiter      Shared persistent counter store
     * @param int $maxRequests          Max requests allowed in the window
     * @param int $windowSeconds        Window length in seconds
     * @param string $keyPrefix         Separates limits for different endpoints
     * @param bool $keyByUser           Key on the authenticated userId when present
     *                                  (falls back to IP). Use for expensive
     *                                  authenticated endpoints so IP rotation
     *                                  cannot bypass the limit. Requires an auth
     *                                  middleware to run first so userId is set.
     */
    public function __construct(
        RateLimiter $limiter,
        int $maxRequests = 60,
        int $windowSeconds = 60,
        string $keyPrefix = 'default',
        bool $keyByUser = false
    ) {
        $this->limiter = $limiter;
        $this->maxRequests = $maxRequests;
        $this->windowSeconds = $windowSeconds;
        $this->keyPrefix = $keyPrefix;
        $this->keyByUser = $keyByUser;
        $this->ipResolver = IpResolver::fromEnvironment();
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        $key = $this->getClientKey($request);

        // Atomically increment and gate on the post-increment count. Gating on a
        // separate count() before hit() let K concurrent requests all observe
        // count < max and overshoot the limit. hit() returns 0 on storage error
        // (fail open). Incrementing a blocked request is harmless: the counter is
        // keyed to a fixed window bucket, so it never extends the lockout.
        $count = $this->limiter->hit($key, $this->windowSeconds);
        if ($count > $this->maxRequests) {
            $retryAfter = $this->limiter->secondsUntilReset($this->windowSeconds);

            $response = new SlimResponse();
            $response->getBody()->write(json_encode([
                'error' => true,
                'message' => 'Too many requests. Please try again later.',
                'retryAfter' => $retryAfter,
            ]));

            return $response
                ->withStatus(429)
                ->withHeader('Content-Type', 'application/json')
                ->withHeader('Retry-After', (string)$retryAfter)
                ->withHeader('X-RateLimit-Limit', (string)$this->maxRequests)
                ->withHeader('X-RateLimit-Remaining', '0')
                ->withHeader('X-RateLimit-Reset', (string)(time() + $retryAfter));
        }

        $remaining = max(0, $this->maxRequests - $count);

        $response = $handler->handle($request);

        return $response
            ->withHeader('X-RateLimit-Limit', (string)$this->maxRequests)
            ->withHeader('X-RateLimit-Remaining', (string)$remaining)
            ->withHeader('X-RateLimit-Reset', (string)(time() + $this->limiter->secondsUntilReset($this->windowSeconds)));
    }

    /**
     * Per-client key. When keyByUser is on and an authenticated userId is present,
     * the limit is per-account (so changing source IP cannot bypass it); otherwise
     * it falls back to the trusted client IP. IpResolver only honors
     * X-Forwarded-For from configured proxies, preventing spoofing that could
     * bypass the limit.
     */
    private function getClientKey(Request $request): string
    {
        if ($this->keyByUser) {
            $userId = $request->getAttribute('userId');
            if (is_string($userId) && $userId !== '') {
                return $this->keyPrefix . ':u:' . hash('sha256', $userId);
            }
        }
        $ip = $this->ipResolver->getClientIp($request);
        return $this->keyPrefix . ':' . hash('sha256', $ip);
    }
}
