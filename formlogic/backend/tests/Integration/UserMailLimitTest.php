<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AppUserController;
use FormLogic\Controllers\ExternalApiController;
use FormLogic\Controllers\ResponseController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\EmailService;
use FormLogic\Services\FormService;
use FormLogic\Services\RateLimiter;
use FormLogic\Services\ResponseService;
use FormLogic\Services\WebhookService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Log\AbstractLogger;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

/**
 * Invitations and a form's new-response notifications send mail to an address the account
 * chose, with the app's name or the form's title in it, from the site's own address. They had no
 * limit: an account could set a form to notify anyone and submit to it in a loop, or invite and
 * revoke one address over and over, and the site sent every one in the operator's name.
 * EmailService::USER_MAIL_LIMITS now holds each account to an hourly and a daily number, and each
 * address to a daily number whichever accounts send to it. A submission is never refused for it;
 * an invitation past the limit is refused with a plain message. Each refusal is logged.
 *
 * The limits are given small here; the real ones are the same code with larger numbers.
 */
class UserMailLimitTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SQLiteConnection $sqlite;
    private static FormService $forms;
    private static ResponseService $responses;
    private static AppService $apps;
    private static AppUserService $appUsers;

    /** @var string[] */ private array $userIds = [];
    /** @var string[] */ private array $formIds = [];
    /** @var string[] */ private array $appIds = [];
    private string|false $appUrlBefore = false;

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
        self::$sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-usermail-' . bin2hex(random_bytes(5)));
        self::$forms = new FormService($conn, self::$sqlite);
        self::$responses = new ResponseService($conn, self::$sqlite);
        self::$apps = new AppService($conn, self::$forms);
        self::$appUsers = new AppUserService($conn);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        // The invitation's accept link is built from a server-trusted base only.
        $this->appUrlBefore = getenv('APP_URL');
        putenv('APP_URL=https://forms.example');
    }

    protected function tearDown(): void
    {
        putenv($this->appUrlBefore === false ? 'APP_URL' : 'APP_URL=' . $this->appUrlBefore);
        if (self::$pdo === null) {
            return;
        }
        foreach ($this->appIds as $appId) {
            self::$pdo->prepare('DELETE FROM app_invitations WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_versions WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$appId]);
        }
        foreach ($this->formIds as $formId) {
            self::$pdo->prepare('DELETE FROM response_metadata WHERE form_id = ?')->execute([$formId]);
            self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$formId]);
        }
        foreach ($this->userIds as $userId) {
            self::$pdo->prepare('DELETE FROM audit_log WHERE user_id = ?')->execute([$userId]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$userId]);
        }
    }

    // ── fixtures ─────────────────────────────────────────────────────────────

    /**
     * A mailer that is configured and records what it is asked to send, with the given limits.
     * @param array<string, array{accountHour:int, accountDay:int, recipientDay:int}> $limits
     */
    private function mailer(array $limits, ?AbstractLogger $logger = null): EmailService
    {
        return new class ($logger, $limits) extends EmailService {
            /** @var list<array{to:string, subject:string}> */
            public array $sent = [];

            public function isConfigured(): bool
            {
                return true;
            }

            public function send(string $to, string $subject, string $htmlBody, ?string $textBody = null): bool
            {
                $this->sent[] = ['to' => $to, 'subject' => $subject];
                return true;
            }
        };
    }

    /**
     * A mailer of a site that sends no mail (no MAIL_FROM_ADDRESS), whatever this machine's .env
     * says, recording anything it is asked to send all the same.
     */
    private function unconfiguredMailer(array $limits): EmailService
    {
        return new class (null, $limits) extends EmailService {
            /** @var list<string> */
            public array $sent = [];

            public function isConfigured(): bool
            {
                return false;
            }

            public function send(string $to, string $subject, string $htmlBody, ?string $textBody = null): bool
            {
                $this->sent[] = $to;
                return false;
            }
        };
    }

    private function logger(): AbstractLogger
    {
        return new class extends AbstractLogger {
            /** @var list<array{level:mixed, message:string, context:array<mixed>}> */
            public array $records = [];

            public function log($level, \Stringable|string $message, array $context = []): void
            {
                $this->records[] = ['level' => $level, 'message' => (string) $message, 'context' => $context];
            }
        };
    }

    private static function limits(int $accountHour, int $accountDay, int $recipientDay): array
    {
        $kind = ['accountHour' => $accountHour, 'accountDay' => $accountDay, 'recipientDay' => $recipientDay];
        return ['invitation' => $kind, 'notification' => $kind];
    }

    private function makeUser(): array
    {
        $id = 'u-' . bin2hex(random_bytes(12));
        $email = $id . '@test.local';
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$id, $email]);
        $this->userIds[] = $id;
        return ['id' => $id, 'email' => $email];
    }

    /** A published form whose Notifications tab sends each new response to $notify. */
    private function makeForm(string $ownerId, string $notify): string
    {
        $form = self::$forms->createForm([
            'userId' => $ownerId,
            'title' => 'Win a prize at prize.example',
            'status' => 'published',
            'settings' => ['notifications' => ['emailNotifications' => true, 'notificationEmail' => $notify]],
            'fields' => [
                ['id' => 'note', 'type' => 'short_text', 'label' => 'Note', 'required' => false, 'order' => 0, 'properties' => []],
            ],
        ]);
        $id = (string) $form['id'];
        $this->formIds[] = $id;
        return $id;
    }

    private static function stranger(): string
    {
        return 'someone-' . bin2hex(random_bytes(6)) . '@elsewhere.example';
    }

    private function request(?string $userId, array $body = []): ServerRequestInterface
    {
        $req = (new ServerRequestFactory())->createServerRequest('POST', 'https://forms.example/api', ['REMOTE_ADDR' => '203.0.113.9'])
            ->withParsedBody($body);
        return $userId !== null ? $req->withAttribute('userId', $userId) : $req;
    }

    /** Submit to the public form as an anonymous visitor; the submission's status. */
    private function submit(ResponseController $controller, string $formId): int
    {
        $out = $controller->create($this->request(null, ['answers' => ['note' => 'hello']]), new SlimResponse(), ['formId' => $formId]);
        return $out->getStatusCode();
    }

    private function responseController(EmailService $mailer): ResponseController
    {
        return new ResponseController(self::$responses, self::$forms, self::$sqlite, null, null, $mailer, self::$apps, self::$mysql);
    }

    /** An app owned by $ownerId and the id of a role an invitation may give. */
    private function makeApp(string $ownerId): array
    {
        $app = self::$apps->createApp(['name' => 'Prize desk'], $ownerId);
        $appId = (string) $app['id'];
        $this->appIds[] = $appId;
        $role = self::$appUsers->createRole($appId, ['name' => 'Clerk']);
        return [$appId, (string) $role['id']];
    }

    private function invite(AppUserController $controller, string $ownerId, string $appId, string $roleId, string $email): \Psr\Http\Message\ResponseInterface
    {
        return $controller->createInvitation(
            $this->request($ownerId, ['email' => $email, 'roleId' => $roleId]),
            new SlimResponse(),
            ['appId' => $appId]
        );
    }

    private function invitationCount(string $appId): int
    {
        $stmt = self::$pdo->prepare('SELECT COUNT(*) FROM app_invitations WHERE app_id = ?');
        $stmt->execute([$appId]);
        return (int) $stmt->fetchColumn();
    }

    // ── notifications ────────────────────────────────────────────────────────

    public function testNotificationsToAnAddressThatIsNotTheOwnersStopAtThatAddressesDailyLimit(): void
    {
        $owner = $this->makeUser();
        $victim = self::stranger();
        $formId = $this->makeForm($owner['id'], $victim);
        $logger = $this->logger();
        $mailer = $this->mailer(self::limits(100, 100, 2), $logger);
        $controller = $this->responseController($mailer);

        for ($i = 0; $i < 4; $i++) {
            // The submission itself is never refused for the limit.
            $this->assertSame(201, $this->submit($controller, $formId));
        }

        $this->assertCount(2, $mailer->sent, 'two mails to the address, then none');
        $this->assertSame($victim, $mailer->sent[0]['to']);
        $limited = array_values(array_filter($logger->records, static fn (array $r): bool => $r['message'] === 'Email not sent: limit reached'));
        $this->assertCount(2, $limited, 'each mail not sent is logged');
        $this->assertSame('recipient_day', $limited[0]['context']['limit']);
        $this->assertSame('notification', $limited[0]['context']['kind']);
        $this->assertSame($owner['id'], $limited[0]['context']['account']);
    }

    public function testTheAddressesLimitHoldsWhicheverAccountsSendToIt(): void
    {
        $victim = self::stranger();
        $mailer = $this->mailer(self::limits(100, 100, 2));
        $controller = $this->responseController($mailer);
        foreach ([$this->makeUser(), $this->makeUser()] as $owner) {
            $formId = $this->makeForm($owner['id'], strtoupper($victim)); // the same address, written otherwise
            $this->submit($controller, $formId);
            $this->submit($controller, $formId);
        }
        $this->assertCount(2, $mailer->sent);
    }

    /** "name+tag@" reaches "name@", and Gmail ignores dots: those spellings share one address's limit. */
    public function testSpellingsOfOneMailboxShareItsLimit(): void
    {
        $name = 'pat' . bin2hex(random_bytes(4));
        $mailer = $this->mailer(self::limits(100, 100, 2));
        $controller = $this->responseController($mailer);
        $owner = $this->makeUser();
        foreach (["{$name}+one@gmail.com", strtoupper("{$name}+two@gmail.com"), 'p.a.t' . substr($name, 3) . '@googlemail.com'] as $spelling) {
            $this->submit($controller, $this->makeForm($owner['id'], $spelling));
        }
        $this->assertCount(2, $mailer->sent);
    }

    public function testTheOwnersOwnAddressIsHeldToTheAccountsLimitOnly(): void
    {
        $owner = $this->makeUser();
        $formId = $this->makeForm($owner['id'], $owner['email']);
        $mailer = $this->mailer(self::limits(3, 100, 1));
        $controller = $this->responseController($mailer);

        for ($i = 0; $i < 5; $i++) {
            $this->assertSame(201, $this->submit($controller, $formId));
        }
        // More than the address's daily 1 (it is the owner's own), but no more than the account's 3 an hour.
        $this->assertCount(3, $mailer->sent);
    }

    public function testTheAccountsLimitCoversEveryFormAndAddressItNotifies(): void
    {
        $owner = $this->makeUser();
        $mailer = $this->mailer(self::limits(100, 3, 100));
        $controller = $this->responseController($mailer);
        for ($i = 0; $i < 3; $i++) {
            $formId = $this->makeForm($owner['id'], self::stranger());
            $this->submit($controller, $formId);
            $this->submit($controller, $formId);
        }
        $this->assertCount(3, $mailer->sent);
    }

    public function testTheApisSubmissionsAreCountedToo(): void
    {
        $owner = $this->makeUser();
        $victim = self::stranger();
        $formId = $this->makeForm($owner['id'], $victim);
        $mailer = $this->mailer(self::limits(100, 100, 1));
        $api = new ExternalApiController(self::$forms, self::$responses, new WebhookService(self::$mysql), $mailer, null, null, self::$mysql);

        for ($i = 0; $i < 3; $i++) {
            $out = $api->submitResponse($this->request($owner['id'], ['answers' => ['note' => 'x']]), new SlimResponse(), ['formId' => $formId]);
            $this->assertSame(201, $out->getStatusCode(), (string) $out->getBody());
        }
        $this->assertCount(1, $mailer->sent);
    }

    public function testASiteThatSendsNoMailCountsNothing(): void
    {
        $owner = $this->makeUser();
        $victim = self::stranger();
        $limits = self::limits(1, 1, 1);
        $unconfigured = $this->unconfiguredMailer($limits);
        $formId = $this->makeForm($owner['id'], $victim);
        $this->submit($this->responseController($unconfigured), $formId);
        $this->submit($this->responseController($unconfigured), $formId);

        // Nothing was counted, so a configured mailer still has the whole allowance.
        $mailer = $this->mailer($limits);
        $this->submit($this->responseController($mailer), $formId);
        $this->assertCount(1, $mailer->sent);
    }

    // ── invitations ──────────────────────────────────────────────────────────

    public function testInvitationsPastTheAccountsHourlyLimitAreRefusedWithAPlainMessage(): void
    {
        $owner = $this->makeUser();
        [$appId, $roleId] = $this->makeApp($owner['id']);
        $logger = $this->logger();
        $mailer = $this->mailer(self::limits(2, 100, 100), $logger);
        $controller = new AppUserController(self::$appUsers, self::$apps, null, $mailer, new RateLimiter(self::$pdo));

        $this->assertSame(201, $this->invite($controller, $owner['id'], $appId, $roleId, self::stranger())->getStatusCode());
        $this->assertSame(201, $this->invite($controller, $owner['id'], $appId, $roleId, self::stranger())->getStatusCode());
        $refused = $this->invite($controller, $owner['id'], $appId, $roleId, self::stranger());

        $this->assertSame(429, $refused->getStatusCode());
        $body = json_decode((string) $refused->getBody(), true);
        $this->assertSame('email_limit', $body['code']);
        $this->assertStringContainsString('Your account has sent as many invitation emails as it can this hour', $body['message']);
        $this->assertGreaterThan(0, (int) $refused->getHeaderLine('Retry-After'));
        $this->assertSame(2, $this->invitationCount($appId), 'the refused invitation was not made');
        $this->assertCount(2, $mailer->sent);
        $this->assertStringContainsString("You're invited to Prize desk", $mailer->sent[0]['subject']);
        $limited = array_values(array_filter($logger->records, static fn (array $r): bool => $r['message'] === 'Email not sent: limit reached'));
        $this->assertCount(1, $limited);
        $this->assertSame('account_hour', $limited[0]['context']['limit']);
    }

    public function testInvitingAndRevokingOneAddressOverAndOverStopsAtThatAddressesLimit(): void
    {
        $owner = $this->makeUser();
        [$appId, $roleId] = $this->makeApp($owner['id']);
        $victim = self::stranger();
        $mailer = $this->mailer(self::limits(100, 100, 2));
        $controller = new AppUserController(self::$appUsers, self::$apps, null, $mailer, new RateLimiter(self::$pdo));

        for ($i = 0; $i < 2; $i++) {
            $made = $this->invite($controller, $owner['id'], $appId, $roleId, $victim);
            $this->assertSame(201, $made->getStatusCode(), (string) $made->getBody());
            $id = json_decode((string) $made->getBody(), true)['invitation']['id'];
            self::$appUsers->revokeInvitation($id);
        }
        $refused = $this->invite($controller, $owner['id'], $appId, $roleId, $victim);
        $this->assertSame(429, $refused->getStatusCode());
        $this->assertStringContainsString('This address has been sent as many invitation emails as it can be today', json_decode((string) $refused->getBody(), true)['message']);
        $this->assertCount(2, $mailer->sent);
    }

    public function testInvitationsAreNotLimitedWhenTheSiteSendsNoMail(): void
    {
        $owner = $this->makeUser();
        [$appId, $roleId] = $this->makeApp($owner['id']);
        $mailer = $this->unconfiguredMailer(self::limits(1, 1, 1));
        $controller = new AppUserController(self::$appUsers, self::$apps, null, $mailer, new RateLimiter(self::$pdo));
        for ($i = 0; $i < 3; $i++) {
            // The inviter copies the link instead; nothing is mailed, so nothing is limited.
            $this->assertSame(201, $this->invite($controller, $owner['id'], $appId, $roleId, self::stranger())->getStatusCode());
        }
        $this->assertSame([], $mailer->sent);
    }
}
