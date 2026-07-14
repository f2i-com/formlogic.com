<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\McpController;
use FormLogic\Controllers\McpOAuthController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppReportService;
use FormLogic\Services\AppService;
use FormLogic\Services\FormService;
use FormLogic\Services\McpOAuthService;
use FormLogic\Services\McpTokenService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;

/**
 * End-to-end MCP OAuth 2.1 flow against a real DB: RFC 9728/8414 discovery, DCR registration,
 * authorize-info validation, consent -> one-time code, PKCE-verified token exchange, the minted
 * access token driving /api/mcp, audience binding, refresh rotation + reuse revocation, the exact
 * WWW-Authenticate 401 challenge, loopback port-agnostic redirects and the claude.ai callback.
 * Skipped without a test database (same setup as the other Integration tests).
 */
class McpOAuthFlowTest extends TestCase
{
    /** All requests are built against this origin; expectations derive from it via McpOAuthService. */
    private const BASE = 'http://localhost';

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static McpTokenService $tokens;
    private static McpOAuthService $oauth;
    private static McpOAuthController $oauthCtrl;
    private static McpController $mcpCtrl;
    private static AppService $apps;

    private string $userId = '';
    /** @var string[] client_ids registered during the test (cleaned up in tearDown) */
    private array $clientIds = [];

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        $config = [
            'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
            'port' => $_ENV['DB_PORT'] ?? '3306',
            'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
            'username' => $_ENV['DB_USERNAME'] ?? 'root',
            'password' => $_ENV['DB_PASSWORD'] ?? '',
            'charset' => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
        ];
        try {
            $conn = new MySQLConnection($config);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-mcp-oauth-test-' . bin2hex(random_bytes(4)));
        $forms = new FormService($conn, $sqlite);
        $responses = new ResponseService($conn, $sqlite);
        self::$apps = new AppService($conn, $forms);
        self::$tokens = new McpTokenService($conn);
        self::$oauth = new McpOAuthService($conn, self::$tokens);
        self::$oauthCtrl = new McpOAuthController(self::$oauth, self::$apps);
        self::$mcpCtrl = new McpController(self::$tokens, $forms, self::$apps, $responses, null, null, new AppReportService(self::$apps, $forms));
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$this->userId, $this->userId . '@test.local']);
        $this->clientIds = [];
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->userId === '') {
            return;
        }
        foreach ($this->clientIds as $cid) {
            self::$pdo->prepare('DELETE FROM mcp_oauth_clients WHERE client_id_hash = ?')->execute([hash('sha256', $cid)]);
        }
        self::$pdo->prepare('DELETE FROM mcp_oauth_codes WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM mcp_oauth_refresh_tokens WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM mcp_sessions WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM app_forms WHERE app_id IN (SELECT id FROM apps WHERE owner_id = ?)')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    // ── helpers ──

    private function probe(string $path = '/api/mcp'): \Psr\Http\Message\ServerRequestInterface
    {
        return (new ServerRequestFactory())->createServerRequest('GET', self::BASE . $path);
    }

    /** The origin/resource exactly as the server derives them for BASE (env-agnostic). */
    private function origin(): string
    {
        return McpOAuthService::publicOrigin($this->probe());
    }

    private function resource(): string
    {
        return McpOAuthService::resourceFor($this->probe());
    }

    private static function decode(ResponseInterface $resp): array
    {
        $resp->getBody()->rewind();
        return json_decode((string) $resp->getBody(), true) ?: [];
    }

    /** Register a client via the DCR endpoint. Returns the 201 payload. */
    private function register(array $meta): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/oauth/register')
            ->withHeader('Content-Type', 'application/json')
            ->withParsedBody($meta);
        $resp = self::$oauthCtrl->register($req, (new ResponseFactory())->createResponse());
        $body = self::decode($resp);
        $this->assertSame(201, $resp->getStatusCode(), 'DCR should return 201: ' . json_encode($body));
        $this->clientIds[] = (string) $body['client_id'];
        return $body;
    }

    /** @return array{verifier:string, challenge:string} */
    private function pkce(): array
    {
        $verifier = rtrim(strtr(base64_encode(random_bytes(48)), '+/', '-_'), '=');
        return [
            'verifier' => $verifier,
            'challenge' => rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '='),
        ];
    }

    /** Standard authorize params for $client (override/remove keys per test). */
    private function authorizeParams(array $client, string $challenge, array $overrides = []): array
    {
        $params = [
            'client_id' => $client['client_id'],
            'redirect_uri' => $client['redirect_uris'][0],
            'scope' => 'apps:read apps:write forms:read forms:write screens:write offline_access',
            'state' => 'st-' . bin2hex(random_bytes(6)),
            'code_challenge' => $challenge,
            'code_challenge_method' => 'S256',
            'resource' => $this->resource(),
        ];
        foreach ($overrides as $k => $v) {
            if ($v === null) {
                unset($params[$k]);
            } else {
                $params[$k] = $v;
            }
        }
        return $params;
    }

    /** GET /api/oauth/authorize-info. Returns ['status'=>int,'body'=>array]. */
    private function authorizeInfo(array $params): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('GET', self::BASE . '/api/oauth/authorize-info')
            ->withQueryParams($params);
        $resp = self::$oauthCtrl->authorizeInfo($req, (new ResponseFactory())->createResponse());
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    /** POST /api/oauth/approve as the (authed) test user. Returns ['status'=>int,'body'=>array]. */
    private function approve(array $params): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/oauth/approve')
            ->withHeader('Content-Type', 'application/json')
            ->withParsedBody($params)
            ->withAttribute('userId', $this->userId);
        $resp = self::$oauthCtrl->approve($req, (new ResponseFactory())->createResponse());
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    /** POST /api/oauth/token as a raw application/x-www-form-urlencoded body (the real wire format). */
    private function token(array $form): array
    {
        $stream = (new StreamFactory())->createStream(http_build_query($form));
        $req = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/oauth/token')
            ->withHeader('Content-Type', 'application/x-www-form-urlencoded')
            ->withBody($stream);
        $resp = self::$oauthCtrl->token($req, (new ResponseFactory())->createResponse());
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp), 'response' => $resp];
    }

    /** Approve + extract the one-time code (and echoed state) from redirectTo. */
    private function mintCodeViaApprove(array $params): array
    {
        $r = $this->approve($params);
        $this->assertSame(200, $r['status'], 'approve should succeed: ' . json_encode($r['body']));
        $redirectTo = (string) ($r['body']['redirectTo'] ?? '');
        $this->assertStringStartsWith($params['redirect_uri'], $redirectTo);
        parse_str((string) parse_url($redirectTo, PHP_URL_QUERY), $q);
        $this->assertNotSame('', (string) ($q['code'] ?? ''), 'redirectTo must carry a code');
        return ['code' => (string) $q['code'], 'state' => $q['state'] ?? null];
    }

    /** JSON-RPC against /api/mcp (returns the PSR response; $base varies for audience tests). */
    private function mcpRequest(string $token, array $payload, string $base = self::BASE): ResponseInterface
    {
        $stream = (new StreamFactory())->createStream(json_encode($payload));
        $req = (new ServerRequestFactory())->createServerRequest('POST', $base . '/api/mcp')
            ->withHeader('Authorization', 'Bearer ' . $token)
            ->withBody($stream);
        return self::$mcpCtrl->handle($req, (new ResponseFactory())->createResponse());
    }

    /** Run the whole happy path for $client and return the token-endpoint result. */
    private function fullExchange(array $client, array $extraTokenParams = [], ?string $appId = null): array
    {
        $pkce = $this->pkce();
        $params = $this->authorizeParams($client, $pkce['challenge']);
        if ($appId !== null) {
            $params['appId'] = $appId;
        }
        $minted = $this->mintCodeViaApprove($params);
        return $this->token(array_merge([
            'grant_type' => 'authorization_code',
            'code' => $minted['code'],
            'redirect_uri' => $params['redirect_uri'],
            'client_id' => $client['client_id'],
            'code_verifier' => $pkce['verifier'],
            'resource' => $this->resource(),
        ], isset($client['client_secret']) ? ['client_secret' => $client['client_secret']] : [], $extraTokenParams));
    }

    // ── discovery ──

    public function testProtectedResourceMetadataServedAtBothPaths(): void
    {
        foreach (['/.well-known/oauth-protected-resource/api/mcp', '/.well-known/oauth-protected-resource'] as $path) {
            $req = (new ServerRequestFactory())->createServerRequest('GET', self::BASE . $path);
            $resp = self::$oauthCtrl->protectedResourceMetadata($req, (new ResponseFactory())->createResponse());
            $this->assertSame(200, $resp->getStatusCode());
            $body = self::decode($resp);
            $this->assertSame($this->resource(), $body['resource'], "PRM resource must equal the pasteable MCP URL ($path)");
            $this->assertSame([$this->origin()], $body['authorization_servers']);
            $this->assertSame(['header'], $body['bearer_methods_supported']);
            $this->assertContains('offline_access', $body['scopes_supported']);
            foreach (McpTokenService::ALL_SCOPES as $scope) {
                $this->assertContains($scope, $body['scopes_supported']);
            }
        }
    }

    public function testAuthorizationServerMetadataShape(): void
    {
        $req = (new ServerRequestFactory())->createServerRequest('GET', self::BASE . '/.well-known/oauth-authorization-server');
        $resp = self::$oauthCtrl->authorizationServerMetadata($req, (new ResponseFactory())->createResponse());
        $this->assertSame(200, $resp->getStatusCode());
        $body = self::decode($resp);
        $origin = $this->origin();
        $this->assertSame($origin, $body['issuer'], 'issuer is the bare origin, no path');
        $this->assertSame($origin . '/oauth/authorize', $body['authorization_endpoint']);
        $this->assertSame($origin . '/api/oauth/token', $body['token_endpoint']);
        $this->assertSame($origin . '/api/oauth/register', $body['registration_endpoint']);
        $this->assertSame(['code'], $body['response_types_supported']);
        $this->assertSame(['authorization_code', 'refresh_token'], $body['grant_types_supported']);
        $this->assertSame(['S256'], $body['code_challenge_methods_supported']);
        $this->assertSame(['none', 'client_secret_post'], $body['token_endpoint_auth_methods_supported']);
        $this->assertTrue($body['client_id_metadata_document_supported']);
        $this->assertContains('offline_access', $body['scopes_supported']);
    }

    // ── registration ──

    public function testDynamicRegistrationMintsConfidentialClient(): void
    {
        $client = $this->register([
            'client_name' => 'Claude',
            'redirect_uris' => ['https://claude.ai/api/mcp/auth_callback'],
        ]);
        $this->assertNotSame('', (string) $client['client_id']);
        $this->assertStringStartsWith('mcps_', (string) $client['client_secret'], 'confidential by default — Claude expects a client_secret');
        $this->assertSame(0, $client['client_secret_expires_at']);
        $this->assertSame('client_secret_post', $client['token_endpoint_auth_method']);
        $this->assertSame(['https://claude.ai/api/mcp/auth_callback'], $client['redirect_uris']);
        // Stored HASHED, never plaintext.
        $stmt = self::$pdo->prepare('SELECT secret_hash FROM mcp_oauth_clients WHERE client_id_hash = ?');
        $stmt->execute([hash('sha256', (string) $client['client_id'])]);
        $this->assertSame(hash('sha256', (string) $client['client_secret']), $stmt->fetchColumn());
    }

    public function testRegistrationRejectsBadRedirects(): void
    {
        $req = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/oauth/register')
            ->withParsedBody(['redirect_uris' => ['javascript:alert(1)']]);
        $resp = self::$oauthCtrl->register($req, (new ResponseFactory())->createResponse());
        $this->assertSame(400, $resp->getStatusCode());
        $this->assertSame('invalid_redirect_uri', self::decode($resp)['error']);
    }

    // ── authorize-info validation ──

    public function testAuthorizeInfoRejectsUnregisteredRedirectUri(): void
    {
        $client = $this->register(['client_name' => 'C', 'redirect_uris' => ['https://claude.ai/api/mcp/auth_callback']]);
        $pkce = $this->pkce();
        $r = $this->authorizeInfo($this->authorizeParams($client, $pkce['challenge'], ['redirect_uri' => 'https://evil.example/cb']));
        $this->assertSame(400, $r['status']);
        $this->assertSame('invalid_request', $r['body']['error']);
        $this->assertStringContainsString('redirect_uri', $r['body']['error_description']);
    }

    public function testAuthorizeInfoRejectsMissingPkce(): void
    {
        $client = $this->register(['client_name' => 'C', 'redirect_uris' => ['https://claude.ai/api/mcp/auth_callback']]);
        $pkce = $this->pkce();
        $missing = $this->authorizeInfo($this->authorizeParams($client, $pkce['challenge'], ['code_challenge' => null]));
        $this->assertSame(400, $missing['status']);
        $this->assertSame('invalid_request', $missing['body']['error'], 'OAuth 2.1: missing PKCE must be rejected');
        $plain = $this->authorizeInfo($this->authorizeParams($client, $pkce['challenge'], ['code_challenge_method' => 'plain']));
        $this->assertSame(400, $plain['status']);
        $this->assertStringContainsString('S256', $plain['body']['error_description']);
    }

    public function testAuthorizeInfoRejectsWrongResource(): void
    {
        $client = $this->register(['client_name' => 'C', 'redirect_uris' => ['https://claude.ai/api/mcp/auth_callback']]);
        $pkce = $this->pkce();
        $r = $this->authorizeInfo($this->authorizeParams($client, $pkce['challenge'], ['resource' => 'https://someone-else.example/api/mcp']));
        $this->assertSame(400, $r['status']);
        $this->assertSame('invalid_target', $r['body']['error']);
    }

    public function testAuthorizeInfoReturnsConsentDisplayData(): void
    {
        $client = $this->register(['client_name' => 'Claude', 'client_uri' => 'https://claude.ai', 'redirect_uris' => ['https://claude.ai/api/mcp/auth_callback']]);
        $pkce = $this->pkce();
        $r = $this->authorizeInfo($this->authorizeParams($client, $pkce['challenge']));
        $this->assertSame(200, $r['status'], json_encode($r['body']));
        $this->assertSame('Claude', $r['body']['clientName']);
        $this->assertSame('claude.ai', $r['body']['redirectHost'], 'redirect host is displayed prominently (anti-phishing)');
        $this->assertContains('forms:write', $r['body']['scopes']);
        $this->assertContains('offline_access', $r['body']['scopes']);
    }

    // ── the full happy path ──

    public function testFullFlowMintsWorkingMcpToken(): void
    {
        $client = $this->register(['client_name' => 'Claude', 'redirect_uris' => ['https://claude.ai/api/mcp/auth_callback']]);
        $pkce = $this->pkce();
        $params = $this->authorizeParams($client, $pkce['challenge']);
        $minted = $this->mintCodeViaApprove($params);
        $this->assertSame($params['state'], $minted['state'], 'state must be echoed verbatim');

        $r = $this->token([
            'grant_type' => 'authorization_code',
            'code' => $minted['code'],
            'redirect_uri' => $params['redirect_uri'],
            'client_id' => $client['client_id'],
            'client_secret' => $client['client_secret'],
            'code_verifier' => $pkce['verifier'],
            'resource' => $this->resource(),
        ]);
        $this->assertSame(200, $r['status'], json_encode($r['body']));
        $this->assertStringStartsWith('flm_oauth_', $r['body']['access_token']);
        $this->assertSame('Bearer', $r['body']['token_type']);
        $this->assertSame(McpOAuthService::ACCESS_TOKEN_TTL, $r['body']['expires_in']);
        $this->assertStringStartsWith('mcprt_', $r['body']['refresh_token']);
        $this->assertStringContainsString('forms:write', $r['body']['scope']);
        $this->assertSame('no-store', $r['response']->getHeaderLine('Cache-Control'));

        // The minted access token drives /api/mcp: tools/list works.
        $resp = $this->mcpRequest($r['body']['access_token'], ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/list']);
        $this->assertSame(200, $resp->getStatusCode());
        $tools = array_map(static fn ($t) => $t['name'], self::decode($resp)['result']['tools'] ?? []);
        $this->assertContains('create_app', $tools, 'an account-wide OAuth grant can build apps');

        // Audience binding: the same token presented on ANOTHER host is a 401.
        $other = $this->mcpRequest($r['body']['access_token'], ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/list'], 'http://mcp.other-host.example');
        $this->assertSame(401, $other->getStatusCode(), 'audience mismatch must 401');
    }

    public function testWrongVerifierIsInvalidGrant(): void
    {
        $client = $this->register(['client_name' => 'C', 'redirect_uris' => ['https://claude.ai/api/mcp/auth_callback']]);
        $pkce = $this->pkce();
        $params = $this->authorizeParams($client, $pkce['challenge']);
        $minted = $this->mintCodeViaApprove($params);
        $r = $this->token([
            'grant_type' => 'authorization_code',
            'code' => $minted['code'],
            'redirect_uri' => $params['redirect_uri'],
            'client_id' => $client['client_id'],
            'client_secret' => $client['client_secret'],
            'code_verifier' => rtrim(strtr(base64_encode(random_bytes(48)), '+/', '-_'), '='), // wrong
        ]);
        $this->assertSame(400, $r['status']);
        $this->assertSame('invalid_grant', $r['body']['error']);
    }

    public function testCodeReuseIsInvalidGrant(): void
    {
        $client = $this->register(['client_name' => 'C', 'redirect_uris' => ['https://claude.ai/api/mcp/auth_callback']]);
        $pkce = $this->pkce();
        $params = $this->authorizeParams($client, $pkce['challenge']);
        $minted = $this->mintCodeViaApprove($params);
        $form = [
            'grant_type' => 'authorization_code',
            'code' => $minted['code'],
            'redirect_uri' => $params['redirect_uri'],
            'client_id' => $client['client_id'],
            'client_secret' => $client['client_secret'],
            'code_verifier' => $pkce['verifier'],
        ];
        $this->assertSame(200, $this->token($form)['status'], 'first exchange succeeds');
        $again = $this->token($form);
        $this->assertSame(400, $again['status']);
        $this->assertSame('invalid_grant', $again['body']['error'], 'a code is single-use');
    }

    public function testBadClientSecretIs401InvalidClient(): void
    {
        $client = $this->register(['client_name' => 'C', 'redirect_uris' => ['https://claude.ai/api/mcp/auth_callback']]);
        $pkce = $this->pkce();
        $params = $this->authorizeParams($client, $pkce['challenge']);
        $minted = $this->mintCodeViaApprove($params);
        $r = $this->token([
            'grant_type' => 'authorization_code',
            'code' => $minted['code'],
            'redirect_uri' => $params['redirect_uri'],
            'client_id' => $client['client_id'],
            'client_secret' => 'mcps_wrong',
            'code_verifier' => $pkce['verifier'],
        ]);
        $this->assertSame(401, $r['status']);
        $this->assertSame('invalid_client', $r['body']['error']);
    }

    // ── refresh rotation ──

    public function testRefreshRotationAndReuseRevokesFamily(): void
    {
        // PUBLIC client ('none') — the rotation path.
        $client = $this->register(['client_name' => 'CLI', 'token_endpoint_auth_method' => 'none', 'redirect_uris' => ['http://127.0.0.1:33418/callback']]);
        $this->assertArrayNotHasKey('client_secret', $client, 'public clients get no secret');
        $first = $this->fullExchange($client);
        $this->assertSame(200, $first['status'], json_encode($first['body']));
        $rt1 = $first['body']['refresh_token'];

        $refreshed = $this->token(['grant_type' => 'refresh_token', 'refresh_token' => $rt1, 'client_id' => $client['client_id']]);
        $this->assertSame(200, $refreshed['status'], json_encode($refreshed['body']));
        $rt2 = $refreshed['body']['refresh_token'];
        $this->assertNotSame($rt1, $rt2, 'public-client refresh must ROTATE');
        $this->assertStringStartsWith('flm_oauth_', $refreshed['body']['access_token']);

        // Reusing the ROTATED rt1 is theft evidence: invalid_grant + the whole family dies.
        $reuse = $this->token(['grant_type' => 'refresh_token', 'refresh_token' => $rt1, 'client_id' => $client['client_id']]);
        $this->assertSame(400, $reuse['status']);
        $this->assertSame('invalid_grant', $reuse['body']['error']);
        $dead = $this->token(['grant_type' => 'refresh_token', 'refresh_token' => $rt2, 'client_id' => $client['client_id']]);
        $this->assertSame(400, $dead['status']);
        $this->assertSame('invalid_grant', $dead['body']['error'], 'reuse revokes the whole family, including the newest token');
    }

    public function testConfidentialRefreshKeepsSameToken(): void
    {
        $client = $this->register(['client_name' => 'C', 'redirect_uris' => ['https://claude.ai/api/mcp/auth_callback']]);
        $first = $this->fullExchange($client);
        $this->assertSame(200, $first['status'], json_encode($first['body']));
        $rt = $first['body']['refresh_token'];
        $refreshed = $this->token(['grant_type' => 'refresh_token', 'refresh_token' => $rt, 'client_id' => $client['client_id'], 'client_secret' => $client['client_secret']]);
        $this->assertSame(200, $refreshed['status'], json_encode($refreshed['body']));
        $this->assertSame($rt, $refreshed['body']['refresh_token'], 'confidential clients may keep the same refresh token');
    }

    // ── the 401 discovery trigger ──

    public function testMcp401CarriesExactWwwAuthenticateHeader(): void
    {
        $resp = $this->mcpRequest('flm_not_a_real_token', ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/list']);
        $this->assertSame(401, $resp->getStatusCode());
        $expected = 'Bearer resource_metadata="' . $this->origin() . '/.well-known/oauth-protected-resource/api/mcp"'
            . ', scope="apps:read apps:write forms:read forms:write screens:write"';
        $this->assertSame($expected, $resp->getHeaderLine('WWW-Authenticate'));

        // Missing header entirely also 401s with the challenge.
        $stream = (new StreamFactory())->createStream(json_encode(['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/list']));
        $bare = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/mcp')->withBody($stream);
        $bareResp = self::$mcpCtrl->handle($bare, (new ResponseFactory())->createResponse());
        $this->assertSame(401, $bareResp->getStatusCode());
        $this->assertSame($expected, $bareResp->getHeaderLine('WWW-Authenticate'));
    }

    // ── redirect matching rules ──

    public function testLoopbackRedirectMatchesPortAgnostically(): void
    {
        $client = $this->register(['client_name' => 'CLI', 'token_endpoint_auth_method' => 'none', 'redirect_uris' => ['http://127.0.0.1:33418/callback']]);
        $pkce = $this->pkce();
        // A DIFFERENT ephemeral port must be accepted (RFC 8252 §7.3 — Claude Code).
        $params = $this->authorizeParams($client, $pkce['challenge'], ['redirect_uri' => 'http://127.0.0.1:51999/callback']);
        $info = $this->authorizeInfo($params);
        $this->assertSame(200, $info['status'], json_encode($info['body']));
        $minted = $this->mintCodeViaApprove($params);
        $r = $this->token([
            'grant_type' => 'authorization_code',
            'code' => $minted['code'],
            'redirect_uri' => 'http://127.0.0.1:51999/callback',
            'client_id' => $client['client_id'],
            'code_verifier' => $pkce['verifier'],
        ]);
        $this->assertSame(200, $r['status'], json_encode($r['body']));

        // But a different PATH (or host) must not match.
        $bad = $this->authorizeInfo($this->authorizeParams($client, $pkce['challenge'], ['redirect_uri' => 'http://127.0.0.1:33418/other']));
        $this->assertSame(400, $bad['status']);
    }

    public function testClaudeCallbackRequiresExactMatch(): void
    {
        $client = $this->register(['client_name' => 'Claude', 'redirect_uris' => ['https://claude.ai/api/mcp/auth_callback']]);
        $pkce = $this->pkce();
        $exact = $this->authorizeInfo($this->authorizeParams($client, $pkce['challenge'], ['redirect_uri' => 'https://claude.ai/api/mcp/auth_callback']));
        $this->assertSame(200, $exact['status'], json_encode($exact['body']));
        $mutated = $this->authorizeInfo($this->authorizeParams($client, $pkce['challenge'], ['redirect_uri' => 'https://claude.ai/api/mcp/auth_callback/extra']));
        $this->assertSame(400, $mutated['status'], 'non-loopback redirects are EXACT match only');
    }

    // ── app narrowing on consent ──

    public function testApproveWithAppIdNarrowsTheGrant(): void
    {
        $appId = 'app-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'Scoped', ?, 'published')")
            ->execute([$appId, $this->userId, 'oauth-' . bin2hex(random_bytes(5))]);
        $otherApp = 'app-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'Other', ?, 'published')")
            ->execute([$otherApp, $this->userId, 'oauth-' . bin2hex(random_bytes(5))]);

        $client = $this->register(['client_name' => 'C', 'redirect_uris' => ['https://claude.ai/api/mcp/auth_callback']]);
        $r = $this->fullExchange($client, [], $appId);
        $this->assertSame(200, $r['status'], json_encode($r['body']));

        $resp = $this->mcpRequest($r['body']['access_token'], ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/call', 'params' => ['name' => 'list_apps', 'arguments' => []]]);
        $data = json_decode(self::decode($resp)['result']['content'][0]['text'] ?? '', true);
        $this->assertCount(1, $data, 'app-narrowed grant sees only the approved app');
        $this->assertSame($appId, $data[0]['id']);

        // And approving an app the user does NOT own is rejected.
        $foreignApprove = $this->approve($this->authorizeParams($client, $this->pkce()['challenge'], ['appId' => 'app-not-owned']));
        $this->assertSame(400, $foreignApprove['status']);
    }
}
