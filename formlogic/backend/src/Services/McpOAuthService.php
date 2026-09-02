<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Helpers\IpSafety;
use PDO;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;

/**
 * OAuth 2.1 authorization server for the MCP endpoint (/api/mcp), per the MCP authorization spec
 * (2025-06-18/2025-11-25): RFC 9728 protected-resource metadata, RFC 8414 AS metadata, RFC 7591
 * dynamic client registration + CIMD (URL-shaped client_ids resolved to a client-metadata document),
 * authorization-code grant with mandatory PKCE (S256 only), RFC 8707 resource binding, and rotating
 * refresh tokens. Access tokens are ordinary McpTokenService sessions (prefix flm_oauth_), so the
 * existing /api/mcp validation, scoping and audit pipeline work unchanged.
 *
 * Secrets are never stored or logged in plaintext: client secrets, authorization codes and refresh
 * tokens are persisted as sha256 hashes only.
 */
class McpOAuthService
{
    /** Authorization codes are one-time and very short-lived (OAuth 2.1 recommends <= 60s). */
    public const CODE_TTL = 60;
    /** OAuth access tokens get a hard 1h absolute expiry; clients refresh via the refresh grant. */
    public const ACCESS_TOKEN_TTL = 3600;
    /** Native Companion access stays short; its rotating refresh family supplies continuity. */
    public const AOKIE_COMPANION_ACCESS_TOKEN_TTL = 600;
    /** Refresh tokens last ~30 days (rotation for public clients keeps the family fresh). */
    public const REFRESH_TOKEN_TTL = 2592000;

    private const CODE_PREFIX = 'mcpac_';
    private const REFRESH_PREFIX = 'mcprt_';
    private const CLIENT_ID_PREFIX = 'mcpc_';
    private const CLIENT_SECRET_PREFIX = 'mcps_';

    /**
     * The static first-party PUBLIC native client (seeded in MySQLConnection::seedFirstPartyOAuthClients).
     * FormLogic Desktop links an account via this client's authorization-code + PKCE flow; the token
     * exchange mints a long-lived SCOPED flk_ API key (McpOAuthController::token) instead of an MCP
     * session, tied to a desktop_connections row. Any other client keeps the unchanged MCP flow.
     */
    public const DESKTOP_CLIENT_ID = 'formlogic-desktop';

    /**
     * Every first-party desktop runtime allowed to device-link, as
     * `client_id => display name`.
     *
     * A SET rather than one id so this server is not tied to a single desktop
     * product: OAIY Desktop is a second, independent runtime that speaks the
     * same connector protocol, and a third would be one more entry here plus
     * the matching seed row. Nothing in the flow below names any of them.
     *
     * They all draw from DESKTOP_SCOPES and all mint an account-wide scoped
     * flk_ key, which is what makes them interchangeable to this server. Each
     * gets its OWN client id so a user can see which runtime they approved and
     * revoke one without revoking the other.
     */
    public const DESKTOP_CLIENTS = [
        'formlogic-desktop' => 'FormLogic Desktop',
        'oaiy-desktop' => 'OAIY Desktop',
    ];

    /** First-party public native client used by Windows/Android Companion. */
    public const AOKIE_COMPANION_CLIENT_ID = 'aokie-companion';

    /** App-narrowed call permissions shown explicitly on the OAuth consent page. */
    public const AOKIE_COMPANION_SCOPES = [
        'aokie:state',
        'aokie:monitor',
        'aokie:consult',
        'aokie:takeover',
        'aokie:resume',
        'aokie:assistance',
        'aokie:end_caller',
        'offline_access',
    ];

    /** @var list<string> Scopes that no dynamically registered/MCP client may obtain. */
    private const AOKIE_COMPANION_ONLY_SCOPES = [
        'aokie:state',
        'aokie:monitor',
        'aokie:consult',
        'aokie:takeover',
        'aokie:resume',
        'aokie:assistance',
        'aokie:end_caller',
    ];

    /**
     * The scope vocabulary the desktop client may request — DISTINCT from the MCP session scopes.
     * These are ApiKeyService scopes (the minted flk_ key holds exactly the granted subset):
     *   flows:read/flows:write drive the Flows runtime headless; responses:read/write/manage let the
     *   runtime read (list_responses + match-based updates LIST), submit, and update an app's records
     *   when applying onConnectorEvent effects + flow output actions; connector:relay claims/completes
     *   the remote connector commands a web member enqueues.
     */
    public const DESKTOP_SCOPES = ['flows:read', 'flows:write', 'responses:read', 'responses:write', 'responses:manage', 'connector:relay', 'aokie:realtime'];

    /** CIMD (client-metadata-document) fetch limits: SSRF-guarded, 5s, 64KB, JSON only, no redirects. */
    private const CIMD_CACHE_TTL = 300;
    private const CIMD_MAX_BYTES = 65536;
    private const CIMD_TIMEOUT_SECONDS = 5;

