<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\FlowService;
use FormLogic\Services\Flows\FlowCompiler;
use FormLogic\Services\Packages\PackageV2InstallService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * POST /api/flows/{flowId}/compile — RUN-301 first slice (plan §13.2): server-authoritative
 * compilation of an OWNED flow. Returns diagnostics, the canonical IR preview, and the
 * definition locks. READ-ONLY: nothing is persisted; wiring compiled IR into run
 * reservation/revision pinning is the next RUN-301 slice.
 */
class FlowCompileController
{
    use JsonResponseTrait;

    public function __construct(
        private FlowService $flowService,
        private ?PackageV2InstallService $packageV2 = null,
    ) {
    }

    public function compile(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $flowId = (string) ($args['flowId'] ?? '');
        if ($flowId === '') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Flow ID is required'], 400);
        }
        // Ownership-gated fetch (workspace + app flows alike); missing/foreign = identical 404.
        $flow = $this->flowService->getOwnedFlow($userId, $flowId);
        if ($flow === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Flow not found'], 404);
        }

        $installedByType = [];
        if ($this->packageV2 !== null) {
            foreach ($this->packageV2->listDefinitions($userId) as $entry) {
                if ($entry['enabled'] === true) {
                    $installedByType[$entry['type']] = [
                        'definition' => $entry['definition'],
                        'digest' => $entry['digest'],
                        'version' => $entry['version'],
                        'packageId' => $entry['packageId'],
                    ];
                }
            }
        }

        $graph = is_array($flow['flowJson'] ?? null) ? $flow['flowJson'] : ['nodes' => [], 'edges' => []];
        $result = FlowCompiler::compile($graph, $installedByType);
        return $this->jsonResponse($response, [
            'ok' => $result['ok'],
            'irVersion' => FlowCompiler::IR_VERSION,
            'irDigest' => $result['irDigest'],
            'ir' => $result['ir'],
            'locks' => $result['locks'],
            'diagnostics' => $result['diagnostics'],
        ]);
    }
}
