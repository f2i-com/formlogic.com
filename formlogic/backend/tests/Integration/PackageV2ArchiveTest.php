<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\PackageInstallPlanController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FormService;
use FormLogic\Services\Packages\InstallPlanService;
use FormLogic\Services\Packages\PackageV2InstallService;
use FormLogic\Services\PackService;
use FormLogic\Services\SigningService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Message\UploadedFileInterface;
use Slim\Psr7\Response as SlimResponse;

/**
 * ADR-010 archive lane: an Application Package v2 aggregate delivered as a .formlogic archive
 * may reference its flow-node definitions as ENTRY PATHS instead of inlining them.
 *
 * The property that matters is that resolution happens ONCE, at parse, so review and install
 * see the identical inlined aggregate — and that a SIGNED package cannot be extended after
 * signing: a referenced entry the signature does not cover is a tamper, not a contribution.
 */
class PackageV2ArchiveTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static PackService $packs;
    private static PackageV2InstallService $pkgV2;
    private static SigningService $signing;

    private string $userId = '';
    /** @var list<string> */
    private array $tempFiles = [];

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-pkgv2arc-' . bin2hex(random_bytes(4)));
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
        foreach ($this->tempFiles as $path) {
            if (is_file($path)) {
                @unlink($path);
            }
        }
        $this->tempFiles = [];
        if (self::$pdo !== null && $this->userId !== '') {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
        }
    }

    /** The definition an archive delivers as a file. */
    private function definition(): array
    {
        return [
            'schemaVersion' => 1,
            'type' => 'com.acme.archived.greet',
            'version' => '1.0.0',
            'display' => ['label' => 'Greet'],
            'handler' => ['kind' => 'core-preset', 'coreType' => 'template', 'defaults' => ['template' => 'hi']],
            'sideEffects' => 'none',
        ];
    }

    /** A v2 aggregate whose single contribution is an ENTRY PATH, not an inline object. */
    private function aggregate(): array
    {
        return [
            'formatVersion' => 2,
            'package' => ['id' => 'com.acme.archived', 'kind' => 'extension', 'version' => '1.0.0', 'publisherId' => 'com.acme', 'displayName' => 'Archived Tools'],
            'contributions' => ['flowNodes' => ['flow-nodes/greet.json']],
        ];
    }

    /**
     * Build a .formlogic archive. When $sign is true the manifest covers exactly $covered
     * (defaulting to every written entry) and carries a real detached signature.
     *
     * @param array<string,string> $entries entry name => raw bytes
     * @param list<string>|null $covered
     */
    private function archive(array $entries, bool $sign = false, ?array $covered = null): string
    {
        $path = (string) tempnam(sys_get_temp_dir(), 'flarc_') . '.zip';
        $this->tempFiles[] = $path;
        $zip = new \ZipArchive();
        $zip->open($path, \ZipArchive::CREATE | \ZipArchive::OVERWRITE);
        foreach ($entries as $name => $bytes) {
            $zip->addFromString($name, $bytes);
        }
        if ($sign) {
            $hashes = [];
            foreach ($covered ?? array_keys($entries) as $name) {
                $hashes[$name] = hash('sha256', $entries[$name]);
            }
            $manifest = ['entries' => $hashes];
            $signed = self::$signing->sign($manifest);
            $zip->addFromString('manifest.json', (string) json_encode($manifest));
            $zip->addFromString('signature.json', (string) json_encode(['signature' => $signed['signature'], 'alg' => $signed['alg']]));
        }
        $zip->close();
        return $path;
    }

    // ── Parsing ─────────────────────────────────────────────────────────────────────────────

    public function testEntryPathContributionsAreInlinedAtParse(): void
    {
        $path = $this->archive([
            'pack.json' => (string) json_encode($this->aggregate()),
            'flow-nodes/greet.json' => (string) json_encode($this->definition()),
        ]);
        $parsed = self::$packs->parseApplicationPackageArchive($path, self::$signing);

        $nodes = $parsed['pack']['contributions']['flowNodes'];
        $this->assertIsArray($nodes[0], 'the entry path was replaced by the definition itself');
        $this->assertSame('com.acme.archived.greet', $nodes[0]['type']);
        $this->assertSame('community', $parsed['trust']);

        // And the inlined aggregate installs through the ordinary v2 path — the installer never
        // learns the package arrived as an archive.
        $result = self::$pkgV2->install($parsed['pack'], $this->userId, []);
        $this->assertSame(['com.acme.archived.greet'], $result['nodeTypes']);
    }

    public function testASignedPackageCannotBeExtendedWithAnUncoveredDefinition(): void
    {
        $entries = [
            'pack.json' => (string) json_encode($this->aggregate()),
            'flow-nodes/greet.json' => (string) json_encode($this->definition()),
        ];
        // The signature covers pack.json ONLY: the definition file was added after signing.
        $path = $this->archive($entries, true, ['pack.json']);

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('not covered by the package signature');
        self::$packs->parseApplicationPackageArchive($path, self::$signing);
    }

    public function testASignedPackageResolvesCoveredDefinitions(): void
    {
        $entries = [
            'pack.json' => (string) json_encode($this->aggregate()),
            'flow-nodes/greet.json' => (string) json_encode($this->definition()),
        ];
        $path = $this->archive($entries, true); // covers both
        $parsed = self::$packs->parseApplicationPackageArchive($path, self::$signing);

        $this->assertContains($parsed['trust'], ['official', 'local-only']);
        $this->assertSame('com.acme.archived.greet', $parsed['pack']['contributions']['flowNodes'][0]['type']);
    }

    public function testUnsafeOrMissingEntryReferencesRefuse(): void
    {
        foreach ([
            '../outside.json' => "package-relative",
            'flow-nodes/absent.json' => 'not in the package',
        ] as $reference => $needle) {
            $aggregate = $this->aggregate();
            $aggregate['contributions']['flowNodes'] = [$reference];
            $path = $this->archive([
                'pack.json' => (string) json_encode($aggregate),
                'flow-nodes/greet.json' => (string) json_encode($this->definition()),
            ]);
            try {
                self::$packs->parseApplicationPackageArchive($path, self::$signing);
                $this->fail("reference {$reference} must refuse");
            } catch (\RuntimeException $e) {
                $this->assertStringContainsString($needle, $e->getMessage());
            }
        }

        // A referenced entry that is not JSON is refused rather than silently skipped.
        $path = $this->archive([
            'pack.json' => (string) json_encode($this->aggregate()),
            'flow-nodes/greet.json' => 'not json at all',
        ]);
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('is not valid JSON');
        self::$packs->parseApplicationPackageArchive($path, self::$signing);
    }

    public function testAPackV1ArchiveIsUntouched(): void
    {
        // The resolver must be a no-op for everything that is not a v2 aggregate.
        $pack = ['name' => 'Legacy', 'version' => '1.0.0', 'forms' => [['title' => 'F', 'fields' => []]]];
        $path = $this->archive(['pack.json' => (string) json_encode($pack)]);
        $parsed = self::$packs->parseApplicationPackageArchive($path, self::$signing);
        $this->assertSame($pack, $parsed['pack']);
    }

    // ── HTTP: the install-plan archive lane ─────────────────────────────────────────────────

    private function uploadOf(string $path): UploadedFileInterface
    {
        // moveTo() consumes the file, so hand the controller a copy.
        $copy = (string) tempnam(sys_get_temp_dir(), 'flarcup_');
        $this->tempFiles[] = $copy;
        copy($path, $copy);

        $file = $this->createMock(UploadedFileInterface::class);
        $file->method('getError')->willReturn(UPLOAD_ERR_OK);
        $file->method('moveTo')->willReturnCallback(function (string $target) use ($copy): void {
            copy($copy, $target);
        });
        return $file;
    }

    public function testProposeAcceptsAnArchiveAndConfirmInstallsWhatWasReviewed(): void
    {
        $path = $this->archive([
            'pack.json' => (string) json_encode($this->aggregate()),
            'flow-nodes/greet.json' => (string) json_encode($this->definition()),
        ]);
        $plans = new InstallPlanService(self::$mysql, self::$pkgV2);
        $controller = new PackageInstallPlanController($plans, self::$signing, self::$packs);

        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $this->userId : null);
        $req->method('getUploadedFiles')->willReturn(['file' => $this->uploadOf($path)]);
        $req->method('getParsedBody')->willReturn([]);
        $out = $controller->propose($req, new SlimResponse());
        $body = json_decode((string) $out->getBody(), true);

        $this->assertSame(201, $out->getStatusCode(), json_encode($body));
        $this->assertSame(2, $body['formatVersion']);
        // The REVIEW shows the resolved contribution — an unresolved entry path would have
        // reviewed as a package that contributes nothing.
        $this->assertSame('Greet', $body['capabilities']['packageV2']['nodes'][0]['label']);

        // Confirming installs the stored (already inlined) bytes.
        $req2 = $this->createMock(ServerRequestInterface::class);
        $req2->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $this->userId : null);
        $req2->method('getParsedBody')->willReturn(['planDigest' => $body['planDigest'], 'approvedConnectorGrants' => []]);
        $out2 = $controller->confirm($req2, new SlimResponse(), ['id' => $body['planId']]);
        $confirmed = json_decode((string) $out2->getBody(), true);
        $this->assertSame(201, $out2->getStatusCode(), json_encode($confirmed));
        $this->assertSame(['com.acme.archived.greet'], $confirmed['nodeTypes']);
    }

    public function testProposeRefusesAPackV1Archive(): void
    {
        $path = $this->archive([
            'pack.json' => (string) json_encode(['name' => 'Legacy', 'version' => '1.0.0', 'forms' => [['title' => 'F', 'fields' => []]]]),
        ]);
        $controller = new PackageInstallPlanController(new InstallPlanService(self::$mysql, self::$pkgV2), self::$signing, self::$packs);

        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $this->userId : null);
        $req->method('getUploadedFiles')->willReturn(['file' => $this->uploadOf($path)]);
        $req->method('getParsedBody')->willReturn([]);
        $out = $controller->propose($req, new SlimResponse());
        $body = json_decode((string) $out->getBody(), true);

        $this->assertSame(400, $out->getStatusCode());
        $this->assertSame('unsupported_source', $body['code']);
    }
}
