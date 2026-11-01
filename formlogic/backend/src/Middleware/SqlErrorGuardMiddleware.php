<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

use FormLogic\Support\SqlErrorText;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;
use Psr\Log\LoggerInterface;
use Slim\Psr7\Factory\StreamFactory;

/**
 * What a client hears of a database error. A PDOException is a RuntimeException, and about a
 * hundred catch blocks answer those with the message as a 400, so raw SQL went out, and a client
 * reads a 400 as final. This sits outside everything: an error whose body carries SQL text is
 * logged and answered in plain words, and a busy database says to try again.
 *
 * A response that is an error but not a database's stays as it was.
 */
final class SqlErrorGuardMiddleware implements MiddlewareInterface
{
    /** An error is short, and nothing bigger is read into memory to find out that it isn't one. */
    private const MAX_BODY_BYTES = 1048576;

    /** On these an app answers for itself, and what it says is its own text, whatever it says. */
    private const APP_ANSWERS = '#^/api/app/[^/]+/(?:actions/|native(?:/|$))#';

    public function __construct(private LoggerInterface $logger)
    {
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        $response = $handler->handle($request);
        if ($response->getStatusCode() < 400 || preg_match(self::APP_ANSWERS, $request->getUri()->getPath()) === 1) {
            return $response;
        }
        $body = $response->getBody();
        $size = $body->getSize();
        if ($size === null || $size > self::MAX_BODY_BYTES || !$body->isSeekable()) {
            return $response;
        }
        $body->rewind();
        $text = $body->getContents();
        $body->rewind();
        if (!str_contains($text, 'SQLSTATE[')) {
            return $response;
        }

        $this->logger->error('A database error reached a response', [
            'method' => $request->getMethod(),
            'path' => $request->getUri()->getPath(),
            'status' => $response->getStatusCode(),
            'body' => substr($text, 0, 2000),
        ]);

        if (SqlErrorText::isBusy($text)) {
            return $this->answer($response, 503, ['error' => true, 'retryable' => true,
                'message' => 'The server is busy. Please try again in a moment.'])->withHeader('Retry-After', '2');
        }
        return $this->answer($response, 500, ['error' => true, 'message' => 'An unexpected error occurred']);
    }

    /** @param array<string, mixed> $payload */
    private function answer(Response $response, int $status, array $payload): Response
    {
        return $response->withStatus($status)
            ->withHeader('Content-Type', 'application/json')
            ->withoutHeader('Content-Length')
            ->withBody((new StreamFactory())->createStream((string) json_encode($payload)));
    }
}
