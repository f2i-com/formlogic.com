<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

use FormLogic\Support\AdminActingLimits;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;
use Slim\Psr7\Response as SlimResponse;

/**
 * The acting-as routes that write code that runs on records: see AdminActingLimits::codeRefusal.
 * $flowSwitch marks a route where a request that only pauses the flow needs no leave.
 */
class AdminCodeEditGate implements MiddlewareInterface
{
    public function __construct(private bool $flowSwitch = false)
    {
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        if (AdminActingLimits::mayEditCode($request) || ($this->flowSwitch && AdminActingLimits::onlyPausesFlow($request->getParsedBody()))) {
            return $handler->handle($request);
        }
        $response = new SlimResponse();
        $response->getBody()->write((string) json_encode(AdminActingLimits::SUPPORT_ACCESS_REFUSAL));
        return $response->withStatus(403)->withHeader('Content-Type', 'application/json');
    }
}
