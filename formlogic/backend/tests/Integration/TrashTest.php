<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\PackController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AccountBackupService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppStorageEraser;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\PackService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\TrashConflictException;
use FormLogic\Services\TrashService;
use FormLogic\Services\TrashSnapshotException;
use PDO;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

/**
 * Recycle-bin acceptance: delete = snapshot + the SAME hard delete; restore =
 * preserve-ids re-import (a TRUE undelete when the ids are still free).
 *
 *  1. form trash + restore: original form AND response ids reclaimed, records/
 *     computed/tags faithful, app memberships re-attached, a surviving form's
 *     linked_record field still points at it and its inbound response_links
 *     (purged by deleteForm) are rebuilt;
 *  2. collision fallback: an occupied id (forms row / stale sqlite) restores
 *     as a copy with a warning;
 *  3. app trash + restore: member forms survive the delete; restore brings the
 *     ORIGINAL app id + slug back, re-attaches surviving forms, recreates the
 *     cascade-died flows/bindings/roles, and rebuilds the exclusive-form links
 *     deleteApp purged;
 *  4. flow trash + restore (bindings back); an app flow whose app is gone
 *     fails LOUDLY ("restore the app first") and succeeds after the app
 *     restore reclaims the original app id;
 *  5. restore consumes the item (row + zip); a claimed item can't be
 *     double-restored;
 *  6. empty drafts (0 fields + 0 responses) hard-delete without a bin entry;
 *  7. purgeExpired removes expired rows + zips and sweeps orphan zips;
 *  8. purgeUser (account erasure) wipes the user's bin fail-closed;
 *  9. pack uninstall pre-capture: record-bearing forms get bin entries, forms
 *     that survived don't.
 */
class TrashTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SQLiteConnection $sqlite;
    private static FormService $forms;
    private static ResponseService $responses;
    private static AppService $apps;
    private static AppUserService $appUsers;
    private static FlowService $flows;
    private static AccountBackupService $backup;
    private static TrashService $trash;
    private static string $tmpRoot = '';
    private static string $formsPath = '';
    private static string $uploadsPath = '';
    private static string $trashDir = '';

    private string $userId = '';
    private string $f1 = '';
    private string $f2 = '';
    private string $app1 = '';
    private array $f1ResponseIds = [];
    private string $f2ResponseId = '';

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
        self::$tmpRoot = sys_get_temp_dir() . '/formlogic-trash-test-' . bin2hex(random_bytes(4));
        self::$formsPath = self::$tmpRoot . '/sqlite';
        self::$uploadsPath = self::$tmpRoot . '/uploads';
        self::$trashDir = self::$tmpRoot . '/trash';
        mkdir(self::$formsPath, 0777, true);
        mkdir(self::$uploadsPath, 0777, true);
        mkdir(self::$trashDir, 0777, true);

        self::$sqlite = new SQLiteConnection(self::$formsPath);
        self::$forms = new FormService($conn, self::$sqlite);
        self::$responses = new ResponseService($conn, self::$sqlite);
        self::$apps = new AppService($conn, self::$forms);
        self::$appUsers = new AppUserService($conn);
        self::$flows = new FlowService($conn);
        self::$backup = new AccountBackupService(
            self::$mysql,
            self::$sqlite,
            self::$forms,
            self::$apps,
            self::$appUsers,
            self::$flows,
            self::$responses,
            [],
            self::$formsPath,
            self::$uploadsPath
        );
        self::$trash = new TrashService(
            self::$mysql,
            self::$sqlite,
            self::$backup,
            self::$forms,
            self::$apps,
            self::$flows,
            ['retentionDays' => 30, 'dir' => self::$trashDir]
        );
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = $this->makeUser();
        $this->buildFixture();
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->userId === '') {
            return;
        }
        $uid = $this->userId;
        self::$pdo->prepare('DELETE FROM trash_items WHERE user_id = ?')->execute([$uid]);
        foreach (glob(self::$trashDir . '/' . $uid . '/*.zip') ?: [] as $left) {
            unlink($left); // a test that leaves an item in the bin must not read as another's
        }
        self::$pdo->prepare('DELETE FROM pack_installations WHERE user_id = ?')->execute([$uid]);
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
        self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$uid]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
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
     * F1 "Clients" (2 responses, one with computed + tag), EXCLUSIVE member of
     * app1; F2 "Jobs" standalone with a linked_record → F1 (link row synced);
     * a workspace flow bound to F2; an app flow with a binding in app1.
     */
    private function buildFixture(): void
    {
        $f1 = self::$forms->createForm([
            'title' => 'Clients', 'userId' => $this->userId, 'status' => 'published',
            'fields' => [
                ['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false],
            ],
        ]);
        $this->f1 = (string) $f1['id'];
        self::$responses->createResponse($this->f1, ['answers' => ['name' => 'Alice']], null);
        self::$responses->createResponse($this->f1, ['answers' => ['name' => 'Bob']], null);
        $db1 = self::$sqlite->getFormDatabase($this->f1);
        $this->f1ResponseIds = $db1->query('SELECT id FROM responses ORDER BY rowid')->fetchAll(PDO::FETCH_COLUMN);
        $db1->prepare('INSERT INTO computed (response_id, field_name, field_value) VALUES (?, ?, ?)')
            ->execute([$this->f1ResponseIds[0], 'score', json_encode(42.5)]);
        $db1->prepare('INSERT INTO tags (response_id, tag) VALUES (?, ?)')
            ->execute([$this->f1ResponseIds[0], 'vip']);

        $f2 = self::$forms->createForm([
            'title' => 'Jobs', 'userId' => $this->userId, 'status' => 'draft',
            'fields' => [
                ['id' => 'client', 'type' => 'linked_record', 'label' => 'Client', 'required' => false,
                 'properties' => ['targetFormId' => $this->f1, 'displayFieldIds' => ['name']]],
            ],
        ]);
        $this->f2 = (string) $f2['id'];
        self::$responses->createResponse($this->f2, ['answers' => ['client' => $this->f1ResponseIds[0]]], null);
        $this->f2ResponseId = (string) self::$sqlite->getFormDatabase($this->f2)
            ->query('SELECT id FROM responses LIMIT 1')->fetchColumn();
        self::$responses->syncResponseLinks($this->f2, $this->f2ResponseId, $f2['fields'], ['client' => $this->f1ResponseIds[0]]);

        $app1 = self::$apps->createApp(['name' => 'Primary App'], $this->userId);
        $this->app1 = (string) $app1['id'];
        self::$apps->addFormToApp($this->app1, $this->f1, 'Client Book');

        self::$flows->createWorkspaceFlow($this->userId, ['name' => 'Workspace Flow', 'slug' => 'wf']);
        self::$flows->createFormBinding($this->userId, $this->f2, ['flow' => 'wf', 'event' => 'form.submitted', 'mode' => 'async']);
        self::$flows->createFlow($this->app1, $this->userId, ['name' => 'App Flow', 'slug' => 'af']);
        self::$flows->createBinding($this->app1, ['flow' => 'af', 'event' => 'form.submitted', 'mode' => 'async', 'formId' => $this->f1]);
    }

    // ── a form's id while it is in the bin ───────────────────────────────────

    public function testAnotherAccountCannotTakeTheIdOfAFormInTheBin(): void
    {
        $this->assertTrue(self::$trash->trashForm($this->f1, $this->userId)['trashed']);
        $stranger = $this->makeUser();
        try {
            self::$forms->createForm(['id' => $this->f1, 'title' => 'Squatter', 'userId' => $stranger]);
            $this->fail('expected a refusal');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('already exists', $e->getMessage());
        } finally {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$stranger]);
        }
        $this->assertNull(self::$forms->getForm($this->f1));
    }

    public function testItsOwnerCanStillRestoreIt(): void
    {
        self::$trash->trashForm($this->f1, $this->userId);
        $item = (string) array_values(array_filter($this->trashRows(), fn (array $row) => $row['original_id'] === $this->f1))[0]['id'];

        self::$trash->restore($item, $this->userId);

        $this->assertNotNull(self::$forms->getForm($this->f1));
    }

    public function testAClientMadeIdStillWorks(): void
    {
        // A form made offline keeps the id its client gave it: that is why ids are not dropped.
        $id = 'offline-' . bin2hex(random_bytes(8));
        $form = self::$forms->createForm(['id' => $id, 'title' => 'Made offline', 'userId' => $this->userId]);
        $this->assertSame($id, $form['id']);
    }

    // ── what an app holds on disk ────────────────────────────────────────────

    /** A bin whose app storage is on a temp root, and the two files that stand for an app's storage. */
    private function binWithStorage(): array
    {
        $root = self::$tmpRoot . '/storage-' . bin2hex(random_bytes(4));
        $hash = hash('sha256', $this->app1);
        mkdir("{$root}/native/{$hash}/private/data", 0700, true);
        mkdir("{$root}/hosted", 0700, true);
        $native = "{$root}/native/{$hash}/private/config.json";
        $hosted = "{$root}/hosted/{$hash}.sqlite";
        file_put_contents($native, '{"keyHex":"secret"}');
        file_put_contents($hosted, 'records');
        $trash = new TrashService(
            self::$mysql, self::$sqlite, self::$backup, self::$forms, self::$apps, self::$flows,
            ['retentionDays' => 30, 'dir' => self::$trashDir], null, null,
            new AppStorageEraser(new NativeAppService("{$root}/native"), "{$root}/hosted"),
        );
        return [$trash, $native, $hosted];
    }

    private function trashApp1(TrashService $trash): string
    {
        $this->assertTrue($trash->trashApp($this->app1, $this->userId));
        return (string) array_values(array_filter($this->trashRows(), fn (array $row) => $row['original_id'] === $this->app1))[0]['id'];
    }

    public function testAnAppKeepsItsStorageInTheBinAndLosesItWithDeleteForever(): void
    {
        [$trash, $native, $hosted] = $this->binWithStorage();
        $item = $this->trashApp1($trash);

        // The bin's snapshot holds no host keys and no hosted database: this is the only copy.
        $this->assertFileExists($native);
        $this->assertFileExists($hosted);

        (new \FormLogic\Services\FlowKvService(self::$mysql))->put($this->userId, $this->app1, 'app', 'count', 7);
        $this->assertTrue($trash->purgeItem($item, $this->userId));

        $this->assertFileDoesNotExist($native);
        $this->assertFileDoesNotExist($hosted);
        $this->assertSame([], (new \FormLogic\Services\FlowKvService(self::$mysql))->list($this->userId, $this->app1), 'nothing could reach it any more');
    }

    public function testExpiryAndErasureTakeAnAppsStorageToo(): void
    {
        [$trash, $native, $hosted] = $this->binWithStorage();
        $item = $this->trashApp1($trash);
        self::$pdo->prepare('UPDATE trash_items SET expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id = ?')->execute([$item]);
        $trash->purgeExpired();
        $this->assertFileDoesNotExist($native);
        $this->assertFileDoesNotExist($hosted);
    }

    public function testErasingAnAccountTakesTheStorageOfTheAppsInItsBin(): void
    {
        [$trash, $native, $hosted] = $this->binWithStorage();
        $this->trashApp1($trash);
        $this->assertSame(0, $trash->purgeUser($this->userId));
        $this->assertFileDoesNotExist($native);
        $this->assertFileDoesNotExist($hosted);
    }

    public function testAnIdWithALiveAppKeepsItsStorageWhateverTheBinSays(): void
    {
        [$trash, $native, $hosted] = $this->binWithStorage();
        $item = $this->trashApp1($trash);
        // What a restore that ended badly could leave: the item, and the app live again.
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'Back', ?, 'draft')")
            ->execute([$this->app1, $this->userId, 'back-' . bin2hex(random_bytes(4))]);

        $this->assertTrue($trash->purgeItem($item, $this->userId));

        $this->assertFileExists($native);
        $this->assertFileExists($hosted);
    }

    private function statusOf(string $item): string
    {
        $stmt = self::$pdo->prepare('SELECT status FROM trash_items WHERE id = ?');
        $stmt->execute([$item]);
        return (string) $stmt->fetchColumn();
    }

    /** A bin whose eraser notes the item's status at the moment it erases. */
    private function binNotingStatusAtErase(?string &$status, string &$item): TrashService
    {
        $eraser = $this->createMock(AppStorageEraser::class);
        $eraser->method('erase')->willReturnCallback(function () use (&$status, &$item): void {
            $status = $this->statusOf($item);
        });
        return new TrashService(
            self::$mysql, self::$sqlite, self::$backup, self::$forms, self::$apps, self::$flows,
            ['retentionDays' => 30, 'dir' => self::$trashDir], null, null, $eraser,
        );
    }

    public function testDeleteForeverHasTheItemBeforeItErasesAnything(): void
    {
        $status = null;
        $item = '';
        $trash = $this->binNotingStatusAtErase($status, $item);
        $item = $this->trashApp1($trash);

        $this->assertTrue($trash->purgeItem($item, $this->userId));

        $this->assertSame('restoring', $status, 'a restore can no longer take it');
    }

    public function testExpiryHasTheItemBeforeItErasesAnything(): void
    {
        $status = null;
        $item = '';
        $trash = $this->binNotingStatusAtErase($status, $item);
        $item = $this->trashApp1($trash);
        self::$pdo->prepare('UPDATE trash_items SET expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id = ?')->execute([$item]);

        $trash->purgeExpired();

        $this->assertSame('restoring', $status);
    }

    public function testExpiryLeavesAnItemARestoreIsWorkingOn(): void
    {
        [$trash, $native, $hosted] = $this->binWithStorage();
        $item = $this->trashApp1($trash);
        self::$pdo->prepare("UPDATE trash_items SET status = 'restoring', claimed_at = NOW(), expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id = ?")->execute([$item]);

        $trash->purgeExpired();

        $this->assertFileExists($native);
        $this->assertFileExists($hosted);
        $this->assertNotEmpty(array_filter($this->trashRows(), static fn (array $row) => $row['id'] === $item));
    }

    public function testExpiryTakesAnItemWhoseRestoreDied(): void
    {
        [$trash, $native, $hosted] = $this->binWithStorage();
        $item = $this->trashApp1($trash);
        self::$pdo->prepare("UPDATE trash_items SET status = 'restoring', claimed_at = DATE_SUB(NOW(), INTERVAL 1 HOUR), expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id = ?")->execute([$item]);

        $trash->purgeExpired();

        $this->assertFileDoesNotExist($native);
        $this->assertFileDoesNotExist($hosted);
        $this->assertSame([], array_filter($this->trashRows(), static fn (array $row) => $row['id'] === $item));
    }

    public function testAPurgeThatFailsHandsTheItemBack(): void
    {
        $eraser = $this->createMock(AppStorageEraser::class);
        $eraser->method('erase')->willThrowException(new \RuntimeException('The app is busy.'));
        $trash = new TrashService(
            self::$mysql, self::$sqlite, self::$backup, self::$forms, self::$apps, self::$flows,
            ['retentionDays' => 30, 'dir' => self::$trashDir], null, null, $eraser,
        );
        $item = $this->trashApp1($trash);

        $this->assertFalse($trash->purgeItem($item, $this->userId));

        $this->assertSame('trashed', $this->statusOf($item), 'it can be tried again, or restored');
    }

    public function testUninstallingAPackPutsItsAppInTheBinWithItsStorage(): void
    {
        [$trash, $native, $hosted] = $this->binWithStorage();
        $packs = new PackService(self::$mysql, self::$forms, self::$apps, new AppUserService(self::$mysql));
        $install = function (): string {
            $id = 'inst-' . bin2hex(random_bytes(8));
            self::$pdo->prepare("INSERT INTO pack_installations (id, user_id, pack_id, pack_name, form_ids, app_ids) VALUES (?, ?, 'test-pack', 'Test Pack', '[]', ?)")
                ->execute([$id, $this->userId, json_encode([$this->app1])]);
            return $id;
        };

        $result = $packs->uninstallPack($install(), $this->userId, $trash);

        $this->assertSame(1, $result['appsDeleted']);
        $this->assertNull(self::$apps->getApp($this->app1));
        $this->assertFileExists($native, 'members\' records are in this: the pack can\'t bring them back');
        $this->assertFileExists($hosted);
        $this->assertNotEmpty(array_filter($this->trashRows(), fn (array $row) => $row['original_id'] === $this->app1));

        // A retry finds the row gone and must not take that for storage left behind.
        $again = $packs->uninstallPack($install(), $this->userId, $trash);
        $this->assertSame(0, $again['appsDeleted']);
        $this->assertFileExists($hosted);
    }

    private function claimAged(string $item, int $minutes): void
    {
        self::$pdo->prepare("UPDATE trash_items SET status = 'restoring', claimed_at = NOW() - INTERVAL {$minutes} MINUTE WHERE id = ?")->execute([$item]);
    }

    private function listed(string $item): array
    {
        return array_values(array_filter(self::$trash->listTrash($this->userId), static fn (array $row) => $row['id'] === $item))[0];
    }

    public function testAPurgeThatDiedLeavesAnItemThatCanBeUsed(): void
    {
        [$trash] = $this->binWithStorage();
        $item = $this->trashApp1($trash);
        $this->claimAged($item, 31);

        $this->assertSame('trashed', $this->listed($item)['status'], 'the page greys out what it is told is taken');
        $this->assertSame('trashed', self::$trash->getItem($item, $this->userId)['status']);

        $this->assertTrue($trash->purgeItem($item, $this->userId));
        $this->assertEmpty(array_filter($this->trashRows(), static fn (array $row) => $row['id'] === $item));
    }

    public function testAClaimStillInItsThirtyMinutesKeepsTheItem(): void
    {
        [$trash] = $this->binWithStorage();
        $item = $this->trashApp1($trash);
        $this->claimAged($item, 29);

        $this->assertSame('restoring', $this->listed($item)['status']);
        $this->assertFalse($trash->purgeItem($item, $this->userId));
        $this->assertSame('restoring', $this->statusOf($item));
    }

    /** A bin that can't keep anything: its folder's place is taken by a file. */
    private function binThatCannotKeepAnything(array $config = []): TrashService
    {
        $blocked = self::$tmpRoot . '/not-a-folder-' . bin2hex(random_bytes(4));
        file_put_contents($blocked, '');
        return new TrashService(
            self::$mysql, self::$sqlite, self::$backup, self::$forms, self::$apps, self::$flows,
            $config + ['retentionDays' => 30, 'dir' => $blocked]
        );
    }

    private function packHolding(array $formIds, array $appIds): string
    {
        $id = 'inst-' . bin2hex(random_bytes(8));
        self::$pdo->prepare("INSERT INTO pack_installations (id, user_id, pack_id, pack_name, form_ids, app_ids) VALUES (?, ?, 'test-pack', 'Test Pack', ?, ?)")
            ->execute([$id, $this->userId, json_encode($formIds), json_encode($appIds)]);
        return $id;
    }

    private function packStillInstalled(string $installationId): bool
    {
        $stmt = self::$pdo->prepare('SELECT 1 FROM pack_installations WHERE id = ?');
        $stmt->execute([$installationId]);
        return $stmt->fetchColumn() !== false;
    }

    private function packs(): PackService
    {
        return new PackService(self::$mysql, self::$forms, self::$apps, new AppUserService(self::$mysql));
    }

    public function testAnUninstallStopsBeforeAnythingGoesWhenTheBinCannotKeepAnApp(): void
    {
        [, $native, $hosted] = $this->binWithStorage();
        $installation = $this->packHolding([$this->f1], [$this->app1]);

        try {
            $this->packs()->uninstallPack($installation, $this->userId, $this->binThatCannotKeepAnything());
            $this->fail('Nothing stopped it');
        } catch (TrashSnapshotException $e) {
            $this->assertStringContainsString('Nothing was uninstalled', $e->getMessage());
            $this->assertStringContainsString('recycle bin', $e->getMessage());
            $this->assertStringContainsString('Could not create the trash directory', $e->getMessage(), 'and it says why');
        }

        $this->assertNotNull(self::$apps->getApp($this->app1));
        $this->assertNotNull(self::$forms->getForm($this->f1));
        $this->assertFileExists($native);
        $this->assertFileExists($hosted);
        $this->assertTrue($this->packStillInstalled($installation), 'it can be tried again');
        $this->assertSame([], $this->trashRows());
    }

    public function testAnAppSecondInLineStopsTheFirstGoingToo(): void
    {
        $second = self::$apps->createApp(['name' => 'Second', 'status' => 'published'], $this->userId);
        // The bin's read of the second app is what fails, as a full disk would fail its copy.
        $apps = new class ((string) $second['id'], self::$mysql, self::$forms) extends AppService {
            public function __construct(private string $refused, MySQLConnection $mysql, FormService $forms)
            {
                parent::__construct($mysql, $forms);
            }

            public function getApp(string $appId): ?array
            {
                if ($appId === $this->refused) {
                    throw new \RuntimeException('No space left on device');
                }
                return parent::getApp($appId);
            }
        };
        $trash = new TrashService(self::$mysql, self::$sqlite, self::$backup, self::$forms, $apps, self::$flows, ['retentionDays' => 30, 'dir' => self::$trashDir]);

        try {
            $this->packs()->uninstallPack($this->packHolding([], [$this->app1, $second['id']]), $this->userId, $trash);
            $this->fail('Nothing stopped it');
        } catch (TrashSnapshotException $e) {
            $this->assertStringContainsString('No space left on device', $e->getMessage());
        }

        $this->assertNotNull(self::$apps->getApp($this->app1));
        $this->assertSame([], $this->trashRows(), 'the first app\'s copy goes: it is still here');
        $this->assertSame([], glob(self::$trashDir . '/' . $this->userId . '/*.zip') ?: []);
    }

    public function testADeleteThatFailsAfterTheCopyLeavesNoItem(): void
    {
        $apps = new class (self::$mysql, self::$forms) extends AppService {
            public function deleteApp(string $appId): bool
            {
                throw new \RuntimeException('The app is busy.');
            }
        };
        $trash = new TrashService(self::$mysql, self::$sqlite, self::$backup, self::$forms, $apps, self::$flows, ['retentionDays' => 30, 'dir' => self::$trashDir]);
        $packs = new PackService(self::$mysql, self::$forms, $apps, new AppUserService(self::$mysql));

        try {
            $packs->uninstallPack($this->packHolding([], [$this->app1]), $this->userId, $trash);
            $this->fail('The delete failed');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('Retry uninstall', $e->getMessage());
        }

        $this->assertNotNull(self::$apps->getApp($this->app1));
        $this->assertSame([], $this->trashRows(), 'an item for an app that is still here would come back as a copy');
    }

    public function testAnUninstallKeepsACopyOfARecordBearingFormBeforeItGoes(): void
    {
        $trash = $this->binThatCannotKeepAnything();

        $this->expectException(TrashSnapshotException::class);
        $this->expectExceptionMessage('"Clients"');
        $trash->captureRecordBearingForms($this->packHolding([$this->f1], []), $this->userId);
    }

    public function testACopyOfTheSecondFormFailingTakesTheFirstCopyOutToo(): void
    {
        // A snapshot that can't be made: the file holding the second form's records is ruined.
        self::$sqlite->closeAll();
        file_put_contents(self::$sqlite->getFormDbPath($this->f2), 'not a database');

        try {
            self::$trash->captureRecordBearingForms($this->packHolding([$this->f1, $this->f2], []), $this->userId);
            $this->fail('Nothing stopped it');
        } catch (TrashSnapshotException $e) {
            $this->assertStringContainsString('"Jobs"', $e->getMessage());
        }

        $this->assertSame([], $this->trashRows());
        $this->assertSame([], glob(self::$trashDir . '/' . $this->userId . '/*.zip') ?: []);
    }

    public function testTheRouteSaysWhyAndDeletesNothing(): void
    {
        $installation = $this->packHolding([$this->f1], [$this->app1]);
        $controller = new PackController($this->packs(), null, null, null, $this->binThatCannotKeepAnything());
        $request = (new ServerRequestFactory())->createServerRequest('DELETE', '/api/packs/' . $installation)->withAttribute('userId', $this->userId);

        $response = $controller->uninstall($request, new SlimResponse(), ['installationId' => $installation]);

        $this->assertSame(503, $response->getStatusCode(), (string) $response->getBody());
        $body = json_decode((string) $response->getBody(), true);
        $this->assertSame('bin_unavailable', $body['code']);
        $this->assertStringContainsString('Nothing was uninstalled', $body['message']);
        $this->assertNotNull(self::$apps->getApp($this->app1));
        $this->assertNotNull(self::$forms->getForm($this->f1));
        $this->assertTrue($this->packStillInstalled($installation));
    }

    public function testTheRouteGoesOnWithoutACopyWhenThePersonSaysTo(): void
    {
        $installation = $this->packHolding([$this->f1], [$this->app1]);
        $controller = new PackController($this->packs(), null, null, null, $this->binThatCannotKeepAnything());
        $request = (new ServerRequestFactory())->createServerRequest('DELETE', '/api/packs/' . $installation)
            ->withQueryParams(['withoutCopy' => '1'])->withAttribute('userId', $this->userId);

        $response = $controller->uninstall($request, new SlimResponse(), ['installationId' => $installation]);

        $this->assertSame(200, $response->getStatusCode(), (string) $response->getBody());
        $this->assertNull(self::$apps->getApp($this->app1));
        $this->assertNull(self::$forms->getForm($this->f1));
        $this->assertFalse($this->packStillInstalled($installation));
        $this->assertSame([], $this->trashRows());
    }

    public function testAFormDeleteRefusesWhenNoCopyCanBeMadeAndGoesOnWhenThePersonSaysTo(): void
    {
        self::$sqlite->closeAll();
        file_put_contents(self::$sqlite->getFormDbPath($this->f2), 'not a database');

        try {
            self::$trash->trashForm($this->f2, $this->userId);
            $this->fail('Nothing stopped it');
        } catch (TrashSnapshotException $e) {
            $this->assertStringContainsString('Nothing was deleted', $e->getMessage());
            $this->assertStringContainsString('"Jobs"', $e->getMessage());
            $this->assertStringNotContainsString('SQLSTATE', $e->getMessage(), 'the guard would answer for it, and the code would be lost');
        }
        $this->assertSame($this->userId, self::$forms->ownerOf($this->f2));

        $this->assertSame(['deleted' => true, 'trashed' => false], self::$trash->trashForm($this->f2, $this->userId, false));
        $this->assertNull(self::$forms->ownerOf($this->f2));
        $this->assertSame([], $this->trashRows());
    }

    public function testAnOrdinaryDeleteStillGoesThroughWhenTheBinCannotKeepIt(): void
    {
        $this->assertTrue($this->binThatCannotKeepAnything()->trashApp($this->app1, $this->userId), 'what was asked for is deleted, as it was');
        $this->assertNull(self::$apps->getApp($this->app1));
    }

    public function testAnItemWhoseStorageCannotGoStaysForARetry(): void
    {
        $eraser = $this->createMock(AppStorageEraser::class);
        $eraser->method('erase')->willThrowException(new \RuntimeException('The app is busy.'));
        $trash = new TrashService(
            self::$mysql, self::$sqlite, self::$backup, self::$forms, self::$apps, self::$flows,
            ['retentionDays' => 30, 'dir' => self::$trashDir], null, null, $eraser,
        );
        $item = $this->trashApp1($trash);

        $this->assertFalse($trash->purgeItem($item, $this->userId));
        $this->assertNotEmpty(array_filter($this->trashRows(), static fn (array $row) => $row['id'] === $item));

        self::$pdo->prepare('UPDATE trash_items SET expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id = ?')->execute([$item]);
        $trash->purgeExpired();
        $this->assertNotEmpty(array_filter($this->trashRows(), static fn (array $row) => $row['id'] === $item));
        $this->assertSame(1, $trash->purgeUser($this->userId), 'an erasure must not call this complete');
    }

    private function linkCount(string $sourceFormId, string $targetFormId): int
    {
        $stmt = self::$pdo->prepare('SELECT COUNT(*) FROM response_links WHERE source_form_id = ? AND target_form_id = ?');
        $stmt->execute([$sourceFormId, $targetFormId]);
        return (int) $stmt->fetchColumn();
    }

    private function trashRows(): array
    {
        $stmt = self::$pdo->prepare('SELECT * FROM trash_items WHERE user_id = ? ORDER BY deleted_at');
        $stmt->execute([$this->userId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    // ── 1. form trash + true undelete ────────────────────────────────────────

    public function testFormTrashAndRestoreReclaimsOriginalIds(): void
    {
        $this->assertSame(1, $this->linkCount($this->f2, $this->f1));

        $result = self::$trash->trashForm($this->f1, $this->userId);
        $this->assertTrue($result['deleted']);
        $this->assertTrue($result['trashed']);

        // Hard-deleted for real; links purged both directions; snapshot on disk.
        $exists = self::$pdo->prepare('SELECT 1 FROM forms WHERE id = ?');
        $exists->execute([$this->f1]);
        $this->assertFalse($exists->fetchColumn());
        $this->assertSame(0, $this->linkCount($this->f2, $this->f1));
        $rows = $this->trashRows();
        $this->assertCount(1, $rows);
        $this->assertSame('form', $rows[0]['kind']);
        $this->assertSame($this->f1, $rows[0]['original_id']);
        $this->assertSame('Clients', $rows[0]['name']);
        $this->assertFileExists(self::$trashDir . '/' . $rows[0]['zip_path']);
        $meta = json_decode((string) $rows[0]['meta'], true);
        $this->assertSame(2, $meta['counts']['responses']);

        $out = self::$trash->restore((string) $rows[0]['id'], $this->userId);

        // TRUE undelete: same form id, same response ids, records faithful.
        $restored = self::$forms->getForm($this->f1);
        $this->assertNotNull($restored);
        $this->assertSame('Clients', $restored['title']);
        $db = self::$sqlite->getFormDatabase($this->f1);
        $ids = $db->query('SELECT id FROM responses ORDER BY rowid')->fetchAll(PDO::FETCH_COLUMN);
        $this->assertSame($this->f1ResponseIds, $ids);
        $this->assertSame('42.5', (string) $db->query('SELECT field_value FROM computed LIMIT 1')->fetchColumn());
        $this->assertSame('vip', (string) $db->query('SELECT tag FROM tags LIMIT 1')->fetchColumn());

        // App membership re-attached (app_forms cascade-died with the form).
        $member = self::$pdo->prepare('SELECT display_name FROM app_forms WHERE app_id = ? AND form_id = ?');
        $member->execute([$this->app1, $this->f1]);
        $this->assertSame('Client Book', $member->fetchColumn());

        // The surviving form still targets it, and its inbound links are rebuilt.
        $f2 = self::$forms->getForm($this->f2);
        $this->assertSame($this->f1, $f2['fields'][0]['properties']['targetFormId']);
        $this->assertSame(1, $this->linkCount($this->f2, $this->f1));

        // Consumed.
        $this->assertCount(0, $this->trashRows());
        $this->assertSame([], glob(self::$trashDir . '/*/*.zip') ?: []);
        $this->assertSame(2, $out['restored']['responses']);
    }

    // ── 2. collision → copy fallback ─────────────────────────────────────────

    public function testOccupiedIdRestoresAsCopyWithWarning(): void
    {
        self::$trash->trashForm($this->f1, $this->userId);
        // Someone re-claims the id (same id supplied — the restore path itself uses this gate).
        self::$forms->createForm(['id' => $this->f1, 'title' => 'Squatter', 'userId' => $this->userId, 'fields' => [
            ['id' => 'x', 'type' => 'short_text', 'label' => 'X', 'required' => false],
        ]]);

        $rows = $this->trashRows();
        $out = self::$trash->restore((string) $rows[0]['id'], $this->userId);

        $this->assertNotEmpty($out['restored']['warnings']);
        $this->assertStringContainsString('restored as a copy', implode(' ', $out['restored']['warnings']));
        $copyId = $out['restored']['forms'][0]['id'];
        $this->assertNotSame($this->f1, $copyId);
        $copyDb = self::$sqlite->getFormDatabase($copyId);
        $this->assertSame(2, (int) $copyDb->query('SELECT COUNT(*) FROM responses')->fetchColumn());
        // The squatter is untouched.
        $this->assertSame('Squatter', self::$forms->getForm($this->f1)['title']);
    }

    public function testStaleSqliteFileBlocksIdReclaim(): void
    {
        self::$trash->trashForm($this->f1, $this->userId);
        // A stale on-disk database still owns the id even with no forms row.
        file_put_contents(self::$formsPath . '/' . $this->f1 . '.sqlite', 'stale');
        try {
            $rows = $this->trashRows();
            $out = self::$trash->restore((string) $rows[0]['id'], $this->userId);
            $this->assertNotSame($this->f1, $out['restored']['forms'][0]['id']);
            $this->assertStringContainsString('restored as a copy', implode(' ', $out['restored']['warnings']));
        } finally {
            @unlink(self::$formsPath . '/' . $this->f1 . '.sqlite');
        }
    }

    // ── 3. app trash + restore ───────────────────────────────────────────────

    public function testAppTrashAndRestoreReattachesFormsAndRebuildsCascades(): void
    {
        $role = self::$appUsers->createRole($this->app1, ['name' => 'Reviewer']);
        self::$appUsers->setRolePermissions($role['id'], [['formId' => $this->f1, 'permission' => 'view_all_responses']], true);
        $slugStmt = self::$pdo->prepare('SELECT slug FROM apps WHERE id = ?');
        $slugStmt->execute([$this->app1]);
        $origSlug = (string) $slugStmt->fetchColumn();

        $this->assertTrue(self::$trash->trashApp($this->app1, $this->userId));

        // Forms SURVIVE; the app + its flows are gone; exclusive-form links purged.
        $this->assertNotNull(self::$forms->getForm($this->f1));
        $appGone = self::$pdo->prepare('SELECT 1 FROM apps WHERE id = ?');
        $appGone->execute([$this->app1]);
        $this->assertFalse($appGone->fetchColumn());
        $flowGone = self::$pdo->prepare('SELECT COUNT(*) FROM flow_definitions WHERE app_id = ?');
        $flowGone->execute([$this->app1]);
        $this->assertSame(0, (int) $flowGone->fetchColumn());
        $this->assertSame(0, $this->linkCount($this->f2, $this->f1));

        $rows = $this->trashRows();
        $this->assertSame('app', $rows[0]['kind']);
        self::$trash->restore((string) $rows[0]['id'], $this->userId);

        // ORIGINAL app id + slug; membership re-attached; flow + binding + role back.
        $app = self::$apps->getApp($this->app1);
        $this->assertNotNull($app);
        $this->assertSame('Primary App', $app['name']);
        $this->assertSame($origSlug, $app['slug']);
        $member = self::$pdo->prepare('SELECT 1 FROM app_forms WHERE app_id = ? AND form_id = ?');
        $member->execute([$this->app1, $this->f1]);
        $this->assertNotFalse($member->fetchColumn());
        $flowsBack = self::$flows->listFlows($this->app1);
        $this->assertCount(1, $flowsBack);
        $this->assertSame('af', $flowsBack[0]['slug']);
        $bindings = self::$flows->listBindings($this->app1);
        $this->assertCount(1, $bindings);
        $this->assertSame($this->f1, $bindings[0]['formId']);
        $roleBack = null;
        foreach (self::$appUsers->getRoles($this->app1) as $r) {
            if ($r['name'] === 'Reviewer') {
                $roleBack = $r;
            }
        }
        $this->assertNotNull($roleBack);
        $this->assertSame($this->f1, $roleBack['permissions'][0]['formId'] ?? null);

        // The exclusive form's purged links are rebuilt.
        $this->assertSame(1, $this->linkCount($this->f2, $this->f1));
    }

    // ── 4. flow trash + restore ──────────────────────────────────────────────

    public function testWorkspaceFlowTrashAndRestoreBringsBindingsBack(): void
    {
        $wf = null;
        foreach (self::$flows->listWorkspaceFlows($this->userId) as $f) {
            if ($f['slug'] === 'wf') {
                $wf = $f;
            }
        }
        $this->assertNotNull($wf);
        $this->assertTrue(self::$trash->trashWorkspaceFlow((string) $wf['id'], $this->userId));
        $this->assertSame([], self::$flows->listFormBindings($this->userId, $this->f2));

        $rows = $this->trashRows();
        self::$trash->restore((string) $rows[0]['id'], $this->userId);

        $restored = self::$flows->getWorkspaceFlow($this->userId, (string) $wf['id']);
        $this->assertNotNull($restored);
        $this->assertSame('wf', $restored['slug']);
        $bindings = self::$flows->listFormBindings($this->userId, $this->f2);
        $this->assertCount(1, $bindings);
        $this->assertSame('form.submitted', $bindings[0]['event']);
    }

    public function testAppFlowRestoreRequiresTheAppFirst(): void
    {
        $flow = self::$flows->listFlows($this->app1)[0];
        $this->assertTrue(self::$trash->trashFlow($this->app1, (string) $flow['id'], $this->userId));
        $this->assertTrue(self::$trash->trashApp($this->app1, $this->userId));

        $rows = $this->trashRows();
        $flowRow = null;
        $appRow = null;
        foreach ($rows as $r) {
            if ($r['kind'] === 'flow') {
                $flowRow = $r;
            }
            if ($r['kind'] === 'app') {
                $appRow = $r;
            }
        }
        $this->assertNotNull($flowRow);
        $this->assertNotNull($appRow);

        // App gone → loud failure, item NOT consumed.
        try {
            self::$trash->restore((string) $flowRow['id'], $this->userId);
            $this->fail('Expected the flow restore to fail while its app is deleted');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('Restore the app', $e->getMessage());
        }
        $still = self::$pdo->prepare("SELECT status FROM trash_items WHERE id = ?");
        $still->execute([$flowRow['id']]);
        $this->assertSame('trashed', $still->fetchColumn());

        // Restore the app (original id reclaimed). The flow was trashed BEFORE the
        // app, so the app snapshot has no flows — the retried flow restore then
        // recreates it inside the original app, reclaiming the original flow id.
        self::$trash->restore((string) $appRow['id'], $this->userId);
        self::$trash->restore((string) $flowRow['id'], $this->userId);
        $flowsBack = self::$flows->listFlows($this->app1);
        $this->assertCount(1, $flowsBack);
        $this->assertSame('af', $flowsBack[0]['slug']);
        $this->assertSame((string) $flow['id'], (string) $flowsBack[0]['id']);
    }

    // ── 5. consumption + claim ───────────────────────────────────────────────

    public function testRestoreConsumesTheItemAndClaimsAtomically(): void
    {
        self::$trash->trashForm($this->f1, $this->userId);
        $rows = $this->trashRows();
        $trashId = (string) $rows[0]['id'];

        self::$trash->restore($trashId, $this->userId);
        try {
            self::$trash->restore($trashId, $this->userId);
            $this->fail('Expected the second restore to fail');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('not found', $e->getMessage());
        }

        // A claimed ('restoring') item refuses another claim AND delete-forever.
        self::$trash->trashForm($this->f2, $this->userId);
        $rows = $this->trashRows();
        $claimedId = (string) $rows[0]['id'];
        self::$pdo->prepare("UPDATE trash_items SET status = 'restoring', claimed_at = NOW() WHERE id = ?")->execute([$claimedId]);
        try {
            self::$trash->restore($claimedId, $this->userId);
            $this->fail('Expected a conflict on the claimed item');
        } catch (TrashConflictException $e) {
            $this->assertStringContainsString('already being restored', $e->getMessage());
        }
        $this->assertFalse(self::$trash->purgeItem($claimedId, $this->userId));
    }

    // ── 6. empty-draft guard ─────────────────────────────────────────────────

    public function testEmptyDraftDeletesWithoutABinEntry(): void
    {
        $draft = self::$forms->createForm(['title' => 'Empty Draft', 'userId' => $this->userId, 'fields' => []]);
        $result = self::$trash->trashForm((string) $draft['id'], $this->userId);
        $this->assertTrue($result['deleted']);
        $this->assertFalse($result['trashed']);
        $this->assertCount(0, $this->trashRows());
    }

    // ── 7. purge ─────────────────────────────────────────────────────────────

    public function testPurgeExpiredRemovesExpiredItemsAndOrphanZips(): void
    {
        self::$trash->trashForm($this->f1, $this->userId);
        self::$trash->trashForm($this->f2, $this->userId);
        $rows = $this->trashRows();
        $this->assertCount(2, $rows);
        self::$pdo->prepare('UPDATE trash_items SET expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id = ?')
            ->execute([$rows[0]['id']]);

        // An orphan zip (no row) old enough to sweep.
        $orphan = self::$trashDir . '/' . $this->userId . '/orphan-' . bin2hex(random_bytes(4)) . '.zip';
        file_put_contents($orphan, 'zip');
        touch($orphan, time() - 40 * 86400);

        $purged = self::$trash->purgeExpired();
        $this->assertSame(1, $purged['items']);
        $this->assertSame(1, $purged['orphans']);
        $this->assertFileDoesNotExist(self::$trashDir . '/' . $rows[0]['zip_path']);
        $this->assertFileDoesNotExist($orphan);
        $remaining = $this->trashRows();
        $this->assertCount(1, $remaining);
        $this->assertSame($rows[1]['id'], $remaining[0]['id']);
        $this->assertFileExists(self::$trashDir . '/' . $remaining[0]['zip_path']);
    }

    // ── 8. erasure wipes the bin ─────────────────────────────────────────────

    public function testPurgeUserWipesRowsAndZips(): void
    {
        self::$trash->trashForm($this->f1, $this->userId);
        self::$trash->trashApp($this->app1, $this->userId);
        $this->assertCount(2, $this->trashRows());

        $remaining = self::$trash->purgeUser($this->userId);
        $this->assertSame(0, $remaining);
        $this->assertCount(0, $this->trashRows());
        $this->assertDirectoryDoesNotExist(self::$trashDir . '/' . $this->userId);
    }

    // ── 9. pack uninstall pre-capture ────────────────────────────────────────

    public function testPackUninstallCapturesOnlyRecordBearingDeletedForms(): void
    {
        // F1 has records; "Settings" has fields but no records; both in the pack.
        $settings = self::$forms->createForm(['title' => 'Pack Settings', 'userId' => $this->userId, 'fields' => [
            ['id' => 'k', 'type' => 'short_text', 'label' => 'K', 'required' => false],
        ]]);
        $installId = 'inst-' . bin2hex(random_bytes(8));
        self::$pdo->prepare("INSERT INTO pack_installations (id, user_id, pack_id, pack_name, form_ids, app_ids) VALUES (?, ?, 'test-pack', 'Test Pack', ?, '[]')")
            ->execute([$installId, $this->userId, json_encode([$this->f1, (string) $settings['id'], $this->f2])]);

        $pendings = self::$trash->captureRecordBearingForms($installId, $this->userId);
        // F1 and F2 have records; the settings form doesn't.
        $this->assertCount(2, $pendings);

        // The "uninstall" deletes F1 but F2 survives (e.g. shared / skipped).
        self::$forms->deleteForm($this->f1);
        self::$trash->commitCapturedForms($pendings);

        $rows = $this->trashRows();
        $this->assertCount(1, $rows);
        $this->assertSame($this->f1, $rows[0]['original_id']);
        // The survivor's pending zip was discarded, not committed.
        $this->assertNotNull(self::$forms->getForm($this->f2));
    }
}
