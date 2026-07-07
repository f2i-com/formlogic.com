<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\FlowController;
use FormLogic\Controllers\McpOAuthController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\ApiKeyService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\McpOAuthService;
use FormLogic\Services\McpTokenService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;

/**
 * FormLogic Desktop OAuth device-link: the static first-party PUBLIC client (formlogic-desktop) runs
 * the authorization-code + PKCE S256 flow, and the token exchange mints a long-lived SCOPED flk_ API
 * key tied to a desktop_connections row (returned once). Loopback redirects are port-agnostic
 * (RFC 8252 §7.3); non-loopback is rejected for this client; deleting the connection revokes the key.
 * Skipped without a test database.
 */
class DesktopOAuthLinkTest extends TestCase
{
    private const BASE = 'http://localhost';

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static McpOAuthService $oauth;
    private static McpOAuthController $oauthCtrl;
    private static ApiKeyService $apiKeys;
    private static FlowService $flows;
    private static FlowController $flowCtrl;

    private string $userId = '';

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-desktop-oauth-' . bin2hex(random_bytes(4)));
        $forms = new FormService($conn, $sqlite);
        $apps = new AppService($conn, $forms);
        self::$apiKeys = new ApiKeyService($conn);
        self::$flows = new FlowService($conn);
        self::$oauth = new McpOAuthService($conn, new McpTokenService($conn));
        self::$oauthCtrl = new McpOAuthController(self::$oauth, $apps, null, null, self::$apiKeys, self::$flows);
        self::$flowCtrl = new FlowController(self::$flows, $apps, new AppUserService($conn), self::$apiKeys);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->userId, $this->userId . '@test.local']);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->userId === '') {
            return;
        }
        self::$pdo->prepare('DELETE FROM desktop_connections WHERE owner_user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM api_keys WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM mcp_oauth_codes WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    // ── helpers ──

    private static function decode(ResponseInterface $resp): array
    {
        $resp->getBody()->rewind();
        return json_decode((string) $resp->getBody(), true) ?: [];
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

    private function authorizeParams(string $challenge, array $overrides = []): array
    {
        $params = [
            'client_id' => McpOAuthService::DESKTOP_CLIENT_ID,
            'redirect_uri' => 'http://127.0.0.1:51999/callback',
            'scope' => implode(' ', McpOAuthService::DESKTOP_SCOPES),
            'state' => 'st-' . bin2hex(random_bytes(6)),
            'code_challenge' => $challenge,
            'code_challenge_method' => 'S256',
            'device' => 'Reception PC',
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

    private function authorizeInfo(array $params): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('GET', self::BASE . '/api/oauth/authorize-info')->withQueryParams($params);
        $resp = self::$oauthCtrl->authorizeInfo($req, (new ResponseFactory())->createResponse());
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    private function approve(array $params): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/oauth/approve')
            ->withHeader('Content-Type', 'application/json')
            ->withParsedBody($params)
            ->withAttribute('userId', $this->userId);
        $resp = self::$oauthCtrl->approve($req, (new ResponseFactory())->createResponse());
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    private function token(array $form): array
    {
        $stream = (new StreamFactory())->createStream(http_build_query($form));
        $req = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/oauth/token')
            ->withHeader('Content-Type', 'application/x-www-form-urlencoded')
            ->withBody($stream);
        $resp = self::$oauthCtrl->token($req, (new ResponseFactory())->createResponse());
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    /** Approve → extract one-time code from the redirect. */
    private function mintCode(array $params): string
    {
        $r = $this->approve($params);
        $this->assertSame(200, $r['status'], 'approve should succeed: ' . json_encode($r['body']));
        parse_str((string) parse_url((string) $r['body']['redirectTo'], PHP_URL_QUERY), $q);
        $this->assertNotSame('', (string) ($q['code'] ?? ''));
        return (string) $q['code'];
    }

    // ── the seeded client + consent ──

    public function testDesktopClientIsSeededAndPublic(): void
    {
        $client = self::$oauth->resolveClient(McpOAuthService::DESKTOP_CLIENT_ID);
        $this->assertNotNull($client, 'the first-party desktop client must be seeded');
        $this->assertSame('none', $client['authMethod'], 'desktop client is PUBLIC (no secret)');
    }

    public function testConsentRendersDesktopScopesHumanReadably(): void
    {
        $r = $this->authorizeInfo($this->authorizeParams($this->pkce()['challenge']));
        $this->assertSame(200, $r['status'], json_encode($r['body']));
        $this->assertTrue($r['body']['isDesktopLink']);
        $this->assertSame('Reception PC', $r['body']['device']);
        foreach (McpOAuthService::DESKTOP_SCOPES as $scope) {
            $this->assertContains($scope, $r['body']['scopes']);
            $this->assertArrayHasKey($scope, $r['body']['scopeLabels']);
        }
        $this->assertSame('Act as a desktop runtime for connector commands', $r['body']['scopeLabels']['connector:relay']);
    }

    // ── loopback redirect validation (RFC 8252) ──

    public function testLoopbackRedirectsAcceptedAnyPortNonLoopbackRejected(): void
    {
        $challenge = $this->pkce()['challenge'];
        foreach (['http://127.0.0.1:12345/callback', 'http://127.0.0.1:60000/callback', 'http://localhost:8123/callback'] as $ok) {
            $r = $this->authorizeInfo($this->authorizeParams($challenge, ['redirect_uri' => $ok]));
            $this->assertSame(200, $r['status'], "loopback redirect must be accepted: {$ok} — " . json_encode($r['body']));
        }
        foreach (['https://evil.example/callback', 'http://192.168.0.5/callback', 'http://127.0.0.1:12345/other'] as $bad) {
            $r = $this->authorizeInfo($this->authorizeParams($challenge, ['redirect_uri' => $bad]));
            $this->assertSame(400, $r['status'], "non-loopback/unregistered redirect must be rejected: {$bad}");
        }
    }

    // ── PKCE required ──

    public function testPkceIsRequiredAndS256Only(): void
    {
        $challenge = $this->pkce()['challenge'];
        $missing = $this->authorizeInfo($this->authorizeParams($challenge, ['code_challenge' => null]));
        $this->assertSame(400, $missing['status'], 'missing PKCE must be rejected');
        $plain = $this->authorizeInfo($this->authorizeParams($challenge, ['code_challenge_method' => 'plain']));
        $this->assertSame(400, $plain['status']);
        $this->assertStringContainsString('S256', $plain['body']['error_description']);
    }

    public function testWrongVerifierIsRejected(): void
    {
        $pkce = $this->pkce();
        $params = $this->authorizeParams($pkce['challenge']);
        $code = $this->mintCode($params);
        $r = $this->token([
            'grant_type' => 'authorization_code',
            'code' => $code,
            'redirect_uri' => $params['redirect_uri'],
            'client_id' => McpOAuthService::DESKTOP_CLIENT_ID,
            'code_verifier' => rtrim(strtr(base64_encode(random_bytes(48)), '+/', '-_'), '='),
        ]);
        $this->assertSame(400, $r['status']);
        $this->assertSame('invalid_grant', $r['body']['error']);
        $this->assertCount(0, self::$flows->listDesktopConnections($this->userId), 'no connection on a failed exchange');
    }

    // ── the full mint + revoke cascade ──

    public function testTokenExchangeMintsScopedKeyTiedToConnectionAndRevokeCascades(): void
    {
        $pkce = $this->pkce();
        $params = $this->authorizeParams($pkce['challenge']);
        $code = $this->mintCode($params);

        $r = $this->token([
            'grant_type' => 'authorization_code',
            'code' => $code,
            'redirect_uri' => $params['redirect_uri'],
            'client_id' => McpOAuthService::DESKTOP_CLIENT_ID,
            'code_verifier' => $pkce['verifier'],
        ]);
        $this->assertSame(200, $r['status'], json_encode($r['body']));

        // The token response carries a long-lived flk_ key (== access_token), no refresh token.
        $apiKey = (string) $r['body']['formlogic_api_key'];
        $this->assertStringStartsWith('flk_', $apiKey);
        $this->assertSame($apiKey, $r['body']['access_token']);
        $this->assertArrayNotHasKey('refresh_token', $r['body']);
        $this->assertStringContainsString('connector:relay', $r['body']['scope']);
        $this->assertSame('FormLogic Desktop on Reception PC', $r['body']['device_name']);
        $connectionId = (string) $r['body']['desktop_connection_id'];

        // The key validates with exactly the granted desktop scopes.
        $validated = self::$apiKeys->validateKey($apiKey);
        $this->assertNotNull($validated);
        $this->assertSame($this->userId, $validated['userId']);
        sort($validated['scopes']);
        $expected = McpOAuthService::DESKTOP_SCOPES;
        sort($expected);
        $this->assertSame($expected, $validated['scopes']);

        // The connection row exists, tied to the key.
        $connections = self::$flows->listDesktopConnections($this->userId);
        $this->assertCount(1, $connections);
        $this->assertSame($connectionId, $connections[0]['id']);
        $this->assertSame($validated['id'], $connections[0]['apiKeyId'], 'connection is tied to the minted key');

        // Deleting the connection (web Settings path) revokes the key — the desktop is cut off.
        $del = (new ServerRequestFactory())->createServerRequest('DELETE', self::BASE . '/api/desktop-connections/' . $connectionId)
            ->withAttribute('userId', $this->userId);
        $resp = self::$flowCtrl->deleteDesktopConnection($del, (new ResponseFactory())->createResponse(), ['id' => $connectionId]);
        $this->assertSame(200, $resp->getStatusCode(), (string) $resp->getBody());
        $this->assertNull(self::$apiKeys->validateKey($apiKey), 'revoking the connection revokes its key');
        $this->assertCount(0, self::$flows->listDesktopConnections($this->userId));
    }
}
