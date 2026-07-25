<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\PackCatalogService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * MKT: the marketplace catalog carries Application Package v2 aggregates beside Pack v1.
 *
 * The property under test is that a listing DECLARES which lane installs it, rather than the
 * reader inferring it from the payload's shape — a v1 pack imports directly, a v2 aggregate goes
 * through propose/confirm with a grant review, and guessing wrong runs the wrong one.
 */
class PackCatalogV2Test extends TestCase
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
        self::$catalog = new PackCatalogService($conn);
    }

    protected function setUp(): void
    {
        $this->userId = 'cat-' . bin2hex(random_bytes(8));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'Publisher')")
            ->execute([$this->userId, $this->userId . '@example.com']);
    }

    protected function tearDown(): void
    {
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    /** The AI Toolkit this deployment ships — a real aggregate, not a hand-built stub. */
    private function bundledAggregate(): array
    {
        $path = dirname(__DIR__, 2) . '/resources/bundled-extensions/ai-toolkit.json';
        $aggregate = json_decode((string) file_get_contents($path), true);
        $this->assertIsArray($aggregate, 'the bundled AI Toolkit is readable');
        return $aggregate;
    }

    private function publish(array $payload, string $slug, array $tags = []): void
    {
        self::$catalog->publishPack($payload, $this->userId, [
            'name' => 'Listing ' . $slug,
            'slug' => $slug,
            'tags' => $tags,
            'category' => 'Extensions',
            'visibility' => 'public',
            'version' => '1.0.0',
        ]);
    }

    private function find(string $slug, array $filters = []): ?array
    {
        foreach (self::$catalog->listPublicPacks($filters, 'newest', 1, 50)['packs'] as $pack) {
            if ($pack['slug'] === $slug) {
                return $pack;
            }
        }
        return null;
    }

    public function testAV2AggregateIsListedAsV2WithItsNodeCount(): void
    {
        $slug = 'v2-' . substr($this->userId, 4);
        $this->publish($this->bundledAggregate(), $slug);

        $listed = $this->find($slug);
        $this->assertNotNull($listed, 'a v2 aggregate appears in the ordinary catalog');
        $this->assertSame(2, $listed['formatVersion'], 'the listing declares its lane');
        $this->assertSame(3, $listed['nodeCount'], 'measured in contributed nodes');
        // Forms and apps are a Pack v1 notion — a node-only extension has neither, and the UI
        // filters zero-valued units out rather than rendering "0 forms · 0 apps".
        $this->assertSame(0, $listed['formCount']);
        $this->assertSame(0, $listed['appCount']);
    }

    public function testAV1PackKeepsItsFormatAndCounts(): void
    {
        $slug = 'v1-' . substr($this->userId, 4);
        $this->publish([
            'packMeta' => ['name' => 'Legacy', 'version' => '1.0.0'],
            'forms' => [['id' => 'f1', 'title' => 'One'], ['id' => 'f2', 'title' => 'Two']],
            'apps' => [['id' => 'a1', 'name' => 'App']],
        ], $slug);

        $listed = $this->find($slug);
        $this->assertNotNull($listed);
        $this->assertSame(1, $listed['formatVersion'], 'a v1 pack is unchanged by any of this');
        $this->assertSame(2, $listed['formCount']);
        $this->assertSame(1, $listed['appCount']);
        $this->assertSame(0, $listed['nodeCount']);
    }

    public function testKeywordsAreSearchableNotJustFilterable(): void
    {
        // A keyword nobody can type into the search box is decoration: the user would have to
        // already know the tag exists and then find the chip for it.
        $slug = 'kw-' . substr($this->userId, 4);
        $aggregate = $this->bundledAggregate();
        $this->publish($aggregate, $slug, $aggregate['package']['keywords']);

        foreach (['text-to-speech', 'transcription', 'llm'] as $term) {
            $this->assertNotNull($this->find($slug, ['search' => $term]), "searching '$term' finds it");
        }
        $this->assertNull($this->find($slug, ['search' => 'entirely-unrelated-term']));
    }

    public function testSearchStillMatchesNameAndDescription(): void
    {
        // Widening search to tags must not have replaced what it already matched.
        $slug = 'nm-' . substr($this->userId, 4);
        $this->publish($this->bundledAggregate(), $slug, []);
        $this->assertNotNull($this->find($slug, ['search' => 'Listing ' . $slug]), 'name still matches');
    }

    public function testAMaliciousSearchTermCannotBreakTheQuery(): void
    {
        // The tag arm is a third binding in the same WHERE; the LIKE-escape and quoting rules
        // have to hold for it too.
        $slug = 'esc-' . substr($this->userId, 4);
        $this->publish($this->bundledAggregate(), $slug, ['audio']);

        foreach (["100%", "under_score", "quote'", 'back\\slash', "!bang"] as $hostile) {
            $result = self::$catalog->listPublicPacks(['search' => $hostile], 'newest', 1, 5);
            $this->assertIsArray($result['packs'], "'$hostile' is handled as a literal, not syntax");
        }
    }

    public function testTheBundledAggregateIsWhatTheCatalogStores(): void
    {
        // The stored payload must be the aggregate itself — the install lane re-reads it, and a
        // listing that stored something else would install something else.
        $slug = 'st-' . substr($this->userId, 4);
        $aggregate = $this->bundledAggregate();
        $this->publish($aggregate, $slug);

        $catalogId = self::$pdo->query("SELECT id FROM pack_catalog WHERE slug = " . self::$pdo->quote($slug))->fetchColumn();
        $stored = self::$catalog->getPackVersion((string) $catalogId);
        $this->assertNotNull($stored);
        $payload = is_string($stored['pack_data']) ? json_decode($stored['pack_data'], true) : $stored['pack_data'];
        $this->assertSame(2, $payload['formatVersion']);
        $this->assertSame('com.formlogic.ai-toolkit', $payload['package']['id']);
        $this->assertCount(3, $payload['contributions']['flowNodes']);
    }
}
