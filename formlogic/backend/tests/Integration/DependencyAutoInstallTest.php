<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\Packages\DependencyChainResolver;
use FormLogic\Services\Packages\InstallPlanService;
use FormLogic\Services\Packages\PackageV2InstallService;
use FormLogic\Services\PackCatalogService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Installing a package brings what it declares it needs.
 *
 * A missing required dependency used to be a refusal naming what to install first — honest while
 * there was nowhere to fetch one FROM, but not actionable. Now the catalog is that source, and
 * the plan says "these, in this order".
 *
 * The properties worth pinning are the ones that keep it from becoming a silent bulk installer:
 * the chain is REVIEWED before anything commits, a dependency's own grants are not granted by
 * approving the package that wanted it, and a chain that cannot be satisfied refuses by NAME.
 */
class DependencyAutoInstallTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static PackageV2InstallService $installer;
    private static InstallPlanService $plans;
    private static PackCatalogService $catalog;

    private string $userId = '';
    private string $publisherId = '';

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
        self::$installer = new PackageV2InstallService($conn);
        self::$plans = new InstallPlanService($conn, self::$installer);
        self::$catalog = new PackCatalogService($conn);
    }

    protected function setUp(): void
    {
        $this->userId = 'dep-' . bin2hex(random_bytes(8));
        $this->publisherId = 'pub-' . bin2hex(random_bytes(8));
        foreach ([$this->userId, $this->publisherId] as $id) {
            self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
                ->execute([$id, $id . '@example.com']);
        }
    }

    protected function tearDown(): void
    {
        foreach ([$this->userId, $this->publisherId] as $id) {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$id]);
        }
    }

    /** @param list<array{id:string,version:string,optional?:bool}> $deps */
    private function aggregate(string $suffix, string $version = '1.0.0', array $deps = []): array
    {
        $id = 'com.dep.' . $suffix;
        $out = [
            'formatVersion' => 2,
            'package' => [
                'id' => $id,
                'kind' => 'extension',
                'version' => $version,
                'publisherId' => 'com.dep',
                'displayName' => 'Dep ' . $suffix,
            ],
            'contributions' => ['flowNodes' => [[
                'schemaVersion' => 1,
                'type' => $id . '.node',
                'version' => '1.0.0',
                'display' => ['label' => 'Node ' . $suffix],
                'handler' => ['kind' => 'core-preset', 'coreType' => 'template', 'defaults' => ['template' => 'x']],
                'sideEffects' => 'none',
            ]]],
        ];
        if ($deps !== []) {
            $out['dependencies'] = ['packages' => $deps];
        }
        return $out;
    }

    /** Publish an aggregate so the chain resolver can find it. */
    private function list(array $aggregate): void
    {
        $meta = $aggregate['package'];
        self::$catalog->publishPack($aggregate, $this->publisherId, [
            'name' => $meta['displayName'] . ' ' . bin2hex(random_bytes(3)),
            'slug' => str_replace('.', '-', $meta['id']) . '-' . bin2hex(random_bytes(4)),
            'visibility' => 'public',
            'version' => $meta['version'],
        ]);
    }

    private function resolver(): DependencyChainResolver
    {
        return new DependencyChainResolver(self::$mysql);
    }

    public function testAMissingDependencyIsPlannedFromTheCatalog(): void
    {
        $base = $this->aggregate('base');
        $this->list($base);
        $top = $this->aggregate('top', '1.0.0', [['id' => 'com.dep.base', 'version' => '^1.0.0']]);

        $chain = $this->resolver()->resolveChain($top, $this->userId);

        $this->assertTrue($chain['ok'], json_encode($chain['problems']));
        $this->assertCount(1, $chain['chain']);
        $this->assertSame('com.dep.base', $chain['chain'][0]['packageId']);
        $this->assertSame(1, $chain['chain'][0]['nodeCount'], 'the review shows what the dependency itself adds');
    }

    public function testTheChainIsOrderedDependenciesFirst(): void
    {
        // top → mid → base. Installing in any other order would fail, so the order IS the answer.
        $base = $this->aggregate('b1');
        $mid = $this->aggregate('m1', '1.0.0', [['id' => 'com.dep.b1', 'version' => '^1.0.0']]);
        $this->list($base);
        $this->list($mid);
        $top = $this->aggregate('t1', '1.0.0', [['id' => 'com.dep.m1', 'version' => '^1.0.0']]);

        $chain = $this->resolver()->resolveChain($top, $this->userId);

        $this->assertTrue($chain['ok'], json_encode($chain['problems']));
        $this->assertSame(
            ['com.dep.b1', 'com.dep.m1'],
            array_column($chain['chain'], 'packageId'),
            'deepest dependency first'
        );
    }

    public function testAnAlreadyInstalledDependencyIsNotPlannedAgain(): void
    {
        $base = $this->aggregate('b2');
        $this->list($base);
        self::$installer->install($base, $this->userId, []);

        $top = $this->aggregate('t2', '1.0.0', [['id' => 'com.dep.b2', 'version' => '^1.0.0']]);
        $chain = $this->resolver()->resolveChain($top, $this->userId);

        $this->assertTrue($chain['ok']);
        $this->assertSame([], $chain['chain'], 'nothing to do — it is already there');
    }

    public function testADiamondBringsTheSharedDependencyOnce(): void
    {
        $shared = $this->aggregate('sh');
        $left = $this->aggregate('l1', '1.0.0', [['id' => 'com.dep.sh', 'version' => '^1.0.0']]);
        $right = $this->aggregate('r1', '1.0.0', [['id' => 'com.dep.sh', 'version' => '^1.0.0']]);
        foreach ([$shared, $left, $right] as $a) {
            $this->list($a);
        }
        $top = $this->aggregate('t3', '1.0.0', [
            ['id' => 'com.dep.l1', 'version' => '^1.0.0'],
            ['id' => 'com.dep.r1', 'version' => '^1.0.0'],
        ]);

        $chain = $this->resolver()->resolveChain($top, $this->userId);

        $this->assertTrue($chain['ok'], json_encode($chain['problems']));
        $ids = array_column($chain['chain'], 'packageId');
        $this->assertSame(1, count(array_keys($ids, 'com.dep.sh', true)), 'the shared dependency appears once');
        // And still before both of the packages that need it.
        $this->assertLessThan(array_search('com.dep.l1', $ids, true), array_search('com.dep.sh', $ids, true));
        $this->assertLessThan(array_search('com.dep.r1', $ids, true), array_search('com.dep.sh', $ids, true));
    }

    public function testAnUnavailableDependencyRefusesByName(): void
    {
        $top = $this->aggregate('t4', '1.0.0', [['id' => 'com.dep.nowhere', 'version' => '^1.0.0']]);
        $chain = $this->resolver()->resolveChain($top, $this->userId);

        $this->assertFalse($chain['ok']);
        $this->assertSame('dependency_unavailable', $chain['problems'][0]['code']);
        $this->assertStringContainsString('com.dep.nowhere', $chain['problems'][0]['message']);
    }

    public function testAnInstalledButIncompatibleDependencyIsNotSilentlyReplaced(): void
    {
        // Replacing a version something else may rely on is an UPDATE, reviewed on its own terms.
        self::$installer->install($this->aggregate('b3', '1.0.0'), $this->userId, []);
        $this->list($this->aggregate('b3', '2.0.0'));
        $top = $this->aggregate('t5', '1.0.0', [['id' => 'com.dep.b3', 'version' => '^2.0.0']]);

        $chain = $this->resolver()->resolveChain($top, $this->userId);

        $this->assertFalse($chain['ok']);
        $this->assertSame('dependency_incompatible', $chain['problems'][0]['code']);
        $this->assertStringContainsString('update it first', $chain['problems'][0]['message']);
    }

    public function testAnAbsentOptionalDependencyIsLeftAlone(): void
    {
        // Optional means the owner chooses. Filling it in for them is not help.
        $this->list($this->aggregate('opt'));
        $top = $this->aggregate('t6', '1.0.0', [['id' => 'com.dep.opt', 'version' => '^1.0.0', 'optional' => true]]);

        $chain = $this->resolver()->resolveChain($top, $this->userId);

        $this->assertTrue($chain['ok']);
        $this->assertSame([], $chain['chain']);
    }

    public function testACycleIsRefusedAndNamed(): void
    {
        // a → b → a. Following it would not terminate; the author needs to see the ring.
        $a = $this->aggregate('cyc-a', '1.0.0', [['id' => 'com.dep.cyc-b', 'version' => '^1.0.0']]);
        $b = $this->aggregate('cyc-b', '1.0.0', [['id' => 'com.dep.cyc-a', 'version' => '^1.0.0']]);
        $this->list($a);
        $this->list($b);

        $chain = $this->resolver()->resolveChain($a, $this->userId);

        $this->assertFalse($chain['ok']);
        $this->assertSame('dependency_cycle', $chain['problems'][0]['code']);
        // Both ends of the ring are named — the author needs to know which two packages.
        $this->assertStringContainsString('com.dep.cyc-a', $chain['problems'][0]['message']);
        $this->assertStringContainsString('com.dep.cyc-b', $chain['problems'][0]['message']);
    }

    public function testProposeShowsTheChainAndConfirmInstallsItInOrder(): void
    {
        $base = $this->aggregate('pb');
        $this->list($base);
        $top = $this->aggregate('pt', '1.0.0', [['id' => 'com.dep.pb', 'version' => '^1.0.0']]);

        $plan = self::$plans->propose($top, $this->userId, 'community', 'json', []);
        // The plan is viable even though the dependency is absent — that is the whole point.
        $this->assertTrue($plan['resolution']['ok'], json_encode($plan['resolution']));
        $this->assertSame(
            [[
                'packageId' => 'com.dep.pb',
                'version' => '1.0.0',
                'displayName' => 'Dep pb',
                'nodeCount' => 1,
                // Provenance the reviewer can judge — same publisher namespace as the package
                // that declared it, which is what makes it an acceptable dependency at all.
                'publisherId' => 'com.dep',
                'trust' => 'community',
            ]],
            $plan['plannedInstalls'],
            'the review names what else this brings, before anything commits'
        );

        $result = self::$plans->confirm($plan['planId'], $this->userId, $plan['planDigest'], []);

        $this->assertSame('com.dep.pt', $result['packageId']);
        $this->assertSame('com.dep.pb', $result['dependenciesInstalled'][0]['packageId'], 'and says what else landed');

        $installed = self::$pdo->prepare('SELECT package_id FROM package_installations WHERE user_id = ? ORDER BY created_at');
        $installed->execute([$this->userId]);
        $this->assertSame(
            ['com.dep.pb', 'com.dep.pt'],
            $installed->fetchAll(PDO::FETCH_COLUMN),
            'dependency first, then the package that wanted it'
        );

        // PKG-105: the edge exists, so the dependency cannot now be uninstalled out from under it.
        $edges = self::$pdo->prepare('SELECT COUNT(*) FROM package_dependency_edges WHERE child_package_id = ?');
        $edges->execute(['com.dep.pb']);
        $this->assertSame(1, (int) $edges->fetchColumn());
    }

    public function testADependencysOwnGrantsAreNotGrantedByApprovingTheTop(): void
    {
        // Approving "install this" is not approving whatever its dependencies ask for.
        $base = $this->aggregate('gb');
        $this->list($base);
        $top = $this->aggregate('gt', '1.0.0', [['id' => 'com.dep.gb', 'version' => '^1.0.0']]);

        $plan = self::$plans->propose($top, $this->userId, 'community', 'json', []);
        self::$plans->confirm($plan['planId'], $this->userId, $plan['planDigest'], ['connector.something.read']);

        $receipt = self::$pdo->prepare('SELECT receipt_json FROM package_installations WHERE user_id = ? AND package_id = ?');
        $receipt->execute([$this->userId, 'com.dep.gb']);
        $decoded = json_decode((string) $receipt->fetchColumn(), true);
        $this->assertSame([], $decoded['approvedConnectorGrants'], 'the dependency was installed with no grants');
    }
    // -- Provenance: who is allowed to satisfy a dependency ---------------------------------

    public function testAThirdPartyCannotSquatAnotherPublishersDependencyId(): void
    {
        // Dependency confusion. publisherId is self-declared and ANY authenticated user can
        // publish, so matching a dependency on package id alone let an attacker publish a
        // squatting listing and have it installed into other people's accounts as a side effect
        // of them installing something unrelated.
        $attacker = 'atk-' . bin2hex(random_bytes(8));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'A')")
            ->execute([$attacker, $attacker . '@example.com']);

        $squat = [
            'formatVersion' => 2,
            'package' => [
                'id' => 'com.victim.lib',
                'kind' => 'extension',
                'version' => '9.9.9',
                'publisherId' => 'com.victim',
                'displayName' => 'Totally The Real Lib',
            ],
            'contributions' => ['flowNodes' => [[
                'schemaVersion' => 1,
                'type' => 'com.victim.lib.evil',
                'version' => '1.0.0',
                'display' => ['label' => 'Evil'],
                'handler' => ['kind' => 'core-preset', 'coreType' => 'template', 'defaults' => ['template' => 'x']],
                'sideEffects' => 'none',
            ]]],
        ];
        self::$catalog->publishPack($squat, $attacker, [
            'name' => 'Squat ' . bin2hex(random_bytes(3)),
            'slug' => 'squat-' . bin2hex(random_bytes(4)),
            'visibility' => 'public',
            'version' => '9.9.9',
        ]);

        $top = [
            'formatVersion' => 2,
            'package' => [
                'id' => 'com.other.app',
                'kind' => 'extension',
                'version' => '1.0.0',
                'publisherId' => 'com.other',
                'displayName' => 'Other App',
            ],
            'dependencies' => ['packages' => [['id' => 'com.victim.lib', 'version' => '^9.0.0']]],
            'contributions' => ['flowNodes' => [[
                'schemaVersion' => 1,
                'type' => 'com.other.app.node',
                'version' => '1.0.0',
                'display' => ['label' => 'Node'],
                'handler' => ['kind' => 'core-preset', 'coreType' => 'template', 'defaults' => ['template' => 'x']],
                'sideEffects' => 'none',
            ]]],
        ];

        $chain = $this->resolver()->resolveChain($top, $this->userId);

        $this->assertFalse($chain['ok'], 'a squatted listing must not satisfy the dependency');
        $this->assertSame('dependency_unavailable', $chain['problems'][0]['code']);
        $this->assertSame([], $chain['chain'], 'and nothing is planned for install');

        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$attacker]);
    }

    public function testAPublisherMaySatisfyItsOwnDependency(): void
    {
        // The legitimate case the provenance rule must not break.
        $this->list($this->aggregate('own-lib'));
        $top = $this->aggregate('own-app', '1.0.0', [['id' => 'com.dep.own-lib', 'version' => '^1.0.0']]);

        $chain = $this->resolver()->resolveChain($top, $this->userId);

        $this->assertTrue($chain['ok'], json_encode($chain['problems']));
        $this->assertSame('com.dep.own-lib', $chain['chain'][0]['packageId']);
        $this->assertSame('com.dep', $chain['chain'][0]['publisherId']);
    }

    public function testACycleThatDoesNotIncludeTheRootIsStillDetected(): void
    {
        // root -> b -> c -> b. An ancestry list keyed on the root alone walks straight past this
        // and reports the plan viable; the install then fails halfway through the chain.
        $this->list($this->aggregate('ring-b', '1.0.0', [['id' => 'com.dep.ring-c', 'version' => '^1.0.0']]));
        $this->list($this->aggregate('ring-c', '1.0.0', [['id' => 'com.dep.ring-b', 'version' => '^1.0.0']]));
        $root = $this->aggregate('ring-root', '1.0.0', [['id' => 'com.dep.ring-b', 'version' => '^1.0.0']]);

        $chain = $this->resolver()->resolveChain($root, $this->userId);

        $this->assertFalse($chain['ok'], 'the ring is below the root, but it is still a ring');
        $this->assertSame('dependency_cycle', $chain['problems'][0]['code']);
    }

    public function testASelfDependencyIsRefused(): void
    {
        $top = $this->aggregate('selfdep', '1.0.0', [['id' => 'com.dep.selfdep', 'version' => '^1.0.0']]);
        $chain = $this->resolver()->resolveChain($top, $this->userId);

        $this->assertFalse($chain['ok']);
        $this->assertSame('dependency_cycle', $chain['problems'][0]['code']);
        $this->assertStringContainsString('itself', $chain['problems'][0]['message']);
    }

    public function testTwoRequirersWithIncompatibleRangesConflict(): void
    {
        // The chain brings ONE version of a shared dependency. If a second requirer cannot work
        // with it that has to surface — previously the second range was simply dropped.
        $this->list($this->aggregate('shared', '1.0.0'));
        $this->list($this->aggregate('shared', '2.0.0'));
        $this->list($this->aggregate('cl', '1.0.0', [['id' => 'com.dep.shared', 'version' => '^1.0.0']]));
        $this->list($this->aggregate('cr', '1.0.0', [['id' => 'com.dep.shared', 'version' => '^2.0.0']]));
        $top = $this->aggregate('ctop', '1.0.0', [
            ['id' => 'com.dep.cl', 'version' => '^1.0.0'],
            ['id' => 'com.dep.cr', 'version' => '^1.0.0'],
        ]);

        $chain = $this->resolver()->resolveChain($top, $this->userId);

        $this->assertFalse($chain['ok'], 'no single version of com.dep.shared satisfies both');
        $this->assertSame('dependency_conflict', $chain['problems'][0]['code']);
    }

    public function testConfirmRefusesAChainStepTheReviewNeverShowed(): void
    {
        // A listing published BETWEEN propose and confirm must not insert itself into an
        // already-approved install: confirm re-resolves, but only ever to SHRINK the chain.
        $this->list($this->aggregate('late-lib'));
        $top = $this->aggregate('late', '1.0.0', [['id' => 'com.dep.late-lib', 'version' => '^1.0.0']]);

        $plan = self::$plans->propose($top, $this->userId, 'community', 'json', []);
        $this->assertCount(1, $plan['plannedInstalls']);

        self::$pdo->prepare("UPDATE package_install_plans SET summary_json = JSON_SET(summary_json, '$.plannedInstalls[0].version', '0.0.1') WHERE id = ?")
            ->execute([$plan['planId']]);

        try {
            self::$plans->confirm($plan['planId'], $this->userId, $plan['planDigest'], []);
            $this->fail('confirm must refuse a chain that differs from the reviewed one');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('plan_chain_changed', $e->getMessage());
        }

        $count = self::$pdo->prepare('SELECT COUNT(*) FROM package_installations WHERE user_id = ?');
        $count->execute([$this->userId]);
        $this->assertSame(0, (int) $count->fetchColumn(), 'and installs nothing at all');
    }

    public function testADependencyKeepsItsOwnTrustNotTheParents(): void
    {
        // Inheriting an 'official' parent's trust would stamp an unsigned dependency as verified
        // in its immutable receipt and walk it past a verified-only workspace policy.
        $this->list($this->aggregate('trust-lib'));
        $top = $this->aggregate('trust-app', '1.0.0', [['id' => 'com.dep.trust-lib', 'version' => '^1.0.0']]);

        $plan = self::$plans->propose($top, $this->userId, 'official', 'json', []);
        self::$plans->confirm($plan['planId'], $this->userId, $plan['planDigest'], []);

        $receipt = self::$pdo->prepare('SELECT receipt_json FROM package_installations WHERE user_id = ? AND package_id = ?');
        $receipt->execute([$this->userId, 'com.dep.trust-lib']);
        $decoded = json_decode((string) $receipt->fetchColumn(), true);
        $this->assertSame('community', $decoded['trust'], 'the dependency keeps its own trust');
    }
}
