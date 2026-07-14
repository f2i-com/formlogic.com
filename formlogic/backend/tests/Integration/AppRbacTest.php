<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Constants\AppPermissions;
use FormLogic\Database\MySQLConnection;
use FormLogic\Services\AppUserService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Exercises AppUserService::hasPermission against a real MySQL DB — the app-runtime RBAC matrix.
 * Skipped unless a test database is reachable (same setup as PlanEnforcementTest:
 * DB_TEST_DATABASE / DB_HOST / DB_USERNAME / DB_PASSWORD; CI provides MySQL).
 *
 * Covers: owner bypass; view-own vs view-all; edit-without-view-all; app-level vs form-scoped
 * permissions; suspended / pending / non-member denial.
 */
class AppRbacTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static AppUserService $svc;

    /** @var string[] */
    private array $userIds = [];
    /** @var string[] */
    private array $formIds = [];
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
        self::$svc = new AppUserService($conn);
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
            // app_users.role_id → app_roles is ON DELETE RESTRICT, so delete children in
            // FK-safe order rather than relying on cascade ordering.
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

    private function uuid(): string
    {
        // 28 hex chars so prefixed ids ('role-' + uuid, etc.) stay within varchar(36) —
        // otherwise MySQL silently truncates and FK/lookup comparisons mismatch.
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

    private function makeApp(string $ownerId): string
    {
        $id = 'app-' . $this->uuid();
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'Test App', ?, 'published')")
            ->execute([$id, $ownerId, 'rbac-' . substr($this->uuid(), 0, 12)]);
        $this->appId = $id;
        return $id;
    }

    private function makeRole(string $appId, string $name): string
    {
        $id = 'role-' . $this->uuid();
        self::$pdo->prepare("INSERT INTO app_roles (id, app_id, name, is_system, sort_order) VALUES (?, ?, ?, 0, 0)")
            ->execute([$id, $appId, $name]);
        return $id;
    }

    private function grant(string $roleId, string $permission, ?string $formId = null): void
    {
        self::$pdo->prepare("INSERT INTO app_role_permissions (id, role_id, form_id, permission) VALUES (?, ?, ?, ?)")
            ->execute(['arp-' . $this->uuid(), $roleId, $formId, $permission]);
    }

    private function addMember(string $appId, string $userId, string $roleId, string $status = 'active'): void
    {
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, ?, NOW())")
            ->execute(['au-' . $this->uuid(), $appId, $userId, $roleId, $status]);
    }

    private function makeForm(string $ownerId): string
    {
        $id = 'form-' . $this->uuid();
        self::$pdo->prepare("INSERT INTO forms (id, user_id, title, status) VALUES (?, ?, 'T', 'draft')")
            ->execute([$id, $ownerId]);
        $this->formIds[] = $id;
        return $id;
    }

    public function testOwnerHasEveryPermission(): void
    {
        $owner = $this->makeUser();
        $appId = $this->makeApp($owner);
        // Owner needs a membership row to resolve a role, but the owner_id bypass grants all.
        $role = $this->makeRole($appId, 'Owner');
        $this->addMember($appId, $owner, $role);
        foreach (AppPermissions::ALL as $perm) {
            $this->assertTrue(self::$svc->hasPermission($appId, $owner, $perm), "owner should have $perm");
        }
    }

    public function testViewOwnRoleCannotViewAll(): void
    {
        $owner = $this->makeUser();
        $appId = $this->makeApp($owner);
        $role = $this->makeRole($appId, 'Submitter');
        $this->grant($role, AppPermissions::VIEW_OWN_RESPONSES);
        $member = $this->makeUser();
        $this->addMember($appId, $member, $role);

        $this->assertTrue(self::$svc->hasPermission($appId, $member, AppPermissions::VIEW_OWN_RESPONSES));
        $this->assertFalse(self::$svc->hasPermission($appId, $member, AppPermissions::VIEW_ALL_RESPONSES));
        $this->assertFalse(self::$svc->hasPermission($appId, $member, AppPermissions::DELETE_RESPONSES));
    }

    public function testEditWithoutViewAll(): void
    {
        $owner = $this->makeUser();
        $appId = $this->makeApp($owner);
        $role = $this->makeRole($appId, 'Editor');
        $this->grant($role, AppPermissions::EDIT_RESPONSES);
        $member = $this->makeUser();
        $this->addMember($appId, $member, $role);

        $this->assertTrue(self::$svc->hasPermission($appId, $member, AppPermissions::EDIT_RESPONSES));
        $this->assertFalse(self::$svc->hasPermission($appId, $member, AppPermissions::VIEW_ALL_RESPONSES));
    }

    public function testFormScopedPermissionDoesNotLeakToOtherForms(): void
    {
        $owner = $this->makeUser();
        $appId = $this->makeApp($owner);
        $role = $this->makeRole($appId, 'FormViewer');
        $formA = $this->makeForm($owner);
        $formB = $this->makeForm($owner);
        $this->grant($role, AppPermissions::VIEW_ALL_RESPONSES, $formA);
        $member = $this->makeUser();
        $this->addMember($appId, $member, $role);

        $this->assertTrue(self::$svc->hasPermission($appId, $member, AppPermissions::VIEW_ALL_RESPONSES, $formA));
        $this->assertFalse(self::$svc->hasPermission($appId, $member, AppPermissions::VIEW_ALL_RESPONSES, $formB));
    }

    public function testAppLevelPermissionAppliesToAnyForm(): void
    {
        $owner = $this->makeUser();
        $appId = $this->makeApp($owner);
        $role = $this->makeRole($appId, 'GlobalViewer');
        $this->grant($role, AppPermissions::VIEW_ALL_RESPONSES, null); // form_id NULL = app-wide
        $member = $this->makeUser();
        $this->addMember($appId, $member, $role);

        $this->assertTrue(self::$svc->hasPermission($appId, $member, AppPermissions::VIEW_ALL_RESPONSES, 'any-form'));
        $this->assertTrue(self::$svc->hasPermission($appId, $member, AppPermissions::VIEW_ALL_RESPONSES));
    }

    public function testSuspendedAndPendingMembersDenied(): void
    {
        $owner = $this->makeUser();
        $appId = $this->makeApp($owner);
        $role = $this->makeRole($appId, 'Member');
        $this->grant($role, AppPermissions::VIEW_OWN_RESPONSES);

        $suspended = $this->makeUser();
        $this->addMember($appId, $suspended, $role, 'suspended');
        $this->assertFalse(self::$svc->hasPermission($appId, $suspended, AppPermissions::VIEW_OWN_RESPONSES));

        $pending = $this->makeUser();
        $this->addMember($appId, $pending, $role, 'pending');
        $this->assertFalse(self::$svc->hasPermission($appId, $pending, AppPermissions::VIEW_OWN_RESPONSES));
    }

    public function testNonMemberDenied(): void
    {
        $owner = $this->makeUser();
        $appId = $this->makeApp($owner);
        $stranger = $this->makeUser(); // never added to the app
        $this->assertFalse(self::$svc->hasPermission($appId, $stranger, AppPermissions::VIEW_OWN_RESPONSES));
        $this->assertFalse(self::$svc->hasPermission($appId, $stranger, AppPermissions::SUBMIT_RESPONSES));
    }
}
