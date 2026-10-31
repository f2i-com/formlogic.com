<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\MfaService;
use FormLogic\Services\TotpService;
use FormLogic\Services\WebhookService;
use FormLogic\Support\DataEncryption;
use PDO;
use PHPUnit\Framework\TestCase;

/** Two-factor and webhook secrets on disk, and how the key in .env is proved against them. */
final class DataEncryptionSecretsTest extends TestCase
{
    private const KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
    private const OTHER = 'ff0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

    private static ?MySQLConnection $mysql = null;
    private static PDO $pdo;
    private static TotpService $totp;
    private static MfaService $mfa;

    private string $userId = '';
    /** @var array<string, mixed> */
    private array $saved = [];

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
        self::$totp = new TotpService();
        self::$mfa = new MfaService($conn, self::$totp);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        foreach ([DataEncryption::KEY_ENV, DataEncryption::PREVIOUS_KEYS_ENV] as $name) {
            $this->saved[$name] = $_ENV[$name] ?? null;
            unset($_ENV[$name], $_SERVER[$name]);
            putenv($name);
        }
        $_ENV[DataEncryption::KEY_ENV] = self::KEY;
        self::$pdo->exec("DELETE FROM system_meta WHERE meta_key IN ('data_encryption_check', 'data_encryption_last_run')");
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, 'T')")
            ->execute([$this->userId, $this->userId . '@test.local', 'x']);
    }

    protected function tearDown(): void
    {
        if (self::$mysql !== null && $this->userId !== '') {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
            self::$pdo->exec("DELETE FROM system_meta WHERE meta_key IN ('data_encryption_check', 'data_encryption_last_run')");
        }
        foreach ($this->saved as $name => $value) {
            unset($_ENV[$name]);
            if ($value !== null) {
                $_ENV[$name] = $value;
            }
        }
    }

    private function key(?string $key): void
    {
        unset($_ENV[DataEncryption::KEY_ENV]);
        if ($key !== null) {
            $_ENV[DataEncryption::KEY_ENV] = $key;
        }
    }

    private function storedSecret(): ?string
    {
        $stmt = self::$pdo->prepare('SELECT mfa_secret FROM users WHERE id = ?');
        $stmt->execute([$this->userId]);
        $value = $stmt->fetchColumn();
        return is_string($value) ? $value : null;
    }

    private function code(string $secret): string
    {
        return self::$totp->code($secret, intdiv(time(), TotpService::PERIOD));
    }

    private function health(): array
    {
        return DataEncryption::fromEnvironment()->health(self::$pdo);
    }

    public function testTheSecretColumnsAreWideEnough(): void
    {
        foreach ([['users', 'mfa_secret'], ['webhooks', 'secret']] as [$table, $column]) {
            $found = self::$pdo->query("SHOW COLUMNS FROM {$table} LIKE '{$column}'")->fetch(PDO::FETCH_ASSOC);
            self::assertSame('varchar(255)', strtolower((string) $found['Type']), $table);
        }
    }

    public function testTwoFactorWorksWithItsSecretEncrypted(): void
    {
        $setup = self::$mfa->beginSetup($this->userId, 'x@test.local');

        $stored = (string) $this->storedSecret();
        self::assertTrue(DataEncryption::isSealed($stored));
        self::assertStringNotContainsString($setup['secret'], $stored);

        self::$mfa->enable($this->userId, $this->code($setup['secret']));
        self::assertTrue(self::$mfa->verifyChallenge($this->userId, $this->code($setup['secret'])));
    }

    public function testASecretFromBeforeTheKeyStillWorks(): void
    {
        $this->key(null);
        $setup = self::$mfa->beginSetup($this->userId, 'x@test.local');
        self::assertSame($setup['secret'], $this->storedSecret());
        self::$mfa->enable($this->userId, $this->code($setup['secret']));

        $this->key(self::KEY);
        self::assertTrue(self::$mfa->verifyChallenge($this->userId, $this->code($setup['secret'])));
    }

    public function testASecretMovedToAnotherAccountDoesNotOpen(): void
    {
        $setup = self::$mfa->beginSetup($this->userId, 'x@test.local');
        self::$mfa->enable($this->userId, $this->code($setup['secret']));

        $other = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, mfa_enabled, mfa_secret) VALUES (?, ?, 'x', 'T', 1, ?)")
            ->execute([$other, $other . '@test.local', $this->storedSecret()]);
        try {
            self::assertFalse(self::$mfa->verifyChallenge($other, $this->code($setup['secret'])));
        } finally {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$other]);
        }
    }

    public function testALostKeyLeavesRecoveryCodesWorking(): void
    {
        $setup = self::$mfa->beginSetup($this->userId, 'x@test.local');
        $codes = self::$mfa->enable($this->userId, $this->code($setup['secret']));

        $this->key(null);
        self::assertFalse(self::$mfa->verifyChallenge($this->userId, $this->code($setup['secret'])));
        self::assertTrue(self::$mfa->verifyChallenge($this->userId, $codes[0]));
    }

    public function testAPendingSecretThatCannotBeReadAsksForAFreshSetup(): void
    {
        $setup = self::$mfa->beginSetup($this->userId, 'x@test.local');
        $this->key(self::OTHER);

        $this->expectExceptionMessage('Start the two-factor setup first');
        self::$mfa->enable($this->userId, $this->code($setup['secret']));
    }

    public function testAWebhookSecretIsEncryptedAndStillSigns(): void
    {
        $service = new WebhookService(self::$mysql);
        $crypto = DataEncryption::fromEnvironment();
        $form = 'f-' . bin2hex(random_bytes(8));
        self::$pdo->prepare("INSERT INTO forms (id, user_id, title) VALUES (?, ?, 'T')")->execute([$form, $this->userId]);
        // A public address needs no name lookup, so this needs no network.
        $created = $service->createWebhook($form, $this->userId, 'https://93.184.216.34/hook', ['response.created']);
        $id = (string) $created['id'];

        $stored = self::$pdo->prepare('SELECT * FROM webhooks WHERE id = ?');
        $stored->execute([$id]);
        $row = $stored->fetch(PDO::FETCH_ASSOC);
        self::assertTrue(DataEncryption::isSealed($row['secret']), 'a full-length secret survives the column');
        self::assertSame($created['secret'], $crypto->open($row['secret'], 'webhooks.secret:' . $id));

        // Signing goes through the private method every delivery uses.
        $signing = new \ReflectionMethod($service, 'buildDeliveryHandle');
        try {
            $signing->invoke($service, ['id' => 'someone-else'] + $row, 'x', '{}', 'd');
            self::fail('a secret moved to another webhook signed');
        } catch (\RuntimeException $e) {
            self::assertSame('Stored data cannot be read', $e->getMessage());
        } finally {
            self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$form]);
        }
    }

    public function testHealthSaysWhenNoKeyIsSet(): void
    {
        $this->key(null);
        $health = $this->health();
        self::assertTrue($health['ok']);
        self::assertFalse($health['critical']);
        self::assertStringContainsString('DATA_ENCRYPTION_KEY', $health['warning']);
    }

    public function testHealthProvesTheKeyAndNoticesAWrongOne(): void
    {
        $health = $this->health();
        self::assertTrue($health['ok']);
        self::assertStringContainsString('encrypt the server\'s disk', $health['detail']);
        self::assertStringNotContainsString(self::KEY, json_encode($health));

        $this->key(self::OTHER);
        $wrong = $this->health();
        self::assertFalse($wrong['ok']);
        self::assertTrue($wrong['critical']);
    }

    public function testHealthNoticesTheKeyHasGone(): void
    {
        $this->health();
        $this->key(null);
        $gone = $this->health();
        self::assertFalse($gone['ok']);
        self::assertTrue($gone['critical']);
    }

    public function testHealthRefusesAnUnusableKey(): void
    {
        $this->key('too-short');
        self::assertFalse($this->health()['ok']);
    }

    public function testHealthAsksForTheMigrationUntilItHasRun(): void
    {
        self::assertStringContainsString('bin/encrypt-data.php', $this->health()['warning'] ?? '');

        DataEncryption::fromEnvironment()->recordMigrated(self::$pdo);
        $this->key(null);
        $setup = self::$mfa->beginSetup($this->userId, 'x@test.local');
        $this->key(self::KEY);
        self::assertSame($setup['secret'], $this->storedSecret());
        self::assertStringContainsString('bin/encrypt-data.php', $this->health()['warning'] ?? '', 'a plain secret is left');
    }
}
