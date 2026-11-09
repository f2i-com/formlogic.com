<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\CameraCheckSettings;
use FormLogic\Services\DesktopAiRelayService;
use FormLogic\Services\SiteAiBusyException;
use FormLogic\Services\SiteAiTooLargeException;
use FormLogic\Services\SiteAiDesktopSettings;
use FormLogic\Services\SiteDesktopAi;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * The site's AI on the administrator's OAIY, through the real desktop AI lane: the server seals a
 * member's turn as a browser would, a desktop that holds the pinned key (the contract's test
 * desktop, docs/contracts/e2e-envelope-vectors.json) claims and opens it, and its sealed frames
 * come back as the answer. A turn never carries a tool grant, so no member can make the
 * administrator's machine act.
 */
final class SiteDesktopAiTest extends TestCase
{
    private static ?PDO $pdo = null;
    private static ?MySQLConnection $mysql = null;
    private static array $vectors = [];

    private string $adminId = '';
    private string $memberId = '';
    private string $settingsPath = '';
    private DesktopAiRelayService $relay;
    private SiteAiDesktopSettings $settings;

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        try {
            $conn = new MySQLConnection([
                'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
                'port' => $_ENV['DB_PORT'] ?? '3306',
                'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
                'username' => $_ENV['DB_USERNAME'] ?? 'root',
                'password' => $_ENV['DB_PASSWORD'] ?? '',
                'charset' => 'utf8mb4',
                'collation' => 'utf8mb4_unicode_ci',
            ]);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        self::$vectors = json_decode((string) file_get_contents(dirname($root, 2) . '/docs/contracts/e2e-envelope-vectors.json'), true, 512, JSON_THROW_ON_ERROR);
    }

