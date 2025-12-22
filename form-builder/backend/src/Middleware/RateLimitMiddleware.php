<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

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

    // In-memory storage (per-process, resets on restart)
    private static array $requests = [];

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
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        $clientKey = $this->getClientKey($request);

        // Clean up expired entries
        $this->cleanup($clientKey);

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
     * Get a unique key for this client based on IP address
     */
    private function getClientKey(Request $request): string
    {
        $serverParams = $request->getServerParams();

        // Check common proxy headers
        $ip = null;
        $headers = ['HTTP_X_FORWARDED_FOR', 'HTTP_X_REAL_IP', 'HTTP_CLIENT_IP'];
        foreach ($headers as $header) {
            if (!empty($serverParams[$header])) {
                $ips = explode(',', $serverParams[$header]);
                $ip = trim($ips[0]);
                if (filter_var($ip, FILTER_VALIDATE_IP)) {
                    break;
                }
                $ip = null;
            }
        }

        $ip = $ip ?? $serverParams['REMOTE_ADDR'] ?? '127.0.0.1';

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
     * Clean up expired requests
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
}
