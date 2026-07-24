<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\CloudFlowRunner;
use FormLogic\Services\FlowService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Flow run dispatcher (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md §5.7, Phase 5):
 * POST /api/flows/{id}/run honors the flow's execution_location —
 *   - 'auto'    → typed 409 use_browser_runner: the site runs those client-side as today
 *                 (the browser runner + the existing reserve/complete run log); this route
 *                 never executes them server-side;
 *   - 'desktop' → the flow runs on the linked desktop via the E2E relay lane. Flow inputs
 *                 are sensitive, so the browser seals them with the tunnel session and this
 *                 route only accepts the ALREADY-SEALED envelope passthrough (delegated to
 *                 DesktopFlowRelayController::enqueue). A plaintext request gets a typed
 *                 409 pointing at the sealed route;
 *   - 'cloud'   → runs synchronously in CloudFlowRunner against plan credits (typed 402
 *                 flow_credits_exceeded when spent; 422 cloud_unsupported_node with the
 *                 offending-node list when the graph is not cloud-eligible — no credit is
 *                 consumed by either refusal).
 *
 * The owner gate mirrors the rest of /api/flows: the session user must OWN the flow
 * (workspace and app flows alike — FlowService::getOwnedFlow).
 */
class FlowRunController
{
    use JsonResponseTrait;

    public function __construct(
        private FlowService $flows,
        private CloudFlowRunner $cloudRunner,
        private DesktopFlowRelayController $flowRelay,
    ) {}

    public function run(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonError($response, 'Authentication required', 401);
        }
        $flowId = (string) ($args['flowId'] ?? '');
        $flow = $this->flows->getOwnedFlow((string) $userId, $flowId);
        if ($flow === null) {
            return $this->jsonError($response, 'Flow not found', 404);
        }

        $body = $request->getParsedBody() ?? [];
        if (!is_array($body)) {
            $body = [];
        }
        $location = (string) ($flow['executionLocation'] ?? 'auto');

        if ($location === 'auto') {
            return $this->jsonError(
                $response,
                'This flow is set to run Automatically — run it from the browser flow editor (the site runs Auto flows client-side).',
                409,
                'use_browser_runner',
            );
        }

        if ($location === 'desktop') {
            $hasEph = is_string($body['ephPub'] ?? null) && $body['ephPub'] !== '';
            $hasEnvelope = is_string($body['envelope'] ?? null) && $body['envelope'] !== '';
            if (!$hasEph && !$hasEnvelope) {
                return $this->jsonError(
                    $response,
                    'This flow runs on your FormLogic Desktop — its inputs must be sealed in the browser first. Run it from the flow editor (or POST the sealed envelope to /api/desktop/flows/run).',
                    409,
                    'use_desktop_relay',
                );
            }
            // Sealed passthrough: the flow identity comes from the ROUTE, never the body.
            $body['flowId'] = $flowId;
            return $this->flowRelay->enqueue($request->withParsedBody($body), $response);
        }

        // 'cloud'
        $inputs = $body['inputs'] ?? [];
        if (!is_array($inputs)) {
            return $this->jsonError($response, 'inputs must be an object', 400);
        }

        // Save-time preflights can go stale (the graph may have gained an unsupported node
        // after the location was chosen) — re-check before any credit is touched. RUN-301:
        // checked over the EFFECTIVE graph (the revision's compiled IR when present), so a
        // contributed node that lowers to a cloud-supported core type passes here.
        $offenders = CloudFlowRunner::validateCloudEligible($this->cloudRunner->effectiveGraph($flow));
        if ($offenders !== []) {
            return $this->jsonError(
                $response,
                'This flow cannot run in FormLogic Cloud — it contains nodes the cloud runner does not support.',
                422,
                'cloud_unsupported_node',
                ['nodes' => $offenders],
            );
        }

        try {
            $outcome = $this->cloudRunner->run($flow, (string) $userId, $inputs);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400);
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'flow_credits_exceeded') {
                return $this->jsonError(
                    $response,
                    'You have used this month\'s cloud flow-run credits — switch the flow to Desktop or wait for the new month.',
                    402,
                    'flow_credits_exceeded',
                );
            }
            throw $e;
        }

        if (($outcome['ok'] ?? false) !== true) {
            // Defensive: the controller preflight above should have caught this first.
            return $this->jsonError(
                $response,
                'This flow cannot run in FormLogic Cloud — it contains nodes the cloud runner does not support.',
                422,
                'cloud_unsupported_node',
                ['nodes' => $outcome['nodes'] ?? []],
            );
        }
        return $this->jsonResponse($response, [
            'runId' => $outcome['runId'],
            'status' => $outcome['status'],
            'result' => $outcome['result'] ?? null,
            'error' => $outcome['error'] ?? null,
            'executionLocation' => 'cloud',
        ]);
    }
}
