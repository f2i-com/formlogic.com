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
