<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\DataCloudSigner;
use FormLogic\Services\DataSnapshotService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Desktop-facing data-node control surface — N2 subset (plan §21.2;
 * docs/FORMLOGIC_DATA_NODES.md §9): Cloud signing identity, snapshot-eligible
 * Private forms, snapshot build/download/delete. Authenticated by the desktop
 * flk_ API key; scope `data:snapshot`, with legacy `connector:relay` keys
 * grandfathered until the N3 node-enrolment flow mints least-privilege
 * data-plane scopes (same posture as the AI/flow relays).
 *
 * Everything is gated on the DATA_NODES flag (403 data_nodes_disabled while
 * off) and scoped to the authenticated key's own user.
 */
final class DataNodeController
{
    use JsonResponseTrait;

    public function __construct(
        private DataSnapshotService $snapshots,
        private DataCloudSigner $signer,
        private bool $dataNodesEnabled,
    ) {
    }

    public function signingKey(Request $request, Response $response): Response
    {
        if (($gate = $this->gate($request, $response)) !== null) {
            return $gate;
        }
        return $this->jsonResponse($response, ['data' => $this->signer->publicIdentity()]);
    }

    public function eligibleForms(Request $request, Response $response): Response
    {
        if (($gate = $this->gate($request, $response)) !== null) {
            return $gate;
        }
        $userId = (string) $request->getAttribute('userId');
        return $this->jsonResponse($response, ['data' => ['forms' => $this->snapshots->eligibleForms($userId)]]);
    }

    public function createSnapshot(Request $request, Response $response): Response
    {
        if (($gate = $this->gate($request, $response)) !== null) {
            return $gate;
        }
        $userId = (string) $request->getAttribute('userId');
        $body = json_decode((string) $request->getBody(), true);
        $formId = is_array($body) ? (string) ($body['formId'] ?? '') : '';
        if ($formId === '' || !preg_match('/^[0-9a-f-]{1,64}$/', $formId)) {
            return $this->jsonError($response, 'formId is required', 400, 'invalid_request');
        }
        try {
            $result = $this->snapshots->createSnapshot($userId, $formId);
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'snapshot_form_ineligible') {
                return $this->jsonError(
                    $response,
                    'Only your own Private forms can be snapshotted to a data node',
                    422,
                    'snapshot_form_ineligible',
                );
            }
            if ($e->getMessage() === 'snapshot_too_large') {
                return $this->jsonError($response, 'Snapshot exceeds the N2 package cap', 413, 'snapshot_too_large');
            }
            throw $e;
        }
        return $this->jsonResponse($response, ['data' => $result], 201);
    }

    public function snapshotFile(Request $request, Response $response, array $args): Response
    {
        if (($gate = $this->gate($request, $response)) !== null) {
            return $gate;
        }
        $snapshotId = (string) ($args['id'] ?? '');
        $params = $request->getQueryParams();
        $path = (string) ($params['path'] ?? '');
        $file = $this->snapshots->snapshotFilePath($snapshotId, $path);
        if ($file === null) {
            return $this->jsonError($response, 'Unknown snapshot file', 404, 'snapshot_file_not_found');
        }
        $bytes = (string) file_get_contents($file);
        $response->getBody()->write($bytes);
        return $response
            ->withHeader('Content-Type', 'application/octet-stream')
            ->withHeader('Cache-Control', 'no-store');
    }

    public function deleteSnapshot(Request $request, Response $response, array $args): Response
    {
        if (($gate = $this->gate($request, $response)) !== null) {
            return $gate;
        }
        $this->snapshots->deleteSnapshot((string) ($args['id'] ?? ''));
        return $this->jsonResponse($response, ['data' => ['ok' => true]]);
    }

    private function gate(Request $request, Response $response): ?Response
    {
        if (!$this->dataNodesEnabled) {
            return $this->jsonError($response, 'Encrypted data nodes are not enabled', 403, 'data_nodes_disabled');
        }
        /** @var list<string> $scopes */
        $scopes = (array) $request->getAttribute('apiKeyScopes', []);
        if (!in_array('data:snapshot', $scopes, true) && !in_array('connector:relay', $scopes, true)) {
            return $this->jsonError($response, 'This API key lacks the data:snapshot scope', 403, 'insufficient_scope');
        }
        return null;
    }
}
