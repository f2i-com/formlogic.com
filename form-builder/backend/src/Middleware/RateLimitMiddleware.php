<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

use FormLogic\Helpers\IpResolver;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;
use Slim\Psr7\Response as SlimResponse;

/**
 * Simple in-memory rate limiting middleware
 * For production with multiple servers, use Redis or a dedicated rate limiting service
 */
class RateLimitMiddleware implements MiddlewareInterface
{
    private int $maxRequests;
    private int $windowSeconds;
    private string $keyPrefix;
    private IpResolver $ipResolver;

    // In-memory storage (per-process, resets on restart)
    private static array $requests = [];
    private static int $requestCounter = 0;

    /**
     * @param int $maxRequests Maximum requests allowed in the time window
     * @param int $windowSeconds Time window in seconds
     * @param string $keyPrefix Prefix for rate limit keys (to separate different endpoints)
     */
    public function __construct(int $maxRequests = 60, int $windowSeconds = 60, string $keyPrefix = 'default')
    {
        $this->maxRequests = $maxRequests;
        $this->windowSeconds = $windowSeconds;
        $this->keyPrefix = $keyPrefix;
        $this->ipResolver = IpResolver::fromEnvironment();
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        $clientKey = $this->getClientKey($request);

        // Clean up expired entries for this client
        $this->cleanup($clientKey);

        // Periodically purge all expired entries to prevent unbounded memory growth
        self::$requestCounter++;
        if (self::$requestCounter % 100 === 0) {
            $this->purgeAllExpired();
        }

        // Check if rate limited
        if ($this->isRateLimited($clientKey)) {
            $retryAfter = $this->getRetryAfter($clientKey);

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

        // Record this request
        $this->recordRequest($clientKey);

        // Get remaining requests
        $remaining = $this->getRemainingRequests($clientKey);

        // Process the request
        $response = $handler->handle($request);

        // Add rate limit headers to response
        return $response
            ->withHeader('X-RateLimit-Limit', (string)$this->maxRequests)
            ->withHeader('X-RateLimit-Remaining', (string)$remaining)
            ->withHeader('X-RateLimit-Reset', (string)(time() + $this->windowSeconds));
    }

    /**
     * Get a unique key for this client based on IP address.
     * Uses IpResolver which only trusts X-Forwarded-For from configured trusted proxies,
     * preventing IP spoofing attacks that could bypass rate limiting.
     */
    private function getClientKey(Request $request): string
    {
        $ip = $this->ipResolver->getClientIp($request);
        return $this->keyPrefix . ':' . hash('sha256', $ip);
    }

    /**
     * Check if the client is rate limited
     */
    private function isRateLimited(string $key): bool
    {
        $requests = self::$requests[$key] ?? [];
        return count($requests) >= $this->maxRequests;
    }

    /**
     * Get seconds until rate limit resets
     */
    private function getRetryAfter(string $key): int
    {
        $requests = self::$requests[$key] ?? [];
        if (empty($requests)) {
            return 0;
        }

        $oldestRequest = min($requests);
        $resetTime = $oldestRequest + $this->windowSeconds;
        return max(0, $resetTime - time());
    }

    /**
     * Record a request for this client
     */
    private function recordRequest(string $key): void
    {
        if (!isset(self::$requests[$key])) {
            self::$requests[$key] = [];
        }
        self::$requests[$key][] = time();
    }

    /**
     * Get remaining requests for this client
     */
    private function getRemainingRequests(string $key): int
    {
        $requests = self::$requests[$key] ?? [];
        return max(0, $this->maxRequests - count($requests));
    }

    /**
     * Clean up expired requests for a specific key
     */
    private function cleanup(string $key): void
    {
        if (!isset(self::$requests[$key])) {
            return;
        }

        $cutoff = time() - $this->windowSeconds;
        self::$requests[$key] = array_filter(
            self::$requests[$key],
            fn($timestamp) => $timestamp > $cutoff
        );

        if (empty(self::$requests[$key])) {
            unset(self::$requests[$key]);
        }
    }

    /**
     * Purge all expired entries across all keys to prevent unbounded memory growth
     * from one-time visitors whose entries would otherwise never be cleaned up.
     */
    private function purgeAllExpired(): void
    {
        $cutoff = time() - $this->windowSeconds;
        foreach (self::$requests as $key => $timestamps) {
            $filtered = array_filter($timestamps, fn($ts) => $ts > $cutoff);
            if (empty($filtered)) {
                unset(self::$requests[$key]);
            } else {
                self::$requests[$key] = $filtered;
            }
        }
    }
}
