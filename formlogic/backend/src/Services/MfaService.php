<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * Optional TOTP multi-factor authentication (Google Authenticator et al):
 *
 *  - ENROLLMENT: beginSetup() stores a pending secret (mfa_enabled stays 0 —
 *    nothing changes at login until the user PROVES the authenticator works by
 *    submitting a valid code to enable()), which also mints single-use
 *    recovery codes (returned in plaintext exactly once, stored hashed).
 *  - LOGIN: with MFA enabled, the password step alone no longer mints a
 *    session on an UNKNOWN browser — the controller challenges for a code.
 *  - TRUSTED BROWSERS: a successful challenge may remember the browser via a
 *    long-lived random cookie token (hash stored server-side, usage tracked
 *    in last_used_at, listed + revocable in Settings, 60-day expiry).
 */
class MfaService
{
    public const TRUST_COOKIE = 'formlogic_mfa_trust';
    public const TRUST_DAYS = 60;
    private const RECOVERY_CODE_COUNT = 8;
    /** Wrong-code answers allowed per pending challenge before it burns (defence in depth beside the IP rate limit). */
    public const CHALLENGE_MAX_ATTEMPTS = 5;
    /** Bounded retries when a recovery-code consume loses a concurrent compare-and-swap. */
    private const RECOVERY_CAS_RETRIES = 3;

    private PDO $mysql;
    private TotpService $totp;
    private ?AuditService $audit;

    public function __construct(MySQLConnection $mysql, TotpService $totp, ?AuditService $audit = null)
    {
        $this->mysql = $mysql->getConnection();
        $this->totp = $totp;
        $this->audit = $audit;
    }

    public function isEnabled(string $userId): bool
    {
        $stmt = $this->mysql->prepare('SELECT mfa_enabled FROM users WHERE id = :id');
        $stmt->execute(['id' => $userId]);
        return (bool) $stmt->fetchColumn();
    }

