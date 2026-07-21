<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AdminController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AdminService;
use FormLogic\Services\AppService;
use FormLogic\Services\AuditService;
use FormLogic\Services\AuthService;
use FormLogic\Services\FileStorageService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\MaintenanceService;
use FormLogic\Services\PlanService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\UpgradeService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Log\NullLogger;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * Plan allowances + usage metering (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md Phase 2):
 * the seeded rows, allowance() lookup, checkAndIncrement math (cap, disabled metric,
 * unlimited -1, enterprise bypass, cloud-lapsed refusal), UTC-month rollover (a new
 * period is a fresh row — no reset job), the planEnforced gate (off = unlimited but
 * still recorded), token metering via recordUsage, the flow_credits_exceeded typed code,
 * and the audited admin allowance update. Skipped without a test database.
 */
class SiteAiAllowanceTest extends TestCase
{
    private const BASE = 'http://localhost';

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;

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
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$this->userId, $this->userId . '@test.local']);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        // Restore any allowance rows a test perturbed; keep only the two seeded rows.
        self::$pdo->exec("DELETE FROM plan_allowances WHERE plan NOT IN ('personal', 'enterprise')
            OR (plan = 'personal' AND metric != 'ai_messages') OR (plan = 'enterprise' AND metric != 'ai_messages')");
        self::$pdo->prepare("INSERT INTO plan_allowances (plan, metric, monthly_value, enabled) VALUES ('personal', 'ai_messages', 500, 1)
            ON DUPLICATE KEY UPDATE monthly_value = 500, enabled = 1")->execute();
        if ($this->userId !== '') {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
        }
    }

    // ── helpers ──

    private function plan(array $cloud = ['planEnforced' => true]): PlanService
    {
        $files = new FileStorageService(['storagePath' => sys_get_temp_dir() . '/fl-test-uploads']);
        return new PlanService(self::$mysql, $files, $cloud);
    }

    private function meterRow(string $metric, ?string $period = null): ?array
    {
        $stmt = self::$pdo->prepare('SELECT `count`, tokens_in, tokens_out FROM usage_meter WHERE user_id = ? AND metric = ? AND period = ?');
        $stmt->execute([$this->userId, $metric, $period ?? gmdate('Y-m')]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    private static function decode(ResponseInterface $resp): array
    {
        $resp->getBody()->rewind();
        return json_decode((string) $resp->getBody(), true) ?: [];
    }

    // ── seeded rows + lookup ──

    public function testSeededAllowancesExist(): void
    {
        $plan = $this->plan();
        $personal = $plan->allowance('personal', 'ai_messages');
        $this->assertTrue($personal['enabled']);
        $this->assertSame(500, $personal['monthlyValue']);
        $enterprise = $plan->allowance('enterprise', 'ai_messages');
        $this->assertTrue($enterprise['enabled']);
        $this->assertSame(-1, $enterprise['monthlyValue']);
        // A plan/metric with no row reads as disabled-zero.
        $this->assertSame(['enabled' => false, 'monthlyValue' => 0], $plan->allowance('personal', 'no_such_metric'));
    }

    // ── checkAndIncrement math ──

    public function testCapEnforcedAndUsageRecorded(): void
    {
        $plan = $this->plan();
        $plan->setAllowance('personal', 'ai_messages', 3, true);
        $plan->checkAndIncrement($this->userId, 'ai_messages');
        $plan->checkAndIncrement($this->userId, 'ai_messages', 2);
        $row = $this->meterRow('ai_messages');
        $this->assertNotNull($row);
        $this->assertSame(3, (int) $row['count']);
        try {
            $plan->checkAndIncrement($this->userId, 'ai_messages');
            $this->fail('expected ai_allowance_exceeded');
        } catch (\RuntimeException $e) {
            $this->assertSame('ai_allowance_exceeded', $e->getMessage());
        }
        // The refused increment did not leak into the meter.
        $this->assertSame(3, (int) $this->meterRow('ai_messages')['count']);
    }

    public function testUtcMonthRolloverStartsAFreshCounter(): void
    {
        $plan = $this->plan();
        $plan->setAllowance('personal', 'ai_messages', 1, true);
        // Last month's meter is already at the cap — it must not count against this month.
        self::$pdo->prepare("INSERT INTO usage_meter (user_id, metric, period, `count`) VALUES (?, 'ai_messages', '2020-01', 1)")
            ->execute([$this->userId]);
        $plan->checkAndIncrement($this->userId, 'ai_messages');
        $this->assertSame(1, (int) $this->meterRow('ai_messages')['count']);
        // ... and the current month is capped independently.
        try {
            $plan->checkAndIncrement($this->userId, 'ai_messages');
            $this->fail('expected the current month to be capped at 1');
        } catch (\RuntimeException $e) {
            $this->assertSame('ai_allowance_exceeded', $e->getMessage());
        }
    }

    public function testPlanEnforcedOffIsUnlimitedButStillRecords(): void
    {
        $plan = $this->plan(['planEnforced' => false]);
        for ($i = 0; $i < 600; $i++) {
            $plan->checkAndIncrement($this->userId, 'ai_messages'); // past the 500 seed
        }
        $this->assertSame(600, (int) $this->meterRow('ai_messages')['count']);
    }

    public function testEnterpriseIsUnlimited(): void
    {
        self::$pdo->prepare("UPDATE users SET plan = 'enterprise', cloud_until = NULL WHERE id = ?")->execute([$this->userId]);
        $plan = $this->plan();
        for ($i = 0; $i < 600; $i++) {
            $plan->checkAndIncrement($this->userId, 'ai_messages');
        }
        $this->assertSame(600, (int) $this->meterRow('ai_messages')['count']);
    }

    public function testDisabledMetricRefuses(): void
    {
        $plan = $this->plan();
        $plan->setAllowance('personal', 'test_disabled', 5, false);
        try {
            $plan->checkAndIncrement($this->userId, 'test_disabled');
            $this->fail('expected a disabled metric to refuse');
        } catch (\RuntimeException $e) {
            $this->assertSame('ai_allowance_exceeded', $e->getMessage());
        }
    }

    public function testCloudLapsedUserRefuses(): void
    {
        self::$pdo->prepare("UPDATE users SET cloud_until = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id = ?")->execute([$this->userId]);
        $plan = $this->plan();
        try {
            $plan->checkAndIncrement($this->userId, 'ai_messages');
            $this->fail('expected a lapsed plan to refuse hosted AI');
        } catch (\RuntimeException $e) {
            $this->assertSame('ai_allowance_exceeded', $e->getMessage());
        }
    }

    public function testFlowCreditsTypedCode(): void
    {
        $plan = $this->plan();
        $plan->setAllowance('personal', 'cloud_flow_runs', 0, true);
        try {
            $plan->checkAndIncrement($this->userId, 'cloud_flow_runs');
            $this->fail('expected flow_credits_exceeded');
        } catch (\RuntimeException $e) {
            $this->assertSame('flow_credits_exceeded', $e->getMessage());
        }
    }

    public function testRecordUsageAccumulatesTokensWithoutACheck(): void
    {
        $plan = $this->plan();
        $plan->recordUsage($this->userId, 'ai_messages', 0, 120, 45);
        $plan->recordUsage($this->userId, 'ai_messages', 1, 30, 15);
        $row = $this->meterRow('ai_messages');
        $this->assertSame(1, (int) $row['count']);
        $this->assertSame(150, (int) $row['tokens_in']);
        $this->assertSame(60, (int) $row['tokens_out']);
        $meter = $plan->usageMeter($this->userId);
        $this->assertSame(gmdate('Y-m'), $meter['period']);
        $this->assertSame(['count' => 1, 'tokensIn' => 150, 'tokensOut' => 60], $meter['metrics']['ai_messages']);
        // An older period reads back independently.
        self::$pdo->prepare("INSERT INTO usage_meter (user_id, metric, period, `count`) VALUES (?, 'ai_messages', '2020-01', 9)")
            ->execute([$this->userId]);
        $this->assertSame(9, $plan->usageMeter($this->userId, '2020-01')['metrics']['ai_messages']['count']);
    }

    // ── admin surface (audited) ──

    public function testSetAllowanceValidation(): void
    {
        $plan = $this->plan();
        try {
            $plan->setAllowance('Bad Plan', 'ai_messages', 1, true);
            $this->fail('expected a bad plan slug to be rejected');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('plan', $e->getMessage());
        }
        try {
            $plan->setAllowance('personal', 'ai_messages', -2, true);
            $this->fail('expected monthlyValue < -1 to be rejected');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('monthlyValue', $e->getMessage());
        }
        $plan->setAllowance('acme', 'ai_messages', 42, true);
        $rows = array_column($plan->listAllowances(), null, 'plan');
        $this->assertSame(42, $rows['acme']['monthlyValue']);
    }

    public function testAdminPutAllowanceIsAudited(): void
    {
        $tmpRoot = sys_get_temp_dir() . '/fl-allowance-admin-' . bin2hex(random_bytes(4));
        mkdir($tmpRoot, 0777, true);
        $sqlite = new SQLiteConnection($tmpRoot . '/sqlite');
        $forms = new FormService(self::$mysql, $sqlite);
        $maintenance = new MaintenanceService($tmpRoot . '/maintenance.json');
        $audit = new AuditService(self::$mysql, new NullLogger(), hash('sha256', 'test-audit-key'));
        $plan = $this->plan();
        $ctrl = new AdminController(
            new AdminService(self::$mysql),
            new AuthService(self::$mysql, ['secret' => 'test-secret-allowances-0123456789', 'algorithm' => 'HS256']),
            $maintenance,
            new UpgradeService($tmpRoot . '/nowhere', self::$mysql, $maintenance),
            $forms,
            new AppService(self::$mysql, $forms),
            new FlowService(self::$mysql),
            new ResponseService(self::$mysql, $sqlite),
            $audit,
            new NullLogger(),
            null,
            null,
            null,
            null,
            null,
            $plan
        );
        $adminId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, is_admin) VALUES (?, ?, 'x', 'T', 1)")
            ->execute([$adminId, $adminId . '@test.local']);
        try {
            $req = (new ServerRequestFactory())->createServerRequest('PUT', self::BASE . '/api/admin/allowances')
                ->withParsedBody(['plan' => 'personal', 'metric' => 'ai_messages', 'monthlyValue' => 250, 'enabled' => true])
                ->withAttribute('userId', $adminId);
            $resp = $ctrl->putAllowance($req, (new ResponseFactory())->createResponse());
            $this->assertSame(200, $resp->getStatusCode());
            $body = self::decode($resp);
            $this->assertSame(250, $body['allowance']['monthlyValue']);
            $this->assertSame(250, $plan->allowance('personal', 'ai_messages')['monthlyValue']);

            $auditRow = self::$pdo->prepare("SELECT resource_type, resource_id, details FROM audit_log WHERE action = 'admin.allowance_update' AND user_id = ? ORDER BY created_at DESC, sequence_number DESC LIMIT 1");
            $auditRow->execute([$adminId]);
            $row = $auditRow->fetch(PDO::FETCH_ASSOC);
            $this->assertNotFalse($row);
            $this->assertSame('admin', $row['resource_type']);
            $this->assertSame('personal/ai_messages', $row['resource_id']);
            $details = json_decode((string) $row['details'], true);
            $this->assertSame(250, $details['monthlyValue']);

            // GET lists it back.
            $listReq = (new ServerRequestFactory())->createServerRequest('GET', self::BASE . '/api/admin/allowances')
                ->withAttribute('userId', $adminId);
            $list = self::decode($ctrl->listAllowances($listReq, (new ResponseFactory())->createResponse()));
            $this->assertContains('ai_messages', array_column($list['allowances'], 'metric'));

            // Validation failures are 400 and unaudited.
            $badReq = (new ServerRequestFactory())->createServerRequest('PUT', self::BASE . '/api/admin/allowances')
                ->withParsedBody(['plan' => 'personal', 'metric' => 'ai_messages'])
                ->withAttribute('userId', $adminId);
            $this->assertSame(400, $ctrl->putAllowance($badReq, (new ResponseFactory())->createResponse())->getStatusCode());
        } finally {
            self::$pdo->prepare("DELETE FROM audit_log WHERE action = 'admin.allowance_update' AND user_id = ?")->execute([$adminId]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$adminId]);
        }
    }
}
