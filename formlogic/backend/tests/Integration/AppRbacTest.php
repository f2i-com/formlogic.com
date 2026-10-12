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

    /**
     * App-level grants are the owner's to manage: the backend refuses a non-owner who adds one,
     * and the role editor shows them disabled to a non-owner (AppRoleEditor appLevelDisabled).
     * A non-owner's save must therefore leave them exactly as they are, in both directions: a
     * save that drops them must not strip the Admin role, and a save that carries them unchanged
     * (what the editor sends) must go through.
     */
    public function testANonOwnerSaveLeavesTheRolesAppLevelGrantsAsTheyAre(): void
    {
        $owner = $this->makeUser();
        $appId = $this->makeApp($owner);
        $form = $this->makeForm($owner);
        self::$pdo->prepare("INSERT INTO app_forms (id, app_id, form_id, display_name, sort_order, is_visible, settings) VALUES (?, ?, ?, 'T', 0, 1, '{}')")
            ->execute(['af-' . $this->uuid(), $appId, $form]);
        $admin = $this->makeRole($appId, 'Admin');
        $this->grant($admin, AppPermissions::MANAGE_APP);
        $this->grant($admin, AppPermissions::MANAGE_USERS);
        $current = static fn (): array => array_map(
            static fn (array $p): string => $p['permission'] . '@' . ($p['formId'] ?? '*'),
            self::$svc->getRolePermissions($admin)
        );

        $refused = null;
        try {
            self::$svc->setRolePermissions($admin, [['formId' => $form, 'permission' => AppPermissions::VIEW_ALL_RESPONSES]], false);
        } catch (\RuntimeException $e) {
            $refused = $e;
        }
        $this->assertNotNull($refused, 'a non-owner save that drops app-level grants must be refused');
        $this->assertEqualsCanonicalizing([AppPermissions::MANAGE_APP . '@*', AppPermissions::MANAGE_USERS . '@*'], $current());

        // The editor's save: the app-level grants unchanged, a form grant added.
        self::$svc->setRolePermissions($admin, [
            ['formId' => null, 'permission' => AppPermissions::MANAGE_APP],
            ['formId' => null, 'permission' => AppPermissions::MANAGE_USERS],
            ['formId' => $form, 'permission' => AppPermissions::VIEW_ALL_RESPONSES],
        ], false);
        $this->assertEqualsCanonicalizing(
            [AppPermissions::MANAGE_APP . '@*', AppPermissions::MANAGE_USERS . '@*', AppPermissions::VIEW_ALL_RESPONSES . '@' . $form],
            $current()
        );

        // The owner may still change them.
        self::$svc->setRolePermissions($admin, [['formId' => $form, 'permission' => AppPermissions::VIEW_ALL_RESPONSES]], true);
        $this->assertSame([AppPermissions::VIEW_ALL_RESPONSES . '@' . $form], $current());
    }

    /**
     * The non-owner check has to judge what the save would STORE, not what the request says.
     * An app-level grant sent with a formId the save then skips (an empty string, false, a form
     * of another app) read as "unchanged" and was dropped by the rewrite: a delegated
     * MANAGE_ROLES holder stripped the Admin role with one request.
     */
    public function testANonOwnerCannotDropAppLevelGrantsByNamingAFormTheSaveSkips(): void
    {
        $owner = $this->makeUser();
        $appId = $this->makeApp($owner);
        $form = $this->makeForm($owner);
        self::$pdo->prepare("INSERT INTO app_forms (id, app_id, form_id, display_name, sort_order, is_visible, settings) VALUES (?, ?, ?, 'T', 0, 1, '{}')")
            ->execute(['af-' . $this->uuid(), $appId, $form]);
        $admin = $this->makeRole($appId, 'Admin');
        $this->grant($admin, AppPermissions::MANAGE_APP);
        $this->grant($admin, AppPermissions::MANAGE_USERS);
        $this->grant($admin, AppPermissions::VIEW_ANALYTICS, $form);
        $kept = [AppPermissions::MANAGE_APP . '@*', AppPermissions::MANAGE_USERS . '@*', AppPermissions::VIEW_ANALYTICS . '@' . $form];
        $current = static fn (): array => array_map(
            static fn (array $p): string => $p['permission'] . '@' . ($p['formId'] ?? '*'),
            self::$svc->getRolePermissions($admin)
        );

        foreach (['an empty string' => '', 'false' => false, 'a form of no app' => 'no-such-form'] as $label => $skipped) {
            $refused = null;
            try {
                self::$svc->setRolePermissions($admin, [
                    ['formId' => $skipped, 'permission' => AppPermissions::MANAGE_APP],
                    ['formId' => $skipped, 'permission' => AppPermissions::MANAGE_USERS],
                    ['formId' => $form, 'permission' => AppPermissions::VIEW_ANALYTICS],
                ], false);
            } catch (\RuntimeException $e) {
                $refused = $e;
            }
            $this->assertEqualsCanonicalizing($kept, $current(), "formId $label must not drop the role's app-level grants");
            $this->assertNotNull($refused, "a non-owner save with formId $label is refused, not half applied");
        }

        // Nor may the same trick move a form-scoped grant app-wide, or the other way round.
        foreach ([
            [['formId' => null, 'permission' => AppPermissions::MANAGE_APP], ['formId' => null, 'permission' => AppPermissions::MANAGE_USERS], ['formId' => null, 'permission' => AppPermissions::VIEW_ANALYTICS]],
            [['formId' => $form, 'permission' => AppPermissions::MANAGE_APP], ['formId' => null, 'permission' => AppPermissions::MANAGE_USERS], ['formId' => $form, 'permission' => AppPermissions::VIEW_ANALYTICS]],
        ] as $attempt) {
            $refused = null;
            try {
                self::$svc->setRolePermissions($admin, $attempt, false);
            } catch (\RuntimeException $e) {
                $refused = $e;
            }
            $this->assertNotNull($refused);
            $this->assertEqualsCanonicalizing($kept, $current());
        }

        // The editor's own save (every app-level grant back as it is, listed twice by a slow
        // double click) still goes through, and stores each grant once.
        $asIs = [
            ['formId' => null, 'permission' => AppPermissions::MANAGE_APP],
            ['formId' => null, 'permission' => AppPermissions::MANAGE_USERS],
            ['formId' => $form, 'permission' => AppPermissions::VIEW_ANALYTICS],
        ];
        self::$svc->setRolePermissions($admin, array_merge($asIs, $asIs, [['formId' => $form, 'permission' => AppPermissions::SUBMIT_RESPONSES]]), false);
        $this->assertEqualsCanonicalizing(array_merge($kept, [AppPermissions::SUBMIT_RESPONSES . '@' . $form]), $current());
    }

    /**
     * A role holds grants only on the app's forms: a save stores none on a form outside the app
     * and keeps none it finds there (by design, see setRolePermissions). Taking a form out of the
     * app left its grants in place, though, until some later save of the role dropped them, so
     * putting the form back gave its old access back to whoever held it, or not, depending on
     * whether anyone had saved the role in between. The grants go with the form now.
     */
    public function testAFormTakenOutOfTheAppTakesTheRolesGrantsOnItWithIt(): void
    {
        $owner = $this->makeUser();
        $appId = $this->makeApp($owner);
        $form = $this->makeForm($owner);
        $other = $this->makeForm($owner);
        $forms = new \FormLogic\Services\FormService(self::$mysql, new \FormLogic\Database\SQLiteConnection(sys_get_temp_dir() . '/fl-rbac-' . $this->uuid()));
        $apps = new \FormLogic\Services\AppService(self::$mysql, $forms);
        $apps->addFormToApp($appId, $form);
        $apps->addFormToApp($appId, $other);
        $reviewers = $this->makeRole($appId, 'Reviewers');
        self::$svc->setRolePermissions($reviewers, [
            ['formId' => $form, 'permission' => AppPermissions::VIEW_ALL_RESPONSES],
            ['formId' => $form, 'permission' => AppPermissions::VIEW_ANALYTICS],
            ['formId' => $other, 'permission' => AppPermissions::VIEW_ALL_RESPONSES],
        ], true);
        $member = $this->makeUser();
        $this->addMember($appId, $member, $reviewers);
        $this->assertTrue(self::$svc->hasPermission($appId, $member, AppPermissions::VIEW_ALL_RESPONSES, $form));

        $apps->removeFormFromApp($appId, $form);
        $held = array_map(static fn (array $p): string => $p['permission'] . '@' . ($p['formId'] ?? '*'), self::$svc->getRolePermissions($reviewers));
        $this->assertSame([AppPermissions::VIEW_ALL_RESPONSES . '@' . $other], $held, 'the grants on the removed form are gone; the rest stay');

        $apps->addFormToApp($appId, $form);
        $this->assertFalse(
            self::$svc->hasPermission($appId, $member, AppPermissions::VIEW_ALL_RESPONSES, $form),
            'putting the form back does not give its old access back'
        );
        $this->assertTrue(self::$svc->hasPermission($appId, $member, AppPermissions::VIEW_ALL_RESPONSES, $other));
    }

    /**
     * Only the owner gives app-level permissions (grants, role assignments, invitations), so only
     * the owner takes them away: a delegated MANAGE_USERS holder may not change the role of, suspend
     * or remove a member whose role grants any app-level permission. Members below that line stay
     * theirs to manage.
     */
    public function testOnlyTheOwnerChangesAMemberWhoHoldsAnAppLevelRole(): void
    {
        $owner = $this->makeUser();
        $appId = $this->makeApp($owner);
        $adminRole = $this->makeRole($appId, 'Admin');
        $this->grant($adminRole, AppPermissions::MANAGE_APP);
        $managerRole = $this->makeRole($appId, 'People manager');
        $this->grant($managerRole, AppPermissions::MANAGE_USERS);
        $memberRole = $this->makeRole($appId, 'Member');
        $this->grant($memberRole, AppPermissions::VIEW_OWN_RESPONSES);

        $manager = $this->makeUser();
        $this->addMember($appId, $manager, $managerRole);
        $admin = $this->makeUser();
        $this->addMember($appId, $admin, $adminRole);
        $member = $this->makeUser();
        $this->addMember($appId, $member, $memberRole);
        $appUserId = function (string $userId) use ($appId): string {
            $stmt = self::$pdo->prepare('SELECT id FROM app_users WHERE app_id = ? AND user_id = ?');
            $stmt->execute([$appId, $userId]);
            return (string) $stmt->fetchColumn();
        };
        $refusedBy = function (callable $action): ?string {
            try {
                $action();
            } catch (\RuntimeException $e) {
                return $e->getMessage();
            }
            return null;
        };

        foreach ([
            'change their role' => fn () => self::$svc->updateAppUser($appUserId($admin), ['roleId' => $memberRole], $manager, $appId),
            'suspend them' => fn () => self::$svc->updateAppUser($appUserId($admin), ['status' => 'suspended'], $manager, $appId),
            'remove them' => fn () => self::$svc->removeAppUser($appUserId($admin), $manager, $appId),
        ] as $label => $action) {
            $this->assertNotNull($refusedBy($action), "a delegated manager must not $label");
        }
        $this->assertTrue(self::$svc->hasPermission($appId, $admin, AppPermissions::MANAGE_APP), 'the admin keeps their role and status');

        // A member below the line is still the delegated manager's to manage.
        $this->assertNull($refusedBy(fn () => self::$svc->updateAppUser($appUserId($member), ['status' => 'suspended'], $manager, $appId)));
        $this->assertNull($refusedBy(fn () => self::$svc->removeAppUser($appUserId($member), $manager, $appId)));

        // The owner may change the admin.
        $this->assertNull($refusedBy(fn () => self::$svc->updateAppUser($appUserId($admin), ['roleId' => $memberRole], $owner, $appId)));
        $this->assertFalse(self::$svc->hasPermission($appId, $admin, AppPermissions::MANAGE_APP));
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
