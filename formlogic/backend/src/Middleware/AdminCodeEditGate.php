<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

use FormLogic\Support\AdminActingLimits;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;
use Slim\Psr7\Response as SlimResponse;

/** The acting-as routes that write code that runs on records: see AdminActingLimits::codeRefusal. */
class AdminCodeEditGate implements MiddlewareInterface
{
    public function process(Request $request, RequestHandler $handler): Response
    {
        if (AdminActingLimits::mayEditCode($request)) {
            return $handler->handle($request);
        }
        $response = new SlimResponse();
        $response->getBody()->write((string) json_encode(AdminActingLimits::SUPPORT_ACCESS_REFUSAL));
        return $response->withStatus(403)->withHeader('Content-Type', 'application/json');
    }
}
