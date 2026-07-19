<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Constants\AppPermissions;
use FormLogic\Controllers\AokieCompanionController;
use FormLogic\Controllers\McpOAuthController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AokieCompanionAdmissionSigner;
use FormLogic\Services\AokieCompanionDeviceService;
use FormLogic\Services\AokieCompanionPushService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\AuditService;
use FormLogic\Services\FormService;
use FormLogic\Services\McpOAuthService;
use FormLogic\Services\McpTokenService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\SigningService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;

/** End-to-end managed Companion OAuth, enrollment, admission and revocation. */
final class AokieCompanionAuthTest extends TestCase
{
    private const BASE = 'http://localhost';
    /** Sentinel: omit `supportedTransports` entirely, as a shipped build does. */
    private const NO_TRANSPORTS = '__omit__';
    private const API_BASE = 'http://api.localhost';
    private const SECRET = '0123456789abcdef0123456789abcdef';
    private const PLUGIN_PUBLIC_KEY = 'PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw';
    private const PLUGIN_THUMBPRINT = 'FtIu-VbGrfe_KB6CH7GNwODB72MNxj_ml11dEvO-7kk';

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static McpTokenService $tokens;
    private static McpOAuthService $oauth;
    private static McpOAuthController $oauthController;
    private static AokieCompanionController $controller;
    private static AppService $apps;
    private static FormService $forms;
    private static ResponseService $responses;
    private static SQLiteConnection $sqlite;
    private static SigningService $signing;
    private static AokieCompanionPushService $push;

