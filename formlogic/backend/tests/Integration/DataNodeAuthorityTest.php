<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\DataNodeController;
use FormLogic\Services\AccountBackupService;
use FormLogic\Services\DataAccountBackupService;
use FormLogic\Services\DataCloudSigner;
use FormLogic\Services\DataNodeService;
use FormLogic\Services\DataSnapshotService;
use FormLogic\Support\DataCanonicalJson;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;

/**
 * Review FL-001/FL-002 — the ACTUAL authority boundary of the data-node
 * surface, exercised through the controller:
 *
 *  - data-plane operations (snapshot build/download/delete, whole-account
 *    backup) require the API key to resolve to an APPROVED node with an
 *    unexpired owner-signed certificate; unregistered, pending, revoked,
 *    expired, wrong-user, and relay-only keys all receive the SAME 403;
 *  - the enrolment tier (register/self/signing-key/eligible-forms) stays
 *    reachable so a desktop can enrol before approval;
 *  - staged artifacts are owner-bound: a leaked ID reads/deletes as 404 for
 *    anyone else;
 *  - the account-backup transfer key must be signed by the enrolled node key
 *    (an approved node cannot substitute an attacker's ephemeral key).
 */
final class DataNodeAuthorityTest extends E2eeTestCase
{
    private static DataNodeService $nodes;
    private static DataCloudSigner $signer;
    private static DataSnapshotService $snapshots;
    private static DataAccountBackupService $accountBackups;
    private static DataNodeController $controller;

    public static function setUpBeforeClass(): void
    {
        parent::setUpBeforeClass();
        if (self::$mysql === null) {
            return;
        }
        self::$nodes = new DataNodeService(self::$mysql);
        self::$signer = new DataCloudSigner(self::$tmpRoot . '/keys/data-cloud-signing.key');
        self::$snapshots = new DataSnapshotService(self::$mysql, self::$sqlite, self::$signer, self::$tmpRoot . '/data-snapshots');
        $backups = new AccountBackupService(
            self::$mysql,
            self::$sqlite,
            self::$forms,
            self::$apps,
            self::$appUsers,
            self::$flows,
            self::$responses,
            [],
            self::$tmpRoot . '/sqlite',
            self::$uploadsPath,
        );
        self::$accountBackups = new DataAccountBackupService($backups, self::$signer, self::$tmpRoot . '/data-snapshots', self::$mysql);
        self::$controller = new DataNodeController(
            self::$snapshots,
            self::$signer,
            self::$accountBackups,
            self::$nodes,
            true,
        );
    }

    // ── request plumbing ─────────────────────────────────────────────────────

