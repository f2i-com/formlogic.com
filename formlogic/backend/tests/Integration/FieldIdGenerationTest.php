<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\FormService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * The ids the server gives fields itself, on a real form: a field saved without an id, and a
 * duplicated form's fields. See Unit\FieldIdGenerationTest for the rule. Stored ids, words of the
 * expression language among them, keep saving and are copied as they are.
 */
class FieldIdGenerationTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FormService $forms;

    /** @var string[] */ private array $userIds = [];
    /** @var string[] */ private array $formIds = [];

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
        self::$forms = new FormService($conn, new SQLiteConnection(sys_get_temp_dir() . '/fl-fieldids-' . bin2hex(random_bytes(5))));
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
        foreach ($this->formIds as $formId) {
            self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$formId]);
        }
        foreach ($this->userIds as $userId) {
            self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$userId]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$userId]);
        }
    }

    private function makeUser(): string
    {
        $id = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")->execute([$id, $id . '@test.local']);
        $this->userIds[] = $id;
        return $id;
    }

    /** @param list<array<string,mixed>> $fields */
    private function makeForm(array $fields, ?string $logicScript = null): array
    {
        $form = self::$forms->createForm(['userId' => $this->makeUser(), 'title' => 'Enrolment', 'fields' => $fields, 'logicScript' => $logicScript]);
        $this->formIds[] = (string) $form['id'];
        return $form;
    }

    private static function field(string $label, ?string $id = null, array $extra = []): array
    {
        return $extra + array_filter(['id' => $id, 'type' => 'short_text', 'label' => $label, 'required' => false, 'properties' => []], static fn ($v) => $v !== null);
    }

    /**
     * A field sent without an id got its label's plain slug: a field labelled Class could not be
     * read by any rule, and one labelled Count got 'count', an id the server itself refuses, so the
     * form could not be saved again.
     */
    public function testAFieldSavedWithoutAnIdGetsOneEveryExpressionCanRead(): void
    {
        $form = $this->makeForm([self::field('Class'), self::field('Default'), self::field('2nd address'), self::field('Count'), self::field('Class')]);
        $ids = array_column(self::$forms->getForm((string) $form['id'])['fields'], 'id');
        $this->assertSame(['class_1', 'default_1', '_2nd_address', 'count_1', 'class_2'], $ids);

        // And the form saves again as it is.
        $again = self::$forms->updateForm((string) $form['id'], ['fields' => self::$forms->getForm((string) $form['id'])['fields']]);
        $this->assertSame($ids, array_column($again['fields'], 'id'));
    }

    /** A stored id that is a word of the language (forms made before the editor avoided them) keeps saving. */
    public function testAStoredIdThatIsAWordOfTheLanguageKeepsSavingAndIsNotRenamed(): void
    {
        $form = $this->makeForm([self::field('Class', 'class'), self::field('New', 'new')]);
        $fields = self::$forms->getForm((string) $form['id'])['fields'];
        $fields[] = self::field('Default');
        $saved = self::$forms->updateForm((string) $form['id'], ['fields' => $fields]);
        $this->assertSame(['class', 'new', 'default_1'], array_column($saved['fields'], 'id'));
    }

    /**
     * Duplicating a form names its fields from their labels again, and rewrites every rule and the
     * logic script for each id that changes. A field labelled Class with the id class_1 (as the
     * editor names it) became 'class' in the copy, its rule `class_1 == "5A"` became
     * `class == "5A"`, which does not parse; one labelled New kept 'new' only by luck of the slug.
     * Now an id the label gives is kept, and a new one is one an expression can read; nothing in
     * the script is rewritten for an id that did not change.
     */
    public function testADuplicatedFormKeepsItsIdsAndItsScriptReadsAsBefore(): void
    {
        $script = "function onSubmit(ctx) { const d = new Date(); if (class_1 == '5A' && _1st == 'x') { ctx.reject('no'); } }";
        $form = $this->makeForm([
            self::field('New', 'new'),
            self::field('Class', 'class_1'),
            self::field('Shown when 5A', 'shown', ['conditionalLogic' => ['expression' => 'class_1 == "5A"']]),
            self::field('1st', '_1st'),
        ], $script);

        $copy = self::$forms->duplicateForm((string) $form['id']);
        $this->formIds[] = (string) $copy['id'];
        $copy = self::$forms->getForm((string) $copy['id']);

        $this->assertSame(['new', 'class_1', 'shown_when_5a', '_1st'], array_column($copy['fields'], 'id'));
        $this->assertSame('class_1 == "5A"', $copy['fields'][2]['conditionalLogic']['expression']);
        $this->assertSame($script, $copy['logicScript']);
    }
}
