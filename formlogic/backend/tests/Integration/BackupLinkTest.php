<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\BackupLinkController;
use FormLogic\Services\ApiKeyService;
use FormLogic\Services\BackupLinkService;
use FormLogic\Services\DataNodeService;
use FormLogic\Services\DesktopCommandService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;

/**
 * Setting up the FormLogic Backups plugin through a computer's link: the owner sends a one-time
 * code through the relay, and the plugin swaps it for a backup-only key of its own. The code has
 * to be for the owner's own online computer, works once and runs out, and the key it gives is the
 * same narrow key the OAuth sign-in gives.
 */
final class BackupLinkTest extends E2eeTestCase
{
    private const SERVER = 'https://forms.example.test';

    private static BackupLinkService $links;
    private static DesktopCommandService $commands;
    private static ApiKeyService $apiKeys;
    private static DataNodeService $nodes;

    public static function setUpBeforeClass(): void
    {
        parent::setUpBeforeClass();
        if (self::$mysql === null) {
            return;
        }
        self::$commands = new DesktopCommandService(self::$mysql);
        self::$apiKeys = new ApiKeyService(self::$mysql);
        self::$nodes = new DataNodeService(self::$mysql);
        self::$links = new BackupLinkService(self::$mysql, self::$commands, self::$apiKeys);
    }

    protected function tearDown(): void
    {
        if (self::$pdo !== null && $this->userId !== '') {
            foreach (['data_nodes' => 'owner_user_id', 'backup_link_codes' => 'owner_user_id', 'backup_clients' => 'owner_user_id', 'desktop_commands' => 'owner_user_id', 'desktop_connections' => 'owner_user_id', 'api_keys' => 'user_id'] as $table => $column) {
                self::$pdo->prepare("DELETE FROM {$table} WHERE {$column} = ?")->execute([$this->userId]);
            }
        }
        parent::tearDown();
    }

    /** A linked computer, seen `$secondsAgo` ago. */
    private function computer(string $userId, int $secondsAgo = 5, ?string $instance = null, string $name = 'Office PC'): string
    {
        $id = substr('dc-' . bin2hex(random_bytes(12)), 0, 36);
        self::$pdo->prepare(
            'INSERT INTO desktop_connections (id, owner_user_id, device_name, desktop_instance_id, last_seen_at)
             VALUES (?, ?, ?, ?, NOW() - INTERVAL ? SECOND)'
        )->execute([$id, $userId, $name, $instance ?? ('inst-' . bin2hex(random_bytes(6))), $secondsAgo]);
        return $id;
    }

    /** @return array<string,mixed> the command queued for the owner's computer */
    private function queued(): array
    {
        $stmt = self::$pdo->prepare('SELECT * FROM desktop_commands WHERE owner_user_id = ? ORDER BY created_at DESC, id LIMIT 1');
        $stmt->execute([$this->userId]);
        return $stmt->fetch(\PDO::FETCH_ASSOC) ?: [];
    }

    private function sentCode(): string
    {
        return json_decode((string) $this->queued()['payload_json'], true)['code'];
    }

    private function rows(string $sql, array $args): int
    {
        $stmt = self::$pdo->prepare($sql);
        $stmt->execute($args);
        return (int) $stmt->fetchColumn();
    }

    private static function decode(ResponseInterface $response): array
    {
        $response->getBody()->rewind();
        return json_decode((string) $response->getBody(), true) ?: [];
    }

    private function asOwner(array $body = []): ServerRequestInterface
    {
        return (new ServerRequestFactory())->createServerRequest('POST', self::SERVER . '/api/data-nodes/backup-link')
            ->withAttribute('userId', $this->userId)
            ->withBody((new StreamFactory())->createStream((string) json_encode($body)));
    }

