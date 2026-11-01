<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * A site begins either from database/schema.sql (the install wizard) or from an empty database the
 * code fills on its first request. Both have to end up with the same columns and indexes, or what a
 * site has depends on how it began. Index names aren't compared: MySQL chooses some of them.
 *
 * MySQLConnection keeps one connection for the process, so each database here is a USE on it.
 */
class SchemaRoutesTest extends TestCase
{
    /** @var array<string,string> */
    private array $config = [];
    private MySQLConnection $mysql;
    private PDO $pdo;
    private string $home = '';
    /** @var string[] */
    private array $databases = [];

    protected function setUp(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        $this->config = [
            'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
            'port' => $_ENV['DB_PORT'] ?? '3306',
            'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
            'username' => $_ENV['DB_USERNAME'] ?? 'root',
            'password' => $_ENV['DB_PASSWORD'] ?? '',
            'charset' => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
        ];
        try {
            $this->mysql = new MySQLConnection($this->config);
            $this->pdo = $this->mysql->getConnection();
            $this->home = (string) $this->pdo->query('SELECT DATABASE()')->fetchColumn();
        } catch (\Throwable $e) {
            $this->markTestSkipped('No test database available');
        }
    }

    protected function tearDown(): void
    {
        if ($this->home === '') {
            return;
        }
        $this->pdo->exec("USE `{$this->home}`");
        foreach ($this->databases as $name) {
            $this->pdo->exec("DROP DATABASE IF EXISTS `{$name}`");
        }
    }

    public function testASiteFromTheInstallerAndOneFromTheCodeAreBuiltTheSame(): void
    {
        $name = $this->createDatabase('installed');
        // What the wizard does: the whole file through one exec, then the first request.
        $import = new PDO(
            "mysql:host={$this->config['host']};port={$this->config['port']};dbname={$name};charset=utf8mb4",
            $this->config['username'],
            $this->config['password'],
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
        );
        $import->exec((string) file_get_contents(dirname(__DIR__, 2) . '/database/schema.sql'));
        unset($import);
        $this->pdo->exec("USE `{$name}`");
        $this->mysql->ensureSchemaCurrent();
        $installed = $this->shape($name);

        $name = $this->createDatabase('code');
        $this->pdo->exec("USE `{$name}`");
        $this->mysql->ensureSchemaCurrent();
        $code = $this->shape($name);

        $this->assertGreaterThan(50, count($code), 'the code built its tables');
        $this->assertSame([], $this->differences($installed, $code));
    }

    public function testAnInstallThatWentWithoutTheIndexesGetsThem(): void
    {
        $name = $this->createDatabase('older');
        $this->pdo->exec("USE `{$name}`");
        $this->mysql->initializeSchema();
        $this->mysql->runMigrations();

        // As every install from the old schema.sql is.
        $this->pdo->exec('ALTER TABLE forms DROP INDEX idx_user_updated');
        $this->pdo->exec('ALTER TABLE api_keys DROP INDEX idx_api_keys_hash, ADD INDEX idx_api_keys_hash (key_hash)');

        // A repeated hash would be a fluke, but it can't be allowed to stop every request.
        $this->pdo->exec('SET FOREIGN_KEY_CHECKS = 0');
        $insert = $this->pdo->prepare(
            "INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, scopes) VALUES (?, 'u', 'n', 'p', 'same', '[]')"
        );
        $insert->execute(['key-1']);
        $insert->execute(['key-2']);
        $this->pdo->exec('SET FOREIGN_KEY_CHECKS = 1');

        $this->mysql->runMigrations();
        $this->assertGreaterThan(0, $this->pdo->query("SHOW INDEX FROM forms WHERE Key_name = 'idx_user_updated'")->rowCount());
        $this->assertSame(1, $this->hashIndexNonUnique(), 'left alone while a hash repeats');

        $this->pdo->exec("DELETE FROM api_keys WHERE id = 'key-2'");
        $this->mysql->runMigrations();
        $this->assertSame(0, $this->hashIndexNonUnique(), 'unique once it can be');

        $this->mysql->runMigrations();
        $this->assertSame(0, $this->hashIndexNonUnique(), 'and nothing changes on the next run');
    }