    protected function setUp(): void
    {
        if (self::$pdo === null) {
            $this->markTestSkipped('No test database');
        }
        $this->adminId = $this->makeUser();
        // A computer serves the site only while the account it was chosen under is an administrator.
        self::$pdo->prepare('UPDATE users SET is_admin = 1 WHERE id = ?')->execute([$this->adminId]);
        $this->memberId = $this->makeUser();
        $this->settingsPath = sys_get_temp_dir() . '/site-ai-desktop-' . bin2hex(random_bytes(6)) . '.json';
        $this->relay = new DesktopAiRelayService(self::$mysql);
        $this->settings = new SiteAiDesktopSettings(self::$mysql, $this->settingsPath);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        @unlink($this->settingsPath);
        foreach ([$this->adminId, $this->memberId, ...$this->extraUsers] as $uid) {
            self::$pdo->prepare('DELETE FROM desktop_ai_frames WHERE request_id IN (SELECT id FROM desktop_ai_requests WHERE owner_user_id = ?)')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM desktop_ai_requests WHERE owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM desktop_connections WHERE owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
    }

    public function testAMembersTurnGoesToTheAdministratorsOaiyAndComesBackOpened(): void
    {
        $this->chooseTheTestDesktop();
        $seen = [];
        $desktop = $this->desktop(function (array $turn, string $pair, string $id) use (&$seen): void {
            $seen = $turn;
            $this->append($id, ['v' => 1, 'type' => 'delta', 'kind' => 'delta', 'delta' => ['choices' => [['index' => 0, 'delta' => ['content' => 'Hel']]]]], 0, $pair);
            $this->append($id, ['v' => 1, 'type' => 'delta', 'kind' => 'delta', 'delta' => 'lo'], 1, $pair);
            $this->append($id, ['v' => 1, 'type' => 'final', 'kind' => 'final'], 2, $pair);
            $this->relay->complete($id, $this->adminId, ['status' => 'done', 'instanceId' => 'inst-site-ai']);
        });
        $deltas = [];
        $answer = $desktop->chat([['role' => 'user', 'content' => 'Say hello.']], $this->memberId, function (string $d) use (&$deltas) { $deltas[] = $d; }, null, 30);

        self::assertSame('Hello', $answer['content']);
        self::assertSame(['Hel', 'lo'], $deltas);
        // What reached OAIY: the turn, routed to its engine, and no grant or tool mode of any kind.
        self::assertSame(['v', 'kind', 'providerId', 'threadId', 'clientSeq', 'messages'], array_keys($seen));
        self::assertSame(['chat', 'oaiy-engine', 1], [$seen['kind'], $seen['providerId'], $seen['clientSeq']]);
        self::assertSame([['role' => 'user', 'content' => 'Say hello.']], $seen['messages']);
        $row = self::$pdo->query('SELECT requesting_user_id, owner_user_id, target_instance_id FROM desktop_ai_requests WHERE owner_user_id = ' . self::$pdo->quote($this->adminId))->fetch(PDO::FETCH_ASSOC);
        self::assertSame([$this->memberId, $this->adminId, 'inst-site-ai'], [$row['requesting_user_id'], $row['owner_user_id'], $row['target_instance_id']]);
    }

    public function testAComputerWhoseOwnerIsNoLongerAnAdministratorIsSentNoChatAndNoPicture(): void
    {
        $this->chooseTheTestDesktop();
        $id = (string) self::$pdo->query("SELECT id FROM desktop_connections WHERE desktop_instance_id = 'inst-site-ai' AND owner_user_id = " . self::$pdo->quote($this->adminId))->fetchColumn();
        $camera = new CameraCheckSettings($this->settings, $this->settingsPath . '.camera.json');
        $camera->choose($this->adminId, $id, SiteDesktopAi::PROVIDER, null);
        self::assertNotNull($this->settings->current());
        self::assertNotNull($camera->current());

        // Another administrator takes this one's rights away, and nobody presses Stop.
        self::$pdo->prepare('UPDATE users SET is_admin = 0 WHERE id = ?')->execute([$this->adminId]);
        self::assertNull($this->settings->current(), 'the site\'s AI reads as not served from OAIY');
        self::assertNull($camera->current(), 'camera checks read as not set up');
        $desktop = $this->desktop(fn () => self::fail('a turn reached the computer'));
        try {
            $desktop->chat([['role' => 'user', 'content' => 'Say hello.']], $this->memberId, null, null, 5);
            self::fail('a member\'s chat went to the computer');
        } catch (\RuntimeException $e) {
            self::assertStringContainsString('not served from OAIY', $e->getMessage());
        }
        self::assertSame(0, $this->rows(), 'nothing was queued for it');

        // Made an administrator again, it serves as it was chosen.
        self::$pdo->prepare('UPDATE users SET is_admin = 1 WHERE id = ?')->execute([$this->adminId]);
        self::assertNotNull($this->settings->current());
        @unlink($this->settingsPath . '.camera.json');
    }

    public function testATurnQueuedBeforeTheOwnerWasDemotedIsNotHandedToTheirComputer(): void
    {
        $this->chooseTheTestDesktop();
        $desktop = new SiteDesktopAi($this->relay, $this->settings);
        [$id] = $desktop->send($this->settings->current(), ['kind' => 'chat', 'messages' => [['role' => 'user', 'content' => 'Say hello.']]], $this->memberId);
        // The owner's own turn, queued beside it, is still theirs to take.
        $own = $this->relay->enqueue($this->adminId, $this->adminId, [
            'kind' => 'chat', 'providerId' => 'oaiy-engine', 'targetInstanceId' => 'inst-site-ai',
            'ephPub' => base64_encode(random_bytes(32)), 'envelope' => base64_encode(random_bytes(64)),
        ])['request']['requestId'];
        self::assertCount(2, $this->relay->listPending($this->adminId, null, 10, 'inst-site-ai'));

        // Their rights are taken away while the member's turn waits.
        self::$pdo->prepare('UPDATE users SET is_admin = 0 WHERE id = ?')->execute([$this->adminId]);
        self::assertSame([$own], array_column($this->relay->listPending($this->adminId, null, 10, 'inst-site-ai'), 'requestId'), 'the computer is not shown the member\'s turn');
        self::assertSame([$own], array_column($this->relay->pollPending($this->adminId, null, 0, 10, 'inst-site-ai'), 'requestId'));
        try {
            $this->relay->claim($id, $this->adminId, ['instanceId' => 'inst-site-ai']);
            self::fail('the computer took a member\'s turn after its owner was demoted');
        } catch (\RuntimeException $e) {
            self::assertSame('already_claimed', $e->getMessage());
        }
        self::assertSame('pending', $this->relay->getStatus($id, $this->adminId));
        self::assertSame('claimed', $this->relay->claim($own, $this->adminId, ['instanceId' => 'inst-site-ai'])['status'], 'its owner\'s own turn is taken as ever');
    }

    public function testAProviderStoredInOaiyIsAskedForTheModelChosenForIt(): void
    {
        $this->connection($this->adminId, 'inst-site-ai', self::$vectors['desktop']['publicKey']);
        $id = (string) self::$pdo->query("SELECT id FROM desktop_connections WHERE desktop_instance_id = 'inst-site-ai' AND owner_user_id = " . self::$pdo->quote($this->adminId))->fetchColumn();
        foreach ([['all', 'm'], ['lm-studio', null], ['lm-studio', ''], ['bad id!', 'm']] as [$provider, $model]) {
            try {
                $this->settings->choose($this->adminId, $id, $provider, $model);
                self::fail("$provider / " . var_export($model, true) . ' is not a choice');
            } catch (\InvalidArgumentException) {
            }
        }
        self::assertNull($this->settings->current());
        // OAIY's own engine never names a model: it answers with the one chosen in OAIY.
        self::assertNull($this->settings->choose($this->adminId, $id, 'oaiy-engine', 'ignored')['model']);

        $this->settings->choose($this->adminId, $id, 'lm-studio', 'some-vision-model');
        self::assertSame(['lm-studio', 'some-vision-model'], [$this->settings->current()['providerId'], $this->settings->current()['model']]);
        $seen = [];
        $desktop = $this->desktop(function (array $turn, string $pair, string $id) use (&$seen): void {
            $seen = $turn;
            $this->append($id, ['v' => 1, 'type' => 'final', 'kind' => 'final', 'completion' => ['choices' => [['message' => ['role' => 'assistant', 'content' => 'ok']]]]], 0, $pair);
            $this->relay->complete($id, $this->adminId, ['status' => 'done', 'instanceId' => 'inst-site-ai']);
        });
        self::assertSame('ok', $desktop->chat([['role' => 'user', 'content' => 'hi']], $this->memberId, null, null, 30)['content']);
        self::assertSame(['lm-studio', 'some-vision-model'], [$seen['providerId'], $seen['model']]);
    }

    public function testAnAnswerSentWholeInTheFinalFrameIsTheAnswer(): void
    {
        $this->chooseTheTestDesktop();
        $desktop = $this->desktop(function (array $turn, string $pair, string $id): void {
            $this->append($id, ['v' => 1, 'type' => 'final', 'kind' => 'final', 'completion' => ['choices' => [['message' => ['role' => 'assistant', 'content' => 'Paris']]]]], 0, $pair);
            $this->relay->complete($id, $this->adminId, ['status' => 'done', 'instanceId' => 'inst-site-ai']);
        });
        self::assertSame('Paris', $desktop->chat([['role' => 'user', 'content' => 'Capital of France?']], $this->memberId, null, null, 30)['content']);
    }

    public function testOaiysErrorIsSaidAndAFrameItDidNotSealIsRefused(): void
    {
        $this->chooseTheTestDesktop();
        $failing = $this->desktop(function (array $turn, string $pair, string $id): void {
            $this->append($id, ['v' => 1, 'type' => 'error', 'kind' => 'error', 'message' => 'no model loaded'], 0, $pair);
            $this->relay->complete($id, $this->adminId, ['status' => 'failed', 'instanceId' => 'inst-site-ai']);
        });
        try {
            $failing->chat([['role' => 'user', 'content' => 'hi']], $this->memberId, null, null, 30);
            self::fail('an error frame is an error');
        } catch (\RuntimeException $e) {
            self::assertStringContainsString('no model loaded', $e->getMessage());
        }

        // A frame sealed with any other key, as from a computer whose key changed, does not open.
        $stranger = $this->desktop(function (array $turn, string $pair, string $id): void {
            $other = sodium_crypto_box_keypair_from_secretkey_and_publickey(sodium_crypto_box_secretkey(sodium_crypto_box_keypair()), sodium_crypto_box_publickey(sodium_crypto_box_keypair()));
            $this->append($id, ['v' => 1, 'kind' => 'delta', 'delta' => 'hijacked'], 0, $other);
        });
        try {
            $stranger->chat([['role' => 'user', 'content' => 'hi']], $this->memberId, null, null, 30);
            self::fail('a frame this turn did not seal must not open');
        } catch (\RuntimeException $e) {
            self::assertStringContainsString('did not open', $e->getMessage());
        }
    }

    public function testAMemberWithTurnsWaitingIsToldBusyAtOnce(): void
    {
        $this->chooseTheTestDesktop();
        $idle = new SiteDesktopAi($this->relay, $this->settings, static function (): void {
            throw new \LogicException('no wait: the busy answer comes before any');
        });
        // Two turns of this member's already wait (the lane's per-requester limit).
        for ($i = 0; $i < DesktopAiRelayService::MAX_IN_FLIGHT_PER_USER; $i++) {
            $this->relay->enqueue($this->adminId, $this->memberId, [
                'kind' => 'chat', 'providerId' => 'oaiy-engine', 'targetInstanceId' => 'inst-site-ai',
                'ephPub' => base64_encode(random_bytes(32)), 'envelope' => base64_encode(random_bytes(64)),
            ]);
        }
        $this->expectException(SiteAiBusyException::class);
        $idle->chat([['role' => 'user', 'content' => 'one more']], $this->memberId, null, null, 30);
    }

    public function testAnOfflineComputerOrAFullQueueIsSaidAtOnceAndNothingIsQueued(): void
    {
        $this->chooseTheTestDesktop();
        $never = new SiteDesktopAi($this->relay, $this->settings, static function (): void {
            throw new \LogicException('no wait: the answer comes before any');
        });
        self::$pdo->prepare("UPDATE desktop_connections SET last_seen_at = NOW() - INTERVAL 10 MINUTE WHERE owner_user_id = ?")->execute([$this->adminId]);
        try {
            $never->chat([['role' => 'user', 'content' => 'hi']], $this->memberId, null, null, 30);
            self::fail('an offline computer');
        } catch (SiteAiBusyException $e) {
            self::assertSame('site_ai_offline', $e->reason);
        }
        self::assertSame(0, $this->rows());

        self::$pdo->prepare('UPDATE desktop_connections SET last_seen_at = NOW() WHERE owner_user_id = ?')->execute([$this->adminId]);
        // Other members' turns fill the site's own cap, which is below the lane's.
        for ($i = 0; $i < SiteDesktopAi::MAX_WAITING; $i++) {
            $this->relay->enqueue($this->adminId, $this->makeUser(), [
                'kind' => 'chat', 'providerId' => 'oaiy-engine', 'targetInstanceId' => 'inst-site-ai',
                'ephPub' => base64_encode(random_bytes(32)), 'envelope' => base64_encode(random_bytes(64)),
            ]);
        }
        try {
            $never->chat([['role' => 'user', 'content' => 'hi']], $this->memberId, null, null, 30);
            self::fail('a full queue');
        } catch (SiteAiBusyException $e) {
            self::assertSame('site_ai_busy', $e->reason);
        }
        self::assertSame(SiteDesktopAi::MAX_WAITING, $this->rows());
    }

    public function testATurnTooLargeForTheLaneIsRefusedInWords(): void
    {
        $this->chooseTheTestDesktop();
        $this->expectException(SiteAiTooLargeException::class);
        $picture = 'data:image/jpeg;base64,' . base64_encode(random_bytes(300000));
        (new SiteDesktopAi($this->relay, $this->settings))->chat([['role' => 'user', 'content' => [['type' => 'image_url', 'image_url' => ['url' => $picture]]]]], $this->memberId, null, null, 30);
    }

    public function testATurnNobodyWaitsForAnyMoreIsTakenOffTheQueue(): void
    {
        $this->chooseTheTestDesktop();
        $quiet = new SiteDesktopAi($this->relay, $this->settings, static function (): void {
            usleep(200000);
        });
        try {
            $quiet->chat([['role' => 'user', 'content' => 'hi']], $this->memberId, null, null, 5);
            self::fail('nobody answered');
        } catch (\RuntimeException $e) {
            self::assertStringContainsString('too long', $e->getMessage());
        }
        $status = self::$pdo->query('SELECT status, envelope FROM desktop_ai_requests WHERE owner_user_id = ' . self::$pdo->quote($this->adminId))->fetch(PDO::FETCH_ASSOC);
        self::assertSame(['expired', null], [$status['status'], $status['envelope']]);
    }

    public function testOnlyTheAdministratorsOwnComputerWithAPublishedKeyCanBeChosen(): void
    {
        $this->connection($this->memberId, 'inst-members', self::$vectors['desktop']['publicKey']);
        $members = (string) self::$pdo->query('SELECT id FROM desktop_connections WHERE owner_user_id = ' . self::$pdo->quote($this->memberId))->fetchColumn();
        try {
            $this->settings->choose($this->adminId, $members);
            self::fail('another account\'s computer');
        } catch (\InvalidArgumentException) {
        }
        $this->connection($this->adminId, 'inst-keyless', null);
        $keyless = (string) self::$pdo->query("SELECT id FROM desktop_connections WHERE desktop_instance_id = 'inst-keyless'")->fetchColumn();
        try {
            $this->settings->choose($this->adminId, $keyless);
            self::fail('a computer with no published key');
        } catch (\InvalidArgumentException) {
        }
        self::assertNull($this->settings->current());
        $this->chooseTheTestDesktop();
        self::assertSame(self::$vectors['desktop']['publicKey'], $this->settings->current()['publicKey']);
        self::assertSame(SiteAiDesktopSettings::fingerprint(self::$vectors['desktop']['publicKey']), $this->settings->candidates($this->adminId)[0]['fingerprint']);
        $this->settings->clear();
        self::assertNull($this->settings->current());
    }

    /** A SiteDesktopAi whose wait plays the desktop once: claim, open, then $answer. */
    private function desktop(\Closure $answer): SiteDesktopAi
    {
        $played = false;
        return new SiteDesktopAi($this->relay, $this->settings, function () use (&$played, $answer): void {
            if ($played) {
                return;
            }
            $played = true;
            $pending = $this->relay->listPending($this->adminId, null, 10, 'inst-site-ai');
            self::assertCount(1, $pending);
            $claimed = $this->relay->claim($pending[0]['requestId'], $this->adminId, ['instanceId' => 'inst-site-ai']);
            $desktopSecret = base64_decode(self::$vectors['desktop']['secretKey'], true);
            $pair = sodium_crypto_box_keypair_from_secretkey_and_publickey($desktopSecret, base64_decode($claimed['ephPub'], true));
            $turn = SiteDesktopAi::open($claimed['envelope'], 0, 0, $pair);
            $answer($turn, $pair, $claimed['requestId']);
        });
    }

    private function append(string $id, array $frame, int $counter, string $pair): void
    {
        $this->relay->appendFrame($id, $this->adminId, SiteDesktopAi::seal($frame, 1, $counter, $pair), 'inst-site-ai');
    }

    private function chooseTheTestDesktop(): void
    {
        $this->connection($this->adminId, 'inst-site-ai', self::$vectors['desktop']['publicKey']);
        $id = (string) self::$pdo->query("SELECT id FROM desktop_connections WHERE desktop_instance_id = 'inst-site-ai' AND owner_user_id = " . self::$pdo->quote($this->adminId))->fetchColumn();
        $this->settings->choose($this->adminId, $id);
    }

    private function connection(string $owner, string $instance, ?string $key): void
    {
        self::$pdo->prepare('INSERT INTO desktop_connections (id, owner_user_id, device_name, desktop_instance_id, last_seen_at, e2e_public_key) VALUES (?, ?, ?, ?, NOW(), ?)')
            ->execute([bin2hex(random_bytes(16)), $owner, 'Test PC', $instance, $key]);
    }

    /** @var string[] users made beyond the two each test has */
    private array $extraUsers = [];

    private function makeUser(): string
    {
        $id = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")->execute([$id, $id . '@test.local']);
        if ($this->adminId !== '' && $this->memberId !== '') {
            $this->extraUsers[] = $id;
        }
        return $id;
    }

    private function rows(): int
    {
        return (int) self::$pdo->query('SELECT COUNT(*) FROM desktop_ai_requests WHERE owner_user_id = ' . self::$pdo->quote($this->adminId))->fetchColumn();
    }

    /** A picture as App AI sends it (contract §1, OAIY-LANE.md): the fields OAIY reads, and no chat thread. */
    public function testAPictureTurnCarriesThePictureFieldsAndNothingElse(): void
    {
        $this->chooseTheTestDesktop();
        $site = $this->settings->current();
        $desktop = new SiteDesktopAi($this->relay, $this->settings);
        [$id, $pair] = $desktop->send($site, ['kind' => 'image', 'requestId' => 'fl-ai-job-1', 'providerId' => 'oaiy-engine', 'model' => 'flux-3-image-klein', 'prompt' => 'A red kite', 'size' => '512x512', 'seed' => 9007199254740991, 'reference' => null, 'incognito' => true, 'toolGrant' => ['x']], $this->adminId, DesktopAiRelayService::SOURCE_APP_AI);
        $claimed = $this->relay->claim($id, $this->adminId, ['instanceId' => 'inst-site-ai']);
        $desktopPair = sodium_crypto_box_keypair_from_secretkey_and_publickey(base64_decode(self::$vectors['desktop']['secretKey'], true), base64_decode($claimed['ephPub'], true));
        $turn = SiteDesktopAi::open($claimed['envelope'], 0, 0, $desktopPair);
        self::assertSame(['v', 'kind', 'providerId', 'requestId', 'model', 'prompt', 'size', 'seed', 'reference', 'incognito'], array_keys($turn));
        self::assertSame(['image', 'oaiy-engine', 9007199254740991, true], [$turn['kind'], $turn['providerId'], $turn['seed'], $turn['incognito']]);
        $row = self::$pdo->query('SELECT kind, source, provider_id FROM desktop_ai_requests WHERE id = ' . self::$pdo->quote($id))->fetch(PDO::FETCH_ASSOC);
        self::assertSame(['image', 'app-ai', 'oaiy-engine'], [$row['kind'], $row['source'], $row['provider_id']]);
        sodium_memzero($pair);
    }

    /** A picture being drawn takes none of the members' chat places, and a second picture waits its turn. */
    public function testAPictureHasAPlaceOfItsOwnBesideTheMembersChats(): void
    {
        $this->chooseTheTestDesktop();
        $site = $this->settings->current();
        $desktop = new SiteDesktopAi($this->relay, $this->settings);
        $picture = ['kind' => 'image', 'providerId' => 'oaiy-engine', 'model' => 'flux-3-image-klein', 'prompt' => 'A kite', 'size' => '512x512', 'incognito' => true];
        $desktop->send($site, $picture, $this->adminId, DesktopAiRelayService::SOURCE_APP_AI);
        for ($i = 0; $i < SiteDesktopAi::MAX_WAITING; $i++) {
            $desktop->send($site, ['kind' => 'chat', 'messages' => [['role' => 'user', 'content' => 'hi']]], $this->makeUser());
        }
        self::assertSame(SiteDesktopAi::MAX_WAITING + 1, $this->rows(), 'every member\'s chat was queued beside the picture');
        try {
            $desktop->send($site, $picture, $this->adminId, DesktopAiRelayService::SOURCE_APP_AI);
            self::fail('a second picture');
        } catch (SiteAiBusyException $e) {
            self::assertSame('site_ai_busy', $e->reason);
        }
        try {
            $desktop->send($site, ['kind' => 'chat', 'messages' => [['role' => 'user', 'content' => 'hi']]], $this->makeUser());
            self::fail('a fourth chat');
        } catch (SiteAiBusyException) {
        }
        self::assertSame(SiteDesktopAi::MAX_WAITING + 1, $this->rows());
    }
}
