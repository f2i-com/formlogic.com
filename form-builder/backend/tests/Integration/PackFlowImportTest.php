<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\PackService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Pack import/export of FormLogic Flows: importPack creates flow_definitions + app_flow_bindings
 * inside the same transaction with @pack:<packFormId> refs (binding formId + outputActions[].form)
 * remapped to the new form ids; exportApp round-trips them back to portable @pack: refs without
 * leaking real UUIDs. Skipped without a test DB.
 */
class PackFlowImportTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FormService $forms;
    private static AppService $apps;
    private static AppUserService $appUsers;
    private static PackService $packs;
    private static FlowService $flows;

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-packflow-' . bin2hex(random_bytes(4)));
        self::$forms = new FormService($conn, $sqlite);
        self::$apps = new AppService($conn, self::$forms);
        self::$appUsers = new AppUserService($conn);
        self::$packs = new PackService($conn, self::$forms, self::$apps, self::$appUsers);
        self::$flows = new FlowService($conn);
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
            self::$pdo->prepare('DELETE FROM flow_run_logs WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_flow_bindings WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM flow_definitions WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$aid]);
        }
        self::$pdo->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM pack_installations WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    private function flowsPack(): array
    {
        return [
            'formatVersion' => 1,
            'packMeta' => ['id' => 'aokie-receptionist-test', 'name' => 'Receptionist', 'version' => '1.0.0'],
            'forms' => [
                ['packFormId' => 'calls', 'title' => 'Calls', 'fields' => [
                    ['id' => 'caller', 'type' => 'short_text', 'label' => 'Caller', 'required' => false],
                ]],
                ['packFormId' => 'bookings', 'title' => 'Bookings', 'fields' => [
                    ['id' => 'when', 'type' => 'short_text', 'label' => 'When', 'required' => false],
                ]],
            ],
            'apps' => [[
                'packAppId' => 'receptionist',
                'name' => 'Receptionist',
                'forms' => [
                    ['packFormId' => 'calls', 'sortOrder' => 0],
                    ['packFormId' => 'bookings', 'sortOrder' => 1],
                ],
            ]],
            'flows' => [[
                'slug' => 'call-triage',
                'name' => 'Call triage',
                'description' => 'Summarize the call and log it',
                'nodeCapabilities' => ['model.llm.local', 'connector.aokie.call'],
                'flowJson' => [
                    'nodes' => [
                        ['id' => 'in', 'type' => 'input'],
                        // Node-level @pack: form ref — remapped at import like binding formIds.
                        ['id' => 'lookup', 'type' => 'formlogic_list_responses', 'data' => ['form' => '@pack:calls', 'limit' => 100]],
                        ['id' => 'llm', 'type' => 'llm_chat', 'data' => ['prompt' => 'Summarize {{in}}']],
                        ['id' => 'out', 'type' => 'output'],
                    ],
                    'edges' => [
                        ['source' => 'in', 'target' => 'lookup'],
                        ['source' => 'lookup', 'target' => 'llm'],
                        ['source' => 'llm', 'target' => 'out'],
                    ],
                ],
            ]],
            'flowBindings' => [[
                'flow' => 'call-triage',
                'event' => 'aokie.call.ended',
                'mode' => 'async',
                'formId' => '@pack:calls',
                'timeoutMs' => 15000,
                'inputMap' => ['transcript' => '$event.data.transcript'],
                'outputActions' => [
                    ['type' => 'formlogic.submitResponse', 'form' => '@pack:calls', 'answers' => '$result.answers'],
                    ['type' => 'formlogic.submitResponse', 'form' => '@pack:bookings', 'answers' => '$result.booking', 'when' => '$result.wantsBooking'],
                    ['type' => 'formlogic.toast', 'message' => 'Call logged'],
                ],
            ]],
        ];
    }

    public function testImportCreatesFlowsAndRemapsPackRefs(): void
    {
        $result = self::$packs->importPack($this->flowsPack(), $this->userId);
        $appId = $result['apps'][0]['id'];
        $newFormIds = [];
        foreach ($result['forms'] as $f) {
            $newFormIds[$f['title']] = $f['id'];
        }

        // Flow definition created and owned by the importer, attached to the new app.
        $flows = self::$flows->listFlows($appId);
        $this->assertCount(1, $flows);
        $flow = $flows[0];
        $this->assertSame('call-triage', $flow['slug']);
        $this->assertSame('f2i', $flow['engine']);
        $this->assertSame($this->userId, $flow['ownerUserId']);
        $this->assertCount(4, $flow['flowJson']['nodes']);
        $this->assertSame(['model.llm.local', 'connector.aokie.call'], $flow['nodeCapabilities']);

        // Node-level form ref remapped to the real new form id (no @pack: left in the graph).
        $lookup = null;
        foreach ($flow['flowJson']['nodes'] as $n) {
            if (($n['id'] ?? '') === 'lookup') {
                $lookup = $n;
            }
        }
        $this->assertNotNull($lookup);
        $this->assertSame($newFormIds['Calls'], $lookup['data']['form'], 'flow node form ref remapped');
        $this->assertStringNotContainsString('@pack:', json_encode($flow['flowJson']));

        // Binding created with formId + outputActions[].form remapped to REAL new form ids.
        $bindings = self::$flows->listBindings($appId);
        $this->assertCount(1, $bindings);
        $binding = $bindings[0];
        $this->assertSame('call-triage', $binding['flow']);
        $this->assertSame('aokie.call.ended', $binding['event']);
        $this->assertSame(15000, $binding['timeoutMs']);
        $this->assertSame($newFormIds['Calls'], $binding['formId'], 'binding formId remapped from @pack:calls');
        $this->assertSame($newFormIds['Calls'], $binding['outputActions'][0]['form'], 'action form remapped');
        $this->assertSame($newFormIds['Bookings'], $binding['outputActions'][1]['form'], 'second action remapped');
        $raw = json_encode($bindings);
        $this->assertStringNotContainsString('@pack:', $raw, 'no unresolved pack refs may remain');
    }

    public function testImportWithUnknownPackFormRefFailsAtomically(): void
    {
        $pack = $this->flowsPack();
        $pack['packMeta']['id'] = 'broken-flows-test';
        $pack['flowBindings'][0]['formId'] = '@pack:ghost';

        try {
            self::$packs->importPack($pack, $this->userId);
            $this->fail('unknown packFormId must fail the import');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('ghost', $e->getMessage());
        }

        // Atomic: NOTHING was committed — no apps, no flows, no installation record.
        $stmt = self::$pdo->prepare('SELECT COUNT(*) FROM apps WHERE owner_id = ?');
        $stmt->execute([$this->userId]);
        $this->assertSame(0, (int) $stmt->fetchColumn(), 'rolled-back import must leave no app');
        $stmt = self::$pdo->prepare('SELECT COUNT(*) FROM flow_definitions WHERE owner_user_id = ?');
        $stmt->execute([$this->userId]);
        $this->assertSame(0, (int) $stmt->fetchColumn(), 'rolled-back import must leave no flow');
        $stmt = self::$pdo->prepare('SELECT COUNT(*) FROM pack_installations WHERE user_id = ?');
        $stmt->execute([$this->userId]);
        $this->assertSame(0, (int) $stmt->fetchColumn());
    }

    public function testUnknownFlowNodeFormRefFailsValidation(): void
    {
        $pack = $this->flowsPack();
        $pack['packMeta']['id'] = 'broken-node-ref-test';
        $pack['flows'][0]['flowJson']['nodes'][1]['data']['form'] = '@pack:ghost';

        try {
            self::$packs->importPack($pack, $this->userId);
            $this->fail('unknown packFormId inside flowJson must fail the import');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('ghost', $e->getMessage());
        }

        $stmt = self::$pdo->prepare('SELECT COUNT(*) FROM apps WHERE owner_id = ?');
        $stmt->execute([$this->userId]);
        $this->assertSame(0, (int) $stmt->fetchColumn(), 'rolled-back import must leave no app');
    }

    /**
     * The REAL Aokie Receptionist pack (emitted from src/data/packs by emit-marketplace.mjs)
     * validates + imports cleanly: 10 forms, 1 app with customLogic, 5 flows, 5 bindings, and
     * no unresolved @pack: refs anywhere in the stored flows/bindings. Skipped when the
     * emitted JSON isn't present (run `node scripts/emit-marketplace.mjs` from form-builder/ui).
     */
    public function testAokieReceptionistPackImportsCleanly(): void
    {
        $file = dirname(__DIR__, 2) . '/resources/marketplace-packs/aokie-receptionist.json';
        if (!is_file($file)) {
            $this->markTestSkipped('aokie-receptionist.json not emitted');
        }
        $record = json_decode((string) file_get_contents($file), true);
        $this->assertIsArray($record);
        $pack = $record['pack'] ?? null;
        $this->assertIsArray($pack);

        $result = self::$packs->importPack($pack, $this->userId);
        $this->assertCount(10, $result['forms']);
        $this->assertCount(1, $result['apps']);
        $appId = $result['apps'][0]['id'];

        $flows = self::$flows->listFlows($appId);
        $this->assertCount(6, $flows);
        $bindings = self::$flows->listBindings($appId);
        $this->assertCount(6, $bindings);
        $this->assertStringNotContainsString('@pack:', json_encode($flows));
        $this->assertStringNotContainsString('@pack:', json_encode($bindings));

        // The app-logic bundle survived import (raw-record writers + connector grant surface).
        $app = self::$apps->getApp($appId);
        $logic = $app['customLogic'] ?? null;
        $this->assertIsArray($logic);
        $this->assertNotEmpty($logic['scripts'] ?? []);
        $this->assertContains('connector.aokie.call.answer', $logic['permissions'] ?? []);
    }

    public function testExportRoundTripsFlowsWithPortableRefs(): void
    {
        $result = self::$packs->importPack($this->flowsPack(), $this->userId);
        $appId = $result['apps'][0]['id'];

        $pack = self::$packs->exportApp($appId, $this->userId);
        $this->assertCount(1, $pack['flows'] ?? []);
        $this->assertCount(1, $pack['flowBindings'] ?? []);
        $this->assertSame('call-triage', $pack['flows'][0]['slug']);

        $binding = $pack['flowBindings'][0];
        $this->assertStringStartsWith('@pack:', $binding['formId'], 'exported binding formId is portable');
        $this->assertStringStartsWith('@pack:', $binding['outputActions'][0]['form'], 'exported action form is portable');

        // Node-level form refs are packified too (inverse of the import remap).
        foreach ($pack['flows'][0]['flowJson']['nodes'] as $n) {
            if (($n['id'] ?? '') === 'lookup') {
                $this->assertStringStartsWith('@pack:', $n['data']['form'], 'exported node form ref is portable');
            }
        }

        // No real ids leak anywhere in the exported flows/bindings.
        $raw = json_encode([$pack['flows'], $pack['flowBindings']]);
        foreach ($result['forms'] as $f) {
            $this->assertStringNotContainsString($f['id'], $raw, 'real form id must not leak');
        }
        $this->assertStringNotContainsString($appId, $raw, 'real app id must not leak');
        $this->assertStringNotContainsString($this->userId, $raw, 'owner id must not leak');

        // And the export re-imports cleanly (full round trip).
        $pack['packMeta']['id'] = 'roundtrip-flows-test';
        $second = self::$packs->importPack($pack, $this->userId);
        $bindings = self::$flows->listBindings($second['apps'][0]['id']);
        $this->assertCount(1, $bindings);
        $this->assertStringNotContainsString('@pack:', json_encode($bindings));
    }
}
