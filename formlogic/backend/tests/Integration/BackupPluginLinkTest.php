<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\DataNodeController;
use FormLogic\Controllers\McpOAuthController;
use FormLogic\Middleware\ApiKeyMiddleware;
use FormLogic\Services\AccountBackupService;
use FormLogic\Services\ApiKeyService;
use FormLogic\Services\DataAccountBackupService;
use FormLogic\Services\DataCloudSigner;
use FormLogic\Services\DataNodeService;
use FormLogic\Services\DataSnapshotService;
use FormLogic\Services\McpOAuthService;
use FormLogic\Services\McpTokenService;
use FormLogic\Support\DataCanonicalJson;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;

/**
 * The FormLogic Backups plugin's link: a public native client that gets one scope and a
 * backup_clients row. It stays out of the relay roster, so a computer can hold an OAIY link and
 * a backup link at once without either touching the other, and its key does nothing but backups.
 */
final class BackupPluginLinkTest extends E2eeTestCase
{
    private const BASE = 'http://localhost';
    private const REDIRECT = 'http://127.0.0.1:51777/callback';

    private static DataNodeService $nodes;
    private static McpOAuthController $oauthCtrl;
    private static McpOAuthService $oauth;
    private static ApiKeyService $apiKeys;
    private static DataNodeController $nodeRoutes;

    public static function setUpBeforeClass(): void
    {
        parent::setUpBeforeClass();
        if (self::$mysql === null) {
            return;
        }
        self::$nodes = new DataNodeService(self::$mysql);
        self::$apiKeys = new ApiKeyService(self::$mysql);
        $signer = new DataCloudSigner(self::$tmpRoot . '/keys/data-cloud-signing.key');
        $backups = new AccountBackupService(self::$mysql, self::$sqlite, self::$forms, self::$apps, self::$appUsers, self::$flows, self::$responses, [], self::$tmpRoot . '/sqlite', self::$uploadsPath);
        self::$nodeRoutes = new DataNodeController(
            new DataSnapshotService(self::$mysql, self::$sqlite, $signer, self::$tmpRoot . '/data-snapshots'),
            $signer,
            new DataAccountBackupService($backups, $signer, self::$tmpRoot . '/data-snapshots', self::$mysql),
            self::$nodes,
            true,
            $backups,
        );
        self::$oauth = new McpOAuthService(self::$mysql, new McpTokenService(self::$mysql));
        self::$oauthCtrl = new McpOAuthController(
            self::$oauth,
            self::$apps,
            null,
            null,
            self::$apiKeys,
            self::$flows,
        );
    }

    protected function tearDown(): void
    {
        if (self::$pdo !== null && $this->userId !== '') {
            foreach (['data_nodes' => 'owner_user_id', 'backup_clients' => 'owner_user_id', 'desktop_connections' => 'owner_user_id', 'api_keys' => 'user_id', 'mcp_oauth_codes' => 'user_id'] as $table => $column) {
                self::$pdo->prepare("DELETE FROM {$table} WHERE {$column} = ?")->execute([$this->userId]);
            }
        }
        parent::tearDown();
    }

    private static function decode(ResponseInterface $response): array
    {
        $response->getBody()->rewind();
        return json_decode((string) $response->getBody(), true) ?: [];
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

    private function params(string $challenge, array $over = []): array
    {
        return array_merge([
            'client_id' => McpOAuthService::BACKUP_PLUGIN_CLIENT_ID,
            'redirect_uri' => self::REDIRECT,
            'code_challenge' => $challenge,
            'code_challenge_method' => 'S256',
            'state' => 'st-' . bin2hex(random_bytes(6)),
            'device' => 'Office PC',
        ], $over);
    }

    private function approve(array $params): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/oauth/approve')
            ->withHeader('Content-Type', 'application/json')
            ->withParsedBody($params)
            ->withAttribute('userId', $this->userId);
        $response = self::$oauthCtrl->approve($request, (new ResponseFactory())->createResponse());
        return ['status' => $response->getStatusCode(), 'body' => self::decode($response)];
    }

