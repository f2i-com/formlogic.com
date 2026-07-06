<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FormService;
use FormLogic\Services\PackCatalogService;
use FormLogic\Services\PackFileService;
use FormLogic\Services\PackService;
use FormLogic\Services\SigningService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * ApplicationPackage (.formlogic ARCHIVE) export → import round-trip against a real DB (#19/#20):
 * a signed ZIP re-imports as a fresh owner-scoped app; a tampered signature is rejected; a zip carrying a
 * path-traversal entry is rejected by the shared PackFileService zip-slip guard. Skipped without a test DB.
 */
class ApplicationPackageTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FormService $forms;
    private static AppService $apps;
    private static AppUserService $appUsers;
    private static PackService $packs;
    private static SigningService $signing;
    private static PackCatalogService $catalog;

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-apppkg-' . bin2hex(random_bytes(4)));
        self::$forms = new FormService($conn, $sqlite);
        self::$apps = new AppService($conn, self::$forms);
        self::$appUsers = new AppUserService($conn);
        self::$packs = new PackService($conn, self::$forms, self::$apps, self::$appUsers);
        self::$signing = new SigningService($conn);
        self::$catalog = new PackCatalogService($conn);
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
        if (self::$pdo === null || $this->userId === '') {
            return;
        }
        $appIds = self::$pdo->prepare('SELECT id FROM apps WHERE owner_id = ?');
        $appIds->execute([$this->userId]);
        foreach ($appIds->fetchAll(PDO::FETCH_COLUMN) as $aid) {
            self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$aid]);
        }
        self::$pdo->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM pack_installations WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM pack_catalog WHERE publisher_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    private function uuid(): string
    {
        return 'x-' . bin2hex(random_bytes(12));
    }

    /** Build a minimal app with two linked forms; return the appId. */
    private function buildApp(): string
    {
        $formBId = $this->uuid();
        self::$forms->createForm([
            'id' => $formBId, 'userId' => $this->userId, 'title' => 'Customers', 'status' => 'published',
            'fields' => [['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => true]],
        ]);
        $formAId = $this->uuid();
        self::$forms->createForm([
            'id' => $formAId, 'userId' => $this->userId, 'title' => 'Orders', 'status' => 'published',
            'fields' => [
                ['id' => 'item', 'type' => 'short_text', 'label' => 'Item', 'required' => true],
                ['id' => 'customer', 'type' => 'linked_record', 'label' => 'Customer', 'required' => false, 'properties' => ['targetFormId' => $formBId]],
            ],
        ]);
        $app = self::$apps->createApp([
            'name' => 'Pkg Shop',
            'description' => 'Round-trip shop',
            'customScreen' => ['enabled' => true, 'html' => '<h1>Home</h1>', 'css' => '', 'js' => ''],
            'settings' => ['hideNav' => true],
        ], $this->userId);
        self::$apps->addFormToApp($app['id'], $formAId, 'Orders');
        self::$apps->addFormToApp($app['id'], $formBId, 'Customers');
        return $app['id'];
    }

    public function testExportProducesSignedArchive(): void
    {
        $appId = $this->buildApp();
        $zipPath = self::$packs->exportApplicationPackage($appId, $this->userId, self::$signing);
        $this->assertFileExists($zipPath);

        $zip = new \ZipArchive();
        $this->assertTrue($zip->open($zipPath) === true);
        $names = [];
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $names[] = $zip->getNameIndex($i);
        }
        $this->assertContains('manifest.json', $names);
        $this->assertContains('pack.json', $names);
        $this->assertContains('signature.json', $names, 'a signature is written when a signer is supplied');

        $manifest = json_decode((string) $zip->getFromName('manifest.json'), true);
        $this->assertSame('formlogic.applicationPackage', $manifest['kind']);
        $this->assertStringStartsWith('sha256:', $manifest['contentHash']);
        $this->assertSame('pkg-shop', $manifest['id']);
        $zip->close();
        @unlink($zipPath);
    }

    public function testSignedRoundTripImportRecreatesApp(): void
    {
        $appId = $this->buildApp();
        $zipPath = self::$packs->exportApplicationPackage($appId, $this->userId, self::$signing);

        // Import into a SECOND account (a genuine cross-account install).
        $importer = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$importer, $importer . '@test.local']);
        try {
            $result = self::$packs->importApplicationPackage($zipPath, $importer, self::$signing);
            $this->assertContains($result['trust'], ['official', 'local-only'], 'a verified signature yields a trusted import');
            $this->assertCount(2, $result['forms']);
            $this->assertCount(1, $result['apps']);

            $newApp = self::$apps->getApp($result['apps'][0]['id']);
            $this->assertSame('Pkg Shop', $newApp['name']);
            $this->assertNotEmpty($newApp['customScreen']['html'] ?? '');

            // linked_record remapped to the imported Customers form.
            $newOrders = null; $newCustomers = null;
            foreach ($result['forms'] as $f) {
                if ($f['title'] === 'Orders') { $newOrders = $f['id']; }
                if ($f['title'] === 'Customers') { $newCustomers = $f['id']; }
            }
            $orders = self::$forms->getForm($newOrders);
            $link = null;
            foreach ($orders['fields'] as $fld) {
                if (($fld['type'] ?? '') === 'linked_record') { $link = $fld; }
            }
            $this->assertNotNull($link);
            $this->assertSame($newCustomers, $link['properties']['targetFormId']);
        } finally {
            @unlink($zipPath);
            $this->cleanupUser($importer);
        }
    }

    public function testTamperedSignatureIsRejected(): void
    {
        $appId = $this->buildApp();
        $zipPath = self::$packs->exportApplicationPackage($appId, $this->userId, self::$signing);

        // Tamper: rewrite pack.json inside the archive so it no longer matches the signature.
        $zip = new \ZipArchive();
        $this->assertTrue($zip->open($zipPath) === true);
        $pack = json_decode((string) $zip->getFromName('pack.json'), true);
        $pack['packMeta']['name'] = 'Hijacked';
        $zip->deleteName('pack.json');
        $zip->addFromString('pack.json', (string) json_encode($pack));
        $zip->close();

        try {
            $this->expectException(\RuntimeException::class);
            $this->expectExceptionMessage('signature verification failed');
            self::$packs->importApplicationPackage($zipPath, $this->userId, self::$signing);
        } finally {
            @unlink($zipPath);
        }
    }

    public function testPathTraversalEntryIsRejected(): void
    {
        // The shared guard rejects a "../" traversal name outright.
        $this->assertFalse(PackFileService::isSafeZipEntryName('../evil.txt'));
        $this->assertFalse(PackFileService::isSafeZipEntryName('/etc/passwd'));
        $this->assertFalse(PackFileService::isSafeZipEntryName('a/../../b'));
        $this->assertTrue(PackFileService::isSafeZipEntryName('assets/logo.png'));

        // And an actual archive carrying a traversal entry is refused by the importer.
        $zipPath = (string) tempnam(sys_get_temp_dir(), 'flevil_');
        $zip = new \ZipArchive();
        $this->assertTrue($zip->open($zipPath, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) === true);
        $zip->addFromString('pack.json', (string) json_encode(['formatVersion' => 1, 'packMeta' => ['name' => 'x'], 'forms' => []]));
        $zip->addFromString('../evil.txt', 'pwned');
        $zip->close();

        try {
            $this->expectException(\RuntimeException::class);
            $this->expectExceptionMessage('Unsafe path in archive');
            self::$packs->importApplicationPackage($zipPath, $this->userId, self::$signing);
        } finally {
            @unlink($zipPath);
        }
    }

    public function testCatalogThreadsItemTypeAndDerivesTrustLevel(): void
    {
        $pack = ['formatVersion' => 1, 'packMeta' => ['name' => 'Trust Pack', 'version' => '1.0.0'], 'forms' => [['packFormId' => 'f', 'title' => 'F', 'fields' => []]]];

        // A non-official publisher → community trust; item_type honoured from the (validated) metadata.
        $res = self::$catalog->publishPack($pack, $this->userId, ['name' => 'Trust Pack', 'itemType' => 'connector']);
        $detail = self::$catalog->getPackDetail($res['slug'], $this->userId);
        $this->assertSame('connector', $detail['itemType']);
        $this->assertSame('community', $detail['trustLevel'], 'trust is server-derived, not client-supplied');

        // An unknown item_type falls back to the default; trust is never taken from client input.
        $res2 = self::$catalog->publishPack($pack, $this->userId, ['name' => 'Default Pack', 'itemType' => 'not-a-type', 'trustLevel' => 'official']);
        $detail2 = self::$catalog->getPackDetail($res2['slug'], $this->userId);
        $this->assertSame('application_package', $detail2['itemType']);
        $this->assertSame('community', $detail2['trustLevel'], 'a client-supplied trust_level must be ignored');

        // Filtering by trust level excludes community listings.
        $officialOnly = self::$catalog->listPublicPacks(['trustLevel' => 'official'], 'newest', 1, 50);
        $slugs = array_column($officialOnly['packs'], 'slug');
        $this->assertNotContains($res['slug'], $slugs);
        // Filtering by item_type surfaces the connector listing.
        $connectors = self::$catalog->listPublicPacks(['itemType' => 'connector'], 'newest', 1, 50);
        $this->assertContains($res['slug'], array_column($connectors['packs'], 'slug'));
    }

    private function cleanupUser(string $uid): void
    {
        $appIds = self::$pdo->prepare('SELECT id FROM apps WHERE owner_id = ?');
        $appIds->execute([$uid]);
        foreach ($appIds->fetchAll(PDO::FETCH_COLUMN) as $aid) {
            self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$aid]);
        }
        self::$pdo->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$uid]);
        self::$pdo->prepare('DELETE FROM pack_installations WHERE user_id = ?')->execute([$uid]);
        self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$uid]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
    }
}