    public function testACodeGoesToThatComputersPluginAndOnlyItsHashIsKept(): void
    {
        $this->computer($this->userId, 5, 'inst-other', 'Other PC');
        $connection = $this->computer($this->userId, 5, 'inst-office');

        $started = self::$links->start($this->userId, $connection, self::SERVER);

        self::assertSame('Office PC', $started['deviceName']);
        $queued = $this->queued();
        self::assertSame('formlogic-backups', $queued['connector_id']);
        self::assertSame('link.accept', $queued['command']);
        self::assertSame('inst-office', $queued['target_instance_id'], 'that computer, and no other');
        $payload = json_decode((string) $queued['payload_json'], true);
        self::assertSame(self::SERVER, $payload['server']);
        self::assertMatchesRegularExpression('/^[0-9a-f]{64}$/', $payload['code']);
        $owner = self::$pdo->prepare('SELECT email FROM users WHERE id = ?');
        $owner->execute([$this->userId]);
        self::assertSame($owner->fetchColumn(), $payload['account'], 'the window names the account');

        $stored = self::$pdo->prepare('SELECT code_hash FROM backup_link_codes WHERE id = ?');
        $stored->execute([$started['id']]);
        self::assertSame(hash('sha256', $payload['code']), $stored->fetchColumn());
        self::assertSame(0, $this->rows('SELECT COUNT(*) FROM backup_link_codes WHERE code_hash = ?', [$payload['code']]));
    }

    public function testTheServiceEveryRelaySurfaceUsesCannotOfferALink(): void
    {
        $instance = 'inst-' . bin2hex(random_bytes(6));
        $this->computer($this->userId, 5, $instance);
        foreach ([['formlogic-backups', 'link.accept'], ['FormLogic-Backups', 'LINK.ACCEPT'], [' formlogic-backups ', ' link.accept ']] as [$connector, $command]) {
            try {
                self::$commands->enqueue($this->userId, $this->userId, null, [
                    'connectorId' => $connector,
                    'command' => $command,
                    'payload' => ['server' => 'https://elsewhere.example', 'code' => str_repeat('a', 64)],
                    'targetInstanceId' => $instance,
                ]);
                self::fail("{$connector} {$command}");
            } catch (\InvalidArgumentException $e) {
                self::assertSame(DesktopCommandService::PRIVATE_BACKUP_LINK_MESSAGE, $e->getMessage());
            }
        }
        self::assertSame(0, $this->rows('SELECT COUNT(*) FROM desktop_commands WHERE owner_user_id = ?', [$this->userId]));

        // The plugin's reads are as open as they ever were.
        DesktopCommandService::assertPublicRelayCommand('formlogic-backups', 'status.get');
        DesktopCommandService::assertPublicRelayCommand('someone-else', 'link.accept');
    }

    public function testAComputerOfSomeoneElsesIsRefused(): void
    {
        $other = $this->makeUser();
        $theirs = $this->computer($other);

        try {
            self::$links->start($this->userId, $theirs, self::SERVER);
            self::fail('someone else\'s computer');
        } catch (\RuntimeException $e) {
            self::assertSame('backup_link_offline', $e->getMessage());
        }
        self::assertSame(0, $this->rows('SELECT COUNT(*) FROM desktop_commands WHERE owner_user_id IN (?, ?)', [$this->userId, $other]));
    }

    public function testAComputerThatIsNotOnlineIsRefused(): void
    {
        $this->expectExceptionMessage('backup_link_offline');
        self::$links->start($this->userId, $this->computer($this->userId, 600), self::SERVER);
    }

    public function testAComputerThatHasOnlyJustLinkedIsAskedToWait(): void
    {
        $connection = $this->computer($this->userId, 5, 'oauth-abc');

        $response = $this->controller()->start($this->asOwner(['connectionId' => $connection]), (new ResponseFactory())->createResponse());

        self::assertSame(409, $response->getStatusCode());
        self::assertSame('backup_link_not_ready', self::decode($response)['code']);
        self::assertSame(0, $this->rows('SELECT COUNT(*) FROM desktop_commands WHERE owner_user_id = ?', [$this->userId]));
    }

    public function testACodeBecomesABackupOnlyKeyOnce(): void
    {
        self::$links->start($this->userId, $this->computer($this->userId), self::SERVER);
        $code = $this->sentCode();

        $client = self::$links->redeem($code);

        self::assertSame($this->userId, $client['accountId']);
        $key = self::$apiKeys->validateKey($client['key']);
        self::assertSame(['data:snapshot'], $key['scopes']);
        self::assertStringContainsString('FormLogic Backups on Office PC', (string) $key['name']);
        self::assertSame(1, $this->rows('SELECT COUNT(*) FROM backup_clients WHERE owner_user_id = ?', [$this->userId]));

        // Some time on: within the same second MySQL counts rewriting the same value as no change.
        self::$pdo->prepare('UPDATE backup_link_codes SET used_at = used_at - INTERVAL 1 MINUTE WHERE owner_user_id = ?')->execute([$this->userId]);
        try {
            self::$links->redeem($code);
            self::fail('a code works once');
        } catch (\RuntimeException $e) {
            self::assertSame('backup_link_invalid', $e->getMessage());
        }
        self::assertSame(1, $this->rows('SELECT COUNT(*) FROM backup_clients WHERE owner_user_id = ?', [$this->userId]));
    }

