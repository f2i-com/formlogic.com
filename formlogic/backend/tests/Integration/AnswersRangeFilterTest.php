<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Range-bound pushdown behind the flow filter ops `gte`/`lte`
 * (answersGte/answersLte): ISO-date bounds are applied IN SQL, BEFORE the
 * row limit — the whole point (aokie business-lookup): a capped fetch over a
 * growing Appointments table must not silently drop in-window rows because
 * newer out-of-window rows crowded the page. Semantics are mirrored in the
 * browser executor (nodes.ts gte/lte) and the desktop Rust runner
 * (FilterOp::Gte/Lte) — change one, change all three.
 *
 * Skipped unless a test database is reachable.
 */
class AnswersRangeFilterTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FormService $formService;
    private static ResponseService $responses;

    /** @var string[] */ private array $userIds = [];
    /** @var string[] */ private array $formIds = [];

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-rangefilter-' . bin2hex(random_bytes(5)));
        self::$formService = new FormService($conn, $sqlite);
        self::$responses = new ResponseService($conn, $sqlite);
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
        foreach ($this->formIds as $fid) {
            self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$fid]);
        }
        foreach ($this->userIds as $uid) {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
    }

    private function uuid(): string
    {
        return bin2hex(random_bytes(10));
    }

    private function makeUser(): string
    {
        $id = 'u' . $this->uuid();
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$id, $id . '@test.local']);
        $this->userIds[] = $id;
        return $id;
    }

    /** An Appointments-like form: a plain date-string field, like the Aokie pack. */
    private function makeAppointmentsForm(string $ownerId): string
    {
        $form = self::$formService->createForm([
            'user_id' => $ownerId,
            'title' => 'Appointments',
            'status' => 'published',
            'fields' => [
                ['id' => 'service', 'type' => 'short_text', 'label' => 'Service', 'required' => false, 'order' => 0, 'properties' => []],
                ['id' => 'date', 'type' => 'short_text', 'label' => 'Date', 'required' => false, 'order' => 1, 'properties' => []],
            ],
        ]);
        $id = (string) $form['id'];
        $this->formIds[] = $id;
        return $id;
    }

    private function submit(string $formId, string $service, ?string $date): void
    {
        $answers = ['service' => $service];
        if ($date !== null) {
            $answers['date'] = $date;
        }
        $result = self::$responses->createResponse($formId, ['answers' => $answers]);
        $this->assertIsArray($result, "submitting {$service} should succeed");
    }

    public function testDateWindowFiltersBeforeTheLimit(): void
    {
        $owner = $this->makeUser();
        $formId = $this->makeAppointmentsForm($owner);

        // ONE in-window row submitted FIRST (oldest), then a pile of
        // out-of-window rows submitted after it — newest-first ordering would
        // put every one of them ahead of the in-window row.
        $this->submit($formId, 'InWindow', '2026-07-20');
        $this->submit($formId, 'Boundary', '2026-10-12');
        for ($i = 0; $i < 8; $i++) {
            $this->submit($formId, "Past{$i}", '2026-01-0' . (($i % 9) + 1));
            $this->submit($formId, "Beyond{$i}", '2026-12-1' . ($i % 9));
        }
        $this->submit($formId, 'NoDate', null);

        $options = [
            'answersGte' => ['date' => '2026-07-14'],
            'answersLte' => ['date' => '2026-10-12'],
            // The crux: a limit SMALLER than the out-of-window row count.
            // Without SQL pushdown the page would hold only Past/Beyond rows.
            'limit' => 2,
        ];
        $rows = self::$responses->getFormResponses($formId, $options);
        $services = array_map(static fn (array $r) => $r['answers']['service'] ?? '', $rows);
        sort($services);
        $this->assertSame(['Boundary', 'InWindow'], $services, 'bounds are inclusive; the window applies BEFORE the limit');

        // Same semantics through the searchable path (the app route the flow
        // runners actually hit — the phone_eq lesson).
        $searchable = self::$responses->getFormResponsesSearchable($formId, '', [], $options);
        $sServices = array_map(static fn (array $r) => $r['answers']['service'] ?? '', $searchable['responses']);
        sort($sServices);
        $this->assertSame(['Boundary', 'InWindow'], $sServices);
    }

    public function testLteAloneAdmitsMissingDatesLikeTheRunners(): void
    {
        $owner = $this->makeUser();
        $formId = $this->makeAppointmentsForm($owner);
        $this->submit($formId, 'NoDate', null);
        $this->submit($formId, 'InWindow', '2026-07-20');
        $this->submit($formId, 'Beyond', '2026-12-01');

        // Runners' semantics: a missing value stringifies to '' which sorts
        // before any bound — lte keeps it, gte drops it.
        $lteOnly = self::$responses->getFormResponses($formId, ['answersLte' => ['date' => '2026-10-12'], 'limit' => 10]);
        $names = array_map(static fn (array $r) => $r['answers']['service'] ?? '', $lteOnly);
        sort($names);
        $this->assertSame(['InWindow', 'NoDate'], $names);

        $gteOnly = self::$responses->getFormResponses($formId, ['answersGte' => ['date' => '2026-07-14'], 'limit' => 10]);
        $gNames = array_map(static fn (array $r) => $r['answers']['service'] ?? '', $gteOnly);
        sort($gNames);
        $this->assertSame(['Beyond', 'InWindow'], $gNames);
    }
}
