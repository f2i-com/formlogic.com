<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\MarketplaceSandboxService;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\NativeTableFormBridge;
use FormLogic\Services\PackService;
use FormLogic\Services\SoftnPackCatalog;
use PDO;
use PHPUnit\Framework\TestCase;

final class FormSqliteAndSoftnPacksTest extends TestCase
{
    private string $tmpRoot;
    private NativeAppService $native;
    private MarketplaceSandboxService $sandbox;

    protected function setUp(): void
    {
        $this->tmpRoot = sys_get_temp_dir() . '/fl-sbp-test-' . bin2hex(random_bytes(8));
        mkdir($this->tmpRoot . '/native', 0700, true);
        mkdir($this->tmpRoot . '/sandboxes', 0700, true);
        $this->native = new NativeAppService($this->tmpRoot . '/native');
        $this->sandbox = new MarketplaceSandboxService($this->native, $this->tmpRoot . '/sandboxes', 'test-secret-key-softn-packs');
    }

    protected function tearDown(): void
    {
        if (is_dir($this->tmpRoot)) {
            $it = new \RecursiveIteratorIterator(
                new \RecursiveDirectoryIterator($this->tmpRoot, \FilesystemIterator::SKIP_DOTS),
                \RecursiveIteratorIterator::CHILD_FIRST
            );
            foreach ($it as $entry) {
                if ($entry->isLink() || !$entry->isDir()) {
                    @unlink($entry->getPathname());
                } else {
                    @rmdir($entry->getPathname());
                }
            }
            @rmdir($this->tmpRoot);
        }
    }

    public function testAll29FreeSoftnBusinessPacksLoadAndValidateWithSchemaMatchedForms(): void
    {
        $catalog = new SoftnPackCatalog();
        $metaAll = $catalog->loadMeta();
        self::assertCount(29, $metaAll, 'Expected all 29 SoftN business packs under resources/softn-packs');

        foreach ($metaAll as $slug => $meta) {
            $summary = SoftnPackCatalog::summary($meta, false);
            self::assertSame('softn_app', $summary['itemType'], $slug);
            self::assertSame(0, $summary['priceCents'], $slug);
            self::assertSame('free', $summary['billingModel'], $slug);
            self::assertTrue($summary['demoEnabled'], $slug);
            self::assertTrue($summary['bundledSoftnPack'], $slug);
            self::assertNotEmpty($summary['tables'], $slug);
            self::assertGreaterThan(0, $summary['formCount'], $slug);

            // Validate full installable definition (SoftN App + Matched Forms + Management App)
            $install = json_decode((string) file_get_contents((string) $meta['_installPath']), true, 128, JSON_THROW_ON_ERROR);
            PackService::validateDefinition($install);
            self::assertCount(2, $install['apps'], $slug . ' should include SoftN app + Forms & Charts app');
            self::assertCount(count($summary['tables']), $install['forms'], $slug . ' should have 1 schema-matched form per domain SQLite table');

            $softnAppId = $install['apps'][0]['packAppId'];
            foreach ($install['forms'] as $form) {
                $ntb = $form['settings']['nativeTableBinding'] ?? null;
                self::assertIsArray($ntb, "{$slug}: form {$form['packFormId']} missing nativeTableBinding");
                self::assertSame('@packApp:' . $softnAppId, $ntb['appId'], "{$slug}: binding must reference @packApp:{$softnAppId}");
                self::assertContains($ntb['table'], $summary['tables'], "{$slug}: bound table must exist in schema");
                self::assertNotEmpty($ntb['columns'], "{$slug}: bound table {$ntb['table']} must map columns");
            }

            // Validate link_forms mode rewrites bindings to an existing owned SoftN app
            $linkedPack = $catalog->buildInstallablePack($slug, 'link_forms', 'existing-softn-123');
            self::assertNotNull($linkedPack);
            self::assertCount(1, $linkedPack['apps']);
            self::assertSame('existing-softn-123', $linkedPack['apps'][0]['settings']['sharedDatabaseAppId']);
            self::assertSame('existing-softn-123', $linkedPack['forms'][0]['settings']['nativeTableBinding']['appId']);
        }
    }

