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
 * A record's detail view resolves an empty linked_record answer by matching a key against the
 * target form (properties.matchField / targetMatchField). That lookup must stay inside what the
 * caller may read: a form of this app they can view. The target id is whatever the form's author
 * wrote, so without the guard any app owner could point it at another account's form and learn,
 * through their own record, whether that form holds a record with a given value, and its id.
 *
 * Skipped unless a test database is reachable (DB_TEST_DATABASE / DB_HOST / DB_USERNAME / DB_PASSWORD).
 */
class LinkedMatchResolutionScopeTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SQLiteConnection $sqlite;
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
        self::$sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-matchscope-' . bin2hex(random_bytes(5)));
        $formService = new FormService($conn, self::$sqlite);
        $responseService = new ResponseService($conn, self::$sqlite);
        self::$ctrl = new AppPublicController(
            new AppService($conn, $formService),
            new AppUserService($conn),
            new AppResponseService($conn, self::$sqlite, $responseService, null, $formService),
            $formService,
            $responseService,
            $conn,
            self::$sqlite,
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
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$id, $id . '@test.local']);
        $this->userIds[] = $id;
        return $id;
    }

    /** @param list<array{0:string,1:string,2?:array<string,mixed>}> $fields [id, type, properties] */
    private function makeForm(string $ownerId, array $fields): string
    {
        $id = 'form' . $this->uuid();
        self::$pdo->prepare("INSERT INTO forms (id, user_id, title, status) VALUES (?, ?, 'T', 'published')")->execute([$id, $ownerId]);
        $this->formIds[] = $id;
        $db = self::$sqlite->getFormDatabase($id);
        foreach ($fields as $i => $f) {
            $db->prepare("INSERT INTO fields (id, type, label, field_order, properties) VALUES (?, ?, ?, ?, ?)")
                ->execute([$f[0], $f[1], $f[0], $i, json_encode($f[2] ?? new \stdClass())]);
        }
        return $id;
    }

    private function insertResponse(string $formId, string $responseId, array $answers, string $submittedBy): void
    {
        self::$sqlite->getFormDatabase($formId)
            ->prepare("INSERT INTO responses (id, answers, metadata, status, submitted_at) VALUES (?, ?, ?, 'submitted', datetime('now'))")
            ->execute([$responseId, json_encode($answers), json_encode(['submittedByUserId' => $submittedBy])]);
    }

    private function makeApp(string $ownerId, array $formIds): string
    {
        $this->appId = 'app' . $this->uuid();
        $slug = 'lms' . substr($this->uuid(), 0, 12);
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'T', ?, 'published')")
            ->execute([$this->appId, $ownerId, $slug]);
        foreach ($formIds as $fid) {
            self::$pdo->prepare("INSERT INTO app_forms (id, app_id, form_id, display_name, sort_order, is_visible, settings) VALUES (?, ?, ?, 'T', 0, 1, '{}')")
                ->execute(['af' . $this->uuid(), $this->appId, $fid]);
        }
        $role = 'role' . $this->uuid();
        self::$pdo->prepare("INSERT INTO app_roles (id, app_id, name, is_system, sort_order) VALUES (?, ?, 'Owner', 1, 0)")->execute([$role, $this->appId]);
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, 'active', NOW())")
            ->execute(['au' . $this->uuid(), $this->appId, $ownerId, $role]);
        return $slug;
    }

    private function detail(string $userId, string $slug, string $formId, string $responseId): array
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $userId : null);
        $req->method('getQueryParams')->willReturn(['resolve' => 'linked']);
        $out = self::$ctrl->getResponseById($req, new SlimResponse(), ['slug' => $slug, 'formId' => $formId, 'id' => $responseId]);
        $this->assertSame(200, $out->getStatusCode());
        return json_decode((string) $out->getBody(), true)['response'] ?? [];
    }

    public function testMatchResolutionNeverReadsAFormOutsideTheApp(): void
    {
        $victim = $this->makeUser();
        $victimForm = $this->makeForm($victim, [['email', 'email']]);
        $this->insertResponse($victimForm, 'victim-record-1', ['email' => 'alice@example.com'], $victim);

        $owner = $this->makeUser();
        $probe = $this->makeForm($owner, [
            ['key', 'short_text'],
            ['link', 'linked_record', ['targetFormId' => $victimForm, 'matchField' => 'key', 'targetMatchField' => 'email']],
        ]);
        $slug = $this->makeApp($owner, [$probe]);
        $this->insertResponse($probe, 'probe-1', ['key' => 'alice@example.com'], $owner);

        $resp = $this->detail($owner, $slug, $probe, 'probe-1');
        $this->assertStringNotContainsString('victim-record-1', (string) json_encode($resp), "another account's record id leaked through the match");
    }

    public function testMatchResolutionInsideTheAppNeedsViewPermissionOnTheTarget(): void
    {
        $owner = $this->makeUser();
        $member = $this->makeUser();
        $target = $this->makeForm($owner, [['email', 'email']]);
        $base = $this->makeForm($owner, [
            ['key', 'short_text'],
            ['link', 'linked_record', ['targetFormId' => $target, 'matchField' => 'key', 'targetMatchField' => 'email']],
        ]);
        $slug = $this->makeApp($owner, [$base, $target]);
        $this->insertResponse($target, 'hidden-record-1', ['email' => 'bob@example.com'], $owner);
        $this->insertResponse($base, 'base-1', ['key' => 'bob@example.com'], $member);

        // The member may view their own base records and nothing on the target form.
        $role = 'role' . $this->uuid();
        self::$pdo->prepare("INSERT INTO app_roles (id, app_id, name, is_system, sort_order) VALUES (?, ?, 'M', 0, 1)")->execute([$role, $this->appId]);
        self::$pdo->prepare("INSERT INTO app_role_permissions (id, role_id, form_id, permission) VALUES (?, ?, ?, ?)")
            ->execute(['arp' . $this->uuid(), $role, $base, AppPermissions::VIEW_OWN_RESPONSES]);
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, 'active', NOW())")
            ->execute(['au' . $this->uuid(), $this->appId, $member, $role]);

        $resp = $this->detail($member, $slug, $base, 'base-1');
        $this->assertStringNotContainsString('hidden-record-1', (string) json_encode($resp), 'a record id of a form the member cannot view leaked through the match');

        // The owner, who may view the target, still gets the match resolved to its label.
        $ownerView = $this->detail($owner, $slug, $base, 'base-1');
        $this->assertSame('hidden-record-1', $ownerView['_resolved']['link']['id'] ?? null);
    }
}
