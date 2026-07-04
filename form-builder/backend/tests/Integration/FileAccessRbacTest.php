<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Constants\AppPermissions;
use FormLogic\Controllers\FileController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FileStorageService;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;

/**
 * Exercises FileController::authorizeFileAccess for app-scoped files — the P0 RBAC fix.
 * Files are gated on an EXPLICIT form permission (not mere app membership):
 *   owner → any; VIEW_ALL → any; VIEW_OWN → only files on the caller's own responses; else deny.
 *
 * FormService + ResponseService are mocked (so we control form status + file→owner linkage); the
 * permission/app-membership resolution runs against real AppService/AppUserService + MySQL.
 * Skipped unless a test database is reachable (same env as AppRbacTest).
 */
class FileAccessRbacTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;

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

    private function makeApp(string $ownerId): string
    {
        $id = 'app-' . $this->uuid();
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'Test App', ?, 'published')")
            ->execute([$id, $ownerId, 'files-' . substr($this->uuid(), 0, 12)]);
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

    private function addMember(string $appId, string $userId, string $roleId): void
    {
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, 'active', NOW())")
            ->execute(['au-' . $this->uuid(), $appId, $userId, $roleId]);
    }

    private function makeForm(string $ownerId): string
    {
        $id = 'form-' . $this->uuid();
        self::$pdo->prepare("INSERT INTO forms (id, user_id, title, status) VALUES (?, ?, 'T', 'draft')")
            ->execute([$id, $ownerId]);
        $this->formIds[] = $id;
        return $id;
    }

    private function addFormToApp(string $appId, string $formId): void
    {
        self::$pdo->prepare("INSERT INTO app_forms (id, app_id, form_id, display_name, sort_order, is_visible, settings) VALUES (?, ?, ?, 'T', 0, 1, '{}')")
            ->execute(['af-' . $this->uuid(), $appId, $formId]);
    }

    /** A FileController whose FormService + ResponseService are stubbed; AppService/AppUserService are real. */
    private function controller(string $appFormId, string $owner, string $publicFormId, string $ownerOfFileUser, string $ownFileId): FileController
    {
        $formService = $this->createMock(FormService::class);
        $formService->method('getForm')->willReturnCallback(function (string $id) use ($appFormId, $owner, $publicFormId) {
            if ($id === $appFormId) {
                return ['id' => $id, 'userId' => $owner, 'status' => 'draft'];
            }
            if ($id === $publicFormId) {
                return ['id' => $id, 'userId' => $owner, 'status' => 'published'];
            }
            return null;
        });

        $responseService = $this->createMock(ResponseService::class);
        $responseService->method('userOwnsFile')->willReturnCallback(
            fn(string $fid, string $file, string $uid) => $fid === $appFormId && $file === $ownFileId && $uid === $ownerOfFileUser
        );

        $storage = new FileStorageService(['storagePath' => sys_get_temp_dir() . '/fl-test-' . $this->uuid()]);

        return new FileController(
            $storage,
            $formService,
            new AppService(self::$mysql, $formService),
            new AppUserService(self::$mysql),
            null,
            $responseService
        );
    }

    private function can(FileController $fc, ?string $userId, string $formId, string $fileId): bool
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn($name) => $name === 'userId' ? $userId : null);
        $m = new \ReflectionMethod(FileController::class, 'authorizeFileAccess');
        $m->setAccessible(true);
        return (bool) $m->invoke($fc, $req, $formId, $fileId);
    }

    public function testAppFileRbacMatrix(): void
    {
        $owner = $this->makeUser();
        $appId = $this->makeApp($owner);
        $appForm = $this->makeForm($owner);
        $publicForm = $this->makeForm($owner);
        $this->addFormToApp($appId, $appForm);

        $viewAllRole = $this->makeRole($appId, 'ViewAll');
        $this->grant($viewAllRole, AppPermissions::VIEW_ALL_RESPONSES);
        $viewOwnRole = $this->makeRole($appId, 'ViewOwn');
        $this->grant($viewOwnRole, AppPermissions::VIEW_OWN_RESPONSES);
        $noneRole = $this->makeRole($appId, 'SubmitOnly');
        $this->grant($noneRole, AppPermissions::SUBMIT_RESPONSES);

        $userAll = $this->makeUser();
        $userOwn = $this->makeUser();
        $userNone = $this->makeUser();
        $stranger = $this->makeUser();
        $this->addMember($appId, $userAll, $viewAllRole);
        $this->addMember($appId, $userOwn, $viewOwnRole);
        $this->addMember($appId, $userNone, $noneRole);

        $ownFile = 'FILEOWN';
        $otherFile = 'FILEOTHER';
        $fc = $this->controller($appForm, $owner, $publicForm, $userOwn, $ownFile);

        // Owner: any file.
        $this->assertTrue($this->can($fc, $owner, $appForm, $otherFile), 'owner can access any app file');
        // VIEW_ALL: any file.
        $this->assertTrue($this->can($fc, $userAll, $appForm, $otherFile), 'view_all can access any app file');
        // VIEW_OWN: own file yes, other file no.
        $this->assertTrue($this->can($fc, $userOwn, $appForm, $ownFile), 'view_own can access its OWN file');
        $this->assertFalse($this->can($fc, $userOwn, $appForm, $otherFile), 'view_own CANNOT access another user\'s file');
        // Submit-only member: denied even knowing the URL.
        $this->assertFalse($this->can($fc, $userNone, $appForm, $ownFile), 'submit-only member is denied');
        // Non-member: denied.
        $this->assertFalse($this->can($fc, $stranger, $appForm, $ownFile), 'non-member is denied');
        // Anonymous: denied for app-scoped.
        $this->assertFalse($this->can($fc, null, $appForm, $ownFile), 'anonymous is denied app files');

        // Standalone published form: files remain public (unchanged behaviour).
        $this->assertTrue($this->can($fc, null, $publicForm, 'anything'), 'standalone published form files stay public');
    }
}
