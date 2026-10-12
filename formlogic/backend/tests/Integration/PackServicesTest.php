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
 * Pack services (wave 1): a pack app may DECLARE included services; importPack composes
 * them into apps.settings.services (owner-toggleable enable/disable map), exportApp
 * round-trips the declaration with defaultEnabled reflecting the CURRENT enabled state,
 * and validatePack enforces the strict declaration shape. Skipped without a test DB.
 */
class PackServicesTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FormService $forms;
    private static AppService $apps;
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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-packsvc-' . bin2hex(random_bytes(4)));
        self::$forms = new FormService($conn, $sqlite);
        self::$apps = new AppService($conn, self::$forms);
        self::$packs = new PackService($conn, self::$forms, self::$apps, new AppUserService($conn));
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

    /** @param array<string,mixed> $appOverrides */
    private function servicesPack(array $appOverrides = []): array
    {
        return [
            'formatVersion' => 1,
            'packMeta' => ['name' => 'Svc Pack ' . bin2hex(random_bytes(4)), 'version' => '1.0.0'],
            'forms' => [
                ['packFormId' => 'calls', 'title' => 'Calls', 'fields' => [
                    ['id' => 'caller', 'type' => 'short_text', 'label' => 'Caller', 'required' => false],
                ]],
            ],
            'apps' => [array_merge([
                'packAppId' => 'svc-app',
                'name' => 'Svc App',
                'forms' => [['packFormId' => 'calls', 'sortOrder' => 0]],
                'services' => [[
                    'id' => 'companion-relay',
                    'title' => 'Companion app relay',
                    'description' => 'Relay for the Companion app.',
                    'defaultEnabled' => true,
                ]],
            ], $appOverrides)],
        ];
    }

    public function testImportComposesServiceSettingsAndExportRoundTripsCurrentState(): void
    {
        $result = self::$packs->importPack($this->servicesPack(), $this->userId);
        $appId = (string) $result['apps'][0]['id'];
        $app = self::$apps->getApp($appId);
        $this->assertEquals(
            [
                'enabled' => true,
                'title' => 'Companion app relay',
                'description' => 'Relay for the Companion app.',
            ],
            $app['settings']['services']['companion-relay'] ?? null,
            'import composes settings.services from the declaration'
        );

        // Owner disables the service, then exports: the declaration must carry
        // defaultEnabled=false so the export reproduces the app's behavior.
        $settings = $app['settings'];
        $settings['services']['companion-relay']['enabled'] = false;
        self::$apps->updateApp($appId, ['settings' => $settings]);

        $export = self::$packs->exportApp($appId, $this->userId);
        $exportedApp = $export['apps'][0];
        $this->assertEquals([[
            'id' => 'companion-relay',
            'title' => 'Companion app relay',
            'description' => 'Relay for the Companion app.',
            'defaultEnabled' => false,
        ]], $exportedApp['services'], 'export emits the declaration with the CURRENT enabled state');
        // exportApp normalizes settings via jsonObject() (stdClass when empty-ish).
        $this->assertArrayNotHasKey(
            'services',
            (array) ($exportedApp['settings'] ?? []),
            'the raw settings map never rides in the export — import recomposes it'
        );

        // Re-import the export: the service starts disabled.
        $reimport = self::$packs->importPack($export, $this->userId);
        $reApp = self::$apps->getApp((string) $reimport['apps'][0]['id']);
        $this->assertFalse($reApp['settings']['services']['companion-relay']['enabled']);
    }

    public function testImportWithoutDeclarationDropsStraySettingsServices(): void
    {
        $pack = $this->servicesPack(['services' => null]);
        unset($pack['apps'][0]['services']);
        // A stray raw map in the pack's app settings must not survive import — the
        // declaration is the only source (absent = enabled at runtime anyway).
        $pack['apps'][0]['settings'] = ['services' => ['sneaky' => ['enabled' => false]]];
        $result = self::$packs->importPack($pack, $this->userId);
        $app = self::$apps->getApp((string) $result['apps'][0]['id']);
        $this->assertArrayNotHasKey('services', $app['settings']);
    }

    /**
     * Remote monitoring, takeover and the rest of the Aokie Companion consent policy are the
     * installer's to give, through the audited policy endpoint: a pack that ships them in its app
     * settings must not arrive with them granted. The rest of the companion settings stay.
     */
    public function testImportDropsAShippedRemoteConsentPolicy(): void
    {
        $pack = $this->servicesPack();
        $pack['apps'][0]['settings'] = ['aokieCompanion' => [
            'remoteConsent' => ['configured' => true, 'remoteMonitoring' => true, 'remoteTakeover' => true],
            'greeting' => 'kept',
        ]];
        $result = self::$packs->importPack($pack, $this->userId);
        $app = self::$apps->getApp((string) $result['apps'][0]['id']);
        $this->assertArrayNotHasKey('remoteConsent', $app['settings']['aokieCompanion'] ?? []);
        $this->assertSame('kept', $app['settings']['aokieCompanion']['greeting'] ?? null);
    }

    /**
     * A linked_record target in a pack is a '@pack:' reference to one of its own forms. Any other
     * value is an id from the author's account (or anything at all): it is mapped when it names a
     * form of the pack, and otherwise dropped, so an import never points at a form outside it.
     */
    public function testImportMapsOrDropsARawLinkedRecordTarget(): void
    {
        $pack = $this->servicesPack();
        $pack['forms'][] = ['packFormId' => 'notes', 'title' => 'Notes', 'fields' => [
            ['id' => 'to_calls', 'type' => 'linked_record', 'label' => 'Call', 'properties' => ['targetFormId' => 'calls']],
            ['id' => 'elsewhere', 'type' => 'linked_record', 'label' => 'Elsewhere', 'properties' => ['targetFormId' => 'a-form-of-another-account']],
            ['id' => 'packed', 'type' => 'linked_record', 'label' => 'Packed', 'properties' => ['targetFormId' => '@pack:calls']],
        ]];
        $result = self::$packs->importPack($pack, $this->userId);
        $ids = array_column($result['forms'], 'id', 'title');
        $fields = array_column(self::$forms->getForm($ids['Notes'])['fields'], null, 'id');
        $this->assertSame($ids['Calls'], $fields['to_calls']['properties']['targetFormId'] ?? null, 'a pack form named without @pack: is mapped');
        $this->assertArrayNotHasKey('targetFormId', $fields['elsewhere']['properties'] ?? [], 'an id outside the pack is dropped');
        $this->assertSame($ids['Calls'], $fields['packed']['properties']['targetFormId'] ?? null);
    }

    public function testFeaturesIsTheV2NameAndImportsIdentically(): void
    {
        // PKG-102 (ADR-010): `features` is the v2 name for the same declarations; runtime
        // storage stays settings.services, so behavior is identical either way.
        $pack = $this->servicesPack();
        $pack['apps'][0]['features'] = $pack['apps'][0]['services'];
        unset($pack['apps'][0]['services']);

        $result = self::$packs->importPack($pack, $this->userId);
        $app = self::$apps->getApp((string) $result['apps'][0]['id']);
        $this->assertEquals(
            ['enabled' => true, 'title' => 'Companion app relay', 'description' => 'Relay for the Companion app.'],
            $app['settings']['services']['companion-relay'] ?? null,
            'a features declaration composes the same settings.services map'
        );

        // The capability review surfaces them from either key.
        $caps = \FormLogic\Helpers\PackCapabilities::describe($pack);
        $this->assertSame('companion-relay', $caps['services'][0]['id'] ?? null);

        // Malformed `features` validate exactly like malformed `services`.
        $bad = $this->servicesPack();
        $bad['apps'][0]['features'] = ['not-a-list' => ['id' => 'x']];
        unset($bad['apps'][0]['services']);
        try {
            self::$packs->importPack($bad, $this->userId);
            $this->fail('a non-list features declaration must refuse');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('features must be a list', $e->getMessage());
        }
    }

    public function testDeclaringBothFeaturesAndServicesIsRefused(): void
    {
        $pack = $this->servicesPack();
        $pack['apps'][0]['features'] = $pack['apps'][0]['services'];
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage("declares both 'features' and its v1 alias 'services'");
        self::$packs->importPack($pack, $this->userId);
    }

    public function testValidateRejectsMalformedServiceDeclarations(): void
    {
        $cases = [
            'non-list services' => ['services' => ['companion-relay' => ['id' => 'companion-relay']]],
            'bad id shape' => ['services' => [['id' => 'Bad_Id!', 'title' => 'T', 'description' => 'D']]],
            'unknown key' => ['services' => [[
                'id' => 'companion-relay', 'title' => 'T', 'description' => 'D', 'grants' => ['x'],
            ]]],
            'missing title' => ['services' => [['id' => 'companion-relay', 'description' => 'D']]],
            'non-bool defaultEnabled' => ['services' => [[
                'id' => 'companion-relay', 'title' => 'T', 'description' => 'D', 'defaultEnabled' => 'yes',
            ]]],
            'duplicate ids' => ['services' => [
                ['id' => 'companion-relay', 'title' => 'T', 'description' => 'D'],
                ['id' => 'companion-relay', 'title' => 'T2', 'description' => 'D2'],
            ]],
            'over the 8-entry cap' => ['services' => array_map(
                static fn (int $i): array => ['id' => 'svc-' . $i, 'title' => 'T', 'description' => 'D'],
                range(1, 9),
            )],
        ];
        foreach ($cases as $label => $overrides) {
            try {
                self::$packs->importPack($this->servicesPack($overrides), $this->userId);
                $this->fail("validatePack accepted: {$label}");
            } catch (\RuntimeException $e) {
                $this->assertStringContainsString('service', strtolower($e->getMessage()), $label);
            }
        }
    }

    public function testAokieFixtureDeclaresCompanionRelayAndImportsEnabled(): void
    {
        $file = dirname(__DIR__, 2) . '/resources/marketplace-packs/aokie-receptionist.json';
        $this->assertFileExists($file);
        $record = json_decode((string) file_get_contents($file), true);
        $pack = $record['pack'] ?? null;
        $this->assertIsArray($pack);
        $declared = $pack['apps'][0]['services'] ?? null;
        $this->assertIsArray($declared, 'the aokie pack must declare its included services');
        $this->assertSame('companion-relay', $declared[0]['id']);

        $result = self::$packs->importPack($pack, $this->userId);
        $app = self::$apps->getApp((string) $result['apps'][0]['id']);
        $relay = $app['settings']['services']['companion-relay'] ?? null;
        $this->assertIsArray($relay);
        $this->assertTrue($relay['enabled'], 'companion-relay installs enabled');
        $this->assertSame('Companion app relay', $relay['title']);
    }
}
