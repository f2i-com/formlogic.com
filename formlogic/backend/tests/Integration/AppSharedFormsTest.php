<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Multi-app-over-shared-forms semantics: app_forms is many-to-many, responses live in
 * per-form SQLite, so two apps referencing the same form_id share its data (a client
 * app + an admin app over the same stored records). Exercised against a real DB:
 *
 *  - one form attached to two apps → both apps list it, same form_id backing (shared responses)
 *  - duplicate attach to the SAME app rejected with a friendly error
 *  - unique_app_form migration dedupes pre-existing duplicates (keeps lowest sort_order)
 *  - removing a form from app A keeps it (and its responses/links) in app B
 *  - deleting app A keeps the shared form, its responses, its response_links, and app B
 *  - getAppsForForms is owner-scoped
 *
 * Skipped unless a test database is reachable (same setup as AppRbacTest:
 * DB_TEST_DATABASE / DB_HOST / DB_USERNAME / DB_PASSWORD; CI provides MySQL).
 */
class AppSharedFormsTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static AppService $apps;
    private static ResponseService $responses;

    /** @var string[] */
    private array $userIds = [];
    /** @var string[] */
    private array $formIds = [];
    /** @var string[] */
    private array $appIds = [];

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-sharedforms-' . bin2hex(random_bytes(5)));
        $formService = new FormService($conn, $sqlite);
        self::$apps = new AppService($conn, $formService);
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
        foreach ($this->appIds as $appId) {
            // app_users.role_id → app_roles is ON DELETE RESTRICT: delete children in FK-safe order.
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$appId]);
        }
        foreach ($this->formIds as $fid) {
            self::$pdo->prepare('DELETE FROM response_links WHERE source_form_id = ? OR target_form_id = ?')->execute([$fid, $fid]);
            self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$fid]);
        }
        foreach ($this->userIds as $uid) {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
    }

    private function uuid(): string
    {
        return bin2hex(random_bytes(14));
    }

    private function makeUser(): string
    {
        $id = 'u-' . $this->uuid();
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$id, $id . '@test.local']);
        $this->userIds[] = $id;
        return $id;
    }

    private function makeForm(string $ownerId, string $title = 'Shared Form'): string
    {
        $id = 'form-' . $this->uuid();
        self::$pdo->prepare("INSERT INTO forms (id, user_id, title, status) VALUES (?, ?, ?, 'published')")
            ->execute([$id, $ownerId, $title]);
        $this->formIds[] = $id;
        return $id;
    }

    private function makeApp(string $ownerId, string $name): string
    {
        $app = self::$apps->createApp(['name' => $name], $ownerId);
        $this->appIds[] = $app['id'];
        return $app['id'];
    }

    private function appFormRowCount(string $appId, string $formId): int
    {
        $stmt = self::$pdo->prepare('SELECT COUNT(*) FROM app_forms WHERE app_id = ? AND form_id = ?');
        $stmt->execute([$appId, $formId]);
        return (int) $stmt->fetchColumn();
    }

    private function addResponseLink(string $formId): string
    {
        $id = 'rl-' . $this->uuid();
        self::$pdo->prepare("INSERT INTO response_links (id, source_form_id, source_response_id, target_form_id, target_response_id, field_id) VALUES (?, ?, 'src-resp', ?, 'tgt-resp', 'field_1')")
            ->execute([$id, $formId, $formId]);
        return $id;
    }

    private function responseLinkExists(string $linkId): bool
    {
        $stmt = self::$pdo->prepare('SELECT 1 FROM response_links WHERE id = ?');
        $stmt->execute([$linkId]);
        return $stmt->fetchColumn() !== false;
    }

    // -------------------------------------------------------------------------
    // Shared attach + shared response backing
    // -------------------------------------------------------------------------

    public function testGetAllAppsReturnsRealFormCount(): void
    {
        // The apps LIST payload must carry the true attached-form count — list UIs were deriving it
        // from navConfig.length, which is empty on pack-provisioned apps (the "0 forms" bug).
        $owner = $this->makeUser();
        $appId = $this->makeApp($owner, 'Counted App');
        $emptyApp = $this->makeApp($owner, 'Empty App');
        self::$apps->addFormToApp($appId, $this->makeForm($owner, 'F1'));
        self::$apps->addFormToApp($appId, $this->makeForm($owner, 'F2'));
        self::$apps->addFormToApp($appId, $this->makeForm($owner, 'F3'));

        $byId = [];
        foreach (self::$apps->getAllApps($owner) as $a) {
            $byId[$a['id']] = $a;
        }
        $this->assertSame(3, $byId[$appId]['formCount'] ?? null, 'formCount reflects app_forms, not navConfig');
        $this->assertSame(0, $byId[$emptyApp]['formCount'] ?? null);
    }

    public function testFormAttachedToTwoAppsSharesTheSameResponseBacking(): void
    {
        $owner = $this->makeUser();
        $formId = $this->makeForm($owner);
        $clientApp = $this->makeApp($owner, 'Client App');
        $adminApp = $this->makeApp($owner, 'Admin App');

        self::$apps->addFormToApp($clientApp, $formId);
        self::$apps->addFormToApp($adminApp, $formId);

        $clientForms = array_column(self::$apps->getAppForms($clientApp), 'formId');
        $adminForms = array_column(self::$apps->getAppForms($adminApp), 'formId');
        $this->assertContains($formId, $clientForms, 'client app should list the shared form');
        $this->assertContains($formId, $adminForms, 'admin app should list the shared form');

        // Responses live in per-form SQLite keyed by form_id: both apps reference
        // the SAME form_id, so a response submitted "through" either app lands in
        // the one shared store both apps read.
        $result = self::$responses->createResponse($formId, ['answers' => ['field_1' => 'hello']]);
        $this->assertIsArray($result);
        $this->assertSame(1, self::$responses->getResponseCount($formId));

        // Same form_id backing on both join rows — that IS the shared-data guarantee.
        $this->assertSame(
            array_intersect($clientForms, [$formId]),
            array_intersect($adminForms, [$formId])
        );
    }

    public function testGetAppsForFormsIsOwnerScopedAndMapsFormToApps(): void
    {
        $owner = $this->makeUser();
        $stranger = $this->makeUser();
        $formId = $this->makeForm($owner);
        $appA = $this->makeApp($owner, 'App A');
        $appB = $this->makeApp($owner, 'App B');
        $strangerApp = $this->makeApp($stranger, 'Stranger App');

        self::$apps->addFormToApp($appA, $formId);
        self::$apps->addFormToApp($appB, $formId);
        // Simulate a cross-owner attach directly (the controller forbids it) to prove owner scoping.
        self::$pdo->prepare("INSERT INTO app_forms (id, app_id, form_id, display_name, sort_order, is_visible, settings) VALUES (?, ?, ?, 'X', 0, 1, '{}')")
            ->execute(['af-' . $this->uuid(), $strangerApp, $formId]);

        $map = self::$apps->getAppsForForms([$formId], $owner);
        $this->assertArrayHasKey($formId, $map);
        $ids = array_column($map[$formId], 'id');
        $this->assertContains($appA, $ids);
        $this->assertContains($appB, $ids);
        $this->assertNotContains($strangerApp, $ids, 'another owner\'s app must not leak into the map');
        foreach ($map[$formId] as $entry) {
            $this->assertSame(['id', 'name', 'slug'], array_keys($entry));
        }

        $this->assertSame([], self::$apps->getAppsForForms([], $owner), 'empty input short-circuits');
    }

    // -------------------------------------------------------------------------
    // Duplicate attach
    // -------------------------------------------------------------------------

    public function testDuplicateAttachToSameAppIsRejectedWithFriendlyError(): void
    {
        $owner = $this->makeUser();
        $formId = $this->makeForm($owner);
        $appId = $this->makeApp($owner, 'Dup App');

        self::$apps->addFormToApp($appId, $formId);

        try {
            self::$apps->addFormToApp($appId, $formId);
            $this->fail('duplicate attach should throw');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('already in this app', $e->getMessage());
        }

        $this->assertSame(1, $this->appFormRowCount($appId, $formId), 'no second join row inserted');
    }

    public function testUniqueIndexBackstopsARaceWithFriendlyError(): void
    {
        $owner = $this->makeUser();
        $formId = $this->makeForm($owner);
        $appId = $this->makeApp($owner, 'Race App');

        self::$apps->addFormToApp($appId, $formId);

        // Bypass the SELECT guard to hit the UNIQUE index directly (simulates the
        // concurrent-insert race the guard cannot see).
        try {
            self::$pdo->prepare("INSERT INTO app_forms (id, app_id, form_id, display_name, sort_order, is_visible, settings) VALUES (?, ?, ?, 'Dup', 1, 1, '{}')")
                ->execute(['af-' . $this->uuid(), $appId, $formId]);
            $this->fail('unique_app_form index should reject the duplicate pair');
        } catch (\PDOException $e) {
            $this->assertSame(1062, $e->errorInfo[1] ?? null);
        }

        $this->assertSame(1, $this->appFormRowCount($appId, $formId));
    }

    // -------------------------------------------------------------------------
    // Migration dedupe
    // -------------------------------------------------------------------------

    public function testUniqueIndexMigrationDedupesKeepingLowestSortOrder(): void
    {
        $owner = $this->makeUser();
        $formId = $this->makeForm($owner);
        $appId = $this->makeApp($owner, 'Legacy App');

        // Simulate a pre-index install: drop the unique key, insert duplicates.
        self::$pdo->exec('ALTER TABLE app_forms DROP INDEX unique_app_form');
        try {
            $insert = self::$pdo->prepare("INSERT INTO app_forms (id, app_id, form_id, display_name, sort_order, is_visible, settings) VALUES (?, ?, ?, ?, ?, 1, '{}')");
            $insert->execute(['af-' . $this->uuid(), $appId, $formId, 'dup-2', 2]);
            $keptId = 'af-' . $this->uuid();
            $insert->execute([$keptId, $appId, $formId, 'keep-0', 0]);
            $insert->execute(['af-' . $this->uuid(), $appId, $formId, 'dup-1', 1]);
            $this->assertSame(3, $this->appFormRowCount($appId, $formId));
        } finally {
            // The migration is what restores the index — run it even if setup asserts fail
            // so the shared test DB is never left without the unique key.
            self::$mysql->runMigrations();
        }

        $this->assertSame(1, $this->appFormRowCount($appId, $formId), 'migration should keep exactly one row per (app_id, form_id)');
        $stmt = self::$pdo->prepare('SELECT id, sort_order FROM app_forms WHERE app_id = ? AND form_id = ?');
        $stmt->execute([$appId, $formId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        $this->assertSame($keptId, $row['id'], 'survivor should be the lowest sort_order row');
        $this->assertSame(0, (int) $row['sort_order']);

        $hasIdx = self::$pdo->query("SHOW INDEX FROM app_forms WHERE Key_name = 'unique_app_form'")->rowCount() > 0;
        $this->assertTrue($hasIdx, 'migration should restore the unique index');
    }

    // -------------------------------------------------------------------------
    // Deletion semantics
    // -------------------------------------------------------------------------

    public function testRemovingFormFromOneAppKeepsItInTheOther(): void
    {
        $owner = $this->makeUser();
        $formId = $this->makeForm($owner);
        $appA = $this->makeApp($owner, 'App A');
        $appB = $this->makeApp($owner, 'App B');

        self::$apps->addFormToApp($appA, $formId);
        self::$apps->addFormToApp($appB, $formId);
        self::$responses->createResponse($formId, ['answers' => ['field_1' => 'kept']]);
        $linkId = $this->addResponseLink($formId);

        $this->assertTrue(self::$apps->removeFormFromApp($appA, $formId));

        // Only the join row for app A is gone — app B, the form, its responses and
        // its response_links all survive.
        $this->assertSame(0, $this->appFormRowCount($appA, $formId));
        $this->assertSame(1, $this->appFormRowCount($appB, $formId));
        $this->assertContains($formId, array_column(self::$apps->getAppForms($appB), 'formId'));

        $formRow = self::$pdo->prepare('SELECT 1 FROM forms WHERE id = ?');
        $formRow->execute([$formId]);
        $this->assertNotFalse($formRow->fetchColumn(), 'forms row must survive a join-row removal');

        $this->assertSame(1, self::$responses->getResponseCount($formId), 'responses must survive');
        $this->assertTrue($this->responseLinkExists($linkId), 'response_links must survive while another app still uses the form');
    }

    public function testRemovingFormFromItsLastAppPurgesItsResponseLinks(): void
    {
        $owner = $this->makeUser();
        $formId = $this->makeForm($owner);
        $appA = $this->makeApp($owner, 'Only App');

        self::$apps->addFormToApp($appA, $formId);
        $linkId = $this->addResponseLink($formId);

        $this->assertTrue(self::$apps->removeFormFromApp($appA, $formId));
        $this->assertFalse($this->responseLinkExists($linkId), 'links purge once the form is in no app');
    }

    public function testDeletingAppAKeepsSharedFormResponsesAndAppB(): void
    {
        $owner = $this->makeUser();
        $sharedForm = $this->makeForm($owner, 'Shared');
        $exclusiveForm = $this->makeForm($owner, 'Exclusive');
        $appA = $this->makeApp($owner, 'Doomed App');
        $appB = $this->makeApp($owner, 'Surviving App');

        self::$apps->addFormToApp($appA, $sharedForm);
        self::$apps->addFormToApp($appB, $sharedForm);
        self::$apps->addFormToApp($appA, $exclusiveForm);

        self::$responses->createResponse($sharedForm, ['answers' => ['field_1' => 'precious data']]);
        $sharedLink = $this->addResponseLink($sharedForm);
        $exclusiveLink = $this->addResponseLink($exclusiveForm);

        $this->assertTrue(self::$apps->deleteApp($appA));

        // App A is gone; app B and the shared form's world are untouched.
        $this->assertNull(self::$apps->getApp($appA));
        $this->assertNotNull(self::$apps->getApp($appB));
        $this->assertContains($sharedForm, array_column(self::$apps->getAppForms($appB), 'formId'));

        foreach ([$sharedForm, $exclusiveForm] as $fid) {
            $formRow = self::$pdo->prepare('SELECT 1 FROM forms WHERE id = ?');
            $formRow->execute([$fid]);
            $this->assertNotFalse($formRow->fetchColumn(), "deleting an app must never delete form $fid");
        }

        $this->assertSame(1, self::$responses->getResponseCount($sharedForm), 'shared responses must survive app deletion');
        $this->assertTrue($this->responseLinkExists($sharedLink), 'shared form\'s response_links must survive — app B still needs them');
        $this->assertFalse($this->responseLinkExists($exclusiveLink), 'exclusive form\'s links purge with its only app');
    }
}
