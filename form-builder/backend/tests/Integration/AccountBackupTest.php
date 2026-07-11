<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AccountBackupService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\ReconcileService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Account backup export/import acceptance:
 *  - the export zip carries the whole workspace (shared forms ONCE, standalone
 *    forms, workspace + app flows, bindings) with a sha256-indexed manifest;
 *  - a round-trip import recreates everything as NEW resources with full record
 *    fidelity (ids remapped backup-wide: linked_record answers point at the NEW
 *    target rows, file urls rewritten, timestamps/status/metadata/computed/tags
 *    preserved) while keeping every MySQL mirror clean (response_metadata,
 *    response_links, forms.response_count — the Doctor's dual-store checks);
 *  - tampered/oversized/corrupt archives are rejected before anything is
 *    created, and a data-phase failure compensates back to zero.
 */
class AccountBackupTest extends TestCase
{
    private const SECRET = 'BACKUP-SECRET-ANSWER';

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SQLiteConnection $sqlite;
    private static FormService $forms;
    private static ResponseService $responses;
    private static AppService $apps;
    private static AppUserService $appUsers;
    private static FlowService $flows;
    private static AccountBackupService $backup;
    private static string $tmpRoot = '';
    private static string $formsPath = '';
    private static string $uploadsPath = '';

    private string $userId = '';
    private string $otherId = '';
    private string $f1 = '';
    private string $f2 = '';
    private string $app1 = '';
    private string $app2 = '';
    private array $f1ResponseIds = [];
    private string $f2ResponseId = '';
    private string $fileId = '';

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
        self::$tmpRoot = sys_get_temp_dir() . '/formlogic-backup-test-' . bin2hex(random_bytes(4));
        self::$formsPath = self::$tmpRoot . '/sqlite';
        self::$uploadsPath = self::$tmpRoot . '/uploads';
        mkdir(self::$formsPath, 0777, true);
        mkdir(self::$uploadsPath, 0777, true);

        self::$sqlite = new SQLiteConnection(self::$formsPath);
        self::$forms = new FormService($conn, self::$sqlite);
        self::$responses = new ResponseService($conn, self::$sqlite);
        self::$apps = new AppService($conn, self::$forms);
        self::$appUsers = new AppUserService($conn);
        self::$flows = new FlowService($conn);
        self::$backup = self::makeService();
    }

    private static function makeService(array $configOverride = []): AccountBackupService
    {
        return new AccountBackupService(
            self::$mysql,
            self::$sqlite,
            self::$forms,
            self::$apps,
            self::$appUsers,
            self::$flows,
            self::$responses,
            $configOverride,
            self::$formsPath,
            self::$uploadsPath
        );
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = $this->makeUser();
        $this->otherId = $this->makeUser();
        $this->buildFixture();
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        foreach ([$this->userId, $this->otherId] as $uid) {
            if ($uid === '') {
                continue;
            }
            self::$pdo->prepare('DELETE FROM audit_log WHERE user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM response_links WHERE source_form_id IN (SELECT id FROM forms WHERE user_id = ?)')->execute([$uid]);
            $owned = self::$pdo->prepare('SELECT id FROM apps WHERE owner_id = ?');
            $owned->execute([$uid]);
            foreach ($owned->fetchAll(PDO::FETCH_COLUMN) as $aid) {
                self::$pdo->prepare('DELETE FROM app_flow_bindings WHERE app_id = ?')->execute([$aid]);
                self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$aid]);
                self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$aid]);
                self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$aid]);
                self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$aid]);
            }
            self::$pdo->prepare('DELETE FROM app_flow_bindings WHERE flow_definition_id IN (SELECT id FROM flow_definitions WHERE owner_user_id = ?)')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM flow_definitions WHERE owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$uid]);
            // response_metadata cascades with forms.
            self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
    }

    // ── fixture ──────────────────────────────────────────────────────────────

    private function makeUser(): string
    {
        $id = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$id, $id . '@test.local']);
        return $id;
    }

    /**
     * User's world: app1 + app2 SHARING form F1 (published, 3 responses, one with
     * computed + tags); standalone form F2 (linked_record → F1, a file answer with
     * the file on disk); a workspace flow with a form binding on F2; an app flow
     * with a binding in app1.
     */
    private function buildFixture(): void
    {
        $f1 = self::$forms->createForm([
            'title' => 'Clients', 'userId' => $this->userId, 'status' => 'published',
            'fields' => [
                ['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false],
                ['id' => 'notes', 'type' => 'long_text', 'label' => 'Notes', 'required' => false],
            ],
        ]);
        $this->f1 = (string) $f1['id'];
        self::$pdo->prepare("UPDATE forms SET published_at = '2026-01-02 03:04:05', updated_at = updated_at WHERE id = ?")->execute([$this->f1]);

        self::$responses->createResponse($this->f1, ['answers' => ['name' => 'Alice', 'notes' => self::SECRET]], null);
        self::$responses->createResponse($this->f1, ['answers' => ['name' => 'Bob']], null);
        self::$responses->createResponse($this->f1, ['answers' => ['name' => 'Cara']], null);
        $db1 = self::$sqlite->getFormDatabase($this->f1);
        $this->f1ResponseIds = $db1->query('SELECT id FROM responses ORDER BY rowid')->fetchAll(PDO::FETCH_COLUMN);
        // computed values are stored as json-encoded TEXT; tags plain.
        $db1->prepare('INSERT INTO computed (response_id, field_name, field_value) VALUES (?, ?, ?)')
            ->execute([$this->f1ResponseIds[0], 'score', json_encode(42.5)]);
        $db1->prepare('INSERT INTO tags (response_id, tag) VALUES (?, ?)')
            ->execute([$this->f1ResponseIds[0], 'vip']);

        $this->fileId = 'file-' . bin2hex(random_bytes(8));
        $f2 = self::$forms->createForm([
            'title' => 'Jobs', 'userId' => $this->userId, 'status' => 'draft',
            'fields' => [
                ['id' => 'client', 'type' => 'linked_record', 'label' => 'Client', 'required' => false,
                 'properties' => ['targetFormId' => $this->f1, 'displayFieldIds' => ['name']]],
                ['id' => 'attachment', 'type' => 'file_upload', 'label' => 'Attachment', 'required' => false],
            ],
        ]);
        $this->f2 = (string) $f2['id'];
        $uploadDir = self::$uploadsPath . '/' . preg_replace('/[^a-zA-Z0-9\-]/', '', $this->f2);
        mkdir($uploadDir, 0777, true);
        file_put_contents($uploadDir . '/' . $this->fileId . '.pdf', 'PDF-BYTES');
        self::$responses->createResponse($this->f2, ['answers' => [
            'client' => $this->f1ResponseIds[0],
            'attachment' => [[
                'id' => $this->fileId, 'originalFilename' => 'doc.pdf',
                'storedFilename' => $this->fileId . '.pdf', 'size' => 9, 'mimeType' => 'application/pdf',
                'url' => "/api/files/{$this->f2}/{$this->fileId}/doc.pdf",
            ]],
        ]], null);
        $this->f2ResponseId = (string) self::$sqlite->getFormDatabase($this->f2)
            ->query('SELECT id FROM responses LIMIT 1')->fetchColumn();
        self::$responses->syncResponseLinks($this->f2, $this->f2ResponseId, $f2['fields'], ['client' => $this->f1ResponseIds[0]]);

        $app1 = self::$apps->createApp(['name' => 'Primary App'], $this->userId);
        $this->app1 = (string) $app1['id'];
        self::$apps->addFormToApp($this->app1, $this->f1, 'Client Book');
        $app2 = self::$apps->createApp(['name' => 'Companion App'], $this->userId);
        $this->app2 = (string) $app2['id'];
        self::$apps->addFormToApp($this->app2, $this->f1);

        self::$flows->createWorkspaceFlow($this->userId, ['name' => 'Workspace Flow', 'slug' => 'wf']);
        self::$flows->createFormBinding($this->userId, $this->f2, ['flow' => 'wf', 'event' => 'form.submitted', 'mode' => 'async']);
        self::$flows->createFlow($this->app1, $this->userId, ['name' => 'App Flow', 'slug' => 'af']);
        self::$flows->createBinding($this->app1, ['flow' => 'af', 'event' => 'form.submitted', 'mode' => 'async', 'formId' => $this->f1]);
    }

    private function countUserResources(string $userId): array
    {
        $forms = self::$pdo->prepare('SELECT COUNT(*) FROM forms WHERE user_id = ?');
        $forms->execute([$userId]);
        $apps = self::$pdo->prepare('SELECT COUNT(*) FROM apps WHERE owner_id = ?');
        $apps->execute([$userId]);
        $flows = self::$pdo->prepare('SELECT COUNT(*) FROM flow_definitions WHERE owner_user_id = ?');
        $flows->execute([$userId]);
        return [(int) $forms->fetchColumn(), (int) $apps->fetchColumn(), (int) $flows->fetchColumn()];
    }

    /** Rewrite one entry inside a backup zip; optionally fix up its manifest hash. */
    private function replaceZipEntry(string $zipPath, string $entry, string $content, bool $fixManifest): void
    {
        $zip = new \ZipArchive();
        $this->assertTrue($zip->open($zipPath) === true);
        $manifest = json_decode((string) $zip->getFromName('manifest.json'), true);
        $zip->deleteName($entry);
        $zip->addFromString($entry, $content);
        if ($fixManifest) {
            $manifest['entries'][$entry] = hash('sha256', $content);
            $zip->deleteName('manifest.json');
            $zip->addFromString('manifest.json', (string) json_encode($manifest));
        }
        $zip->close();
    }

    // ── 1. export archive shape ──────────────────────────────────────────────

    public function testExportProducesValidIndexedArchive(): void
    {
        $zipPath = self::$backup->exportAccount($this->userId);
        try {
            $zip = new \ZipArchive();
            $this->assertTrue($zip->open($zipPath) === true);

            $manifest = json_decode((string) $zip->getFromName('manifest.json'), true);
            $this->assertSame('formlogic.accountBackup', $manifest['kind']);
            $this->assertSame(1, $manifest['formatVersion']);
            $this->assertSame(2, $manifest['counts']['forms']);
            $this->assertSame(2, $manifest['counts']['apps']);
            $this->assertSame(2, $manifest['counts']['flows']);
            $this->assertSame(2, $manifest['counts']['bindings']);
            $this->assertSame(4, $manifest['counts']['responses']);
            $this->assertSame(1, $manifest['counts']['files']);

            // Every non-manifest entry is indexed with a correct sha256.
            foreach ($manifest['entries'] as $name => $sha) {
                $this->assertSame($sha, hash('sha256', (string) $zip->getFromName($name)), "hash of {$name}");
            }
            $this->assertArrayHasKey('backup.json', $manifest['entries']);
            $this->assertArrayHasKey("data/forms/{$this->f1}.sqlite", $manifest['entries']);
            $this->assertArrayHasKey("data/forms/{$this->f2}.sqlite", $manifest['entries']);
            $this->assertArrayHasKey("files/{$this->f2}/{$this->fileId}.pdf", $manifest['entries']);

            $structure = json_decode((string) $zip->getFromName('backup.json'), true);
            // The SHARED form appears exactly once; both apps reference it.
            $this->assertCount(2, $structure['forms']);
            $this->assertCount(2, $structure['apps']);
            $memberRefs = array_merge(...array_map(static fn ($a) => array_column($a['forms'], 'formId'), $structure['apps']));
            $this->assertSame([$this->f1, $this->f1], $memberRefs);
            $this->assertCount(2, $structure['flows']);
            $this->assertCount(1, $structure['appBindings']);
            $this->assertCount(1, $structure['formBindings']);
            $this->assertSame('wf', $structure['formBindings'][0]['flow']);
            $this->assertNotEmpty($structure['excluded']);

            $zip->close();
        } finally {
            @unlink($zipPath);
        }
    }

    // ── 2. full round trip ───────────────────────────────────────────────────

    public function testExportImportRoundTripPreservesRecordsAndRemapsIds(): void
    {
        $zipPath = self::$backup->exportAccount($this->userId);
        try {
            $result = self::$backup->importAccount($zipPath, $this->userId);
        } finally {
            @unlink($zipPath);
        }

        $this->assertCount(2, $result['forms']);
        $this->assertCount(2, $result['apps']);
        $this->assertSame(2, $result['flows']);
        $this->assertSame(2, $result['bindings']);
        $this->assertSame(4, $result['responses']);
        $this->assertSame(1, $result['files']);

        $newIds = array_column($result['forms'], 'id', 'title');
        $newF1 = $newIds['Clients'];
        $newF2 = $newIds['Jobs'];
        $this->assertNotSame($this->f1, $newF1);
        $this->assertNotSame($this->f2, $newF2);

        // Form status + publishedAt preserved; fields' link target remapped.
        $form1 = self::$forms->getForm($newF1);
        $this->assertSame('published', $form1['status']);
        $this->assertSame('2026-01-02 03:04:05', $form1['publishedAt']);
        $form2 = self::$forms->getForm($newF2);
        $clientField = null;
        foreach ($form2['fields'] as $f) {
            if ($f['id'] === 'client') {
                $clientField = $f;
            }
        }
        $this->assertSame($newF1, $clientField['properties']['targetFormId']);

        // Records: identical answers/status/timestamps; NEW ids; computed + tags faithful.
        $oldDb = self::$sqlite->getFormDatabase($this->f1);
        $newDb = self::$sqlite->getFormDatabase($newF1);
        $oldRows = $oldDb->query('SELECT answers, status, submitted_at, updated_at FROM responses ORDER BY submitted_at, answers')->fetchAll(PDO::FETCH_ASSOC);
        $newRows = $newDb->query('SELECT answers, status, submitted_at, updated_at FROM responses ORDER BY submitted_at, answers')->fetchAll(PDO::FETCH_ASSOC);
        $this->assertSame($oldRows, $newRows);
        $newRespIds = $newDb->query('SELECT id FROM responses')->fetchAll(PDO::FETCH_COLUMN);
        $this->assertEmpty(array_intersect($newRespIds, $this->f1ResponseIds), 'response ids must be regenerated');
        $computed = $newDb->query('SELECT field_name, field_value FROM computed')->fetchAll(PDO::FETCH_ASSOC);
        $this->assertSame([['field_name' => 'score', 'field_value' => json_encode(42.5)]], $computed);
        $tags = $newDb->query('SELECT tag FROM tags')->fetchAll(PDO::FETCH_COLUMN);
        $this->assertSame(['vip'], $tags);

        // Linked answer points at the NEW target row; file url carries the NEW form id.
        $newF2Db = self::$sqlite->getFormDatabase($newF2);
        $row = $newF2Db->query('SELECT id, answers FROM responses LIMIT 1')->fetch(PDO::FETCH_ASSOC);
        $answers = json_decode((string) $row['answers'], true);
        $this->assertContains($answers['client'], $newRespIds);
        $this->assertNotSame($this->f1ResponseIds[0], $answers['client']);
        $this->assertStringContainsString("/api/files/{$newF2}/{$this->fileId}/", $answers['attachment'][0]['url']);

        // response_links rebuilt with the NEW ids; the file restored under the new form dir.
        $links = self::$pdo->prepare('SELECT target_form_id, target_response_id FROM response_links WHERE source_form_id = ?');
        $links->execute([$newF2]);
        $link = $links->fetch(PDO::FETCH_ASSOC);
        $this->assertSame($newF1, $link['target_form_id']);
        $this->assertSame($answers['client'], $link['target_response_id']);
        $this->assertFileExists(self::$uploadsPath . '/' . preg_replace('/[^a-zA-Z0-9\-]/', '', $newF2) . '/' . $this->fileId . '.pdf');

        // MySQL mirrors are exact: metadata counts, cached response_count.
        foreach ([[$newF1, 3], [$newF2, 1]] as [$fid, $expected]) {
            $meta = self::$pdo->prepare('SELECT COUNT(*) FROM response_metadata WHERE form_id = ?');
            $meta->execute([$fid]);
            $this->assertSame($expected, (int) $meta->fetchColumn(), "response_metadata for {$fid}");
            $cnt = self::$pdo->prepare('SELECT response_count FROM forms WHERE id = ?');
            $cnt->execute([$fid]);
            $this->assertSame($expected, (int) $cnt->fetchColumn(), "forms.response_count for {$fid}");
        }

        // Workspace flow slug deduped, and the form binding follows the rename.
        $wsSlugs = array_column(self::$flows->listWorkspaceFlows($this->userId), 'slug');
        sort($wsSlugs);
        $this->assertSame(['wf', 'wf-2'], $wsSlugs);
        $newBindings = self::$flows->listFormBindings($this->userId, $newF2);
        $this->assertCount(1, $newBindings);
        $this->assertSame('wf-2', $newBindings[0]['flow']);

        // App membership: the shared form is attached to both new apps.
        foreach ($result['apps'] as $newApp) {
            $attached = array_column(self::$apps->getAppForms($newApp['id']), 'formId');
            $this->assertContains($newF1, $attached);
        }

        // The Doctor's dual-store report holds NO drift for the restored forms
        // (other suites' fixtures may drift globally — assert OUR ids are clean).
        $recon = new ReconcileService(self::$pdo, self::$sqlite, self::$formsPath, self::$uploadsPath, self::$forms);
        $report = $recon->report();
        foreach ([$newF1, $newF2] as $fid) {
            $this->assertNotContains($fid, $report['missingSqlite'], 'restored sqlite must exist');
            $this->assertNotContains($fid, array_column($report['countDrift'], 'formId'), 'no count drift for restored forms');
        }
        // And the restored links point at forms that exist (they'd otherwise count here).
        $orphans = self::$pdo->prepare(
            'SELECT COUNT(*) FROM response_links rl
             WHERE rl.source_form_id = ? AND rl.target_form_id NOT IN (SELECT id FROM forms)'
        );
        $orphans->execute([$newF2]);
        $this->assertSame(0, (int) $orphans->fetchColumn());
    }

    // ── 3-5. rejection + all-or-nothing ─────────────────────────────────────

    public function testTamperedEntryIsRejectedBeforeAnythingIsCreated(): void
    {
        $zipPath = self::$backup->exportAccount($this->userId);
        $before = $this->countUserResources($this->userId);
        try {
            // Flip the sqlite entry WITHOUT fixing the manifest hash.
            $this->replaceZipEntry($zipPath, "data/forms/{$this->f1}.sqlite", 'corrupted-bytes', false);
            try {
                self::$backup->importAccount($zipPath, $this->userId);
                $this->fail('expected integrity rejection');
            } catch (\RuntimeException $e) {
                $this->assertStringContainsString('checksum', $e->getMessage());
            }
            $this->assertSame($before, $this->countUserResources($this->userId), 'nothing may be created');
        } finally {
            @unlink($zipPath);
        }
    }

    public function testZipSlipAndOversizeAreRejected(): void
    {
        // Zip-slip: an escaping entry name is refused up front.
        $evil = self::$tmpRoot . '/evil-' . bin2hex(random_bytes(3)) . '.zip';
        $zip = new \ZipArchive();
        $zip->open($evil, \ZipArchive::CREATE);
        $zip->addFromString('../evil.txt', 'x');
        $zip->addFromString('manifest.json', '{}');
        $zip->close();
        try {
            self::$backup->importAccount($evil, $this->userId);
            $this->fail('expected zip-slip rejection');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('Unsafe path', $e->getMessage());
        } finally {
            @unlink($evil);
        }

        // Oversize: a service configured with a tiny cap refuses a real backup.
        $zipPath = self::$backup->exportAccount($this->userId);
        try {
            $small = self::makeService(['maxZipSize' => 1024]);
            $this->expectException(\RuntimeException::class);
            $this->expectExceptionMessageMatches('/maximum size/');
            $small->importAccount($zipPath, $this->userId);
        } finally {
            @unlink($zipPath);
        }
    }

    public function testDataPhaseFailureCompensatesEverything(): void
    {
        $zipPath = self::$backup->exportAccount($this->userId);
        $before = $this->countUserResources($this->userId);
        try {
            // Doctor the shipped sqlite: an invalid status passes zip validation
            // (hash fixed up) and the structure restore, then fails the data phase
            // inside restoreResponses — the import must compensate back to zero.
            $zip = new \ZipArchive();
            $this->assertTrue($zip->open($zipPath) === true);
            $staged = self::$tmpRoot . '/doctored-' . bin2hex(random_bytes(3)) . '.sqlite';
            file_put_contents($staged, $zip->getFromName("data/forms/{$this->f1}.sqlite"));
            $zip->close();
            $db = new PDO('sqlite:' . $staged);
            $db->exec("UPDATE responses SET status = 'hacked' WHERE id = (SELECT id FROM responses LIMIT 1)");
            unset($db);
            $this->replaceZipEntry($zipPath, "data/forms/{$this->f1}.sqlite", (string) file_get_contents($staged), true);
            @unlink($staged);

            try {
                self::$backup->importAccount($zipPath, $this->userId);
                $this->fail('expected data-phase failure');
            } catch (\RuntimeException $e) {
                $this->assertStringContainsString('rolled back', $e->getMessage());
            }
            $this->assertSame($before, $this->countUserResources($this->userId), 'compensation must remove every created resource');
        } finally {
            @unlink($zipPath);
        }
    }

    // ── 6-7. ownership + restore validation ─────────────────────────────────

    public function testImportIsOwnedByTheImporterNotTheBackupUser(): void
    {
        $zipPath = self::$backup->exportAccount($this->userId);
        try {
            $result = self::$backup->importAccount($zipPath, $this->otherId);
        } finally {
            @unlink($zipPath);
        }
        foreach ($result['forms'] as $f) {
            $owner = self::$pdo->prepare('SELECT user_id FROM forms WHERE id = ?');
            $owner->execute([$f['id']]);
            $this->assertSame($this->otherId, $owner->fetchColumn(), 'the IMPORTER owns everything; backup.json user.id is ignored');
        }
        // The original user's world is untouched.
        $this->assertSame([2, 2, 2], $this->countUserResources($this->userId));
    }

    public function testRestoreResponsesRejectsInvalidStatus(): void
    {
        $before = (int) self::$sqlite->getFormDatabase($this->f1)->query('SELECT COUNT(*) FROM responses')->fetchColumn();
        try {
            self::$responses->restoreResponses($this->f1, [[
                'id' => 'r-' . bin2hex(random_bytes(8)),
                'answers' => ['name' => 'x'], 'metadata' => [], 'status' => 'hacked',
                'submittedAt' => '2026-01-01 00:00:00', 'updatedAt' => '2026-01-01 00:00:00',
            ]]);
            $this->fail('expected invalid-status rejection');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('invalid status', $e->getMessage());
        }
        $after = (int) self::$sqlite->getFormDatabase($this->f1)->query('SELECT COUNT(*) FROM responses')->fetchColumn();
        $this->assertSame($before, $after);
    }

    // ── 8. the export really is the user's data (sanity for the round trip) ──

    public function testExportContainsTheRecordDataItPromises(): void
    {
        // (The ADMIN manifest's no-data guarantee is asserted in AdminPanelTest —
        // this is the inverse sanity check: the OWNER's backup does carry records.)
        $zipPath = self::$backup->exportAccount($this->userId);
        try {
            $zip = new \ZipArchive();
            $this->assertTrue($zip->open($zipPath) === true);
            $sqliteBytes = (string) $zip->getFromName("data/forms/{$this->f1}.sqlite");
            $this->assertStringContainsString(self::SECRET, $sqliteBytes);
            $zip->close();
        } finally {
            @unlink($zipPath);
        }
    }
}
