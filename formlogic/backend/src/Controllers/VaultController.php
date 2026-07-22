<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\EncryptionRequestException;
use FormLogic\Services\VaultService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * E2EE vault API (docs/E2EE_PRIVATE_FORMS_PLAN.md §16-P2):
 *   GET  /api/vault                    → the caller's vault (404 vault_not_found)
 *   PUT  /api/vault                    → create-only (409 vault_exists)
 *   POST /api/vault/change-passphrase  → version-CAS passphrase rewrap
 *
 * The demo account is refused (demo_readonly — plan D9) and admin acting-as is
 * refused defensively: vault routes are NOT in the acting-as mirror allowlist
 * (AdminActingAsRoutes default-deny), and this controller additionally rejects
 * any request that carries the acting-as actor attribute — an administrator
 * must never read or replace a user's key material.
 */
class VaultController
{
    use JsonResponseTrait;

    public function __construct(
        private VaultService $vaultService,
        private bool $privateFormsEnabled = true,
    ) {
    }

    public function getVault(Request $request, Response $response): Response
    {
        if ($guard = $this->guard($request, $response)) {
            return $guard;
        }
        $userId = (string) $request->getAttribute('userId');
        $vault = $this->vaultService->getVault($userId);
        if ($vault === null) {
            return $this->jsonError($response, 'No vault exists for this account.', 404, 'vault_not_found');
        }
        return $this->jsonResponse($response, ['data' => ['vault' => $vault]]);
    }

    public function createVault(Request $request, Response $response): Response
    {
        if ($guard = $this->guard($request, $response)) {
            return $guard;
        }
        if (!$this->privateFormsEnabled) {
            // Beta gate (plan D9): the PRIVATE_FORMS public-config flag is off.
            return $this->jsonError($response, 'Private forms are not enabled on this server.', 403, 'private_forms_disabled');
        }
        $userId = (string) $request->getAttribute('userId');
        $body = $request->getParsedBody();
        if (!is_array($body)) {
            return $this->jsonError($response, 'Invalid request body', 400, 'vault_invalid');
        }
        try {
            $vault = $this->vaultService->createVault($userId, $body);
            return $this->jsonResponse($response, ['data' => ['vault' => $vault]]);
        } catch (EncryptionRequestException $e) {
            return $this->jsonError($response, $e->getMessage(), $e->status, $e->errorCode, $e->details);
        }
    }

    public function changePassphrase(Request $request, Response $response): Response
    {
        if ($guard = $this->guard($request, $response)) {
            return $guard;
        }
        $userId = (string) $request->getAttribute('userId');
        $body = $request->getParsedBody();
        if (!is_array($body)) {
            return $this->jsonError($response, 'Invalid request body', 400, 'vault_invalid');
        }
        try {
            $vault = $this->vaultService->changePassphrase($userId, $body);
            return $this->jsonResponse($response, ['data' => ['vault' => $vault]]);
        } catch (EncryptionRequestException $e) {
            return $this->jsonError($response, $e->getMessage(), $e->status, $e->errorCode, $e->details);
        }
    }

    /** Shared demo + acting-as refusals (ALL vault verbs — reads included). */
    private function guard(Request $request, Response $response): ?Response
    {
        if ($this->isDemoRequest($request)) {
            return $this->jsonError($response, 'The shared demo account cannot use private-form vaults.', 403, 'demo_readonly');
        }
        $actor = $request->getAttribute('adminActorId');
        if (is_string($actor) && $actor !== '') {
            return $this->jsonError($response, 'Administrators cannot access user vaults.', 403, 'acting_as_denied');
        }
        return null;
    }
}
