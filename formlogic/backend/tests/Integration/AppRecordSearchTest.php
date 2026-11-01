<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Constants\AppPermissions;
use FormLogic\Controllers\AppPublicController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppResponseService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Response;

/**
 * Search and sort on an app's record table, through the real controller and real SQLite. Rows are
 * written as old versions wrote them, with every non-ASCII letter escaped: the search has to find
 * those without rewriting them. A member's search reads no row their list wouldn't show them.
 *
 * Skipped unless a test database is reachable.
 */
class AppRecordSearchTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SQLiteConnection $sqlite;
    private static AppPublicController $runtime;
    private static ResponseService $responses;

    /** @var string[] */ private array $userIds = [];
    /** @var string[] */ private array $formIds = [];
    /** @var string[] */ private array $appIds = [];

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
        self::$sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-recordsearch-' . bin2hex(random_bytes(5)));
        $forms = new FormService($conn, self::$sqlite);
        self::$responses = new ResponseService($conn, self::$sqlite);
        self::$runtime = new AppPublicController(
            new AppService($conn, $forms),
            new AppUserService($conn),
            new AppResponseService($conn, self::$sqlite, self::$responses, null, $forms),
            $forms,
            self::$responses,
            $conn,
            self::$sqlite,
            new AppDomainService($conn)
        );
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
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
    }

    private function uuid(): string { return bin2hex(random_bytes(10)); }

    private function makeUser(): string
    {
        $id = 'u' . $this->uuid();
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$id, $id . '@test.local']);
        $this->userIds[] = $id;
        return $id;
    }

    /** @param array<int, array<string, mixed>> $fields */
    private function makeForm(string $ownerId, array $fields): string
    {
        $id = 'form' . $this->uuid();
        self::$pdo->prepare("INSERT INTO forms (id, user_id, title, status) VALUES (?, ?, 'T', 'published')")->execute([$id, $ownerId]);
        $this->formIds[] = $id;
        $db = self::$sqlite->getFormDatabase($id);
        foreach ($fields as $i => $field) {
            $db->prepare('INSERT INTO fields (id, type, label, field_order, properties) VALUES (?, ?, ?, ?, ?)')
                ->execute([$field['id'], $field['type'], $field['label'] ?? $field['id'], $i, json_encode($field['properties'] ?? [])]);
        }
        return $id;
    }

    /** As every version up to now stored answers: bare json_encode. */
    private function insert(string $formId, array $answers, ?string $submittedBy = null, ?string $id = null, string $at = '2026-01-01 00:00:00'): string
    {
        $id ??= 'r' . $this->uuid();
        self::$sqlite->getFormDatabase($formId)
            ->prepare("INSERT INTO responses (id, answers, metadata, status, submitted_at) VALUES (?, ?, ?, 'submitted', ?)")
            ->execute([$id, json_encode($answers), json_encode($submittedBy === null ? [] : ['submittedByUserId' => $submittedBy]), $at]);
        return $id;
    }

    /**
     * @param string[] $formIds
     * @return array{id:string, slug:string}
     */
    private function makeApp(string $ownerId, array $formIds): array
    {
        $id = 'app' . $this->uuid();
        $slug = 'srch' . substr($this->uuid(), 0, 12);
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status, settings) VALUES (?, ?, 'T', ?, 'published', '{}')")
            ->execute([$id, $ownerId, $slug]);
        $this->appIds[] = $id;
        foreach ($formIds as $i => $fid) {
            self::$pdo->prepare("INSERT INTO app_forms (id, app_id, form_id, display_name, sort_order, is_visible, settings) VALUES (?, ?, ?, 'T', ?, 1, '{}')")
                ->execute(['af' . $this->uuid(), $id, $fid, $i]);
        }
        $this->addMember($id, $ownerId, []);
        return ['id' => $id, 'slug' => $slug];
    }

    /** @param list<array{0:?string,1:string}> $grants (formId|null, permission) */
    private function addMember(string $appId, string $userId, array $grants): void
    {
        $role = 'role' . $this->uuid();
        self::$pdo->prepare("INSERT INTO app_roles (id, app_id, name, is_system, sort_order) VALUES (?, ?, ?, 0, 0)")
            ->execute([$role, $appId, 'R' . substr($role, 0, 10)]);
        foreach ($grants as [$formId, $perm]) {
            self::$pdo->prepare("INSERT INTO app_role_permissions (id, role_id, form_id, permission) VALUES (?, ?, ?, ?)")
                ->execute(['arp' . $this->uuid(), $role, $formId, $perm]);
        }
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, 'active', NOW())")
            ->execute(['au' . $this->uuid(), $appId, $userId, $role]);
    }

    /** @return array{total:int, ids:string[], status:int} */
    private function list(array $app, string $formId, string $userId, array $query): array
    {
        $request = $this->createMock(ServerRequestInterface::class);
        $request->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $userId : null);
        $request->method('getQueryParams')->willReturn($query);
        $out = self::$runtime->listResponses($request, new Response(), ['slug' => $app['slug'], 'formId' => $formId]);
        $body = json_decode((string) $out->getBody(), true) ?: [];
        return [
            'status' => $out->getStatusCode(),
            'total' => (int) ($body['total'] ?? -1),
            'ids' => array_column($body['responses'] ?? [], 'id'),
            'names' => array_map(static fn (array $r) => $r['answers']['name'] ?? null, $body['responses'] ?? []),
        ];
    }

    private function namesForm(string $owner): string
    {
        $form = $this->makeForm($owner, [['id' => 't1', 'type' => 'short_text'], ['id' => 'name', 'type' => 'short_text'], ['id' => 'link', 'type' => 'url']]);
        foreach (['Plain', 'José García', 'Иван Петров', '山田太郎', 'Müller café'] as $name) {
            $this->insert($form, ['t1' => $name, 'name' => 'x', 'link' => 'https://example.com/a?b="c"']);
        }
        return $form;
    }

    public function testTheTableInTheReportFindsWhatItShould(): void
    {
        $owner = $this->makeUser();
        $form = $this->namesForm($owner);
        $app = $this->makeApp($owner, [$form]);
        $expected = [
            'Plain' => 1, 'Jos' => 1, 'José' => 1, 'JOSÉ' => 1, 'García' => 1, 'Иван' => 1, 'иван' => 1, '山田' => 1,
            'café' => 1, 'CAFÉ' => 1, 'Müller' => 1, 'https://example.com/a' => 5, '"c"' => 5,
            't1' => 0, 'name' => 0, 'link' => 0,
        ];
        foreach ($expected as $term => $count) {
            $this->assertSame($count, $this->list($app, $form, $owner, ['search' => $term])['total'], "search for {$term}");
        }
    }

    public function testThePageAndTheTotalAgree(): void
    {
        $owner = $this->makeUser();
        $form = $this->makeForm($owner, [['id' => 'name', 'type' => 'short_text']]);
        $ids = [];
        for ($i = 0; $i < 7; $i++) {
            $ids[] = $this->insert($form, ['name' => "Ñandú $i"], null, null, sprintf('2026-01-0%d 00:00:00', $i + 1));
        }
        $this->insert($form, ['name' => 'Other']);
        $app = $this->makeApp($owner, [$form]);

        $page = $this->list($app, $form, $owner, ['search' => 'ñandú', 'limit' => '3', 'offset' => '2']);
        $this->assertSame(7, $page['total']);
        $this->assertSame([$ids[4], $ids[3], $ids[2]], $page['ids'], 'newest first, the third to the fifth');

        $sorted = $this->list($app, $form, $owner, ['search' => 'ñandú', 'limit' => '2', 'sort' => 'name', 'dir' => 'asc']);
        $this->assertSame(['Ñandú 0', 'Ñandú 1'], $sorted['names']);
    }

    public function testChoiceLabelsAreFoundInAnyCase(): void
    {
        $owner = $this->makeUser();
        $options = [['value' => 'option_1', 'label' => 'Crème Brûlée'], ['value' => 'option_2', 'label' => 'Tiramisu']];
        $form = $this->makeForm($owner, [['id' => 'dish', 'type' => 'dropdown', 'properties' => ['options' => $options]]]);
        $this->insert($form, ['dish' => 'option_1']);
        $this->insert($form, ['dish' => 'option_2']);
        $app = $this->makeApp($owner, [$form]);
        $this->assertSame(1, $this->list($app, $form, $owner, ['search' => 'CRÈME'])['total']);
    }

    public function testALinkedRecordIsFoundByTheTextOfTheRecordItNames(): void
    {
        $owner = $this->makeUser();
        $people = $this->makeForm($owner, [['id' => 'name', 'type' => 'short_text']]);
        $ivan = $this->insert($people, ['name' => 'Иван Петров']);
        $ana = $this->insert($people, ['name' => 'Ana']);
        $orders = $this->makeForm($owner, [['id' => 'who', 'type' => 'linked_record', 'properties' => ['targetFormId' => $people]]]);
        $this->insert($orders, ['who' => $ivan]);
        $this->insert($orders, ['who' => $ana]);
        $app = $this->makeApp($owner, [$people, $orders]);

        $this->assertSame(1, $this->list($app, $orders, $owner, ['search' => 'иван'])['total']);
        $this->assertSame([$ivan], self::$responses->findMatchingResponseIds($people, 'ПЕТРОВ'));
        // The id of a field in the linked form is no way to reach its records.
        $this->assertSame([], self::$responses->findMatchingResponseIds($people, 'name'));
    }

    public function testAMemberWhoSeesTheirOwnRowsSearchesOnlyThose(): void
    {
        $owner = $this->makeUser();
        $member = $this->makeUser();
        $form = $this->makeForm($owner, [['id' => 'name', 'type' => 'short_text']]);
        $mine = $this->insert($form, ['name' => 'José'], $member);
        $this->insert($form, ['name' => 'José'], $owner);
        $app = $this->makeApp($owner, [$form]);
        $this->addMember($app['id'], $member, [[$form, AppPermissions::VIEW_OWN_RESPONSES]]);

        $found = $this->list($app, $form, $member, ['search' => 'josé']);
        $this->assertSame(1, $found['total']);
        $this->assertSame([$mine], $found['ids']);
    }

    public function testASearchReadsOnlyWhatTheListWouldHandOver(): void
    {
        $owner = $this->makeUser();
        $member = $this->makeUser();
        $people = $this->makeForm($owner, [['id' => 'name', 'type' => 'short_text']]);
        $theirs = $this->insert($people, ['name' => 'Ñoño secreto'], $owner);
        $orders = $this->makeForm($owner, [['id' => 'who', 'type' => 'linked_record', 'properties' => ['targetFormId' => $people]]]);
        $this->insert($orders, ['who' => $theirs], $member);
        $app = $this->makeApp($owner, [$people, $orders]);
        // Own rows on the order form, nothing on the people form: its text is not theirs to search.
        $this->addMember($app['id'], $member, [[$orders, AppPermissions::VIEW_OWN_RESPONSES]]);

        $this->assertSame(0, $this->list($app, $orders, $member, ['search' => 'secreto'])['total']);
    }

    public function testASortGoesByLetterAcrossThePages(): void
    {
        $owner = $this->makeUser();
        $form = $this->makeForm($owner, [['id' => 'name', 'type' => 'short_text'], ['id' => 'size', 'type' => 'number']]);
        foreach (['zack', 'Adam', 'Émile', 'Ångström', 'Zoë'] as $i => $name) {
            $this->insert($form, ['name' => $name, 'size' => [10, 9, 100, 1, 20][$i]]);
        }
        $app = $this->makeApp($owner, [$form]);

        $this->assertSame(['Adam', 'Ångström', 'Émile', 'zack', 'Zoë'], $this->list($app, $form, $owner, ['sort' => 'name', 'dir' => 'asc'])['names']);
        $this->assertSame(['Zoë', 'zack', 'Émile', 'Ångström', 'Adam'], $this->list($app, $form, $owner, ['sort' => 'name', 'dir' => 'desc'])['names']);
        $this->assertSame(['Émile', 'Ångström'], $this->list($app, $form, $owner, ['sort' => 'name', 'dir' => 'desc', 'limit' => '2', 'offset' => '2'])['names']);
        // Numbers still sort as numbers.
        $this->assertSame(['Ångström', 'Adam', 'zack', 'Zoë', 'Émile'], $this->list($app, $form, $owner, ['sort' => 'size', 'dir' => 'asc'])['names']);
    }

    public function testASearchWithSortOrEqualityFiltersKeepsThemAll(): void
    {
        $owner = $this->makeUser();
        $form = $this->makeForm($owner, [['id' => 'name', 'type' => 'short_text'], ['id' => 'kind', 'type' => 'short_text']]);
        $this->insert($form, ['name' => 'Émile A', 'kind' => 'x']);
        $this->insert($form, ['name' => 'Émile B', 'kind' => 'y']);
        $app = $this->makeApp($owner, [$form]);
        $found = $this->list($app, $form, $owner, ['search' => 'émile', 'answers.kind' => 'y']);
        $this->assertSame(1, $found['total']);
        $this->assertSame(['Émile B'], $found['names']);
    }

    public function testNothingToShowIsNoError(): void
    {
        $owner = $this->makeUser();
        $form = $this->makeForm($owner, [['id' => 'name', 'type' => 'short_text']]);
        $app = $this->makeApp($owner, [$form]);
        $found = $this->list($app, $form, $owner, ['search' => 'anything', 'offset' => '50']);
        $this->assertSame(['status' => 200, 'total' => 0, 'ids' => []], ['status' => $found['status'], 'total' => $found['total'], 'ids' => $found['ids']]);
    }

    public function testASearchPastTheLastPageKeepsTheTotal(): void
    {
        $owner = $this->makeUser();
        $form = $this->makeForm($owner, [['id' => 'name', 'type' => 'short_text']]);
        $this->insert($form, ['name' => 'Ñ']);
        $app = $this->makeApp($owner, [$form]);
        $found = $this->list($app, $form, $owner, ['search' => 'ñ', 'offset' => '50']);
        $this->assertSame(1, $found['total']);
        $this->assertSame([], $found['ids']);
    }
}
