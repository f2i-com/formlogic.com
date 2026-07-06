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
 * Integration coverage for the app activity feed + form relations map + their supporting
 * service work, driven against a real DB (skipped without one):
 *  - GET /api/app/{slug}/activity: per-member form access, newest-first ordering, limit clamp;
 *  - GET /api/apps/{id}/forms/relations: outgoing/incoming linked_record shape + cross-form names;
 *  - FormService::getFormsByIds: batch output identical to per-form getForm;
 *  - settings.appKind sanitization (create/update/companion default 'admin');
 *  - createApp rolePreset: non-owner system-role default grants per preset.
 */
class AppActivityRelationsTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SQLiteConnection $sqlite;
    private static FormService $formService;
    private static AppService $appService;
    private static AppResponseService $appResponseService;
    private static AppPublicController $publicCtrl;
    private static AppController $adminCtrl;

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
        self::$sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-actrel-' . bin2hex(random_bytes(5)));
        self::$formService = new FormService($conn, self::$sqlite);
        $responseService = new ResponseService($conn, self::$sqlite);
        self::$appService = new AppService($conn, self::$formService);
        self::$appResponseService = new AppResponseService($conn, self::$sqlite, $responseService, null, self::$formService);
        self::$publicCtrl = new AppPublicController(
            self::$appService,
            new AppUserService($conn),
            self::$appResponseService,
            self::$formService,
            $responseService,
            $conn,
            self::$sqlite,
            new AppDomainService($conn)
        );
        self::$adminCtrl = new AppController(self::$appService);
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
            self::$pdo->prepare('DELETE FROM response_links WHERE source_form_id = ? OR target_form_id = ?')->execute([$fid, $fid]);
            self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$fid]);
        }
        foreach ($this->userIds as $uid) {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
        $this->appIds = $this->formIds = $this->userIds = [];
    }

    // ---- helpers -------------------------------------------------------------------------

    private function uuid(): string { return bin2hex(random_bytes(10)); }

    private function makeUser(): string
    {
        $id = 'u' . $this->uuid();
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$id, $id . '@test.local']);
        $this->userIds[] = $id;
        return $id;
    }

    /** Create a real form (MySQL row + per-form SQLite DB with fields). */
    private function makeForm(string $ownerId, string $title, array $fields): string
    {
        $form = self::$formService->createForm([
            'userId' => $ownerId,
            'title' => $title,
            'status' => 'published',
            'fields' => $fields,
        ]);
        $this->formIds[] = $form['id'];
        return $form['id'];
    }

    private function makeApp(array $data, string $ownerId): array
    {
        $app = self::$appService->createApp($data, $ownerId);
        $this->appIds[] = $app['id'];
        return $app;
    }

    /** Give $userId an active membership with ONE per-form permission (custom role). */
    private function grantFormPerm(string $appId, string $userId, string $formId, string $perm): void
    {
        $role = 'role' . $this->uuid();
        self::$pdo->prepare("INSERT INTO app_roles (id, app_id, name, is_system, sort_order) VALUES (?, ?, ?, 0, 0)")->execute([$role, $appId, 'R' . substr($role, 0, 10)]);
        self::$pdo->prepare("INSERT INTO app_role_permissions (id, role_id, form_id, permission) VALUES (?, ?, ?, ?)")->execute(['arp' . $this->uuid(), $role, $formId, $perm]);
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, 'active', NOW())")->execute(['au' . $this->uuid(), $appId, $userId, $role]);
    }

    /** Submit through the real pipeline, then pin submitted_at to a controlled timestamp. */
    private function makeResponse(string $appId, string $formId, string $userId, array $answers, string $submittedAt): string
    {
        $resp = self::$appResponseService->createResponse($appId, $formId, ['answers' => $answers], $userId, null);
        $this->assertIsArray($resp);
        self::$sqlite->getFormDatabase($formId)
            ->prepare('UPDATE responses SET submitted_at = :ts WHERE id = :id')
            ->execute(['ts' => $submittedAt, 'id' => $resp['id']]);
        return (string) $resp['id'];
    }

    private function mockRequest(?string $userId, array $query = []): ServerRequestInterface
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $userId : null);
        $req->method('getQueryParams')->willReturn($query);
        return $req;
    }

    /** @return array{status:int, body:array} */
    private function activity(?string $userId, string $slug, array $query = []): array
    {
        $out = self::$publicCtrl->activity($this->mockRequest($userId, $query), new SlimResponse(), ['slug' => $slug]);
        return ['status' => $out->getStatusCode(), 'body' => json_decode((string) $out->getBody(), true) ?: []];
    }

    /** @return array{status:int, body:array} */
    private function relations(?string $userId, string $appId): array
    {
        $out = self::$adminCtrl->formRelations($this->mockRequest($userId), new SlimResponse(), ['id' => $appId]);
        return ['status' => $out->getStatusCode(), 'body' => json_decode((string) $out->getBody(), true) ?: []];
    }

    /** @return string[] sorted permission names of an app's system role */
    private function rolePerms(string $appId, string $roleName): array
    {
        $stmt = self::$pdo->prepare(
            'SELECT arp.permission FROM app_role_permissions arp
             JOIN app_roles ar ON ar.id = arp.role_id
             WHERE ar.app_id = ? AND ar.name = ? AND ar.is_system = 1'
        );
        $stmt->execute([$appId, $roleName]);
        $perms = $stmt->fetchAll(PDO::FETCH_COLUMN) ?: [];
        sort($perms);
        return $perms;
    }

    private function textField(string $id, string $label): array
    {
        return ['id' => $id, 'type' => 'short_text', 'label' => $label, 'required' => false];
    }

    // ---- T12: activity -------------------------------------------------------------------

    public function testActivityRespectsMemberAccessNewestFirstAndLimitClamp(): void
    {
        $owner = $this->makeUser();
        $member = $this->makeUser();
        $formA = $this->makeForm($owner, 'Checks', [$this->textField('name', 'Name')]);
        $formB = $this->makeForm($owner, 'Incidents', [$this->textField('name', 'Name')]);
        $app = $this->makeApp(['name' => 'Activity App', 'status' => 'published', 'formIds' => [$formA, $formB]], $owner);

        // Member can view ALL responses on form A only.
        $this->grantFormPerm($app['id'], $member, $formA, AppPermissions::VIEW_ALL_RESPONSES);

        $a1 = $this->makeResponse($app['id'], $formA, $owner, ['name' => 'Alpha'], '2026-07-01 10:00:00');
        $b1 = $this->makeResponse($app['id'], $formB, $owner, ['name' => 'Bravo'], '2026-07-01 11:00:00');
        $a2 = $this->makeResponse($app['id'], $formA, $member, ['name' => 'Charlie'], '2026-07-01 12:00:00');

        // Member: only form A rows, newest first — no trace of form B.
        $r = $this->activity($member, $app['slug']);
        $this->assertSame(200, $r['status']);
        $items = $r['body']['activity'] ?? [];
        $this->assertSame([$a2, $a1], array_column($items, 'recordId'));
        $this->assertSame([$formA, $formA], array_column($items, 'formId'));
        $this->assertSame('Charlie', $items[0]['title']);
        $this->assertSame('Checks', $items[0]['formName']);
        $this->assertSame('2026-07-01 12:00:00', $items[0]['submittedAt']);
        $this->assertStringNotContainsString($formB, json_encode($r['body']));

        // Owner: rows from BOTH forms, merged globally newest-first.
        $r = $this->activity($owner, $app['slug']);
        $this->assertSame(200, $r['status']);
        $this->assertSame([$a2, $b1, $a1], array_column($r['body']['activity'] ?? [], 'recordId'));

        // limit honored...
        $r = $this->activity($owner, $app['slug'], ['limit' => '2']);
        $this->assertSame([$a2, $b1], array_column($r['body']['activity'] ?? [], 'recordId'));
        // ...clamped low (0 → 1)...
        $r = $this->activity($owner, $app['slug'], ['limit' => '0']);
        $this->assertCount(1, $r['body']['activity'] ?? []);
        // ...and clamped high (999 → 25): bulk rows so the cap is actually exercised.
        $db = self::$sqlite->getFormDatabase($formB);
        $ins = $db->prepare("INSERT INTO responses (id, answers, metadata, status, submitted_at, updated_at) VALUES (?, ?, '{}', 'submitted', ?, ?)");
        for ($i = 0; $i < 30; $i++) {
            $ts = sprintf('2026-07-02 10:%02d:00', $i);
            $ins->execute(['bulk' . $i . $this->uuid(), json_encode(['name' => 'Bulk ' . $i]), $ts, $ts]);
        }
        $r = $this->activity($owner, $app['slug'], ['limit' => '999']);
        $this->assertCount(25, $r['body']['activity'] ?? []);
        // The 25 newest overall = the bulk rows' newest (all dated after the seeded three).
        $this->assertSame('2026-07-02 10:29:00', $r['body']['activity'][0]['submittedAt']);
    }

    public function testActivityViewOwnScopeAndSubmitOnlyExclusion(): void
    {
        $owner = $this->makeUser();
        $viewOwn = $this->makeUser();
        $submitOnly = $this->makeUser();
        $outsider = $this->makeUser();
        $form = $this->makeForm($owner, 'Reports', [$this->textField('name', 'Name')]);
        $app = $this->makeApp(['name' => 'Scoped App', 'status' => 'published', 'formIds' => [$form]], $owner);

        $this->grantFormPerm($app['id'], $viewOwn, $form, AppPermissions::VIEW_OWN_RESPONSES);
        $this->grantFormPerm($app['id'], $submitOnly, $form, AppPermissions::SUBMIT_RESPONSES);

        $mine = $this->makeResponse($app['id'], $form, $viewOwn, ['name' => 'Mine'], '2026-07-01 09:00:00');
        $this->makeResponse($app['id'], $form, $owner, ['name' => 'Theirs'], '2026-07-01 10:00:00');

        // view_own: only the caller's rows, even though newer rows by others exist.
        $r = $this->activity($viewOwn, $app['slug']);
        $this->assertSame(200, $r['status']);
        $this->assertSame([$mine], array_column($r['body']['activity'] ?? [], 'recordId'));

        // submit-only: the form is in their runtime config, but they can view no records.
        $r = $this->activity($submitOnly, $app['slug']);
        $this->assertSame(200, $r['status']);
        $this->assertSame([], $r['body']['activity'] ?? null);

        // Non-members and anonymous callers are rejected.
        $this->assertSame(403, $this->activity($outsider, $app['slug'])['status']);
        $this->assertSame(401, $this->activity(null, $app['slug'])['status']);
    }

    // ---- T16: relations ------------------------------------------------------------------

    public function testRelationsShapeWithOutgoingIncomingAndCrossFormNames(): void
    {
        $owner = $this->makeUser();
        $member = $this->makeUser();
        $projects = $this->makeForm($owner, 'Projects', [$this->textField('pname', 'Project name')]);
        $external = $this->makeForm($owner, 'External Registry', [$this->textField('x', 'X')]);
        $tasks = $this->makeForm($owner, 'Tasks', [
            $this->textField('title', 'Title'),
            ['id' => 'proj', 'type' => 'linked_record', 'label' => 'Project', 'required' => false,
                'properties' => ['targetFormId' => $projects, 'allowMultiple' => false]],
            ['id' => 'ext', 'type' => 'linked_record', 'label' => 'Registry entry', 'required' => false,
                'properties' => ['targetFormId' => $external, 'allowMultiple' => true]],
        ]);
        // Note: 'External Registry' is deliberately NOT attached to the app.
        $app = $this->makeApp(['name' => 'Rel App', 'formIds' => [$tasks, $projects]], $owner);
        $this->grantFormPerm($app['id'], $member, $tasks, AppPermissions::VIEW_ALL_RESPONSES);

        $r = $this->relations($owner, $app['id']);
        $this->assertSame(200, $r['status']);
        $forms = $r['body']['forms'] ?? [];
        $this->assertSame([$tasks, $projects], array_column($forms, 'formId'));
        $byId = array_column($forms, null, 'formId');

        // Tasks → outgoing: in-app target named by its app display name, external by its title.
        $this->assertSame('Tasks', $byId[$tasks]['displayName']);
        $this->assertSame([
            ['fieldId' => 'proj', 'fieldLabel' => 'Project', 'targetFormId' => $projects,
                'targetFormName' => 'Projects', 'allowMultiple' => false],
            ['fieldId' => 'ext', 'fieldLabel' => 'Registry entry', 'targetFormId' => $external,
                'targetFormName' => 'External Registry', 'allowMultiple' => true],
        ], $byId[$tasks]['outgoingLinks']);
        $this->assertSame([], $byId[$tasks]['incomingLinks']);

        // Projects → incoming: the inverse of Tasks.proj (in-app only; the external link isn't inverted).
        $this->assertSame([], $byId[$projects]['outgoingLinks']);
        $this->assertSame([
            ['fieldId' => 'proj', 'fieldLabel' => 'Project', 'targetFormId' => $tasks,
                'targetFormName' => 'Tasks', 'allowMultiple' => false],
        ], $byId[$projects]['incomingLinks']);

        // Owner-scoped: a mere member (and a nobody) gets 404, not the relationship map.
        $this->assertSame(404, $this->relations($member, $app['id'])['status']);
        $this->assertSame(404, $this->relations($this->makeUser(), $app['id'])['status']);
    }

    // ---- T17: getFormsByIds --------------------------------------------------------------

    public function testGetFormsByIdsMatchesGetFormAndPreservesInputOrder(): void
    {
        $owner = $this->makeUser();
        $fa = $this->makeForm($owner, 'Form A', [$this->textField('a', 'A')]);
        $fb = $this->makeForm($owner, 'Form B', [$this->textField('b', 'B'), $this->textField('b2', 'B2')]);

        $map = self::$formService->getFormsByIds([$fb, $fa, 'missing-' . $this->uuid(), $fb]);

        // Input order, de-duplicated, missing ids absent.
        $this->assertSame([$fb, $fa], array_keys($map));
        // Per-form output identical to getForm (same builder path ⇒ identical sanitization input).
        $this->assertSame(self::$formService->getForm($fa), $map[$fa]);
        $this->assertSame(self::$formService->getForm($fb), $map[$fb]);

        $this->assertSame([], self::$formService->getFormsByIds([]));
        $this->assertSame([], self::$formService->getFormsByIds(['', 'nope-' . $this->uuid()]));
    }

    // ---- T8: appKind ---------------------------------------------------------------------

    public function testAppKindSanitizedOnCreateUpdateAndCompanionDefault(): void
    {
        $owner = $this->makeUser();

        // Valid value persists; invalid is dropped (other settings survive).
        $valid = $this->makeApp(['name' => 'K1', 'settings' => ['appKind' => 'client']], $owner);
        $this->assertSame('client', $valid['settings']['appKind'] ?? null);
        $invalid = $this->makeApp(['name' => 'K2', 'settings' => ['appKind' => 'warlord', 'allowSelfRegistration' => true]], $owner);
        $this->assertArrayNotHasKey('appKind', $invalid['settings']);
        $this->assertTrue($invalid['settings']['allowSelfRegistration']);

        // Top-level appKind shorthand lands at settings.appKind.
        $short = $this->makeApp(['name' => 'K3', 'appKind' => 'staff'], $owner);
        $this->assertSame('staff', $short['settings']['appKind'] ?? null);

        // updateApp: same write gate.
        $upd = self::$appService->updateApp($valid['id'], ['settings' => ['appKind' => 'internal']]);
        $this->assertSame('internal', $upd['settings']['appKind'] ?? null);
        $upd = self::$appService->updateApp($valid['id'], ['settings' => ['appKind' => 'bogus']]);
        $this->assertArrayNotHasKey('appKind', $upd['settings']);

        // Companion defaults to 'admin'; a valid explicit kind wins; an invalid one falls back.
        $comp = self::$appService->createCompanionApp($valid['id'], $owner);
        $this->appIds[] = $comp['id'];
        $this->assertSame('admin', $comp['settings']['appKind'] ?? null);
        $comp2 = self::$appService->createCompanionApp($valid['id'], $owner, 'Portal Twin', ['appKind' => 'client']);
        $this->appIds[] = $comp2['id'];
        $this->assertSame('client', $comp2['settings']['appKind'] ?? null);
        $comp3 = self::$appService->createCompanionApp($valid['id'], $owner, 'Odd Twin', ['appKind' => 'nonsense']);
        $this->appIds[] = $comp3['id'];
        $this->assertSame('admin', $comp3['settings']['appKind'] ?? null);
    }

    // ---- T9: rolePreset ------------------------------------------------------------------

    public function testRolePresetsTuneNonOwnerSystemRoles(): void
    {
        $owner = $this->makeUser();
        $portal = $this->makeApp(['name' => 'Portal', 'rolePreset' => 'client-portal'], $owner);
        $console = $this->makeApp(['name' => 'Console', 'rolePreset' => 'admin-console'], $owner);
        $plain = $this->makeApp(['name' => 'Plain', 'rolePreset' => 'not-a-preset'], $owner);

        // client-portal Member: submit + view OWN only — explicitly no view-all.
        $portalMember = $this->rolePerms($portal['id'], 'Member');
        $this->assertContains(AppPermissions::SUBMIT_RESPONSES, $portalMember);
        $this->assertContains(AppPermissions::VIEW_OWN_RESPONSES, $portalMember);
        $this->assertNotContains(AppPermissions::VIEW_ALL_RESPONSES, $portalMember);

        // admin-console Member: reviews everyone's records.
        $consoleMember = $this->rolePerms($console['id'], 'Member');
        $this->assertContains(AppPermissions::VIEW_ALL_RESPONSES, $consoleMember);
        $this->assertContains(AppPermissions::EDIT_RESPONSES, $consoleMember);
        $this->assertContains(AppPermissions::EXPORT_RESPONSES, $consoleMember);

        // The Owner role is untouched by presets — always every permission.
        $allSorted = AppPermissions::ALL;
        sort($allSorted);
        $this->assertSame($allSorted, $this->rolePerms($portal['id'], 'Owner'));
        $this->assertSame($allSorted, $this->rolePerms($console['id'], 'Owner'));

        // Invalid preset is ignored: Admin/Member stay grant-less (original behavior).
        $this->assertSame([], $this->rolePerms($plain['id'], 'Member'));
        $this->assertSame([], $this->rolePerms($plain['id'], 'Admin'));
    }
}
