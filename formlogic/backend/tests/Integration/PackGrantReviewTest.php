<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FormService;
use FormLogic\Services\PackService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * APP-502 explicit grant review: importPack's approved-connector-grants set
 * strips unapproved connector grants from BOTH carriers (app customLogic
 * permissions AND role connector grants) before persist, while non-connector
 * permissions and the scripts survive; null = no review (all grants active).
 */
class PackGrantReviewTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FormService $forms;
    private static AppService $apps;
    private static AppUserService $appUsers;
    private static PackService $packs;

    private string $userId = '';

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-grantreview-' . bin2hex(random_bytes(4)));
        self::$forms = new FormService($conn, $sqlite);
        self::$apps = new AppService($conn, self::$forms);
        self::$appUsers = new AppUserService($conn);
        self::$packs = new PackService($conn, self::$forms, self::$apps, self::$appUsers);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->userId, $this->userId . '@test.local']);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->userId === '') {
            return;
        }
        $appIds = self::$pdo->prepare('SELECT id FROM apps WHERE owner_id = ?');
        $appIds->execute([$this->userId]);
        foreach ($appIds->fetchAll(PDO::FETCH_COLUMN) as $aid) {
            // app_users references app_roles (ON DELETE RESTRICT) — drop it first.
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$aid]);
        }
        self::$pdo->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM pack_installations WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    /** A pack whose app requests two connector grants (customLogic + a role) plus non-connector perms. */
    private function grantPack(): array
    {
        return [
            'formatVersion' => 1,
            'packMeta' => ['id' => 'gr-' . bin2hex(random_bytes(6)), 'name' => 'Grant Pack', 'version' => '1.0.0'],
            'forms' => [['packFormId' => 'f1', 'title' => 'F1', 'fields' => []]],
            'apps' => [[
                'packAppId' => 'a1',
                'name' => 'Grant App',
                'customLogic' => [
                    'version' => 1,
                    'runtime' => 'quickjs',
                    'permissions' => [
                        'formlogic.responses.write',
                        'ui.toast',
                        'connector.aokie.call.answer',
                        'connector.aokie.sms.send',
                    ],
                    'scripts' => [[
                        'id' => 's1',
                        'hook' => 'onConnectorEvent',
                        'code' => 'return [];',
                        'permissions' => ['connector.aokie.call.hangup'],
                    ]],
                ],
                'forms' => [['packFormId' => 'f1', 'sortOrder' => 0]],
                'roles' => [[
                    'name' => 'Operator',
                    'permissions' => [
                        ['formId' => null, 'permission' => 'view_responses'],
                        ['formId' => null, 'permission' => 'connector.aokie.call.answer'],
                        ['formId' => null, 'permission' => 'connector.aokie.sms.send'],
                    ],
                ]],
            ]],
        ];
    }

    /** @return array<string,mixed> the created app's stored customLogic */
    private function storedCustomLogic(string $appId): array
    {
        $stmt = self::$pdo->prepare('SELECT custom_logic FROM apps WHERE id = ?');
        $stmt->execute([$appId]);
        return json_decode((string) $stmt->fetch()['custom_logic'], true) ?? [];
    }

    /** @return list<string> connector grant strings persisted on the app's roles */
    private function storedRoleConnectorGrants(string $appId): array
    {
        $stmt = self::$pdo->prepare(
            "SELECT permission FROM app_role_permissions
             WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?) AND permission LIKE 'connector.%'"
        );
        $stmt->execute([$appId]);
        $out = $stmt->fetchAll(PDO::FETCH_COLUMN);
        sort($out);
        return array_values(array_unique($out));
    }

    public function testNoReviewActivatesEveryRequestedGrant(): void
    {
        $res = self::$packs->importPack($this->grantPack(), $this->userId); // no approved set
        $this->assertSame([], $res['withheldGrants']);
        $appId = $res['apps'][0]['id'];
        $cl = $this->storedCustomLogic($appId);
        $this->assertContains('connector.aokie.call.answer', $cl['permissions']);
        $this->assertContains('connector.aokie.sms.send', $cl['permissions']);
        $this->assertContains('connector.aokie.call.hangup', $cl['scripts'][0]['permissions']);
        $this->assertEqualsCanonicalizing(
            ['connector.aokie.call.answer', 'connector.aokie.sms.send'],
            $this->storedRoleConnectorGrants($appId)
        );
    }

    public function testReviewStripsUnapprovedGrantsFromBothCarriers(): void
    {
        // Approve only call.answer + call.hangup; sms.send is withheld everywhere.
        $res = self::$packs->importPack(
            $this->grantPack(),
            $this->userId,
            null,
            null,
            null,
            ['connector.aokie.call.answer', 'connector.aokie.call.hangup']
        );
        $this->assertSame(['connector.aokie.sms.send'], $res['withheldGrants']);
        $appId = $res['apps'][0]['id'];
        $cl = $this->storedCustomLogic($appId);
        // Approved connector grant + non-connector perms survive; sms.send gone.
        $this->assertContains('connector.aokie.call.answer', $cl['permissions']);
        $this->assertNotContains('connector.aokie.sms.send', $cl['permissions']);
        $this->assertContains('formlogic.responses.write', $cl['permissions']);
        $this->assertContains('ui.toast', $cl['permissions']);
        // Per-script approved grant survives.
        $this->assertContains('connector.aokie.call.hangup', $cl['scripts'][0]['permissions']);
        // Role carrier: only the approved connector grant persists.
        $this->assertSame(['connector.aokie.call.answer'], $this->storedRoleConnectorGrants($appId));
    }

    public function testEmptyApprovedSetStripsAllConnectorGrantsButKeepsTheRest(): void
    {
        $res = self::$packs->importPack($this->grantPack(), $this->userId, null, null, null, []);
        $this->assertEqualsCanonicalizing(
            ['connector.aokie.call.answer', 'connector.aokie.call.hangup', 'connector.aokie.sms.send'],
            $res['withheldGrants']
        );
        $appId = $res['apps'][0]['id'];
        $cl = $this->storedCustomLogic($appId);
        foreach ($cl['permissions'] as $p) {
            $this->assertStringStartsNotWith('connector.', $p);
        }
        // The bundle + non-connector perms + scripts are intact.
        $this->assertContains('formlogic.responses.write', $cl['permissions']);
        $this->assertCount(1, $cl['scripts']);
        $this->assertSame('return [];', $cl['scripts'][0]['code']);
        $this->assertSame([], $this->storedRoleConnectorGrants($appId));
    }

    public function testDescribeSurfacesVendorSigningVerdict(): void
    {
        // An unsigned pack reports signed=false.
        $this->assertSame(['signed' => false], self::$packs->describeSigning($this->grantPack()));
    }

    public function testDeclinedWildcardConnectorGrantIsStripped(): void
    {
        // A 'connector.*' wildcard (which the runtime gate honors as covering
        // EVERY command) must be governed by the review — declining it strips
        // it, even though it fails the strict role-grant validator.
        $pack = $this->grantPack();
        $pack['apps'][0]['customLogic']['permissions'][] = 'connector.aokie.*';
        $pack['apps'][0]['customLogic']['permissions'][] = 'connector.*';
        // Approve only one exact grant; both wildcards are declined.
        $res = self::$packs->importPack(
            $pack,
            $this->userId,
            null,
            null,
            null,
            ['connector.aokie.call.answer']
        );
        $this->assertContains('connector.aokie.*', $res['withheldGrants']);
        $this->assertContains('connector.*', $res['withheldGrants']);
        $cl = $this->storedCustomLogic($res['apps'][0]['id']);
        $this->assertNotContains('connector.aokie.*', $cl['permissions']);
        $this->assertNotContains('connector.*', $cl['permissions']);
        $this->assertContains('connector.aokie.call.answer', $cl['permissions']);
    }
}