    /** Settings payload: enabled state, remaining recovery codes, trusted browsers. */
    public function status(string $userId, ?string $currentTrustToken = null): array
    {
        $stmt = $this->mysql->prepare('SELECT mfa_enabled, mfa_secret, mfa_recovery_codes FROM users WHERE id = :id');
        $stmt->execute(['id' => $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
        $codes = json_decode((string) ($row['mfa_recovery_codes'] ?? '[]'), true);
        $currentHash = $currentTrustToken !== null && $currentTrustToken !== ''
            ? hash('sha256', $currentTrustToken)
            : null;

        $browsers = [];
        $list = $this->mysql->prepare(
            'SELECT id, label, token_hash, created_at, last_used_at, expires_at
             FROM mfa_trusted_browsers WHERE user_id = :id AND expires_at > NOW()
             ORDER BY last_used_at DESC'
        );
        $list->execute(['id' => $userId]);
        foreach ($list->fetchAll(PDO::FETCH_ASSOC) as $b) {
            $browsers[] = [
                'id' => $b['id'],
                'label' => $b['label'],
                'createdAt' => $b['created_at'],
                'lastUsedAt' => $b['last_used_at'],
                'expiresAt' => $b['expires_at'],
                'current' => $currentHash !== null && hash_equals($b['token_hash'], $currentHash),
            ];
        }

        return [
            'enabled' => (bool) ($row['mfa_enabled'] ?? false),
            'pendingSetup' => !($row['mfa_enabled'] ?? false) && !empty($row['mfa_secret']),
            'recoveryCodesRemaining' => is_array($codes) ? count($codes) : 0,
            'trustedBrowsers' => $browsers,
        ];
    }

    /** Start (or restart) enrollment: a fresh pending secret + the otpauth URI to QR. */
    public function beginSetup(string $userId, string $email): array
    {
        $secret = $this->totp->generateSecret();
        $stmt = $this->mysql->prepare('UPDATE users SET mfa_secret = :s, mfa_enabled = 0, mfa_recovery_codes = NULL WHERE id = :id AND mfa_enabled = 0');
        $stmt->execute(['s' => $secret, 'id' => $userId]);
        if ($stmt->rowCount() === 0 && $this->isEnabled($userId)) {
            throw new \RuntimeException('Two-factor authentication is already enabled');
        }
        return ['secret' => $secret, 'uri' => $this->totp->otpauthUri($secret, $email)];
    }

    /**
     * Prove the authenticator works and switch MFA ON. Returns the plaintext
     * recovery codes — shown exactly once, only hashes are stored.
     */
    public function enable(string $userId, string $code): array
    {
        $stmt = $this->mysql->prepare('SELECT mfa_secret, mfa_enabled FROM users WHERE id = :id');
        $stmt->execute(['id' => $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row || empty($row['mfa_secret'])) {
            throw new \RuntimeException('Start the two-factor setup first');
        }
        if ((bool) $row['mfa_enabled']) {
            throw new \RuntimeException('Two-factor authentication is already enabled');
        }
        if (!$this->totp->verify((string) $row['mfa_secret'], $code)) {
            throw new \RuntimeException('That code didn\'t match — check your authenticator app and try again');
        }
        [$plain, $hashes] = $this->mintRecoveryCodes();
        $upd = $this->mysql->prepare('UPDATE users SET mfa_enabled = 1, mfa_recovery_codes = :codes WHERE id = :id');
        $upd->execute(['codes' => json_encode($hashes), 'id' => $userId]);
        return $plain;
    }

    /**
     * Switch MFA off and forget every secret, recovery code, pending login
     * challenge and trusted browser — atomically (audit MFA-001: a partial
     * failure must not leave, say, mfa_enabled=0 with live trusted-browser
     * rows). Bumps token_version in the same statement so every outstanding
     * session, pending-MFA token and remembered device is revoked; callers
     * that want the CURRENT session to survive re-issue its cookie after.
     *
     * Code trust goes with it (RuntimeEngineService): an account verified for the host-JavaScript
     * engine must keep two-factor auth on, so the one place that switches it off — Settings or an
     * admin lockout reset, both of which land here — revokes the verification and clears the
     * account's stored host-js choices in the SAME transaction.
     *
     * $actorId and $ipAddress name who did it, for the revocation's audit row: the account itself
     * from Settings (the default), the acting administrator from a lockout reset. The apps whose
     * host-js choice was cleared are returned so that caller's own audit row can name them too.
     *
     * @return array{affectedApps: list<string>}
     */
    public function disable(string $userId, ?string $actorId = null, ?string $ipAddress = null): array
    {
        $ownsTx = !$this->mysql->inTransaction();
        if ($ownsTx) {
            $this->mysql->beginTransaction();
        }
        try {
            $this->mysql->prepare(
                'UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_recovery_codes = NULL,
                        token_version = token_version + 1 WHERE id = :id'
            )->execute(['id' => $userId]);
            $this->mysql->prepare('DELETE FROM mfa_trusted_browsers WHERE user_id = :id')->execute(['id' => $userId]);
            $this->mysql->prepare('DELETE FROM mfa_challenges WHERE user_id = :id')->execute(['id' => $userId]);
            $affected = $this->revokeCodeTrust($userId, $actorId ?? $userId, $ipAddress);
            if ($ownsTx) {
                $this->mysql->commit();
            }
            return ['affectedApps' => $affected];
        } catch (\Throwable $e) {
            if ($ownsTx && $this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            throw $e;
        }
    }

    /**
     * Revoke code trust because two-factor auth just went away. Nothing happens (and nothing is
     * recorded) for the overwhelmingly common case of an account that was never verified. When it
     * WAS verified, the record is part of the revocation: without an audit service to write it
     * this throws rather than quietly dropping trust with no trace.
     *
     * The user row is read FOR UPDATE: RuntimeEngineService::storeChoice locks the same row before
     * it re-checks the owner's verification, so this revoke and an owner's host-js choice serialise.
     *
     * @return list<string> the apps whose stored host-js choice was cleared
     */
    private function revokeCodeTrust(string $userId, string $actorId, ?string $ipAddress): array
    {
        $stmt = $this->mysql->prepare('SELECT code_trust_verified_at FROM users WHERE id = :id FOR UPDATE');
        $stmt->execute(['id' => $userId]);
        $verifiedAt = $stmt->fetchColumn();
        if (!is_string($verifiedAt) || $verifiedAt === '') {
            return [];
        }
        if ($this->audit === null) {
            throw new \RuntimeException('Code-trust revocation cannot be recorded: no audit service is configured');
        }
        $ids = $this->mysql->prepare('SELECT id FROM apps WHERE owner_id = :id AND client_engine = :e');
        $ids->execute(['id' => $userId, 'e' => RuntimeEngineService::HOST_JS]);
        $affected = array_map('strval', $ids->fetchAll(PDO::FETCH_COLUMN));
        if ($affected !== []) {
            $this->mysql->prepare('UPDATE apps SET client_engine = NULL WHERE owner_id = :id AND client_engine = :e')
                ->execute(['id' => $userId, 'e' => RuntimeEngineService::HOST_JS]);
        }
        $this->mysql->prepare('UPDATE users SET code_trust_verified_at = NULL, code_trust_verified_by = NULL WHERE id = :id')
            ->execute(['id' => $userId]);
        $this->audit->logStrict('user.revoke_code_trust', 'user', $userId, $actorId, $ipAddress, [
            'trigger' => 'mfa_disabled',
            'affectedApps' => $affected,
        ]);
        return $affected;
    }

    // ── One-time login challenges (audit MFA-001) ────────────────────────────

    /**
     * Register the pending token's jti as a one-time server-side challenge.
     * Without a live row the code exchange refuses, so a pending token can
     * never mint more than one session however many times it is replayed.
     */
    public function registerChallenge(string $userId, string $jti, int $ttlSeconds = 300): void
    {
        // Opportunistic hygiene — dead challenges serve nothing.
        $this->mysql->prepare('DELETE FROM mfa_challenges WHERE expires_at <= DATE_SUB(NOW(), INTERVAL 1 HOUR)')->execute();
        $stmt = $this->mysql->prepare(
            'INSERT INTO mfa_challenges (jti_hash, user_id, expires_at)
             VALUES (:hash, :uid, DATE_ADD(NOW(), INTERVAL :ttl SECOND))'
        );
        $stmt->execute(['hash' => hash('sha256', $jti), 'uid' => $userId, 'ttl' => $ttlSeconds]);
    }

    /**
     * Gate one answer attempt against the challenge: false when the challenge
     * is unknown, expired, already consumed, or has burned its attempt budget.
     * The increment is atomic, so parallel guesses share one honest counter.
     */
    public function challengeAttempt(string $jti): bool
    {
        $stmt = $this->mysql->prepare(
            'UPDATE mfa_challenges SET attempts = attempts + 1
             WHERE jti_hash = :hash AND consumed_at IS NULL AND expires_at > NOW() AND attempts < :max'
        );
        $stmt->execute(['hash' => hash('sha256', $jti), 'max' => self::CHALLENGE_MAX_ATTEMPTS]);
        return $stmt->rowCount() > 0;
    }

    /**
     * Atomically claim the challenge after a correct code: exactly ONE caller
     * wins (conditional single-row UPDATE — MySQL serialises the writes), so
     * two parallel exchanges of the same pending token mint one session.
     */
    public function claimChallenge(string $jti): bool
    {
        $stmt = $this->mysql->prepare(
            'UPDATE mfa_challenges SET consumed_at = NOW()
             WHERE jti_hash = :hash AND consumed_at IS NULL AND expires_at > NOW()'
        );
        $stmt->execute(['hash' => hash('sha256', $jti)]);
        return $stmt->rowCount() > 0;
    }

    /**
     * Verify a login challenge answer: a TOTP code, or a single-use recovery
     * code (consumed on success).
     */
    public function verifyChallenge(string $userId, string $code): bool
    {
        $stmt = $this->mysql->prepare('SELECT mfa_secret, mfa_enabled FROM users WHERE id = :id');
        $stmt->execute(['id' => $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row || !(bool) $row['mfa_enabled'] || empty($row['mfa_secret'])) {
            return false;
        }
        if ($this->totp->verify((string) $row['mfa_secret'], $code)) {
            return true;
        }
        // Recovery code path: normalized (case/dash/space-insensitive), single-use.
        $normalized = strtoupper(preg_replace('/[^a-z0-9]/i', '', $code) ?? '');
        if (strlen($normalized) < 8) {
            return false;
        }
        return $this->consumeRecoveryCode($userId, hash('sha256', $normalized));
    }

    /**
     * Single-use recovery-code consumption via compare-and-swap (audit
     * MFA-001): the row is only rewritten when it still holds EXACTLY the
     * JSON we matched against, so two parallel uses of the same code can
     * never both succeed. Losing the swap to a DIFFERENT concurrent change
     * (another code consumed, set regenerated) re-reads and retries within
     * a small bound; the same code twice always fails the re-read.
     */
    private function consumeRecoveryCode(string $userId, string $candidateHash): bool
    {
        for ($try = 0; $try < self::RECOVERY_CAS_RETRIES; $try++) {
            $stmt = $this->mysql->prepare('SELECT mfa_recovery_codes FROM users WHERE id = :id AND mfa_enabled = 1');
            $stmt->execute(['id' => $userId]);
            $current = $stmt->fetchColumn();
            if (!is_string($current) || $current === '') {
                return false;
            }
            $hashes = json_decode($current, true);
            if (!is_array($hashes)) {
                return false;
            }
            $matched = false;
            foreach ($hashes as $i => $h) {
                if (is_string($h) && hash_equals($h, $candidateHash)) {
                    unset($hashes[$i]);
                    $matched = true;
                    break;
                }
            }
            if (!$matched) {
                return false;
            }
            $upd = $this->mysql->prepare(
                'UPDATE users SET mfa_recovery_codes = :new WHERE id = :id AND mfa_recovery_codes = :old AND mfa_enabled = 1'
            );
            $upd->execute(['new' => json_encode(array_values($hashes)), 'id' => $userId, 'old' => $current]);
            if ($upd->rowCount() > 0) {
                return true;
            }
            // Lost the swap — someone rewrote the set between our read and write.
        }
        return false;
    }

    /** Fresh recovery codes (invalidates the old set). Requires a valid current code upstream. */
    public function regenerateRecoveryCodes(string $userId): array
    {
        [$plain, $hashes] = $this->mintRecoveryCodes();
        $this->mysql->prepare('UPDATE users SET mfa_recovery_codes = :codes WHERE id = :id AND mfa_enabled = 1')
            ->execute(['codes' => json_encode($hashes), 'id' => $userId]);
        return $plain;
    }

    // ── Trusted browsers ─────────────────────────────────────────────────────

    /** Remember this browser: returns the RAW cookie token (only its hash is stored). */
    public function mintTrust(string $userId, string $userAgent): string
    {
        // Opportunistic hygiene: expired rows for this user serve nothing and
        // would otherwise accumulate every time a browser is re-remembered.
        $this->mysql->prepare('DELETE FROM mfa_trusted_browsers WHERE user_id = :uid AND expires_at <= NOW()')
            ->execute(['uid' => $userId]);
        $token = bin2hex(random_bytes(32));
        $stmt = $this->mysql->prepare(
            'INSERT INTO mfa_trusted_browsers (id, user_id, token_hash, label, created_at, last_used_at, expires_at)
             VALUES (:id, :uid, :hash, :label, NOW(), NOW(), DATE_ADD(NOW(), INTERVAL :days DAY))'
        );
        $stmt->execute([
            'id' => $this->uuid(),
            'uid' => $userId,
            'hash' => hash('sha256', $token),
            'label' => mb_substr(trim($userAgent) !== '' ? $userAgent : 'Unknown browser', 0, 255),
            'days' => self::TRUST_DAYS,
        ]);
        return $token;
    }

    /** True when the raw cookie token matches a live trust row — and track the use. */
    public function checkTrust(string $userId, ?string $token): bool
    {
        if ($token === null || $token === '' || strlen($token) > 128) {
            return false;
        }
        // SELECT then touch: MySQL's UPDATE rowCount() reports rows CHANGED, so a
        // same-second re-check (last_used_at already NOW()) would read as "no match".
        $stmt = $this->mysql->prepare(
            'SELECT id FROM mfa_trusted_browsers
             WHERE user_id = :uid AND token_hash = :hash AND expires_at > NOW() LIMIT 1'
        );
        $stmt->execute(['uid' => $userId, 'hash' => hash('sha256', $token)]);
        $id = $stmt->fetchColumn();
        if (!is_string($id) || $id === '') {
            return false;
        }
        $this->mysql->prepare('UPDATE mfa_trusted_browsers SET last_used_at = NOW() WHERE id = :id')
            ->execute(['id' => $id]);
        return true;
    }

    /** Revoke one remembered browser (that device re-prompts for a code next login). */
    public function revokeTrust(string $userId, string $trustId): bool
    {
        $stmt = $this->mysql->prepare('DELETE FROM mfa_trusted_browsers WHERE user_id = :uid AND id = :id');
        $stmt->execute(['uid' => $userId, 'id' => $trustId]);
        return $stmt->rowCount() > 0;
    }

    /** @return array{0: string[], 1: string[]} [plaintext codes, sha256 hashes] */
    private function mintRecoveryCodes(): array
    {
        $plain = [];
        $hashes = [];
        for ($i = 0; $i < self::RECOVERY_CODE_COUNT; $i++) {
            // 10 chars from an unambiguous alphabet, shown as XXXXX-XXXXX.
            $raw = '';
            $alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
            for ($c = 0; $c < 10; $c++) {
                $raw .= $alphabet[random_int(0, strlen($alphabet) - 1)];
            }
            $plain[] = substr($raw, 0, 5) . '-' . substr($raw, 5);
            $hashes[] = hash('sha256', $raw);
        }
        return [$plain, $hashes];
    }

    private function uuid(): string
    {
        $d = random_bytes(16);
        $d[6] = chr(ord($d[6]) & 0x0f | 0x40);
        $d[8] = chr(ord($d[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
    }
}
