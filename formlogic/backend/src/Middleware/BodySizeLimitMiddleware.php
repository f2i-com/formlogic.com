<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;
use Slim\Psr7\Response as SlimResponse;
use FormLogic\Services\AuthService;

/**
 * Middleware to limit request body size
 * Prevents large payload DoS attacks
 */
class BodySizeLimitMiddleware implements MiddlewareInterface
{
    private int $maxBytes;
    private array $routePolicies;
    private ?AuthService $authService;
    private string $cookieName;

    /**
     * @param int $maxBytes Maximum allowed request body size in bytes (default 1MB)
     */
    public function __construct(
        int $maxBytes = 1024 * 1024,
        array $routePolicies = [],
        ?AuthService $authService = null,
        string $cookieName = 'formlogic_auth'
    )
    {
        $this->maxBytes = $maxBytes;
        $this->routePolicies = $routePolicies;
        $this->authService = $authService;
        $this->cookieName = $cookieName;
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        [$maxBytes, $requiresAuth] = $this->limitFor($request);
        if ($requiresAuth && !$this->hasValidSession($request)) {
            return $this->unauthorized();
        }
        // Check Content-Length header first (fast path)
        $contentLength = $request->getHeaderLine('Content-Length');
        if ($contentLength !== '' && (int)$contentLength > $maxBytes) {
            return $this->payloadTooLarge($maxBytes);
        }

        // For chunked transfers or when Content-Length is missing,
        // check actual body size
        $body = $request->getBody();
        $size = $body->getSize();

        // If size is known and exceeds limit
        if ($size !== null && $size > $maxBytes) {
            return $this->payloadTooLarge($maxBytes);
        }

        // If size is unknown (streaming), count it in CHUNKS up to limit + 1.
        // A single read($maxBytes + 1) allocates the whole limit as one PHP
        // string. Large authenticated route policies can exceed PHP's memory
        // limit, while 1MB chunks keep counting memory-flat.
        if ($size === null) {
            $body->rewind();
            $total = 0;
            while (!$body->eof()) {
                $chunk = $body->read(1024 * 1024);
                if ($chunk === '') {
                    break;
                }
                $total += strlen($chunk);
                if ($total > $maxBytes) {
                    return $this->payloadTooLarge($maxBytes);
                }
            }
            // Rewind for downstream handlers
            $body->rewind();
        }

        return $handler->handle($request);
    }

    /** @return array{0:int,1:bool} */
    private function limitFor(Request $request): array
    {
        $path = $request->getUri()->getPath();
        $method = strtoupper($request->getMethod());
        $contentType = strtolower(trim(explode(';', $request->getHeaderLine('Content-Type'), 2)[0]));
        foreach ($this->routePolicies as $policy) {
            if (($policy['method'] ?? 'POST') !== $method
                || !preg_match((string) ($policy['path'] ?? '//'), $path)
                || !in_array($contentType, $policy['contentTypes'] ?? [], true)
            ) {
                continue;
            }
            return [(int) ($policy['maxBytes'] ?? $this->maxBytes), (bool) ($policy['auth'] ?? false)];
        }
        return [$this->maxBytes, false];
    }

    private function hasValidSession(Request $request): bool
    {
        if ($this->authService === null) {
            return false;
        }
        $token = null;
        if (preg_match('/^Bearer\s+(.+)$/i', $request->getHeaderLine('Authorization'), $match)) {
            $token = trim($match[1]);
        }
        if ($token === null || $token === '') {
            $token = $request->getCookieParams()[$this->cookieName] ?? null;
        }
        return is_string($token) && $token !== '' && $this->authService->validateToken($token) !== null;
    }

    private function unauthorized(): Response
    {
        $response = new SlimResponse();
        $response->getBody()->write(json_encode(['error' => true, 'message' => 'Authentication required']));
        return $response->withStatus(401)->withHeader('Content-Type', 'application/json');
    }

    private function payloadTooLarge(int $maxBytes): Response
    {
        $response = new SlimResponse();
        $response->getBody()->write(json_encode([
            'error' => true,
            'message' => 'Request body too large',
            'maxSize' => $maxBytes,
            'maxSizeHuman' => $this->formatBytes($maxBytes),
        ]));

        return $response
            ->withStatus(413)
            ->withHeader('Content-Type', 'application/json');
    }

    private function formatBytes(int $bytes): string
    {
        if ($bytes >= 1024 * 1024) {
            return round($bytes / (1024 * 1024), 1) . 'MB';
        }
        if ($bytes >= 1024) {
            return round($bytes / 1024, 1) . 'KB';
        }
        return $bytes . ' bytes';
    }
}