    private string $userId = '';
    private string $appId = '';
    private string $appSlug = '';
    private string $desktopId = '';
    private string $apiKeyId = '';
    private string $assignmentId = '';
    /** @var list<string> */
    private array $approvedMobileThumbprints = [];
    private int $peerRosterRevision = 0;
    /** @var list<string> */
    private array $dynamicClients = [];
    /** @var list<string> */
    private array $extraUsers = [];
    /** @var list<string> */
    private array $formIds = [];

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        self::setEnvironment('APP_ENV', 'development');
        self::setEnvironment('APP_URL', self::BASE);
        self::setEnvironment('AOKIE_COMPANION_ISSUER', self::BASE);
        self::setEnvironment('AOKIE_COMPANION_ALLOW_LEGACY_CONNECTOR_RELAY', 'false');
        self::setEnvironment(
            'AOKIE_COMPANION_PUSH_ENCRYPTION_KEY',
            '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        );
        self::setEnvironment('AOKIE_COMPANION_ICE_SERVERS_JSON', json_encode([[
            'urls' => ['turns:turn.example.test:5349?transport=tcp'],
            'username' => 'temporary-user',
            'credential' => 'temporary-secret',
            'expiresAt' => time() + 3600,
        ]], JSON_UNESCAPED_SLASHES));
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
            $connection = new MySQLConnection($config);
            $connection->getConnection()->query('SELECT 1');
            $connection->initializeSchema();
            $connection->runMigrations();
        } catch (\Throwable $error) {
            self::markTestSkipped('No test database available: ' . $error->getMessage());
        }
        self::$mysql = $connection;
        self::$pdo = $connection->getConnection();
        self::$sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-aokie-auth-' . bin2hex(random_bytes(4)));
        self::$forms = new FormService($connection, self::$sqlite);
        self::$responses = new ResponseService($connection, self::$sqlite);
        self::$apps = new AppService($connection, self::$forms);
        self::$tokens = new McpTokenService($connection);
        self::$oauth = new McpOAuthService($connection, self::$tokens);
        $appUsers = new AppUserService($connection);
        self::$oauthController = new McpOAuthController(self::$oauth, self::$apps, null, null, null, null, $appUsers);
        self::$signing = new SigningService($connection);
        self::$push = new AokieCompanionPushService($connection);
        self::$controller = new AokieCompanionController(
            self::$tokens,
            self::$apps,
            new AokieCompanionDeviceService($connection),
            new AokieCompanionAdmissionSigner(self::SECRET, 'ws://127.0.0.1:39000/v2/realtime'),
            self::$signing,
            $appUsers,
            self::$push,
            new AuditService($connection),
            self::$responses,
        );
    }

    protected function setUp(): void
    {
        if (self::$pdo === null) {
            $this->markTestSkipped('No test database');
        }
        $suffix = bin2hex(random_bytes(8));
        $this->userId = 'u-' . $suffix;
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'Owner')")
            ->execute([$this->userId, $suffix . '@aokie.test']);
        $app = self::$apps->createApp([
            'name' => 'Aokie Test ' . $suffix,
            'slug' => 'aokie-test-' . $suffix,
            'status' => 'published',
            'settings' => [
                'aokieCompanion' => [
                    'remoteConsent' => [
                        'remoteMonitoring' => true,
                        'remoteConsult' => true,
                        'remoteTakeover' => true,
                        'remoteCaptions' => true,
                        'remoteAssistance' => true,
                    ],
                ],
            ],
        ], $this->userId);
        $this->appId = (string) $app['id'];
        $this->appSlug = (string) $app['slug'];
        $this->desktopId = 'desk-' . bin2hex(random_bytes(8));
        $this->apiKeyId = 'key-' . bin2hex(random_bytes(8));
        $this->assignmentId = 'assignment-' . bin2hex(random_bytes(8));
        self::$pdo->prepare(
            "INSERT INTO desktop_connections
                (id, owner_user_id, device_name, desktop_instance_id, api_key_id,
                 last_seen_at, capabilities_json)
             VALUES (?, ?, 'Front Desk', ?, ?, NOW(), '[\"aokie\"]')"
        )->execute([
            $this->desktopId,
            $this->userId,
            'instance-' . bin2hex(random_bytes(6)),
            $this->apiKeyId,
        ]);
        self::$pdo->prepare(
            "INSERT INTO connector_assignments
                (id, owner_user_id, connector_id, app_id, desktop_connection_id)
             VALUES (?, ?, 'aokie', ?, ?)"
        )->execute([$this->assignmentId, $this->userId, $this->appId, $this->desktopId]);
        $this->approvedMobileThumbprints = [];
        $this->peerRosterRevision = 0;
        $this->dynamicClients = [];
        $this->extraUsers = [];
        $this->formIds = [];
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->userId === '') {
            return;
        }
        foreach ($this->dynamicClients as $clientId) {
            self::$pdo->prepare('DELETE FROM mcp_oauth_clients WHERE client_id_hash = ?')
                ->execute([hash('sha256', $clientId)]);
        }
        self::$pdo->prepare('DELETE FROM mcp_oauth_codes WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM mcp_oauth_refresh_tokens WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM mcp_sessions WHERE user_id = ?')->execute([$this->userId]);
        foreach ($this->formIds as $formId) {
            self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$formId]);
            self::$sqlite->deleteFormDatabase($formId);
        }
        self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare("DELETE FROM audit_log WHERE resource_type = 'app' AND resource_id = ?")
            ->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM app_users WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
        foreach ($this->extraUsers as $userId) {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$userId]);
        }
    }

    private static function setEnvironment(string $name, string $value): void
    {
        $_ENV[$name] = $value;
        putenv($name . '=' . $value);
    }

    private static function decode(ResponseInterface $response): array
    {
        $response->getBody()->rewind();
        return json_decode((string) $response->getBody(), true) ?: [];
    }

    /** @return array{verifier:string,challenge:string} */
    private function pkce(): array
    {
        $verifier = rtrim(strtr(base64_encode(random_bytes(48)), '+/', '-_'), '=');
        return [
            'verifier' => $verifier,
            'challenge' => rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '='),
        ];
    }

    /** @return array{accessToken:string,refreshToken:string,body:array} */
    private function authorizeCompanion(string $deviceId, ?string $userId = null): array
    {
        $userId ??= $this->userId;
        $pkce = $this->pkce();
        $params = [
            'client_id' => McpOAuthService::AOKIE_COMPANION_CLIENT_ID,
            'redirect_uri' => 'com.aokie.companion:/oauth/callback',
            'scope' => implode(' ', McpOAuthService::AOKIE_COMPANION_SCOPES),
            'resource' => McpOAuthService::companionResourceFor($this->request('GET', '/probe')),
            'code_challenge' => $pkce['challenge'],
            'code_challenge_method' => 'S256',
            'device' => $deviceId,
            'appId' => $this->appId,
        ];
        $info = self::$oauthController->authorizeInfo(
            $this->request('GET', '/api/oauth/authorize-info')
                ->withQueryParams($params)
                ->withAttribute('userId', $userId),
            (new ResponseFactory())->createResponse(),
        );
        $infoBody = self::decode($info);
        $this->assertSame(200, $info->getStatusCode(), json_encode($infoBody));
        $this->assertTrue($infoBody['isAokieCompanionLink']);
        $this->assertTrue($infoBody['appBindingRequired']);

        $approval = self::$oauthController->approve(
            $this->request('POST', '/api/oauth/approve')
                ->withParsedBody($params)
                ->withAttribute('userId', $userId),
            (new ResponseFactory())->createResponse(),
        );
        $approvalBody = self::decode($approval);
        $this->assertSame(200, $approval->getStatusCode(), json_encode($approvalBody));
        parse_str((string) parse_url((string) $approvalBody['redirectTo'], PHP_URL_QUERY), $query);

        $form = [
            'grant_type' => 'authorization_code',
            'client_id' => McpOAuthService::AOKIE_COMPANION_CLIENT_ID,
            'code' => (string) $query['code'],
            'redirect_uri' => $params['redirect_uri'],
            'code_verifier' => $pkce['verifier'],
            'resource' => $params['resource'],
        ];
        $token = self::$oauthController->token(
            $this->request('POST', '/api/oauth/token')
                ->withHeader('Content-Type', 'application/x-www-form-urlencoded')
                ->withBody((new StreamFactory())->createStream(http_build_query($form))),
            (new ResponseFactory())->createResponse(),
        );
        $tokenBody = self::decode($token);
        $this->assertSame(200, $token->getStatusCode(), json_encode($tokenBody));
        $this->assertSame(McpOAuthService::AOKIE_COMPANION_ACCESS_TOKEN_TTL, $tokenBody['expires_in']);
        return [
            'accessToken' => (string) $tokenBody['access_token'],
            'refreshToken' => (string) $tokenBody['refresh_token'],
            'body' => $tokenBody,
        ];
    }

    private function request(string $method, string $path): \Psr\Http\Message\ServerRequestInterface
    {
        return $this->requestAt(self::BASE, $method, $path);
    }

    private function requestAt(string $origin, string $method, string $path): \Psr\Http\Message\ServerRequestInterface
    {
        return (new ServerRequestFactory())->createServerRequest($method, $origin . $path)
            ->withAttribute('userId', $this->userId);
    }

    /**
     * @param mixed $supportedTransports the transport declaration to send, or
     *        the NO_TRANSPORTS sentinel to omit the key entirely — the two are
     *        distinct cases, since `null` is itself a shape that must not read
     *        as consent.
     */
    private function mobileAdmission(
        string $accessToken,
        string $deviceId,
        ?array $grants = null,
        ?string $holderKeyThumbprint = null,
        bool $ensurePaired = true,
        mixed $supportedTransports = self::NO_TRANSPORTS,
    ): ResponseInterface
    {
        $holderKeyThumbprint ??= $this->mobileHolder($deviceId);
        if ($ensurePaired) {
            $this->ensurePluginRosterContains($holderKeyThumbprint);
        }
        $body = [
            'appId' => $this->appId,
            'deviceId' => $deviceId,
            'displayName' => 'Reception Phone',
            'holderKeyThumbprint' => $holderKeyThumbprint,
        ];
        if ($grants !== null) {
            $body['grants'] = $grants;
        }
        if ($supportedTransports !== self::NO_TRANSPORTS) {
            $body['supportedTransports'] = $supportedTransports;
        }
        return self::$controller->mobileAdmission(
            $this->request('POST', '/api/aokie-companion/admission')
                ->withHeader('Authorization', 'Bearer ' . $accessToken)
                ->withParsedBody($body),
            (new ResponseFactory())->createResponse(),
        );
    }

    private function mobileHolder(string $deviceId): string
    {
        $publicKey = rtrim(strtr(base64_encode(hash('sha256', 'mobile:' . $deviceId, true)), '+/', '-_'), '=');
        return AokieCompanionAdmissionSigner::endpointThumbprint($publicKey);
    }

    /** @return array{calls:string,transcript-turns:string,follow-up-tasks:string} */
    private function installAokieCallForms(?string $appId = null): array
    {
        $appId ??= $this->appId;
        $forms = [];
        foreach ([
            'calls' => 'Calls',
            'transcript-turns' => 'Transcript Turns',
            'follow-up-tasks' => 'Follow-up Tasks',
        ] as $packFormId => $title) {
            $form = self::$forms->createForm([
                'title' => $title . ' ' . bin2hex(random_bytes(3)),
                'userId' => $this->userId,
                'status' => 'published',
                'fields' => [],
            ]);
            $formId = (string) $form['id'];
            $this->formIds[] = $formId;
            self::$apps->addFormToApp($appId, $formId, $title);
            self::$apps->updateAppForm($appId, $formId, [
                'settings' => ['packFormId' => $packFormId],
            ]);
            $forms[$packFormId] = $formId;
        }
        return $forms;
    }

    /** @return array<string,mixed> */
    private function pluginAdmissionBody(): array
    {
        return [
            'appId' => $this->appId,
            'pluginId' => 'aokie',
            'displayName' => 'Front Desk Desktop',
            'endpointPublicKey' => [
                'algorithm' => 'ed25519',
                'publicKey' => self::PLUGIN_PUBLIC_KEY,
                'thumbprint' => self::PLUGIN_THUMBPRINT,
            ],
            'holderKeyThumbprint' => self::PLUGIN_THUMBPRINT,
            'approvedPeerKeyThumbprints' => $this->approvedMobileThumbprints,
            'peerRosterRevision' => $this->peerRosterRevision,
            'peerRosterHash' => AokieCompanionAdmissionSigner::peerRosterHash(
                $this->peerRosterRevision,
                $this->approvedMobileThumbprints,
            ),
        ];
    }

    private function ensurePluginRosterContains(string $holderKeyThumbprint): void
    {
        if (in_array($holderKeyThumbprint, $this->approvedMobileThumbprints, true)) {
            return;
        }
        $this->approvedMobileThumbprints[] = $holderKeyThumbprint;
        sort($this->approvedMobileThumbprints, SORT_STRING);
        $this->peerRosterRevision++;
        $response = self::$controller->pluginAdmission(
            $this->request('POST', '/api/v1/aokie-companion/admission')
                ->withParsedBody($this->pluginAdmissionBody())
                ->withAttribute('apiKeyId', $this->apiKeyId)
                ->withAttribute('apiKeyScopes', ['aokie:realtime']),
            (new ResponseFactory())->createResponse(),
        );
        $body = self::decode($response);
        $this->assertSame(200, $response->getStatusCode(), json_encode($body));
        $this->assertSame(self::PLUGIN_THUMBPRINT, $body['holderKeyThumbprint']);
        $this->assertSame($this->approvedMobileThumbprints, $body['approvedPeerKeyThumbprints']);
        $this->assertSame($this->peerRosterRevision, $body['peerRosterRevision']);
    }

    public function testSeededClientIsPublicAndGeneralClientsCannotRequestCallScopes(): void
    {
        $client = self::$oauth->resolveClient(McpOAuthService::AOKIE_COMPANION_CLIENT_ID);
        $this->assertNotNull($client);
        $this->assertSame('none', $client['authMethod']);
        $this->assertContains('com.aokie.companion:/oauth/callback', $client['redirectUris']);

        $registered = self::$oauth->registerClient([
            'redirect_uris' => ['https://client.example/callback'],
            'token_endpoint_auth_method' => 'none',
        ]);
        $this->assertTrue($registered['ok']);
        $clientId = (string) $registered['client']['client_id'];
        $this->dynamicClients[] = $clientId;
        $pkce = $this->pkce();
        $result = self::$oauth->validateAuthorizeRequest([
            'client_id' => $clientId,
            'redirect_uri' => 'https://client.example/callback',
            'scope' => 'aokie:state aokie:takeover',
            'code_challenge' => $pkce['challenge'],
            'code_challenge_method' => 'S256',
        ], $this->request('GET', '/api/oauth/authorize-info'));
        $this->assertFalse($result['ok']);
        $this->assertSame('invalid_scope', $result['error']);
        $this->assertNotContains('aokie:state', McpOAuthService::supportedScopes());
    }

    public function testDiscoveryIsAppSpecificSignedAndCarriesBoundedIceConfiguration(): void
    {
        $response = self::$controller->appDiscovery(
            $this->request('GET', '/api/app/' . $this->appSlug . '/aokie-discovery'),
            (new ResponseFactory())->createResponse(),
            ['slug' => $this->appSlug],
        );
        $body = self::decode($response);
        // This is the exact fail-closed schema-v2 surface consumed by the native
        // Companion parser. Additive fields must be deliberately added to both
        // implementations because the native document and nested structs reject
        // unknown fields.
        $payloadKeys = [
            'schemaVersion',
            'issuer',
            'apiBaseUrl',
            'gatewayUrl',
            'realtimeUrl',
            'oauthAuthorizationUrl',
            'oauthTokenUrl',
            'oauthResource',
            'admissionEndpoint',
            'clientId',
            'deploymentId',
            'available',
            'scopesSupported',
            'features',
            'remoteConsent',
            'iceServers',
            'relayOnly',
            'turnCredentialExpiresAt',
            'media',
            'appId',
            'appSlug',
        ];
        $trustKeys = [
            'trustStatus',
            'signingKeyId',
            'signatureAlgorithm',
            'signature',
            'signingKeyUrl',
            'signatureEnvelope',
        ];
        $this->assertSame(200, $response->getStatusCode(), json_encode($body));
        $this->assertSame(array_merge($payloadKeys, $trustKeys), array_keys($body));
        $this->assertSame(2, $body['schemaVersion']);
        $origin = (string) $body['issuer'];
        $this->assertNotSame('', $origin);
        $this->assertContains(parse_url($origin, PHP_URL_SCHEME), ['http', 'https']);
        $this->assertIsString(parse_url($origin, PHP_URL_HOST));
        $this->assertNull(parse_url($origin, PHP_URL_PATH));
        $this->assertNull(parse_url($origin, PHP_URL_QUERY));
        $this->assertNull(parse_url($origin, PHP_URL_FRAGMENT));
        $this->assertSame($origin . '/api', $body['apiBaseUrl']);
        $this->assertSame($this->appId, $body['appId']);
        $this->assertSame($this->appSlug, $body['appSlug']);
        $this->assertSame('ws://127.0.0.1:39000/v2/realtime', $body['gatewayUrl']);
        $this->assertSame($body['gatewayUrl'], $body['realtimeUrl']);
        // ⚠️ ENABLED documents must NOT carry `companionRelay` — the native
        // Companion parser is deny_unknown_fields, and already-shipped builds
        // were built against this exact key set (absence = enabled; the field
        // appears only in the disabled document, asserted below).
        $this->assertArrayNotHasKey('companionRelay', $body);
        $this->assertSame($origin . '/oauth/authorize', $body['oauthAuthorizationUrl']);
        $this->assertSame($origin . '/api/oauth/token', $body['oauthTokenUrl']);
        $this->assertSame($origin . '/api/aokie-companion', $body['oauthResource']);
        $this->assertSame($origin . '/api/aokie-companion/admission', $body['admissionEndpoint']);
        $this->assertSame('aokie-companion', $body['clientId']);
        $this->assertTrue($body['available']);
        $this->assertSame(
            [
                'configured',
                'remoteMonitoring',
                'remoteConsult',
                'remoteTakeover',
                'remoteCaptions',
                'remoteAssistance',
            ],
            array_keys($body['remoteConsent']),
        );
        $this->assertTrue($body['remoteConsent']['remoteConsult']);
        $this->assertContains('consult', $body['features']);
        $this->assertContains('aokie:consult', $body['scopesSupported']);
        $this->assertCount(1, $body['iceServers']);
        $this->assertSame(['urls', 'username', 'credential', 'expiresAt'], array_keys($body['iceServers'][0]));
        $this->assertSame('turns:turn.example.test:5349?transport=tcp', $body['iceServers'][0]['urls'][0]);
        $this->assertIsInt($body['turnCredentialExpiresAt']);
        $this->assertSame($body['iceServers'][0]['expiresAt'], $body['turnCredentialExpiresAt']);
        $this->assertSame(
            ['transport', 'gatewayRelaysMedia', 'companionUsesBluetoothDongle', 'relayOnly'],
            array_keys($body['media']),
        );
        $this->assertSame('webrtc', $body['media']['transport']);
        $this->assertFalse($body['media']['gatewayRelaysMedia']);
        $this->assertFalse($body['media']['companionUsesBluetoothDongle']);
        $this->assertIsBool($body['relayOnly']);
        $this->assertSame($body['relayOnly'], $body['media']['relayOnly']);
        if (self::$signing->isEd25519()) {
            $this->assertSame('signed', $body['trustStatus']);
            $this->assertSame(
                ['payload', 'signature', 'alg', 'keyId'],
                array_keys($body['signatureEnvelope']),
            );
            $this->assertSame($payloadKeys, array_keys($body['signatureEnvelope']['payload']));
            $this->assertSame(
                array_intersect_key($body, array_flip($payloadKeys)),
                $body['signatureEnvelope']['payload'],
                'signatureEnvelope.payload must exactly equal the additive top-level payload',
            );
            $this->assertSame('Ed25519', $body['signatureAlgorithm']);
            $this->assertSame($body['signatureAlgorithm'], $body['signatureEnvelope']['alg']);
            $this->assertSame($body['signingKeyId'], $body['signatureEnvelope']['keyId']);
            $this->assertSame($body['signature'], $body['signatureEnvelope']['signature']);
            $this->assertSame($origin . '/api/public/signing-key', $body['signingKeyUrl']);
            $this->assertTrue(self::$signing->verify($body['signatureEnvelope']));
            $this->assertSame($this->appId, $body['signatureEnvelope']['payload']['appId']);
            $this->assertTrue($body['signatureEnvelope']['payload']['remoteConsent']['remoteConsult']);

            // Verify with only the public response material and the same compact
            // JSON representation consumed by the native Ed25519 verifier. This
            // catches envelope/key mismatches that SigningService::verify() alone
            // could mask by reusing its private persisted keypair.
            $key = self::$signing->publicKeyInfo();
            $this->assertSame(['alg', 'keyId', 'publicKey'], array_keys($key));
            $this->assertSame($body['signatureAlgorithm'], $key['alg']);
            $this->assertSame($body['signingKeyId'], $key['keyId']);
            $publicKey = base64_decode((string) $key['publicKey'], true);
            $signature = strtr((string) $body['signature'], '-_', '+/');
            $signature .= str_repeat('=', (4 - strlen($signature) % 4) % 4);
            $signature = base64_decode($signature, true);
            $message = json_encode(
                $body['signatureEnvelope']['payload'],
                JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR,
            );
            $this->assertNotFalse($publicKey);
            $this->assertNotFalse($signature);
            $this->assertSame(SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES, strlen((string) $publicKey));
            $this->assertSame(SODIUM_CRYPTO_SIGN_BYTES, strlen((string) $signature));
            $this->assertTrue(sodium_crypto_sign_verify_detached(
                (string) $signature,
                $message,
                (string) $publicKey,
            ));
        } else {
            $this->assertSame('unverified', $body['trustStatus']);
            $this->assertNull($body['signatureEnvelope']);
        }

        self::setEnvironment('AOKIE_COMPANION_ICE_SERVERS_JSON', json_encode(array_fill(0, 9, [
            'urls' => ['stun:stun.example.test'],
        ])));
        try {
            $invalid = self::$controller->discovery(
                $this->request('GET', '/.well-known/aokie-companion'),
                (new ResponseFactory())->createResponse(),
            );
            $this->assertSame(503, $invalid->getStatusCode());
            $this->assertSame('ice_configuration_invalid', self::decode($invalid)['code']);
        } finally {
            self::setEnvironment('AOKIE_COMPANION_ICE_SERVERS_JSON', json_encode([[
                'urls' => ['turns:turn.example.test:5349?transport=tcp'],
                'username' => 'temporary-user',
                'credential' => 'temporary-secret',
                'expiresAt' => time() + 3600,
            ]], JSON_UNESCAPED_SLASHES));
        }
    }

    public function testSplitApiHostDiscoveryAuthorizeTokenAndAdmissionUseOneExactResource(): void
    {
        self::setEnvironment('AOKIE_COMPANION_ISSUER', self::API_BASE);
        try {
            $discoveryResponse = self::$controller->appDiscovery(
                $this->requestAt(
                    self::API_BASE,
                    'GET',
                    '/api/app/' . $this->appSlug . '/aokie-discovery',
                ),
                (new ResponseFactory())->createResponse(),
                ['slug' => $this->appSlug],
            );
            $discovery = self::decode($discoveryResponse);
            $this->assertSame(200, $discoveryResponse->getStatusCode(), json_encode($discovery));
            $this->assertSame(self::API_BASE, $discovery['issuer']);
            $this->assertSame(self::API_BASE . '/api', $discovery['apiBaseUrl']);
            $this->assertSame(self::API_BASE . '/oauth/authorize', $discovery['oauthAuthorizationUrl']);
            $this->assertSame(self::API_BASE . '/api/oauth/token', $discovery['oauthTokenUrl']);
            $this->assertSame(self::API_BASE . '/api/aokie-companion', $discovery['oauthResource']);
            $this->assertSame(
                self::API_BASE . '/api/aokie-companion/admission',
                $discovery['admissionEndpoint'],
            );
            $this->assertSame(self::API_BASE . '/api/public/signing-key', $discovery['signingKeyUrl']);

            $deviceId = 'split_host_' . bin2hex(random_bytes(4));
            $pkce = $this->pkce();
            $params = [
                'response_type' => 'code',
                'client_id' => (string) $discovery['clientId'],
                'redirect_uri' => 'http://127.0.0.1:43123/oauth/callback',
                'scope' => implode(' ', $discovery['scopesSupported']),
                'state' => 'split-host-state',
                'code_challenge' => $pkce['challenge'],
                'code_challenge_method' => 'S256',
                'resource' => (string) $discovery['oauthResource'],
                'device' => $deviceId,
                'appId' => $this->appId,
            ];
            $rawQuery = http_build_query($params, '', '&', PHP_QUERY_RFC3986);

            $invalidParams = $params;
            $invalidParams['resource'] = 'http://attacker.invalid/api/aokie-companion';
            $invalidQuery = http_build_query($invalidParams, '', '&', PHP_QUERY_RFC3986);
            $invalidEntry = self::$oauthController->authorizationPage(
                $this->requestAt(self::API_BASE, 'GET', '/oauth/authorize?' . $invalidQuery)
                    ->withQueryParams($invalidParams),
                (new ResponseFactory())->createResponse(),
            );
            $this->assertSame(400, $invalidEntry->getStatusCode());
            $this->assertSame('invalid_target', self::decode($invalidEntry)['error']);
            $this->assertSame('', $invalidEntry->getHeaderLine('Location'));

            // The native system browser enters through the API issuer. PHP validates the exact
            // resource before sending the same query to the fixed, trusted APP_URL consent SPA.
            $entry = self::$oauthController->authorizationPage(
                $this->requestAt(self::API_BASE, 'GET', '/oauth/authorize?' . $rawQuery)
                    ->withQueryParams($params),
                (new ResponseFactory())->createResponse(),
            );
            $this->assertSame(302, $entry->getStatusCode(), (string) $entry->getBody());
            $this->assertSame(
                self::BASE . '/oauth/authorize?' . $rawQuery,
                $entry->getHeaderLine('Location'),
            );

            // The SPA calls the configured split API host. This is the exact live path that used
            // to return invalid_target when discovery incorrectly advertised the frontend origin.
            $info = self::$oauthController->authorizeInfo(
                $this->requestAt(self::API_BASE, 'GET', '/api/oauth/authorize-info')
                    ->withQueryParams($params),
                (new ResponseFactory())->createResponse(),
            );
            $infoBody = self::decode($info);
            $this->assertSame(200, $info->getStatusCode(), json_encode($infoBody));
            $this->assertTrue($infoBody['isAokieCompanionLink']);

            $approval = self::$oauthController->approve(
                $this->requestAt(self::API_BASE, 'POST', '/api/oauth/approve')
                    ->withParsedBody($params),
                (new ResponseFactory())->createResponse(),
            );
            $approvalBody = self::decode($approval);
            $this->assertSame(200, $approval->getStatusCode(), json_encode($approvalBody));
            parse_str((string) parse_url((string) $approvalBody['redirectTo'], PHP_URL_QUERY), $callback);

            $tokenForm = [
                'grant_type' => 'authorization_code',
                'client_id' => (string) $discovery['clientId'],
                'code' => (string) $callback['code'],
                'redirect_uri' => $params['redirect_uri'],
                'code_verifier' => $pkce['verifier'],
                'resource' => (string) $discovery['oauthResource'],
            ];
            $token = self::$oauthController->token(
                $this->requestAt(self::API_BASE, 'POST', '/api/oauth/token')
                    ->withHeader('Content-Type', 'application/x-www-form-urlencoded')
                    ->withBody((new StreamFactory())->createStream(http_build_query($tokenForm))),
                (new ResponseFactory())->createResponse(),
            );
            $tokenBody = self::decode($token);
            $this->assertSame(200, $token->getStatusCode(), json_encode($tokenBody));
            $session = self::$tokens->validate((string) $tokenBody['access_token']);
            $this->assertNotNull($session);
            $this->assertSame($discovery['oauthResource'], $session['resource']);
            $this->assertTrue(McpOAuthService::resourceMatchesRequest(
                (string) $session['resource'],
                $this->requestAt(self::API_BASE, 'POST', '/api/aokie-companion/admission'),
            ));
            $this->assertFalse(McpOAuthService::resourceMatchesRequest(
                (string) $session['resource'],
                $this->request('POST', '/api/aokie-companion/admission'),
            ));

            $holder = $this->mobileHolder($deviceId);
            $this->ensurePluginRosterContains($holder);
            $admission = self::$controller->mobileAdmission(
                $this->requestAt(self::API_BASE, 'POST', '/api/aokie-companion/admission')
                    ->withHeader('Authorization', 'Bearer ' . $tokenBody['access_token'])
                    ->withParsedBody([
                        'appId' => $this->appId,
                        'deviceId' => $deviceId,
                        'displayName' => 'Split Host Companion',
                        'holderKeyThumbprint' => $holder,
                    ]),
                (new ResponseFactory())->createResponse(),
            );
            $this->assertSame(200, $admission->getStatusCode(), (string) $admission->getBody());
        } finally {
            self::setEnvironment('AOKIE_COMPANION_ISSUER', self::BASE);
        }
    }

    public function testRemoteConsultPolicyIsExactSignedAndAdmissionGated(): void
    {
        $missingConsult = self::$controller->updatePolicy(
            $this->request('PUT', '/api/aokie-companion/policy')->withParsedBody([
                'appId' => $this->appId,
                'remoteConsent' => [
                    'remoteMonitoring' => true,
                    'remoteTakeover' => true,
                    'remoteCaptions' => true,
                    'remoteAssistance' => true,
                ],
            ]),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(400, $missingConsult->getStatusCode());
        $this->assertSame('invalid_remote_consent', self::decode($missingConsult)['code']);

        $withoutConsult = [
            'remoteMonitoring' => true,
            'remoteConsult' => false,
            'remoteTakeover' => true,
            'remoteCaptions' => true,
            'remoteAssistance' => true,
        ];
        $saved = self::$controller->updatePolicy(
            $this->request('PUT', '/api/aokie-companion/policy')->withParsedBody([
                'appId' => $this->appId,
                'remoteConsent' => $withoutConsult,
            ]),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(200, $saved->getStatusCode(), (string) $saved->getBody());
        $this->assertFalse(self::decode($saved)['remoteConsent']['remoteConsult']);

        $discovery = self::decode(self::$controller->appDiscovery(
            $this->request('GET', '/api/app/' . $this->appSlug . '/aokie-discovery'),
            (new ResponseFactory())->createResponse(),
            ['slug' => $this->appSlug],
        ));
        $this->assertNotContains('consult', $discovery['features']);
        if (self::$signing->isEd25519()) {
            $this->assertFalse($discovery['signatureEnvelope']['payload']['remoteConsent']['remoteConsult']);
        }

        $deviceId = 'consult_policy_' . bin2hex(random_bytes(4));
        $oauth = $this->authorizeCompanion($deviceId);
        $gated = self::decode($this->mobileAdmission($oauth['accessToken'], $deviceId));
        $this->assertNotContains('consult', $gated['scopes']);

        $withConsult = $withoutConsult;
        $withConsult['remoteConsult'] = true;
        $enabled = self::$controller->updatePolicy(
            $this->request('PUT', '/api/aokie-companion/policy')->withParsedBody([
                'appId' => $this->appId,
                'remoteConsent' => $withConsult,
            ]),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(200, $enabled->getStatusCode(), (string) $enabled->getBody());
        $admitted = self::decode($this->mobileAdmission($oauth['accessToken'], $deviceId));
        $this->assertContains('consult', $admitted['scopes']);
        $this->assertContains('rtc_signal', $admitted['scopes']);
    }

    public function testDiscoveryRejectsCrossRuntimeJsonSeparatorsInIceMaterial(): void
    {
        $valid = [
            'urls' => ['turns:turn.example.test:5349?transport=tcp'],
            'username' => 'temporary-user',
            'credential' => 'temporary-secret',
            'expiresAt' => time() + 3600,
        ];
        $invalidEntries = [];

        $invalidUrl = $valid;
        $invalidUrl['urls'] = ['turns:turn.example.test:5349?transport=tcp' . "\u{2028}"];
        $invalidEntries['URL line separator'] = $invalidUrl;

        $invalidUsername = $valid;
        $invalidUsername['username'] = 'temporary' . "\u{2029}" . 'user';
        $invalidEntries['username paragraph separator'] = $invalidUsername;

        $invalidCredential = $valid;
        $invalidCredential['credential'] = 'temporary' . "\u{2028}" . 'secret';
        $invalidEntries['credential line separator'] = $invalidCredential;

        try {
            foreach ($invalidEntries as $label => $entry) {
                self::setEnvironment('AOKIE_COMPANION_ICE_SERVERS_JSON', json_encode(
                    [$entry],
                    JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR,
                ));
                $response = self::$controller->discovery(
                    $this->request('GET', '/.well-known/aokie-companion'),
                    (new ResponseFactory())->createResponse(),
                );
                $this->assertSame(503, $response->getStatusCode(), $label);
                $this->assertSame('ice_configuration_invalid', self::decode($response)['code'], $label);
            }
        } finally {
            self::setEnvironment('AOKIE_COMPANION_ICE_SERVERS_JSON', json_encode(
                [$valid],
                JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR,
            ));
        }
    }

    public function testOAuthAdmissionPluginAdmissionAndImmediateDeviceRevocation(): void
    {
        $deviceId = 'device_mobile_' . bin2hex(random_bytes(6));
        $oauth = $this->authorizeCompanion($deviceId);
        $session = self::$tokens->validate($oauth['accessToken']);
        $this->assertNotNull($session);
        $this->assertSame(McpOAuthService::AOKIE_COMPANION_CLIENT_ID, $session['oauthClientId']);
        $this->assertSame($deviceId, $session['deviceId']);
        $this->assertSame($this->appId, $session['appId']);
        $this->assertSame('/api/aokie-companion', parse_url($session['resource'], PHP_URL_PATH));
        $this->assertFalse(
            McpOAuthService::resourceMatchesRequest($session['resource'], $this->request('POST', '/api/mcp')),
            'the native token audience cannot authenticate the unrelated MCP endpoint',
        );

        $admission = $this->mobileAdmission(
            $oauth['accessToken'],
            $deviceId,
            ['state_read', 'monitor', 'rtc_signal'],
        );
        $body = self::decode($admission);
        $this->assertSame(200, $admission->getStatusCode(), json_encode($body));
        $this->assertStringStartsWith('aokie-adm-v2.', $body['accessToken']);
        $this->assertSame('mobile', $body['role']);
        $this->assertSame($this->mobileHolder($deviceId), $body['holderKeyThumbprint']);
        $this->assertSame(self::PLUGIN_THUMBPRINT, $body['expectedPeerKeyThumbprint']);
        $this->assertArrayNotHasKey('approvedPeerKeyThumbprints', $body);
        $this->assertArrayNotHasKey('holderKeyThumbprint', $body['device']);
        $this->assertSame(['state_read', 'monitor', 'rtc_signal'], $body['scopes']);
        $this->assertSame('temporary-secret', $body['iceServers'][0]['credential']);
        [, $claimsHex] = explode('.', $body['accessToken']);
        $claims = json_decode((string) hex2bin($claimsHex), true);
        $this->assertSame($this->appId, $claims['appId']);
        $this->assertSame($deviceId, $claims['subjectId']);
        $this->assertSame($body['holderKeyThumbprint'], $claims['holderKeyThumbprint']);
        $this->assertSame($body['expectedPeerKeyThumbprint'], $claims['expectedPeerKeyThumbprint']);
        $this->assertArrayNotHasKey('approvedPeerKeyThumbprints', $claims);

        $wrongDevice = $this->mobileAdmission($oauth['accessToken'], 'device_other');
        $this->assertSame(403, $wrongDevice->getStatusCode());
        $this->assertSame('device_binding_mismatch', self::decode($wrongDevice)['code']);
        $escalation = $this->mobileAdmission($oauth['accessToken'], $deviceId, ['state_read', 'not_a_grant']);
        $this->assertSame(403, $escalation->getStatusCode());
        $this->assertSame('scope_escalation', self::decode($escalation)['code']);

        $pluginRequest = $this->request('POST', '/api/v1/aokie-companion/admission')
            ->withParsedBody($this->pluginAdmissionBody())
            ->withAttribute('apiKeyId', $this->apiKeyId);
        $oldScope = self::$controller->pluginAdmission(
            $pluginRequest->withAttribute('apiKeyScopes', ['connector:relay']),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(403, $oldScope->getStatusCode());
        $this->assertSame('desktop_relink_required', self::decode($oldScope)['code']);
        self::$pdo->prepare('DELETE FROM connector_assignments WHERE id = ?')
            ->execute([$this->assignmentId]);
        $unassigned = self::$controller->pluginAdmission(
            $pluginRequest->withAttribute('apiKeyScopes', ['aokie:realtime']),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(409, $unassigned->getStatusCode());
        $this->assertSame('aokie_assignment_required', self::decode($unassigned)['code']);
        self::$pdo->prepare(
            "INSERT INTO connector_assignments
                (id, owner_user_id, connector_id, app_id, desktop_connection_id)
             VALUES (?, ?, 'aokie', ?, ?)"
        )->execute([$this->assignmentId, $this->userId, $this->appId, $this->desktopId]);
        $wrongDesktopKey = self::$controller->pluginAdmission(
            $pluginRequest
                ->withAttribute('apiKeyId', 'key-wrong-desktop')
                ->withAttribute('apiKeyScopes', ['aokie:realtime']),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(409, $wrongDesktopKey->getStatusCode());
        $this->assertSame('desktop_binding_mismatch', self::decode($wrongDesktopKey)['code']);
        $plugin = self::$controller->pluginAdmission(
            $pluginRequest->withAttribute('apiKeyScopes', ['aokie:realtime']),
            (new ResponseFactory())->createResponse(),
        );
        $pluginBody = self::decode($plugin);
        $this->assertSame(200, $plugin->getStatusCode(), json_encode($pluginBody));
        $this->assertSame('plugin', $pluginBody['role']);
        $this->assertSame($this->pluginAdmissionBody()['endpointPublicKey'], $pluginBody['endpointPublicKey']);
        $this->assertSame(self::PLUGIN_THUMBPRINT, $pluginBody['holderKeyThumbprint']);
        $this->assertSame($this->approvedMobileThumbprints, $pluginBody['approvedPeerKeyThumbprints']);
        $this->assertSame($this->peerRosterRevision, $pluginBody['peerRosterRevision']);
        $this->assertArrayNotHasKey('expectedPeerKeyThumbprint', $pluginBody);
        $this->assertContains('consult', $pluginBody['scopes']);
        $this->assertContains('takeover', $pluginBody['scopes']);
        [, $pluginClaimsHex] = explode('.', $pluginBody['accessToken']);
        $pluginClaims = json_decode((string) hex2bin($pluginClaimsHex), true);
        $this->assertSame(self::PLUGIN_THUMBPRINT, $pluginClaims['holderKeyThumbprint']);
        $this->assertSame($this->approvedMobileThumbprints, $pluginClaims['approvedPeerKeyThumbprints']);
        $this->assertSame($this->peerRosterRevision, $pluginClaims['peerRosterRevision']);
        $this->assertArrayNotHasKey('expectedPeerKeyThumbprint', $pluginClaims);

        $listed = self::$controller->listDevices(
            $this->request('GET', '/api/aokie-companion/devices')->withQueryParams(['appId' => $this->appId]),
            (new ResponseFactory())->createResponse(),
        );
        $devices = self::decode($listed)['devices'];
        $this->assertCount(2, $devices);
        $mobile = array_values(array_filter($devices, static fn (array $row): bool => $row['role'] === 'mobile'))[0];

        $crossOwner = self::$controller->revokeDevice(
            $this->request('DELETE', '/api/aokie-companion/devices/' . $mobile['id'])
                ->withAttribute('userId', 'another-owner'),
            (new ResponseFactory())->createResponse(),
            ['id' => $mobile['id']],
        );
        $this->assertSame(404, $crossOwner->getStatusCode(), 'another owner cannot revoke this endpoint');

        $revoked = self::$controller->revokeDevice(
            $this->request('DELETE', '/api/aokie-companion/devices/' . $mobile['id']),
            (new ResponseFactory())->createResponse(),
            ['id' => $mobile['id']],
        );
        $this->assertSame(200, $revoked->getStatusCode());
        $this->assertNull(self::$tokens->validate($oauth['accessToken']), 'device revoke invalidates access immediately');
        $refresh = self::$oauth->redeemRefreshToken(
            $oauth['refreshToken'],
            McpOAuthService::AOKIE_COMPANION_CLIENT_ID,
            true,
        );
        $this->assertFalse($refresh['ok'], 'device revoke invalidates the refresh family');

        $approved = self::$controller->approveDevice(
            $this->request('POST', '/api/aokie-companion/devices/' . $mobile['id'] . '/approve'),
            (new ResponseFactory())->createResponse(),
            ['id' => $mobile['id']],
        );
        $approvedBody = self::decode($approved);
        $this->assertSame(200, $approved->getStatusCode());
        $this->assertTrue($approvedBody['reauthorizationRequired']);
        $this->assertNull(self::$tokens->validate($oauth['accessToken']), 'reapproval never resurrects old access');

        $fresh = $this->authorizeCompanion($deviceId);
        $again = $this->mobileAdmission($fresh['accessToken'], $deviceId, ['state_read']);
        $this->assertSame(200, $again->getStatusCode(), (string) $again->getBody());
    }

    /**
     * Pack services wave 1: the owner's App Settings toggle for the pack-declared
     * `companion-relay` service gates BOTH admission endpoints, and the per-app
     * discovery document withholds the gateway endpoints while stating the toggle.
     * An ABSENT services map (every pre-services app) stays fully enabled.
     */
    public function testCompanionRelayServiceToggleGatesAdmissionAndDiscovery(): void
    {
        $deviceId = 'device_svcgate_' . bin2hex(random_bytes(6));
        $oauth = $this->authorizeCompanion($deviceId);
        // Absent settings.services map (this app never declared any) = ENABLED:
        // pairing + mobile admission proceed exactly as before pack services existed.
        $baseline = $this->mobileAdmission($oauth['accessToken'], $deviceId, ['state_read']);
        $this->assertSame(200, $baseline->getStatusCode(), (string) $baseline->getBody());

        $setRelay = function (bool $enabled): void {
            $app = self::$apps->getApp($this->appId);
            $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
            $settings['services'] = ['companion-relay' => [
                'enabled' => $enabled,
                'title' => 'Companion app relay',
                'description' => 'Relay for the Companion app',
            ]];
            self::$apps->updateApp($this->appId, ['settings' => $settings]);
        };
        $pluginRequest = fn () => $this->request('POST', '/api/v1/aokie-companion/admission')
            ->withParsedBody($this->pluginAdmissionBody())
            ->withAttribute('apiKeyId', $this->apiKeyId)
            ->withAttribute('apiKeyScopes', ['aokie:realtime']);

        $setRelay(false);
        $pluginDenied = self::$controller->pluginAdmission(
            $pluginRequest(),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(403, $pluginDenied->getStatusCode());
        $this->assertSame('service_disabled', self::decode($pluginDenied)['code']);
        // The device key is already in the plugin roster from the baseline admission,
        // so ensurePaired:false keeps this from re-running pluginAdmission (which the
        // gate would now refuse).
        $mobileDenied = $this->mobileAdmission(
            $oauth['accessToken'],
            $deviceId,
            ['state_read'],
            null,
            false,
        );
        $this->assertSame(403, $mobileDenied->getStatusCode());
        $this->assertSame('service_disabled', self::decode($mobileDenied)['code']);

        $disabledDiscovery = self::decode(self::$controller->appDiscovery(
            $this->request('GET', '/api/app/' . $this->appSlug . '/aokie-discovery'),
            (new ResponseFactory())->createResponse(),
            ['slug' => $this->appSlug],
        ));
        $this->assertSame(['enabled' => false], $disabledDiscovery['companionRelay']);
        $this->assertArrayNotHasKey('gatewayUrl', $disabledDiscovery);
        $this->assertArrayNotHasKey('realtimeUrl', $disabledDiscovery);
        $this->assertArrayNotHasKey('iceServers', $disabledDiscovery);
        $this->assertArrayNotHasKey('turnCredentialExpiresAt', $disabledDiscovery);

        // Re-enable: everything proceeds past the gate again.
        $setRelay(true);
        $pluginAllowed = self::$controller->pluginAdmission(
            $pluginRequest(),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(200, $pluginAllowed->getStatusCode(), (string) $pluginAllowed->getBody());
        $mobileAllowed = $this->mobileAdmission($oauth['accessToken'], $deviceId, ['state_read'], null, false);
        $this->assertSame(200, $mobileAllowed->getStatusCode(), (string) $mobileAllowed->getBody());
        $enabledDiscovery = self::decode(self::$controller->appDiscovery(
            $this->request('GET', '/api/app/' . $this->appSlug . '/aokie-discovery'),
            (new ResponseFactory())->createResponse(),
            ['slug' => $this->appSlug],
        ));
        // Enabled documents carry NO companionRelay key (deny_unknown_fields
        // compatibility with shipped Companion builds — absence = enabled).
        $this->assertArrayNotHasKey('companionRelay', $enabledDiscovery);
        $this->assertSame('ws://127.0.0.1:39000/v2/realtime', $enabledDiscovery['gatewayUrl']);
    }

    public function testPluginAdmissionAdvertisesTheHostedRelayAndKeepsEveryExistingKey(): void
    {
        // A plugin admission needs a non-empty roster; this primes one.
        $this->ensurePluginRosterContains($this->mobileHolder('device_relayadv_' . bin2hex(random_bytes(4))));
        $pluginRequest = fn () => $this->request('POST', '/api/v1/aokie-companion/admission')
            ->withParsedBody($this->pluginAdmissionBody())
            ->withAttribute('apiKeyId', $this->apiKeyId)
            ->withAttribute('apiKeyScopes', ['aokie:realtime']);

        $response = self::$controller->pluginAdmission($pluginRequest(), (new ResponseFactory())->createResponse());
        $body = self::decode($response);
        $this->assertSame(200, $response->getStatusCode(), json_encode($body));

        // ⚠️ REGRESSION LOCK. The desktop projects this response through an
        // EXACT key allowlist and returns None for any missing entry, so a
        // removed or renamed key breaks admission outright. Additions are inert
        // there until the allowlist carries them — which is what makes the
        // `relay` advertisement safe to deploy on its own.
        foreach ([
            'accessToken', 'tokenType', 'expiresIn', 'expiresAt', 'gatewayUrl',
            'appId', 'subjectId', 'role', 'holderKeyThumbprint', 'scopes',
            'approvedPeerKeyThumbprints', 'peerRosterRevision', 'peerRosterHash',
            'endpointPublicKey', 'iceServers', 'relayOnly', 'turnCredentialExpiresAt',
            'device', 'desktopConnection', 'scopeCompatibility',
        ] as $key) {
            $this->assertArrayHasKey($key, $body, $key . ' is part of the shipped admission contract');
        }
        $this->assertNotSame('', (string) $body['gatewayUrl'], 'the desktop projection hard-requires gatewayUrl');

        $this->assertSame([
            'challengeUrl' => self::BASE . '/api/aokie-companion/relay/challenge',
            'framesUrl' => self::BASE . '/api/aokie-companion/relay/frames',
            'streamUrl' => self::BASE . '/api/aokie-companion/relay/stream',
        ], $body['relay']);

        // Turning the service off withholds the advertisement with the rest of
        // the admission — the gate runs before anything is minted.
        $app = self::$apps->getApp($this->appId);
        $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
        $restore = $settings;
        $settings['services'] = ['companion-relay' => ['enabled' => false]];
        self::$apps->updateApp($this->appId, ['settings' => $settings]);
        try {
            $disabled = self::$controller->pluginAdmission($pluginRequest(), (new ResponseFactory())->createResponse());
            $disabledBody = self::decode($disabled);
            $this->assertSame(403, $disabled->getStatusCode());
            $this->assertSame('service_disabled', $disabledBody['code']);
            $this->assertArrayNotHasKey('relay', $disabledBody);
        } finally {
            self::$apps->updateApp($this->appId, ['settings' => $restore]);
        }
    }

    public function testMobileRelayAdvertisementIsNegotiatedAndAbsentFromDiscovery(): void
    {
        // ⚠️ THE MOBILE ADMISSION IS PARSED WITH deny_unknown_fields BY
        // ALREADY-SHIPPED NATIVE COMPANION BUILDS, and unlike the plugin path
        // there is no desktop broker in between to strip a key the client did
        // not ask for. An unconditional `relay` field would therefore be an
        // instant hard parse failure on every installed build. So the mobile
        // advertisement is NEGOTIATED: emitted only when the caller declares
        // relay support, which is exactly what keeps the two repos free to
        // deploy in either order.
        $deviceId = 'device_relayscope_' . bin2hex(random_bytes(6));
        $oauth = $this->authorizeCompanion($deviceId);

        // 1. Silence is not consent — the shipped-build case. Asserted WITH a
        //    positive check: an error body carries no `relay` either, so
        //    absence alone would also "pass" on a mint that had started failing.
        $silentResponse = $this->mobileAdmission($oauth['accessToken'], $deviceId, ['state_read']);
        $silent = self::decode($silentResponse);
        $this->assertSame(200, $silentResponse->getStatusCode(), json_encode($silent));
        $this->assertArrayNotHasKey('relay', $silent);

        // 2. Neither is any ambiguous shape. Only a JSON LIST carrying the
        //    exact string 'relay' may be read as support; anything else must
        //    fall back to the shape the caller was built against.
        foreach ([
            'empty list' => [],
            'another transport' => ['websocket'],
            'object with named key' => ['transport' => 'relay'],
            'bare string' => 'relay',
            'null' => null,
            'nested' => [['relay']],
            'case mismatch' => ['Relay'],
        ] as $label => $declared) {
            $body = self::decode($this->mobileAdmission(
                $oauth['accessToken'],
                $deviceId,
                ['state_read'],
                supportedTransports: $declared,
            ));
            $this->assertArrayNotHasKey('relay', $body, $label . ' must not read as opt-in');
            $this->assertArrayHasKey('accessToken', $body, $label . ' must still mint normally');
        }

        // 2b. ⚠️ ONE SHAPE IS INDISTINGUISHABLE, DOCUMENTED RATHER THAN HIDDEN.
        //     A numeric-keyed JSON object {"0":"relay"} and the list ["relay"]
        //     decode to the SAME PHP array — assoc decoding casts decimal-string
        //     keys to ints, the same lossiness the relay controller calls out
        //     for {} vs []. Telling them apart would mean re-decoding the raw
        //     body non-associatively in body(), which every other route shares.
        //     It is left as-is because the shape is one no client emits, and the
        //     only consequence of reading it as consent is offering three URLs
        //     to a caller that asked for them in a degenerate way — while the
        //     cases that actually matter (silence above all, and a named-key
        //     object) are refused above.
        $degenerate = self::decode($this->mobileAdmission(
            $oauth['accessToken'],
            $deviceId,
            ['state_read'],
            supportedTransports: ['0' => 'relay'],
        ));
        $this->assertArrayHasKey('relay', $degenerate, 'known and accepted limit of assoc JSON decoding');

        // 3. A declared opt-in gets exactly the three URLs — the same values the
        //    plugin admission publishes, off the one trustedOrigin invariant.
        $negotiated = self::decode($this->mobileAdmission(
            $oauth['accessToken'],
            $deviceId,
            ['state_read'],
            supportedTransports: ['relay'],
        ));
        $this->assertSame([
            'challengeUrl' => self::BASE . '/api/aokie-companion/relay/challenge',
            'framesUrl' => self::BASE . '/api/aokie-companion/relay/frames',
            'streamUrl' => self::BASE . '/api/aokie-companion/relay/stream',
        ], $negotiated['relay']);

        // 4. ⚠️ REGRESSION LOCK, both branches. These are what the shipped
        //    mobile parser hard-requires; negotiation must never trade one of
        //    them away for the new field.
        foreach ([$silent, $negotiated] as $index => $body) {
            foreach (['gatewayUrl', 'relayOnly', 'turnCredentialExpiresAt'] as $key) {
                $this->assertArrayHasKey($key, $body, $key . ' is required by the shipped mobile parser (branch ' . $index . ')');
            }
        }

        // 5. Discovery still carries no relay in EITHER case. It is fetched
        //    pre-auth, is cached, and is gated twice on the Companion — a
        //    V2_PAYLOAD_KEYS allowlist that hard-errors on an unknown key
        //    BEFORE signature verification, plus a deny_unknown_fields struct.
        $discovery = self::decode(self::$controller->appDiscovery(
            $this->request('GET', '/api/app/' . $this->appSlug . '/aokie-discovery'),
            (new ResponseFactory())->createResponse(),
            ['slug' => $this->appSlug],
        ));
        $this->assertArrayNotHasKey('relay', $discovery);
    }

    public function testEndpointKeysRostersReplayRotationAndDesktopBindingFailClosed(): void
    {
        $columns = self::$pdo->query('SHOW COLUMNS FROM aokie_companion_devices')
            ->fetchAll(PDO::FETCH_COLUMN);
        foreach ([
            'holder_key_thumbprint',
            'endpoint_public_key',
            'approved_peer_key_thumbprints',
            'peer_roster_revision',
            'peer_roster_hash',
            'desktop_connection_id',
        ] as $column) {
            $this->assertContains($column, $columns, "migration must add {$column}");
        }

        $deviceId = 'identity_mobile_' . bin2hex(random_bytes(5));
        $holderA = $this->mobileHolder($deviceId);
        $holderB = $this->mobileHolder($deviceId . '_rotated');
        $holderC = $this->mobileHolder($deviceId . '_unpaired');
        $this->ensurePluginRosterContains($holderA);
        $revisionOne = $this->pluginAdmissionBody();

        $idempotent = self::$controller->pluginAdmission(
            $this->request('POST', '/api/v1/aokie-companion/admission')
                ->withParsedBody($revisionOne)
                ->withAttribute('apiKeyId', $this->apiKeyId)
                ->withAttribute('apiKeyScopes', ['aokie:realtime']),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(200, $idempotent->getStatusCode(), (string) $idempotent->getBody());

        $emptyRoster = $revisionOne;
        $emptyRoster['approvedPeerKeyThumbprints'] = [];
        $emptyRoster['peerRosterRevision'] = 2;
        $emptyRoster['peerRosterHash'] = AokieCompanionAdmissionSigner::peerRosterHash(2, []);
        $empty = self::$controller->pluginAdmission(
            $this->request('POST', '/api/v1/aokie-companion/admission')
                ->withParsedBody($emptyRoster)
                ->withAttribute('apiKeyId', $this->apiKeyId)
                ->withAttribute('apiKeyScopes', ['aokie:realtime']),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(400, $empty->getStatusCode());
        $this->assertSame('invalid_endpoint_identity', self::decode($empty)['code']);

        $malformedKey = $revisionOne;
        $malformedKey['endpointPublicKey']['thumbprint'] = $holderA;
        $malformed = self::$controller->pluginAdmission(
            $this->request('POST', '/api/v1/aokie-companion/admission')
                ->withParsedBody($malformedKey)
                ->withAttribute('apiKeyId', $this->apiKeyId)
                ->withAttribute('apiKeyScopes', ['aokie:realtime']),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(400, $malformed->getStatusCode());

        $malformedThumbprint = $revisionOne;
        $malformedThumbprint['holderKeyThumbprint'] = 'not-an-rfc7638-thumbprint';
        $badThumbprint = self::$controller->pluginAdmission(
            $this->request('POST', '/api/v1/aokie-companion/admission')
                ->withParsedBody($malformedThumbprint)
                ->withAttribute('apiKeyId', $this->apiKeyId)
                ->withAttribute('apiKeyScopes', ['aokie:realtime']),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(400, $badThumbprint->getStatusCode());

        $badHash = $revisionOne;
        $badHash['peerRosterHash'] = $holderC;
        $badHashResponse = self::$controller->pluginAdmission(
            $this->request('POST', '/api/v1/aokie-companion/admission')
                ->withParsedBody($badHash)
                ->withAttribute('apiKeyId', $this->apiKeyId)
                ->withAttribute('apiKeyScopes', ['aokie:realtime']),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(400, $badHashResponse->getStatusCode());

        $equivocation = $revisionOne;
        $equivocation['approvedPeerKeyThumbprints'] = [$holderA, $holderB];
        sort($equivocation['approvedPeerKeyThumbprints'], SORT_STRING);
        $equivocation['peerRosterHash'] = AokieCompanionAdmissionSigner::peerRosterHash(
            (int) $equivocation['peerRosterRevision'],
            $equivocation['approvedPeerKeyThumbprints'],
        );
        $equivocationResponse = self::$controller->pluginAdmission(
            $this->request('POST', '/api/v1/aokie-companion/admission')
                ->withParsedBody($equivocation)
                ->withAttribute('apiKeyId', $this->apiKeyId)
                ->withAttribute('apiKeyScopes', ['aokie:realtime']),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(409, $equivocationResponse->getStatusCode());
        $this->assertSame('endpoint_identity_conflict', self::decode($equivocationResponse)['code']);

        $this->ensurePluginRosterContains($holderB);
        $stale = self::$controller->pluginAdmission(
            $this->request('POST', '/api/v1/aokie-companion/admission')
                ->withParsedBody($revisionOne)
                ->withAttribute('apiKeyId', $this->apiKeyId)
                ->withAttribute('apiKeyScopes', ['aokie:realtime']),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(409, $stale->getStatusCode());

        $rotatedPlugin = $this->pluginAdmissionBody();
        $rotatedPlugin['endpointPublicKey'] = [
            'algorithm' => 'ed25519',
            'publicKey' => '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
            'thumbprint' => 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k',
        ];
        $rotatedPlugin['holderKeyThumbprint'] = $rotatedPlugin['endpointPublicKey']['thumbprint'];
        $substitution = self::$controller->pluginAdmission(
            $this->request('POST', '/api/v1/aokie-companion/admission')
                ->withParsedBody($rotatedPlugin)
                ->withAttribute('apiKeyId', $this->apiKeyId)
                ->withAttribute('apiKeyScopes', ['aokie:realtime']),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(409, $substitution->getStatusCode());

        $oauth = $this->authorizeCompanion($deviceId);
        $mobile = $this->mobileAdmission($oauth['accessToken'], $deviceId, null, $holderA, false);
        $mobileBody = self::decode($mobile);
        $this->assertSame(200, $mobile->getStatusCode(), json_encode($mobileBody));
        $this->assertSame($holderA, $mobileBody['holderKeyThumbprint']);
        $this->assertSame(self::PLUGIN_THUMBPRINT, $mobileBody['expectedPeerKeyThumbprint']);

        $mobileSubstitution = $this->mobileAdmission(
            $oauth['accessToken'],
            $deviceId,
            null,
            $holderB,
            false,
        );
        $this->assertSame(409, $mobileSubstitution->getStatusCode());
        $this->assertSame('endpoint_identity_conflict', self::decode($mobileSubstitution)['code']);

        $missingHolder = self::$controller->mobileAdmission(
            $this->request('POST', '/api/aokie-companion/admission')
                ->withHeader('Authorization', 'Bearer ' . $oauth['accessToken'])
                ->withParsedBody(['appId' => $this->appId, 'deviceId' => $deviceId]),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(400, $missingHolder->getStatusCode());
        $unpaired = $this->mobileAdmission($oauth['accessToken'], $deviceId, null, $holderC, false);
        $this->assertSame(403, $unpaired->getStatusCode());
        $this->assertSame('mobile_not_paired', self::decode($unpaired)['code']);

        $crossApp = self::$controller->mobileAdmission(
            $this->request('POST', '/api/aokie-companion/admission')
                ->withHeader('Authorization', 'Bearer ' . $oauth['accessToken'])
                ->withParsedBody([
                    'appId' => 'another-app',
                    'deviceId' => $deviceId,
                    'holderKeyThumbprint' => $holderA,
                ]),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(403, $crossApp->getStatusCode());
        $this->assertSame('app_binding_required', self::decode($crossApp)['code']);

        $otherDesktop = 'desk-' . bin2hex(random_bytes(8));
        self::$pdo->prepare(
            "INSERT INTO desktop_connections
                (id, owner_user_id, device_name, desktop_instance_id, api_key_id,
                 last_seen_at, capabilities_json)
             VALUES (?, ?, 'Other Desktop', ?, ?, NOW(), '[\"aokie\"]')"
        )->execute([
            $otherDesktop,
            $this->userId,
            'other-instance-' . bin2hex(random_bytes(5)),
            'other-key-' . bin2hex(random_bytes(5)),
        ]);
        self::$pdo->prepare('UPDATE connector_assignments SET desktop_connection_id = ? WHERE id = ?')
            ->execute([$otherDesktop, $this->assignmentId]);
        $wrongDesktop = $this->mobileAdmission($oauth['accessToken'], $deviceId, null, $holderA, false);
        $this->assertSame(409, $wrongDesktop->getStatusCode());
        $this->assertSame('desktop_identity_unavailable', self::decode($wrongDesktop)['code']);
        self::$pdo->prepare('UPDATE connector_assignments SET desktop_connection_id = ? WHERE id = ?')
            ->execute([$this->desktopId, $this->assignmentId]);

        $pluginDevice = array_values(array_filter(
            (new AokieCompanionDeviceService(self::$mysql))->listForApp($this->appId),
            static fn (array $device): bool => $device['role'] === 'plugin',
        ))[0];
        $revoked = self::$controller->revokeDevice(
            $this->request('DELETE', '/api/aokie-companion/devices/' . $pluginDevice['id']),
            (new ResponseFactory())->createResponse(),
            ['id' => $pluginDevice['id']],
        );
        $this->assertSame(200, $revoked->getStatusCode());
        $revokedAdmission = self::$controller->pluginAdmission(
            $this->request('POST', '/api/v1/aokie-companion/admission')
                ->withParsedBody($this->pluginAdmissionBody())
                ->withAttribute('apiKeyId', $this->apiKeyId)
                ->withAttribute('apiKeyScopes', ['aokie:realtime']),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(403, $revokedAdmission->getStatusCode());
        $this->assertSame('device_revoked', self::decode($revokedAdmission)['code']);

        $approved = self::$controller->approveDevice(
            $this->request('POST', '/api/aokie-companion/devices/' . $pluginDevice['id'] . '/approve'),
            (new ResponseFactory())->createResponse(),
            ['id' => $pluginDevice['id']],
        );
        $this->assertSame(200, $approved->getStatusCode());
        $rotatedPlugin['peerRosterRevision'] = 1;
        $rotatedPlugin['peerRosterHash'] = AokieCompanionAdmissionSigner::peerRosterHash(
            1,
            $rotatedPlugin['approvedPeerKeyThumbprints'],
        );
        $rotatedAfterOwnerAction = self::$controller->pluginAdmission(
            $this->request('POST', '/api/v1/aokie-companion/admission')
                ->withParsedBody($rotatedPlugin)
                ->withAttribute('apiKeyId', $this->apiKeyId)
                ->withAttribute('apiKeyScopes', ['aokie:realtime']),
            (new ResponseFactory())->createResponse(),
        );
        $rotatedBody = self::decode($rotatedAfterOwnerAction);
        $this->assertSame(200, $rotatedAfterOwnerAction->getStatusCode(), json_encode($rotatedBody));
        $this->assertSame($rotatedPlugin['holderKeyThumbprint'], $rotatedBody['holderKeyThumbprint']);
    }

    public function testActiveMemberAdmissionIsIntersectedWithCurrentExactRolePermissions(): void
    {
        $memberId = 'm-' . bin2hex(random_bytes(8));
        $this->extraUsers[] = $memberId;
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'Member')")
            ->execute([$memberId, $memberId . '@aokie.test']);
        $role = self::$pdo->prepare("SELECT id FROM app_roles WHERE app_id = ? AND name = 'Member'");
        $role->execute([$this->appId]);
        $roleId = (string) $role->fetchColumn();
        foreach ([
            AppPermissions::AOKIE_COMPANION_STATE,
            AppPermissions::AOKIE_COMPANION_MONITOR,
            AppPermissions::AOKIE_COMPANION_CONSULT,
        ] as $permission) {
            self::$pdo->prepare(
                'INSERT INTO app_role_permissions (id, role_id, form_id, permission) VALUES (?, ?, NULL, ?)'
            )->execute(['p-' . bin2hex(random_bytes(8)), $roleId, $permission]);
        }
        $appUserId = 'au-' . bin2hex(random_bytes(8));
        self::$pdo->prepare(
            "INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at)
             VALUES (?, ?, ?, ?, 'active', NOW())"
        )->execute([$appUserId, $this->appId, $memberId, $roleId]);

        $deviceId = 'member_device_' . bin2hex(random_bytes(4));
        $oauth = $this->authorizeCompanion($deviceId, $memberId);
        $session = self::$tokens->validate($oauth['accessToken']);
        $this->assertSame(
            ['aokie:state', 'aokie:monitor', 'aokie:consult'],
            $session['scopes'],
            'consent is narrowed to exact current role grants',
        );
        $admission = $this->mobileAdmission($oauth['accessToken'], $deviceId);
        $body = self::decode($admission);
        $this->assertSame(200, $admission->getStatusCode(), json_encode($body));
        $this->assertContains('monitor', $body['scopes']);
        $this->assertContains('consult', $body['scopes']);
        $this->assertContains('captions_read', $body['scopes']);
        $this->assertNotContains('takeover', $body['scopes']);
        $this->assertNotContains('resume_aokie', $body['scopes']);

        self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id = ? AND permission = ?')
            ->execute([$roleId, AppPermissions::AOKIE_COMPANION_CONSULT]);
        $withoutConsult = self::decode($this->mobileAdmission($oauth['accessToken'], $deviceId));
        $this->assertNotContains('consult', $withoutConsult['scopes']);
        $this->assertContains('monitor', $withoutConsult['scopes']);
        $this->assertContains('rtc_signal', $withoutConsult['scopes']);

        self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id = ? AND permission = ?')
            ->execute([$roleId, AppPermissions::AOKIE_COMPANION_MONITOR]);
        $narrowed = self::decode($this->mobileAdmission($oauth['accessToken'], $deviceId));
        $this->assertNotContains('monitor', $narrowed['scopes']);
        $this->assertNotContains('rtc_signal', $narrowed['scopes']);

        self::$pdo->prepare("UPDATE app_users SET status = 'suspended' WHERE id = ?")->execute([$appUserId]);
        $suspended = $this->mobileAdmission($oauth['accessToken'], $deviceId);
        $this->assertSame(403, $suspended->getStatusCode());
    }

    public function testEndCallerIsAnIndependentRoleAndPolicyGrant(): void
    {
        $memberId = 'm-' . bin2hex(random_bytes(8));
        $this->extraUsers[] = $memberId;
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'Member')")
            ->execute([$memberId, $memberId . '@aokie.test']);
        $role = self::$pdo->prepare("SELECT id FROM app_roles WHERE app_id = ? AND name = 'Member'");
        $role->execute([$this->appId]);
        $roleId = (string) $role->fetchColumn();
        foreach ([
            AppPermissions::AOKIE_COMPANION_STATE,
            AppPermissions::AOKIE_COMPANION_TAKEOVER,
        ] as $permission) {
            self::$pdo->prepare(
                'INSERT INTO app_role_permissions (id, role_id, form_id, permission) VALUES (?, ?, NULL, ?)'
            )->execute(['p-' . bin2hex(random_bytes(8)), $roleId, $permission]);
        }
        self::$pdo->prepare(
            "INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at)
             VALUES (?, ?, ?, ?, 'active', NOW())"
        )->execute(['au-' . bin2hex(random_bytes(8)), $this->appId, $memberId, $roleId]);

        $withoutEndDevice = 'member_no_end_' . bin2hex(random_bytes(4));
        $withoutEnd = $this->authorizeCompanion($withoutEndDevice, $memberId);
        $withoutEndSession = self::$tokens->validate($withoutEnd['accessToken']);
        $this->assertContains('aokie:takeover', $withoutEndSession['scopes']);
        $this->assertNotContains('aokie:end_caller', $withoutEndSession['scopes']);
        $withoutEndAdmission = self::decode($this->mobileAdmission($withoutEnd['accessToken'], $withoutEndDevice));
        $this->assertContains('takeover', $withoutEndAdmission['scopes']);
        $this->assertNotContains('end_caller', $withoutEndAdmission['scopes']);

        self::$pdo->prepare(
            'INSERT INTO app_role_permissions (id, role_id, form_id, permission) VALUES (?, ?, NULL, ?)'
        )->execute(['p-' . bin2hex(random_bytes(8)), $roleId, AppPermissions::AOKIE_COMPANION_END]);
        $withEndDevice = 'member_with_end_' . bin2hex(random_bytes(4));
        $withEnd = $this->authorizeCompanion($withEndDevice, $memberId);
        $withEndSession = self::$tokens->validate($withEnd['accessToken']);
        $this->assertContains('aokie:end_caller', $withEndSession['scopes']);
        $withEndAdmission = self::decode($this->mobileAdmission($withEnd['accessToken'], $withEndDevice));
        $this->assertContains('end_caller', $withEndAdmission['scopes']);
        $this->assertNotContains('resume_aokie', $withEndAdmission['scopes']);

        $policyOff = self::$controller->updatePolicy(
            $this->request('PUT', '/api/aokie-companion/policy')->withParsedBody([
                'appId' => $this->appId,
                'remoteConsent' => [
                    'remoteMonitoring' => true,
                    'remoteConsult' => true,
                    'remoteTakeover' => false,
                    'remoteCaptions' => true,
                    'remoteAssistance' => true,
                ],
            ]),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(200, $policyOff->getStatusCode(), (string) $policyOff->getBody());
        $policyNarrowed = self::decode($this->mobileAdmission($withEnd['accessToken'], $withEndDevice));
        $this->assertNotContains('takeover', $policyNarrowed['scopes']);
        $this->assertNotContains('end_caller', $policyNarrowed['scopes']);
    }

    public function testRefreshTokenReuseRevokesEveryAccessSessionInTheFamily(): void
    {
        $deviceId = 'refresh_family_' . bin2hex(random_bytes(5));
        $oauth = $this->authorizeCompanion($deviceId);
        $initial = self::$tokens->validate($oauth['accessToken']);
        $this->assertNotNull($initial);
        $this->assertContains('aokie:assistance', $initial['scopes']);
        $this->assertContains('aokie:end_caller', $initial['scopes']);
        $this->assertNotEmpty($initial['refreshFamilyId']);

        $rotation = self::$oauth->redeemRefreshToken(
            $oauth['refreshToken'],
            McpOAuthService::AOKIE_COMPANION_CLIENT_ID,
            true,
        );
        $this->assertTrue($rotation['ok']);
        $this->assertNotEmpty($rotation['newRefreshToken']);
        $this->assertSame($initial['refreshFamilyId'], $rotation['familyId']);
        $descendant = self::$oauth->issueAccessToken(
            $rotation['userId'],
            $rotation['appId'],
            $rotation['scopes'],
            $rotation['resource'],
            McpOAuthService::AOKIE_COMPANION_CLIENT_ID,
            $rotation['deviceId'],
            $rotation['familyId'],
        );
        $this->assertNotNull(self::$tokens->validate($descendant['access_token']));

        $reuse = self::$oauth->redeemRefreshToken(
            $oauth['refreshToken'],
            McpOAuthService::AOKIE_COMPANION_CLIENT_ID,
            true,
        );
        $this->assertFalse($reuse['ok']);
        $this->assertStringContainsString('reuse detected', $reuse['error_description']);
        $this->assertNull(self::$tokens->validate($oauth['accessToken']));
        $this->assertNull(self::$tokens->validate($descendant['access_token']));
        $descendantRefresh = self::$oauth->redeemRefreshToken(
            $rotation['newRefreshToken'],
            McpOAuthService::AOKIE_COMPANION_CLIENT_ID,
            true,
        );
        $this->assertFalse($descendantRefresh['ok']);
    }

    public function testNativeBootstrapAvailabilityPushAndInstallationIsolation(): void
    {
        $deviceId = 'native_bootstrap_' . bin2hex(random_bytes(5));
        $oauth = $this->authorizeCompanion($deviceId);
        $admission = self::decode($this->mobileAdmission($oauth['accessToken'], $deviceId));
        $device = $admission['device'];
        $service = new AokieCompanionDeviceService(self::$mysql);
        $service->saveRoutingGroup($this->userId, $this->appId, [
            'name' => 'Native Reception',
            'policy' => 'all',
            'members' => [['deviceId' => $device['id'], 'priority' => 10]],
        ]);
        $staffUser = 'staff-' . bin2hex(random_bytes(8));
        $this->extraUsers[] = $staffUser;
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'Casey Operator')")
            ->execute([$staffUser, $staffUser . '@aokie.test']);
        $memberRole = self::$pdo->prepare("SELECT id FROM app_roles WHERE app_id = ? AND name = 'Member'");
        $memberRole->execute([$this->appId]);
        $staffAppUserId = 'au-' . bin2hex(random_bytes(8));
        self::$pdo->prepare(
            "INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at)
             VALUES (?, ?, ?, ?, 'active', NOW())"
        )->execute([$staffAppUserId, $this->appId, $staffUser, (string) $memberRole->fetchColumn()]);

        $cookieOnly = self::$controller->mobileBootstrap(
            $this->request('GET', '/api/aokie-companion/mobile/bootstrap'),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(401, $cookieOnly->getStatusCode(), 'browser identity is never native Companion identity');
        $bootstrap = self::$controller->mobileBootstrap(
            $this->request('GET', '/api/aokie-companion/mobile/bootstrap')
                ->withHeader('Authorization', 'Bearer ' . $oauth['accessToken']),
            (new ResponseFactory())->createResponse(),
        );
        $bootstrapBody = self::decode($bootstrap);
        $this->assertSame(200, $bootstrap->getStatusCode(), json_encode($bootstrapBody));
        $this->assertSame($this->appId, $bootstrapBody['membership']['appId']);
        $this->assertSame($deviceId, $bootstrapBody['device']['subjectId']);
        $this->assertSame([
            'id',
            'userId',
            'appId',
            'subjectId',
            'role',
            'displayName',
            'grants',
            'approvedAt',
            'lastSeenAt',
            'revokedAt',
        ], array_keys($bootstrapBody['device']), 'native bootstrap must not expose Desktop identity metadata');
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/D', $bootstrapBody['device']['approvedAt']);
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/D', $bootstrapBody['device']['lastSeenAt']);
        $this->assertContains('end_caller', $bootstrapBody['capabilities']);
        $bootstrapJson = json_encode($bootstrapBody, JSON_THROW_ON_ERROR);
        $this->assertStringNotContainsString($oauth['accessToken'], $bootstrapJson);
        $this->assertStringNotContainsString($oauth['refreshToken'], $bootstrapJson);
        $this->assertCount(2, $bootstrapBody['staff']);
        $staffJson = json_encode($bootstrapBody['staff'], JSON_THROW_ON_ERROR);
        $this->assertStringNotContainsString('@aokie.test', $staffJson);
        $this->assertStringNotContainsString($this->userId, $staffJson);
        $this->assertStringNotContainsString($staffUser, $staffJson);
        $currentStaff = array_values(array_filter(
            $bootstrapBody['staff'],
            static fn (array $staff): bool => $staff['isCurrentUser'] === true,
        ));
        $this->assertCount(1, $currentStaff);
        $this->assertSame(
            ['id', 'displayName', 'roleName', 'isCurrentUser', 'isOwner', 'companionReady'],
            array_keys($currentStaff[0]),
        );
        $this->assertSame('Owner', $currentStaff[0]['displayName']);
        $this->assertSame('Owner', $currentStaff[0]['roleName']);
        $this->assertTrue($currentStaff[0]['isOwner']);
        $this->assertTrue($currentStaff[0]['companionReady']);
        $inactiveEndpointStaff = array_values(array_filter(
            $bootstrapBody['staff'],
            static fn (array $staff): bool => $staff['id'] === $staffAppUserId,
        ));
        $this->assertCount(1, $inactiveEndpointStaff);
        $this->assertFalse($inactiveEndpointStaff[0]['companionReady']);
        $routingMember = $bootstrapBody['routingGroups'][0]['members'][0];
        $this->assertSame([
            'staffId',
            'displayName',
            'roleName',
            'isCurrentUser',
            'priority',
            'enabled',
            'availability',
            'availabilityUpdatedAt',
            'availabilityExpiresAt',
        ], array_keys($routingMember));
        $this->assertSame($currentStaff[0]['id'], $routingMember['staffId']);
        $this->assertSame('Owner', $routingMember['displayName'], 'device-supplied display name is not staff authority');
        $this->assertSame('Owner', $routingMember['roleName']);
        $this->assertTrue($routingMember['isCurrentUser']);
        $this->assertSame(10, $routingMember['priority']);
        $this->assertTrue($routingMember['enabled']);
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/D', $routingMember['availabilityUpdatedAt']);
        $routing = self::$controller->mobileRouting(
            $this->request('GET', '/api/aokie-companion/mobile/routing')
                ->withHeader('Authorization', 'Bearer ' . $oauth['accessToken']),
            (new ResponseFactory())->createResponse(),
        );
        $routingBody = self::decode($routing);
        $this->assertSame(200, $routing->getStatusCode(), json_encode($routingBody));
        $this->assertSame(['routingGroups', 'staff'], array_keys($routingBody));
        $this->assertSame($routingMember, $routingBody['routingGroups'][0]['members'][0]);
        $this->assertSame($bootstrapBody['staff'], $routingBody['staff']);

        $availability = self::$controller->mobileSetAvailability(
            $this->request('PUT', '/api/aokie-companion/mobile/availability')
                ->withHeader('Authorization', 'Bearer ' . $oauth['accessToken'])
                ->withParsedBody(['availability' => 'busy', 'expiresInSeconds' => 600]),
            (new ResponseFactory())->createResponse(),
        );
        $availabilityBody = self::decode($availability);
        $this->assertSame(200, $availability->getStatusCode(), json_encode($availabilityBody));
        $this->assertSame('busy', $availabilityBody['availability']['availability']);
        $this->assertNotNull($availabilityBody['availability']['expiresAt']);
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/D', $availabilityBody['availability']['updatedAt']);
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/D', $availabilityBody['availability']['expiresAt']);

        $rawPushToken = 'fcm-managed-' . bin2hex(random_bytes(24));
        $registered = self::$controller->mobileRegisterPushEndpoint(
            $this->request('PUT', '/api/aokie-companion/mobile/devices/' . $deviceId . '/push-endpoints/fcm')
                ->withHeader('Authorization', 'Bearer ' . $oauth['accessToken'])
                ->withParsedBody([
                    'mode' => 'managed',
                    'token' => $rawPushToken,
                    'environment' => 'production',
                ]),
            (new ResponseFactory())->createResponse(),
            ['deviceId' => $deviceId, 'kind' => 'fcm'],
        );
        $registeredBody = self::decode($registered);
        $this->assertSame(201, $registered->getStatusCode(), json_encode($registeredBody));
        $registeredJson = json_encode($registeredBody, JSON_THROW_ON_ERROR);
        $this->assertStringNotContainsString($rawPushToken, $registeredJson);
        $this->assertArrayNotHasKey('token', $registeredBody['endpoint']);
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/D', $registeredBody['endpoint']['rotatedAt']);
        $storedEndpoint = self::$pdo->prepare(
            'SELECT endpoint_ciphertext, broker_handle, endpoint_fingerprint
             FROM aokie_companion_push_endpoints WHERE id = ?'
        );
        $storedEndpoint->execute([$registeredBody['endpoint']['id']]);
        $stored = $storedEndpoint->fetch(PDO::FETCH_ASSOC);
        $this->assertIsArray($stored);
        $this->assertStringNotContainsString($rawPushToken, (string) $stored['endpoint_ciphertext']);
        $this->assertNull($stored['broker_handle']);
        $this->assertSame(hash('sha256', $rawPushToken), $stored['endpoint_fingerprint']);

        $wrongPath = self::$controller->mobileRegisterPushEndpoint(
            $this->request('PUT', '/api/aokie-companion/mobile/devices/another-device/push-endpoints/fcm')
                ->withHeader('Authorization', 'Bearer ' . $oauth['accessToken'])
                ->withParsedBody([
                    'mode' => 'managed',
                    'token' => $rawPushToken,
                    'environment' => 'production',
                ]),
            (new ResponseFactory())->createResponse(),
            ['deviceId' => 'another-device', 'kind' => 'fcm'],
        );
        $this->assertSame(403, $wrongPath->getStatusCode());
        $mixedCredentials = self::$controller->mobileRegisterPushEndpoint(
            $this->request('PUT', '/api/aokie-companion/mobile/devices/' . $deviceId . '/push-endpoints/fcm')
                ->withHeader('Authorization', 'Bearer ' . $oauth['accessToken'])
                ->withParsedBody([
                    'mode' => 'managed',
                    'token' => $rawPushToken,
                    'brokerHandle' => 'opaque-broker-' . bin2hex(random_bytes(16)),
                    'environment' => 'production',
                ]),
            (new ResponseFactory())->createResponse(),
            ['deviceId' => $deviceId, 'kind' => 'fcm'],
        );
        $this->assertSame(400, $mixedCredentials->getStatusCode());

        $otherUser = 'other-' . bin2hex(random_bytes(8));
        $this->extraUsers[] = $otherUser;
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'Other')")
            ->execute([$otherUser, $otherUser . '@aokie.test']);
        try {
            $service->enrollOrTouch(
                $otherUser,
                $this->appId,
                $deviceId,
                'mobile',
                'Hijack Attempt',
                ['state_read'],
                ['holderKeyThumbprint' => $this->mobileHolder($deviceId)],
            );
            $this->fail('the same installation subject must not move to another account');
        } catch (\DomainException $error) {
            $this->assertStringContainsString('another account', $error->getMessage());
        }

        $audit = self::$controller->auditHistory(
            $this->request('GET', '/api/aokie-companion/audit')->withQueryParams(['appId' => $this->appId]),
            (new ResponseFactory())->createResponse(),
        );
        $actions = array_column(self::decode($audit)['audit'], 'action');
        $this->assertContains('aokie.companion.availability.updated', $actions);
        $this->assertContains('aokie.companion.push.registered', $actions);
    }

    public function testNativeStaffDirectoryIsBoundedAndTextIsClientSafe(): void
    {
        $deviceId = 'bounded_staff_' . bin2hex(random_bytes(5));
        $oauth = $this->authorizeCompanion($deviceId);
        $this->assertSame(200, $this->mobileAdmission($oauth['accessToken'], $deviceId)->getStatusCode());
        $role = self::$pdo->prepare("SELECT id FROM app_roles WHERE app_id = ? AND name = 'Member'");
        $role->execute([$this->appId]);
        $roleId = (string) $role->fetchColumn();
        $insertUser = self::$pdo->prepare(
            "INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', ?)"
        );
        $insertMember = self::$pdo->prepare(
            "INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at)
             VALUES (?, ?, ?, ?, 'active', NOW())"
        );
        $longStaffId = '';
        for ($index = 0; $index < 205; $index++) {
            $userId = 'bounded-' . bin2hex(random_bytes(8));
            $appUserId = 'au-' . bin2hex(random_bytes(8));
            $this->extraUsers[] = $userId;
            $name = $index === 0
                ? 'A' . "\x01" . str_repeat('é', 100)
                : sprintf('Staff %03d', $index);
            if ($index === 0) {
                $longStaffId = $appUserId;
            }
            $insertUser->execute([$userId, $userId . '@aokie.test', $name]);
            $insertMember->execute([$appUserId, $this->appId, $userId, $roleId]);
        }

        $bootstrap = self::$controller->mobileBootstrap(
            $this->request('GET', '/api/aokie-companion/mobile/bootstrap')
                ->withHeader('Authorization', 'Bearer ' . $oauth['accessToken']),
            (new ResponseFactory())->createResponse(),
        );
        $body = self::decode($bootstrap);
        $this->assertSame(200, $bootstrap->getStatusCode(), json_encode($body));
        $this->assertCount(200, $body['staff'], 'native parser limit is enforced server-side');
        $current = array_values(array_filter(
            $body['staff'],
            static fn (array $staff): bool => $staff['isCurrentUser'] === true,
        ));
        $this->assertCount(1, $current);
        $this->assertTrue($current[0]['isOwner']);
        $long = array_values(array_filter(
            $body['staff'],
            static fn (array $staff): bool => $staff['id'] === $longStaffId,
        ));
        $this->assertCount(1, $long);
        $this->assertLessThanOrEqual(120, strlen($long[0]['displayName']));
        $this->assertSame(0, preg_match('/\p{Cc}/u', $long[0]['displayName']));
    }

    public function testNativeCallRecordsAreRedactedTenantBoundAndExactlyRoleScoped(): void
    {
        $forms = $this->installAokieCallForms();
        $ownerDevice = 'call_records_owner_' . bin2hex(random_bytes(5));
        $ownerOauth = $this->authorizeCompanion($ownerDevice);
        $this->assertSame(200, $this->mobileAdmission($ownerOauth['accessToken'], $ownerDevice)->getStatusCode());

        $ownerCallId = 'call-owner-' . bin2hex(random_bytes(4));
        $ownerCall = self::$responses->createResponse($forms['calls'], [
            'answers' => [
                'call_id' => $ownerCallId,
                'caller_phone' => '+61 491 570 156',
                'caller_name' => 'Alice 0412 345 678',
                'status' => 'completed',
                'direction' => 'inbound',
                'started_at' => '2026-07-16T09:00:00Z',
                'ended_at' => '2026-07-16T09:02:05Z',
                'duration_seconds' => 125,
                'summary' => 'Asked us to call 0491 570 156 tomorrow.',
                'follow_up_required' => ['yes'],
            ],
            'submittedByUserId' => $this->userId,
        ]);
        $ownerTurn = self::$responses->createResponse($forms['transcript-turns'], [
            'answers' => [
                'call_id' => $ownerCallId,
                'turn_index' => 1,
                'speaker' => 'caller',
                'text' => 'My direct number is 0491 570 156.',
                'stt_text' => 'raw speech that must never be returned',
                'timestamp' => '2026-07-16T09:00:10Z',
            ],
            'submittedByUserId' => $this->userId,
        ]);
        $ownerTask = self::$responses->createResponse($forms['follow-up-tasks'], [
            'answers' => [
                'call_id' => $ownerCallId,
                'phone' => '0491570156',
                'summary' => 'Return the call on 0491 570 156.',
                'status' => 'open',
                'priority' => 'high',
            ],
            'submittedByUserId' => $this->userId,
        ]);
        $this->assertIsArray($ownerCall);
        $this->assertIsArray($ownerTurn);
        $this->assertIsArray($ownerTask);

        $ownerList = self::$controller->mobileCallRecords(
            $this->request('GET', '/api/aokie-companion/mobile/call-records')
                ->withHeader('Authorization', 'Bearer ' . $ownerOauth['accessToken']),
            (new ResponseFactory())->createResponse(),
        );
        $ownerListBody = self::decode($ownerList);
        $this->assertSame(200, $ownerList->getStatusCode(), json_encode($ownerListBody));
        $this->assertSame('full', $ownerListBody['access']);
        $this->assertCount(1, $ownerListBody['records']);
        $this->assertSame([
            'id',
            'callId',
            'callerName',
            'maskedNumber',
            'status',
            'direction',
            'summary',
            'startedAt',
            'endedAt',
            'durationSeconds',
            'followUpRequired',
            'submittedAt',
        ], array_keys($ownerListBody['records'][0]));
        $this->assertSame('•••• 0156', $ownerListBody['records'][0]['maskedNumber']);
        $this->assertTrue($ownerListBody['records'][0]['followUpRequired']);
        $ownerListJson = json_encode($ownerListBody, JSON_THROW_ON_ERROR);
        $this->assertStringNotContainsString('0491570156', preg_replace('/\D+/', '', $ownerListJson) ?? '');
        $this->assertStringNotContainsString('+61 491 570 156', $ownerListJson);

        $ownerDetail = self::$controller->mobileCallRecord(
            $this->request('GET', '/api/aokie-companion/mobile/call-records/' . $ownerCall['id'])
                ->withHeader('Authorization', 'Bearer ' . $ownerOauth['accessToken']),
            (new ResponseFactory())->createResponse(),
            ['recordId' => $ownerCall['id']],
        );
        $ownerDetailBody = self::decode($ownerDetail);
        $this->assertSame(200, $ownerDetail->getStatusCode(), json_encode($ownerDetailBody));
        $this->assertSame(['record', 'transcript', 'followUps'], array_keys($ownerDetailBody));
        $this->assertSame(['id', 'speaker', 'text', 'occurredAt'], array_keys($ownerDetailBody['transcript'][0]));
        $this->assertSame(['id', 'summary', 'status', 'priority', 'submittedAt'], array_keys($ownerDetailBody['followUps'][0]));
        $ownerDetailJson = json_encode($ownerDetailBody, JSON_THROW_ON_ERROR);
        $this->assertStringNotContainsString('raw speech', $ownerDetailJson);
        $this->assertStringNotContainsString('0491 570 156', $ownerDetailJson);
        $this->assertStringNotContainsString('0491570156', $ownerDetailJson);

        $missing = self::$controller->mobileCallRecord(
            $this->request('GET', '/api/aokie-companion/mobile/call-records/missing-record')
                ->withHeader('Authorization', 'Bearer ' . $ownerOauth['accessToken']),
            (new ResponseFactory())->createResponse(),
            ['recordId' => 'missing-record'],
        );
        $this->assertSame(404, $missing->getStatusCode());

        $foreign = self::$apps->createApp([
            'name' => 'Foreign Aokie ' . bin2hex(random_bytes(3)),
            'slug' => 'foreign-aokie-' . bin2hex(random_bytes(6)),
            'status' => 'published',
        ], $this->userId);
        $foreignForms = $this->installAokieCallForms((string) $foreign['id']);
        $foreignCall = self::$responses->createResponse($foreignForms['calls'], [
            'answers' => ['call_id' => 'foreign-call', 'caller_phone' => '0400000000'],
            'submittedByUserId' => $this->userId,
        ]);
        $crossTenant = self::$controller->mobileCallRecord(
            $this->request('GET', '/api/aokie-companion/mobile/call-records/' . $foreignCall['id'])
                ->withHeader('Authorization', 'Bearer ' . $ownerOauth['accessToken']),
            (new ResponseFactory())->createResponse(),
            ['recordId' => $foreignCall['id']],
        );
        $this->assertSame(404, $crossTenant->getStatusCode());

        $memberId = 'call-member-' . bin2hex(random_bytes(7));
        $this->extraUsers[] = $memberId;
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'Call Member')")
            ->execute([$memberId, $memberId . '@aokie.test']);
        $role = self::$pdo->prepare("SELECT id FROM app_roles WHERE app_id = ? AND name = 'Member'");
        $role->execute([$this->appId]);
        $roleId = (string) $role->fetchColumn();
        foreach ([
            [null, AppPermissions::AOKIE_COMPANION_STATE],
            [$forms['calls'], AppPermissions::VIEW_OWN_RESPONSES],
            [$forms['transcript-turns'], AppPermissions::VIEW_OWN_RESPONSES],
            [$forms['follow-up-tasks'], AppPermissions::VIEW_OWN_RESPONSES],
        ] as [$formId, $permission]) {
            self::$pdo->prepare(
                'INSERT INTO app_role_permissions (id, role_id, form_id, permission) VALUES (?, ?, ?, ?)'
            )->execute(['p-' . bin2hex(random_bytes(8)), $roleId, $formId, $permission]);
        }
        self::$pdo->prepare(
            "INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at)
             VALUES (?, ?, ?, ?, 'active', NOW())"
        )->execute(['au-' . bin2hex(random_bytes(8)), $this->appId, $memberId, $roleId]);
        $memberDevice = 'call_records_member_' . bin2hex(random_bytes(5));
        $memberOauth = $this->authorizeCompanion($memberDevice, $memberId);
        $this->assertSame(200, $this->mobileAdmission($memberOauth['accessToken'], $memberDevice)->getStatusCode());

        $memberCallId = 'call-member-' . bin2hex(random_bytes(4));
        $memberCall = self::$responses->createResponse($forms['calls'], [
            'answers' => [
                'call_id' => $memberCallId,
                'caller_phone' => '0400 111 222',
                'status' => 'completed',
                'direction' => 'inbound',
            ],
            'submittedByUserId' => $memberId,
        ]);
        $memberTurn = self::$responses->createResponse($forms['transcript-turns'], [
            'answers' => ['call_id' => $memberCallId, 'turn_index' => 2, 'speaker' => 'operator', 'text' => 'Member turn'],
            'submittedByUserId' => $memberId,
        ]);
        self::$responses->createResponse($forms['transcript-turns'], [
            'answers' => ['call_id' => $memberCallId, 'turn_index' => 1, 'speaker' => 'system', 'text' => 'Owner-only turn'],
            'submittedByUserId' => $this->userId,
        ]);
        $memberTask = self::$responses->createResponse($forms['follow-up-tasks'], [
            'answers' => ['call_id' => $memberCallId, 'summary' => 'Member task', 'status' => 'open', 'priority' => 'normal'],
            'submittedByUserId' => $memberId,
        ]);
        self::$responses->createResponse($forms['follow-up-tasks'], [
            'answers' => ['call_id' => $memberCallId, 'summary' => 'Owner-only task', 'status' => 'open', 'priority' => 'high'],
            'submittedByUserId' => $this->userId,
        ]);

        $memberList = self::$controller->mobileCallRecords(
            $this->request('GET', '/api/aokie-companion/mobile/call-records')
                ->withHeader('Authorization', 'Bearer ' . $memberOauth['accessToken']),
            (new ResponseFactory())->createResponse(),
        );
        $memberListBody = self::decode($memberList);
        $this->assertSame('own', $memberListBody['access']);
        $this->assertSame([$memberCall['id']], array_column($memberListBody['records'], 'id'));

        $ownerHidden = self::$controller->mobileCallRecord(
            $this->request('GET', '/api/aokie-companion/mobile/call-records/' . $ownerCall['id'])
                ->withHeader('Authorization', 'Bearer ' . $memberOauth['accessToken']),
            (new ResponseFactory())->createResponse(),
            ['recordId' => $ownerCall['id']],
        );
        $this->assertSame(404, $ownerHidden->getStatusCode());
        $memberDetail = self::$controller->mobileCallRecord(
            $this->request('GET', '/api/aokie-companion/mobile/call-records/' . $memberCall['id'])
                ->withHeader('Authorization', 'Bearer ' . $memberOauth['accessToken']),
            (new ResponseFactory())->createResponse(),
            ['recordId' => $memberCall['id']],
        );
        $memberDetailBody = self::decode($memberDetail);
        $this->assertSame(200, $memberDetail->getStatusCode(), json_encode($memberDetailBody));
        $this->assertSame([$memberTurn['id']], array_column($memberDetailBody['transcript'], 'id'));
        $this->assertSame([$memberTask['id']], array_column($memberDetailBody['followUps'], 'id'));

        self::$pdo->prepare(
            'DELETE FROM app_role_permissions
             WHERE role_id = ? AND form_id = ? AND permission = ?'
        )->execute([$roleId, $forms['calls'], AppPermissions::VIEW_OWN_RESPONSES]);
        self::$pdo->prepare(
            'INSERT INTO app_role_permissions (id, role_id, form_id, permission) VALUES (?, ?, ?, ?)'
        )->execute([
            'p-' . bin2hex(random_bytes(8)),
            $roleId,
            $forms['calls'],
            AppPermissions::VIEW_ALL_RESPONSES,
        ]);
        $fullList = self::$controller->mobileCallRecords(
            $this->request('GET', '/api/aokie-companion/mobile/call-records')
                ->withHeader('Authorization', 'Bearer ' . $memberOauth['accessToken']),
            (new ResponseFactory())->createResponse(),
        );
        $fullListBody = self::decode($fullList);
        $this->assertSame('full', $fullListBody['access']);
        $this->assertEqualsCanonicalizing(
            [$ownerCall['id'], $memberCall['id']],
            array_column($fullListBody['records'], 'id'),
        );
        self::$pdo->prepare(
            'DELETE FROM app_role_permissions
             WHERE role_id = ? AND form_id = ? AND permission = ?'
        )->execute([$roleId, $forms['calls'], AppPermissions::VIEW_ALL_RESPONSES]);
        $deniedList = self::$controller->mobileCallRecords(
            $this->request('GET', '/api/aokie-companion/mobile/call-records')
                ->withHeader('Authorization', 'Bearer ' . $memberOauth['accessToken']),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(['records' => [], 'access' => 'none'], self::decode($deniedList));
        $deniedDetail = self::$controller->mobileCallRecord(
            $this->request('GET', '/api/aokie-companion/mobile/call-records/' . $memberCall['id'])
                ->withHeader('Authorization', 'Bearer ' . $memberOauth['accessToken']),
            (new ResponseFactory())->createResponse(),
            ['recordId' => $memberCall['id']],
        );
        $this->assertSame(404, $deniedDetail->getStatusCode());
        $this->assertSame('call_record_not_found', self::decode($deniedDetail)['code']);
    }

    public function testRoutingTargetsCurrentMembersAndPushOutboxStaysPrivate(): void
    {
        $ownerSubject = 'offer_owner_' . bin2hex(random_bytes(5));
        $oauth = $this->authorizeCompanion($ownerSubject);
        $ownerAdmission = self::decode($this->mobileAdmission($oauth['accessToken'], $ownerSubject));
        $ownerDevice = $ownerAdmission['device'];
        $rawPushToken = 'fcm-offer-' . bin2hex(random_bytes(24));
        self::$push->registerEndpoint($this->appId, $ownerDevice['id'], 'fcm', [
            'mode' => 'managed',
            'token' => $rawPushToken,
            'environment' => 'production',
        ]);

        $memberId = 'route-' . bin2hex(random_bytes(8));
        $this->extraUsers[] = $memberId;
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'Route Member')")
            ->execute([$memberId, $memberId . '@aokie.test']);
        $role = self::$pdo->prepare("SELECT id FROM app_roles WHERE app_id = ? AND name = 'Member'");
        $role->execute([$this->appId]);
        $roleId = (string) $role->fetchColumn();
        self::$pdo->prepare(
            'INSERT INTO app_role_permissions (id, role_id, form_id, permission) VALUES (?, ?, NULL, ?)'
        )->execute(['p-' . bin2hex(random_bytes(8)), $roleId, AppPermissions::AOKIE_COMPANION_STATE]);
        $appUserId = 'au-' . bin2hex(random_bytes(8));
        self::$pdo->prepare(
            "INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at)
             VALUES (?, ?, ?, ?, 'active', NOW())"
        )->execute([$appUserId, $this->appId, $memberId, $roleId]);
        $service = new AokieCompanionDeviceService(self::$mysql);
        $memberSubject = 'route_device_' . bin2hex(random_bytes(4));
        $memberDevice = $service->enrollOrTouch(
            $memberId,
            $this->appId,
            $memberSubject,
            'mobile',
            'Route Member',
            ['state_read', 'takeover'],
            ['holderKeyThumbprint' => $this->mobileHolder($memberSubject)],
        );
        $group = $service->saveRoutingGroup($this->userId, $this->appId, [
            'name' => 'Offer Group',
            'policy' => 'all',
            'members' => [
                ['deviceId' => $ownerDevice['id'], 'priority' => 10],
                ['deviceId' => $memberDevice['id'], 'priority' => 20],
            ],
        ]);
        $withoutCurrentPermission = $service->resolveRoutingGroup($this->appId, $group['id'], 'takeover');
        $this->assertSame([$ownerDevice['id']], array_column($withoutCurrentPermission['members'], 'deviceId'));
        self::$pdo->prepare(
            'INSERT INTO app_role_permissions (id, role_id, form_id, permission) VALUES (?, ?, NULL, ?)'
        )->execute(['p-' . bin2hex(random_bytes(8)), $roleId, AppPermissions::AOKIE_COMPANION_TAKEOVER]);
        $withCurrentPermission = $service->resolveRoutingGroup($this->appId, $group['id'], 'takeover');
        $this->assertEqualsCanonicalizing(
            [$ownerDevice['id'], $memberDevice['id']],
            array_column($withCurrentPermission['members'], 'deviceId'),
        );
        self::$pdo->prepare("UPDATE app_users SET status = 'suspended' WHERE id = ?")->execute([$appUserId]);
        $afterSuspension = $service->resolveRoutingGroup($this->appId, $group['id'], 'takeover');
        $this->assertSame([$ownerDevice['id']], array_column($afterSuspension['members'], 'deviceId'));

        $invitationId = 'inv_' . bin2hex(random_bytes(8));
        $collapseId = 'collapse_' . bin2hex(random_bytes(6));
        $expiresAt = time() + 120;
        $offer = self::$push->queueOffer(
            $this->appId,
            $group['id'],
            'takeover_offer',
            $invitationId,
            $collapseId,
            $expiresAt,
            $afterSuspension['members'],
        );
        $this->assertFalse($offer['idempotentReplay']);
        $this->assertSame(
            ['kind', 'invitationId', 'expiresAt', 'collapseId'],
            array_keys($offer['payload']),
        );
        $offerJson = json_encode($offer, JSON_THROW_ON_ERROR);
        $this->assertStringNotContainsString($rawPushToken, $offerJson);
        $this->assertStringNotContainsString('phone', strtolower($offerJson));
        $replay = self::$push->queueOffer(
            $this->appId,
            $group['id'],
            'takeover_offer',
            $invitationId,
            $collapseId,
            $expiresAt,
            $afterSuspension['members'],
        );
        $this->assertTrue($replay['idempotentReplay']);
        $this->expectException(\DomainException::class);
        try {
            self::$push->queueOffer(
                $this->appId,
                $group['id'],
                'takeover_offer',
                $invitationId,
                'different_' . bin2hex(random_bytes(5)),
                $expiresAt,
                $afterSuspension['members'],
            );
        } finally {
            $claimed = self::$push->claimPending();
            $this->assertCount(1, $claimed);
            $this->assertSame($rawPushToken, $claimed[0]['credential']);
            $this->assertEqualsCanonicalizing(
                ['kind', 'invitationId', 'expiresAt', 'collapseId'],
                array_keys($claimed[0]['payload']),
            );
            $this->assertTrue(self::$push->completeDelivery($claimed[0]['deliveryId'], false));
            $retried = self::$push->claimPending();
            $this->assertCount(1, $retried);
            $this->assertSame($claimed[0]['deliveryId'], $retried[0]['deliveryId']);
            $this->assertTrue(self::$push->completeDelivery($retried[0]['deliveryId'], false, null, true));
            $endpoints = self::$push->listForDevice($this->appId, $ownerDevice['id']);
            $this->assertNotNull($endpoints[0]['invalidatedAt']);
        }
    }

    public function testActivityIsIdempotentAndRoutingPoliciesAreDeterministicWithoutMediaPersistence(): void
    {
        $deviceId = 'activity_device_' . bin2hex(random_bytes(4));
        $oauth = $this->authorizeCompanion($deviceId);
        $admission = self::decode($this->mobileAdmission($oauth['accessToken'], $deviceId));
        $firstDevice = $admission['device'];
        $event = [
            'appId' => $this->appId,
            'deviceId' => $deviceId,
            'eventId' => 'evt_' . bin2hex(random_bytes(8)),
            'eventType' => 'monitor_joined',
            'sessionId' => 'session_' . bin2hex(random_bytes(6)),
            'callId' => 'call_' . bin2hex(random_bytes(6)),
            'ownerEpoch' => 7,
            'occurredAt' => time(),
            // Unknown media fields are neither accepted into a metadata blob nor persisted.
            'sdp' => 'secret-session-description',
            'iceCandidate' => 'secret-candidate',
        ];
        $request = $this->request('POST', '/api/aokie-companion/activity')
            ->withHeader('Authorization', 'Bearer ' . $oauth['accessToken'])
            ->withParsedBody($event);
        $rejected = self::$controller->mobileActivity($request, (new ResponseFactory())->createResponse());
        $this->assertSame(400, $rejected->getStatusCode());
        $this->assertSame('invalid_activity', self::decode($rejected)['code']);
        unset($event['sdp'], $event['iceCandidate']);
        $request = $request->withParsedBody($event);
        $created = self::$controller->mobileActivity($request, (new ResponseFactory())->createResponse());
        $this->assertSame(201, $created->getStatusCode(), (string) $created->getBody());
        $replay = self::$controller->mobileActivity($request, (new ResponseFactory())->createResponse());
        $this->assertTrue(self::decode($replay)['activity']['idempotentReplay']);
        $conflict = self::$controller->mobileActivity(
            $request->withParsedBody($event + ['reason' => 'changed']),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(400, $conflict->getStatusCode());

        $service = new AokieCompanionDeviceService(self::$mysql);
        $secondSubject = 'second_mobile_' . bin2hex(random_bytes(4));
        $second = $service->enrollOrTouch(
            $this->userId,
            $this->appId,
            $secondSubject,
            'mobile',
            'Second Receptionist',
            ['state_read', 'monitor'],
            ['holderKeyThumbprint' => $this->mobileHolder($secondSubject)],
        );
        $group = $service->saveRoutingGroup($this->userId, $this->appId, [
            'name' => 'Reception',
            'policy' => 'round_robin',
            'members' => [
                ['deviceId' => $firstDevice['id'], 'priority' => 10],
                ['deviceId' => $second['id'], 'priority' => 10],
            ],
        ]);
        $one = $service->resolveRoutingGroup($this->appId, $group['id']);
        $two = $service->resolveRoutingGroup($this->appId, $group['id']);
        $three = $service->resolveRoutingGroup($this->appId, $group['id']);
        $this->assertNotSame($one['members'][0]['deviceId'], $two['members'][0]['deviceId']);
        $this->assertSame($one['members'][0]['deviceId'], $three['members'][0]['deviceId']);

        $history = self::$controller->history(
            $this->request('GET', '/api/aokie-companion/history')
                ->withQueryParams(['appId' => $this->appId]),
            (new ResponseFactory())->createResponse(),
        );
        $historyJson = json_encode(self::decode($history), JSON_THROW_ON_ERROR);
        $this->assertStringNotContainsString('secret-session-description', $historyJson);
        $this->assertStringNotContainsString('secret-candidate', $historyJson);
        $activityTypes = array_column(self::decode($history)['activity'], 'eventType');
        $this->assertContains('admission_issued', $activityTypes);
        $this->assertContains('monitor_joined', $activityTypes);
        $this->assertCount(1, self::decode($history)['sessions']);

        $revoked = self::$controller->revokeDevice(
            $this->request('DELETE', '/api/aokie-companion/devices/' . $firstDevice['id']),
            (new ResponseFactory())->createResponse(),
            ['id' => $firstDevice['id']],
        );
        $this->assertSame(200, $revoked->getStatusCode());
        $state = self::$pdo->prepare('SELECT state FROM aokie_companion_sessions WHERE app_id = ?');
        $state->execute([$this->appId]);
        $this->assertSame('revoked', $state->fetchColumn());
    }

    public function testMissingConsentAndExpiredTurnCredentialsFailClosed(): void
    {
        $app = self::$apps->getApp($this->appId);
        $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
        unset($settings['aokieCompanion']);
        self::$apps->updateApp($this->appId, ['settings' => $settings]);
        $discovery = self::$controller->appDiscovery(
            $this->request('GET', '/api/app/' . $this->appSlug . '/aokie-discovery'),
            (new ResponseFactory())->createResponse(),
            ['slug' => $this->appSlug],
        );
        $document = self::decode($discovery);
        $this->assertFalse($document['remoteConsent']['configured']);
        $this->assertFalse($document['remoteConsent']['remoteConsult']);
        $this->assertSame(['state'], $document['features']);

        $deviceId = 'closed_device_' . bin2hex(random_bytes(4));
        $oauth = $this->authorizeCompanion($deviceId);
        $admission = self::decode($this->mobileAdmission($oauth['accessToken'], $deviceId));
        $this->assertSame([
            'state_read',
            'caller_read',
            'participants_read',
            'participant_identity_read',
            'audio_levels_read',
        ], $admission['scopes']);

        self::setEnvironment('AOKIE_COMPANION_ICE_SERVERS_JSON', json_encode([[
            'urls' => ['turns:turn.example.test:5349?transport=tcp'],
            'username' => 'expired-user',
            'credential' => 'expired-secret',
            'expiresAt' => time() - 1,
        ]], JSON_UNESCAPED_SLASHES));
        try {
            $expired = self::$controller->discovery(
                $this->request('GET', '/.well-known/aokie-companion'),
                (new ResponseFactory())->createResponse(),
            );
            $this->assertSame(503, $expired->getStatusCode());
            $this->assertSame('ice_configuration_invalid', self::decode($expired)['code']);
        } finally {
            self::setEnvironment('AOKIE_COMPANION_ICE_SERVERS_JSON', json_encode([[
                'urls' => ['turns:turn.example.test:5349?transport=tcp'],
                'username' => 'temporary-user',
                'credential' => 'temporary-secret',
                'expiresAt' => time() + 3600,
            ]], JSON_UNESCAPED_SLASHES));
        }
    }
}