    public function testBundledPropertyMaintenanceLiveSandboxSeedsSampleDataAndIsolatesVisitors(): void
    {
        if (!$this->native->available()) {
            self::markTestSkipped('Native SoftN runtime not prepared in this environment.');
        }

        $catalog = new SoftnPackCatalog();
        $rec = $catalog->asDemoCatalogRecord('property-maintenance-softn');
        self::assertNotNull($rec);

        $demoAppId = $this->sandbox->ensureBundledDemoInstalled(
            'property-maintenance-softn',
            (string) $rec['_archivePath'],
            'Property Maintenance'
        );
        $rec['demo_app_id'] = $demoAppId;

        $sessA = $this->sandbox->createSession($rec);
        $sessB = $this->sandbox->createSession($rec);
        self::assertSame('sandbox_web', $sessA['renderMode']);

        // Auto-seeded turnkey workspace grants owner demo access immediately with sample data!
        $sessionResp = $this->sandbox->handleBackendRequest($rec, $sessA['token'], [
            'method' => 'GET',
            'path' => '/api/session',
        ]);
        self::assertSame(200, $sessionResp['status']);
        self::assertTrue($sessionResp['body']['setupDone']);
        self::assertSame('granted', $sessionResp['body']['access']);

        $propsA = $this->sandbox->handleBackendRequest($rec, $sessA['token'], [
            'method' => 'GET',
            'path' => '/api/properties',
        ]);
        self::assertSame(200, $propsA['status']);
        self::assertGreaterThanOrEqual(4, count($propsA['body']['properties']));
        $initialCount = count($propsA['body']['properties']);

        // Visitor A adds a property; Visitor B's isolated ephemeral SQLite DB is unaffected!
        $addA = $this->sandbox->handleBackendRequest($rec, $sessA['token'], [
            'method' => 'POST',
            'path' => '/api/properties',
            'body' => [
                'address' => '99 Sandbox Lane, Sydney NSW 2000',
                'property_type' => 'House',
                'owner_manager' => 'Alex Tester',
                'manager_phone' => '0400 123 456',
                'access_notes' => 'Side gate unlocked',
            ],
        ]);
        self::assertSame(201, $addA['status']);

        $propsAAfter = $this->sandbox->handleBackendRequest($rec, $sessA['token'], ['method' => 'GET', 'path' => '/api/properties']);
        $propsB = $this->sandbox->handleBackendRequest($rec, $sessB['token'], ['method' => 'GET', 'path' => '/api/properties']);
        self::assertCount($initialCount + 1, $propsAAfter['body']['properties']);
        self::assertCount($initialCount, $propsB['body']['properties']);

        // Also test NativeTableFormBridge inserting directly into the SoftN app's properties & tenants tables
        // (verifying unix created_at auto-fill, integer FK unwrapping, and ISO date formatting!)
        $mysqlMock = new PDO('sqlite::memory:');
        $bridge = new NativeTableFormBridge($mysqlMock, $this->native);
        $propBinding = [
            'formId' => 'form-props',
            'ownerId' => 'owner-1',
            'appId' => $demoAppId,
            'databaseAppId' => $demoAppId,
            'table' => 'properties',
            'primaryKey' => ['id'],
            'columns' => [
                'address' => 'address',
                'property_type' => 'property_type',
                'owner_manager' => 'owner_manager',
                'manager_phone' => 'manager_phone',
                'access_notes' => 'access_notes',
            ],
            'createdAtColumn' => 'created_at',
            'statusColumn' => null,
        ];
        $createdProp = $bridge->createResponse($propBinding, [
            'answers' => [
                'address' => '12 Bridge St, Melbourne VIC',
                'property_type' => 'Apartment',
                'owner_manager' => 'Form Submitter',
                'manager_phone' => '0411 222 333',
                'access_notes' => 'Concierge desk',
            ],
        ]);
        self::assertSame('12 Bridge St, Melbourne VIC', $createdProp['answers']['address']);
        self::assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/', $createdProp['submittedAt']);

        $tenantBinding = [
            'formId' => 'form-tenants',
            'ownerId' => 'owner-1',
            'appId' => $demoAppId,
            'databaseAppId' => $demoAppId,
            'table' => 'tenants',
            'primaryKey' => ['id'],
            'columns' => [
                'property_id' => 'property_id',
                'name' => 'name',
                'phone' => 'phone',
                'email' => 'email',
            ],
            'createdAtColumn' => 'created_at',
            'statusColumn' => null,
        ];
        // Linked record answer shape `{ id: "<propId>" }` cleanly unwraps & casts to INTEGER property_id!
        $createdTenant = $bridge->createResponse($tenantBinding, [
            'answers' => [
                'property_id' => ['id' => $createdProp['id']],
                'name' => 'Sam Linked',
                'phone' => '0499 888 777',
                'email' => 'sam@example.test',
            ],
        ]);
        self::assertSame((int) $createdProp['id'], (int) $createdTenant['answers']['property_id']);
    }

