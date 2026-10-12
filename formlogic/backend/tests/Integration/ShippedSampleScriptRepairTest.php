<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * The Expense sample app shipped an onSubmit script calling `ctx.addTag`, which the sandbox does
 * not define (it is `ctx.db.addTag`): every expense over 500 was refused, in every account that
 * installed the sample. The sample file is corrected, and a form still holding the script exactly
 * as it shipped is given the corrected one when the schema is brought up to date. A script anyone
 * changed, by so much as a character, is left as it is.
 */
class ShippedSampleScriptRepairTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;

    /** @var string[] */
    private array $formIds = [];
    private string $userId = '';

    private const BROKEN = "function onSubmit(ctx) {\n  // Flag large expenses so approvers can spot them quickly.\n  var amount = Number(ctx.answers.amount);\n  if (amount > 500) {\n    ctx.addTag('high-value');\n  }\n}\n";

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
        if (self::$pdo === null) {
            return;
        }
        foreach ($this->formIds as $id) {
            self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$id]);
        }
        if ($this->userId !== '') {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
        }
    }

    private function formWith(string $script): string
    {
        $id = 'f-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO forms (id, user_id, title, status, logic_script) VALUES (?, ?, 'Expense', 'published', ?)")
            ->execute([$id, $this->userId, $script]);
        $this->formIds[] = $id;
        return $id;
    }

    private function scriptOf(string $formId): ?string
    {
        $stmt = self::$pdo->prepare('SELECT logic_script FROM forms WHERE id = ?');
        $stmt->execute([$formId]);
        $script = $stmt->fetchColumn();
        return $script === false ? null : $script;
    }

    /** The corrected script, as the sample file now ships it. */
    private static function shipped(): string
    {
        $sample = json_decode((string) file_get_contents(dirname(__DIR__, 2) . '/resources/sample-apps/expense.json'), true);
        foreach ($sample['forms'] ?? [] as $form) {
            if (is_string($form['logicScript'] ?? null) && $form['logicScript'] !== '') {
                return $form['logicScript'];
            }
        }
        self::fail('the Expense sample has no script');
    }

    public function testTheSampleNoLongerCallsWhatTheSandboxDoesNotHave(): void
    {
        $this->assertStringContainsString('ctx.db.addTag(', self::shipped());
        $this->assertStringNotContainsString("ctx.addTag(", self::shipped());
    }

    public function testAFormStillHoldingTheBrokenSampleScriptIsGivenTheCorrectedOne(): void
    {
        $broken = $this->formWith(self::BROKEN);
        $edited = $this->formWith(str_replace('500', '750', self::BROKEN));
        // Different in letter case alone, which the column's collation would call equal.
        $recased = $this->formWith(str_replace('Flag large', 'FLAG LARGE', self::BROKEN));
        $other = $this->formWith("function onSubmit(ctx) { ctx.db.addTag('x'); }");

        self::$mysql->repairShippedSampleScripts();

        $this->assertSame(self::shipped(), $this->scriptOf($broken));
        // A script someone changed is theirs, whatever it still calls.
        $this->assertSame(str_replace('500', '750', self::BROKEN), $this->scriptOf($edited));
        $this->assertSame(str_replace('Flag large', 'FLAG LARGE', self::BROKEN), $this->scriptOf($recased));
        $this->assertSame("function onSubmit(ctx) { ctx.db.addTag('x'); }", $this->scriptOf($other));

        // Run again, it changes nothing.
        self::$mysql->repairShippedSampleScripts();
        $this->assertSame(self::shipped(), $this->scriptOf($broken));
    }
}
