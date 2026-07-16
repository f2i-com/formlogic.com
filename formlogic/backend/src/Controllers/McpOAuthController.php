<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Constants\AppPermissions;
use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Helpers\AppUrl;
use FormLogic\Services\ApiKeyService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\AuditService;
use FormLogic\Services\FlowService;
use FormLogic\Services\McpOAuthService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;

/**
 * HTTP surface of the MCP OAuth 2.1 authorization server (see McpOAuthService for the mechanics):
 *
 *   GET  /.well-known/oauth-protected-resource[/api/mcp]  RFC 9728 PRM (public, CORS *)
 *   GET  /.well-known/oauth-authorization-server          RFC 8414 AS metadata (public, CORS *)
 *   POST /api/oauth/register                              RFC 7591 DCR (public, rate-limited, CORS *)
 *   GET  /oauth/authorize                                 validates, then redirects an API-host request to the trusted SPA
 *   GET  /api/oauth/authorize-info                        validates an authorize request for the SPA consent page
 *   POST /api/oauth/approve                               AUTHED user consent -> mints the one-time code
 *   POST /api/oauth/token                                 code / refresh_token grants (public, form-encoded, CORS *)
 *
 * In a same-origin deployment /oauth/authorize is served directly by the SPA. A split API host
 * reaches the backend route first; authorizationPage() validates the OAuth request and redirects
 * it to APP_URL's fixed /oauth/authorize route. The SPA then calls authorize-info, approve, and
 * performs the returned client redirect. Token responses are never cacheable (no-store).
 */
class McpOAuthController
{
    use JsonResponseTrait;

    public function __construct(
        private McpOAuthService $oauth,
        private AppService $apps,
        private ?AuditService $auditService = null,
        private ?LoggerInterface $logger = null,
        // Injected for the first-party desktop device-link flow (token exchange mints a scoped flk_
        // key tied to a desktop_connections row). Null in the pure-MCP test harness — the desktop
        // branch only runs for the DESKTOP_CLIENT_ID client, which those tests never use.
        private ?ApiKeyService $apiKeys = null,
        private ?FlowService $flows = null,
        private ?AppUserService $appUsers = null,
    ) {}

    // ── Discovery (public, cache-friendly) ──

    public function protectedResourceMetadata(Request $request, Response $response): Response
    {
        return $this->jsonResponse($response, $this->oauth->protectedResourceMetadata($request))
            ->withHeader('Cache-Control', 'public, max-age=300');
    }

    public function authorizationServerMetadata(Request $request, Response $response): Response
    {
        return $this->jsonResponse($response, $this->oauth->authorizationServerMetadata($request))
            ->withHeader('Cache-Control', 'public, max-age=300');
    }

    // ── Dynamic client registration (RFC 7591) ──

    public function register(Request $request, Response $response): Response
    {
        $meta = $this->jsonBody($request);
        if (!is_array($meta) || $meta === []) {
            return $this->oauthError($response, 'invalid_client_metadata', 'Request body must be a JSON client-metadata object', 400);
        }
        $result = $this->oauth->registerClient($meta);
        if (!$result['ok']) {
            return $this->oauthError($response, $result['error'], $result['error_description'], 400);
        }
        // Log the registration (name + redirect hosts only — NEVER the client_secret).
        $this->audit($request, 'mcp.oauth.register', null, [
            'clientId' => $result['client']['client_id'],
            'clientName' => $result['client']['client_name'] ?? null,
            'redirectHosts' => array_values(array_unique(array_map(
                static fn ($u) => (string) (parse_url((string) $u, PHP_URL_HOST) ?? ''),
                $result['client']['redirect_uris']
            ))),
        ]);
        return $this->jsonResponse($response, $result['client'], 201)
            ->withHeader('Cache-Control', 'no-store');
    }

    // ── Consent support for the SPA (/oauth/authorize) ──

