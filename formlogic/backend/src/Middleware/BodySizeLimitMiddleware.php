<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;
use Slim\Psr7\Response as SlimResponse;

/**
 * Middleware to limit request body size
 * Prevents large payload DoS attacks
 */
class BodySizeLimitMiddleware implements MiddlewareInterface
{
    private int $maxBytes;

    /**
     * @param int $maxBytes Maximum allowed request body size in bytes (default 1MB)
     */
    public function __construct(int $maxBytes = 1024 * 1024)
    {
        $this->maxBytes = $maxBytes;
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        // Check Content-Length header first (fast path)
        $contentLength = $request->getHeaderLine('Content-Length');
        if ($contentLength !== '' && (int)$contentLength > $this->maxBytes) {
            return $this->payloadTooLarge();
        }

        // For chunked transfers or when Content-Length is missing,
        // check actual body size
        $body = $request->getBody();
        $size = $body->getSize();

        // If size is known and exceeds limit
        if ($size !== null && $size > $this->maxBytes) {
            return $this->payloadTooLarge();
        }

        // If size is unknown (streaming), count it in CHUNKS up to limit + 1.
        // A single read($maxBytes + 1) allocates the whole limit as one PHP
        // string — with the backup-sized limit (~216MB) that exceeds
        // memory_limit and fatals every unknown-size request (incl. GETs whose
        // php://input size is unreported). 1MB chunks keep memory flat.
        if ($size === null) {
            $body->rewind();
            $total = 0;
            while (!$body->eof()) {
                $chunk = $body->read(1024 * 1024);
                if ($chunk === '') {
                    break;
                }
                $total += strlen($chunk);
                if ($total > $this->maxBytes) {
                    return $this->payloadTooLarge();
                }
            }
            // Rewind for downstream handlers
            $body->rewind();
        }

        return $handler->handle($request);
    }

    private function payloadTooLarge(): Response
    {
        $response = new SlimResponse();
        $response->getBody()->write(json_encode([
            'error' => true,
            'message' => 'Request body too large',
            'maxSize' => $this->maxBytes,
            'maxSizeHuman' => $this->formatBytes($this->maxBytes),
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
