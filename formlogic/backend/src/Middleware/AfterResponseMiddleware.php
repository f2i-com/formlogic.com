<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

use FormLogic\Support\AfterResponse;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;

/**
 * On a server with no call that ends the answer, an answer with work to follow says how long it is
 * and closes the connection, so the client is done when it has read it (see AfterResponse). A
 * compressed answer has no length to state: mod_deflate would keep it open until the work was done.
 */
final class AfterResponseMiddleware implements MiddlewareInterface
{
    public function process(Request $request, RequestHandlerInterface $handler): Response
    {
        $response = $handler->handle($request);
        if (!AfterResponse::pending() || AfterResponse::serverCanFinish()) {
            return $response;
        }
        $size = $response->getBody()->getSize();
        if ($size === null) {
            return $response;
        }
        if (function_exists('apache_setenv')) {
            apache_setenv('no-gzip', '1');
        }
        if (function_exists('ini_set')) {
            @ini_set('zlib.output_compression', '0');
        }
        return $response
            ->withHeader('Content-Length', (string) $size)
            ->withHeader('Connection', 'close');
    }
}
