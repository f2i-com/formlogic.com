<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Models\User;
use FormLogic\Services\EmailService;
use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use PDO;

class AuthService
{
    /**
     * Fixed bcrypt hash used only to spend constant bcrypt time on the
     * unknown-email login path (anti-user-enumeration). Never matches any real
     * password.
     */
    private const DUMMY_PASSWORD_HASH = '$2y$12$PVgkryUdCivISlgtkNpUYeyFZnCn/OYkvLd4bY5OjSkXQO0okymu2';

    /** Maximum length for a user-supplied display name (users.name is VARCHAR(255)). */
    private const MAX_NAME_LENGTH = 255;

    private PDO $mysql;
    private array $jwtConfig;
    private array $rateLimitConfig;
    // Shared, persistent rate-limit store (works across requests/processes).
    private RateLimiter $rateLimiter;
    private ?EmailService $emailService;

    public function __construct(MySQLConnection $mysql, array $jwtConfig, array $rateLimitConfig = [], ?EmailService $emailService = null)
    {
        $this->mysql = $mysql->getConnection();
        $this->jwtConfig = $jwtConfig;
        $this->rateLimitConfig = array_merge([
            'maxAttempts' => 5,           // Max attempts per IP+email combo
            'maxEmailAttempts' => 10,     // Max attempts per email (across all IPs)
            'decayMinutes' => 15,
        ], $rateLimitConfig);
        $this->rateLimiter = new RateLimiter($this->mysql);
        $this->emailService = $emailService;
    }

    /** Rate-limit decay window in seconds. */
    private function decaySeconds(): int
    {
        return (int) $this->rateLimitConfig['decayMinutes'] * 60;
    }

