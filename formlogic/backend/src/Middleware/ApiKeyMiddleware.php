<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

use FormLogic\Services\ApiKeyService;
use FormLogic\Services\RateLimiter;
use FormLogic\Helpers\IpResolver;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;
use Slim\Psr7\Response as SlimResponse;

class ApiKeyMiddleware implements MiddlewareInterface
{
    private ApiKeyService $apiKeyService;
    private array $requiredScopes;
    private ?RateLimiter $rateLimiter;
    private int $perKeyLimit;
    private int $perKeyWindowSeconds;
    private string $perKeyBucket;

    /**
     * @param string $perKeyBucket Which per-key budget this route draws from. '' is the data
     *                             API's (counted as `apikey:<id>`, as it always was); any other
     *                             name is a budget of its own (`apikey:<bucket>:<id>`), so a
     *                             linked desktop's waiting polls and its record writes cannot
     *                             use up each other's allowance.
     */
    public function __construct(
        ApiKeyService $apiKeyService,
        array $requiredScopes = [],
        ?RateLimiter $rateLimiter = null,
        int $perKeyLimit = 120,
        int $perKeyWindowSeconds = 60,
        string $perKeyBucket = ''
    ) {
        $this->apiKeyService = $apiKeyService;
        $this->requiredScopes = $requiredScopes;
        $this->rateLimiter = $rateLimiter;
        $this->perKeyLimit = $perKeyLimit;
        $this->perKeyWindowSeconds = $perKeyWindowSeconds;
        $this->perKeyBucket = $perKeyBucket;
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        $token = $this->extractToken($request);

        if ($token === null) {
            return $this->errorResponse(401, 'Missing or invalid Authorization header. Use: Bearer flk_...');
        }

        // Validate the key
        $keyData = $this->apiKeyService->validateKey($token);
        if ($keyData === null) {
            return $this->errorResponse(401, 'Invalid, expired, or revoked API key');
        }

        // Check required scopes
        foreach ($this->requiredScopes as $scope) {
            if (!in_array($scope, $keyData['scopes'], true)) {
                return $this->errorResponse(403, "Insufficient scope. Required: $scope");
            }
        }

        // Per-KEY rate limit (in addition to the coarse per-IP group limit). Counts
        // only authenticated, in-scope requests, so each key gets its own quota and
        // one tenant's traffic — or failed-auth noise on a shared egress IP — can't
        // starve another's valid key. Atomic via hit() (0 on storage error = fail open).
        if ($this->rateLimiter !== null) {
            $counter = $this->perKeyBucket === ''
                ? 'apikey:' . $keyData['id']
                : 'apikey:' . $this->perKeyBucket . ':' . $keyData['id'];
            $count = $this->rateLimiter->hit($counter, $this->perKeyWindowSeconds);
            if ($count > $this->perKeyLimit) {
                $retryAfter = $this->rateLimiter->secondsUntilReset($this->perKeyWindowSeconds);
                $response = new SlimResponse();
                $response->getBody()->write(json_encode([
                    'error' => true,
                    'message' => 'API key rate limit exceeded. Try again in ' . $retryAfter . 's.',
                    'code' => 'rate_limited',
                    'retryAfter' => $retryAfter,
                ]));
                return $response
                    ->withStatus(429)
                    ->withHeader('Content-Type', 'application/json')
                    ->withHeader('Retry-After', (string) $retryAfter)
                    ->withHeader('X-RateLimit-Limit', (string) $this->perKeyLimit)
                    ->withHeader('X-RateLimit-Remaining', '0')
                    ->withHeader('X-RateLimit-Reset', (string) (time() + $retryAfter));
            }
        }

        // Record usage (fire-and-forget, don't block on failure)
        $ip = $this->getClientIp($request);
        try {
            $this->apiKeyService->recordUsage($keyData['id'], $ip);
        } catch (\Exception $e) {
            // Non-critical, don't fail the request
        }

        // Set request attributes for downstream handlers
        $request = $request->withAttribute('userId', $keyData['userId']);
        $request = $request->withAttribute('apiKeyId', $keyData['id']);
        $request = $request->withAttribute('apiKeyScopes', $keyData['scopes']);
        $request = $request->withAttribute('apiKeyFormIds', $keyData['formIds']);

        return $handler->handle($request);
    }

    private function extractToken(Request $request): ?string
    {
        $authHeader = $request->getHeaderLine('Authorization');
        if (empty($authHeader)) {
            return null;
        }

        if (!preg_match('/^Bearer\s+(flk_[a-f0-9]{40})$/i', $authHeader, $matches)) {
            return null;
        }

        return $matches[1];
    }

    private function getClientIp(Request $request): string
    {
        return IpResolver::fromEnvironment()->getClientIp($request);
    }

    private function errorResponse(int $status, string $message): Response
    {
        $response = new SlimResponse();
        $response->getBody()->write(json_encode([
            'error' => true,
            'message' => $message,
        ]));

        return $response
            ->withStatus($status)
            ->withHeader('Content-Type', 'application/json');
    }
}
