<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Constants\AppPermissions;
use FormLogic\Controllers\AppController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\FormService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Response as SlimResponse;

/**
 * One-click companion (admin) app over the same data — AppService::createCompanionApp
 * + AppController::createCompanion (POST /api/apps/{id}/companion). Verifies:
 *
 *  - the companion gets ALL the source app's forms attached (SHARED — same form ids,
 *    same nav order + display names, hidden forms included)
 *  - the source app is untouched (apps row, roles, members, theme, domains)
 *  - the companion has its OWN system roles + owner membership + owner perms, and
 *    copies ONLY the theme (not customLogic / customScreen / domains / status)
 *  - name defaulting ('<Source> Admin', 255-char cap) + custom name + blank name
 *  - controller: owner gets 201; a non-owner (and an unknown app id) gets 404 and
 *    no app is created
 *  - a pack-installed form on the source is still attached to the companion
 *
 * Skipped unless a test database is reachable (same setup as AppSharedFormsTest:
 * DB_TEST_DATABASE / DB_HOST / DB_USERNAME / DB_PASSWORD; CI provides MySQL).
 */
class AppCompanionTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static AppService $apps;
    private static AppController $ctrl;

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-companion-' . bin2hex(random_bytes(5)));
        $formService = new FormService($conn, $sqlite);
        self::$apps = new AppService($conn, $formService);
        self::$ctrl = new AppController(self::$apps);
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
            self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$appId]);
        }
        foreach ($this->formIds as $fid) {
            self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$fid]);
        }
        foreach ($this->userIds as $uid) {
            // pack_installations + app_domains cascade with their user / app rows.
            self::$pdo->prepare('DELETE FROM pack_installations WHERE user_id = ?')->execute([$uid]);
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

    private function makeForm(string $ownerId, string $title = 'Form'): string
    {
        $id = 'form-' . $this->uuid();
        self::$pdo->prepare("INSERT INTO forms (id, user_id, title, status) VALUES (?, ?, ?, 'published')")
            ->execute([$id, $ownerId, $title]);
        $this->formIds[] = $id;
        return $id;
    }

    private function makeApp(string $ownerId, string $name, array $extra = []): string
    {
        $app = self::$apps->createApp(array_merge(['name' => $name], $extra), $ownerId);
        $this->appIds[] = $app['id'];
        return $app['id'];
    }

    private function makeCompanion(string $sourceAppId, string $ownerId, ?string $name = null): array
    {
        $companion = self::$apps->createCompanionApp($sourceAppId, $ownerId, $name);
        $this->appIds[] = $companion['id'];
        return $companion;
    }

    /** @return array<int, array<string, mixed>> app_roles rows for an app, sorted by sort_order */
    private function rolesOf(string $appId): array
    {
        $stmt = self::$pdo->prepare('SELECT id, name, is_system, sort_order FROM app_roles WHERE app_id = ? ORDER BY sort_order ASC');
        $stmt->execute([$appId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /** @return array<int, array<string, mixed>> app_users rows for an app */
    private function membersOf(string $appId): array
    {
        $stmt = self::$pdo->prepare('SELECT user_id, role_id, status FROM app_users WHERE app_id = ? ORDER BY user_id ASC');
        $stmt->execute([$appId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /** @return array{status:int, body:array} */
    private function callCreateCompanion(?string $userId, string $appId, array $body = []): array
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $userId : null);
        $req->method('getParsedBody')->willReturn($body);
        $out = self::$ctrl->createCompanion($req, new SlimResponse(), ['id' => $appId]);
        return ['status' => $out->getStatusCode(), 'body' => json_decode((string) $out->getBody(), true) ?: []];
    }

    // -------------------------------------------------------------------------
    // Shared form attachment
    // -------------------------------------------------------------------------

    public function testCompanionGetsAllSourceFormsAttachedSharedBySameFormIds(): void
    {
        $owner = $this->makeUser();
        $formA = $this->makeForm($owner, 'Jobs');
        $formB = $this->makeForm($owner, 'Vehicles');
        $formC = $this->makeForm($owner, 'Incidents');
        $source = $this->makeApp($owner, 'MineCab');

        self::$apps->addFormToApp($source, $formA, 'Job Sheet');
        self::$apps->addFormToApp($source, $formB); // default display name = form title
        self::$apps->addFormToApp($source, $formC);
        // Hidden in the source app — an admin console still needs it.
        self::$apps->updateAppForm($source, $formC, ['isVisible' => false]);

        $companion = $this->makeCompanion($source, $owner);

        $sourceForms = self::$apps->getAppForms($source);
        $companionForms = self::$apps->getAppForms($companion['id']);

        // SAME form ids (shared data — responses live in per-form SQLite keyed by
        // form_id), same nav order, same display names.
        $this->assertSame(
            array_column($sourceForms, 'formId'),
            array_column($companionForms, 'formId'),
            'companion must contain ALL source forms, in the source order'
        );
        $this->assertSame(
            array_column($sourceForms, 'displayName'),
            array_column($companionForms, 'displayName')
        );
        $this->assertSame('Job Sheet', $companionForms[0]['displayName']);
        $this->assertSame([0, 1, 2], array_column($companionForms, 'sortOrder'));

        // The join rows are the companion's OWN (fresh ids) — only the form_id is shared.
        $this->assertEmpty(array_intersect(array_column($sourceForms, 'id'), array_column($companionForms, 'id')));

        // The form hidden in the source IS attached (visible — admin consoles see everything).
        $hidden = null;
        foreach ($companionForms as $f) {
            if ($f['formId'] === $formC) {
                $hidden = $f;
            }
        }
        $this->assertNotNull($hidden, 'form hidden in the source app must still be attached');
        $this->assertTrue($hidden['isVisible']);
    }

    public function testCompanionOfAppWithPackInstalledFormStillAttachesIt(): void
    {
        $owner = $this->makeUser();
        $packForm = $this->makeForm($owner, 'Pack Form');
        $source = $this->makeApp($owner, 'Salon');
        self::$apps->addFormToApp($source, $packForm);

        // Record the form as pack-installed (the UI hides pack forms from the manual
        // attach picker, but the companion flow must copy them regardless).
        self::$pdo->prepare("INSERT INTO pack_installations (id, user_id, pack_id, pack_name, form_ids, app_ids) VALUES (?, ?, 'salon-pack', 'Salon Pack', ?, ?)")
            ->execute(['pi-' . $this->uuid(), $owner, json_encode([$packForm]), json_encode([$source])]);

        $companion = $this->makeCompanion($source, $owner);
        $this->assertContains(
            $packForm,
            array_column(self::$apps->getAppForms($companion['id']), 'formId'),
            'pack-installed form must be attached to the companion'
        );
    }

    // -------------------------------------------------------------------------
    // Source untouched / companion isolation
    // -------------------------------------------------------------------------

    public function testSourceAppIsUntouchedIncludingRolesMembersThemeAndDomains(): void
    {
        $owner = $this->makeUser();
        $member = $this->makeUser();
        $formId = $this->makeForm($owner);
        $source = $this->makeApp($owner, 'Client App', ['theme' => ['primaryColor' => '#123456'], 'status' => 'published']);
        self::$apps->addFormToApp($source, $formId);

        // Extra member on the source (must NOT be copied to the companion).
        $memberRole = $this->rolesOf($source)[2]['id']; // 'Member' system role
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, 'active', NOW())")
            ->execute(['au-' . $this->uuid(), $source, $member, $memberRole]);

        // A verified custom domain on the source (must NOT move or be copied).
        $domainId = 'dom-' . $this->uuid();
        self::$pdo->prepare("INSERT INTO app_domains (id, app_id, owner_id, domain, normalized_domain, verification_token) VALUES (?, ?, ?, 'ops.example.com', ?, 'tok')")
            ->execute([$domainId, $source, $owner, 'ops-' . $this->uuid() . '.example.com']);

        $rowBefore = self::$pdo->prepare('SELECT * FROM apps WHERE id = ?');
        $rowBefore->execute([$source]);
        $sourceRowBefore = $rowBefore->fetch(PDO::FETCH_ASSOC);
        $rolesBefore = $this->rolesOf($source);
        $membersBefore = $this->membersOf($source);

        $companion = $this->makeCompanion($source, $owner);

        // The source apps row is byte-for-byte identical (name, slug, status, theme,
        // settings, custom_*, timestamps — everything).
        $rowAfter = self::$pdo->prepare('SELECT * FROM apps WHERE id = ?');
        $rowAfter->execute([$source]);
        $this->assertSame($sourceRowBefore, $rowAfter->fetch(PDO::FETCH_ASSOC), 'source apps row must be untouched');

        $this->assertSame($rolesBefore, $this->rolesOf($source), 'source roles must be untouched');
        $this->assertSame($membersBefore, $this->membersOf($source), 'source members must be untouched');

        // The domain stays on the source; the companion has none.
        $domStmt = self::$pdo->prepare('SELECT app_id FROM app_domains WHERE id = ?');
        $domStmt->execute([$domainId]);
        $this->assertSame($source, $domStmt->fetchColumn());
        $companionDoms = self::$pdo->prepare('SELECT COUNT(*) FROM app_domains WHERE app_id = ?');
        $companionDoms->execute([$companion['id']]);
        $this->assertSame(0, (int) $companionDoms->fetchColumn(), 'companion must not inherit domains');

        // The source's extra member is NOT a member of the companion.
        $this->assertNotContains($member, array_column($this->membersOf($companion['id']), 'user_id'));

        // Theme copied for brand continuity; status/customScreen/customLogic are the companion's own.
        $this->assertSame(['primaryColor' => '#123456'], $companion['theme']);
        $this->assertSame('draft', $companion['status'], 'companion starts as a draft even when the source is published');
        $this->assertNotSame($sourceRowBefore['slug'], $companion['slug'], 'companion gets a fresh slug');
    }

    public function testCompanionDoesNotCopyCustomLogicOrCustomScreen(): void
    {
        $owner = $this->makeUser();
        $source = $this->makeApp($owner, 'Logic App');
        self::$pdo->prepare("UPDATE apps SET custom_screen = ?, custom_logic = ? WHERE id = ?")
            ->execute([json_encode(['enabled' => true, 'html' => '<div>x</div>']), json_encode(['version' => 1, 'source' => 'export function onScreenEnter(){}']), $source]);

        $companion = $this->makeCompanion($source, $owner);

        $this->assertSame([], $companion['customScreen'], 'customScreen must not be copied');
        $this->assertSame([], $companion['customLogic'], 'customLogic must not be copied');
    }

    // -------------------------------------------------------------------------
    // Companion's own roles + owner membership
    // -------------------------------------------------------------------------

    public function testCompanionHasItsOwnSystemRolesAndOwnerMembership(): void
    {
        $owner = $this->makeUser();
        $source = $this->makeApp($owner, 'Client App');

        $companion = $this->makeCompanion($source, $owner);

        $sourceRoles = $this->rolesOf($source);
        $companionRoles = $this->rolesOf($companion['id']);

        $this->assertSame(['Owner', 'Admin', 'Member'], array_column($companionRoles, 'name'));
        foreach ($companionRoles as $role) {
            $this->assertSame(1, (int) $role['is_system']);
        }
        $this->assertEmpty(
            array_intersect(array_column($sourceRoles, 'id'), array_column($companionRoles, 'id')),
            'companion roles are fresh rows, not shared with the source'
        );

        // Owner membership: active, on the companion's OWN Owner role.
        $members = $this->membersOf($companion['id']);
        $this->assertCount(1, $members);
        $this->assertSame($owner, $members[0]['user_id']);
        $this->assertSame('active', $members[0]['status']);
        $this->assertSame($companionRoles[0]['id'], $members[0]['role_id']);

        // Owner role carries the full permission grant (createApp's grantAllPermissions).
        $perms = self::$pdo->prepare('SELECT COUNT(*) FROM app_role_permissions WHERE role_id = ?');
        $perms->execute([$companionRoles[0]['id']]);
        $this->assertSame(count(AppPermissions::ALL), (int) $perms->fetchColumn());
    }

    // -------------------------------------------------------------------------
    // Name defaulting
    // -------------------------------------------------------------------------

    public function testNameDefaultsToSourceAdminAndAcceptsACustomName(): void
    {
        $owner = $this->makeUser();
        $source = $this->makeApp($owner, 'MineCab');

        $defaulted = $this->makeCompanion($source, $owner);
        $this->assertSame('MineCab Admin', $defaulted['name']);

        $blank = $this->makeCompanion($source, $owner, '   ');
        $this->assertSame('MineCab Admin', $blank['name'], 'whitespace-only name falls back to the default');

        $custom = $this->makeCompanion($source, $owner, 'Back Office');
        $this->assertSame('Back Office', $custom['name']);

        // Each companion is a distinct app with a distinct slug.
        $slugs = [$defaulted['slug'], $blank['slug'], $custom['slug']];
        $this->assertSame($slugs, array_values(array_unique($slugs)));
    }

    public function testDefaultNameIsCappedAtTheColumnWidth(): void
    {
        $owner = $this->makeUser();
        $longName = str_repeat('A', 252); // + ' Admin' would be 258 chars > VARCHAR(255)
        $source = $this->makeApp($owner, $longName);

        $companion = $this->makeCompanion($source, $owner);
        $this->assertSame(255, mb_strlen($companion['name']));
        $this->assertStringStartsWith($longName, $companion['name']);
    }

    public function testUnknownSourceAppThrows(): void
    {
        $owner = $this->makeUser();
        $this->expectException(\RuntimeException::class);
        self::$apps->createCompanionApp('nope-' . $this->uuid(), $owner);
    }

    // -------------------------------------------------------------------------
    // Controller boundary (POST /api/apps/{id}/companion)
    // -------------------------------------------------------------------------

    public function testControllerOwnerGets201WithTheCompanionApp(): void
    {
        $owner = $this->makeUser();
        $formId = $this->makeForm($owner);
        $source = $this->makeApp($owner, 'Client App');
        self::$apps->addFormToApp($source, $formId);

        $r = $this->callCreateCompanion($owner, $source, ['name' => 'Ops Console']);
        if (isset($r['body']['app']['id'])) {
            $this->appIds[] = $r['body']['app']['id'];
        }

        $this->assertSame(201, $r['status']);
        $this->assertSame('Ops Console', $r['body']['app']['name'] ?? null);
        $this->assertSame($owner, $r['body']['app']['ownerId'] ?? null);
        $this->assertContains(
            $formId,
            array_column(self::$apps->getAppForms($r['body']['app']['id']), 'formId')
        );
    }

    public function testControllerNonOwnerGets404AndNoAppIsCreated(): void
    {
        $owner = $this->makeUser();
        $stranger = $this->makeUser();
        $source = $this->makeApp($owner, 'Client App');

        $countApps = function () use ($owner, $stranger): int {
            $stmt = self::$pdo->prepare('SELECT COUNT(*) FROM apps WHERE owner_id IN (?, ?)');
            $stmt->execute([$owner, $stranger]);
            return (int) $stmt->fetchColumn();
        };
        $before = $countApps();

        $r = $this->callCreateCompanion($stranger, $source);
        $this->assertSame(404, $r['status'], 'a non-owner must get 404, not 403 (no existence leak)');
        $this->assertTrue($r['body']['error'] ?? false);
        $this->assertSame($before, $countApps(), 'no companion app row may be created');

        // Unauthenticated + unknown app id are the same 404 boundary.
        $this->assertSame(404, $this->callCreateCompanion(null, $source)['status']);
        $this->assertSame(404, $this->callCreateCompanion($owner, 'nope-' . $this->uuid())['status']);
    }
}
