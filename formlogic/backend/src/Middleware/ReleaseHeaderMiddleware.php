<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;

/**
 * Tells a page which release answered. A tab left open runs old code against the new server, and
 * nothing else tells it so (ui/src/lib/newRelease.ts). The answer comes from the packaged VERSION
 * file and not the database, because this runs on every reply. A source checkout has no such file,
 * and a page built from no release has nothing to compare with, so neither says anything.
 */
class ReleaseHeaderMiddleware implements MiddlewareInterface
{
    public const HEADER = 'X-FormLogic-Release';

    public function __construct(private string $versionFile)
    {
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        $response = $handler->handle($request);
        $release = trim((string) @file_get_contents($this->versionFile));
        // Slim throws on a header it can't send, and a damaged file must not cost every reply.
        return preg_match('/^[\w.+-]{1,64}$/D', $release) === 1 ? $response->withHeader(self::HEADER, $release) : $response;
    }
}
