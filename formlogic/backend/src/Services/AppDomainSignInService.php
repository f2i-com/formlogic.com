<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * Signing in to an app on its own domain. Whoever owns a domain controls where its name points, so
 * no password or code is ever typed there: a browser would keep the password for that origin and
 * hand it to whatever the name points at next. The member signs in on the platform and agrees to
 * continue, and gets a one-time code for that app on that host, which the domain exchanges for the
 * session AppDomainSession limits to it. Each sign-in is a row, so leaving ends the session itself.
 */
class AppDomainSignInService
{
    /** A code goes straight from the platform to the domain in one browser. */
    private const CODE_SECONDS = 60;

    private PDO $mysql;

    public function __construct(MySQLConnection $mysql)
    {
        $this->mysql = $mysql->getConnection();
    }

    public function issueCode(string $userId, string $appId, string $host): string
    {
        // Opportunistic hygiene, as with the MFA challenges: dead rows serve nothing.
        $this->mysql->exec(
            'DELETE FROM app_domain_sign_ins
             WHERE (exchanged_at IS NULL AND code_expires_at < NOW()) OR session_expires_at < NOW()'
        );
        $code = bin2hex(random_bytes(32));
        $this->mysql->prepare(
            'INSERT INTO app_domain_sign_ins (id, code_hash, user_id, app_id, host, token_version, code_expires_at)
             SELECT UUID(), :hash, u.id, :app, :host, u.token_version, DATE_ADD(NOW(), INTERVAL :seconds SECOND)
             FROM users u WHERE u.id = :user'
        )->execute(['hash' => hash('sha256', $code), 'user' => $userId, 'app' => $appId, 'host' => $host, 'seconds' => self::CODE_SECONDS]);
        return $code;
    }

    /**
     * Spend a code on the host and app it was issued for. Exactly one caller wins, however the
     * requests race: the conditional update is the gate, as for a password reset. A code dies with
     * the sessions of its day: a sign-out everywhere or a new password ends it too.
     *
     * @return array{id: string, userId: string}|null
     */
    public function exchange(string $code, string $appId, string $host, int $sessionSeconds): ?array
    {
        $hash = hash('sha256', $code);
        $claim = $this->mysql->prepare(
            'UPDATE app_domain_sign_ins s JOIN users u ON u.id = s.user_id
             SET s.exchanged_at = NOW(), s.session_expires_at = DATE_ADD(NOW(), INTERVAL :seconds SECOND)
             WHERE s.code_hash = :hash AND s.app_id = :app AND s.host = :host
               AND s.token_version = u.token_version
               AND s.exchanged_at IS NULL AND s.code_expires_at > NOW()'
        );
        $claim->execute(['seconds' => $sessionSeconds, 'hash' => $hash, 'app' => $appId, 'host' => $host]);
        if ($claim->rowCount() === 0) {
            return null;
        }
        $row = $this->mysql->prepare('SELECT id, user_id FROM app_domain_sign_ins WHERE code_hash = :hash');
        $row->execute(['hash' => $hash]);
        $signIn = $row->fetch(PDO::FETCH_ASSOC);
        return $signIn ? ['id' => (string) $signIn['id'], 'userId' => (string) $signIn['user_id']] : null;
    }

    /** Whether a session from this sign-in is still open. Read for every request it makes. */
    public function isLive(string $id): bool
    {
        $stmt = $this->mysql->prepare(
            'SELECT 1 FROM app_domain_sign_ins WHERE id = :id AND exchanged_at IS NOT NULL AND ended_at IS NULL'
        );
        $stmt->execute(['id' => $id]);
        return $stmt->fetchColumn() !== false;
    }

    public function end(string $id): void
    {
        $this->mysql->prepare('UPDATE app_domain_sign_ins SET ended_at = NOW() WHERE id = :id')->execute(['id' => $id]);
    }
}