    /**
     * Register a new user.
     *
     * Uses INSERT with duplicate key handling to prevent TOCTOU race conditions
     * where two concurrent registrations with the same email could both succeed
     * if we only checked for existence before inserting.
     */
    public function register(string $email, string $password, ?string $name = null): array
    {
        if ($name !== null && mb_strlen($name) > self::MAX_NAME_LENGTH) {
            throw new \InvalidArgumentException('Name must be ' . self::MAX_NAME_LENGTH . ' characters or fewer.');
        }

        $userId = $this->generateUuid();
        $passwordHash = password_hash($password, PASSWORD_DEFAULT);
        $now = date('Y-m-d H:i:s');

        try {
            $stmt = $this->mysql->prepare("
                INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
                VALUES (:id, :email, :password_hash, :name, :created_at, :updated_at)
            ");

            $stmt->execute([
                'id' => $userId,
                'email' => $email,
                'password_hash' => $passwordHash,
                'name' => $name,
                'created_at' => $now,
                'updated_at' => $now,
            ]);
        } catch (\PDOException $e) {
            // Check for duplicate key error (MySQL error code 1062, SQLSTATE 23000)
            if ($e->getCode() === '23000' || strpos($e->getMessage(), 'Duplicate entry') !== false) {
                throw new \RuntimeException('Unable to create account. Please try a different email address.');
            }
            // Re-throw other database errors
            throw $e;
        }

        $user = $this->getUserById($userId);
        $token = $this->generateToken($user);

        return [
            'user' => $user->toArray(),
            'token' => $token,
        ];
    }

    /**
     * Login a user with brute-force protection.
     *
     * Implements dual rate limiting:
     * 1. Per IP+email combo - prevents single-source attacks
     * 2. Per email only - prevents distributed attacks targeting specific accounts
     *
     * This ensures that even if attackers spoof IPs or use a botnet,
     * they cannot brute-force a specific account indefinitely.
     */
    public function login(string $email, string $password, ?string $ipAddress = null): array
    {
        $rateLimitKey = $this->getRateLimitKey($email, $ipAddress);
        $emailKey = $this->getEmailRateLimitKey($email);

        // Check per-IP+email rate limit
        if ($this->isRateLimited($rateLimitKey)) {
            $remainingSeconds = $this->getRateLimitRemainingSeconds($rateLimitKey);
            throw new \RuntimeException(
                "Too many login attempts. Please try again in " .
                ceil($remainingSeconds / 60) . " minute(s)."
            );
        }

        // Check per-email rate limit (protects against distributed attacks)
        if ($this->isEmailRateLimited($emailKey)) {
            $remainingSeconds = $this->getEmailRateLimitRemainingSeconds($emailKey);
            throw new \RuntimeException(
                "Too many login attempts for this account. Please try again in " .
                ceil($remainingSeconds / 60) . " minute(s)."
            );
        }

        $stmt = $this->mysql->prepare("SELECT * FROM users WHERE email = :email");
        $stmt->execute(['email' => $email]);
        $row = $stmt->fetch();

        if (!$row) {
            // Constant-time guard: run a bcrypt comparison against a fixed dummy
            // hash so the unknown-email path costs the same as the wrong-password
            // path. Without this, response latency leaks whether an email is
            // registered (user enumeration), defeating the generic error message.
            password_verify($password, self::DUMMY_PASSWORD_HASH);
            $this->recordFailedLogin($rateLimitKey, $emailKey);
            throw new \RuntimeException('Invalid email or password');
        }

        if (!password_verify($password, $row['password_hash'])) {
            $this->recordFailedLogin($rateLimitKey, $emailKey);
            throw new \RuntimeException('Invalid email or password');
        }

        // Transparently upgrade hash algorithm/cost if needed
        if (password_needs_rehash($row['password_hash'], PASSWORD_DEFAULT)) {
            $newHash = password_hash($password, PASSWORD_DEFAULT);
            $rehashStmt = $this->mysql->prepare("UPDATE users SET password_hash = :hash WHERE id = :id");
            $rehashStmt->execute(['hash' => $newHash, 'id' => $row['id']]);
        }

        // Clear rate limits on successful login
        $this->clearRateLimit($rateLimitKey);
        $this->clearEmailRateLimit($emailKey);

        $user = User::fromArray($row);
        $token = $this->generateToken($user);

        return [
            'user' => $user->toArray(),
            'token' => $token,
        ];
    }

    /**
     * Get rate limit key combining email and IP
     */
    private function getRateLimitKey(string $email, ?string $ipAddress): string
    {
        // Use both email and IP to prevent both per-account and per-IP attacks
        return hash('sha256', strtolower($email) . '|' . ($ipAddress ?? 'unknown'));
    }

    /**
     * Get rate limit key for email-only limiting (protects against distributed attacks)
     */
    private function getEmailRateLimitKey(string $email): string
    {
        return hash('sha256', 'email_only|' . strtolower($email));
    }

    /**
     * Check if a rate limit key is currently rate limited (IP+email combo)
     */
    private function isRateLimited(string $key): bool
    {
        return $this->rateLimiter->count($key, $this->decaySeconds()) >= $this->rateLimitConfig['maxAttempts'];
    }

    /**
     * Check if an email is rate limited (across all IPs)
     */
    private function isEmailRateLimited(string $emailKey): bool
    {
        return $this->rateLimiter->count($emailKey, $this->decaySeconds()) >= $this->rateLimitConfig['maxEmailAttempts'];
    }

    /**
     * Get remaining seconds until rate limit expires (IP+email combo)
     */
    private function getRateLimitRemainingSeconds(string $key): int
    {
        return $this->rateLimiter->secondsUntilReset($this->decaySeconds());
    }

    /**
     * Get remaining seconds until email rate limit expires
     */
    private function getEmailRateLimitRemainingSeconds(string $emailKey): int
    {
        return $this->rateLimiter->secondsUntilReset($this->decaySeconds());
    }

    /**
     * Record a failed login attempt for both IP+email and email-only tracking
     */
    private function recordFailedLogin(string $key, string $emailKey): void
    {
        $window = $this->decaySeconds();
        $this->rateLimiter->hit($key, $window);
        $this->rateLimiter->hit($emailKey, $window);
    }

    /**
     * Clear rate limit for a key (on successful login)
     */
    private function clearRateLimit(string $key): void
    {
        $this->rateLimiter->clear($key);
    }

    /**
     * Clear email rate limit (on successful login)
     */
    private function clearEmailRateLimit(string $emailKey): void
    {
        $this->rateLimiter->clear($emailKey);
    }

    /**
     * Validate a JWT token and return the user
     *
     * Validates:
     * - Signature (done by Firebase JWT)
     * - Expiry (exp claim, done by Firebase JWT)
     * - Not Before (nbf claim, done by Firebase JWT)
     * - Issuer (iss claim)
     * - Audience (aud claim)
     * - Subject (sub claim - user ID)
     */
    public function validateToken(string $token): ?User
    {
        try {
            // Firebase JWT library automatically validates:
            // - Signature
            // - exp (expiry time) - throws ExpiredException
            // - nbf (not before) - throws BeforeValidException
            // - iat (issued at) - validates it's not in the future
            $decoded = JWT::decode($token, new Key($this->jwtConfig['secret'], $this->jwtConfig['algorithm']));

            // Validate subject exists
            if (!isset($decoded->sub)) {
                return null;
            }

            // Validate issuer (must be present and match)
            $expectedIssuer = $this->jwtConfig['issuer'] ?? 'formlogic';
            if (!isset($decoded->iss) || $decoded->iss !== $expectedIssuer) {
                return null;
            }

            // Validate audience (must be present and match)
            $expectedAudience = $this->jwtConfig['audience'] ?? 'formlogic-api';
            if (!isset($decoded->aud)) {
                return null;
            }
            $audiences = is_array($decoded->aud) ? $decoded->aud : [$decoded->aud];
            if (!in_array($expectedAudience, $audiences, true)) {
                return null;
            }

            // Token revocation: reject tokens issued before the user's credentials
            // changed (token_version bumped). Missing claim is treated as 0 so
            // pre-upgrade tokens remain valid until the next credential change.
            $tokenTv = isset($decoded->tv) ? (int) $decoded->tv : 0;
            if ($tokenTv !== $this->getTokenVersion($decoded->sub)) {
                return null;
            }

            return $this->getUserById($decoded->sub);
        } catch (\Firebase\JWT\ExpiredException $e) {
            // Token has expired
            return null;
        } catch (\Firebase\JWT\BeforeValidException $e) {
            // Token not yet valid (nbf)
            return null;
        } catch (\Firebase\JWT\SignatureInvalidException $e) {
            // Invalid signature
            return null;
        } catch (\Exception $e) {
            // Other JWT errors
            return null;
        }
    }

    /**
     * Get user by ID
     */
    public function getUserById(string $userId): ?User
    {
        $stmt = $this->mysql->prepare("SELECT * FROM users WHERE id = :id");
        $stmt->execute(['id' => $userId]);
        $row = $stmt->fetch();

        if (!$row) {
            return null;
        }

        return User::fromArray($row);
    }

    /**
     * Update user profile
     */
    public function updateUser(string $userId, array $data): ?User
    {
        $updates = [];
        $params = ['id' => $userId];

        if (isset($data['name'])) {
            if (mb_strlen((string) $data['name']) > self::MAX_NAME_LENGTH) {
                throw new \InvalidArgumentException('Name must be ' . self::MAX_NAME_LENGTH . ' characters or fewer.');
            }
            $updates[] = "name = :name";
            $params['name'] = $data['name'];
        }

        if (isset($data['email'])) {
            // Look up the current email + hash so we only re-authenticate when the
            // email is actually changing (profile saves often resend the same email).
            $stmt = $this->mysql->prepare("SELECT email, password_hash FROM users WHERE id = :id");
            $stmt->execute(['id' => $userId]);
            $cur = $stmt->fetch();
            if (!$cur) {
                throw new \RuntimeException('User not found');
            }
            $newEmail = trim((string) $data['email']);
            if (strtolower($newEmail) !== strtolower((string) $cur['email'])) {
                // Validate format
                if (!filter_var($newEmail, FILTER_VALIDATE_EMAIL)) {
                    throw new \RuntimeException('Invalid email address');
                }
                // Require current-password verification before changing the email
                // (a stolen session must not be able to silently take over the account).
                if (!isset($data['currentPassword']) || !password_verify((string) $data['currentPassword'], $cur['password_hash'])) {
                    throw new \RuntimeException('Current password is required to change your email');
                }
                // Check if the new email is taken by another user
                $dup = $this->mysql->prepare("SELECT id FROM users WHERE email = :email AND id != :check_id");
                $dup->execute(['email' => $newEmail, 'check_id' => $userId]);
                if ($dup->fetch()) {
                    throw new \RuntimeException('Unable to update email address');
                }

                $updates[] = "email = :email";
                $params['email'] = $newEmail;
                $bumpTokenVersion = true; // revoke existing sessions on email change
            }
        }

        if (isset($data['password'])) {
            // Require current password verification before allowing change
            if (!isset($data['currentPassword'])) {
                throw new \RuntimeException('Current password is required to set a new password');
            }
            $currentUser = $this->getUserById($userId);
            if (!$currentUser) {
                throw new \RuntimeException('User not found');
            }
            $stmt = $this->mysql->prepare("SELECT password_hash FROM users WHERE id = :id");
            $stmt->execute(['id' => $userId]);
            $row = $stmt->fetch();
            if (!$row || !password_verify($data['currentPassword'], $row['password_hash'])) {
                throw new \RuntimeException('Current password is incorrect');
            }
            $updates[] = "password_hash = :password_hash";
            $params['password_hash'] = password_hash($data['password'], PASSWORD_DEFAULT);
            $bumpTokenVersion = true; // revoke existing sessions on password change
        }

        if (empty($updates)) {
            return $this->getUserById($userId);
        }

        // Revoke all outstanding JWTs when credentials change: token_version is a
        // JWT claim that validateToken() checks against this column.
        if ($bumpTokenVersion ?? false) {
            $updates[] = "token_version = token_version + 1";
        }

        $updates[] = "updated_at = :updated_at";
        $params['updated_at'] = date('Y-m-d H:i:s');

        $sql = "UPDATE users SET " . implode(', ', $updates) . " WHERE id = :id";
        $stmt = $this->mysql->prepare($sql);
        try {
            $stmt->execute($params);
        } catch (\PDOException $e) {
            // Handle UNIQUE constraint violation on email (TOCTOU race condition)
            if (str_contains($e->getMessage(), '1062') || str_contains($e->getMessage(), 'Duplicate entry')) {
                throw new \RuntimeException('Unable to update email address');
            }
            throw $e;
        }

        return $this->getUserById($userId);
    }

    /**
     * Read a user's current token_version. Fails open to 0 if the column hasn't
     * been migrated yet, so un-migrated databases keep authenticating normally.
     */
    private function getTokenVersion(string $userId): int
    {
        try {
            $stmt = $this->mysql->prepare("SELECT token_version FROM users WHERE id = :id");
            $stmt->execute(['id' => $userId]);
            $v = $stmt->fetchColumn();
            return $v === false ? 0 : (int) $v;
        } catch (\Exception $e) {
            return 0; // column not migrated — treat as version 0
        }
    }

    /**
     * Invalidate all of a user's outstanding JWTs by bumping token_version
     * (e.g. on logout = sign out everywhere). Fails open if not yet migrated.
     */
    public function revokeTokens(string $userId): void
    {
        try {
            $stmt = $this->mysql->prepare("UPDATE users SET token_version = token_version + 1 WHERE id = :id");
            $stmt->execute(['id' => $userId]);
        } catch (\Exception $e) {
            // Column not migrated — nothing to bump.
        }
    }

    /**
     * Begin a password reset: issue a single-use, expiring token and email a
     * reset link. Always returns silently (never reveals whether the email
     * exists) to avoid account enumeration. Best-effort email — if no email
     * service is configured the token is still created but undeliverable.
     */
    public function requestPasswordReset(string $email, string $resetUrlBase): void
    {
        $stmt = $this->mysql->prepare("SELECT id, name FROM users WHERE email = :email LIMIT 1");
        $stmt->execute(['email' => trim($email)]);
        $user = $stmt->fetch();
        if (!$user) {
            return; // Don't reveal non-existence.
        }

        // Invalidate any outstanding resets for this user, then issue a new one.
        $this->mysql->prepare("DELETE FROM password_resets WHERE user_id = :uid")
            ->execute(['uid' => $user['id']]);

        $token = bin2hex(random_bytes(32));
        $tokenHash = hash('sha256', $token);
        $expiresAt = date('Y-m-d H:i:s', time() + 3600); // 1 hour

        $this->mysql->prepare("
            INSERT INTO password_resets (id, user_id, token_hash, expires_at)
            VALUES (:id, :uid, :hash, :expires)
        ")->execute([
            'id' => $this->generateUuid(),
            'uid' => $user['id'],
            'hash' => $tokenHash,
            'expires' => $expiresAt,
        ]);

        if ($this->emailService !== null) {
            $link = rtrim($resetUrlBase, '?&') . (str_contains($resetUrlBase, '?') ? '&' : '?') . 'token=' . $token;
            $name = $user['name'] ? htmlspecialchars((string) $user['name'], ENT_QUOTES) : 'there';
            $safeLink = htmlspecialchars($link, ENT_QUOTES);
            $html = "<p>Hi {$name},</p>"
                . "<p>We received a request to reset your FormLogic password. Click the link below to choose a new one. This link expires in 1 hour.</p>"
                . "<p><a href=\"{$safeLink}\">Reset your password</a></p>"
                . "<p>If you didn't request this, you can safely ignore this email.</p>";
            $this->emailService->send((string) $email, 'Reset your FormLogic password', $html);
        }
    }