    public function testAWrongCodeGivesNothing(): void
    {
        self::$links->start($this->userId, $this->computer($this->userId), self::SERVER);
        try {
            self::$links->redeem(str_repeat('0', 64));
            self::fail('a wrong code');
        } catch (\RuntimeException $e) {
            self::assertSame('backup_link_invalid', $e->getMessage());
        }
        self::assertSame(0, $this->rows('SELECT COUNT(*) FROM api_keys WHERE user_id = ?', [$this->userId]));
    }

    public function testACodeOutOfTimeGivesNothing(): void
    {
        $started = self::$links->start($this->userId, $this->computer($this->userId), self::SERVER);
        self::$pdo->prepare('UPDATE backup_link_codes SET expires_at = ? WHERE id = ?')->execute([gmdate('Y-m-d H:i:s', time() - 1), $started['id']]);

        try {
            self::$links->redeem($this->sentCode());
            self::fail('out of time');
        } catch (\RuntimeException $e) {
            self::assertSame('backup_link_invalid', $e->getMessage());
        }
        self::assertSame('expired', self::$links->status($this->userId, $started['id'])['state']);
    }

    public function testANewCodeLeavesTheOneBeforeGood(): void
    {
        $connection = $this->computer($this->userId);
        $first = self::$links->start($this->userId, $connection, self::SERVER);
        $old = $this->sentCode();
        self::$pdo->prepare('UPDATE desktop_commands SET created_at = created_at - INTERVAL 1 MINUTE WHERE owner_user_id = ?')->execute([$this->userId]);

        $second = self::$links->start($this->userId, $connection, self::SERVER);

        // A window may still be open on the first, and answering it has to work.
        self::assertSame('waiting', self::$links->status($this->userId, $first['id'])['state']);
        self::$links->redeem($old);
        self::assertSame('linked', self::$links->status($this->userId, $first['id'])['state']);
        self::assertSame('waiting', self::$links->status($this->userId, $second['id'])['state']);
    }

    public function testACodeBeingSwappedThisMomentIsStillWaiting(): void
    {
        $started = self::$links->start($this->userId, $this->computer($this->userId), self::SERVER);
        self::$pdo->prepare('UPDATE backup_link_codes SET used_at = ? WHERE id = ?')->execute([gmdate('Y-m-d H:i:s'), $started['id']]);

        self::assertSame('waiting', self::$links->status($this->userId, $started['id'])['state']);
    }

    public function testASwapThatDiedEndsWithTheCode(): void
    {
        $started = self::$links->start($this->userId, $this->computer($this->userId), self::SERVER);
        self::$pdo->prepare('UPDATE backup_link_codes SET used_at = ?, expires_at = ? WHERE id = ?')->execute([gmdate('Y-m-d H:i:s'), gmdate('Y-m-d H:i:s', time() - 1), $started['id']]);

        self::assertSame('expired', self::$links->status($this->userId, $started['id'])['state']);
    }

    public function testStatusFollowsItFromWaitingToTheNode(): void
    {
        $started = self::$links->start($this->userId, $this->computer($this->userId), self::SERVER);
        self::assertSame(['state' => 'waiting', 'message' => null, 'nodeId' => null], self::$links->status($this->userId, $started['id']));

        $client = self::$links->redeem($this->sentCode());
        self::assertSame(['state' => 'linked', 'message' => null, 'nodeId' => null], self::$links->status($this->userId, $started['id']));

        $node = self::$nodes->register($this->userId, $client['apiKeyId'], [
            'signingPublicKey' => base64_encode(sodium_crypto_sign_publickey(sodium_crypto_sign_keypair())),
            'displayName' => 'FormLogic Backups on Office PC',
        ]);
        self::assertSame($node['id'], self::$links->status($this->userId, $started['id'])['nodeId']);
    }

