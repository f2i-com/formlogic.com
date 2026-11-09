<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Helpers\IpResolver;
use FormLogic\Services\AuditService;
use FormLogic\Services\DesktopLinkCodeService;
use FormLogic\Services\DesktopLinkIssuer;
use FormLogic\Services\McpOAuthService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Connect an OAIY server (DesktopLinkCodeService). `start` and `status` are the signed-in person's;
 * `redeem` is the server's: it has no key yet, so the code is its only credential, and the route is
 * public and rate limited, as /api/oauth/backup-link is.
 */
final class DesktopLinkController
{
    use JsonResponseTrait;

    public function __construct(private DesktopLinkCodeService $links, private ?AuditService $audit = null)
    {
    }

    /** POST /api/desktop-links/codes {scope?: "ai"|"all", deviceName?} */
    public function start(Request $request, Response $response): Response
    {
        if ($this->isDemoRequest($request)) return $this->jsonError($response, 'Not available in the demo', 403, 'demo_readonly');
        $actor = $request->getAttribute('adminActorId');
        if (is_string($actor) && $actor !== '') return $this->jsonError($response, 'Administrators cannot link computers to other accounts', 403, 'acting_as_denied');
        $body = $request->getParsedBody();
        $body = is_array($body) ? $body : [];
        $scope = is_string($body['scope'] ?? null) ? $body['scope'] : 'ai';
        $device = is_string($body['deviceName'] ?? null) ? $body['deviceName'] : null;
        $userId = (string) $request->getAttribute('userId');
        try {
            $started = $this->links->start($userId, $scope, $device);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400, 'invalid_request');
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'desktop_link_no_room') return $this->jsonError($response, DesktopLinkCodeService::NO_ROOM, 409, 'desktop_link_no_room');
            if ($e->getMessage() === 'desktop_link_too_many') return $this->jsonError($response, 'You already have ' . DesktopLinkCodeService::MAX_OPEN . ' codes waiting. Use one, or wait ten minutes.', 409, 'desktop_link_too_many');
            throw $e;
        }
        $this->record($request, 'desktop.link_code.create', $userId, ['codeId' => $started['id'], 'scope' => $scope]);
        // The address this API was reached at, which the server goes on to call (APP_URL is the
        // site's, and on a split deployment that is another host).
        $base = McpOAuthService::publicOrigin($request);
        $command = 'oaiy-server link --code ' . $started['code'] . ' --base-url ' . $base;
        return $this->jsonResponse($response->withHeader('Cache-Control', 'no-store'), ['data' => $started + ['baseUrl' => $base, 'command' => $command]], 201);
    }

    /** GET /api/desktop-links/codes/{id} */
    public function status(Request $request, Response $response, array $args): Response
    {
        $status = $this->links->status((string) $request->getAttribute('userId'), (string) ($args['id'] ?? ''));
        if ($status === null) return $this->jsonError($response, 'Unknown code', 404, 'desktop_link_not_found');
        return $this->jsonResponse($response->withHeader('Cache-Control', 'no-store'), ['data' => $status]);
    }

    /**
     * POST /api/oauth/oaiy-link {code, device_name?} (JSON or a form): answers as the browser link's
     * token exchange does, so the server keeps the same link/account.json.
     */
    public function redeem(Request $request, Response $response): Response
    {
        $body = $request->getParsedBody();
        if (!is_array($body)) {
            $raw = (string) $request->getBody();
            $decoded = json_decode($raw, true);
            if (is_array($decoded)) $body = $decoded;
            else parse_str($raw, $body);
        }
        $code = is_string($body['code'] ?? null) ? $body['code'] : '';
        $device = is_string($body['device_name'] ?? null) ? $body['device_name'] : null;
        try {
            $linked = $this->links->redeem($code, $device);
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'desktop_link_invalid') return $this->oauthError($response, 'invalid_grant', 'That code is not valid. Start again from FormLogic.', 400);
            if ($e->getMessage() === 'desktop_link_no_room') return $this->oauthError($response, 'invalid_request', DesktopLinkCodeService::NO_ROOM, 409);
            return $this->oauthError($response, 'server_error', 'FormLogic could not finish linking that server. Make a new code and try again.', 500);
        }
        $this->record($request, 'desktop.link_code.redeem', $linked['userId'], ['codeId' => $linked['codeId'], 'connectionId' => $linked['connection']['id'], 'apiKeyId' => $linked['key']['id'], 'scopes' => $linked['scopes']]);
        return $this->jsonResponse($response, DesktopLinkIssuer::tokenBody($linked['key'], $linked['connection'], $linked['scopes']))
            ->withHeader('Cache-Control', 'no-store')
            ->withHeader('Pragma', 'no-cache');
    }

    /** RFC 6749 §5.2's error shape, as the token endpoint answers: OAIY reads error_description. */
    private function oauthError(Response $response, string $error, string $description, int $status): Response
    {
        return $this->jsonResponse($response, ['error' => $error, 'error_description' => $description], $status)
            ->withHeader('Cache-Control', 'no-store')
            ->withHeader('Pragma', 'no-cache');
    }

    private function record(Request $request, string $action, string $userId, array $details): void
    {
        try {
            $this->audit?->log($action, 'account', $userId, $userId, IpResolver::fromEnvironment()->getClientIp($request), $details);
        } catch (\Throwable) {
            // audit is best-effort
        }
    }
}
