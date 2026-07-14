<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Constants\AppPermissions;
use FormLogic\Controllers\FileController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FileStorageService;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Response as SlimResponse;

/**
 * Route-level tests for FileController::serve() — real services (MySQL + per-form SQLite + on-disk
 * files), not the private authorize method in isolation. Verifies status codes, cache headers, and
 * the P1 fixes: VIEW_OWN reaches an own file even when it's on an OLD response (past the 100-row
 * pagination), VIEW_OWN cannot reach another user's file. Skipped without a test database.
 */
class FileServeRouteTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static string $tmp = '';
    private static SQLiteConnection $sqlite;
    private static FileStorageService $files;
    private static FileController $fc;

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
        self::$tmp = sys_get_temp_dir() . '/fl-serve-' . bin2hex(random_bytes(6));
        @mkdir(self::$tmp . '/forms', 0777, true);
        @mkdir(self::$tmp . '/uploads', 0777, true);
        self::$sqlite = new SQLiteConnection(self::$tmp . '/forms');
        self::$files = new FileStorageService(['storagePath' => self::$tmp . '/uploads', 'receiptSecret' => 'test-receipt-secret']);
        $formService = new FormService($conn, self::$sqlite);
        self::$fc = new FileController(
            self::$files,
            $formService,
            new AppService($conn, $formService),
            new AppUserService($conn),
            null,
            new ResponseService($conn, self::$sqlite)
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

    private function makeApp(string $ownerId): string
    {
        $id = 'app' . $this->uuid();
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'T', ?, 'published')")
            ->execute([$id, $ownerId, 'srv' . substr($this->uuid(), 0, 10)]);
        $this->appId = $id;
        return $id;
    }

    private function makeRole(string $appId, string $perm): string
    {
        $id = 'role' . $this->uuid();
        self::$pdo->prepare("INSERT INTO app_roles (id, app_id, name, is_system, sort_order) VALUES (?, ?, ?, 0, 0)")->execute([$id, $appId, 'R' . substr($id, 0, 12)]);
        self::$pdo->prepare("INSERT INTO app_role_permissions (id, role_id, form_id, permission) VALUES (?, ?, NULL, ?)")->execute(['arp' . $this->uuid(), $id, $perm]);
        return $id;
    }

    private function addMember(string $appId, string $userId, string $roleId): void
    {
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, 'active', NOW())")
            ->execute(['au' . $this->uuid(), $appId, $userId, $roleId]);
    }

    private function makeForm(string $ownerId, string $status = 'draft', ?array $customScreen = null): string
    {
        $id = 'form' . $this->uuid();
        self::$pdo->prepare("INSERT INTO forms (id, user_id, title, status, custom_screen) VALUES (?, ?, 'T', ?, ?)")
            ->execute([$id, $ownerId, $status, $customScreen !== null ? json_encode($customScreen) : null]);
        $this->formIds[] = $id;
        return $id;
    }

    private function addFormToApp(string $appId, string $formId): void
    {
        self::$pdo->prepare("INSERT INTO app_forms (id, app_id, form_id, display_name, sort_order, is_visible, settings) VALUES (?, ?, ?, 'T', 0, 1, '{}')")
            ->execute(['af' . $this->uuid(), $appId, $formId]);
    }

    /** Direct SQLite insert so we control response age + file linkage without the submit pipeline. */
    private function insertResponse(string $formId, ?string $fileId, string $submittedBy, string $submittedAt): void
    {
        $db = self::$sqlite->getFormDatabase($formId);
        $answers = $fileId ? json_encode(['f1' => [['id' => $fileId, 'storedFilename' => $fileId . '.txt']]]) : '{}';
        $meta = json_encode(['submittedByUserId' => $submittedBy]);
        $db->prepare("INSERT INTO responses (id, answers, metadata, status, submitted_at) VALUES (?, ?, ?, 'submitted', ?)")
            ->execute(['r' . $this->uuid(), $answers, $meta, $submittedAt]);
    }

    /** A response whose only reference to $text is a plain TEXT answer (not file-upload metadata). */
    private function insertTextResponse(string $formId, string $text, string $submittedBy, string $submittedAt): void
    {
        $db = self::$sqlite->getFormDatabase($formId);
        $answers = json_encode(['note' => $text]);
        $meta = json_encode(['submittedByUserId' => $submittedBy]);
        $db->prepare("INSERT INTO responses (id, answers, metadata, status, submitted_at) VALUES (?, ?, ?, 'submitted', ?)")
            ->execute(['r' . $this->uuid(), $answers, $meta, $submittedAt]);
    }

    private function placeFile(string $formId, string $fileId): void
    {
        $dir = self::$tmp . '/uploads/' . $formId;
        @mkdir($dir, 0777, true);
        file_put_contents($dir . '/' . $fileId . '.txt', 'file-body');
    }

    /** @return array{status:int, cache:string} */
    private function serve(?string $userId, string $formId, string $fileId, array $query = []): array
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn($n) => $n === 'userId' ? $userId : null);
        $req->method('getQueryParams')->willReturn($query);
        $out = self::$fc->serve($req, new SlimResponse(), ['formId' => $formId, 'fileId' => $fileId]);
        return ['status' => $out->getStatusCode(), 'cache' => $out->getHeaderLine('Cache-Control')];
    }

    public function testAppFileServeRbacAndCacheHeaders(): void
    {
        $owner = $this->makeUser();
        $appId = $this->makeApp($owner);
        $form = $this->makeForm($owner);
        $this->addFormToApp($appId, $form);

        $userAll = $this->makeUser();
        $userOwn = $this->makeUser();
        $userNone = $this->makeUser();
        $this->addMember($appId, $userAll, $this->makeRole($appId, AppPermissions::VIEW_ALL_RESPONSES));
        $this->addMember($appId, $userOwn, $this->makeRole($appId, AppPermissions::VIEW_OWN_RESPONSES));
        $this->addMember($appId, $userNone, $this->makeRole($appId, AppPermissions::SUBMIT_RESPONSES));

        // userOwn's file lives on the OLDEST response, with 120 newer ones after it (past the 100 page).
        $ownFile = 'fileown' . substr($this->uuid(), 0, 6);
        $this->insertResponse($form, $ownFile, $userOwn, '2020-01-01 00:00:00');
        for ($i = 0; $i < 120; $i++) {
            $this->insertResponse($form, null, $userOwn, sprintf('2024-01-%02d %02d:00:00', ($i % 27) + 1, $i % 24));
        }
        // Another user's file.
        $otherFile = 'fileoth' . substr($this->uuid(), 0, 6);
        $this->insertResponse($form, $otherFile, $userAll, '2024-06-01 00:00:00');

        $this->placeFile($form, $ownFile);
        $this->placeFile($form, $otherFile);

        // VIEW_ALL → any file, private cache.
        $r = $this->serve($userAll, $form, $ownFile);
        $this->assertSame(200, $r['status']);
        $this->assertSame('private, no-store', $r['cache']);

        // VIEW_OWN → own file (on the OLDEST response, past the 100-row window) still 200. [#4]
        $this->assertSame(200, $this->serve($userOwn, $form, $ownFile)['status']);
        // VIEW_OWN → another user's file → 404.
        $this->assertSame(404, $this->serve($userOwn, $form, $otherFile)['status']);
        // Submit-only member → 404 even knowing the id.
        $this->assertSame(404, $this->serve($userNone, $form, $ownFile)['status']);
        // Anonymous → 404 for app-scoped.
        $this->assertSame(404, $this->serve(null, $form, $ownFile)['status']);
    }

    public function testViewOwnCannotReachFileMentionedOnlyInTextAnswer(): void
    {
        $owner = $this->makeUser();
        $appId = $this->makeApp($owner);
        $form = $this->makeForm($owner);
        $this->addFormToApp($appId, $form);
        $userAll = $this->makeUser();
        $userOwn = $this->makeUser();
        $this->addMember($appId, $userAll, $this->makeRole($appId, AppPermissions::VIEW_ALL_RESPONSES));
        $this->addMember($appId, $userOwn, $this->makeRole($appId, AppPermissions::VIEW_OWN_RESPONSES));

        $otherFile = 'secret' . substr($this->uuid(), 0, 6);
        // The file really belongs to userAll (attached via a file_upload field) and exists on disk.
        $this->insertResponse($form, $otherFile, $userAll, '2024-06-01 00:00:00');
        $this->placeFile($form, $otherFile);
        // userOwn types that file id into a TEXT field of their OWN response — must NOT grant access.
        $this->insertTextResponse($form, $otherFile, $userOwn, '2024-07-01 00:00:00');

        $this->assertSame(404, $this->serve($userOwn, $form, $otherFile)['status'], 'a file id in a text answer must not grant access');
        $this->assertSame(200, $this->serve($userAll, $form, $otherFile)['status'], 'view_all still reaches the real file');
    }

    public function testStandalonePublishedFormFileIsPrivateByDefault(): void
    {
        // FILE-PRIV-001: publishing a form no longer makes its uploads public —
        // knowing the URL must not be enough to fetch a response upload.
        $owner = $this->makeUser();
        $form = $this->makeForm($owner, 'published'); // NOT added to any app
        $file = 'prv' . substr($this->uuid(), 0, 8);
        $this->placeFile($form, $file);

        $this->assertSame(404, $this->serve(null, $form, $file)['status'], 'anonymous URL knowledge is not enough');

        // The form owner still reaches it, privately.
        $r = $this->serve($owner, $form, $file);
        $this->assertSame(200, $r['status']);
        $this->assertSame('private, no-store', $r['cache']);
    }

    public function testReceiptTokenGrantsBoundedAnonymousAccess(): void
    {
        $owner = $this->makeUser();
        $form = $this->makeForm($owner, 'published');
        $file = 'rcp' . substr($this->uuid(), 0, 8);
        $otherFile = 'oth' . substr($this->uuid(), 0, 8);
        $this->placeFile($form, $file);
        $this->placeFile($form, $otherFile);

        $token = self::$files->mintReceiptToken($form, $file);
        $this->assertNotNull($token);

        // Valid receipt → 200, but NEVER shared-cacheable.
        $r = $this->serve(null, $form, $file, ['rt' => $token]);
        $this->assertSame(200, $r['status']);
        $this->assertSame('private, no-store', $r['cache']);

        // The token is bound to ONE file — it opens nothing else.
        $this->assertSame(404, $this->serve(null, $form, $otherFile, ['rt' => $token])['status']);
        // Tampered token → denied.
        $this->assertSame(404, $this->serve(null, $form, $file, ['rt' => $token . 'x'])['status']);
        // Expired token → denied.
        $expired = self::$files->mintReceiptToken($form, $file, -10);
        $this->assertSame(404, $this->serve(null, $form, $file, ['rt' => $expired])['status']);
    }

    public function testExplicitPublicAssetPolicyViaPublicRecordFields(): void
    {
        // The ONLY public case: owner enabled customScreen.publicRecords AND whitelisted
        // the field the file is attached under. Publicity is an explicit opt-in.
        $owner = $this->makeUser();
        $form = $this->makeForm($owner, 'published', [
            'publicRecords' => true,
            'publicRecordFields' => ['f1'],
        ]);
        $publicFile = 'pub' . substr($this->uuid(), 0, 8);
        $privateFile = 'sec' . substr($this->uuid(), 0, 8);
        $this->placeFile($form, $publicFile);
        $this->placeFile($form, $privateFile);
        // publicFile attached under whitelisted field f1 (insertResponse uses f1).
        $this->insertResponse($form, $publicFile, $owner, '2024-06-01 00:00:00');
        // privateFile attached under a NON-whitelisted field.
        $db = self::$sqlite->getFormDatabase($form);
        $db->prepare("INSERT INTO responses (id, answers, metadata, status, submitted_at) VALUES (?, ?, '{}', 'submitted', ?)")
            ->execute(['r' . $this->uuid(), json_encode(['hidden_field' => [['id' => $privateFile, 'storedFilename' => $privateFile . '.txt']]]), '2024-06-01 00:00:00']);

        $r = $this->serve(null, $form, $publicFile);
        $this->assertSame(200, $r['status'], 'whitelisted public-records field asset is public');
        $this->assertStringContainsString('public', $r['cache']);
        $this->assertStringNotContainsString('immutable', $r['cache'], 'bounded cache so revocation converges');

        $this->assertSame(404, $this->serve(null, $form, $privateFile)['status'], 'non-whitelisted field stays private');

        // An unattached file (e.g. still pending) is never public either.
        $pendingFile = 'pnd' . substr($this->uuid(), 0, 8);
        $this->placeFile($form, $pendingFile);
        $this->assertSame(404, $this->serve(null, $form, $pendingFile)['status']);
    }
}