    public function testStatusIsTheOwnersAlone(): void
    {
        $started = self::$links->start($this->userId, $this->computer($this->userId), self::SERVER);
        self::assertNull(self::$links->status($this->makeUser(), $started['id']));
    }

    /** @return array{0: string, 1: string} the request's id and its command's */
    private function startedWithCommand(): array
    {
        $started = self::$links->start($this->userId, $this->computer($this->userId), self::SERVER);
        return [$started['id'], (string) $this->queued()['id']];
    }

    private function commandEnds(string $commandId, string $status, ?array $result, ?array $error): void
    {
        self::$pdo->prepare('UPDATE desktop_commands SET status = ?, result_json = ?, error_json = ? WHERE id = ?')
            ->execute([$status, $result !== null ? json_encode($result) : null, $error !== null ? json_encode($error) : null, $commandId]);
    }

    public function testAComputerWithoutThePluginIsHeardAsAFailure(): void
    {
        [$id, $commandId] = $this->startedWithCommand();
        $this->commandEnds($commandId, 'failed', null, ['message' => 'The "formlogic-backups" connector is not available']);

        $status = self::$links->status($this->userId, $id);

        self::assertSame('failed', $status['state']);
        self::assertStringContainsString('not available', $status['message']);
    }

    public function testThePluginSayingNoIsHeardAsAFailure(): void
    {
        [$id, $commandId] = $this->startedWithCommand();
        $this->commandEnds($commandId, 'done', ['ok' => false, 'error' => ['code' => 'failed', 'message' => "This computer's backups are connected already."]], null);

        self::assertSame("This computer's backups are connected already.", self::$links->status($this->userId, $id)['message']);
    }

    public function testThePluginStartingItsWindowIsStillWaiting(): void
    {
        [$id, $commandId] = $this->startedWithCommand();
        $this->commandEnds($commandId, 'done', ['ok' => true, 'data' => ['jobId' => 'job-1']], null);

        self::assertSame('waiting', self::$links->status($this->userId, $id)['state']);
    }

    public function testNobodyClaimingItIsHeardAsAFailure(): void
    {
        [$id, $commandId] = $this->startedWithCommand();
        // Past its minute, and swept by nobody: the computer that would have polled has gone.
        self::$pdo->prepare('UPDATE desktop_commands SET expires_at = NOW() - INTERVAL 1 SECOND WHERE id = ?')->execute([$commandId]);

        self::assertStringContainsString('did not answer', self::$links->status($this->userId, $id)['message']);
    }