    public function testAnInstallWhoseRoutingGroupsDiedWithTheirCreatorIsMovedOn(): void
    {
        $name = $this->createDatabase('routing');
        $this->pdo->exec("USE `{$name}`");
        $this->mysql->initializeSchema();
        $this->mysql->runMigrations();

        // As every install before the change is.
        $rule = "SELECT r.DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS r
                 JOIN information_schema.KEY_COLUMN_USAGE k
                   ON k.CONSTRAINT_SCHEMA = r.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = r.CONSTRAINT_NAME
                 WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = 'aokie_companion_routing_groups' AND k.COLUMN_NAME = 'created_by_user_id'";
        $fk = $this->pdo->query(
            "SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aokie_companion_routing_groups' AND COLUMN_NAME = 'created_by_user_id' AND REFERENCED_TABLE_NAME = 'users'"
        )->fetchColumn();
        $this->pdo->exec("ALTER TABLE aokie_companion_routing_groups DROP FOREIGN KEY `{$fk}`");
        $this->pdo->exec('ALTER TABLE aokie_companion_routing_groups MODIFY COLUMN created_by_user_id VARCHAR(36) NOT NULL');
        $this->pdo->exec('ALTER TABLE aokie_companion_routing_groups ADD FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE');
        $this->assertSame('CASCADE', $this->pdo->query($rule)->fetchColumn());

        $this->mysql->runMigrations();

        $this->assertSame('SET NULL', $this->pdo->query($rule)->fetchColumn());
        $column = $this->pdo->query("SHOW COLUMNS FROM aokie_companion_routing_groups LIKE 'created_by_user_id'")->fetch(PDO::FETCH_ASSOC);
        $this->assertSame('YES', $column['Null']);

        $this->mysql->runMigrations();
        $this->assertSame('SET NULL', $this->pdo->query($rule)->fetchColumn(), 'and nothing changes on the next run');
    }

    private function createDatabase(string $label): string
    {
        $name = 'formlogic_schema_' . $label . '_' . bin2hex(random_bytes(4));
        $this->pdo->exec("CREATE DATABASE `{$name}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
        $this->databases[] = $name;
        return $name;
    }

    private function hashIndexNonUnique(): int
    {
        $row = $this->pdo->query("SHOW INDEX FROM api_keys WHERE Key_name = 'idx_api_keys_hash'")->fetch(PDO::FETCH_ASSOC);
        return (int) ($row['Non_unique'] ?? -1);
    }

    /** @return array<string,array{columns:array<string,string>,indexes:string[]}> */
    private function shape(string $name): array
    {
        $shape = [];
        $columns = $this->pdo->prepare(
            'SELECT TABLE_NAME t, COLUMN_NAME c, COLUMN_TYPE ct, IS_NULLABLE n, COLUMN_DEFAULT d, EXTRA e, COLLATION_NAME l
             FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?'
        );
        $columns->execute([$name]);
        foreach ($columns->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $shape[$row['t']]['columns'][$row['c']] = implode(' ', [
                $row['ct'], $row['n'], $row['d'] ?? '(none)', $row['e'], $row['l'] ?? '',
            ]);
            $shape[$row['t']]['indexes'] ??= [];
        }
        $indexes = $this->pdo->prepare(
            "SELECT TABLE_NAME t, MAX(NON_UNIQUE) u, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) c
             FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? GROUP BY TABLE_NAME, INDEX_NAME"
        );
        $indexes->execute([$name]);
        foreach ($indexes->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $shape[$row['t']]['indexes'][] = ((int) $row['u'] === 0 ? 'unique ' : 'index ') . $row['c'];
        }
        return $shape;
    }

    /**
     * @param array<string,array{columns:array<string,string>,indexes:string[]}> $installed
     * @param array<string,array{columns:array<string,string>,indexes:string[]}> $code
     * @return string[]
     */
    private function differences(array $installed, array $code): array
    {
        $found = [];
        foreach (array_unique([...array_keys($installed), ...array_keys($code)]) as $table) {
            if (!isset($installed[$table], $code[$table])) {
                $found[] = "{$table}: only " . (isset($code[$table]) ? 'from the code' : 'from schema.sql');
                continue;
            }
            foreach (array_unique([...array_keys($installed[$table]['columns']), ...array_keys($code[$table]['columns'])]) as $column) {
                $a = $installed[$table]['columns'][$column] ?? '(missing)';
                $b = $code[$table]['columns'][$column] ?? '(missing)';
                if ($a !== $b) {
                    $found[] = "{$table}.{$column}: schema.sql has {$a}, the code has {$b}";
                }
            }
            foreach (array_diff($installed[$table]['indexes'], $code[$table]['indexes']) as $index) {
                $found[] = "{$table}: {$index} only from schema.sql";
            }
            foreach (array_diff($code[$table]['indexes'], $installed[$table]['indexes']) as $index) {
                $found[] = "{$table}: {$index} only from the code";
            }
        }
        return $found;
    }
}