    private function token(array $form): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/oauth/token')
            ->withHeader('Content-Type', 'application/x-www-form-urlencoded')
            ->withBody((new StreamFactory())->createStream(http_build_query($form)));
        $response = self::$oauthCtrl->token($request, (new ResponseFactory())->createResponse());
        return ['status' => $response->getStatusCode(), 'body' => self::decode($response)];
    }

    /** Runs the whole link: consent, one-time code, token. */
    private function link(): array
    {
        $pkce = $this->pkce();
        $approved = $this->approve($this->params($pkce['challenge']));
        self::assertSame(200, $approved['status'], json_encode($approved['body']));
        parse_str((string) parse_url((string) $approved['body']['redirectTo'], PHP_URL_QUERY), $query);
        $token = $this->token([
            'grant_type' => 'authorization_code',
            'code' => $query['code'],
            'redirect_uri' => self::REDIRECT,
            'client_id' => McpOAuthService::BACKUP_PLUGIN_CLIENT_ID,
            'code_verifier' => $pkce['verifier'],
        ]);
        self::assertSame(200, $token['status'], json_encode($token['body']));
        return $token['body'];
    }

    private function registerBackupNode(array $linked): array
    {
        return self::$nodes->register($this->userId, $linked['api_key_id'], [
            'signingPublicKey' => base64_encode(sodium_crypto_sign_publickey(sodium_crypto_sign_keypair())),
            'displayName' => 'FormLogic Backups on Office PC',
            'capabilities' => ['storage'],
        ]);
    }

    private function signedCert(array $node, array $vault): array
    {
        $edPkRaw = base64_decode($vault['ed25519PkB64']);
        $cert = [
            'protocol' => 'formlogic-data-sync/1',
            'kind' => 'node-authority',
            'nodeId' => $node['id'],
            'connectionId' => $node['connectionId'],
            'ownerUserId' => $this->userId,
            'signingKeyId' => $node['signingKeyId'],
            'signingKeyGeneration' => $node['signingKeyGeneration'],
            'signingPublicKey' => $node['signingPublicKey'],
            'fingerprint' => $node['fingerprint'],
            'capabilities' => ['storage'],
            'issuedAt' => gmdate('Y-m-d\TH:i:s\Z'),
            'expiresAt' => null,
            'ownerSignerKeyId' => DataCanonicalJson::keyId($edPkRaw),
            'ownerSignerFingerprint' => DataCanonicalJson::fingerprint($edPkRaw),
        ];
        $cert['signature'] = DataCanonicalJson::signB64(DataCanonicalJson::DOMAIN_NODE_CERT, $cert, $vault['ed25519SkRaw']);
        return $cert;
    }

    private function approveNode(array $node): array
    {
        $vault = $this->makeVault($this->userId);
        return self::$nodes->approve($this->userId, $node['id'], $this->signedCert($node, $vault), base64_decode($vault['ed25519PkB64']));
    }

    private function keyIsActive(string $apiKeyId): bool
    {
        $stmt = self::$pdo->prepare('SELECT is_active FROM api_keys WHERE id = ?');
        $stmt->execute([$apiKeyId]);
        return (int) $stmt->fetchColumn() === 1;
    }

    private function rows(string $sql, array $args): int
    {
        $stmt = self::$pdo->prepare($sql);
        $stmt->execute($args);
        return (int) $stmt->fetchColumn();
    }

    public function testConsentOffersOneScopeAndSaysItIsABackupLink(): void
    {
        $request = (new ServerRequestFactory())->createServerRequest('GET', self::BASE . '/api/oauth/authorize-info')
            ->withQueryParams($this->params($this->pkce()['challenge']));
        $info = self::decode(self::$oauthCtrl->authorizeInfo($request, (new ResponseFactory())->createResponse()));

        self::assertSame(['data:snapshot'], $info['scopes']);
        self::assertTrue($info['isBackupLink']);
        self::assertFalse($info['isDesktopLink']);
        self::assertSame('Office PC', $info['device']);
    }

    public function testNoOtherScopeCanBeAskedFor(): void
    {
        $request = (new ServerRequestFactory())->createServerRequest('GET', self::BASE . '/api/oauth/authorize-info')
            ->withQueryParams($this->params($this->pkce()['challenge'], ['scope' => 'connector:relay flows:write']));
        $response = self::$oauthCtrl->authorizeInfo($request, (new ResponseFactory())->createResponse());

        self::assertSame(400, $response->getStatusCode());
        self::assertSame('invalid_scope', self::decode($response)['error']);
    }

    public function testALinkCannotBeLimitedToOneApp(): void
    {
        $app = self::$apps->createApp(['name' => 'Bookings'], $this->userId);

        $refused = $this->approve($this->params($this->pkce()['challenge'], ['appId' => $app['id']]));

        self::assertSame(400, $refused['status']);
        self::assertStringContainsString('cannot be limited', $refused['body']['error_description']);
    }

    public function testAGrantCarryingAnAppLimitMintsNothing(): void
    {
        $pkce = $this->pkce();
        $app = self::$apps->createApp(['name' => 'Bookings'], $this->userId);
        $code = self::$oauth->mintCode($this->userId, McpOAuthService::BACKUP_PLUGIN_CLIENT_ID, self::REDIRECT, ['data:snapshot'], $pkce['challenge'], McpOAuthService::resourceFor((new ServerRequestFactory())->createServerRequest('GET', self::BASE . '/')), $app['id'], 'Office PC');

        $token = $this->token([
            'grant_type' => 'authorization_code',
            'code' => $code,
            'redirect_uri' => self::REDIRECT,
            'client_id' => McpOAuthService::BACKUP_PLUGIN_CLIENT_ID,
            'code_verifier' => $pkce['verifier'],
        ]);

        self::assertSame(400, $token['status'], json_encode($token['body']));
        self::assertSame('invalid_grant', $token['body']['error']);
        self::assertSame(0, $this->rows('SELECT COUNT(*) FROM backup_clients WHERE owner_user_id = ?', [$this->userId]));
    }

    public function testTheKeyHoldsOneScopeAndIsNotADesktopConnection(): void
    {
        $linked = $this->link();

        self::assertSame('data:snapshot', $linked['scope']);
        self::assertSame($this->userId, $linked['account_id']);
        self::assertSame(1, $this->rows('SELECT COUNT(*) FROM backup_clients WHERE owner_user_id = ?', [$this->userId]));
        self::assertSame(0, $this->rows('SELECT COUNT(*) FROM desktop_connections WHERE owner_user_id = ?', [$this->userId]));
        $key = self::$apiKeys->validateKey($linked['formlogic_api_key']);
        self::assertSame(['data:snapshot'], $key['scopes']);
        self::assertStringContainsString('FormLogic Backups on Office PC', (string) $key['name']);
    }

    public function testTheKeyCannotBeUsedAsARelay(): void
    {
        $linked = $this->link();
        $middleware = new ApiKeyMiddleware(self::$apiKeys, ['connector:relay']);
        $request = (new ServerRequestFactory())->createServerRequest('GET', self::BASE . '/api/v1/desktop/commands')
            ->withHeader('Authorization', 'Bearer ' . $linked['formlogic_api_key']);
        $handler = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                return (new ResponseFactory())->createResponse(200);
            }
        };

        self::assertSame(403, $middleware->process($request, $handler)->getStatusCode());
    }

    public function testADesktopAndABackupLinkLiveSideBySide(): void
    {
        $desktopKey = self::$apiKeys->createKey($this->userId, 'OAIY Desktop on Office PC', ['connector:relay']);
        $connection = self::$flows->createOAuthDesktopConnection($this->userId, 'Office PC', $desktopKey['id'], 'OAIY Desktop');
        $desktopNode = self::$nodes->register($this->userId, $desktopKey['id'], [
            'signingPublicKey' => base64_encode(sodium_crypto_sign_publickey(sodium_crypto_sign_keypair())),
        ]);

        $linked = $this->link();
        $backupNode = $this->registerBackupNode($linked);

        // One computer in the desktop list, two nodes under Data nodes, each with its own kind.
        self::assertSame(1, $this->rows('SELECT COUNT(*) FROM desktop_connections WHERE owner_user_id = ?', [$this->userId]));
        self::assertSame('desktop', $desktopNode['kind']);
        self::assertSame($connection['id'], $desktopNode['connectionId']);
        self::assertSame('backup', $backupNode['kind']);
        self::assertSame($linked['backup_client_id'], $backupNode['connectionId']);
        self::assertCount(2, self::$nodes->listForOwner($this->userId));

        // Revoking the backup node leaves the desktop's key and node exactly as they were.
        self::$nodes->revoke($this->userId, $backupNode['id']);
        self::assertTrue($this->keyIsActive($desktopKey['id']));
        self::assertSame('pending', self::$nodes->selfForConnection($this->userId, $desktopKey['id'])['status']);
    }

    public function testAnApprovedBackupNodeResolvesAndAPendingOneDoesNot(): void
    {
        $linked = $this->link();
        $node = $this->registerBackupNode($linked);
        self::assertSame('pending', $node['status']);
        try {
            self::$nodes->resolveApprovedNode($this->userId, $linked['api_key_id']);
            self::fail('a pending node has no authority');
        } catch (\RuntimeException $e) {
            self::assertSame('data_node_unauthorized', $e->getMessage());
        }

        $approved = $this->approveNode($node);

        self::assertTrue($approved['approved']);
        self::assertSame($node['id'], self::$nodes->resolveApprovedNode($this->userId, $linked['api_key_id'])['id']);
        self::assertSame($node['id'], self::$nodes->selfForConnection($this->userId, $linked['api_key_id'])['id']);
    }

    public function testRegisteringAgainUpdatesTheSameNode(): void
    {
        $linked = $this->link();
        $signing = base64_encode(sodium_crypto_sign_publickey(sodium_crypto_sign_keypair()));
        $first = self::$nodes->register($this->userId, $linked['api_key_id'], ['signingPublicKey' => $signing, 'displayName' => 'One']);
        $second = self::$nodes->register($this->userId, $linked['api_key_id'], ['signingPublicKey' => $signing, 'displayName' => 'Two']);

        self::assertSame($first['id'], $second['id']);
        self::assertSame('Two', $second['displayName']);
    }

    public function testTheScopeCannotBeAskedForInSettings(): void
    {
        $this->expectExceptionMessage('Invalid scope: data:snapshot');
        self::$apiKeys->createKey($this->userId, 'Mine', ['data:snapshot']);
    }

    public function testAKeyThatIsNotLinkedCannotRegister(): void
    {
        $plain = self::$apiKeys->createKey($this->userId, 'Mine', ['forms:read']);

        $this->expectExceptionMessage('data_node_no_connection');
        self::$nodes->register($this->userId, $plain['id'], [
            'signingPublicKey' => base64_encode(sodium_crypto_sign_publickey(sodium_crypto_sign_keypair())),
        ]);
    }

    private function asKey(string $apiKeyId, array $scopes, ?array $body = null): ServerRequestInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/v1/data-node/test')
            ->withAttribute('userId', $this->userId)
            ->withAttribute('apiKeyId', $apiKeyId)
            ->withAttribute('apiKeyScopes', $scopes);
        return $body === null ? $request : $request->withBody((new StreamFactory())->createStream((string) json_encode($body)));
    }

    /** @return array<string, ResponseInterface> every route a backup client has no business on */
    private function desktopRoutes(string $apiKeyId, array $scopes): array
    {
        $routes = self::$nodeRoutes;
        $response = fn () => (new ResponseFactory())->createResponse();
        return [
            'eligible forms' => $routes->eligibleForms($this->asKey($apiKeyId, $scopes), $response()),
            'snapshot' => $routes->createSnapshot($this->asKey($apiKeyId, $scopes, ['formId' => 'abc']), $response()),
            'snapshot file' => $routes->snapshotFile($this->asKey($apiKeyId, $scopes), $response(), ['id' => 'x']),
            'delete snapshot' => $routes->deleteSnapshot($this->asKey($apiKeyId, $scopes), $response(), ['id' => 'x']),
            'account backup' => $routes->createAccountBackup($this->asKey($apiKeyId, $scopes, []), $response()),
        ];
    }

    public function testAnApprovedBackupKeyReachesBackupsAndNothingElseOfADataNode(): void
    {
        $linked = $this->link();
        $node = $this->registerBackupNode($linked);

        foreach ($this->desktopRoutes($linked['api_key_id'], ['data:snapshot']) as $route => $response) {
            self::assertSame(403, $response->getStatusCode(), "pending: {$route}");
        }

        $this->approveNode($node);

        foreach ($this->desktopRoutes($linked['api_key_id'], ['data:snapshot']) as $route => $response) {
            self::assertSame(403, $response->getStatusCode(), "approved: {$route}");
            self::assertSame('data_node_unauthorized', self::decode($response)['code'], $route);
        }
        $sources = self::$nodeRoutes->backupSources($this->asKey($linked['api_key_id'], ['data:snapshot']), (new ResponseFactory())->createResponse());
        self::assertSame(200, $sources->getStatusCode());
    }

    public function testADesktopKeepsItsRoutes(): void
    {
        $desktopKey = self::$apiKeys->createKey($this->userId, 'OAIY Desktop', ['connector:relay']);
        self::$flows->createOAuthDesktopConnection($this->userId, 'Office PC', $desktopKey['id'], 'OAIY Desktop');

        $eligible = self::$nodeRoutes->eligibleForms($this->asKey($desktopKey['id'], ['connector:relay']), (new ResponseFactory())->createResponse());

        self::assertSame(200, $eligible->getStatusCode());
    }

    public function testAnotherAccountCannotResolveTheNode(): void
    {
        $linked = $this->link();
        $this->approveNode($this->registerBackupNode($linked));

        $this->expectExceptionMessage('data_node_unauthorized');
        self::$nodes->resolveApprovedNode($this->makeUser(), $linked['api_key_id']);
    }

    public function testRevokingEndsTheKeyAndRemovingClearsTheRecord(): void
    {
        $linked = $this->link();
        $node = $this->approveNode($this->registerBackupNode($linked));

        self::$nodes->revoke($this->userId, $node['id']);
        self::assertFalse($this->keyIsActive($linked['api_key_id']));

        self::$nodes->forget($this->userId, $node['id']);
        self::assertSame(0, $this->rows('SELECT COUNT(*) FROM backup_clients WHERE owner_user_id = ?', [$this->userId]));
        self::assertSame(0, $this->rows('SELECT COUNT(*) FROM data_nodes WHERE owner_user_id = ?', [$this->userId]));
    }

    public function testThePluginCanEndItsOwnLink(): void
    {
        $linked = $this->link();
        $node = $this->approveNode($this->registerBackupNode($linked));

        self::assertTrue(self::$nodes->unlinkBackupClient($this->userId, $linked['api_key_id']));

        self::assertFalse($this->keyIsActive($linked['api_key_id']));
        self::assertSame('revoked', self::$nodes->listForOwner($this->userId)[0]['status']);
        self::assertSame($node['id'], self::$nodes->listForOwner($this->userId)[0]['id']);
    }

    public function testEndingALinkThatNeverRegisteredLeavesNothingBehind(): void
    {
        $linked = $this->link();

        self::assertTrue(self::$nodes->unlinkBackupClient($this->userId, $linked['api_key_id']));

        self::assertFalse($this->keyIsActive($linked['api_key_id']));
        self::assertSame(0, $this->rows('SELECT COUNT(*) FROM backup_clients WHERE owner_user_id = ?', [$this->userId]));
    }

    public function testADesktopKeyCannotUseTheUnlinkRoute(): void
    {
        $desktopKey = self::$apiKeys->createKey($this->userId, 'OAIY Desktop', ['connector:relay']);
        self::$flows->createOAuthDesktopConnection($this->userId, 'Office PC', $desktopKey['id'], 'OAIY Desktop');

        self::assertFalse(self::$nodes->unlinkBackupClient($this->userId, $desktopKey['id']));
        self::assertTrue($this->keyIsActive($desktopKey['id']));
    }

    public function testAFailedLinkLeavesNoActiveKey(): void
    {
        // Too long for its column, so the row can't be written after the key has been.
        try {
            self::$apiKeys->createBackupClient($this->userId, str_repeat('x', 200));
            self::fail('the link should fail');
        } catch (\PDOException) {
        }

        self::assertSame(0, $this->rows('SELECT COUNT(*) FROM api_keys WHERE user_id = ? AND is_active = 1', [$this->userId]));
    }
}