    private const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];

    public function __construct(
        private MySQLConnection $mysql,
        private McpTokenService $tokens,
        private ?LoggerInterface $logger = null,
    ) {}

    private function db(): PDO
    {
        return $this->mysql->getConnection();
    }

    // ── Origin / resource derivation (static so McpController shares the same authority) ──

    /**
     * Effective request scheme, UPGRADE-ONLY — the same pattern as AppManifestController::requestScheme.
     * X-Forwarded-Proto is honored only to CONFIRM https (TLS-terminating proxy forwarding http on the
     * wire); a spoofed "X-Forwarded-Proto: http" can never downgrade the advertised issuer/resource to
     * cleartext. Anything other than an explicit APP_ENV=development is production => always https;
     * only in development does the real connection scheme flow through (http://formlogic.local works).
     */
    public static function requestScheme(Request $request): string
    {
        $proto = strtolower(trim(explode(',', $request->getHeaderLine('X-Forwarded-Proto'))[0]));
        if ($proto === 'https') {
            return 'https';
        }
        if ((($_ENV['APP_ENV'] ?? (getenv('APP_ENV') ?: 'production'))) !== 'development') {
            return 'https';
        }
        return strtolower($request->getUri()->getScheme()) === 'http' ? 'http' : 'https';
    }

    /**
     * The public origin ("issuer") is derived from the REQUEST host — the PRM `resource` must equal
     * the MCP URL exactly as users paste it into their client, whatever hostname they reached us on.
     */
    public static function publicOrigin(Request $request): string
    {
        $uri = $request->getUri();
        $port = $uri->getPort();
        $suffix = ($port !== null && $port !== 80 && $port !== 443) ? ':' . $port : '';
        return self::requestScheme($request) . '://' . strtolower($uri->getHost()) . $suffix;
    }

    /** Canonical RFC 8707 resource identifier for this MCP server as reached by $request. */
    public static function resourceFor(Request $request): string
    {
        return self::publicOrigin($request) . '/api/mcp';
    }

    /** Dedicated audience for the native Companion profile; it cannot authenticate /api/mcp. */
    public static function companionResourceFor(Request $request): string
    {
        return self::publicOrigin($request) . '/api/aokie-companion';
    }

    public static function resourceForClient(Request $request, string $clientId): string
    {
        return self::isAokieCompanionClient($clientId)
            ? self::companionResourceFor($request)
            : self::resourceFor($request);
    }

    /**
     * The RFC 9728 §5.1 challenge that /api/mcp MUST send on every 401 — it is the discovery trigger
     * for MCP clients (Claude ignores WWW-Authenticate on 200s; the 401 header starts the OAuth flow).
     */
    public static function wwwAuthenticateHeader(Request $request): string
    {
        return 'Bearer resource_metadata="' . self::publicOrigin($request)
            . '/.well-known/oauth-protected-resource/api/mcp", scope="'
            . implode(' ', McpTokenService::DEFAULT_SCOPES) . '"';
    }

    /**
     * Audience check for OAuth-minted access tokens: the token row stores the resource it was issued
     * for; a request on a different host must be rejected (a token for server A can't replay on B).
     * Host(+non-default port) comparison — the scheme is derived identically on mint and use.
     */
    public static function resourceMatchesRequest(string $resource, Request $request): bool
    {
        $stored = parse_url($resource);
        if (!is_array($stored) || empty($stored['host']) || empty($stored['scheme'])) {
            return false;
        }
        $storedHost = strtolower((string) $stored['host'])
            . (isset($stored['port']) && $stored['port'] !== 80 && $stored['port'] !== 443 ? ':' . $stored['port'] : '');
        $uri = $request->getUri();
        $port = $uri->getPort();
        $requestHost = strtolower($uri->getHost()) . (($port !== null && $port !== 80 && $port !== 443) ? ':' . $port : '');
        $storedPath = rtrim((string) ($stored['path'] ?? ''), '/');
        $requestPath = rtrim($uri->getPath(), '/');
        $pathMatches = $storedPath !== ''
            && ($requestPath === $storedPath || str_starts_with($requestPath, $storedPath . '/'));
        return $storedHost !== ''
            && hash_equals(strtolower((string) $stored['scheme']), self::requestScheme($request))
            && hash_equals($storedHost, $requestHost)
            && $pathMatches;
    }

    /** Every scope an OAuth client may ask for: the MCP session scopes + offline_access (refresh). */
    public static function supportedScopes(): array
    {
        // A DCR/CIMD client is an MCP client, not a native-call client. Keep the
        // call scopes out of global discovery and out of its authorize policy.
        return array_merge(
            array_values(array_diff(McpTokenService::ALL_SCOPES, self::AOKIE_COMPANION_ONLY_SCOPES)),
            ['offline_access'],
        );
    }

    /** True for any first-party desktop runtime client (device-link → scoped API key). */
    public static function isDesktopClient(string $clientId): bool
    {
        return array_key_exists($clientId, self::DESKTOP_CLIENTS);
    }

    public static function isAokieCompanionClient(string $clientId): bool
    {
        return $clientId === self::AOKIE_COMPANION_CLIENT_ID;
    }

    /**
     * The scope vocabulary + default a given client draws from. The desktop client uses the
     * ApiKeyService DESKTOP_SCOPES; every other client keeps the unchanged MCP session scopes.
     * @return array{0: array, 1: array} [supportedScopes, defaultWhenNoneRequested]
     */
    private static function scopePolicyForClient(string $clientId): array
    {
        if (self::isDesktopClient($clientId)) {
            return [self::DESKTOP_SCOPES, self::DESKTOP_SCOPES];
        }
        if (self::isAokieCompanionClient($clientId)) {
            return [self::AOKIE_COMPANION_SCOPES, self::AOKIE_COMPANION_SCOPES];
        }
        return [self::supportedScopes(), McpTokenService::DEFAULT_SCOPES];
    }

    /** Human-readable labels for the consent screen (falls back to the raw scope for unknowns). */
    public static function scopeLabels(array $scopes): array
    {
        $map = [
            'apps:read' => 'Read your apps',
            'apps:write' => 'Create and edit apps',
            'forms:read' => 'Read your forms',
            'forms:write' => 'Create and edit forms',
            'screens:write' => 'Edit app screens',
            'responses:read' => 'Read form submissions',
            'responses:write' => 'Submit form responses',
            'offline_access' => 'Stay connected (refresh access)',
            'flows:read' => 'Read your flows, bindings and runs',
            'flows:write' => 'Run and complete flows',
            'connector:relay' => 'Act as a desktop runtime for connector commands',
            'aokie:realtime' => 'Connect the assigned Aokie Desktop plugin to Companion realtime calls',
            'aokie:state' => 'See live Aokie call state, caller details and captions for the selected app',
            'aokie:monitor' => 'Listen to a live Aokie call without microphone access',
            'aokie:consult' => 'Join a private voice consultation when invited',
            'aokie:takeover' => 'Take over a live caller using this device microphone',
            'aokie:resume' => 'Return a caller to the Aokie receptionist',
            'aokie:assistance' => 'Read and respond to typed Aokie assistance requests',
            'aokie:end_caller' => 'End the caller leg while you actively own the live call',
            'connector:command' => 'Send commands to your FormLogic Desktop connectors (e.g. control the Aokie phone) — account-wide',
        ];
        $out = [];
        foreach ($scopes as $scope) {
            $out[$scope] = $map[$scope] ?? $scope;
        }
        return $out;
    }

    // ── Discovery documents ──

    /** RFC 9728 protected-resource metadata for /api/mcp. */
    public function protectedResourceMetadata(Request $request): array
    {
        $origin = self::publicOrigin($request);
        return [
            'resource' => $origin . '/api/mcp',
            'authorization_servers' => [$origin],
            'scopes_supported' => self::supportedScopes(),
            'bearer_methods_supported' => ['header'],
        ];
    }

    /** RFC 8414 authorization-server metadata (issuer = the bare origin, no path). */
    public function authorizationServerMetadata(Request $request): array
    {
        $origin = self::publicOrigin($request);
        return [
            'issuer' => $origin,
            'authorization_endpoint' => $origin . '/oauth/authorize',
            'token_endpoint' => $origin . '/api/oauth/token',
            'registration_endpoint' => $origin . '/api/oauth/register',
            'response_types_supported' => ['code'],
            'grant_types_supported' => ['authorization_code', 'refresh_token'],
            'code_challenge_methods_supported' => ['S256'],
            'token_endpoint_auth_methods_supported' => ['none', 'client_secret_post'],
            'client_id_metadata_document_supported' => true,
            'scopes_supported' => self::supportedScopes(),
        ];
    }

    // ── Client registration (RFC 7591 DCR + CIMD) ──

    /**
     * RFC 7591 dynamic registration. Returns ['ok'=>true,'client'=>payload] (the 201 body) or
     * ['ok'=>false,'error'=>...,'error_description'=>...]. Confidential is the default (Claude
     * registers confidential and expects a client_secret); token_endpoint_auth_method 'none' opts
     * into a public client. Only 'none' and 'client_secret_post' are supported, so any other
     * confidential method (e.g. client_secret_basic) is normalized to client_secret_post.
     */
    public function registerClient(array $meta): array
    {
        $redirects = $meta['redirect_uris'] ?? null;
        if (!is_array($redirects) || $redirects === [] || count($redirects) > 10) {
            return ['ok' => false, 'error' => 'invalid_redirect_uri', 'error_description' => 'redirect_uris must be a non-empty array (max 10)'];
        }
        $redirects = array_values($redirects);
        foreach ($redirects as $uri) {
            if (!is_string($uri) || !self::validRedirectUri($uri)) {
                return ['ok' => false, 'error' => 'invalid_redirect_uri', 'error_description' => 'redirect_uris contains an invalid entry (https, loopback http, or a native app scheme; no fragments)'];
            }
        }
        $name = $this->cleanText($meta['client_name'] ?? null, 255);
        $clientUri = null;
        if (is_string($meta['client_uri'] ?? null) && strlen($meta['client_uri']) <= 500) {
            $scheme = strtolower((string) parse_url($meta['client_uri'], PHP_URL_SCHEME));
            if ($scheme === 'https' || $scheme === 'http') {
                $clientUri = $meta['client_uri'];
            }
        }
        $method = (($meta['token_endpoint_auth_method'] ?? '') === 'none') ? 'none' : 'client_secret_post';

        $clientId = self::CLIENT_ID_PREFIX . bin2hex(random_bytes(16));
        $secret = $method === 'none' ? null : self::CLIENT_SECRET_PREFIX . bin2hex(random_bytes(24));

        $stmt = $this->db()->prepare("
            INSERT INTO mcp_oauth_clients
                (client_id_hash, client_id, secret_hash, token_endpoint_auth_method, client_name, client_uri, redirect_uris, is_cimd, fetched_at, created_at)
            VALUES (:h, :cid, :sh, :method, :name, :uri, :redirects, 0, NULL, :now)
        ");
        $stmt->execute([
            'h' => hash('sha256', $clientId),
            'cid' => $clientId,
            'sh' => $secret !== null ? hash('sha256', $secret) : null,
            'method' => $method,
            'name' => $name,
            'uri' => $clientUri,
            'redirects' => json_encode($redirects),
            'now' => date('Y-m-d H:i:s'),
        ]);

        $payload = [
            'client_id' => $clientId,
            'client_id_issued_at' => time(),
            'redirect_uris' => $redirects,
            'token_endpoint_auth_method' => $method,
            'grant_types' => ['authorization_code', 'refresh_token'],
            'response_types' => ['code'],
        ];
        if ($secret !== null) {
            // client_secret_expires_at: 0 => never expires (RFC 7591 §3.2.1); shown once, stored hashed.
            $payload['client_secret'] = $secret;
            $payload['client_secret_expires_at'] = 0;
        }
        if ($name !== null) {
            $payload['client_name'] = $name;
        }
        if ($clientUri !== null) {
            $payload['client_uri'] = $clientUri;
        }
        return ['ok' => true, 'client' => $payload];
    }

    /**
     * Resolve a client_id to its registration: a URL-shaped client_id (https + a path) is a CIMD
     * client (metadata fetched from that URL, spec-preferred — Claude's path); anything else is a
     * DCR-registered row. Returns null when unresolvable.
     *
     * @return array{clientId:string,name:?string,clientUri:?string,redirectUris:array,authMethod:string,secretHash:?string,isCimd:bool}|null
     */
    public function resolveClient(string $clientId): ?array
    {
        $clientId = trim($clientId);
        if ($clientId === '' || strlen($clientId) > 500) {
            return null;
        }
        if (self::isCimdClientId($clientId)) {
            return $this->resolveCimdClient($clientId);
        }
        $stmt = $this->db()->prepare("SELECT * FROM mcp_oauth_clients WHERE client_id_hash = :h AND is_cimd = 0 LIMIT 1");
        $stmt->execute(['h' => hash('sha256', $clientId)]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ? $this->clientFromRow($row) : null;
    }

    /** Constant-time client-secret check; public ('none') clients pass without one (PKCE is their proof). */
    public function authenticateClient(array $client, ?string $secret): bool
    {
        if (($client['authMethod'] ?? '') === 'none') {
            return true;
        }
        if (!is_string($secret) || $secret === '' || !is_string($client['secretHash'] ?? null)) {
            return false;
        }
        return hash_equals($client['secretHash'], hash('sha256', $secret));
    }

    /** Exact-match redirect validation, with the RFC 8252 §7.3 loopback port-agnostic carve-out. */
    public function redirectUriAllowed(array $client, string $redirectUri): bool
    {
        foreach (($client['redirectUris'] ?? []) as $registered) {
            if (is_string($registered) && self::redirectUriMatches($registered, $redirectUri)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Exact string match (this is the path https://claude.ai/api/mcp/auth_callback takes) — EXCEPT
     * loopback http redirects (Claude Code binds a random localhost port per RFC 8252 §7.3), which
     * match with ANY port as long as scheme/host/path/query are identical.
     */
    public static function redirectUriMatches(string $registered, string $requested): bool
    {
        if ($registered === $requested) {
            return true;
        }
        $r = parse_url($registered);
        $q = parse_url($requested);
        if (!is_array($r) || !is_array($q)) {
            return false;
        }
        if (($r['scheme'] ?? '') !== 'http' || ($q['scheme'] ?? '') !== 'http') {
            return false;
        }
        $rh = strtolower((string) ($r['host'] ?? ''));
        if ($rh === '' || $rh !== strtolower((string) ($q['host'] ?? '')) || !in_array($rh, self::LOOPBACK_HOSTS, true)) {
            return false;
        }
        return ($r['path'] ?? '/') === ($q['path'] ?? '/') && ($r['query'] ?? '') === ($q['query'] ?? '');
    }

    // ── Authorization request validation + code minting ──

    /**
     * Validate one authorization request (shared by GET /api/oauth/authorize-info and POST
     * /api/oauth/approve so the approve path can never be laxer than the info the user consented on).
     * OAuth 2.1 rules: PKCE is REQUIRED and only S256 is accepted; the RFC 8707 resource, when
     * present, must be exactly this server's '<origin>/api/mcp'.
     *
     * @return array ['ok'=>true, 'client','redirectUri','scopes','codeChallenge','resource']
     *               or ['ok'=>false, 'error','error_description'] (RFC 6749-style error codes)
     */
    public function validateAuthorizeRequest(array $p, Request $request): array
    {
        $err = static fn (string $e, string $d) => ['ok' => false, 'error' => $e, 'error_description' => $d];

        $clientId = trim((string) ($p['client_id'] ?? ''));
        if ($clientId === '') {
            return $err('invalid_request', 'client_id is required');
        }
        $client = $this->resolveClient($clientId);
        if ($client === null) {
            return $err('invalid_client', 'Unknown client_id — register via /api/oauth/register or use a resolvable client-metadata URL');
        }
        $redirectUri = trim((string) ($p['redirect_uri'] ?? ''));
        if ($redirectUri === '' || !$this->redirectUriAllowed($client, $redirectUri)) {
            return $err('invalid_request', 'redirect_uri does not match the client registration');
        }
        if (isset($p['response_type']) && $p['response_type'] !== 'code') {
            return $err('unsupported_response_type', 'Only response_type=code is supported');
        }
        // OAuth 2.1: PKCE is mandatory; 'plain' is rejected, only S256.
        $challenge = trim((string) ($p['code_challenge'] ?? ''));
        if ($challenge === '') {
            return $err('invalid_request', 'PKCE is required: code_challenge is missing');
        }
        $method = trim((string) ($p['code_challenge_method'] ?? ''));
        if ($method !== 'S256') {
            return $err('invalid_request', 'code_challenge_method must be S256');
        }
        if (!preg_match('/^[A-Za-z0-9\-._~]{43,128}$/', $challenge)) {
            return $err('invalid_request', 'Malformed code_challenge');
        }
        $expectedResource = self::resourceForClient($request, $client['clientId']);
        $resource = trim((string) ($p['resource'] ?? ''));
        if ($resource !== '' && $resource !== $expectedResource) {
            return $err('invalid_target', 'resource must be ' . $expectedResource);
        }
        [$supported, $default] = self::scopePolicyForClient($client['clientId']);
        $scopes = $this->grantedScopes((string) ($p['scope'] ?? ''), $supported, $default);
        if ($scopes === null) {
            return $err('invalid_scope', 'None of the requested scopes are supported');
        }
        $device = $this->cleanText($p['device'] ?? null, 100);
        if (self::isAokieCompanionClient($client['clientId'])
            && (!is_string($device) || preg_match('/^[A-Za-z0-9_.:-]{1,100}$/D', $device) !== 1)) {
            return $err('invalid_request', 'device is required and must be a stable safe identifier for Aokie Companion');
        }
        return [
            'ok' => true,
            'client' => $client,
            'redirectUri' => $redirectUri,
            'scopes' => $scopes,
            'codeChallenge' => $challenge,
            'resource' => $expectedResource,
            // Sanitized device label from ?device= — carried through consent to the token exchange so
            // a desktop-minted key/connection can be named "FormLogic Desktop on <device>". null otherwise.
            'device' => $device,
        ];
    }

    /**
     * Mint a one-time authorization code bound to client + redirect_uri + PKCE challenge + user +
     * scopes + resource (+ optional app narrowing). <=60s TTL, single use, stored hashed.
     */
    public function mintCode(string $userId, string $clientId, string $redirectUri, array $scopes, string $codeChallenge, string $resource, ?string $appId, ?string $deviceLabel = null): string
    {
        $this->purgeExpired();
        $raw = self::CODE_PREFIX . bin2hex(random_bytes(24));
        $stmt = $this->db()->prepare("
            INSERT INTO mcp_oauth_codes
                (id, code_hash, client_id, user_id, app_id, redirect_uri, scopes, code_challenge, resource, device_label, expires_at, created_at)
            VALUES (:id, :h, :cid, :uid, :app, :redirect, :scopes, :challenge, :resource, :device, :exp, :now)
        ");
        $stmt->execute([
            'id' => $this->uuid(),
            'h' => hash('sha256', $raw),
            'cid' => $clientId,
            'uid' => $userId,
            'app' => $appId,
            'redirect' => $redirectUri,
            'scopes' => json_encode(array_values($scopes)),
            'challenge' => $codeChallenge,
            'resource' => $resource,
            'device' => $deviceLabel,
            'exp' => date('Y-m-d H:i:s', time() + self::CODE_TTL),
            'now' => date('Y-m-d H:i:s'),
        ]);
        return $raw;
    }

    /**
     * Redeem an authorization code. Single use is enforced ATOMICALLY (UPDATE ... WHERE used_at IS
     * NULL + rowCount), so a concurrent double-spend loses cleanly; any validation failure after the
     * claim leaves the code burned (safer than releasing it).
     *
     * @return array ['ok'=>true,'userId','appId','scopes','resource'] or ['ok'=>false,'error','error_description']
     */
    public function redeemCode(string $rawCode, string $clientId, string $redirectUri, string $verifier, ?string $resourceParam): array
    {
        $err = static fn (string $d) => ['ok' => false, 'error' => 'invalid_grant', 'error_description' => $d];

        $stmt = $this->db()->prepare("SELECT * FROM mcp_oauth_codes WHERE code_hash = :h LIMIT 1");
        $stmt->execute(['h' => hash('sha256', $rawCode)]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return $err('Unknown or expired authorization code');
        }
        $claim = $this->db()->prepare("UPDATE mcp_oauth_codes SET used_at = :now WHERE id = :id AND used_at IS NULL");
        $claim->execute(['now' => date('Y-m-d H:i:s'), 'id' => $row['id']]);
        if ($claim->rowCount() === 0) {
            return $err('Authorization code has already been used');
        }
        if (strtotime((string) $row['expires_at']) < time()) {
            return $err('Authorization code expired');
        }
        if ((string) $row['client_id'] !== $clientId) {
            return $err('Authorization code was issued to a different client');
        }
        if ((string) $row['redirect_uri'] !== $redirectUri) {
            return $err('redirect_uri does not match the authorization request');
        }
        if (!preg_match('/^[A-Za-z0-9\-._~]{43,128}$/', $verifier)) {
            return $err('Malformed code_verifier');
        }
        // PKCE S256: BASE64URL(SHA256(verifier)) must equal the stored challenge, constant-time.
        $computed = rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '=');
        if (!hash_equals((string) $row['code_challenge'], $computed)) {
            return $err('PKCE verification failed');
        }
        if ($resourceParam !== null && $resourceParam !== '' && $resourceParam !== (string) $row['resource']) {
            return $err('resource does not match the authorization request');
        }
        $scopes = json_decode((string) $row['scopes'], true);
        return [
            'ok' => true,
            // Which client redeemed this code. Needed once more than one
            // desktop runtime can link: without it the audit log falls back to
            // a constant and reports every link as the first-party one.
            'clientId' => (string) $row['client_id'],
            'userId' => (string) $row['user_id'],
            'appId' => $row['app_id'] !== null ? (string) $row['app_id'] : null,
            'scopes' => is_array($scopes) ? $scopes : McpTokenService::DEFAULT_SCOPES,
            'resource' => (string) $row['resource'],
            'deviceLabel' => isset($row['device_label']) && $row['device_label'] !== null ? (string) $row['device_label'] : null,
        ];
    }

    // ── Token issuance ──

    /**
     * Mint the access token (an flm_oauth_ McpTokenService session, 1h absolute expiry, audience-bound
     * to $resource) + a refresh token, as the RFC 6749 token-response body.
     */
    public function issueTokenPair(
        string $userId,
        ?string $appId,
        array $scopes,
        string $resource,
        string $clientId,
        ?string $familyId = null,
        ?string $deviceId = null,
    ): array
    {
        $familyId ??= $this->uuid();
        $ttl = self::isAokieCompanionClient($clientId)
            ? self::AOKIE_COMPANION_ACCESS_TOKEN_TTL
            : self::ACCESS_TOKEN_TTL;
        $access = $this->tokens->createOAuth(
            $userId,
            $appId,
            $scopes,
            $resource,
            $ttl,
            $clientId,
            $deviceId,
            $familyId,
        );
        return [
            'access_token' => $access['token'],
            'token_type' => 'Bearer',
            'expires_in' => $ttl,
            'refresh_token' => $this->mintRefreshToken($userId, $clientId, $appId, $scopes, $resource, $familyId, $deviceId),
            'scope' => implode(' ', $scopes),
        ];
    }

    /** Access-token-only variant (confidential-client refresh keeps its same refresh token). */
    public function issueAccessToken(
        string $userId,
        ?string $appId,
        array $scopes,
        string $resource,
        string $clientId,
        ?string $deviceId = null,
        ?string $familyId = null,
    ): array
    {
        $ttl = self::isAokieCompanionClient($clientId)
            ? self::AOKIE_COMPANION_ACCESS_TOKEN_TTL
            : self::ACCESS_TOKEN_TTL;
        $access = $this->tokens->createOAuth(
            $userId,
            $appId,
            $scopes,
            $resource,
            $ttl,
            $clientId,
            $deviceId,
            $familyId,
        );
        return [
            'access_token' => $access['token'],
            'token_type' => 'Bearer',
            'expires_in' => $ttl,
            'scope' => implode(' ', $scopes),
        ];
    }

    /** Mint a refresh token (hashed at rest). $familyId chains rotations for reuse detection. */
    public function mintRefreshToken(
        string $userId,
        string $clientId,
        ?string $appId,
        array $scopes,
        string $resource,
        ?string $familyId = null,
        ?string $deviceId = null,
    ): string
    {
        $raw = self::REFRESH_PREFIX . bin2hex(random_bytes(24));
        $stmt = $this->db()->prepare("
            INSERT INTO mcp_oauth_refresh_tokens
                (id, token_hash, family_id, client_id, user_id, app_id, scopes, resource, device_id, expires_at, created_at)
            VALUES (:id, :h, :family, :cid, :uid, :app, :scopes, :resource, :device, :exp, :now)
        ");
        $stmt->execute([
            'id' => $this->uuid(),
            'h' => hash('sha256', $raw),
            'family' => $familyId ?? $this->uuid(),
            'cid' => $clientId,
            'uid' => $userId,
            'app' => $appId,
            'scopes' => json_encode(array_values($scopes)),
            'resource' => $resource,
            'device' => $deviceId,
            'exp' => date('Y-m-d H:i:s', time() + self::REFRESH_TOKEN_TTL),
            'now' => date('Y-m-d H:i:s'),
        ]);
        return $raw;
    }

    /**
     * Redeem a refresh token. PUBLIC clients get ROTATION: the presented token is atomically retired
     * and a new one (same family) is returned; presenting an already-rotated token is theft evidence
     * and revokes the WHOLE family. Confidential clients keep their token (no rotation).
     *
     * @return array ['ok'=>true,'userId','appId','scopes','resource','newRefreshToken'=>?string]
     *               or ['ok'=>false,'error','error_description']
     */
    public function redeemRefreshToken(string $raw, string $clientId, bool $isPublicClient): array
    {
        $err = static fn (string $d) => ['ok' => false, 'error' => 'invalid_grant', 'error_description' => $d];

        $stmt = $this->db()->prepare("SELECT * FROM mcp_oauth_refresh_tokens WHERE token_hash = :h LIMIT 1");
        $stmt->execute(['h' => hash('sha256', $raw)]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return $err('Unknown refresh token');
        }
        if ($row['revoked_at'] !== null) {
            return $err('Refresh token has been revoked');
        }
        if ($row['rotated_at'] !== null) {
            // Reuse of a rotated token => the family is compromised; kill every descendant.
            $this->revokeRefreshFamily((string) $row['family_id']);
            return $err('Refresh token reuse detected — all sessions for this grant were revoked');
        }
        if (strtotime((string) $row['expires_at']) < time()) {
            return $err('Refresh token expired');
        }
        if ((string) $row['client_id'] !== $clientId) {
            return $err('Refresh token was issued to a different client');
        }

        $scopes = json_decode((string) $row['scopes'], true);
        $result = [
            'ok' => true,
            'userId' => (string) $row['user_id'],
            'appId' => $row['app_id'] !== null ? (string) $row['app_id'] : null,
            'scopes' => is_array($scopes) ? $scopes : McpTokenService::DEFAULT_SCOPES,
            'resource' => (string) $row['resource'],
            'deviceId' => isset($row['device_id']) && is_string($row['device_id']) ? $row['device_id'] : null,
            'familyId' => (string) $row['family_id'],
            'newRefreshToken' => null,
        ];
        if ($isPublicClient) {
            // Atomic rotation claim — a concurrent redeem of the same token means reuse: revoke family.
            $claim = $this->db()->prepare("UPDATE mcp_oauth_refresh_tokens SET rotated_at = :now WHERE id = :id AND rotated_at IS NULL AND revoked_at IS NULL");
            $claim->execute(['now' => date('Y-m-d H:i:s'), 'id' => $row['id']]);
            if ($claim->rowCount() === 0) {
                $this->revokeRefreshFamily((string) $row['family_id']);
                return $err('Refresh token reuse detected — all sessions for this grant were revoked');
            }
            $result['newRefreshToken'] = $this->mintRefreshToken(
                $result['userId'],
                $clientId,
                $result['appId'],
                $result['scopes'],
                $result['resource'],
                (string) $row['family_id'],
                $result['deviceId'],
            );
        }
        return $result;
    }

    /**
     * Scope narrowing at the token endpoint (refresh): the new grant may only shrink. Returns the
     * effective scope list, or null when the request names none of the originally-granted scopes.
     */
    public function narrowScopes(string $scopeParam, array $granted): ?array
    {
        $requested = array_values(array_filter(explode(' ', trim($scopeParam)), static fn ($s) => $s !== ''));
        if ($requested === []) {
            return $granted;
        }
        $narrowed = array_values(array_intersect($granted, $requested));
        return $narrowed === [] ? null : $narrowed;
    }

    // ── Internals ──

    /**
     * The scope list a grant gets: requested ∩ supported. No scope requested => the same safe default
     * as manual MCP tokens (builder scopes, NO responses:*). ONLY offline_access requested still
     * grants the builder defaults (an access token with zero MCP scopes would be useless). Returns
     * null when scopes were requested but none are supported (invalid_scope).
     */
    private function grantedScopes(string $scopeParam, ?array $supported = null, ?array $default = null): ?array
    {
        $supported ??= self::supportedScopes();
        $default ??= McpTokenService::DEFAULT_SCOPES;
        $requested = array_values(array_filter(explode(' ', trim($scopeParam)), static fn ($s) => $s !== ''));
        if ($requested === []) {
            return $default;
        }
        $granted = array_values(array_intersect($requested, $supported));
        if ($granted === []) {
            return null;
        }
        if ($granted === ['offline_access']) {
            return array_values(array_unique(array_merge($default, ['offline_access'])));
        }
        return $granted;
    }

    /**
     * CIMD detection: a URL-shaped client_id — https with a non-trivial path. In development ONLY,
     * an http loopback URL also qualifies so a local client-metadata document can be tested; in
     * production a localhost client_id fails closed (isCimd true → the SSRF guard rejects the fetch,
     * and it can never collide with a DCR row because DCR ids are opaque mcpc_ strings).
     */
    public static function isCimdClientId(string $clientId): bool
    {
        $p = parse_url($clientId);
        if (!is_array($p) || empty($p['host']) || (($p['path'] ?? '') === '' || ($p['path'] ?? '') === '/')) {
            return false;
        }
        $scheme = strtolower((string) ($p['scheme'] ?? ''));
        if ($scheme === 'https') {
            return true;
        }
        return $scheme === 'http'
            && in_array(strtolower((string) $p['host']), self::LOOPBACK_HOSTS, true)
            && self::isDevelopment();
    }

    /** Resolve a CIMD client: serve from the ~5min cache, else fetch + validate + cache. */
    private function resolveCimdClient(string $url): ?array
    {
        $hash = hash('sha256', $url);
        $stmt = $this->db()->prepare("SELECT * FROM mcp_oauth_clients WHERE client_id_hash = :h AND is_cimd = 1 LIMIT 1");
        $stmt->execute(['h' => $hash]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row && $row['fetched_at'] !== null && (time() - strtotime((string) $row['fetched_at'])) < self::CIMD_CACHE_TTL) {
            return $this->clientFromRow($row);
        }

        $doc = $this->fetchCimdDocument($url);
        if (!is_array($doc)) {
            return null; // fail closed — a stale cache row is NOT trusted past its TTL
        }
        // The document must claim exactly this URL as its client_id (spec: identity = the URL).
        if (($doc['client_id'] ?? null) !== $url) {
            return null;
        }
        $redirects = $doc['redirect_uris'] ?? null;
        if (!is_array($redirects) || $redirects === [] || count($redirects) > 10) {
            return null;
        }
        foreach ($redirects as $uri) {
            if (!is_string($uri) || !self::validRedirectUri($uri)) {
                return null;
            }
        }
        $name = $this->cleanText($doc['client_name'] ?? null, 255) ?? (string) parse_url($url, PHP_URL_HOST);
        $clientUri = null;
        if (is_string($doc['client_uri'] ?? null) && strlen($doc['client_uri']) <= 500) {
            $scheme = strtolower((string) parse_url($doc['client_uri'], PHP_URL_SCHEME));
            if ($scheme === 'https' || $scheme === 'http') {
                $clientUri = $doc['client_uri'];
            }
        }

        // CIMD clients are PUBLIC ('none') — there is no out-of-band secret exchange.
        $upsert = $this->db()->prepare("
            INSERT INTO mcp_oauth_clients
                (client_id_hash, client_id, secret_hash, token_endpoint_auth_method, client_name, client_uri, redirect_uris, is_cimd, fetched_at, created_at)
            VALUES (:h, :cid, NULL, 'none', :name, :uri, :redirects, 1, :now, :now2)
            ON DUPLICATE KEY UPDATE
                client_name = VALUES(client_name), client_uri = VALUES(client_uri),
                redirect_uris = VALUES(redirect_uris), fetched_at = VALUES(fetched_at)
        ");
        $now = date('Y-m-d H:i:s');
        $upsert->execute(['h' => $hash, 'cid' => $url, 'name' => $name, 'uri' => $clientUri, 'redirects' => json_encode(array_values($redirects)), 'now' => $now, 'now2' => $now]);

        return [
            'clientId' => $url,
            'name' => $name,
            'clientUri' => $clientUri,
            'redirectUris' => array_values($redirects),
            'authMethod' => 'none',
            'secretHash' => null,
            'isCimd' => true,
        ];
    }

    /**
     * Fetch a client-metadata document, hardened: IpSafety SSRF guard at fetch time (skipped only in
     * development so a loopback CIMD is testable), redirects forbidden, 5s timeout, 64KB cap,
     * Content-Type must be JSON. Returns the decoded document or null.
     */
    private function fetchCimdDocument(string $url): ?array
    {
        $host = (string) parse_url($url, PHP_URL_HOST);
        if ($host === '') {
            return null;
        }
        // SSRF: resolve NOW (DNS may have changed since any earlier check) and require every IP to be
        // public. Development narrows the policy to "loopback is also allowed" (so a http://localhost
        // CIMD doc is testable) rather than disabling the guard — a dev box must still refuse cloud
        // metadata, link-local and LAN destinations (audit DEPLOY-001: security policy is not a
        // developer-diagnostics switch).
        $reason = null;
        $approvedIp = null;
        if (!IpSafety::resolvesToPublicHost($host, $reason, $approvedIp)) {
            $devLoopback = self::isDevelopment() && in_array(strtolower($host), self::LOOPBACK_HOSTS, true);
            if (!$devLoopback) {
                $this->logger?->info('MCP OAuth: CIMD fetch blocked', ['host' => $host, 'reason' => $reason]);
                return null;
            }
        }
        if (!function_exists('curl_init')) {
            return null;
        }
        $buffer = '';
        $ch = curl_init($url);
        $curlOpts = [
            CURLOPT_FOLLOWLOCATION => false, // 3xx is a hard failure — no redirect chasing
            CURLOPT_MAXREDIRS => 0,
            CURLOPT_TIMEOUT => self::CIMD_TIMEOUT_SECONDS,
            CURLOPT_CONNECTTIMEOUT => self::CIMD_TIMEOUT_SECONDS,
            CURLOPT_HTTPHEADER => ['Accept: application/json'],
            CURLOPT_USERAGENT => 'FormLogic-MCP-OAuth/1.0',
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP,
            CURLOPT_REDIR_PROTOCOLS => 0,
            CURLOPT_WRITEFUNCTION => static function ($ch, string $chunk) use (&$buffer): int {
                $buffer .= $chunk;
                return strlen($buffer) > self::CIMD_MAX_BYTES ? -1 : strlen($chunk); // abort past the cap
            },
        ];
        // Vendored CA bundle fallback (same idiom as WebhookService/AIService): without it, PHP curl
        // builds with no default CA store (Windows/WAMP notably) fail TLS verification on EVERY CIMD
        // fetch — which surfaced as Claude's "authorization failed" (invalid_client) because the
        // claude.ai client-metadata document silently could not be fetched. Only applied when the
        // operator hasn't configured their own curl.cainfo / CURL_CA_BUNDLE (don't override a private CA).
        $caBundle = __DIR__ . '/../../resources/cacert.pem';
        if (!ini_get('curl.cainfo') && !getenv('CURL_CA_BUNDLE') && is_file($caBundle)) {
            $curlOpts[CURLOPT_CAINFO] = $caBundle;
        }
        // DNS pinning: connect to the address the check above approved. Without it
        // the check-then-fetch is a rebinding window — a name that resolved public
        // a moment ago can resolve to an internal host when curl looks it up.
        if (is_string($approvedIp) && $approvedIp !== '') {
            $port = (int) (parse_url($url, PHP_URL_PORT) ?: (parse_url($url, PHP_URL_SCHEME) === 'https' ? 443 : 80));
            $curlOpts[CURLOPT_RESOLVE] = ["{$host}:{$port}:{$approvedIp}"];
        }
        curl_setopt_array($ch, $curlOpts);
        curl_exec($ch);
        $curlErr = curl_errno($ch) !== 0 ? curl_error($ch) : null;
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $contentType = strtolower((string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE));
        curl_close($ch);
        if ($curlErr !== null) {
            // Surface WHY in the log — a silent null here cost a production debugging round trip.
            $this->logger?->warning('MCP OAuth: CIMD fetch failed', ['host' => $host, 'error' => $curlErr]);
        }
        if ($status !== 200 || strlen($buffer) > self::CIMD_MAX_BYTES || !str_contains($contentType, 'json')) {
            return null;
        }
        $doc = json_decode($buffer, true);
        return is_array($doc) ? $doc : null;
    }

    /** @return array{clientId:string,name:?string,clientUri:?string,redirectUris:array,authMethod:string,secretHash:?string,isCimd:bool} */
    private function clientFromRow(array $row): array
    {
        $redirects = json_decode((string) $row['redirect_uris'], true);
        return [
            'clientId' => (string) $row['client_id'],
            'name' => $row['client_name'] !== null ? (string) $row['client_name'] : null,
            'clientUri' => $row['client_uri'] !== null ? (string) $row['client_uri'] : null,
            'redirectUris' => is_array($redirects) ? $redirects : [],
            'authMethod' => (string) $row['token_endpoint_auth_method'],
            'secretHash' => $row['secret_hash'] !== null ? (string) $row['secret_hash'] : null,
            'isCimd' => (bool) $row['is_cimd'],
        ];
    }

    private function revokeRefreshFamily(string $familyId): void
    {
        $stmt = $this->db()->prepare("UPDATE mcp_oauth_refresh_tokens SET revoked_at = :now WHERE family_id = :f AND revoked_at IS NULL");
        $stmt->execute(['now' => date('Y-m-d H:i:s'), 'f' => $familyId]);
        // Access sessions remain database-backed specifically so a stolen,
        // already-rotated refresh token can revoke every descendant access
        // token immediately rather than waiting for its ten-minute TTL.
        $stmt = $this->db()->prepare(
            'UPDATE mcp_sessions SET revoked_at = :now
             WHERE refresh_family_id = :f AND revoked_at IS NULL'
        );
        $stmt->execute(['now' => date('Y-m-d H:i:s'), 'f' => $familyId]);
    }

    /**
     * Redirect URI shape check (DCR + CIMD): https anywhere, http ONLY on loopback (RFC 8252), a
     * native-app custom scheme is allowed (RFC 8252 §7.1), executable/pseudo schemes and fragments never.
     */
    private static function validRedirectUri(string $uri): bool
    {
        if ($uri === '' || strlen($uri) > 1000) {
            return false;
        }
        $p = parse_url($uri);
        if (!is_array($p) || empty($p['scheme']) || isset($p['fragment'])) {
            return false;
        }
        $scheme = strtolower((string) $p['scheme']);
        if (in_array($scheme, ['javascript', 'data', 'file', 'vbscript', 'blob', 'about'], true)) {
            return false;
        }
        if ($scheme === 'http') {
            return in_array(strtolower((string) ($p['host'] ?? '')), self::LOOPBACK_HOSTS, true);
        }
        if ($scheme === 'https') {
            return !empty($p['host']);
        }
        return true; // custom native-app scheme
    }

    /** Opportunistic GC: dead codes (past a 1h grace so late reuse still 404s cleanly) + dead refresh tokens. */
    private function purgeExpired(): void
    {
        try {
            $this->db()->exec("DELETE FROM mcp_oauth_codes WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)");
            $this->db()->exec("DELETE FROM mcp_oauth_refresh_tokens WHERE expires_at < NOW()");
        } catch (\Throwable $e) {
            // GC is best-effort
        }
    }

    private function cleanText(mixed $value, int $max): ?string
    {
        if (!is_string($value)) {
            return null;
        }
        $value = trim(preg_replace('/[\x00-\x1F\x7F]/', '', $value) ?? '');
        if ($value === '') {
            return null;
        }
        return mb_substr($value, 0, $max);
    }

    private static function isDevelopment(): bool
    {
        return ($_ENV['APP_ENV'] ?? (getenv('APP_ENV') ?: 'production')) === 'development';
    }

    private function uuid(): string
    {
        $d = random_bytes(16);
        $d[6] = chr((ord($d[6]) & 0x0f) | 0x40);
        $d[8] = chr((ord($d[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
    }
}
