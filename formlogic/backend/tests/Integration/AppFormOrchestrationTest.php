<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AppController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\FormService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Response as SlimResponse;

/**
 * Form↔app orchestration endpoints + hardening (custom-app follow-up round):
 *
 *  - GET /api/forms/{formId}/app-contexts: owner-scoped contexts with per-app display
 *    name + isPublished; 404 for a non-owned form; another owner's app never leaks
 *  - POST /api/apps with formIds: atomic create-with-forms — a single bad/foreign id
 *    rolls EVERYTHING back (no app row, no app_forms rows); all-valid attaches all
 *  - GET /api/apps: canManage/canCreateCompanion are true only for the owner
 *    (non-owner members get false + no ownerId)
 *  - GET /api/apps/form-usage: batched apps+forms shape, same visibility as /api/apps
 *  - PUT /api/apps/{id}/forms/reorder: submitted list must be EXACTLY the app's
 *    current form set (duplicate / missing / foreign ids → 400), valid reorder works
 *  - PUT /api/apps/{id}/forms/{formId}: unknown payload keys and blank/overlong
 *    display names and non-object/oversized settings → 400
 *  - schema: app_forms carries idx_form_id; apps carries reports + custom_logic
 *
 * Skipped unless a test database is reachable (same setup as AppSharedFormsTest:
 * DB_TEST_DATABASE / DB_HOST / DB_USERNAME / DB_PASSWORD; CI provides MySQL).
 */
class AppFormOrchestrationTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static AppService $apps;
    private static AppController $ctrl;

    /** @var string[] */
    private array $userIds = [];
    /** @var string[] */
    private array $formIds = [];
    /** @var string[] */
    private array $appIds = [];

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-orch-' . bin2hex(random_bytes(5)));
        $formService = new FormService($conn, $sqlite);
        self::$apps = new AppService($conn, $formService);
        self::$ctrl = new AppController(self::$apps);
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
            // app_users.role_id → app_roles is ON DELETE RESTRICT: delete children in FK-safe order.
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

    private function uuid(): string
    {
        return bin2hex(random_bytes(14));
    }

    private function makeUser(): string
    {
        $id = 'u-' . $this->uuid();
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$id, $id . '@test.local']);
        $this->userIds[] = $id;
        return $id;
    }

    private function makeForm(string $ownerId, string $title = 'Form'): string
    {
        $id = 'form-' . $this->uuid();
        self::$pdo->prepare("INSERT INTO forms (id, user_id, title, status) VALUES (?, ?, ?, 'published')")
            ->execute([$id, $ownerId, $title]);
        $this->formIds[] = $id;
        return $id;
    }

    private function makeApp(string $ownerId, string $name, array $extra = []): array
    {
        $app = self::$apps->createApp(array_merge(['name' => $name], $extra), $ownerId);
        $this->appIds[] = $app['id'];
        return $app;
    }

    /** Adds $userId as an ACTIVE member of the app using its system Member role. */
    private function addMember(string $appId, string $userId): void
    {
        $stmt = self::$pdo->prepare("SELECT id FROM app_roles WHERE app_id = ? AND name = 'Member' LIMIT 1");
        $stmt->execute([$appId]);
        $roleId = $stmt->fetchColumn();
        $this->assertNotFalse($roleId, 'system Member role must exist');
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, 'active', NOW())")
            ->execute(['au-' . $this->uuid(), $appId, $userId, $roleId]);
    }

    private function request(?string $userId, array $body = []): ServerRequestInterface
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $userId : null);
        $req->method('getParsedBody')->willReturn($body);
        return $req;
    }

    /** @return array{status:int, body:array} */
    private function call(callable $fn): array
    {
        $out = $fn();
        return ['status' => $out->getStatusCode(), 'body' => json_decode((string) $out->getBody(), true) ?: []];
    }

    private function ownerAppCount(string $ownerId): int
    {
        $stmt = self::$pdo->prepare('SELECT COUNT(*) FROM apps WHERE owner_id = ?');
        $stmt->execute([$ownerId]);
        return (int) $stmt->fetchColumn();
    }

    private function appFormCount(string $formId): int
    {
        $stmt = self::$pdo->prepare('SELECT COUNT(*) FROM app_forms WHERE form_id = ?');
        $stmt->execute([$formId]);
        return (int) $stmt->fetchColumn();
    }

    // -------------------------------------------------------------------------
    // GET /api/forms/{formId}/app-contexts
    // -------------------------------------------------------------------------

    public function testAppContextsReturnsOwnedContextsWithIsPublishedAndDisplayName(): void
    {
        $owner = $this->makeUser();
        $formId = $this->makeForm($owner, 'Job Sheet');
        $published = $this->makeApp($owner, 'Alpha App', ['status' => 'published']);
        $draft = $this->makeApp($owner, 'Beta App'); // default status = draft

        self::$apps->addFormToApp($published['id'], $formId, 'Custom Tab');
        self::$apps->addFormToApp($draft['id'], $formId); // default display name = form title

        $r = $this->call(fn () => self::$ctrl->formAppContexts($this->request($owner), new SlimResponse(), ['formId' => $formId]));
        $this->assertSame(200, $r['status']);
        $contexts = $r['body']['contexts'] ?? null;
        $this->assertIsArray($contexts);
        $this->assertCount(2, $contexts);

        $byApp = [];
        foreach ($contexts as $c) {
            $this->assertSame(
                ['appId', 'appName', 'slug', 'status', 'formDisplayName', 'isPublished'],
                array_keys($c),
                'contract shape: exactly these keys'
            );
            $byApp[$c['appId']] = $c;
        }

        $this->assertSame('Alpha App', $byApp[$published['id']]['appName']);
        $this->assertSame($published['slug'], $byApp[$published['id']]['slug']);
        $this->assertSame('published', $byApp[$published['id']]['status']);
        $this->assertTrue($byApp[$published['id']]['isPublished']);
        $this->assertSame('Custom Tab', $byApp[$published['id']]['formDisplayName']);

        $this->assertSame('draft', $byApp[$draft['id']]['status']);
        $this->assertFalse($byApp[$draft['id']]['isPublished']);
        $this->assertSame('Job Sheet', $byApp[$draft['id']]['formDisplayName'], 'display name falls back to the form title');
    }

    public function testAppContextsIsOwnerScopedAndEmptyWhenFormIsInNoApp(): void
    {
        $owner = $this->makeUser();
        $stranger = $this->makeUser();
        $formId = $this->makeForm($owner);
        $strangerApp = $this->makeApp($stranger, 'Stranger App');

        // Simulate a cross-owner attach directly (the controller forbids it) — it
        // must never surface in the owner's contexts.
        self::$pdo->prepare("INSERT INTO app_forms (id, app_id, form_id, display_name, sort_order, is_visible, settings) VALUES (?, ?, ?, 'X', 0, 1, '{}')")
            ->execute(['af-' . $this->uuid(), $strangerApp['id'], $formId]);

        $r = $this->call(fn () => self::$ctrl->formAppContexts($this->request($owner), new SlimResponse(), ['formId' => $formId]));
        $this->assertSame(200, $r['status']);
        $this->assertSame([], $r['body']['contexts'], 'another owner\'s app must not leak; no owned contexts → empty list');
    }

    public function testAppContextsReturns404ForANonOwnedForm(): void
    {
        $owner = $this->makeUser();
        $caller = $this->makeUser();
        $formId = $this->makeForm($owner);

        $r = $this->call(fn () => self::$ctrl->formAppContexts($this->request($caller), new SlimResponse(), ['formId' => $formId]));
        $this->assertSame(404, $r['status']);

        $r = $this->call(fn () => self::$ctrl->formAppContexts($this->request($caller), new SlimResponse(), ['formId' => 'no-such-form']));
        $this->assertSame(404, $r['status']);
    }

    // -------------------------------------------------------------------------
    // POST /api/apps with formIds (atomic create-with-forms)
    // -------------------------------------------------------------------------

    public function testCreateWithFormIdsAttachesAllFormsInOrder(): void
    {
        $owner = $this->makeUser();
        $formA = $this->makeForm($owner, 'A');
        $formB = $this->makeForm($owner, 'B');

        $r = $this->call(fn () => self::$ctrl->create($this->request($owner, ['name' => 'Bundled App', 'formIds' => [$formA, $formB]]), new SlimResponse()));
        $this->assertSame(201, $r['status']);
        $this->assertIsArray($r['body']['app'] ?? null, 'response shape unchanged: { app }');
        $appId = $r['body']['app']['id'];
        $this->appIds[] = $appId;

        $forms = self::$apps->getAppForms($appId);
        $this->assertSame([$formA, $formB], array_column($forms, 'formId'), 'every form attached, in submitted order');
        $this->assertSame([0, 1], array_column($forms, 'sortOrder'));
    }

    public function testCreateWithOneBadFormIdRollsBackEverything(): void
    {
        $owner = $this->makeUser();
        $goodForm = $this->makeForm($owner, 'Good');

        $r = $this->call(fn () => self::$ctrl->create($this->request($owner, ['name' => 'Doomed App', 'formIds' => [$goodForm, 'no-such-form']]), new SlimResponse()));
        $this->assertSame(400, $r['status']);

        $this->assertSame(0, $this->ownerAppCount($owner), 'no app row may survive a failed create-with-forms');
        $this->assertSame(0, $this->appFormCount($goodForm), 'no app_forms rows may survive either');
    }

    public function testCreateWithANonOwnedFormIdIsRejectedAtomically(): void
    {
        $owner = $this->makeUser();
        $stranger = $this->makeUser();
        $ownForm = $this->makeForm($owner, 'Mine');
        $strangerForm = $this->makeForm($stranger, 'Theirs');

        $r = $this->call(fn () => self::$ctrl->create($this->request($owner, ['name' => 'Sneaky App', 'formIds' => [$ownForm, $strangerForm]]), new SlimResponse()));
        $this->assertSame(400, $r['status']);
        $this->assertSame(0, $this->ownerAppCount($owner));
        $this->assertSame(0, $this->appFormCount($ownForm));
        $this->assertSame(0, $this->appFormCount($strangerForm));
    }

    // -------------------------------------------------------------------------
    // GET /api/apps — canManage / canCreateCompanion
    // -------------------------------------------------------------------------

    public function testAppsListShowsCanManageTrueForOwnerFalseForMember(): void
    {
        $owner = $this->makeUser();
        $member = $this->makeUser();
        $app = $this->makeApp($owner, 'Shared App');
        $this->addMember($app['id'], $member);

        $ownerList = $this->call(fn () => self::$ctrl->index($this->request($owner), new SlimResponse()));
        $this->assertSame(200, $ownerList['status']);
        $ownerRow = null;
        foreach ($ownerList['body']['apps'] as $a) {
            if ($a['id'] === $app['id']) {
                $ownerRow = $a;
            }
        }
        $this->assertNotNull($ownerRow);
        $this->assertTrue($ownerRow['canManage']);
        $this->assertTrue($ownerRow['canCreateCompanion']);
        $this->assertSame($owner, $ownerRow['ownerId'] ?? null, 'owner still sees their own ownerId');

        $memberList = $this->call(fn () => self::$ctrl->index($this->request($member), new SlimResponse()));
        $this->assertSame(200, $memberList['status']);
        $memberRow = null;
        foreach ($memberList['body']['apps'] as $a) {
            if ($a['id'] === $app['id']) {
                $memberRow = $a;
            }
        }
        $this->assertNotNull($memberRow, 'member still sees the app in the list');
        $this->assertFalse($memberRow['canManage']);
        $this->assertFalse($memberRow['canCreateCompanion']);
        $this->assertArrayNotHasKey('ownerId', $memberRow, 'ownerId privacy stripping unchanged');
    }

    // -------------------------------------------------------------------------
    // GET /api/apps/form-usage
    // -------------------------------------------------------------------------

    public function testFormUsageReturnsBatchShapeForOwnerAndMemberApps(): void
    {
        $owner = $this->makeUser();
        $member = $this->makeUser();
        $formA = $this->makeForm($owner, 'Jobs');
        $formB = $this->makeForm($owner, 'Vehicles');
        $appWithForms = $this->makeApp($owner, 'Ops App');
        $emptyApp = $this->makeApp($owner, 'Empty App');

        self::$apps->addFormToApp($appWithForms['id'], $formA, 'Job Sheet');
        self::$apps->addFormToApp($appWithForms['id'], $formB);
        self::$apps->updateAppForm($appWithForms['id'], $formB, ['isVisible' => false]);
        $this->addMember($appWithForms['id'], $member);

        // Owner: both apps, canManage=true, forms in sort order with the contract keys.
        $r = $this->call(fn () => self::$ctrl->formUsage($this->request($owner), new SlimResponse()));
        $this->assertSame(200, $r['status']);
        $byApp = [];
        foreach ($r['body']['apps'] as $a) {
            $this->assertSame(['appId', 'appName', 'slug', 'canManage', 'forms'], array_keys($a), 'contract shape per app');
            $byApp[$a['appId']] = $a;
        }
        $this->assertArrayHasKey($appWithForms['id'], $byApp);
        $this->assertArrayHasKey($emptyApp['id'], $byApp);
        $this->assertTrue($byApp[$appWithForms['id']]['canManage']);
        $this->assertSame('Ops App', $byApp[$appWithForms['id']]['appName']);
        $this->assertSame($appWithForms['slug'], $byApp[$appWithForms['id']]['slug']);
        $this->assertSame([], $byApp[$emptyApp['id']]['forms']);

        $forms = $byApp[$appWithForms['id']]['forms'];
        $this->assertCount(2, $forms);
        foreach ($forms as $f) {
            $this->assertSame(['formId', 'displayName', 'sortOrder', 'isVisible'], array_keys($f), 'contract shape per form');
        }
        $this->assertSame([$formA, $formB], array_column($forms, 'formId'));
        $this->assertSame(['Job Sheet', 'Vehicles'], array_column($forms, 'displayName'), 'display name falls back to the form title');
        $this->assertSame([0, 1], array_column($forms, 'sortOrder'));
        $this->assertSame([true, false], array_column($forms, 'isVisible'));

        // Member: sees the shared app (same visibility as GET /api/apps) with canManage=false.
        $r = $this->call(fn () => self::$ctrl->formUsage($this->request($member), new SlimResponse()));
        $this->assertSame(200, $r['status']);
        $memberApps = array_column($r['body']['apps'], null, 'appId');
        $this->assertArrayHasKey($appWithForms['id'], $memberApps);
        $this->assertArrayNotHasKey($emptyApp['id'], $memberApps, 'apps the member is not in must not appear');
        $this->assertFalse($memberApps[$appWithForms['id']]['canManage']);
        $this->assertCount(2, $memberApps[$appWithForms['id']]['forms']);
    }

    // -------------------------------------------------------------------------
    // PUT /api/apps/{id}/forms/reorder — exact-set validation
    // -------------------------------------------------------------------------

    public function testReorderRejectsDuplicateMissingAndForeignIds(): void
    {
        $owner = $this->makeUser();
        $formA = $this->makeForm($owner, 'A');
        $formB = $this->makeForm($owner, 'B');
        $foreignForm = $this->makeForm($owner, 'Elsewhere');
        $app = $this->makeApp($owner, 'Reorder App');
        self::$apps->addFormToApp($app['id'], $formA);
        self::$apps->addFormToApp($app['id'], $formB);

        $attempts = [
            'duplicate' => [$formA, $formA],
            'missing' => [$formA],
            'foreign' => [$formA, $foreignForm],
            'foreign-extra' => [$formA, $formB, $foreignForm],
        ];
        foreach ($attempts as $label => $ids) {
            $r = $this->call(fn () => self::$ctrl->reorderForms($this->request($owner, ['formIds' => $ids]), new SlimResponse(), ['id' => $app['id']]));
            $this->assertSame(400, $r['status'], "$label ids must be rejected");
        }

        // Nothing moved: original order intact after every rejected attempt.
        $this->assertSame([$formA, $formB], array_column(self::$apps->getAppForms($app['id']), 'formId'));

        // A valid permutation still works and renumbers sort_order.
        $r = $this->call(fn () => self::$ctrl->reorderForms($this->request($owner, ['formIds' => [$formB, $formA]]), new SlimResponse(), ['id' => $app['id']]));
        $this->assertSame(200, $r['status']);
        $forms = self::$apps->getAppForms($app['id']);
        $this->assertSame([$formB, $formA], array_column($forms, 'formId'));
        $this->assertSame([0, 1], array_column($forms, 'sortOrder'));
    }

    // -------------------------------------------------------------------------
    // PUT /api/apps/{id}/forms/{formId} — payload hardening
    // -------------------------------------------------------------------------

    public function testUpdateAppFormRejectsUnknownKeysAndBadValues(): void
    {
        $owner = $this->makeUser();
        $formId = $this->makeForm($owner, 'Original');
        $app = $this->makeApp($owner, 'Update App');
        self::$apps->addFormToApp($app['id'], $formId);

        $update = fn (array $body) => $this->call(
            fn () => self::$ctrl->updateForm($this->request($owner, $body), new SlimResponse(), ['id' => $app['id'], 'formId' => $formId])
        );

        // Unknown keys → 400 (typos like display_name must not be silently ignored).
        $this->assertSame(400, $update(['display_name' => 'typo'])['status']);
        $this->assertSame(400, $update(['displayName' => 'ok', 'sortOrder' => 3])['status']);

        // Display name: blank and overlong rejected; valid input is trimmed.
        $this->assertSame(400, $update(['displayName' => '   '])['status']);
        $this->assertSame(400, $update(['displayName' => str_repeat('x', 256)])['status'], 'overlong display name must be rejected');

        // Settings: must be an object, capped at 16KB.
        $this->assertSame(400, $update(['settings' => ['a', 'b']])['status'], 'a JSON list is not an object');
        $this->assertSame(400, $update(['settings' => ['blob' => str_repeat('x', 17000)]])['status'], 'oversized settings rejected');

        // Nothing above may have written anything.
        $forms = self::$apps->getAppForms($app['id']);
        $this->assertSame('Original', $forms[0]['displayName']);

        // A valid update still works (and trims).
        $r = $update(['displayName' => '  Renamed Tab  ', 'isVisible' => false, 'settings' => ['icon' => 'truck']]);
        $this->assertSame(200, $r['status']);
        $forms = self::$apps->getAppForms($app['id']);
        $this->assertSame('Renamed Tab', $forms[0]['displayName']);
        $this->assertFalse($forms[0]['isVisible']);
        $this->assertSame(['icon' => 'truck'], $forms[0]['settings']);
    }

    // -------------------------------------------------------------------------
    // Schema
    // -------------------------------------------------------------------------

    public function testSchemaHasFormIdIndexAndAlignedAppsColumns(): void
    {
        $hasIdx = self::$pdo->query("SHOW INDEX FROM app_forms WHERE Key_name = 'idx_form_id'")->rowCount() > 0;
        $this->assertTrue($hasIdx, 'app_forms must carry idx_form_id (form_id) — fresh CREATE TABLE and migration both provide it');

        // Fresh-schema alignment: the columns migrations add to apps exist (createApp
        // INSERTs custom_logic, so a fresh install must have it without migrations).
        foreach (['reports', 'custom_logic'] as $col) {
            $has = self::$pdo->query("SHOW COLUMNS FROM apps LIKE '$col'")->rowCount() > 0;
            $this->assertTrue($has, "apps.$col must exist");
        }
    }
}