    /**
     * Split-host entry point for the system-browser authorization request.
     *
     * The native client is sent to the canonical API issuer so its RFC 8707 resource, token and
     * admission audience remain one exact origin. When the visible SPA lives on APP_URL instead,
     * validate the complete OAuth request here first, then preserve its raw query while redirecting
     * only to the server-configured frontend. No request parameter can influence the redirect host.
     */
    public function authorizationPage(Request $request, Response $response): Response
    {
        $v = $this->oauth->validateAuthorizeRequest($request->getQueryParams(), $request);
        if (!$v['ok']) {
            return $this->oauthError($response, $v['error'], $v['error_description'], 400);
        }

        $query = $request->getUri()->getQuery();
        if ($query === '' || strlen($query) > 16_384 || preg_match('/[\x00-\x1F\x7F]/', $query) === 1) {
            return $this->oauthError($response, 'invalid_request', 'Authorization query is missing or invalid', 400);
        }

        try {
            $frontend = $this->trustedFrontendOrigin($request);
        } catch (\Throwable) {
            return $this->oauthError(
                $response,
                'server_error',
                'The trusted FormLogic consent-page origin is not configured',
                503,
            );
        }
        if (hash_equals($frontend, McpOAuthService::publicOrigin($request))) {
            // A normal same-origin install serves this path from the SPA before PHP. If PHP did
            // receive it, redirecting to itself would loop forever, so fail closed instead.
            return $this->oauthError(
                $response,
                'server_error',
                'The OAuth consent SPA must serve /oauth/authorize on this origin',
                503,
            );
        }

        return $response
            ->withStatus(302)
            ->withHeader('Location', $frontend . '/oauth/authorize?' . $query)
            ->withHeader('Cache-Control', 'no-store');
    }

    /**
     * Validate an authorization request and return what the consent page must display: the client
     * name + the redirect host (shown prominently — anti-phishing per spec) + the scopes being
     * granted. A typed RFC 6749-style error otherwise.
     */
    public function authorizeInfo(Request $request, Response $response): Response
    {
        $v = $this->oauth->validateAuthorizeRequest($request->getQueryParams(), $request);
        if (!$v['ok']) {
            return $this->oauthError($response, $v['error'], $v['error_description'], 400);
        }
        $scopes = $v['scopes'];
        if (McpOAuthService::isAokieCompanionClient($v['client']['clientId'])) {
            $userId = $request->getAttribute('userId');
            $appId = $request->getQueryParams()['appId'] ?? null;
            if (is_string($userId) && $userId !== '' && is_string($appId) && $appId !== '') {
                $app = $this->apps->getApp($appId);
                if (!$app || ($app['status'] ?? null) !== 'published' || !$this->apps->isAppMember($appId, $userId)) {
                    return $this->oauthError($response, 'access_denied', 'Published app not found or access denied', 403);
                }
                $scopes = $this->allowedCompanionScopes($appId, $userId, $scopes);
                if (!in_array('aokie:state', $scopes, true)) {
                    return $this->oauthError($response, 'access_denied', 'Your app role does not permit Aokie Companion access', 403);
                }
            }
        }
        return $this->jsonResponse($response, [
            'clientName' => $v['client']['name'] ?? null,
            'clientUri' => $v['client']['clientUri'] ?? null,
            'redirectHost' => (string) (parse_url($v['redirectUri'], PHP_URL_HOST) ?? ''),
            'scopes' => $scopes,
            // Human-readable scope labels for the consent screen + a flag the SPA uses to render the
            // desktop-link copy (and the device name it will link). Additive; the MCP consent UI can
            // ignore both.
            'scopeLabels' => McpOAuthService::scopeLabels($scopes),
            'isDesktopLink' => McpOAuthService::isDesktopClient($v['client']['clientId']),
            'isAokieCompanionLink' => McpOAuthService::isAokieCompanionClient($v['client']['clientId']),
            'appBindingRequired' => McpOAuthService::isAokieCompanionClient($v['client']['clientId']),
            'device' => $v['device'] ?? null,
        ]);
    }