    public function testFormAppManagedSqliteDatabaseCanBeSharedBySoftnApps(): void
    {
        if (!$this->native->available()) {
            self::markTestSkipped('Native SoftN runtime not prepared in this environment.');
        }

        // 1. Initialize a Form App's Unified SQLite database and create a form-backed table
        $formAppId = 'form-app-crm-1';
        $this->native->initFormAppDatabase($formAppId);
        self::assertTrue($this->native->hasManagedDatabase($formAppId));
        self::assertTrue($this->native->isFormAppDatabase($formAppId));

        $this->native->withDatabase($formAppId, static function (PDO $db): void {
            $db->exec('CREATE TABLE IF NOT EXISTS "leads" ("id" TEXT PRIMARY KEY, "company" TEXT, "deal_value" REAL, "status" TEXT NOT NULL DEFAULT \'submitted\', "created_at" TEXT NOT NULL, "updated_at" TEXT NOT NULL)');
            $db->exec("INSERT INTO \"leads\" (\"id\", \"company\", \"deal_value\", \"status\", \"created_at\", \"updated_at\") VALUES ('lead-1', 'Acme Pty Ltd', 12500, 'qualified', '2026-11-21 10:00:00', '2026-11-21 10:00:00')");
        });

        $glance = $this->native->databaseGlance($formAppId);
        self::assertNotNull($glance);
        self::assertTrue($glance['formDatabase']);
        self::assertSame(1, $glance['tables']);

        // 2. Create a SoftN App linked directly to the Form App's SQLite database!
        $softnAppId = 'softn-frontend-1';
        $this->native->setSharedDatabaseLink($softnAppId, $formAppId);
        $starter = NativeAppService::formDatabaseSoftnStarter('CRM SoftN App', $softnAppId, [
            'leads' => ['id', 'company', 'deal_value', 'status', 'created_at', 'updated_at'],
        ]);
        $this->native->install($softnAppId, $starter, 0);

        // 3. The SoftN App's backend reads the Form App's SQLite row AND inserts a new row visible to the Form App!
        $listRes = $this->native->request($softnAppId, [
            'method' => 'GET',
            'path' => '/api/records',
            'query' => ['table' => 'leads'],
            'body' => (object) [],
            'headers' => (object) [],
            'client_ip' => '127.0.0.1',
        ]);
        self::assertSame(200, $listRes['status']);
        self::assertCount(1, $listRes['body']['records']);
        self::assertSame('Acme Pty Ltd', $listRes['body']['records'][0]['company']);

        $createRes = $this->native->request($softnAppId, [
            'method' => 'POST',
            'path' => '/api/records',
            'query' => (object) [],
            'body' => [
                'table' => 'leads',
                'values' => ['company' => 'Beta Holdings', 'deal_value' => 8400],
            ],
            'headers' => (object) [],
            'client_ip' => '127.0.0.1',
        ]);
        self::assertSame(201, $createRes['status']);

        // Form App immediately sees both rows in its SQLite database!
        $formAppRecords = $this->native->records($formAppId, 'leads');
        self::assertCount(2, $formAppRecords['rows']);
    }
}