    /** @param list<string> $scopes */
    private function request(string $userId, string $apiKeyId, array $scopes, ?array $body = null): ServerRequestInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/v1/data-node/test')
            ->withAttribute('userId', $userId)
            ->withAttribute('apiKeyId', $apiKeyId)
            ->withAttribute('apiKeyScopes', $scopes);
        if ($body !== null) {
            $request = $request->withBody((new StreamFactory())->createStream((string) json_encode($body)));
        }
        return $request;
    }

    private function response(): ResponseInterface
    {
        return (new ResponseFactory())->createResponse();
    }

    /** @return array<string,mixed> */
    private function decode(ResponseInterface $response): array
    {
        return (array) json_decode((string) $response->getBody(), true);
    }

    // ── fixtures ─────────────────────────────────────────────────────────────

    /** @return array{apiKeyId: string, connectionId: string} */
    private function makeConnection(?string $userId = null): array
    {
        $apiKeyId = 'ak-' . bin2hex(random_bytes(8));
        $connectionId = 'dc-' . bin2hex(random_bytes(8));
        self::$pdo->prepare(
            'INSERT INTO desktop_connections (id, owner_user_id, device_name, desktop_instance_id, api_key_id)
             VALUES (?, ?, "Test Desktop", ?, ?)'
        )->execute([$connectionId, $userId ?? $this->userId, 'inst-' . bin2hex(random_bytes(6)), $apiKeyId]);
        return ['apiKeyId' => $apiKeyId, 'connectionId' => $connectionId];
    }

    /**
     * Register + owner-approve a node for this user's connection.
     *
     * @return array{node: array<string,mixed>, apiKeyId: string, signSk: string, vault: array<string,mixed>}
     */
    private function makeApprovedNode(?string $userId = null, ?string $expiresAt = null, ?array $vault = null): array
    {
        $userId ??= $this->userId;
        $vault ??= $this->makeVault($userId);
        $conn = $this->makeConnection($userId);
        $pair = sodium_crypto_sign_keypair();
        $node = self::$nodes->register($userId, $conn['apiKeyId'], [
            'signingPublicKey' => base64_encode(sodium_crypto_sign_publickey($pair)),
        ]);
        $edPkRaw = base64_decode($vault['ed25519PkB64']);
        $cert = [
            'protocol' => 'formlogic-data-sync/1',
            'kind' => 'node-authority',
            'nodeId' => $node['id'],
            'connectionId' => $node['connectionId'],
            'ownerUserId' => $userId,
            'signingKeyId' => $node['signingKeyId'],
            'signingKeyGeneration' => $node['signingKeyGeneration'],
            'signingPublicKey' => $node['signingPublicKey'],
            'fingerprint' => $node['fingerprint'],
            'capabilities' => ['storage'],
            'issuedAt' => gmdate('Y-m-d\TH:i:s\Z'),
            'expiresAt' => $expiresAt,
            'ownerSignerKeyId' => DataCanonicalJson::keyId($edPkRaw),
            'ownerSignerFingerprint' => DataCanonicalJson::fingerprint($edPkRaw),
        ];
        $cert['signature'] = DataCanonicalJson::signB64(DataCanonicalJson::DOMAIN_NODE_CERT, $cert, $vault['ed25519SkRaw']);
        $approved = self::$nodes->approve($userId, (string) $node['id'], $cert, $edPkRaw);
        return [
            'node' => $approved,
            'apiKeyId' => $conn['apiKeyId'],
            'signSk' => sodium_crypto_sign_secretkey($pair),
            'vault' => $vault,
        ];
    }

    private function cleanupNodes(): void
    {
        self::$pdo->prepare('DELETE FROM data_nodes WHERE owner_user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM desktop_connections WHERE owner_user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM data_staged_artifacts WHERE owner_user_id = ?')->execute([$this->userId]);
    }

    /** Every data-plane call for the given identity; keyed for failure messages. */
    private function dataPlaneResponses(string $userId, string $apiKeyId, array $scopes): array
    {
        $c = self::$controller;
        return [
            'createSnapshot' => $c->createSnapshot($this->request($userId, $apiKeyId, $scopes, ['formId' => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']), $this->response()),
            'snapshotFile' => $c->snapshotFile($this->request($userId, $apiKeyId, $scopes), $this->response(), ['id' => str_repeat('a', 32)]),
            'deleteSnapshot' => $c->deleteSnapshot($this->request($userId, $apiKeyId, $scopes), $this->response(), ['id' => str_repeat('a', 32)]),
            'createAccountBackup' => $c->createAccountBackup($this->request($userId, $apiKeyId, $scopes, ['ephemeralPk' => base64_encode(random_bytes(32))]), $this->response()),
            'accountBackupPayload' => $c->accountBackupPayload($this->request($userId, $apiKeyId, $scopes), $this->response(), ['id' => 'acct-' . str_repeat('a', 32)]),
            'deleteAccountBackup' => $c->deleteAccountBackup($this->request($userId, $apiKeyId, $scopes), $this->response(), ['id' => 'acct-' . str_repeat('a', 32)]),
        ];
    }

    // ── tests ────────────────────────────────────────────────────────────────

    public function testDataPlaneRefusesUniformlyWithoutApprovedNode(): void
    {
        $conn = $this->makeConnection();

        // Unregistered (key with NO node) — including the legacy relay scope:
        // connector:relay alone must never authorize data export.
        foreach ([['connector:relay'], ['data:snapshot']] as $scopes) {
            foreach ($this->dataPlaneResponses($this->userId, $conn['apiKeyId'], $scopes) as $op => $res) {
                self::assertSame(403, $res->getStatusCode(), $op);
                self::assertSame('data_node_unauthorized', $this->decode($res)['code'] ?? null, $op);
            }
        }

        // Pending node: registered but not approved.
        $pair = sodium_crypto_sign_keypair();
        self::$nodes->register($this->userId, $conn['apiKeyId'], [
            'signingPublicKey' => base64_encode(sodium_crypto_sign_publickey($pair)),
        ]);
        foreach ($this->dataPlaneResponses($this->userId, $conn['apiKeyId'], ['data:snapshot']) as $op => $res) {
            self::assertSame(403, $res->getStatusCode(), "pending: {$op}");
            self::assertSame('data_node_unauthorized', $this->decode($res)['code'] ?? null, "pending: {$op}");
        }

        // The ENROLMENT tier stays reachable for that same pending key.
        $self = self::$controller->self($this->request($this->userId, $conn['apiKeyId'], ['connector:relay']), $this->response());
        self::assertSame(200, $self->getStatusCode());
        $signing = self::$controller->signingKey($this->request($this->userId, $conn['apiKeyId'], ['connector:relay']), $this->response());
        self::assertSame(200, $signing->getStatusCode());

        $this->cleanupNodes();
    }

    public function testRevokedExpiredAndForeignNodesAreRefused(): void
    {
        // Approved node works…
        $form = $this->makeDraftForm();
        ['vault' => $vault] = $this->enablePrivateForm((string) $form['id']);
        $approved = $this->makeApprovedNode(null, null, $vault);
        $created = self::$controller->createSnapshot(
            $this->request($this->userId, $approved['apiKeyId'], ['data:snapshot'], ['formId' => (string) $form['id']]),
            $this->response(),
        );
        self::assertSame(201, $created->getStatusCode());
        $snapshotId = (string) ($this->decode($created)['data']['snapshotId'] ?? '');
        self::assertNotSame('', $snapshotId);

        // …and the legacy relay scope still works WITH the approved node
        // (documented migration posture — the node binding is the authority).
        $file = self::$controller->snapshotFile(
            $this->request($this->userId, $approved['apiKeyId'], ['connector:relay'])
                ->withQueryParams(['path' => 'backup-index.json']),
            $this->response(),
            ['id' => $snapshotId],
        );
        self::assertSame(200, $file->getStatusCode());

        // A neither-scope key fails the scope tier, not the node tier.
        $noScope = self::$controller->createSnapshot(
            $this->request($this->userId, $approved['apiKeyId'], [], ['formId' => (string) $form['id']]),
            $this->response(),
        );
        self::assertSame(403, $noScope->getStatusCode());
        self::assertSame('insufficient_scope', $this->decode($noScope)['code'] ?? null);

        // Another user's key + own approved node cannot see this snapshot:
        // uniform 404 (leaked-ID case, review FL-002), and the denied delete
        // leaves the artifact fully intact.
        $stranger = $this->makeUser();
        $strangerNode = $this->makeApprovedNode($stranger);
        $foreignRead = self::$controller->snapshotFile(
            $this->request($stranger, $strangerNode['apiKeyId'], ['data:snapshot'])
                ->withQueryParams(['path' => 'backup-index.json']),
            $this->response(),
            ['id' => $snapshotId],
        );
        self::assertSame(404, $foreignRead->getStatusCode());
        $foreignDelete = self::$controller->deleteSnapshot(
            $this->request($stranger, $strangerNode['apiKeyId'], ['data:snapshot']),
            $this->response(),
            ['id' => $snapshotId],
        );
        self::assertSame(404, $foreignDelete->getStatusCode());
        $stillThere = self::$controller->snapshotFile(
            $this->request($this->userId, $approved['apiKeyId'], ['data:snapshot'])
                ->withQueryParams(['path' => 'backup-index.json']),
            $this->response(),
            ['id' => $snapshotId],
        );
        self::assertSame(200, $stillThere->getStatusCode(), 'denied foreign delete must leave the artifact intact');

        // Time-controlled expiry: shrink the stored certificate window to the
        // past — access stops immediately and uniformly.
        self::$pdo->prepare('UPDATE data_nodes SET certificate_expires_at = ? WHERE id = ?')
            ->execute([gmdate('Y-m-d H:i:s', time() - 60), $approved['node']['id']]);
        foreach ($this->dataPlaneResponses($this->userId, $approved['apiKeyId'], ['data:snapshot']) as $op => $res) {
            self::assertSame(403, $res->getStatusCode(), "expired: {$op}");
            self::assertSame('data_node_unauthorized', $this->decode($res)['code'] ?? null, "expired: {$op}");
        }
        self::$pdo->prepare('UPDATE data_nodes SET certificate_expires_at = NULL WHERE id = ?')
            ->execute([$approved['node']['id']]);

        // Revocation stops access immediately and uniformly.
        self::$nodes->revoke($this->userId, (string) $approved['node']['id']);
        foreach ($this->dataPlaneResponses($this->userId, $approved['apiKeyId'], ['data:snapshot']) as $op => $res) {
            self::assertSame(403, $res->getStatusCode(), "revoked: {$op}");
            self::assertSame('data_node_unauthorized', $this->decode($res)['code'] ?? null, "revoked: {$op}");
        }

        self::$pdo->prepare('DELETE FROM data_nodes WHERE owner_user_id = ?')->execute([$stranger]);
        self::$pdo->prepare('DELETE FROM desktop_connections WHERE owner_user_id = ?')->execute([$stranger]);
        self::$pdo->prepare('DELETE FROM user_vaults WHERE user_id = ?')->execute([$stranger]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$stranger]);
        $this->cleanupNodes();
    }

    public function testAccountBackupKeyMustBeSignedByTheEnrolledNode(): void
    {
        $approved = $this->makeApprovedNode();
        $epkB64 = base64_encode(sodium_crypto_box_publickey(sodium_crypto_box_keypair()));

        // An approved node submitting a BARE ephemeral key is refused: the
        // transfer key must be provably the node's own.
        $bare = self::$controller->createAccountBackup(
            $this->request($this->userId, $approved['apiKeyId'], ['data:snapshot'], ['ephemeralPk' => $epkB64]),
            $this->response(),
        );
        self::assertSame(403, $bare->getStatusCode());
        self::assertSame('account_backup_key_unbound', $this->decode($bare)['code'] ?? null);

        // A signature by a key OTHER than the enrolled node key is refused.
        $requestedAt = gmdate('Y-m-d\TH:i:s\Z');
        $foreignPair = sodium_crypto_sign_keypair();
        $foreignSig = sodium_crypto_sign_detached(
            DataAccountBackupService::REQUEST_SIGNATURE_DOMAIN . '|' . $requestedAt . '|' . $epkB64,
            sodium_crypto_sign_secretkey($foreignPair),
        );
        $forged = self::$controller->createAccountBackup(
            $this->request($this->userId, $approved['apiKeyId'], ['data:snapshot'], [
                'ephemeralPk' => $epkB64,
                'requestedAt' => $requestedAt,
                'ephemeralPkSignature' => base64_encode($foreignSig),
            ]),
            $this->response(),
        );
        self::assertSame(403, $forged->getStatusCode());
        self::assertSame('account_backup_key_unbound', $this->decode($forged)['code'] ?? null);

        // The genuine node-signed challenge succeeds, and the staged payload
        // is owner-bound.
        $sig = sodium_crypto_sign_detached(
            DataAccountBackupService::REQUEST_SIGNATURE_DOMAIN . '|' . $requestedAt . '|' . $epkB64,
            $approved['signSk'],
        );
        $created = self::$controller->createAccountBackup(
            $this->request($this->userId, $approved['apiKeyId'], ['data:snapshot'], [
                'ephemeralPk' => $epkB64,
                'requestedAt' => $requestedAt,
                'ephemeralPkSignature' => base64_encode($sig),
            ]),
            $this->response(),
        );
        self::assertSame(201, $created->getStatusCode());
        $backupId = (string) ($this->decode($created)['data']['backupId'] ?? '');
        self::assertNotSame('', $backupId);

        $stranger = $this->makeUser();
        $strangerNode = $this->makeApprovedNode($stranger);
        $foreign = self::$controller->accountBackupPayload(
            $this->request($stranger, $strangerNode['apiKeyId'], ['data:snapshot']),
            $this->response(),
            ['id' => $backupId],
        );
        self::assertSame(404, $foreign->getStatusCode());
        $own = self::$controller->accountBackupPayload(
            $this->request($this->userId, $approved['apiKeyId'], ['data:snapshot']),
            $this->response(),
            ['id' => $backupId],
        );
        self::assertSame(200, $own->getStatusCode());
        $deleted = self::$controller->deleteAccountBackup(
            $this->request($this->userId, $approved['apiKeyId'], ['data:snapshot']),
            $this->response(),
            ['id' => $backupId],
        );
        self::assertSame(200, $deleted->getStatusCode());

        self::$pdo->prepare('DELETE FROM data_nodes WHERE owner_user_id = ?')->execute([$stranger]);
        self::$pdo->prepare('DELETE FROM desktop_connections WHERE owner_user_id = ?')->execute([$stranger]);
        self::$pdo->prepare('DELETE FROM user_vaults WHERE user_id = ?')->execute([$stranger]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$stranger]);
        $this->cleanupNodes();
    }
}
