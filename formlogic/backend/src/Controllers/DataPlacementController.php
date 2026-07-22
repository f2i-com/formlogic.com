<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\DataNodeService;
use FormLogic\Services\DataPlacementService;
use FormLogic\Services\VaultService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Session-auth data-node control surface for the OWNER (plan §21.1 subset):
 * node roster + approval/revocation, and the epoch-1 placement baseline.
 * Everything verifies against the owner's VAULT Ed25519 key server-side; the
 * signatures themselves are minted in the browser's crypto worker (the server
 * can verify but never sign for the owner). Gated on DATA_NODES; demo and
 * admin acting-as are refused like every other key-material surface.
 */
final class DataPlacementController
{
    use JsonResponseTrait;

    public function __construct(
        private DataNodeService $nodes,
        private DataPlacementService $placement,
        private VaultService $vaults,
        private bool $dataNodesEnabled,
    ) {
    }

    public function listNodes(Request $request, Response $response): Response
    {
        if (($gate = $this->gate($request, $response)) !== null) {
            return $gate;
        }
        $userId = (string) $request->getAttribute('userId');
        return $this->jsonResponse($response, ['data' => ['nodes' => $this->nodes->listForOwner($userId)]]);
    }

    public function approveNode(Request $request, Response $response, array $args): Response
    {
        if (($gate = $this->gate($request, $response, true)) !== null) {
            return $gate;
        }
        $userId = (string) $request->getAttribute('userId');
        $body = json_decode((string) $request->getBody(), true);
        $certificate = is_array($body) ? ($body['certificate'] ?? null) : null;
        if (!is_array($certificate)) {
            return $this->jsonError($response, 'certificate is required', 400, 'invalid_request');
        }
        $ownerPk = $this->ownerVaultPk($userId);
        if ($ownerPk === null) {
            return $this->jsonError($response, 'A vault is required to approve data nodes', 409, 'vault_required');
        }
        try {
            $node = $this->nodes->approve($userId, (string) ($args['id'] ?? ''), $certificate, $ownerPk);
        } catch (\RuntimeException $e) {
            return $this->nodeError($response, $e);
        }
        return $this->jsonResponse($response, ['data' => ['node' => $node]]);
    }

    public function revokeNode(Request $request, Response $response, array $args): Response
    {
        if (($gate = $this->gate($request, $response, true)) !== null) {
            return $gate;
        }
        $userId = (string) $request->getAttribute('userId');
        try {
            $node = $this->nodes->revoke($userId, (string) ($args['id'] ?? ''));
        } catch (\RuntimeException $e) {
            return $this->nodeError($response, $e);
        }
        return $this->jsonResponse($response, ['data' => ['node' => $node]]);
    }

    public function getPlacement(Request $request, Response $response, array $args): Response
    {
        if (($gate = $this->gate($request, $response)) !== null) {
            return $gate;
        }
        $userId = (string) $request->getAttribute('userId');
        try {
            $state = $this->placement->get((string) ($args['formId'] ?? ''), $userId);
        } catch (\RuntimeException $e) {
            return $this->nodeError($response, $e);
        }
        return $this->jsonResponse($response, ['data' => $state]);
    }

    public function putPlacement(Request $request, Response $response, array $args): Response
    {
        if (($gate = $this->gate($request, $response, true)) !== null) {
            return $gate;
        }
        $userId = (string) $request->getAttribute('userId');
        $body = json_decode((string) $request->getBody(), true);
        $manifest = is_array($body) ? ($body['manifest'] ?? null) : null;
        if (!is_array($manifest)) {
            return $this->jsonError($response, 'manifest is required', 400, 'invalid_request');
        }
        $ownerPk = $this->ownerVaultPk($userId);
        if ($ownerPk === null) {
            return $this->jsonError($response, 'A vault is required to sign placement', 409, 'vault_required');
        }
        try {
            $state = $this->placement->putBaseline((string) ($args['formId'] ?? ''), $userId, $manifest, $ownerPk);
        } catch (\RuntimeException $e) {
            return $this->nodeError($response, $e);
        }
        return $this->jsonResponse($response, ['data' => $state], 201);
    }

    private function ownerVaultPk(string $userId): ?string
    {
        $vault = $this->vaults->getVault($userId);
        $pkB64 = is_array($vault) ? (string) ($vault['ed25519Pk'] ?? '') : '';
        $raw = base64_decode($pkB64, true);
        return (is_string($raw) && strlen($raw) === SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES) ? $raw : null;
    }

    private function nodeError(Response $response, \RuntimeException $e): Response
    {
        $code = $e->getMessage();
        $map = [
            'data_node_not_found' => [404, 'Data node not found'],
            'data_node_revoked' => [409, 'This node was revoked — re-register it from the desktop first'],
            'data_node_cert_signature' => [422, 'The certificate signature does not verify against your vault key'],
            'placement_conflict' => [409, 'A signed placement already exists for this form'],
            'placement_signature_invalid' => [422, 'The placement signature does not verify against your vault key'],
            'placement_form_ineligible' => [422, 'Only your own Private forms have data placement'],
        ];
        foreach ($map as $prefix => [$status, $message]) {
            if (str_starts_with($code, $prefix)) {
                return $this->jsonError($response, $message, $status, $prefix);
            }
        }
        if (str_starts_with($code, 'data_node_cert_mismatch') || str_starts_with($code, 'placement_invalid')) {
            return $this->jsonError($response, 'Signed structure does not match the server state (' . $code . ')', 422, 'signed_structure_mismatch');
        }
        throw $e;
    }

    private function gate(Request $request, Response $response, bool $mutation = false): ?Response
    {
        if (!$this->dataNodesEnabled) {
            return $this->jsonError($response, 'Encrypted data nodes are not enabled', 403, 'data_nodes_disabled');
        }
        if ($mutation) {
            if ($this->isDemoRequest($request)) {
                return $this->jsonError($response, 'Not available in the demo', 403, 'demo_readonly');
            }
            $actor = $request->getAttribute('adminActorId');
            if (is_string($actor) && $actor !== '') {
                return $this->jsonError($response, 'Administrators cannot manage data nodes for other accounts', 403, 'acting_as_denied');
            }
        }
        return null;
    }
}
