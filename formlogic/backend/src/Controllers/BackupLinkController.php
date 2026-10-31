<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\AuditService;
use FormLogic\Services\BackupLinkService;
use FormLogic\Services\McpOAuthService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Setting up the FormLogic Backups plugin through a computer's link (BackupLinkService).
 *
 * `start` and `status` are the owner's, signed in. `redeem` is the plugin's: it has no key yet,
 * so the code is its only credential, and the route is rate limited and public.
 */
final class BackupLinkController
{
    use JsonResponseTrait;

    public function __construct(
        private BackupLinkService $links,
        private bool $dataNodesEnabled,
        private ?AuditService $audit = null,
    ) {
    }

    /** POST /api/data-nodes/backup-link {connectionId} */
    public function start(Request $request, Response $response): Response
    {
        if (($gate = $this->gate($response)) !== null) {
            return $gate;
        }
        if ($this->isDemoRequest($request)) {
            return $this->jsonError($response, 'Not available in the demo', 403, 'demo_readonly');
        }
        $actor = $request->getAttribute('adminActorId');
        if (is_string($actor) && $actor !== '') {
            return $this->jsonError($response, 'Administrators cannot manage data nodes for other accounts', 403, 'acting_as_denied');
        }
        $body = json_decode((string) $request->getBody(), true);
        $connectionId = is_array($body) ? (string) ($body['connectionId'] ?? '') : '';
        if ($connectionId === '') {
            return $this->jsonError($response, 'connectionId is required', 400, 'invalid_request');
        }
        $userId = (string) $request->getAttribute('userId');
        try {
            // The address this API was reached at, which the plugin goes on to call. APP_URL is the
            // site's, and on a split deployment that is another host.
            $started = $this->links->start($userId, $connectionId, McpOAuthService::publicOrigin($request));
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'backup_link_offline') {
                return $this->jsonError($response, 'That computer is not online. Check that OAIY is running there.', 409, 'backup_link_offline');
            }
            if ($e->getMessage() === 'backup_link_not_ready') {
                return $this->jsonError($response, 'That computer is still connecting. Try again in a moment.', 409, 'backup_link_not_ready');
            }
            if ($e->getMessage() === 'backup_link_no_room') {
                return $this->jsonError($response, BackupLinkService::NO_ROOM, 409, 'backup_link_no_room');
            }
            throw $e;
        }
        $this->record($request, 'backup.link.start', $userId, ['connectionId' => $connectionId]);
        return $this->jsonResponse($response, ['data' => $started], 201);
    }

    /** GET /api/data-nodes/backup-link/{id} */
    public function status(Request $request, Response $response, array $args): Response
    {
        if (($gate = $this->gate($response)) !== null) {
            return $gate;
        }
        $status = $this->links->status((string) $request->getAttribute('userId'), (string) ($args['id'] ?? ''));
        if ($status === null) {
            return $this->jsonError($response, 'Unknown request', 404, 'backup_link_not_found');
        }
        return $this->jsonResponse($response, ['data' => $status]);
    }

    /** POST /api/oauth/backup-link {code}: answers as the OAuth token exchange does for this client. */
    public function redeem(Request $request, Response $response): Response
    {
        if (($gate = $this->gate($response)) !== null) {
            return $gate;
        }
        $parsed = $request->getParsedBody();
        $code = is_array($parsed) && is_string($parsed['code'] ?? null) ? $parsed['code'] : '';
        try {
            $client = $this->links->redeem($code);
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'backup_link_invalid') {
                return $this->jsonError($response, 'That code is not valid. Start again from FormLogic.', 400, 'backup_link_invalid');
            }
            if ($e->getMessage() === 'backup_link_no_room') {
                return $this->jsonError($response, BackupLinkService::NO_ROOM, 409, 'backup_link_no_room');
            }
            throw $e;
        }
        $this->record($request, 'backup.link.redeem', $client['accountId'], ['backupClientId' => $client['id'], 'apiKeyId' => $client['apiKeyId']]);
        return $this->jsonResponse($response, [
            'formlogic_api_key' => $client['key'],
            'api_key_id' => $client['apiKeyId'],
            'backup_client_id' => $client['id'],
            'account_id' => $client['accountId'],
            'account_email' => $client['accountEmail'],
        ])->withHeader('Cache-Control', 'no-store');
    }

    private function record(Request $request, string $action, string $userId, array $details): void
    {
        try {
            $this->audit?->log($action, 'account', $userId, $userId, $request->getServerParams()['REMOTE_ADDR'] ?? null, $details);
        } catch (\Throwable) {
            // audit is best-effort
        }
    }

    private function gate(Response $response): ?Response
    {
        return $this->dataNodesEnabled ? null : $this->jsonError($response, 'Encrypted data nodes are not enabled', 403, 'data_nodes_disabled');
    }
}
