<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\AuthService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * A password reset ends the API keys, AI connections and link codes the account has, because
 * whoever knew the old password could have made them and they outlive it. A password changed in
 * Settings ended the sessions and left those standing, though it is changed for the same fear.
 * It now ends them too, in one step with the change. (Against a real database:
 * PasswordResetSingleUseTest.)
 */
final class PasswordChangeEndsCredentialsTest extends TestCase
{
    private PDO $db;
    private AuthService $auth;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $create = method_exists($this->db, 'createFunction') ? 'createFunction' : 'sqliteCreateFunction';
        $this->db->$create('NOW', static fn (): string => gmdate('Y-m-d H:i:s'), 0);
        $this->db->exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, name TEXT, timezone TEXT, is_admin INTEGER DEFAULT 0, token_version INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT)');
        $this->db->exec('CREATE TABLE password_resets (id TEXT, user_id TEXT)');
        $this->db->exec('CREATE TABLE api_keys (user_id TEXT, is_active INTEGER DEFAULT 1)');
        $this->db->exec('CREATE TABLE mcp_sessions (user_id TEXT, revoked_at TEXT)');
        $this->db->exec('CREATE TABLE mcp_oauth_refresh_tokens (user_id TEXT, revoked_at TEXT)');
        $this->db->exec('CREATE TABLE mcp_oauth_codes (user_id TEXT, used_at TEXT)');
        $this->db->exec("CREATE TABLE backup_link_codes (owner_user_id TEXT, expires_at TEXT DEFAULT '2999-01-01 00:00:00')");
        $this->db->exec("CREATE TABLE mcp_device_codes (user_id TEXT, status TEXT DEFAULT 'approved', expires_at TEXT)");
        $this->db->exec("CREATE TABLE desktop_link_codes (user_id TEXT, redeemed_at TEXT, expires_at TEXT DEFAULT '2999-01-01 00:00:00')");
        $this->db->exec('CREATE TABLE mfa_trusted_browsers (user_id TEXT)');
        foreach (['user-1', 'user-2'] as $uid) {
            $this->db->prepare('INSERT INTO users (id, email, password_hash, token_version) VALUES (?, ?, ?, 3)')
                ->execute([$uid, $uid . '@example.test', password_hash('OldPass!42abc', PASSWORD_BCRYPT, ['cost' => 4])]);
            $this->db->exec("INSERT INTO api_keys (user_id) VALUES ('{$uid}')");
            $this->db->exec("INSERT INTO mcp_sessions (user_id) VALUES ('{$uid}')");
            $this->db->exec("INSERT INTO mcp_oauth_refresh_tokens (user_id) VALUES ('{$uid}')");
            $this->db->exec("INSERT INTO mcp_oauth_codes (user_id) VALUES ('{$uid}')");
            $this->db->exec("INSERT INTO backup_link_codes (owner_user_id) VALUES ('{$uid}')");
            $this->db->exec("INSERT INTO mcp_device_codes (user_id) VALUES ('{$uid}')");
            $this->db->exec("INSERT INTO desktop_link_codes (user_id) VALUES ('{$uid}')");
            $this->db->exec("INSERT INTO mfa_trusted_browsers (user_id) VALUES ('{$uid}')");
            $this->db->exec("INSERT INTO password_resets (id, user_id) VALUES ('r-{$uid}', '{$uid}')");
        }
        $mysql = $this->createStub(MySQLConnection::class);
        $mysql->method('getConnection')->willReturn($this->db);
        $this->auth = new AuthService($mysql, ['secret' => 'test-secret-test-secret-test-secret!', 'algorithm' => 'HS256', 'issuer' => 't', 'audience' => 't', 'expiry' => 3600]);
    }

    /** @return list<int> what is still good of: API keys, AI sessions, refresh tokens, codes, backup links, device codes, desktop links, remembered browsers */
    private function live(string $uid): array
    {
        $count = fn (string $sql): int => (int) $this->db->query(str_replace(':uid', "'{$uid}'", $sql))->fetchColumn();
        return [
            $count('SELECT COUNT(*) FROM api_keys WHERE is_active = 1 AND user_id = :uid'),
            $count('SELECT COUNT(*) FROM mcp_sessions WHERE revoked_at IS NULL AND user_id = :uid'),
            $count('SELECT COUNT(*) FROM mcp_oauth_refresh_tokens WHERE revoked_at IS NULL AND user_id = :uid'),
            $count('SELECT COUNT(*) FROM mcp_oauth_codes WHERE used_at IS NULL AND user_id = :uid'),
            $count('SELECT COUNT(*) FROM backup_link_codes WHERE expires_at > NOW() AND owner_user_id = :uid'),
            $count("SELECT COUNT(*) FROM mcp_device_codes WHERE status = 'approved' AND user_id = :uid"),
            $count('SELECT COUNT(*) FROM desktop_link_codes WHERE expires_at > NOW() AND user_id = :uid'),
            $count('SELECT COUNT(*) FROM mfa_trusted_browsers WHERE user_id = :uid'),
        ];
    }

    private function tokenVersion(string $uid): int
    {
        return (int) $this->db->query("SELECT token_version FROM users WHERE id = '{$uid}'")->fetchColumn();
    }

    public function testAChangedPasswordEndsWhatTheOldOneCouldHaveMade(): void
    {
        $user = $this->auth->updateUser('user-1', ['password' => 'ChangedPass!42', 'currentPassword' => 'OldPass!42abc']);

        $this->assertSame([0, 0, 0, 0, 0, 0, 0, 0], $this->live('user-1'));
        $this->assertSame([1, 1, 1, 1, 1, 1, 1, 1], $this->live('user-2'), 'another account is untouched');
        $this->assertSame(4, $this->tokenVersion('user-1'), 'the sessions end as they did');
        $this->assertFalse($this->db->inTransaction());
        // Whoever changed it stays signed in: the route gives them a session made after the change.
        $this->assertNotNull($user);
        $this->assertSame('user-1', $this->auth->validateToken($this->auth->issueToken($user))?->id);
    }

    public function testAChangeThatIsNotOfThePasswordEndsNone(): void
    {
        $this->auth->updateUser('user-1', ['name' => 'Renamed', 'timezone' => 'Europe/Paris']);
        // A new address ends the sessions, and nothing says the password was known.
        $this->auth->updateUser('user-1', ['email' => 'moved@example.test', 'currentPassword' => 'OldPass!42abc']);

        $this->assertSame([1, 1, 1, 1, 1, 1, 1, 1], $this->live('user-1'));
        $this->assertSame(4, $this->tokenVersion('user-1'));
    }

    public function testAChangeThatIsRefusedEndsNone(): void
    {
        foreach ([['password' => 'ChangedPass!42', 'currentPassword' => 'not-it'], ['password' => 'ChangedPass!42'], ['password' => 'short', 'currentPassword' => 'OldPass!42abc']] as $refused) {
            try {
                $this->auth->updateUser('user-1', $refused);
                $this->fail('changed the password on ' . json_encode(array_keys($refused)));
            } catch (\RuntimeException | \InvalidArgumentException) {
                $this->assertSame([1, 1, 1, 1, 1, 1, 1, 1], $this->live('user-1'));
                $this->assertSame(3, $this->tokenVersion('user-1'));
            }
        }
    }

    public function testThePasswordStaysAsItWasWhenTheCredentialsCannotBeEnded(): void
    {
        // Half of it must not land: a changed password with the old keys still good is the case
        // this closes, and the account would not be told.
        $this->db->exec('DROP TABLE mcp_sessions');
        try {
            $this->auth->updateUser('user-1', ['password' => 'ChangedPass!42', 'currentPassword' => 'OldPass!42abc']);
            $this->fail('the change went through with its credentials left standing');
        } catch (\PDOException) {
            $this->assertTrue(password_verify('OldPass!42abc', (string) $this->db->query("SELECT password_hash FROM users WHERE id = 'user-1'")->fetchColumn()));
            $this->assertSame(3, $this->tokenVersion('user-1'));
            $this->assertSame(1, (int) $this->db->query("SELECT COUNT(*) FROM api_keys WHERE is_active = 1 AND user_id = 'user-1'")->fetchColumn());
            $this->assertFalse($this->db->inTransaction());
        }
    }
}
