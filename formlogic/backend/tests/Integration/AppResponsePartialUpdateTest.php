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
 * PATCH semantics of the app-runtime response update (AppPublicController::updateResponseById).
 *
 * Machine writers — app-logic effects (formlogic.updateResponse) and flow output actions —
 * send only the fields they change (e.g. {status, ended_at} on aokie.call.ended). The endpoint
 * must merge the patch over the STORED answers before validating, or every partial update is
 * rejected with "required field missing" for fields the patch never touched (found live on
 * formlogic.local: Aokie call records were stuck at status=incoming).
 *
 * Pins: (1) a partial patch omitting a required field succeeds and preserves it;
 *       (2) explicitly blanking a required field still fails validation (anti-erasure);
 *       (3) the patch actually lands (merged values stored).
 *
 * Skipped unless a test database is reachable (same setup as RuntimePermissionFilteringTest).
 */
class AppResponsePartialUpdateTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static AppPublicController $ctrl;
    private static AppResponseService $appResponses;
    private static FormService $formService;

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-partialupd-' . bin2hex(random_bytes(5)));
        $formService = new FormService($conn, $sqlite);
        self::$formService = $formService;
        $responseService = new ResponseService($conn, $sqlite);
        self::$appResponses = new AppResponseService($conn, $sqlite, $responseService, null, $formService);
        self::$ctrl = new AppPublicController(
            new AppService($conn, $formService),
            new AppUserService($conn),
            self::$appResponses,
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

    /** A Calls-like form: required phone + free machine fields, mirroring the Aokie pack. */
    private function makeCallsForm(string $ownerId): string
    {
        // Fields live in form_fields (via FormService::createForm), not on the forms row.
        $form = self::$formService->createForm([
            'user_id' => $ownerId,
            'title' => 'Calls',
            'status' => 'published',
            'fields' => [
                ['id' => 'call_id', 'type' => 'short_text', 'label' => 'Call ID', 'required' => false, 'order' => 0, 'properties' => []],
                ['id' => 'caller_phone', 'type' => 'phone', 'label' => 'Caller Phone', 'required' => true, 'order' => 1, 'properties' => []],
                ['id' => 'status', 'type' => 'dropdown', 'label' => 'Status', 'required' => true, 'order' => 2, 'properties' => ['options' => [
                    ['id' => 'incoming', 'label' => 'Incoming', 'value' => 'incoming'],
                    ['id' => 'completed', 'label' => 'Completed', 'value' => 'completed'],
                ]]],
                ['id' => 'ended_at', 'type' => 'short_text', 'label' => 'Ended At', 'required' => false, 'order' => 3, 'properties' => []],
            ],
        ]);
        $id = (string) $form['id'];
        $this->formIds[] = $id;
        return $id;
    }

    /** @return array{slug:string, owner:string, formId:string, responseId:string} */
    private function seed(): array
    {
        $owner = $this->makeUser();
        $formId = $this->makeCallsForm($owner);
        $appId = 'app' . $this->uuid();
        $slug = 'pupd' . substr($this->uuid(), 0, 12);
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'T', ?, 'published')")
            ->execute([$appId, $owner, $slug]);
        $this->appId = $appId;
        self::$pdo->prepare("INSERT INTO app_forms (id, app_id, form_id, display_name, sort_order, is_visible, settings) VALUES (?, ?, ?, 'Calls', 0, 1, '{}')")
            ->execute(['af' . $this->uuid(), $appId, $formId]);

        $role = 'role' . $this->uuid();
        self::$pdo->prepare("INSERT INTO app_roles (id, app_id, name, is_system, sort_order) VALUES (?, ?, 'R', 0, 0)")
            ->execute([$role, $appId]);
        foreach ([AppPermissions::EDIT_RESPONSES, AppPermissions::VIEW_ALL_RESPONSES, AppPermissions::SUBMIT_RESPONSES] as $perm) {
            self::$pdo->prepare('INSERT INTO app_role_permissions (id, role_id, form_id, permission) VALUES (?, ?, ?, ?)')
                ->execute(['arp' . $this->uuid(), $role, $formId, $perm]);
        }
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, 'active', NOW())")
            ->execute(['au' . $this->uuid(), $appId, $owner, $role]);

        $created = self::$appResponses->createResponse($appId, $formId, [
            'answers' => ['call_id' => 'call_x1', 'caller_phone' => '+61400000001', 'status' => 'incoming'],
        ], $owner);
        $this->assertIsArray($created);

        return ['slug' => $slug, 'owner' => $owner, 'formId' => $formId, 'responseId' => (string) $created['id']];
    }

    /** @return array{status:int, body:array} */
    private function put(string $userId, string $slug, string $formId, string $responseId, array $body): array
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $userId : null);
        $req->method('getParsedBody')->willReturn($body);
        $out = self::$ctrl->updateResponseById($req, new SlimResponse(), ['slug' => $slug, 'formId' => $formId, 'id' => $responseId]);
        return ['status' => $out->getStatusCode(), 'body' => json_decode((string) $out->getBody(), true) ?: []];
    }

    public function testPartialPatchOmittingRequiredFieldsMergesAndSucceeds(): void
    {
        $s = $this->seed();
        $r = $this->put($s['owner'], $s['slug'], $s['formId'], $s['responseId'], [
            'answers' => ['status' => 'completed', 'ended_at' => '2026-07-07T03:00:00.000Z'],
        ]);
        $this->assertSame(200, $r['status'], json_encode($r['body']));
        $answers = $r['body']['response']['answers'] ?? [];
        $this->assertSame('completed', $answers['status'] ?? null);
        $this->assertSame('2026-07-07T03:00:00.000Z', $answers['ended_at'] ?? null);
        // Untouched fields preserved by the merge — the whole point of the fix.
        $this->assertSame('+61400000001', $answers['caller_phone'] ?? null);
        $this->assertSame('call_x1', $answers['call_id'] ?? null);
    }

    public function testExplicitlyBlankingARequiredFieldStillFailsValidation(): void
    {
        $s = $this->seed();
        $r = $this->put($s['owner'], $s['slug'], $s['formId'], $s['responseId'], [
            'answers' => ['caller_phone' => ''],
        ]);
        $this->assertSame(400, $r['status'], json_encode($r['body']));
        $this->assertArrayHasKey('caller_phone', $r['body']['errors'] ?? []);
    }
}
