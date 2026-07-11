<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;
use Slim\Psr7\Factory\StreamFactory;

/**
 * Strips record data from flow-run payloads on the admin acting-as mirror.
 *
 * Flow runs journal the triggering event (FlowService::formatRun's
 * inputSnapshot — which for form.submitted contains the submission answers),
 * plus result/outputActions/error blobs produced from it. Administrators may
 * see run METADATA (status, timing, which flow/binding/response) but never
 * those snapshots — that's the platform's no-response-data boundary.
 *
 * WHITELIST rebuild, not a blacklist: a future field added to formatRun stays
 * hidden here until deliberately allowed. Non-run top-level keys (page, limit,
 * total, claimed, ...) pass through untouched.
 */
class AdminRunLogRedactionMiddleware implements MiddlewareInterface
{
    private const RUN_FIELDS = [
        'runId', 'appId', 'formId', 'responseId', 'bindingId', 'flowDefinitionId',
        'flow', 'triggerEvent', 'correlationId', 'idempotencyKey', 'status',
        'runtime', 'claimedBy', 'startedAt', 'finishedAt', 'createdAt',
    ];

    public function process(Request $request, RequestHandler $handler): Response
    {
        $response = $handler->handle($request);

        $contentType = $response->getHeaderLine('Content-Type');
        if (stripos($contentType, 'application/json') === false) {
            return $response;
        }
        $body = (string) $response->getBody();
        $data = json_decode($body, true);
        if (!is_array($data) || (!isset($data['run']) && !isset($data['runs']))) {
            return $response;
        }

        if (isset($data['run']) && is_array($data['run'])) {
            $data['run'] = $this->redactRun($data['run']);
        }
        if (isset($data['runs']) && is_array($data['runs'])) {
            $data['runs'] = array_map(
                fn ($run) => is_array($run) ? $this->redactRun($run) : $run,
                $data['runs']
            );
        }

        return $response->withBody(
            (new StreamFactory())->createStream((string) json_encode($data))
        );
    }

    private function redactRun(array $run): array
    {
        $clean = array_intersect_key($run, array_flip(self::RUN_FIELDS));
        $clean['hasError'] = !empty($run['error']);
        $clean['redacted'] = true;
        return $clean;
    }
}
