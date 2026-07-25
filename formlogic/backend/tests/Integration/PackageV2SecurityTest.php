<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\PackController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FormService;
use FormLogic\Services\Packages\InstallPlanService;
use FormLogic\Services\Packages\PackageV2InstallService;
use FormLogic\Services\Packages\ServiceBindingService;
use FormLogic\Services\PackService;
use FormLogic\Services\SigningService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Response as SlimResponse;

/**
 * SEC-701 (ADR-010): adversarial pass over the Application Package v2 surfaces added across
 * the install-plan / update / binding / receipt work.
 *
 * The property under test throughout is OWNER ISOLATION: every one of these endpoints takes
 * an id from the caller, and each must be indistinguishable-from-missing for anyone but the
 * owner — no data, no existence oracle, no side effect. These are the pins that would catch
 * an ownership predicate being dropped from a WHERE clause during a refactor.
 *
 * Also pinned here: capability cannot be escalated after review (grants are receipt-bound,
 * slots are receipt-bound, contributed types cannot be stolen by another package), and an
 * update cannot silently resurrect a binding the owner never re-approved.
 */
class PackageV2SecurityTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static PackService $packs;
    private static PackageV2InstallService $pkgV2;
    private static ServiceBindingService $bindings;
    private static SigningService $signing;

    private string $ownerId = '';
    private string $attackerId = '';

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-pkgv2sec-' . bin2hex(random_bytes(4)));
        $forms = new FormService($conn, $sqlite);
        $apps = new AppService($conn, $forms);
        self::$packs = new PackService($conn, $forms, $apps, new AppUserService($conn));
        self::$pkgV2 = new PackageV2InstallService($conn);
        self::$bindings = new ServiceBindingService($conn);
        self::$signing = new SigningService($conn);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        foreach (['ownerId', 'attackerId'] as $prop) {
            $this->$prop = 'u-' . bin2hex(random_bytes(12));
            self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
                ->execute([$this->$prop, $this->$prop . '@test.local']);
        }
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        foreach ([$this->ownerId, $this->attackerId] as $id) {
            if ($id !== '') {
                self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$id]);
            }
        }
    }

    /** @param list<array<string,mixed>> $services */
    private function aggregate(string $suffix = 'sec-tools', string $version = '1.0.0', ?array $services = null): array
    {
        $bare = str_replace('-', '', $suffix);
        return [
            'formatVersion' => 2,
            'package' => ['id' => 'com.acme.' . $suffix, 'kind' => 'extension', 'version' => $version, 'publisherId' => 'com.acme', 'displayName' => 'Acme Sec Tools'],
            'contributions' => ['flowNodes' => [[
                'schemaVersion' => 1,
                'type' => 'com.acme.' . $bare . '.generate',
                'version' => '1.0.0',
                'display' => ['label' => 'Generate'],
                'handler' => ['kind' => 'service-action', 'bindingSlot' => 'imageGenerator', 'requiredAction' => 'generate-image'],
                'sideEffects' => 'external-write',
            ]]],
            'requirements' => ['services' => $services ?? [['slot' => 'imageGenerator', 'required' => true, 'requiredActions' => ['generate-image']]]],
        ];
    }

    private function controller(): PackController
    {
        return new PackController(self::$packs, null, null, self::$signing, null, self::$pkgV2, self::$bindings);
    }

    /** @return array{status:int, body:array} */
    private function call(string $method, string $userId, array $args, array $body = []): array
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $userId : null);
        $req->method('getParsedBody')->willReturn($body);
        $req->method('getUploadedFiles')->willReturn([]);
        $out = $this->controller()->$method($req, new SlimResponse(), $args);
        return ['status' => $out->getStatusCode(), 'body' => json_decode((string) $out->getBody(), true) ?: []];
    }

    // ── Owner isolation ─────────────────────────────────────────────────────────────────────

    public function testAnotherUserCannotReadOrMutateAnInstallation(): void
    {
        $installed = self::$pkgV2->install($this->aggregate(), $this->ownerId, ['connector.acme.images']);
        $id = $installed['installationId'];
        self::$bindings->bind($id, $this->ownerId, 'imageGenerator', 'openai-api', 'owner-profile');

        // Every read is indistinguishable from "no such installation" — the receipt (which
        // carries the reviewed grants) and the bindings never leak to another account.
        $this->assertNull(self::$pkgV2->getInstallation($id, $this->attackerId));
        $this->assertNull(self::$bindings->listSlots($id, $this->attackerId));
        $this->assertSame(404, $this->call('getPackageInstallation', $this->attackerId, ['id' => $id])['status']);
        $this->assertSame(404, $this->call('listServiceBindings', $this->attackerId, ['id' => $id])['status']);

        // Writes fail closed AND leave the owner's state untouched.
        $this->assertSame(404, $this->call('putServiceBinding', $this->attackerId, ['id' => $id, 'slot' => 'imageGenerator'], ['definitionId' => 'evil-api', 'connection' => 'attacker-profile'])['status']);
        $this->assertSame(404, $this->call('deleteServiceBinding', $this->attackerId, ['id' => $id, 'slot' => 'imageGenerator'])['status']);
        $this->assertFalse(self::$bindings->unbind($id, $this->attackerId, 'imageGenerator'));
        $this->assertNull(self::$pkgV2->uninstall($id, $this->attackerId));

        $slots = self::$bindings->listSlots($id, $this->ownerId);
        $this->assertSame('openai-api', $slots[0]['binding']['definitionId'], 'the owner’s binding is unchanged');
        $this->assertSame('owner-profile', $slots[0]['binding']['connection']);
        $this->assertNotNull(self::$pkgV2->getInstallation($id, $this->ownerId), 'the installation still exists');

        // The attacker's own view of the world is empty — no cross-account bleed anywhere.
        $this->assertSame([], self::$pkgV2->listInstalled($this->attackerId));
        $this->assertSame([], self::$pkgV2->listDefinitions($this->attackerId));
        $this->assertSame([], self::$bindings->resolvedForOwner($this->attackerId));
    }

    public function testAnotherUserCannotConfirmOrCancelAnInstallPlan(): void
    {
        $plans = new InstallPlanService(self::$mysql, self::$pkgV2);
        $aggregate = $this->aggregate();
        $plan = $plans->propose($aggregate, $this->ownerId, 'community', 'json', \FormLogic\Helpers\PackCapabilities::describeV2($aggregate));

        $this->assertNull($plans->get($plan['planId'], $this->attackerId), 'a foreign plan is invisible');
        $this->assertFalse($plans->cancel($plan['planId'], $this->attackerId));
        try {
            // Even holding the digest (it is returned to whoever proposed) must not help.
            $plans->confirm($plan['planId'], $this->attackerId, $plan['planDigest'], []);
            $this->fail('confirming a foreign plan must refuse');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('plan_not_confirmable', $e->getMessage());
        }

        // The owner's plan survived all of it and still confirms exactly once.
        $this->assertSame('proposed', $plans->get($plan['planId'], $this->ownerId)['state']);
        $result = $plans->confirm($plan['planId'], $this->ownerId, $plan['planDigest'], []);
        $this->assertSame('com.acme.sec-tools', $result['packageId']);
        $count = self::$pdo->prepare('SELECT COUNT(*) FROM package_installations WHERE user_id = ?');
        $count->execute([$this->attackerId]);
        $this->assertSame(0, (int) $count->fetchColumn(), 'nothing installed into the attacker account');
    }

    public function testAnotherUserCannotUpdateOrHijackAnInstalledPackage(): void
    {
        self::$pkgV2->install($this->aggregate(), $this->ownerId, []);

        // The attacker does not have it installed, so "update" is not-installed for them —
        // never a write against the owner's row.
        try {
            self::$pkgV2->update($this->aggregate('sec-tools', '2.0.0'), $this->attackerId, []);
            $this->fail('updating a package another account owns must refuse');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('not_installed', $e->getMessage());
        }
        $stmt = self::$pdo->prepare('SELECT version FROM package_installations WHERE user_id = ? AND package_id = ?');
        $stmt->execute([$this->ownerId, 'com.acme.sec-tools']);
        $this->assertSame('1.0.0', $stmt->fetchColumn(), 'the owner stays on the reviewed version');
    }

    // ── Capability cannot grow after review ────────────────────────────────────────────────

    public function testASlotCannotBeBoundBeyondWhatTheReceiptDeclares(): void
    {
        $installed = self::$pkgV2->install($this->aggregate(), $this->ownerId, []);
        $id = $installed['installationId'];

        // Slots are read from the IMMUTABLE receipt, so a package cannot widen its own reach
        // after the review that approved it.
        foreach (['adminAccess', 'imageGenerator2', '', 'imageGenerator '] as $slot) {
            try {
                self::$bindings->bind($id, $this->ownerId, $slot, 'openai-api', 'c');
                $this->fail("binding undeclared slot '$slot' must refuse");
            } catch (\RuntimeException $e) {
                $this->assertStringContainsString('unknown_slot', $e->getMessage());
            }
        }
        $count = self::$pdo->prepare('SELECT COUNT(*) FROM package_service_bindings WHERE installation_id = ?');
        $count->execute([$id]);
        $this->assertSame(0, (int) $count->fetchColumn());
    }

    public function testAnotherPackageCannotStealAnInstalledContributedType(): void
    {
        self::$pkgV2->install($this->aggregate(), $this->ownerId, []);

        // A second package contributing the SAME type is refused — a later install can never
        // take over the type an existing flow's nodes resolve through.
        $impostor = $this->aggregate('sec-tools-pro');
        $impostor['contributions']['flowNodes'][0]['type'] = 'com.acme.sectools.generate';
        try {
            self::$pkgV2->install($impostor, $this->ownerId, []);
            $this->fail('type takeover must refuse');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('already installed by another package', $e->getMessage());
        }

        // …and the same is true through an UPDATE of a different package.
        self::$pkgV2->install($this->aggregate('other-pkg'), $this->ownerId, []);
        $update = $this->aggregate('other-pkg', '2.0.0');
        $update['contributions']['flowNodes'][0]['type'] = 'com.acme.sectools.generate';
        try {
            self::$pkgV2->update($update, $this->ownerId, []);
            $this->fail('type takeover via update must refuse');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('already installed by another package', $e->getMessage());
        }
        $stmt = self::$pdo->prepare('SELECT installation_id FROM flow_node_definitions WHERE user_id = ? AND node_type = ?');
        $stmt->execute([$this->ownerId, 'com.acme.sectools.generate']);
        $owning = self::$pdo->prepare('SELECT package_id FROM package_installations WHERE id = ?');
        $owning->execute([$stmt->fetchColumn()]);
        $this->assertSame('com.acme.sec-tools', $owning->fetchColumn(), 'the original package still owns the type');
    }

    public function testUpdateDropsBindingsForSlotsTheNewVersionNoLongerDeclares(): void
    {
        $installed = self::$pkgV2->install($this->aggregate(), $this->ownerId, []);
        $id = $installed['installationId'];
        self::$bindings->bind($id, $this->ownerId, 'imageGenerator', 'openai-api', 'owner-profile');

        // v2 drops the slot entirely (its node becomes a core-preset).
        $v2 = $this->aggregate('sec-tools', '2.0.0', []);
        unset($v2['requirements']);
        $v2['contributions']['flowNodes'][0]['handler'] = ['kind' => 'core-preset', 'coreType' => 'template', 'defaults' => ['template' => 'x']];
        self::$pkgV2->update($v2, $this->ownerId, []);

        $count = self::$pdo->prepare('SELECT COUNT(*) FROM package_service_bindings WHERE installation_id = ?');
        $count->execute([$id]);
        $this->assertSame(0, (int) $count->fetchColumn(), 'a binding for a dropped slot is removed, not left invisible');
        $this->assertSame([], self::$bindings->resolvedForOwner($this->ownerId), 'and never reaches the compiler');

        // v3 re-declares the SAME slot name: it must come back UNBOUND, so the owner
        // re-chooses rather than silently inheriting a binding they never re-approved.
        self::$pkgV2->update($this->aggregate('sec-tools', '3.0.0'), $this->ownerId, []);
        $slots = self::$bindings->listSlots($id, $this->ownerId);
        $this->assertSame('imageGenerator', $slots[0]['slot']);
        $this->assertNull($slots[0]['binding'], 'a re-declared slot never resurrects the old binding');
    }

    public function testUpdateKeepsBindingsForSlotsThatSurvive(): void
    {
        $installed = self::$pkgV2->install($this->aggregate(), $this->ownerId, []);
        $id = $installed['installationId'];
        self::$bindings->bind($id, $this->ownerId, 'imageGenerator', 'openai-api', 'owner-profile');

        // A patch release that still declares the slot must NOT force a re-bind.
        self::$pkgV2->update($this->aggregate('sec-tools', '1.1.0'), $this->ownerId, []);
        $slots = self::$bindings->listSlots($id, $this->ownerId);
        $this->assertSame('owner-profile', $slots[0]['binding']['connection'] ?? null);
    }
}
