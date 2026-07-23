<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\DataAccountBackupService;
use FormLogic\Services\DataCloudSigner;
use FormLogic\Services\DataSnapshotService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Desktop-facing data-node control surface — N2 subset (plan §21.2;
 * docs/FORMLOGIC_DATA_NODES.md §9). Authenticated by the desktop flk_ API key.
 *
 * Two authority tiers (review FL-001):
 *  - ENROLMENT tier (register, self, signing-key, eligible-forms): scope
 *    `data:snapshot` (legacy `connector:relay` grandfathered) — this is the
 *    chicken-and-egg surface a desktop needs BEFORE the owner approves it.
 *  - DATA-PLANE tier (snapshot build/download/delete, whole-account backup):
 *    additionally requires the API key to resolve — via its desktop
 *    connection — to an APPROVED data node with a valid, unexpired
 *    owner-signed certificate granting `storage`. A legacy relay key alone
 *    can never export data; every failure mode is the same opaque 403.
 *    `connector:relay` on this tier is a documented migration shim and goes
 *    away once enrolment mints least-privilege `data:snapshot` keys.
 *
 * Staged artifacts (snapshots + sealed account backups) are additionally
 * bound to their owner in data_staged_artifacts (review FL-002): GET/DELETE
 * of another tenant's artifact ID is indistinguishable from a missing ID.
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
        private DataAccountBackupService $accountBackups,
        private \FormLogic\Services\DataNodeService $nodes,
        private bool $dataNodesEnabled,
    ) {
    }

    /** POST /api/v1/data-node/register — enrol/heartbeat this desktop's node identity. */
    public function register(Request $request, Response $response): Response
    {
        if (($gate = $this->gate($request, $response)) !== null) {
            return $gate;
        }
        $userId = (string) $request->getAttribute('userId');
        $apiKeyId = (string) $request->getAttribute('apiKeyId');
        $body = json_decode((string) $request->getBody(), true);
        if (!is_array($body)) {
            return $this->jsonError($response, 'A JSON body is required', 400, 'invalid_request');
        }
        try {
            $node = $this->nodes->register($userId, $apiKeyId, $body);
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'data_node_no_connection') {
                return $this->jsonError($response, 'No desktop connection matches this API key', 409, 'data_node_no_connection');
            }
            if ($e->getMessage() === 'data_node_bad_key') {
                return $this->jsonError($response, 'signingPublicKey must be a base64 Ed25519 public key', 400, 'data_node_bad_key');
            }
            throw $e;
        }
        return $this->jsonResponse($response, ['data' => ['node' => $node]]);
    }

    /** GET /api/v1/data-node/self — this desktop's node record (approval state). */
    public function self(Request $request, Response $response): Response
    {
        if (($gate = $this->gate($request, $response)) !== null) {
            return $gate;
        }
        $userId = (string) $request->getAttribute('userId');
        $apiKeyId = (string) $request->getAttribute('apiKeyId');
        return $this->jsonResponse($response, ['data' => ['node' => $this->nodes->selfForConnection($userId, $apiKeyId)]]);
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
        $node = $this->approvedNode($request, $response);
        if ($node instanceof Response) {
            return $node;
        }
        $userId = (string) $request->getAttribute('userId');
        $body = json_decode((string) $request->getBody(), true);
        $formId = is_array($body) ? (string) ($body['formId'] ?? '') : '';
        if ($formId === '' || !preg_match('/^[0-9a-f-]{1,64}$/', $formId)) {
            return $this->jsonError($response, 'formId is required', 400, 'invalid_request');
        }
        try {
            $result = $this->snapshots->createSnapshot($userId, $formId, (string) $node['id']);
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
        $node = $this->approvedNode($request, $response);
        if ($node instanceof Response) {
            return $node;
        }
        $userId = (string) $request->getAttribute('userId');
        $snapshotId = (string) ($args['id'] ?? '');
        $params = $request->getQueryParams();
        $path = (string) ($params['path'] ?? '');
        $file = $this->snapshots->snapshotFilePath($userId, $snapshotId, $path);
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
        $node = $this->approvedNode($request, $response);
        if ($node instanceof Response) {
            return $node;
        }
        $userId = (string) $request->getAttribute('userId');
        if (!$this->snapshots->deleteSnapshotOwned($userId, (string) ($args['id'] ?? ''))) {
            return $this->jsonError($response, 'Unknown snapshot', 404, 'snapshot_not_found');
        }
        return $this->jsonResponse($response, ['data' => ['ok' => true]]);
    }

    public function createAccountBackup(Request $request, Response $response): Response
    {
        if (($gate = $this->gate($request, $response)) !== null) {
            return $gate;
        }
        $node = $this->approvedNode($request, $response);
        if ($node instanceof Response) {
            return $node;
        }
        $userId = (string) $request->getAttribute('userId');
        $body = json_decode((string) $request->getBody(), true);
        if (!is_array($body)) {
            return $this->jsonError($response, 'A JSON body is required', 400, 'invalid_request');
        }
        try {
            $result = $this->accountBackups->create($userId, $body, $node);
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'account_backup_bad_ephemeral_key') {
                return $this->jsonError($response, 'ephemeralPk must be a base64 X25519 public key', 400, 'account_backup_bad_ephemeral_key');
            }
            if ($e->getMessage() === 'account_backup_key_unbound') {
                return $this->jsonError(
                    $response,
                    'The transfer key must carry a fresh signature by this node\'s enrolled signing key',
                    403,
                    'account_backup_key_unbound',
                );
            }
            if ($e->getMessage() === 'account_backup_too_large') {
                return $this->jsonError($response, 'Account backup exceeds the transfer cap', 413, 'account_backup_too_large');
            }
            throw $e;
        }
        return $this->jsonResponse($response, ['data' => $result], 201);
    }

    public function accountBackupPayload(Request $request, Response $response, array $args): Response
    {
        if (($gate = $this->gate($request, $response)) !== null) {
            return $gate;
        }
        $node = $this->approvedNode($request, $response);
        if ($node instanceof Response) {
            return $node;
        }
        $userId = (string) $request->getAttribute('userId');
        $path = $this->accountBackups->payloadPath($userId, (string) ($args['id'] ?? ''));
        if ($path === null) {
            return $this->jsonError($response, 'Unknown account backup', 404, 'account_backup_not_found');
        }
        $stream = fopen($path, 'rb');
        if ($stream === false) {
            return $this->jsonError($response, 'Could not read the sealed payload', 500);
        }
        return $response
            ->withBody(new \Slim\Psr7\Stream($stream))
            ->withHeader('Content-Type', 'application/octet-stream')
            ->withHeader('Content-Length', (string) (int) filesize($path))
            ->withHeader('Cache-Control', 'no-store');
    }

    public function deleteAccountBackup(Request $request, Response $response, array $args): Response
    {
        if (($gate = $this->gate($request, $response)) !== null) {
            return $gate;
        }
        $node = $this->approvedNode($request, $response);
        if ($node instanceof Response) {
            return $node;
        }
        $userId = (string) $request->getAttribute('userId');
        if (!$this->accountBackups->deleteOwned($userId, (string) ($args['id'] ?? ''))) {
            return $this->jsonError($response, 'Unknown account backup', 404, 'account_backup_not_found');
        }
        return $this->jsonResponse($response, ['data' => ['ok' => true]]);
    }

    /** Feature flag + scope — the ENROLMENT tier gate. */
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

    /**
     * DATA-PLANE tier: resolve the key's approved node or refuse uniformly.
     * Every failure (no node, pending, revoked, expired certificate, missing
     * capability, foreign key) is the same 403 — no enrolment-state oracle.
     *
     * @return array<string,mixed>|Response
     */
    private function approvedNode(Request $request, Response $response): array|Response
    {
        $userId = (string) $request->getAttribute('userId');
        $apiKeyId = (string) $request->getAttribute('apiKeyId');
        try {
            return $this->nodes->resolveApprovedNode($userId, $apiKeyId);
        } catch (\RuntimeException) {
            return $this->jsonError(
                $response,
                'This API key is not bound to an approved data node',
                403,
                'data_node_unauthorized',
            );
        }
    }
}
