<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Constants\AppPermissions;
use FormLogic\Controllers\AppController;
use FormLogic\Controllers\AppPublicController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppResponseService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Response as SlimResponse;

/**
 * What an app member receives outside the runtime, held to the rules the runtime already
 * applies (AppPublicController::getApp / listResponses):
 *  - only an ACTIVE membership counts (hasPermission, isAppMember): a suspended or pending
 *    member gets from the app list and the form-usage list what a non-member gets;
 *  - a non-owner member sees an app only while it is published, and its config narrowed to
 *    the forms they can use (nav, reports, dashboard widgets, landing page);
 *  - an export holds the caller to the rows they may read: view-all reads every row,
 *    view-own their own, and neither reads none.
 *
 * Skipped unless a test database is reachable (DB_TEST_DATABASE / DB_HOST / DB_USERNAME / DB_PASSWORD).
 */
class AppMemberAccessTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SQLiteConnection $sqlite;
    private static AppPublicController $runtime;
    private static AppController $apps;

    /** @var string[] */ private array $userIds = [];
    /** @var string[] */ private array $formIds = [];
    /** @var string[] */ private array $appIds = [];

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
        self::$sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-memberaccess-' . bin2hex(random_bytes(5)));
        $formService = new FormService($conn, self::$sqlite);
        $responseService = new ResponseService($conn, self::$sqlite);
        $appService = new AppService($conn, $formService);
        $appUsers = new AppUserService($conn);
        self::$runtime = new AppPublicController(
            $appService,
            $appUsers,
            new AppResponseService($conn, self::$sqlite, $responseService, null, $formService),
            $formService,
            $responseService,
            $conn,
            self::$sqlite,
            new AppDomainService($conn)
        );
        self::$apps = new AppController($appService, null, null, null, null, $appUsers);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        foreach ($this->appIds as $appId) {
            self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$appId]);
        }
        foreach ($this->formIds as $fid) {
            self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$fid]);
        }
        foreach ($this->userIds as $uid) {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
    }

    private function uuid(): string { return bin2hex(random_bytes(10)); }

    private function makeUser(): string
    {
        $id = 'u' . $this->uuid();
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$id, $id . '@test.local']);
        $this->userIds[] = $id;
        return $id;
    }

    private function makeForm(string $ownerId): string
    {
        $id = 'form' . $this->uuid();
        self::$pdo->prepare("INSERT INTO forms (id, user_id, title, status) VALUES (?, ?, 'T', 'published')")->execute([$id, $ownerId]);
        $this->formIds[] = $id;
        self::$sqlite->getFormDatabase($id)
            ->prepare("INSERT INTO fields (id, type, label, field_order) VALUES ('note', 'short_text', 'Note', 0)")
            ->execute();
        return $id;
    }

    private function insertResponse(string $formId, string $note, string $submittedBy): void
    {
        self::$sqlite->getFormDatabase($formId)
            ->prepare("INSERT INTO responses (id, answers, metadata, status, submitted_at) VALUES (?, ?, ?, 'submitted', datetime('now'))")
            ->execute(['r' . $this->uuid(), json_encode(['note' => $note]), json_encode(['submittedByUserId' => $submittedBy])]);
    }

    /**
     * An app over forms A and B whose nav, reports, dashboard and landing page reference both.
     *
     * @return array{id:string, slug:string}
     */
    private function makeApp(string $ownerId, string $formA, string $formB, string $status = 'published'): array
    {
        $id = 'app' . $this->uuid();
        $slug = 'mac' . substr($this->uuid(), 0, 12);
        $settings = json_encode(['landingPage' => $formB]);
        $nav = json_encode([
            ['formId' => $formA, 'displayName' => 'A', 'sortOrder' => 0, 'isVisible' => true],
            ['formId' => $formB, 'displayName' => 'B', 'sortOrder' => 1, 'isVisible' => true],
        ]);
        $reports = json_encode([
            ['id' => 'rA', 'type' => 'builder', 'spec' => ['formId' => $formA, 'viz' => 'bar']],
            ['id' => 'rB', 'type' => 'builder', 'spec' => ['formId' => $formB, 'viz' => 'bar']],
        ]);
        $dash = json_encode(['enabled' => true, 'kind' => 'dashboard', 'dashboard' => ['version' => 1, 'widgets' => [
            ['id' => 'wA', 'kind' => 'list', 'list' => ['formId' => $formA], 'layout' => []],
            ['id' => 'wB', 'kind' => 'list', 'list' => ['formId' => $formB], 'layout' => []],
        ]]]);
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status, settings, nav_config, custom_screen, reports) VALUES (?, ?, 'T', ?, ?, ?, ?, ?, ?)")
            ->execute([$id, $ownerId, $slug, $status, $settings, $nav, $dash, $reports]);
        $this->appIds[] = $id;
        foreach ([$formA, $formB] as $i => $fid) {
            self::$pdo->prepare("INSERT INTO app_forms (id, app_id, form_id, display_name, sort_order, is_visible, settings) VALUES (?, ?, ?, 'T', ?, 1, '{}')")
                ->execute(['af' . $this->uuid(), $id, $fid, $i]);
        }
        $this->addMember($id, $ownerId, [], 'active');
        return ['id' => $id, 'slug' => $slug];
    }

    /** @param list<array{0:?string,1:string}> $grants (formId|null, permission) */
    private function addMember(string $appId, string $userId, array $grants, string $status): void
    {
        $role = 'role' . $this->uuid();
        self::$pdo->prepare("INSERT INTO app_roles (id, app_id, name, is_system, sort_order) VALUES (?, ?, ?, 0, 0)")
            ->execute([$role, $appId, 'R' . substr($role, 0, 10)]);
        foreach ($grants as [$formId, $perm]) {
            self::$pdo->prepare("INSERT INTO app_role_permissions (id, role_id, form_id, permission) VALUES (?, ?, ?, ?)")
                ->execute(['arp' . $this->uuid(), $role, $formId, $perm]);
        }
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, ?, NOW())")
            ->execute(['au' . $this->uuid(), $appId, $userId, $role, $status]);
    }

    private function request(?string $userId): ServerRequestInterface
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $userId : null);
        $req->method('getQueryParams')->willReturn([]);
        return $req;
    }

    /** @return array{status:int, body:array} */
    private function json(\Psr\Http\Message\ResponseInterface $out): array
    {
        return ['status' => $out->getStatusCode(), 'body' => json_decode((string) $out->getBody(), true) ?: []];
    }

    /** The form ids an app payload still mentions anywhere. */
    private function mentions(array $app, string $formId): bool
    {
        return str_contains((string) json_encode($app), $formId);
    }

    public function testOnlyAnActiveMembershipListsTheApp(): void
    {
        $owner = $this->makeUser();
        $formA = $this->makeForm($owner);
        $formB = $this->makeForm($owner);
        $app = $this->makeApp($owner, $formA, $formB);
        $active = $this->makeUser();
        $suspended = $this->makeUser();
        $pending = $this->makeUser();
        $this->addMember($app['id'], $active, [[$formA, AppPermissions::VIEW_ALL_RESPONSES]], 'active');
        $this->addMember($app['id'], $suspended, [[$formA, AppPermissions::VIEW_ALL_RESPONSES]], 'suspended');
        $this->addMember($app['id'], $pending, [[$formA, AppPermissions::VIEW_ALL_RESPONSES]], 'pending');

        foreach (['active' => [$active, true], 'suspended' => [$suspended, false], 'pending' => [$pending, false]] as $label => [$userId, $listed]) {
            $list = $this->json(self::$apps->index($this->request($userId), new SlimResponse()));
            $this->assertSame($listed, in_array($app['id'], array_column($list['body']['apps'] ?? [], 'id'), true), "$label member in GET /api/apps");
            $usage = $this->json(self::$apps->formUsage($this->request($userId), new SlimResponse()));
            $this->assertSame($listed, in_array($app['id'], array_column($usage['body']['apps'] ?? [], 'appId'), true), "$label member in GET /api/apps/form-usage");
        }
    }

    public function testAMemberGetsTheConfigNarrowedToTheFormsTheyCanUse(): void
    {
        $owner = $this->makeUser();
        $formA = $this->makeForm($owner);
        $formB = $this->makeForm($owner);
        $app = $this->makeApp($owner, $formA, $formB);
        $member = $this->makeUser();
        $this->addMember($app['id'], $member, [[$formA, AppPermissions::VIEW_ALL_RESPONSES]], 'active');

        $shown = $this->json(self::$apps->show($this->request($member), new SlimResponse(), ['id' => $app['id']]));
        $this->assertSame(200, $shown['status']);
        $this->assertTrue($this->mentions($shown['body']['app'], $formA), 'the form the member can use stays');
        $this->assertFalse($this->mentions($shown['body']['app'], $formB), 'GET /api/apps/{id} must not reveal the form the member cannot use');
        $this->assertSame('dashboard', $shown['body']['app']['settings']['landingPage'] ?? null);

        $listed = $this->json(self::$apps->index($this->request($member), new SlimResponse()));
        $row = array_values(array_filter($listed['body']['apps'] ?? [], fn ($a) => ($a['id'] ?? null) === $app['id']))[0] ?? null;
        $this->assertNotNull($row);
        $this->assertFalse($this->mentions($row, $formB), 'GET /api/apps must not reveal it either');

        // The owner still edits the whole app.
        $ownerView = $this->json(self::$apps->show($this->request($owner), new SlimResponse(), ['id' => $app['id']]));
        $this->assertTrue($this->mentions($ownerView['body']['app'], $formB));
    }

    public function testAMemberCannotReadAnUnpublishedAppsConfig(): void
    {
        $owner = $this->makeUser();
        $formA = $this->makeForm($owner);
        $formB = $this->makeForm($owner);
        $draft = $this->makeApp($owner, $formA, $formB, 'draft');
        $member = $this->makeUser();
        $this->addMember($draft['id'], $member, [[null, AppPermissions::VIEW_ALL_RESPONSES]], 'active');

        $this->assertSame(404, self::$apps->show($this->request($member), new SlimResponse(), ['id' => $draft['id']])->getStatusCode());
        $this->assertSame(200, self::$apps->show($this->request($owner), new SlimResponse(), ['id' => $draft['id']])->getStatusCode());
    }

    public function testAnExportHoldsTheCallerToTheRowsTheyMayRead(): void
    {
        $owner = $this->makeUser();
        $formA = $this->makeForm($owner);
        $formB = $this->makeForm($owner);
        $app = $this->makeApp($owner, $formA, $formB);
        $ownOnly = $this->makeUser();
        $all = $this->makeUser();
        $exportOnly = $this->makeUser();
        $this->addMember($app['id'], $ownOnly, [[$formA, AppPermissions::VIEW_OWN_RESPONSES], [$formA, AppPermissions::EXPORT_RESPONSES]], 'active');
        $this->addMember($app['id'], $all, [[$formA, AppPermissions::VIEW_ALL_RESPONSES], [$formA, AppPermissions::EXPORT_RESPONSES]], 'active');
        $this->addMember($app['id'], $exportOnly, [[$formA, AppPermissions::EXPORT_RESPONSES]], 'active');
        $this->insertResponse($formA, 'row-of-own-only-member', $ownOnly);
        $this->insertResponse($formA, 'row-of-someone-else', $all);

        $export = fn (string $userId) => self::$runtime->exportResponses($this->request($userId), new SlimResponse(), ['slug' => $app['slug'], 'formId' => $formA]);

        $own = $export($ownOnly);
        $this->assertSame(200, $own->getStatusCode());
        $csv = (string) $own->getBody();
        $this->assertStringContainsString('row-of-own-only-member', $csv);
        $this->assertStringNotContainsString('row-of-someone-else', $csv, 'a view-own member exports only their own rows');

        $csv = (string) $export($all)->getBody();
        $this->assertStringContainsString('row-of-own-only-member', $csv);
        $this->assertStringContainsString('row-of-someone-else', $csv);

        $this->assertSame(403, $export($exportOnly)->getStatusCode(), 'a member who may read no rows exports none');
    }
}