    /**
     * The signed-in user approved the consent screen: re-validate EVERYTHING (never trust that the
     * page called authorize-info), apply the optional appId narrowing (must be an app the user owns —
     * the same app-scoping the manual flm_ token flow uses), mint the one-time code, and hand the SPA
     * the redirect URL to perform. Auth (AuthMiddleware) + CSRF are enforced by the route wiring.
     */
    public function approve(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!is_string($userId) || $userId === '') {
            return $this->oauthError($response, 'access_denied', 'Authentication required', 401);
        }
        $p = $this->jsonBody($request) ?? [];
        $v = $this->oauth->validateAuthorizeRequest($p, $request);
        if (!$v['ok']) {
            return $this->oauthError($response, $v['error'], $v['error_description'], 400);
        }
        $appId = (is_string($p['appId'] ?? null) && $p['appId'] !== '') ? $p['appId'] : null;
        if (McpOAuthService::isAokieCompanionClient($v['client']['clientId']) && $appId === null) {
            return $this->oauthError($response, 'invalid_request', 'Aokie Companion authorization must select an app', 400);
        }
        $grantedScopes = $v['scopes'];
        if ($appId !== null) {
            $app = $this->apps->getApp($appId);
            $isCompanion = McpOAuthService::isAokieCompanionClient($v['client']['clientId']);
            $hasAccess = $isCompanion
                ? $this->apps->isAppMember($appId, $userId)
                : ($app['ownerId'] ?? null) === $userId;
            if (!$app || !$hasAccess) {
                return $this->oauthError($response, 'invalid_request', 'App not found or access denied', 400);
            }
            if ($isCompanion && ($app['status'] ?? null) !== 'published') {
                return $this->oauthError($response, 'invalid_request', 'Aokie Companion requires a published app', 400);
            }
            if ($isCompanion) {
                $grantedScopes = $this->allowedCompanionScopes($appId, $userId, $grantedScopes);
                if (!in_array('aokie:state', $grantedScopes, true)) {
                    return $this->oauthError($response, 'access_denied', 'Your app role does not permit Aokie Companion access', 403);
                }
            }
        }
        $code = $this->oauth->mintCode($userId, $v['client']['clientId'], $v['redirectUri'], $grantedScopes, $v['codeChallenge'], $v['resource'], $appId, $v['device'] ?? null);

        $query = ['code' => $code];
        $state = $p['state'] ?? null;
        if (is_string($state) && $state !== '' && strlen($state) <= 2048) {
            $query['state'] = $state; // echoed verbatim when present (RFC 6749 §4.1.2)
        }
        $redirectTo = $v['redirectUri'] . (str_contains($v['redirectUri'], '?') ? '&' : '?') . http_build_query($query);

