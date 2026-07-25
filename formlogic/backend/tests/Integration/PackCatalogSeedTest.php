<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\PackCatalogController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FormService;
use FormLogic\Services\PackCatalogService;
use FormLogic\Services\PackService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Response as SlimResponse;

/**
 * MKT-602: the marketplace catalog is seeded from the SERVER'S official packs.
 *
 * Previously the browser bundled every pack payload and POSTed it, and the endpoint published
 * whatever arrived — attributed to the platform owner — whenever the catalog was empty. On a
 * fresh deployment that made "official" mean "whatever the first person to open the modal
 * sent". These tests pin that a request body can no longer influence what gets published.
 */
class PackCatalogSeedTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static PackCatalogService $catalog;

    private string $userId = '';

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        try {
            $conn = new MySQLConnection([
                'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
                'port' => $_ENV['DB_PORT'] ?? '3306',
                'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
                'username' => $_ENV['DB_USERNAME'] ?? 'root',
                'password' => $_ENV['DB_PASSWORD'] ?? '',
                'charset' => 'utf8mb4',
                'collation' => 'utf8mb4_unicode_ci',
            ]);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-seed-' . bin2hex(random_bytes(4)));
        $forms = new FormService($conn, $sqlite);
        $apps = new AppService($conn, $forms);
        self::$catalog = new PackCatalogService($conn, new PackService($conn, $forms, $apps, new AppUserService($conn)));
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        // Seeding only runs against an EMPTY catalog, so start from one.
        self::$pdo->exec('DELETE FROM pack_catalog');
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->userId, $this->userId . '@test.local']);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        self::$pdo->exec('DELETE FROM pack_catalog');
        if ($this->userId !== '') {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
        }
    }

    /** @return array{status:int, body:array} */
    private function seed(array $body): array
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $this->userId : null);
        $req->method('getParsedBody')->willReturn($body);
        $out = (new PackCatalogController(self::$catalog, new \FormLogic\Services\PackFileService([])))->seed($req, new SlimResponse());
        return ['status' => $out->getStatusCode(), 'body' => json_decode((string) $out->getBody(), true) ?: []];
    }

    public function testSeedsFromTheServersOwnOfficialPacks(): void
    {
        $result = $this->seed([]);
        $this->assertSame(200, $result['status'], json_encode($result['body']));
        $this->assertGreaterThan(0, $result['body']['seeded'], 'the deployment ships packs to seed');

        // What landed matches the files on disk, not anything a caller sent.
        $names = self::$pdo->query('SELECT name FROM pack_catalog')->fetchAll(PDO::FETCH_COLUMN);
        $this->assertNotEmpty($names);
        $onDisk = [];
        foreach (glob(dirname(__DIR__, 2) . '/resources/marketplace-packs/*.json') ?: [] as $file) {
            $decoded = json_decode((string) file_get_contents($file), true);
            if (is_array($decoded) && is_string($decoded['name'] ?? null)) {
                $onDisk[] = $decoded['name'];
            }
        }
        // MKT: the catalog also carries the Application Package v2 extensions this deployment
        // ships. They live in their own directory because they are a different aggregate, but
        // they are equally the SERVER'S OWN files — which is the property under test here.
        foreach (glob(dirname(__DIR__, 2) . '/resources/bundled-extensions/*.json') ?: [] as $file) {
            $decoded = json_decode((string) file_get_contents($file), true);
            if (is_array($decoded) && is_string($decoded['package']['displayName'] ?? null)) {
                $onDisk[] = $decoded['package']['displayName'];
            }
        }
        foreach ($names as $name) {
            $this->assertContains($name, $onDisk, "seeded pack {$name} came from the server's own set");
        }
    }

    public function testAClientSuppliedPackIsIgnoredEntirely(): void
    {
        // The old contract: this body would have been published as an official pack.
        $result = $this->seed(['packs' => [[
            'name' => 'Totally Legit Payroll',
            'description' => 'Definitely official',
            'tags' => ['finance'],
            'pack' => ['name' => 'Totally Legit Payroll', 'version' => '1.0.0', 'forms' => [['title' => 'Give me your bank details', 'fields' => []]]],
        ]]]);
        $this->assertSame(200, $result['status'], json_encode($result['body']));

        $names = self::$pdo->query('SELECT name FROM pack_catalog')->fetchAll(PDO::FETCH_COLUMN);
        $this->assertNotContains('Totally Legit Payroll', $names, 'a request body cannot define what "official" means');
        $this->assertGreaterThan(0, count($names), 'the server still seeded its own packs');
    }

    public function testSeedingIsIdempotentOnceTheCatalogHasPacks(): void
    {
        $first = $this->seed([]);
        $this->assertGreaterThan(0, $first['body']['seeded']);
        $countAfterFirst = (int) self::$pdo->query('SELECT COUNT(*) FROM pack_catalog')->fetchColumn();

        $second = $this->seed([]);
        $this->assertSame(0, $second['body']['seeded'], 'a populated catalog is never re-seeded');
        $this->assertSame($countAfterFirst, (int) self::$pdo->query('SELECT COUNT(*) FROM pack_catalog')->fetchColumn());
    }
    public function testSeedingAddsWhatIsMissingRatherThanStoppingAtTheFirstRow(): void
    {
        // Seeding used to return early the moment the catalog had any rows, which made anything
        // the deployment shipped LATER invisible on every deployment that had already
        // bootstrapped — that is, every deployment in use.
        $first = $this->seed([]);
        $this->assertGreaterThan(0, $first['body']['seeded']);

        // Drop one listing to stand in for something newly shipped, then seed again.
        $slug = (string) self::$pdo->query('SELECT slug FROM pack_catalog ORDER BY slug LIMIT 1')->fetchColumn();
        $before = (int) self::$pdo->query('SELECT COUNT(*) FROM pack_catalog')->fetchColumn();
        self::$pdo->prepare('DELETE FROM pack_catalog WHERE slug = ?')->execute([$slug]);

        $second = $this->seed([]);
        $this->assertSame(1, $second['body']['seeded'], 'the missing one is added back');
        $this->assertSame(
            $before,
            (int) self::$pdo->query('SELECT COUNT(*) FROM pack_catalog')->fetchColumn(),
            'and nothing is duplicated'
        );

        // A call with nothing missing writes nothing — idempotent, not merely tolerable.
        $third = $this->seed([]);
        $this->assertSame(0, $third['body']['seeded']);
        $this->assertSame(
            $before,
            (int) self::$pdo->query('SELECT COUNT(*) FROM pack_catalog')->fetchColumn()
        );
    }

    public function testTheBundledV2ExtensionIsSeededAsAV2Listing(): void
    {
        $this->seed([]);
        $row = self::$pdo->query(
            "SELECT pv.format_version, pv.node_count, pc.tags
             FROM pack_catalog pc
             JOIN pack_versions pv ON pv.catalog_id = pc.id
             WHERE pc.name = 'AI Toolkit' LIMIT 1"
        )->fetch(\PDO::FETCH_ASSOC);

        $this->assertIsArray($row, 'the bundled extension is in the catalog');
        $this->assertSame(2, (int) $row['format_version'], 'listed as v2, so the client routes it correctly');
        $this->assertSame(3, (int) $row['node_count']);
        // package.keywords became the searchable tags — the package says how it wants to be
        // found once, in its own manifest.
        $this->assertContains('text-to-speech', json_decode((string) $row['tags'], true));
    }
}
