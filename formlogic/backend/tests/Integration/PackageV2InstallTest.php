<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\PackController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FormService;
use FormLogic\Services\Packages\PackageV2InstallService;
use FormLogic\Services\PackService;
use FormLogic\Services\SigningService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Response as SlimResponse;

/**
 * ADR-010 / PKG-103 + PKG-104 subset: node-only Application Package v2 install —
 * definitions + installation rows persist (digest over stored bytes, immutable receipt),
 * the not-yet-supported aggregate features refuse TYPED (never silently dropped), the
 * one-active-version and one-owner-per-contributed-type rules hold, and the HTTP lane
 * rides the same signature/trust/grant gates as Pack v1. Skipped without a test DB.
 */
class PackageV2InstallTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static PackService $packs;
    private static PackageV2InstallService $pkgV2;
    private static SigningService $signing;

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-pkgv2-' . bin2hex(random_bytes(4)));
        $forms = new FormService($conn, $sqlite);
        $apps = new AppService($conn, $forms);
        self::$packs = new PackService($conn, $forms, $apps, new AppUserService($conn));
        self::$pkgV2 = new PackageV2InstallService($conn);
        self::$signing = new SigningService($conn);
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
        // package_installations cascades flow_node_definitions; users cascades installations.
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    /** A valid node-only extension aggregate (mirrors the shared fixture corpus's first case). */
    private function nodeOnlyAggregate(string $suffix = 'media-tools'): array
    {
        return [
            'formatVersion' => 2,
            'package' => [
                'id' => 'com.acme.' . $suffix,
                'kind' => 'extension',
                'version' => '1.4.0',
                'publisherId' => 'com.acme',
                'displayName' => 'Acme Media Tools',
            ],
            'contributions' => [
                'flowNodes' => [[
                    'schemaVersion' => 1,
                    'type' => 'com.acme.' . str_replace('-', '', $suffix) . '.generate-image',
                    'version' => '1.2.0',
                    'display' => ['label' => 'Generate image'],
                    'ports' => [
                        ['id' => 'prompt', 'direction' => 'input', 'kind' => 'data', 'required' => true, 'schema' => ['type' => 'string', 'minLength' => 1]],
                    ],
                    'handler' => ['kind' => 'service-action', 'bindingSlot' => 'imageGenerator', 'requiredAction' => 'generate-image'],
                    'sideEffects' => 'external-write',
                ]],
            ],
            'requirements' => [
                'services' => [['slot' => 'imageGenerator', 'required' => true, 'requiredActions' => ['generate-image']]],
            ],
        ];
    }

    private function controller(): PackController
    {
        return new PackController(self::$packs, null, null, self::$signing, null, self::$pkgV2);
    }

    /** @return array{status:int, body:array} */
    private function callImportSigned(array $body): array
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $this->userId : null);
        $req->method('getUploadedFiles')->willReturn([]);
        $req->method('getParsedBody')->willReturn($body);
        $out = $this->controller()->importSigned($req, new SlimResponse());
        return ['status' => $out->getStatusCode(), 'body' => json_decode((string) $out->getBody(), true) ?: []];
    }

    // ── Service level ───────────────────────────────────────────────────────────────────────

    public function testInstallPersistsDefinitionsWithDigestsAndReceipt(): void
    {
        $result = self::$pkgV2->install($this->nodeOnlyAggregate(), $this->userId, [], 'json', 'community');
        $this->assertSame('com.acme.media-tools', $result['packageId']);
        $this->assertSame(['com.acme.mediatools.generate-image'], $result['nodeTypes']);

        $stmt = self::$pdo->prepare('SELECT * FROM package_installations WHERE id = ?');
        $stmt->execute([$result['installationId']]);
        $install = $stmt->fetch(PDO::FETCH_ASSOC);
        $this->assertSame('extension', $install['kind']);
        $this->assertSame('ready', $install['state']);
        $receipt = json_decode((string) $install['receipt_json'], true);
        $this->assertSame('community', $receipt['trust']);
        $this->assertSame([], $receipt['approvedConnectorGrants']);
        $this->assertCount(1, $receipt['contributions']);

        $stmt = self::$pdo->prepare('SELECT * FROM flow_node_definitions WHERE installation_id = ?');
        $stmt->execute([$result['installationId']]);
        $def = $stmt->fetch(PDO::FETCH_ASSOC);
        $this->assertSame('com.acme.mediatools.generate-image', $def['node_type']);
        $this->assertSame('1.2.0', $def['version']);
        // The digest is over EXACTLY the stored definition bytes.
        $this->assertSame(hash('sha256', (string) $def['definition_json']), $def['digest']);
        $this->assertSame($receipt['contributions'][0]['digest'], $def['digest']);
    }

    public function testOneActiveVersionPerPackagePerOwner(): void
    {
        self::$pkgV2->install($this->nodeOnlyAggregate(), $this->userId, []);
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('already installed');
        self::$pkgV2->install($this->nodeOnlyAggregate(), $this->userId, []);
    }

    public function testContributedTypeIsOwnedByExactlyOnePackage(): void
    {
        self::$pkgV2->install($this->nodeOnlyAggregate(), $this->userId, []);
        // A DIFFERENT package contributing the SAME type must refuse, never first-provider-wins.
        $other = $this->nodeOnlyAggregate('media-tools-pro');
        $other['contributions']['flowNodes'][0]['type'] = 'com.acme.mediatools.generate-image';
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('already installed by another package');
        self::$pkgV2->install($other, $this->userId, []);
    }

    public function testUnsupportedAggregateFeaturesRefuseTyped(): void
    {
        $withPack = $this->nodeOnlyAggregate();
        $withPack['content'] = ['pack' => 'pack.json'];
        try {
            self::$pkgV2->install($withPack, $this->userId, []);
            $this->fail('content.pack must refuse');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('unsupported_content', $e->getMessage());
        }

        $withEntryPath = $this->nodeOnlyAggregate();
        $withEntryPath['contributions']['flowNodes'] = ['flow-nodes/x.json'];
        try {
            self::$pkgV2->install($withEntryPath, $this->userId, []);
            $this->fail('entry-path contributions must refuse on the JSON lane');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('unsupported_entry_path', $e->getMessage());
        }

        $invalid = $this->nodeOnlyAggregate();
        $invalid['package']['kind'] = 'plugin';
        try {
            self::$pkgV2->install($invalid, $this->userId, []);
            $this->fail('an invalid aggregate must refuse');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('bad_package_kind', $e->getMessage());
        }
    }

    public function testUninstallRemovesRowsAndUnknownIdReturnsNull(): void
    {
        $result = self::$pkgV2->install($this->nodeOnlyAggregate(), $this->userId, []);
        $gone = self::$pkgV2->uninstall($result['installationId'], $this->userId);
        $this->assertSame(1, $gone['nodesRemoved']);

        $stmt = self::$pdo->prepare('SELECT COUNT(*) FROM flow_node_definitions WHERE installation_id = ?');
        $stmt->execute([$result['installationId']]);
        $this->assertSame(0, (int) $stmt->fetchColumn(), 'definitions cascade with the installation');

        $this->assertNull(self::$pkgV2->uninstall($result['installationId'], $this->userId));
        $this->assertNull(self::$pkgV2->uninstall('nope', $this->userId));
    }

    // ── HTTP lane (same gates as Pack v1) ───────────────────────────────────────────────────

    public function testImportSignedV2InstallsAndStampsTrust(): void
    {
        $aggregate = $this->nodeOnlyAggregate();
        $signed = self::$signing->sign($aggregate);
        $r = $this->callImportSigned([
            'package' => $aggregate,
            'signature' => $signed['signature'],
            'alg' => $signed['alg'],
            'approvedConnectorGrants' => [],
        ]);
        $this->assertSame(201, $r['status'], json_encode($r['body']));
        $this->assertSame(2, $r['body']['formatVersion']);
        $this->assertContains($r['body']['trust'], ['official', 'local-only']);
        $this->assertSame(['com.acme.mediatools.generate-image'], $r['body']['nodeTypes']);
        $this->assertSame([], $r['body']['forms'], 'a node-only package creates no forms');
        $this->assertSame([], $r['body']['apps'], 'a node-only package creates no apps (no fake launcher)');

        // The v2 installation joins the merged installed list with its marker fields.
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $this->userId : null);
        $out = $this->controller()->listInstalled($req, new SlimResponse());
        $list = json_decode((string) $out->getBody(), true);
        $v2Rows = array_values(array_filter($list['installations'], static fn (array $i) => ($i['formatVersion'] ?? null) === 2));
        $this->assertCount(1, $v2Rows);
        $this->assertSame('extension', $v2Rows[0]['packageKind']);
        $this->assertSame(1, $v2Rows[0]['nodesInstalled']);
        $this->assertSame(0, $v2Rows[0]['formCount']);

        // DELETE /api/packs/{id} routes v2 installations through the v2 lane.
        $delReq = $this->createMock(ServerRequestInterface::class);
        $delReq->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $this->userId : null);
        $delOut = $this->controller()->uninstall($delReq, new SlimResponse(), ['installationId' => $r['body']['installationId']]);
        $del = json_decode((string) $delOut->getBody(), true);
        $this->assertSame(200, $delOut->getStatusCode());
        $this->assertSame(1, $del['nodesRemoved']);
    }

    public function testDependenciesResolveRecordEdgesAndProtectTheChild(): void
    {
        // Install the dependency first, then a package that requires it.
        $dep = self::$pkgV2->install($this->nodeOnlyAggregate(), $this->userId, []); // com.acme.media-tools v1.4.0
        $root = $this->nodeOnlyAggregate('media-suite');
        $root['dependencies'] = ['packages' => [
            ['id' => 'com.acme.media-tools', 'version' => '^1.2.0', 'reason' => 'Shares the image pipeline'],
            ['id' => 'com.acme.extras', 'version' => '^1.0.0', 'optional' => true],
        ]];
        $rootResult = self::$pkgV2->install($root, $this->userId, []);

        // The edge row records the exact lock; the receipt carries it too.
        $stmt = self::$pdo->prepare('SELECT * FROM package_dependency_edges WHERE parent_installation_id = ?');
        $stmt->execute([$rootResult['installationId']]);
        $edges = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $this->assertCount(1, $edges, 'a missing OPTIONAL dependency records no edge');
        $this->assertSame($dep['installationId'], $edges[0]['child_installation_id']);
        $this->assertSame('^1.2.0', $edges[0]['requested_range']);
        $this->assertSame('1.4.0', $edges[0]['resolved_version']);
        $receipt = json_decode((string) self::$pdo->query(
            "SELECT receipt_json FROM package_installations WHERE id = '{$rootResult['installationId']}'"
        )->fetchColumn(), true);
        $this->assertSame('1.4.0', $receipt['dependencies'][0]['resolvedVersion']);
        $this->assertSame([['id' => 'com.acme.extras', 'range' => '^1.0.0']], $receipt['missingOptionalDependencies']);

        // The depended-upon package refuses to uninstall while the required edge exists…
        try {
            self::$pkgV2->uninstall($dep['installationId'], $this->userId);
            $this->fail('uninstalling a required dependency must refuse');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('uninstall_blocked', $e->getMessage());
            $this->assertStringContainsString('Acme Media Tools', $e->getMessage());
        }
        // …and frees once the dependent is removed first.
        self::$pkgV2->uninstall($rootResult['installationId'], $this->userId);
        $gone = self::$pkgV2->uninstall($dep['installationId'], $this->userId);
        $this->assertSame(1, $gone['nodesRemoved']);
    }

    public function testMissingOrIncompatibleRequiredDependencyRefusesTyped(): void
    {
        $root = $this->nodeOnlyAggregate('needs-dep');
        $root['dependencies'] = ['packages' => [['id' => 'com.acme.media-tools', 'version' => '^1.2.0']]];
        try {
            self::$pkgV2->install($root, $this->userId, []);
            $this->fail('a missing required dependency must refuse');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('unresolved_dependencies', $e->getMessage());
            $this->assertStringContainsString('not installed', $e->getMessage());
        }

        // Install v1.4.0, then require ^2.0.0 → incompatible, names the installed version.
        self::$pkgV2->install($this->nodeOnlyAggregate(), $this->userId, []);
        $root2 = $this->nodeOnlyAggregate('needs-newer');
        $root2['dependencies'] = ['packages' => [['id' => 'com.acme.media-tools', 'version' => '^2.0.0']]];
        try {
            self::$pkgV2->install($root2, $this->userId, []);
            $this->fail('an incompatible required dependency must refuse');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('unresolved_dependencies', $e->getMessage());
            $this->assertStringContainsString('v1.4.0 is installed', $e->getMessage());
        }
    }

    public function testListDefinitionsServesTheEditorProviderSource(): void
    {
        $installed = self::$pkgV2->install($this->nodeOnlyAggregate(), $this->userId, []);
        $defs = self::$pkgV2->listDefinitions($this->userId);
        $this->assertCount(1, $defs);
        $this->assertSame('com.acme.mediatools.generate-image', $defs[0]['type']);
        $this->assertSame('com.acme.media-tools', $defs[0]['packageId']);
        $this->assertSame('Acme Media Tools', $defs[0]['packageName']);
        $this->assertTrue($defs[0]['enabled']);
        $this->assertSame('Generate image', $defs[0]['definition']['display']['label'] ?? null, 'the decoded definition rides along');

        // GET /api/flow-node-definitions returns the same rows; another user sees none.
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $this->userId : null);
        $out = $this->controller()->listFlowNodeDefinitions($req, new SlimResponse());
        $body = json_decode((string) $out->getBody(), true);
        $this->assertSame(200, $out->getStatusCode());
        $this->assertCount(1, $body['definitions']);
        $this->assertSame($defs[0]['digest'], $body['definitions'][0]['digest']);

        self::$pkgV2->uninstall($installed['installationId'], $this->userId);
        $this->assertSame([], self::$pkgV2->listDefinitions($this->userId), 'uninstall removes the definitions');
    }

    public function testImportSignedV2RequiresGrantReview(): void
    {
        $r = $this->callImportSigned(['package' => $this->nodeOnlyAggregate()]);
        $this->assertSame(400, $r['status']);
        $this->assertSame('grant_review_required', $r['body']['code'] ?? null);
    }

    public function testDescribeV2ReturnsAggregateSummaryAndBlocksInvalid(): void
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getUploadedFiles')->willReturn([]);
        $req->method('getParsedBody')->willReturn(['pack' => $this->nodeOnlyAggregate()]);
        $out = $this->controller()->describe($req, new SlimResponse());
        $body = json_decode((string) $out->getBody(), true);
        $this->assertSame(200, $out->getStatusCode());
        $this->assertSame(2, $body['formatVersion']);
        $caps = $body['capabilities'];
        $this->assertSame(0, $caps['forms']);
        $this->assertSame('com.acme.media-tools', $caps['packageV2']['id']);
        $this->assertSame('Generate image', $caps['packageV2']['nodes'][0]['label']);
        $this->assertSame(['imageGenerator'], $caps['packageV2']['requirementSlots']);

        $invalid = $this->nodeOnlyAggregate();
        $invalid['package']['version'] = 'not-semver';
        $req2 = $this->createMock(ServerRequestInterface::class);
        $req2->method('getUploadedFiles')->willReturn([]);
        $req2->method('getParsedBody')->willReturn(['pack' => $invalid]);
        $out2 = $this->controller()->describe($req2, new SlimResponse());
        $body2 = json_decode((string) $out2->getBody(), true);
        $this->assertSame(400, $out2->getStatusCode());
        $this->assertSame('invalid_package', $body2['code']);
        $this->assertNotEmpty($body2['issues']);
    }

    public function testCompileEndpointLowersInstalledCorePresetNodes(): void
    {
        // Install an extension whose node is a core-preset, author a flow using it, compile.
        $aggregate = $this->nodeOnlyAggregate('presets');
        $aggregate['contributions']['flowNodes'] = [[
            'schemaVersion' => 1,
            'type' => 'com.acme.presets.notify',
            'version' => '1.0.0',
            'display' => ['label' => 'Notify'],
            'handler' => ['kind' => 'core-preset', 'coreType' => 'condition', 'defaults' => ['expr' => 'true']],
            'sideEffects' => 'none',
        ]];
        unset($aggregate['requirements']);
        self::$pkgV2->install($aggregate, $this->userId, []);

        $flowService = new \FormLogic\Services\FlowService(self::$mysql);
        $flow = $flowService->createWorkspaceFlow($this->userId, [
            'name' => 'Compile me',
            'flowJson' => [
                'nodes' => [
                    ['id' => 'n1', 'type' => 'input', 'data' => ['event' => 'manual'], 'position' => ['x' => 0, 'y' => 0]],
                    ['id' => 'n2', 'type' => 'com.acme.presets.notify', 'data' => [], 'position' => ['x' => 200, 'y' => 0]],
                ],
                'edges' => [['id' => 'e1', 'source' => 'n1', 'target' => 'n2']],
            ],
        ]);

        $controller = new \FormLogic\Controllers\FlowCompileController($flowService, self::$pkgV2);
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $this->userId : null);
        $out = $controller->compile($req, new SlimResponse(), ['flowId' => (string) $flow['id']]);
        $body = json_decode((string) $out->getBody(), true);

        $this->assertSame(200, $out->getStatusCode());
        $this->assertTrue($body['ok'], json_encode($body['diagnostics'] ?? []));
        $this->assertSame('condition', $body['ir']['nodes'][1]['type'], 'the contributed node lowered to its core preset');
        $this->assertSame(['expr' => 'true'], $body['ir']['nodes'][1]['data']);
        $this->assertSame('com.acme.presets.notify', $body['locks'][0]['type']);
        $this->assertNotEmpty($body['irDigest']);

        // A foreign flow id (or another user) is an identical 404 — no flow-id oracle.
        $req2 = $this->createMock(ServerRequestInterface::class);
        $req2->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $this->userId : null);
        $out2 = $controller->compile($req2, new SlimResponse(), ['flowId' => 'nope']);
        $this->assertSame(404, $out2->getStatusCode());

        self::$pdo->prepare('DELETE FROM flow_definitions WHERE id = ?')->execute([(string) $flow['id']]);
    }

    // ── PKG-106: install plans — owner-bound, expiring, single-use, digest-bound ────────────

    private function planService(): \FormLogic\Services\Packages\InstallPlanService
    {
        return new \FormLogic\Services\Packages\InstallPlanService(self::$mysql, self::$pkgV2);
    }

    public function testInstallPlanProposeConfirmRoundTrip(): void
    {
        $plans = $this->planService();
        $aggregate = $this->nodeOnlyAggregate();

        // Propose: no mutations — nothing installs yet.
        $plan = $plans->propose($aggregate, $this->userId, 'community', 'json', \FormLogic\Helpers\PackCapabilities::describeV2($aggregate));
        $this->assertSame(64, strlen($plan['planDigest']));
        $this->assertSame('com.acme.media-tools', $plan['capabilities']['packageV2']['id']);
        $this->assertTrue($plan['resolution']['ok']);
        $count = self::$pdo->prepare('SELECT COUNT(*) FROM package_installations WHERE user_id = ?');
        $count->execute([$this->userId]);
        $this->assertSame(0, (int) $count->fetchColumn(), 'propose never mutates installed state');

        // Confirm with the reviewed digest: installs the STORED bytes, marks the plan used.
        $result = $plans->confirm($plan['planId'], $this->userId, $plan['planDigest'], []);
        $this->assertSame('com.acme.media-tools', $result['packageId']);
        $stored = $plans->get($plan['planId'], $this->userId);
        $this->assertSame('confirmed', $stored['state']);
        $this->assertSame($result['installationId'], $stored['installationId']);

        // Single-use: a second confirm refuses typed.
        try {
            $plans->confirm($plan['planId'], $this->userId, $plan['planDigest'], []);
            $this->fail('a used plan must refuse');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('plan_not_confirmable', $e->getMessage());
        }
    }

    public function testInstallPlanRefusesWrongDigestCancelAndStaleWorld(): void
    {
        $plans = $this->planService();
        $aggregate = $this->nodeOnlyAggregate();
        $plan = $plans->propose($aggregate, $this->userId, 'community', 'json', \FormLogic\Helpers\PackCapabilities::describeV2($aggregate));

        // A wrong digest is proof the caller did NOT review this plan.
        try {
            $plans->confirm($plan['planId'], $this->userId, str_repeat('0', 64), []);
            $this->fail('a digest mismatch must refuse');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('plan_digest_mismatch', $e->getMessage());
        }

        // Cancel discards it; a cancelled plan cannot confirm.
        $this->assertTrue($plans->cancel($plan['planId'], $this->userId));
        try {
            $plans->confirm($plan['planId'], $this->userId, $plan['planDigest'], []);
            $this->fail('a cancelled plan must refuse');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('plan_not_confirmable', $e->getMessage());
        }

        // §7.3.10: the world is re-checked at confirm. Propose, then install the same package
        // directly — the stale plan fails cleanly and is terminally 'failed'.
        $plan2 = $plans->propose($aggregate, $this->userId, 'community', 'json', \FormLogic\Helpers\PackCapabilities::describeV2($aggregate));
        self::$pkgV2->install($aggregate, $this->userId, []);
        try {
            $plans->confirm($plan2['planId'], $this->userId, $plan2['planDigest'], []);
            $this->fail('a stale plan must fail at fresh resolution');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('already installed', $e->getMessage());
        }
        $this->assertSame('failed', $plans->get($plan2['planId'], $this->userId)['state']);

        // Foreign/missing plan ids are identical refusals (no plan-id oracle).
        $this->assertNull($plans->get('nope', $this->userId));
        $this->assertFalse($plans->cancel('nope', $this->userId));
    }

    public function testInstallPlanHttpLaneRequiresGrantsAndDigest(): void
    {
        $controller = new \FormLogic\Controllers\PackageInstallPlanController($this->planService(), self::$signing);

        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $this->userId : null);
        $req->method('getParsedBody')->willReturn(['package' => $this->nodeOnlyAggregate()]);
        $out = $controller->propose($req, new SlimResponse());
        $body = json_decode((string) $out->getBody(), true);
        $this->assertSame(201, $out->getStatusCode(), json_encode($body));
        $this->assertSame('community', $body['trust']);
        $this->assertNotEmpty($body['planDigest']);

        // Confirm without the SAFE-001 grant array fails closed.
        $req2 = $this->createMock(ServerRequestInterface::class);
        $req2->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $this->userId : null);
        $req2->method('getParsedBody')->willReturn(['planDigest' => $body['planDigest']]);
        $out2 = $controller->confirm($req2, new SlimResponse(), ['id' => $body['planId']]);
        $this->assertSame(400, $out2->getStatusCode());
        $this->assertSame('grant_review_required', json_decode((string) $out2->getBody(), true)['code']);

        // Confirm without the digest fails closed too.
        $req3 = $this->createMock(ServerRequestInterface::class);
        $req3->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $this->userId : null);
        $req3->method('getParsedBody')->willReturn(['approvedConnectorGrants' => []]);
        $out3 = $controller->confirm($req3, new SlimResponse(), ['id' => $body['planId']]);
        $this->assertSame(400, $out3->getStatusCode());
        $this->assertSame('plan_digest_required', json_decode((string) $out3->getBody(), true)['code']);

        // A complete confirm installs and returns the import-lane result shape.
        $req4 = $this->createMock(ServerRequestInterface::class);
        $req4->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $this->userId : null);
        $req4->method('getParsedBody')->willReturn(['planDigest' => $body['planDigest'], 'approvedConnectorGrants' => []]);
        $out4 = $controller->confirm($req4, new SlimResponse(), ['id' => $body['planId']]);
        $confirmed = json_decode((string) $out4->getBody(), true);
        $this->assertSame(201, $out4->getStatusCode(), json_encode($confirmed));
        $this->assertSame(['com.acme.mediatools.generate-image'], $confirmed['nodeTypes']);
        $this->assertSame([], $confirmed['forms']);
    }

    public function testDesktopFlowListCarriesCompiledIrForContributedFlows(): void
    {
        // RUN-301 desktop leg: GET /api/v1/flows (the desktop's snapshot source) ships the
        // revision's compiled IR for flows whose graphs store contributed node types — and
        // nothing extra for plain flows.
        $aggregate = $this->nodeOnlyAggregate('desktop-ir');
        $aggregate['contributions']['flowNodes'][0]['type'] = 'com.acme.desktopir.greet';
        $aggregate['contributions']['flowNodes'][0]['handler'] = ['kind' => 'core-preset', 'coreType' => 'template', 'defaults' => ['template' => 'hi']];
        unset($aggregate['requirements']);
        self::$pkgV2->install($aggregate, $this->userId, []);

        $flowService = new \FormLogic\Services\FlowService(self::$mysql);
        $withNode = $flowService->createWorkspaceFlow($this->userId, [
            'name' => 'Desktop IR flow',
            'flowJson' => [
                'nodes' => [
                    ['id' => 'in', 'type' => 'input', 'data' => [], 'position' => ['x' => 0, 'y' => 0]],
                    ['id' => 'g', 'type' => 'com.acme.desktopir.greet', 'data' => [], 'position' => ['x' => 200, 'y' => 0]],
                ],
                'edges' => [['source' => 'in', 'target' => 'g']],
            ],
        ]);
        $plain = $flowService->createWorkspaceFlow($this->userId, [
            'name' => 'Plain flow',
            'flowJson' => ['nodes' => [['id' => 'in', 'type' => 'input', 'data' => [], 'position' => ['x' => 0, 'y' => 0]]], 'edges' => []],
        ]);

        $controller = new \FormLogic\Controllers\FlowController(
            $flowService,
            new \FormLogic\Services\AppService(self::$mysql, new \FormLogic\Services\FormService(self::$mysql, new \FormLogic\Database\SQLiteConnection(sys_get_temp_dir() . '/fl-pkgv2-ir-' . bin2hex(random_bytes(4))))),
            new \FormLogic\Services\AppUserService(self::$mysql)
        );
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $this->userId : null);
        $req->method('getQueryParams')->willReturn([]);
        $out = $controller->listOwnerFlows($req, new SlimResponse());
        $body = json_decode((string) $out->getBody(), true);
        $this->assertSame(200, $out->getStatusCode());

        $byId = [];
        foreach ($body['flows'] as $f) {
            $byId[$f['id']] = $f;
        }
        $ir = $byId[$withNode['id']]['compiledIr'] ?? null;
        $this->assertIsArray($ir, 'the contributed flow ships its compiled IR');
        $this->assertSame('template', $ir['nodes'][1]['type'], 'the IR carries the lowered node');
        $this->assertArrayNotHasKey('compiledIr', $byId[$plain['id']], 'plain flows carry nothing extra');
        $this->assertSame('com.acme.desktopir.greet', $byId[$withNode['id']]['flowJson']['nodes'][1]['type'], 'the stored graph keeps the contributed identity');

        self::$pdo->prepare('DELETE FROM flow_definitions WHERE owner_user_id = ?')->execute([$this->userId]);
    }

    public function testReceiptEndpointReturnsInstallationDetail(): void
    {
        // Install with a dependency so the receipt carries edges too.
        $dep = self::$pkgV2->install($this->nodeOnlyAggregate(), $this->userId, []);
        $root = $this->nodeOnlyAggregate('with-dep');
        $root['dependencies'] = ['packages' => [['id' => 'com.acme.media-tools', 'version' => '^1.0.0']]];
        $rootResult = self::$pkgV2->install($root, $this->userId, []);

        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $this->userId : null);
        $out = $this->controller()->getPackageInstallation($req, new SlimResponse(), ['id' => $rootResult['installationId']]);
        $body = json_decode((string) $out->getBody(), true);
        $this->assertSame(200, $out->getStatusCode());
        $inst = $body['installation'];
        $this->assertSame('com.acme.with-dep', $inst['packageId']);
        $this->assertSame('ready', $inst['state']);
        $this->assertSame('com.acme.withdep.generate-image', $inst['nodes'][0]['type']);
        $this->assertSame(64, strlen($inst['nodes'][0]['digest']));
        $this->assertSame('com.acme.media-tools', $inst['dependencies'][0]['packageId']);
        $this->assertSame('1.4.0', $inst['dependencies'][0]['resolvedVersion']);
        $this->assertSame('1.4.0', $inst['receipt']['dependencies'][0]['resolvedVersion'] ?? null, 'the immutable receipt rides along');
        $this->assertSame([], $inst['dependents'], 'nothing depends on the dependent itself');

        // MKT-605: the DEPENDED-UPON package reports its inbound edge — what blocks its
        // uninstall and constrains its updates, surfaced before the user commits either.
        $reqDep = $this->createMock(ServerRequestInterface::class);
        $reqDep->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $this->userId : null);
        $outDep = $this->controller()->getPackageInstallation($reqDep, new SlimResponse(), ['id' => $dep['installationId']]);
        $depBody = json_decode((string) $outDep->getBody(), true)['installation'];
        $this->assertSame([], $depBody['dependencies']);
        $this->assertCount(1, $depBody['dependents']);
        $this->assertSame('com.acme.with-dep', $depBody['dependents'][0]['packageId']);
        $this->assertSame('Acme Media Tools', $depBody['dependents'][0]['displayName']);
        $this->assertSame('^1.0.0', $depBody['dependents'][0]['range']);
        $this->assertTrue($depBody['dependents'][0]['required']);

        // Foreign/missing ids are identical 404s.
        $req2 = $this->createMock(ServerRequestInterface::class);
        $req2->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $this->userId : null);
        $out2 = $this->controller()->getPackageInstallation($req2, new SlimResponse(), ['id' => 'nope']);
        $this->assertSame(404, $out2->getStatusCode());
    }

    public function testKillSwitchDisablesInstallLanesButNotManagement(): void
    {
        // REL-705: with APPLICATION_PACKAGES_V2=false, install lanes refuse and definitions go
        // dark — but installed content stays visible and removable.
        $installed = self::$pkgV2->install($this->nodeOnlyAggregate(), $this->userId, []);
        $prev = $_ENV['APPLICATION_PACKAGES_V2'] ?? null;
        $_ENV['APPLICATION_PACKAGES_V2'] = 'false';
        try {
            // Definitions serving goes dark (editor degrades to placeholders; mints pin no IR).
            $this->assertSame([], self::$pkgV2->listDefinitions($this->userId));

            // New installs refuse typed at the service…
            try {
                self::$pkgV2->install($this->nodeOnlyAggregate('another'), $this->userId, []);
                $this->fail('install must refuse while disabled');
            } catch (\RuntimeException $e) {
                $this->assertStringContainsString('feature_disabled', $e->getMessage());
            }

            // …and 503 at the HTTP lanes (import branch + install-plan propose + describe).
            $r = $this->callImportSigned(['package' => $this->nodeOnlyAggregate('another'), 'approvedConnectorGrants' => []]);
            $this->assertSame(503, $r['status']);
            $this->assertSame('feature_disabled', $r['body']['code'] ?? null);

            $planController = new \FormLogic\Controllers\PackageInstallPlanController($this->planService(), self::$signing);
            $req = $this->createMock(ServerRequestInterface::class);
            $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $this->userId : null);
            $req->method('getParsedBody')->willReturn(['package' => $this->nodeOnlyAggregate('another')]);
            $out = $planController->propose($req, new SlimResponse());
            $this->assertSame(503, $out->getStatusCode());

            $dreq = $this->createMock(ServerRequestInterface::class);
            $dreq->method('getUploadedFiles')->willReturn([]);
            $dreq->method('getParsedBody')->willReturn(['pack' => $this->nodeOnlyAggregate('another')]);
            $dout = $this->controller()->describe($dreq, new SlimResponse());
            $this->assertSame(503, $dout->getStatusCode());

            // Management stays: the merged installed list still shows the row, receipts read,
            // and uninstall works — operators can always remove content while the plane is off.
            $lreq = $this->createMock(ServerRequestInterface::class);
            $lreq->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $this->userId : null);
            $lout = $this->controller()->listInstalled($lreq, new SlimResponse());
            $list = json_decode((string) $lout->getBody(), true);
            $v2Rows = array_filter($list['installations'], static fn (array $i) => ($i['formatVersion'] ?? null) === 2);
            $this->assertCount(1, $v2Rows);
            $this->assertNotNull(self::$pkgV2->getInstallation($installed['installationId'], $this->userId));
            $gone = self::$pkgV2->uninstall($installed['installationId'], $this->userId);
            $this->assertSame(1, $gone['nodesRemoved']);
        } finally {
            if ($prev === null) {
                unset($_ENV['APPLICATION_PACKAGES_V2']);
            } else {
                $_ENV['APPLICATION_PACKAGES_V2'] = $prev;
            }
        }
    }

    // ── PKG-108: updates — atomic, identity-preserving, dependent-protecting ────────────────

    public function testUpdateReplacesDefinitionsAndKeepsInstallationIdentity(): void
    {
        $v1 = self::$pkgV2->install($this->nodeOnlyAggregate(), $this->userId, []); // v1.4.0

        // v1.5.0 bumps the existing node AND contributes a new one.
        $next = $this->nodeOnlyAggregate();
        $next['package']['version'] = '1.5.0';
        $next['contributions']['flowNodes'][0]['version'] = '1.3.0';
        $next['contributions']['flowNodes'][] = [
            'schemaVersion' => 1,
            'type' => 'com.acme.mediatools.upscale',
            'version' => '1.0.0',
            'display' => ['label' => 'Upscale'],
            'handler' => ['kind' => 'core-preset', 'coreType' => 'condition', 'defaults' => ['expr' => 'true']],
            'sideEffects' => 'none',
        ];
        $result = self::$pkgV2->update($next, $this->userId, ['connector.acme.media'], 'json', 'community');
        $this->assertSame($v1['installationId'], $result['installationId'], 'an update keeps the installation identity');
        $this->assertSame('1.4.0', $result['previousVersion']);
        $this->assertSame('1.5.0', $result['version']);

        $stmt = self::$pdo->prepare('SELECT version, receipt_json FROM package_installations WHERE id = ?');
        $stmt->execute([$v1['installationId']]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        $this->assertSame('1.5.0', $row['version']);
        $receipt = json_decode((string) $row['receipt_json'], true);
        $this->assertSame('1.4.0', $receipt['updatedFrom'], 'the receipt records what it replaced');
        $this->assertSame(['connector.acme.media'], $receipt['approvedConnectorGrants']);

        $defs = self::$pdo->prepare('SELECT node_type, version FROM flow_node_definitions WHERE installation_id = ? ORDER BY node_type');
        $defs->execute([$v1['installationId']]);
        $this->assertSame([
            ['node_type' => 'com.acme.mediatools.generate-image', 'version' => '1.3.0'],
            ['node_type' => 'com.acme.mediatools.upscale', 'version' => '1.0.0'],
        ], $defs->fetchAll(PDO::FETCH_ASSOC));

        // v1.6.0 DROPS the original node — its definition row goes with it (stored graph
        // nodes of that type degrade to the honest missing-definition placeholder).
        $slim = $this->nodeOnlyAggregate();
        $slim['package']['version'] = '1.6.0';
        $slim['contributions']['flowNodes'] = [[
            'schemaVersion' => 1,
            'type' => 'com.acme.mediatools.upscale',
            'version' => '1.1.0',
            'display' => ['label' => 'Upscale'],
            'handler' => ['kind' => 'core-preset', 'coreType' => 'condition', 'defaults' => ['expr' => 'true']],
            'sideEffects' => 'none',
        ]];
        unset($slim['requirements']);
        $result2 = self::$pkgV2->update($slim, $this->userId, []);
        $this->assertSame($v1['installationId'], $result2['installationId']);
        $this->assertSame('1.5.0', $result2['previousVersion']);
        $defs->execute([$v1['installationId']]);
        $this->assertSame([
            ['node_type' => 'com.acme.mediatools.upscale', 'version' => '1.1.0'],
        ], $defs->fetchAll(PDO::FETCH_ASSOC), 'removed contributions are removed, never orphaned');
    }

    public function testUpdateRefusesSameVersionNotInstalledAndForeignPublisher(): void
    {
        try {
            self::$pkgV2->update($this->nodeOnlyAggregate(), $this->userId, []);
            $this->fail('updating a package that is not installed must refuse');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('not_installed', $e->getMessage());
        }

        self::$pkgV2->install($this->nodeOnlyAggregate(), $this->userId, []);
        try {
            self::$pkgV2->update($this->nodeOnlyAggregate(), $this->userId, []);
            $this->fail('re-applying the installed version must refuse');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('already installed at v1.4.0', $e->getMessage());
        }

        // A DIFFERENT publisher shipping the same package id is a hijack, not an update.
        // (Needs a >=3-segment id so two distinct valid publisher prefixes exist.)
        $deep = $this->nodeOnlyAggregate();
        $deep['package']['id'] = 'com.acme.deep.pkg';
        $deep['contributions']['flowNodes'][0]['type'] = 'com.acme.deep.node';
        self::$pkgV2->install($deep, $this->userId, []);
        $hijack = $deep;
        $hijack['package']['version'] = '9.9.9';
        $hijack['package']['publisherId'] = 'com.acme.deep';
        try {
            self::$pkgV2->update($hijack, $this->userId, []);
            $this->fail('a publisher change must refuse');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('publisher_mismatch', $e->getMessage());
        }
    }

    public function testUpdateBlockedByDependentRangeAndAllowedWithinIt(): void
    {
        // media-tools v1.4.0 with a dependent pinning ^1.2.0.
        self::$pkgV2->install($this->nodeOnlyAggregate(), $this->userId, []);
        $suite = $this->nodeOnlyAggregate('media-suite');
        $suite['dependencies'] = ['packages' => [['id' => 'com.acme.media-tools', 'version' => '^1.2.0']]];
        $suiteResult = self::$pkgV2->install($suite, $this->userId, []);

        // v2.0.0 escapes ^1.2.0 → refused, naming the dependent; NOTHING changed.
        $major = $this->nodeOnlyAggregate();
        $major['package']['version'] = '2.0.0';
        try {
            self::$pkgV2->update($major, $this->userId, []);
            $this->fail('an update escaping a dependent range must refuse');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('update_blocked', $e->getMessage());
            $this->assertStringContainsString('Acme Media Tools', $e->getMessage());
            $this->assertStringContainsString('^1.2.0', $e->getMessage());
        }
        $check = self::$pdo->prepare('SELECT version FROM package_installations WHERE user_id = ? AND package_id = ?');
        $check->execute([$this->userId, 'com.acme.media-tools']);
        $this->assertSame('1.4.0', $check->fetchColumn(), 'a refused update leaves the prior version fully active');

        // v1.9.0 stays inside ^1.2.0 → allowed; the dependent's edge re-locks to it.
        $minor = $this->nodeOnlyAggregate();
        $minor['package']['version'] = '1.9.0';
        self::$pkgV2->update($minor, $this->userId, []);
        $edge = self::$pdo->prepare('SELECT resolved_version FROM package_dependency_edges WHERE parent_installation_id = ?');
        $edge->execute([$suiteResult['installationId']]);
        $this->assertSame('1.9.0', $edge->fetchColumn(), 'inbound edges re-lock to the updated version');
    }

    public function testInstallPlanProposesAndConfirmsAnUpdate(): void
    {
        self::$pkgV2->install($this->nodeOnlyAggregate(), $this->userId, []); // v1.4.0
        $plans = $this->planService();

        $next = $this->nodeOnlyAggregate();
        $next['package']['version'] = '1.5.0';
        $plan = $plans->propose($next, $this->userId, 'community', 'json', \FormLogic\Helpers\PackCapabilities::describeV2($next));
        $this->assertSame('update', $plan['action'], 'a same-id different-version proposal is an update');
        $this->assertSame('1.4.0', $plan['installedVersion']);
        $this->assertSame('update', $plans->get($plan['planId'], $this->userId)['action']);

        $result = $plans->confirm($plan['planId'], $this->userId, $plan['planDigest'], []);
        $this->assertSame('1.4.0', $result['previousVersion']);
        $this->assertSame('1.5.0', $result['version']);
        $check = self::$pdo->prepare('SELECT version FROM package_installations WHERE user_id = ? AND package_id = ?');
        $check->execute([$this->userId, 'com.acme.media-tools']);
        $this->assertSame('1.5.0', $check->fetchColumn());

        // Proposing the version that is ALREADY installed refuses at propose (like the install).
        try {
            $plans->propose($next, $this->userId, 'community', 'json', \FormLogic\Helpers\PackCapabilities::describeV2($next));
            $this->fail('proposing the installed version must refuse');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('already installed at v1.5.0', $e->getMessage());
        }
    }

    // ── SRV-405: service binding slots — the package declares a slot, the owner fills it ────

    private function bindingService(): \FormLogic\Services\Packages\ServiceBindingService
    {
        return new \FormLogic\Services\Packages\ServiceBindingService(self::$mysql);
    }

    public function testSlotsComeFromTheReceiptAndOnlyDeclaredSlotsCanBind(): void
    {
        // nodeOnlyAggregate() declares requirements.services[] slot "imageGenerator".
        $installed = self::$pkgV2->install($this->nodeOnlyAggregate(), $this->userId, []);
        $bindings = $this->bindingService();

        $slots = $bindings->listSlots($installed['installationId'], $this->userId);
        $this->assertSame([[
            'slot' => 'imageGenerator',
            'required' => true,
            'requiredActions' => ['generate-image'],
            'binding' => null,
        ]], $slots, 'declared slots come from the immutable receipt, unbound by default');

        // A slot the package never declared cannot be bound — that would grant reach the
        // install review never showed.
        try {
            $bindings->bind($installed['installationId'], $this->userId, 'somethingElse', 'openai-api', 'conn-1');
            $this->fail('binding an undeclared slot must refuse');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('unknown_slot', $e->getMessage());
        }
        // Nor can a malformed binding be stored.
        foreach ([['', 'conn-1'], ['bad id!', 'conn-1'], ['openai-api', '']] as [$definitionId, $connection]) {
            try {
                $bindings->bind($installed['installationId'], $this->userId, 'imageGenerator', $definitionId, $connection);
                $this->fail('a malformed binding must refuse');
            } catch (\RuntimeException $e) {
                $this->assertStringContainsString('invalid_binding', $e->getMessage());
            }
        }

        // Bind, re-bind (idempotent per slot), then unbind.
        $bindings->bind($installed['installationId'], $this->userId, 'imageGenerator', 'openai-api', 'conn-1');
        $bindings->bind($installed['installationId'], $this->userId, 'imageGenerator', 'openai-api', 'conn-2');
        $slots = $bindings->listSlots($installed['installationId'], $this->userId);
        $this->assertSame('conn-2', $slots[0]['binding']['connection'], 're-binding replaces, never duplicates');
        $count = self::$pdo->prepare('SELECT COUNT(*) FROM package_service_bindings WHERE installation_id = ?');
        $count->execute([$installed['installationId']]);
        $this->assertSame(1, (int) $count->fetchColumn());

        $this->assertTrue($bindings->unbind($installed['installationId'], $this->userId, 'imageGenerator'));
        $this->assertFalse($bindings->unbind($installed['installationId'], $this->userId, 'imageGenerator'));
        $this->assertNull($bindings->listSlots($installed['installationId'], 'someone-else'), 'foreign installations are invisible');

        // Uninstalling takes the bindings with it (FK cascade) — no orphan grants survive.
        $bindings->bind($installed['installationId'], $this->userId, 'imageGenerator', 'openai-api', 'conn-1');
        self::$pkgV2->uninstall($installed['installationId'], $this->userId);
        $count->execute([$installed['installationId']]);
        $this->assertSame(0, (int) $count->fetchColumn());
    }

    public function testServiceActionNodeCompilesOnlyOnceItsSlotIsBound(): void
    {
        $installed = self::$pkgV2->install($this->nodeOnlyAggregate(), $this->userId, []);
        $bindings = $this->bindingService();
        $flowService = new \FormLogic\Services\FlowService(self::$mysql);
        $flow = $flowService->createWorkspaceFlow($this->userId, [
            'name' => 'Service action flow',
            'flowJson' => [
                'nodes' => [
                    ['id' => 'in', 'type' => 'input', 'data' => [], 'position' => ['x' => 0, 'y' => 0]],
                    ['id' => 'gen', 'type' => 'com.acme.mediatools.generate-image', 'data' => ['prompt' => 'a cat'], 'position' => ['x' => 200, 'y' => 0]],
                ],
                'edges' => [['id' => 'e1', 'source' => 'in', 'target' => 'gen']],
            ],
        ]);
        $controller = new \FormLogic\Controllers\FlowCompileController($flowService, self::$pkgV2, $bindings);
        $compile = function () use ($controller, $flow): array {
            $req = $this->createMock(ServerRequestInterface::class);
            $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $this->userId : null);
            $out = $controller->compile($req, new SlimResponse(), ['flowId' => (string) $flow['id']]);
            return json_decode((string) $out->getBody(), true);
        };

        // Unbound: fail closed at COMPILE, naming the slot — never a run that must fail.
        $before = $compile();
        $this->assertFalse($before['ok']);
        $this->assertSame('binding_unresolved', $before['diagnostics'][0]['code']);
        $this->assertStringContainsString('imageGenerator', $before['diagnostics'][0]['message']);
        $this->assertNull($before['ir']);

        // Bound: lowers to the canonical service_action the runtimes already execute.
        $bindings->bind($installed['installationId'], $this->userId, 'imageGenerator', 'openai-api', 'provider-profile-7');
        $after = $compile();
        $this->assertTrue($after['ok'], json_encode($after['diagnostics']));
        $node = $after['ir']['nodes'][1];
        $this->assertSame('service_action', $node['type']);
        $this->assertSame('openai-api', $node['data']['definitionId']);
        $this->assertSame('generate-image', $node['data']['actionId'], 'actionId comes from the definition, not the binding');
        $this->assertSame('provider-profile-7', $node['data']['connection']);
        $this->assertSame(['prompt' => 'a cat'], $node['data']['input'], "the node's own configuration is the action input");

        // The lock pins what it was compiled against — a later re-bind is a DIFFERENT lock,
        // never a silent swap under an already-published revision.
        $lock = $after['locks'][0];
        $this->assertSame('service-action', $lock['handlerKind']);
        $this->assertSame('service_action', $lock['loweredTo']);
        $this->assertSame('imageGenerator', $lock['bindingSlot']);
        $this->assertSame('openai-api', $lock['boundDefinitionId']);
        $this->assertSame('generate-image', $lock['boundActionId']);

        // Removing the binding refuses again (no stale capability).
        $bindings->unbind($installed['installationId'], $this->userId, 'imageGenerator');
        $this->assertFalse($compile()['ok']);

        self::$pdo->prepare('DELETE FROM flow_definitions WHERE id = ?')->execute([(string) $flow['id']]);
    }

    public function testServiceBindingHttpLaneGatesSlotsAndOwnership(): void
    {
        $installed = self::$pkgV2->install($this->nodeOnlyAggregate(), $this->userId, []);
        $controller = new PackController(self::$packs, null, null, self::$signing, null, self::$pkgV2, $this->bindingService());
        $call = function (string $method, array $args, array $body = []) use ($controller) {
            $req = $this->createMock(ServerRequestInterface::class);
            $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $this->userId : null);
            $req->method('getParsedBody')->willReturn($body);
            $out = $controller->$method($req, new SlimResponse(), $args);
            return ['status' => $out->getStatusCode(), 'body' => json_decode((string) $out->getBody(), true) ?: []];
        };

        $list = $call('listServiceBindings', ['id' => $installed['installationId']]);
        $this->assertSame(200, $list['status']);
        $this->assertSame('imageGenerator', $list['body']['slots'][0]['slot']);
        $this->assertNull($list['body']['slots'][0]['binding']);

        $bad = $call('putServiceBinding', ['id' => $installed['installationId'], 'slot' => 'nope'], ['definitionId' => 'openai-api', 'connection' => 'c1']);
        $this->assertSame(400, $bad['status']);
        $this->assertSame('unknown_slot', $bad['body']['code']);

        $ok = $call('putServiceBinding', ['id' => $installed['installationId'], 'slot' => 'imageGenerator'], ['definitionId' => 'openai-api', 'connection' => 'c1']);
        $this->assertSame(200, $ok['status']);
        $this->assertSame('c1', $call('listServiceBindings', ['id' => $installed['installationId']])['body']['slots'][0]['binding']['connection']);

        $this->assertSame(200, $call('deleteServiceBinding', ['id' => $installed['installationId'], 'slot' => 'imageGenerator'])['status']);
        $this->assertSame(404, $call('deleteServiceBinding', ['id' => $installed['installationId'], 'slot' => 'imageGenerator'])['status']);
        // Foreign/missing installation ids are identical 404s on every verb.
        $this->assertSame(404, $call('listServiceBindings', ['id' => 'nope'])['status']);
        $this->assertSame(404, $call('putServiceBinding', ['id' => 'nope', 'slot' => 'imageGenerator'], ['definitionId' => 'openai-api', 'connection' => 'c1'])['status']);
    }

    public function testFlatImportLaneRedirectsV2Aggregates(): void
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $this->userId : null);
        $req->method('getParsedBody')->willReturn(['pack' => $this->nodeOnlyAggregate(), 'approvedConnectorGrants' => []]);
        $out = $this->controller()->import($req, new SlimResponse());
        $body = json_decode((string) $out->getBody(), true);
        $this->assertSame(400, $out->getStatusCode());
        $this->assertSame('use_application_package_lane', $body['code']);
    }
}