    public function testErasingAnAccountTakesItsCodes(): void
    {
        $other = $this->makeUser();
        self::$pdo->prepare('INSERT INTO backup_link_codes (id, owner_user_id, code_hash, expires_at) VALUES (?, ?, ?, ?)')
            ->execute(['l-' . bin2hex(random_bytes(8)), $other, bin2hex(random_bytes(32)), gmdate('Y-m-d H:i:s')]);

        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$other]);

        self::assertSame(0, $this->rows('SELECT COUNT(*) FROM backup_link_codes WHERE owner_user_id = ?', [$other]));
    }

    private function controller(bool $enabled = true): BackupLinkController
    {
        return new BackupLinkController(self::$links, $enabled);
    }

    public function testTheControllerSendsAndTheCodeComesBackAsAToken(): void
    {
        // On a split deployment APP_URL is the site, and what the plugin calls is this API.
        $appUrl = $_ENV['APP_URL'] ?? null;
        $_ENV['APP_URL'] = 'https://app.elsewhere.test/';
        try {
            $started = $this->controller()->start($this->asOwner(['connectionId' => $this->computer($this->userId)]), (new ResponseFactory())->createResponse());
        } finally {
            if ($appUrl === null) {
                unset($_ENV['APP_URL']);
            } else {
                $_ENV['APP_URL'] = $appUrl;
            }
        }
        self::assertSame(201, $started->getStatusCode(), json_encode(self::decode($started)));
        self::assertSame(self::SERVER, json_decode((string) $this->queued()['payload_json'], true)['server'], 'the address the API was reached at');

        $request = (new ServerRequestFactory())->createServerRequest('POST', 'http://localhost/api/oauth/backup-link')->withParsedBody(['code' => $this->sentCode()]);
        $redeemed = $this->controller()->redeem($request, (new ResponseFactory())->createResponse());

        self::assertSame(200, $redeemed->getStatusCode());
        self::assertSame('no-store', $redeemed->getHeaderLine('Cache-Control'));
        $body = self::decode($redeemed);
        self::assertStringStartsWith('flk_', $body['formlogic_api_key']);
        self::assertSame($this->userId, $body['account_id']);
        self::assertStringContainsString('@test.local', $body['account_email']);
    }

    public function testACodeTheControllerCannotTakeIsAPlainRefusal(): void
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', 'http://localhost/api/oauth/backup-link')->withParsedBody(['code' => 'nope']);
        $refused = $this->controller()->redeem($request, (new ResponseFactory())->createResponse());
        self::assertSame(400, $refused->getStatusCode());
        self::assertSame('backup_link_invalid', self::decode($refused)['code']);
    }

    private function fillWithKeys(): void
    {
        for ($n = 0; $n < 25; $n++) {
            self::$apiKeys->createKey($this->userId, "Key {$n}", ['forms:read']);
        }
    }

    public function testAnAccountWithNoRoomForAKeyIsToldBeforeAnyWindowOpens(): void
    {
        $this->fillWithKeys();

        $refused = $this->controller()->start($this->asOwner(['connectionId' => $this->computer($this->userId)]), (new ResponseFactory())->createResponse());

        self::assertSame(409, $refused->getStatusCode());
        self::assertSame('backup_link_no_room', self::decode($refused)['code']);
        self::assertSame(0, $this->rows('SELECT COUNT(*) FROM desktop_commands WHERE owner_user_id = ?', [$this->userId]));
    }

    public function testRunningOutOfRoomWhileTheWindowIsOpenIsHeardOnThePage(): void
    {
        $started = self::$links->start($this->userId, $this->computer($this->userId), self::SERVER);
        $this->fillWithKeys();
        $request = (new ServerRequestFactory())->createServerRequest('POST', 'http://localhost/api/oauth/backup-link')->withParsedBody(['code' => $this->sentCode()]);

        $refused = $this->controller()->redeem($request, (new ResponseFactory())->createResponse());

        self::assertSame(409, $refused->getStatusCode());
        self::assertSame('backup_link_no_room', self::decode($refused)['code']);
        self::assertSame(['state' => 'failed', 'message' => BackupLinkService::NO_ROOM, 'nodeId' => null], self::$links->status($this->userId, $started['id']));
    }

    public function testAResetEndsAnOpenCode(): void
    {
        $started = self::$links->start($this->userId, $this->computer($this->userId), self::SERVER);
        $code = $this->sentCode();
        // What AuthService::resetPassword does, which PasswordResetSingleUseTest proves it does.
        self::$pdo->prepare('UPDATE backup_link_codes SET expires_at = NOW() WHERE owner_user_id = ? AND expires_at > NOW()')->execute([$this->userId]);

        self::assertSame('expired', self::$links->status($this->userId, $started['id'])['state']);
        $this->expectExceptionMessage('backup_link_invalid');
        self::$links->redeem($code);
    }

    public function testAdministratorsActingAsTheOwnerCannotSendOne(): void
    {
        $request = $this->asOwner(['connectionId' => $this->computer($this->userId)])->withAttribute('adminActorId', 'admin-1');
        $refused = $this->controller()->start($request, (new ResponseFactory())->createResponse());
        self::assertSame(403, $refused->getStatusCode());
        self::assertSame('acting_as_denied', self::decode($refused)['code']);
    }

    public function testWithDataNodesOffNothingAnswers(): void
    {
        $off = $this->controller(false);
        $response = fn () => (new ResponseFactory())->createResponse();
        foreach ([$off->start($this->asOwner(), $response()), $off->status($this->asOwner(), $response(), ['id' => 'x']), $off->redeem($this->asOwner(), $response())] as $answer) {
            self::assertSame(403, $answer->getStatusCode());
            self::assertSame('data_nodes_disabled', self::decode($answer)['code']);
        }
    }

    public function testASecondOwnersComputerIsNotASideDoor(): void
    {
        $other = $this->makeUser();
        $response = $this->controller()->start($this->asOwner(['connectionId' => $this->computer($other)]), (new ResponseFactory())->createResponse());
        self::assertSame(409, $response->getStatusCode());
        self::assertSame('backup_link_offline', self::decode($response)['code']);
        self::$pdo->prepare('DELETE FROM desktop_connections WHERE owner_user_id = ?')->execute([$other]);
    }
}
