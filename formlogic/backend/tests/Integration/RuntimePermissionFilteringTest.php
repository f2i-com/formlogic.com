<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Constants\AppPermissions;
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
 * Route-level runtime permission filtering — the cases AppVisibilityRouteTest does NOT already pin
 * (that suite covers: member sees only permitted forms, hidden form absent from the whole payload,
 * nav filtered, base-form report/widget removal, direct getForm 200/404, owner sees everything).
 * This suite drives the same real AppPublicController::getApp seam for the REMAINING gaps:
 *
 *  - landing page fallback: settings.landingPage pointing at an inaccessible form resets to
 *    'dashboard' for the member, is preserved for the owner, and an ACCESSIBLE landing survives
 *  - a saved report whose spec JOINS an inaccessible form is removed (base form accessible)
 *  - a document report keeps its accessible/text blocks but drops blocks referencing removed reports
 *  - a dashboard LIST widget bound to an inaccessible form is removed; list/text/activity widgets
 *    on accessible forms survive
 *  - a form hidden via app_forms.is_visible = 0 is absent from the member runtime payload even when
 *    the member holds a permission on it (invisibility, not permission, hides it)
 *
 * Skipped unless a test database is reachable (same setup as AppVisibilityRouteTest:
 * DB_TEST_DATABASE / DB_HOST / DB_USERNAME / DB_PASSWORD; CI provides MySQL).
 */
class RuntimePermissionFilteringTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static AppPublicController $ctrl;

    /** @var string[] */ private array $userIds = [];
    /** @var string[] */ private array $formIds = [];
    private string $appId = '';

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-runtimeperm-' . bin2hex(random_bytes(5)));
        $formService = new FormService($conn, $sqlite);
        $responseService = new ResponseService($conn, $sqlite);
        self::$ctrl = new AppPublicController(
            new AppService($conn, $formService),
            new AppUserService($conn),
            new AppResponseService($conn, $sqlite, $responseService, null, $formService),
            $formService,
            $responseService,
            $conn,
            $sqlite,
            new AppDomainService($conn)
        );
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
        if ($this->appId !== '') {
            self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$this->appId]);
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$this->appId]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$this->appId]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$this->appId]);
            self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$this->appId]);
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
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$id, $id . '@test.local']);
        $this->userIds[] = $id;
        return $id;
    }

    private function makeForm(string $ownerId): string
    {
        $id = 'form' . $this->uuid();
        self::$pdo->prepare("INSERT INTO forms (id, user_id, title, status) VALUES (?, ?, 'T', 'published')")->execute([$id, $ownerId]);
        $this->formIds[] = $id;
        return $id;
    }

    private function addFormToApp(string $appId, string $formId, bool $visible = true): void
    {
        self::$pdo->prepare("INSERT INTO app_forms (id, app_id, form_id, display_name, sort_order, is_visible, settings) VALUES (?, ?, ?, 'T', 0, ?, '{}')")
            ->execute(['af' . $this->uuid(), $appId, $formId, $visible ? 1 : 0]);
    }

    /** One role, arbitrarily many (formId, permission) grants, one active membership. */
    private function makeMember(string $appId, string $userId, array $grants): void
    {
        $role = 'role' . $this->uuid();
        self::$pdo->prepare("INSERT INTO app_roles (id, app_id, name, is_system, sort_order) VALUES (?, ?, ?, 0, 0)")
            ->execute([$role, $appId, 'R' . substr($role, 0, 10)]);
        foreach ($grants as [$formId, $perm]) {
            self::$pdo->prepare("INSERT INTO app_role_permissions (id, role_id, form_id, permission) VALUES (?, ?, ?, ?)")
                ->execute(['arp' . $this->uuid(), $role, $formId, $perm]);
        }
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, 'active', NOW())")
            ->execute(['au' . $this->uuid(), $appId, $userId, $role]);
    }

    /**
     * App fixture: three forms — A (member-accessible), B (inaccessible), C (member-accessible but
     * INVISIBLE via app_forms.is_visible = 0). Landing page points at B. Saved reports: rA (base A),
     * rJ (base A but JOINS B), document d1 referencing both + a text block. Dashboard widgets: report
     * on A, list on B, list on A, text, activity.
     *
     * @return array{slug:string,owner:string,member:string,formA:string,formB:string,formC:string}
     */
    private function seedApp(): array
    {
        $owner = $this->makeUser();
        $member = $this->makeUser();
        $formA = $this->makeForm($owner);
        $formB = $this->makeForm($owner);
        $formC = $this->makeForm($owner);
        $appId = 'app' . $this->uuid();
        $slug = 'rpf' . substr($this->uuid(), 0, 12);

        $settings = json_encode(['landingPage' => $formB, 'other' => 'kept']);
        $nav = json_encode([
            ['formId' => $formA, 'displayName' => 'A', 'sortOrder' => 0, 'isVisible' => true],
            ['formId' => $formB, 'displayName' => 'B', 'sortOrder' => 1, 'isVisible' => true],
            ['formId' => $formC, 'displayName' => 'C', 'sortOrder' => 2, 'isVisible' => true],
        ]);
        $reports = json_encode([
            ['id' => 'rA', 'type' => 'builder', 'spec' => ['formId' => $formA, 'viz' => 'bar']],
            ['id' => 'rJ', 'type' => 'builder', 'spec' => ['formId' => $formA, 'viz' => 'table', 'joins' => [['via' => 'link', 'formId' => $formB, 'type' => 'left']]]],
            ['id' => 'd1', 'type' => 'document', 'blocks' => [
                ['id' => 'bA', 'kind' => 'report', 'reportId' => 'rA'],
                ['id' => 'bJ', 'kind' => 'report', 'reportId' => 'rJ'],
                ['id' => 'bT', 'kind' => 'text', 'body' => 'narrative'],
            ]],
        ]);
        $dash = json_encode(['enabled' => true, 'kind' => 'dashboard', 'dashboard' => ['version' => 1, 'widgets' => [
            ['id' => 'wRepA', 'kind' => 'report', 'spec' => ['formId' => $formA, 'viz' => 'kpi'], 'layout' => []],
            ['id' => 'wListB', 'kind' => 'list', 'list' => ['formId' => $formB], 'layout' => []],
            ['id' => 'wListA', 'kind' => 'list', 'list' => ['formId' => $formA], 'layout' => []],
            ['id' => 'wText', 'kind' => 'text', 'text' => ['body' => 'hello'], 'layout' => []],
            ['id' => 'wAct', 'kind' => 'activity', 'layout' => []],
        ]]]);
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status, settings, nav_config, custom_screen, reports) VALUES (?, ?, 'T', ?, 'published', ?, ?, ?, ?)")
            ->execute([$appId, $owner, $slug, $settings, $nav, $dash, $reports]);
        $this->appId = $appId;

        $this->addFormToApp($appId, $formA);
        $this->addFormToApp($appId, $formB);
        $this->addFormToApp($appId, $formC, false); // permission granted below, but invisible

        // Owner membership row (owner_id bypass grants all perms regardless of the role's grants).
        $this->makeMember($appId, $owner, [[$formA, AppPermissions::VIEW_ALL_RESPONSES]]);
        // Member: permissions on A and on the INVISIBLE C — none on B.
        $this->makeMember($appId, $member, [
            [$formA, AppPermissions::VIEW_ALL_RESPONSES],
            [$formC, AppPermissions::VIEW_ALL_RESPONSES],
        ]);

        return ['slug' => $slug, 'owner' => $owner, 'member' => $member, 'formA' => $formA, 'formB' => $formB, 'formC' => $formC];
    }

    /** @return array{status:int, body:array} */
    private function getApp(?string $userId, string $slug): array
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $userId : null);
        $out = self::$ctrl->getApp($req, new SlimResponse(), ['slug' => $slug]);
        return ['status' => $out->getStatusCode(), 'body' => json_decode((string) $out->getBody(), true) ?: []];
    }

    public function testLandingPageFallsBackToDashboardWhenTargetFormIsInaccessible(): void
    {
        $s = $this->seedApp();

        $member = $this->getApp($s['member'], $s['slug']);
        $this->assertSame(200, $member['status']);
        $this->assertSame('dashboard', $member['body']['app']['settings']['landingPage'] ?? null, 'landing at inaccessible form must reset to dashboard');
        $this->assertSame('kept', $member['body']['app']['settings']['other'] ?? null, 'unrelated settings untouched');

        // Owner path is unfiltered — the configured landing survives.
        $owner = $this->getApp($s['owner'], $s['slug']);
        $this->assertSame($s['formB'], $owner['body']['app']['settings']['landingPage'] ?? null);
    }

    public function testAccessibleLandingPageSurvivesForTheMember(): void
    {
        $s = $this->seedApp();
        self::$pdo->prepare('UPDATE apps SET settings = ? WHERE id = ?')
            ->execute([json_encode(['landingPage' => $s['formA']]), $this->appId]);

        $r = $this->getApp($s['member'], $s['slug']);
        $this->assertSame($s['formA'], $r['body']['app']['settings']['landingPage'] ?? null, 'a landing the member can access must not be reset');
    }

    public function testSavedReportJoiningAnInaccessibleFormIsRemovedAndItsDocBlockDropped(): void
    {
        $s = $this->seedApp();

        $r = $this->getApp($s['member'], $s['slug']);
        $reports = $r['body']['app']['reports'] ?? [];
        $ids = array_column($reports, 'id');

        $this->assertContains('rA', $ids, 'accessible-base report survives');
        $this->assertNotContains('rJ', $ids, 'a report whose JOIN touches an inaccessible form must be removed even though its base form is accessible');

        // The document survives, keeping the accessible-report block + the text block only.
        $this->assertContains('d1', $ids);
        $doc = $reports[array_search('d1', $ids, true)];
        $this->assertSame(['bA', 'bT'], array_column($doc['blocks'] ?? [], 'id'), 'block referencing the removed joined report must be dropped; text blocks stay');

        // Owner keeps everything, including the joined report and all three doc blocks.
        $o = $this->getApp($s['owner'], $s['slug']);
        $ownerIds = array_column($o['body']['app']['reports'] ?? [], 'id');
        $this->assertContains('rJ', $ownerIds);
        $ownerDoc = ($o['body']['app']['reports'] ?? [])[array_search('d1', $ownerIds, true)];
        $this->assertSame(['bA', 'bJ', 'bT'], array_column($ownerDoc['blocks'] ?? [], 'id'));
    }

    public function testDashboardListWidgetOnInaccessibleFormIsRemoved(): void
    {
        $s = $this->seedApp();

        $r = $this->getApp($s['member'], $s['slug']);
        $widgets = $r['body']['app']['customScreen']['dashboard']['widgets'] ?? [];
        $ids = array_column($widgets, 'id');

        $this->assertNotContains('wListB', $ids, 'list widget bound to an inaccessible form must be removed');
        $this->assertSame(['wRepA', 'wListA', 'wText', 'wAct'], $ids, 'accessible report/list + config-free text/activity widgets survive, in order');

        // Owner keeps all five.
        $o = $this->getApp($s['owner'], $s['slug']);
        $this->assertCount(5, $o['body']['app']['customScreen']['dashboard']['widgets'] ?? []);
    }

    public function testInvisibleFormIsAbsentFromTheRuntimePayloadEvenWithAPermissionOnIt(): void
    {
        $s = $this->seedApp();

        $r = $this->getApp($s['member'], $s['slug']);
        $formIds = array_column($r['body']['forms'] ?? [], 'formId');

        $this->assertContains($s['formA'], $formIds);
        $this->assertNotContains($s['formC'], $formIds, 'is_visible = 0 hides a form from the runtime even when the member holds a permission on it');
        // ...and the invisible form leaks through no app-config surface either (nav was seeded with C).
        $this->assertNotContains($s['formC'], array_column($r['body']['app']['navConfig'] ?? [], 'formId'));
    }

    public function testHiddenDataOnlyFormStaysInRuntimePayloadFlaggedHidden(): void
    {
        $s = $this->seedApp();
        // Flag A data-only; sibling settings keys (packFormId) must ride along untouched.
        self::$pdo->prepare('UPDATE app_forms SET settings = ? WHERE app_id = ? AND form_id = ?')
            ->execute([json_encode(['hidden' => true, 'packFormId' => 'stable-alias']), $this->appId, $s['formA']]);

        $r = $this->getApp($s['member'], $s['slug']);
        $forms = [];
        foreach ($r['body']['forms'] ?? [] as $f) {
            $forms[$f['formId']] = $f;
        }
        $this->assertArrayHasKey($s['formA'], $forms, 'a hidden (data-only) form must STAY in the runtime payload so the screen SDK resolves it');
        $this->assertTrue($forms[$s['formA']]['hidden']);
        $this->assertFalse($forms[$s['formA']]['menuHidden']);
        $this->assertSame('stable-alias', $forms[$s['formA']]['packFormId']);
    }

    public function testHiddenFormIsNotANavTargetForMembers(): void
    {
        $s = $this->seedApp();
        self::$pdo->prepare('UPDATE app_forms SET settings = ? WHERE app_id = ? AND form_id = ?')
            ->execute([json_encode(['hidden' => true]), $this->appId, $s['formA']]);
        self::$pdo->prepare('UPDATE apps SET settings = ? WHERE id = ?')
            ->execute([json_encode(['landingPage' => $s['formA']]), $this->appId]);

        $r = $this->getApp($s['member'], $s['slug']);
        $this->assertSame('dashboard', $r['body']['app']['settings']['landingPage'] ?? null, 'a landing page at a hidden form must reset — the form has no UI to land on');
        $this->assertNotContains($s['formA'], array_column($r['body']['app']['navConfig'] ?? [], 'formId'), 'hidden forms never surface as member nav entries');
    }

    public function testCustomLinkNavEntriesSurviveMemberFiltering(): void
    {
        $s = $this->seedApp();
        $nav = json_encode([
            ['kind' => 'link', 'id' => 'l1', 'displayName' => 'Help', 'url' => 'https://example.com', 'sortOrder' => 0, 'isVisible' => true],
            ['formId' => $s['formA'], 'displayName' => 'A', 'sortOrder' => 1, 'isVisible' => true],
            ['formId' => $s['formB'], 'displayName' => 'B', 'sortOrder' => 2, 'isVisible' => true],
        ]);
        self::$pdo->prepare('UPDATE apps SET nav_config = ? WHERE id = ?')->execute([$nav, $this->appId]);

        $r = $this->getApp($s['member'], $s['slug']);
        $navOut = $r['body']['app']['navConfig'] ?? [];
        $keys = array_map(fn ($n) => ($n['kind'] ?? 'form') === 'link' ? 'link:' . ($n['id'] ?? '?') : ($n['formId'] ?? '?'), $navOut);
        $this->assertSame(['link:l1', $s['formA']], $keys, 'owner-authored link entries are app chrome for everyone; inaccessible form entries drop');
    }
}