    /**
     * Complete a password reset using a token from requestPasswordReset.
     * Throws on invalid/expired/used tokens. Bumps token_version to revoke any
     * existing sessions.
     */
    public function resetPassword(string $token, string $newPassword): void
    {
        if (strlen($newPassword) < 8) {
            throw new \InvalidArgumentException('Password must be at least 8 characters');
        }
        $tokenHash = hash('sha256', trim($token));
        $stmt = $this->mysql->prepare("
            SELECT id, user_id FROM password_resets
            WHERE token_hash = :hash AND used_at IS NULL AND expires_at > NOW()
            LIMIT 1
        ");
        $stmt->execute(['hash' => $tokenHash]);
        $row = $stmt->fetch();
        if (!$row) {
            throw new \RuntimeException('This reset link is invalid or has expired.');
        }

        $this->mysql->beginTransaction();
        try {
            $this->mysql->prepare("
                UPDATE users
                SET password_hash = :hash, token_version = token_version + 1, updated_at = :now
                WHERE id = :uid
            ")->execute([
                'hash' => password_hash($newPassword, PASSWORD_DEFAULT),
                'now' => date('Y-m-d H:i:s'),
                'uid' => $row['user_id'],
            ]);
            $this->mysql->prepare("UPDATE password_resets SET used_at = NOW() WHERE id = :id")
                ->execute(['id' => $row['id']]);
            $this->mysql->commit();
        } catch (\Throwable $e) {
            if ($this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            throw $e;
        }
    }

    /**
     * Mint a fresh JWT for a user. Used after a credential change to re-issue the
     * session cookie — the change bumps token_version (revoking old JWTs), so
     * without a fresh token the user would be silently logged out. Reads the
     * current token_version, so call this AFTER updateUser has committed.
     */
    public function issueToken(User $user): string
    {
        return $this->generateToken($user);
    }

    /**
     * Generate a JWT token for a user
     */
    private function generateToken(User $user): string
    {
        $now = time();
        $payload = [
            'iss' => $this->jwtConfig['issuer'] ?? 'formlogic',
            'aud' => $this->jwtConfig['audience'] ?? 'formlogic-api',
            'sub' => $user->id,
            'email' => $user->email,
            'iat' => $now,
            'nbf' => $now, // Not valid before now
            'exp' => $now + $this->jwtConfig['expiry'],
            'tv' => $this->getTokenVersion($user->id), // for revocation on credential change
        ];

        return JWT::encode($payload, $this->jwtConfig['secret'], $this->jwtConfig['algorithm']);
    }

    /**
     * Generate a UUID v4
     */
    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