        $this->audit($request, 'mcp.oauth.approve', $userId, [
            'clientId' => $v['client']['clientId'],
            'appId' => $appId,
            'scopes' => $grantedScopes,
        ]);
        return $this->jsonResponse($response, ['redirectTo' => $redirectTo])
            ->withHeader('Cache-Control', 'no-store');
    }

    /** Trusted, canonical frontend origin used only as the fixed consent-page redirect target. */
    private function trustedFrontendOrigin(Request $request): string
    {
        $base = rtrim(AppUrl::frontendBase($request), '/');
        $parts = parse_url($base);
        if (!is_array($parts)
            || empty($parts['scheme'])
            || empty($parts['host'])
            || isset($parts['user'])
            || isset($parts['pass'])
            || isset($parts['query'])
            || isset($parts['fragment'])
            || !in_array(($parts['path'] ?? ''), ['', '/'], true)) {
            throw new \RuntimeException('APP_URL must be an origin');
        }
        $scheme = strtolower((string) $parts['scheme']);
        $environment = $_ENV['APP_ENV'] ?? (getenv('APP_ENV') ?: 'production');
        if ($scheme !== 'https' && !($environment === 'development' && $scheme === 'http')) {
            throw new \RuntimeException('APP_URL must use HTTPS');
        }
        $portNumber = isset($parts['port']) ? (int) $parts['port'] : null;
        $port = $portNumber !== null
            && !(($scheme === 'http' && $portNumber === 80) || ($scheme === 'https' && $portNumber === 443))
            ? ':' . $portNumber
            : '';
        return $scheme . '://' . strtolower((string) $parts['host']) . $port;
    }

    /** @param list<string> $requested @return list<string> */
    private function allowedCompanionScopes(string $appId, string $userId, array $requested): array
    {
        $map = [
            'aokie:state' => AppPermissions::AOKIE_COMPANION_STATE,
            'aokie:monitor' => AppPermissions::AOKIE_COMPANION_MONITOR,
            'aokie:consult' => AppPermissions::AOKIE_COMPANION_CONSULT,
            'aokie:takeover' => AppPermissions::AOKIE_COMPANION_TAKEOVER,
            'aokie:resume' => AppPermissions::AOKIE_COMPANION_RESUME,
            'aokie:end_caller' => AppPermissions::AOKIE_COMPANION_END,
            'aokie:assistance' => AppPermissions::AOKIE_COMPANION_ASSISTANCE,
        ];
        $allowed = [];
        foreach ($map as $scope => $permission) {
            if (in_array($scope, $requested, true)
                && $this->appUsers !== null
                && $this->appUsers->hasPermission($appId, $userId, $permission)) {
                $allowed[] = $scope;
            }
        }
        // Tests/standalone embeddings may omit AppUserService; only the actual
        // app owner gets the legacy implicit-all fallback. Members fail closed.
        if ($this->appUsers === null) {
            $app = $this->apps->getApp($appId);
            if (($app['ownerId'] ?? null) === $userId) {
                $allowed = array_values(array_intersect(array_keys($map), $requested));
            }
        }
        if (in_array('offline_access', $requested, true) && in_array('aokie:state', $allowed, true)) {
            $allowed[] = 'offline_access';
        }
        return $allowed;
    }

    // ── Token endpoint (RFC 6749 §3.2; application/x-www-form-urlencoded) ──

    public function token(Request $request, Response $response): Response
    {
        $p = $this->formBody($request);
        $grantType = (string) ($p['grant_type'] ?? '');

        // Arrival diagnostic (no secrets — code/verifier/secret are NEVER logged). This is the
        // definitive signal for debugging a remote client like Claude: if a token request from
        // Anthropic's egress (160.79.104.0/21) never appears in the log during a failed connection,
        // an edge/WAF/Cloudflare layer is eating it before PHP; if it appears, the logged failure
        // reason below is the exact cause.
        $sp = $request->getServerParams();
        $this->logger?->info('MCP OAuth: token request received', [
            'grant' => $grantType,
            'client_id' => (string) ($p['client_id'] ?? ($request->getHeaderLine('Authorization') !== '' ? '(via Authorization header)' : '(none)')),
            'ip' => $sp['REMOTE_ADDR'] ?? null,
            'forwarded_for' => $request->getHeaderLine('X-Forwarded-For') ?: null,
            'content_type' => $request->getHeaderLine('Content-Type') ?: null,
            'has_resource' => isset($p['resource']),
        ]);

        // Client identification/authentication. We advertise 'none' + 'client_secret_post'; a Basic
        // Authorization header is also accepted defensively (some clients default to
        // client_secret_basic regardless of the metadata).
        $clientId = trim((string) ($p['client_id'] ?? ''));
        $clientSecret = isset($p['client_secret']) && is_string($p['client_secret']) ? $p['client_secret'] : null;
        if (preg_match('/^Basic\s+(.+)$/i', $request->getHeaderLine('Authorization'), $m)) {
            $decoded = base64_decode(trim($m[1]), true);
            if (is_string($decoded) && str_contains($decoded, ':')) {
                [$basicId, $basicSecret] = explode(':', $decoded, 2);
                if ($clientId === '') {
                    $clientId = rawurldecode($basicId);
                }
                if ($clientSecret === null && $basicSecret !== '') {
                    $clientSecret = rawurldecode($basicSecret);
                }
            }
        }
        if ($clientId === '') {
            return $this->oauthError($response, 'invalid_request', 'client_id is required', 400);
        }
        $client = $this->oauth->resolveClient($clientId);
        if ($client === null) {
            return $this->oauthError($response, 'invalid_client', 'Unknown client', 401);
        }
        if (!$this->oauth->authenticateClient($client, $clientSecret)) {
            return $this->oauthError($response, 'invalid_client', 'Client authentication failed', 401);
        }
        $isPublic = ($client['authMethod'] ?? '') === 'none';

        if ($grantType === 'authorization_code') {
            $code = (string) ($p['code'] ?? '');
            $verifier = (string) ($p['code_verifier'] ?? '');
            $redirectUri = (string) ($p['redirect_uri'] ?? '');
            if ($code === '' || $verifier === '' || $redirectUri === '') {
                return $this->oauthError($response, 'invalid_request', 'code, code_verifier and redirect_uri are required', 400);
            }
            $resourceParam = isset($p['resource']) && is_string($p['resource']) ? $p['resource'] : null;
            $r = $this->oauth->redeemCode($code, $client['clientId'], $redirectUri, $verifier, $resourceParam);
            if (!$r['ok']) {
                return $this->oauthError($response, $r['error'], $r['error_description'], 400);
            }
            // FormLogic Desktop device-link: mint a long-lived SCOPED flk_ API key (not an MCP
            // session) tied to a desktop_connections row, returned ONCE. Keeps the MCP flow below
            // untouched for every other client.
            if (McpOAuthService::isDesktopClient($client['clientId'])) {
                return $this->issueDesktopKey($request, $response, $r);
            }
            $deviceId = McpOAuthService::isAokieCompanionClient($client['clientId'])
                ? ($r['deviceLabel'] ?? null)
                : null;
            $body = $this->oauth->issueTokenPair(
                $r['userId'],
                $r['appId'],
                $r['scopes'],
                $r['resource'],
                $client['clientId'],
                null,
                is_string($deviceId) ? $deviceId : null,
            );
            $this->audit($request, 'mcp.oauth.token', $r['userId'], ['grant' => 'authorization_code', 'clientId' => $client['clientId'], 'appId' => $r['appId']]);
            return $this->tokenResponse($response, $body);
        }

        if ($grantType === 'refresh_token') {
            $refreshToken = (string) ($p['refresh_token'] ?? '');
            if ($refreshToken === '') {
                return $this->oauthError($response, 'invalid_request', 'refresh_token is required', 400);
            }
            $r = $this->oauth->redeemRefreshToken($refreshToken, $client['clientId'], $isPublic);
            if (!$r['ok']) {
                return $this->oauthError($response, $r['error'], $r['error_description'], 400);
            }
            $scopes = $this->oauth->narrowScopes((string) ($p['scope'] ?? ''), $r['scopes']);
            if ($scopes === null) {
                return $this->oauthError($response, 'invalid_scope', 'Requested scope exceeds the original grant', 400);
            }
            $body = $this->oauth->issueAccessToken(
                $r['userId'],
                $r['appId'],
                $scopes,
                $r['resource'],
                $client['clientId'],
                is_string($r['deviceId'] ?? null) ? $r['deviceId'] : null,
                is_string($r['familyId'] ?? null) ? $r['familyId'] : null,
            );
            // Rotation: public clients get a NEW refresh token (old one is already retired);
            // confidential clients keep the one they presented.
            $body['refresh_token'] = $r['newRefreshToken'] ?? $refreshToken;
            $this->audit($request, 'mcp.oauth.token', $r['userId'], ['grant' => 'refresh_token', 'clientId' => $client['clientId'], 'rotated' => $r['newRefreshToken'] !== null]);
            return $this->tokenResponse($response, $body);
        }

        return $this->oauthError($response, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token', 400);
    }

    /**
     * FormLogic Desktop device-link token exchange: mint a long-lived scoped flk_ API key holding
     * exactly the granted scopes, tie it to a fresh desktop_connections row named for the device,
     * and return it ONCE. The key is revocable from Settings→API keys and by deleting the
     * connection (DELETE /api/desktop-connections/{id} revokes it). The desktop client stores
     * `formlogic_api_key` (== access_token) and uses it as the Bearer against /api/v1.
     */
    private function issueDesktopKey(Request $request, Response $response, array $grant): Response
    {
        if ($this->apiKeys === null || $this->flows === null) {
            return $this->oauthError($response, 'server_error', 'Desktop linking is not available', 500);
        }
        $userId = (string) $grant['userId'];
        // Fail CLOSED on app-restricted grants (audit SEC-001/C-08): the desktop key is
        // account-wide by design (the headless runner serves every owner app), so an
        // authorization carrying an app limit must be REFUSED rather than silently
        // widened into an account-wide credential.
        if (isset($grant['appId']) && $grant['appId'] !== null && $grant['appId'] !== '') {
            return $this->oauthError(
                $response,
                'invalid_grant',
                'Desktop linking requires an account-wide grant; an app-restricted authorization cannot mint a desktop key',
                400
            );
        }
        $device = isset($grant['deviceLabel']) && $grant['deviceLabel'] !== null ? (string) $grant['deviceLabel'] : null;
        // The granted scopes are already the DESKTOP_SCOPES subset (validated at authorize time), so
        // every one is a valid ApiKeyService scope. Name the key for the device.
        $scopes = array_values($grant['scopes']);
        $keyName = substr($device !== null ? "FormLogic Desktop on {$device}" : 'FormLogic Desktop', 0, 255);
        try {
            $key = $this->apiKeys->createKey($userId, $keyName, $scopes);
            $connection = $this->flows->createOAuthDesktopConnection($userId, $device, $key['id']);
        } catch (\Throwable $e) {
            $this->logger?->warning('Desktop OAuth key mint failed', ['reason' => $e->getMessage()]);
            return $this->oauthError($response, 'server_error', 'Could not complete desktop linking', 500);
        }

        $this->audit($request, 'desktop.oauth.link', $userId, [
            'clientId' => McpOAuthService::DESKTOP_CLIENT_ID,
            'connectionId' => $connection['id'],
            'apiKeyId' => $key['id'],
            'scopes' => $scopes,
        ]);

        return $this->tokenResponse($response, [
            // access_token == formlogic_api_key so a generic OAuth client still finds a bearer, while
            // the documented field is formlogic_api_key. Long-lived + revocable: no expires_in / refresh.
            'access_token' => $key['key'],
            'token_type' => 'Bearer',
            'scope' => implode(' ', $scopes),
            'formlogic_api_key' => $key['key'],
            'api_key_id' => $key['id'],
            'desktop_connection_id' => $connection['id'],
            'device_name' => $connection['deviceName'],
        ]);
    }

    // ── Helpers ──

    /** RFC 6749 token responses must never be cached or logged by intermediaries. */
    private function tokenResponse(Response $response, array $body): Response
    {
        return $this->jsonResponse($response, $body)
            ->withHeader('Cache-Control', 'no-store')
            ->withHeader('Pragma', 'no-cache');
    }

    /** RFC 6749 §5.2 error shape: { error, error_description } (NOT the app's {error:true} shape). */
    private function oauthError(Response $response, string $error, string $description, int $status): Response
    {
        // Log every OAuth error at the endpoint boundary (no secrets — description is a fixed
        // human string, never an echo of a code/verifier). Turns an opaque remote "authorization
        // failed" into a precise server-side reason the operator can read in app.log.
        $this->logger?->info('MCP OAuth: request rejected', ['error' => $error, 'reason' => $description, 'status' => $status]);
        return $this->jsonResponse($response, ['error' => $error, 'error_description' => $description], $status)
            ->withHeader('Cache-Control', 'no-store');
    }

    /** Parsed JSON body with a raw-stream fallback (mirrors McpController::handle). */
    private function jsonBody(Request $request): ?array
    {
        $body = $request->getParsedBody();
        if (is_array($body)) {
            return $body;
        }
        $raw = (string) $request->getBody();
        if ($raw === '') {
            return null;
        }
        $decoded = json_decode($raw, true);
        return is_array($decoded) ? $decoded : null;
    }

    /**
     * Token-endpoint body: application/x-www-form-urlencoded per RFC 6749 (Slim's body-parsing
     * middleware decodes it); falls back to parsing the raw stream (form or JSON) so odd
     * content-type variants and direct-invocation tests still work.
     */
    private function formBody(Request $request): array
    {
        $body = $request->getParsedBody();
        if (is_array($body)) {
            return $body;
        }
        $raw = (string) $request->getBody();
        if ($raw === '') {
            return [];
        }
        if (str_contains(strtolower($request->getHeaderLine('Content-Type')), 'json')) {
            $decoded = json_decode($raw, true);
            return is_array($decoded) ? $decoded : [];
        }
        parse_str($raw, $out);
        return $out;
    }

    private function audit(Request $request, string $action, ?string $userId, array $details = []): void
    {
        try {
            $sp = $request->getServerParams();
            $this->auditService?->log($action, 'mcp', $details['clientId'] ?? null, $userId, $sp['REMOTE_ADDR'] ?? null, $details);
        } catch (\Throwable) { /* audit is best-effort */ }
    }
}
