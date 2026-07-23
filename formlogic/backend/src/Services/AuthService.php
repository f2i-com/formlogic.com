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
    public const MIN_PASSWORD_LENGTH = 10;

    /**
     * Password-reset request cap, keyed per submitted email string. Deliberately a much
     * longer window than login's 15-minute decay: legitimate reset requests are rare, and
     * this exists to stop an attacker email-bombing one address, not to tolerate retries.
     */
    private const PASSWORD_RESET_MAX_ATTEMPTS = 4;
    private const PASSWORD_RESET_DECAY_SECONDS = 3600; // 1 hour

    /**
     * Validate password strength. Returns a human-readable error, or null if acceptable.
     * Used at both registration and password reset so the rules stay in one place.
     */
    public static function passwordError(string $password): ?string
    {
        if (strlen($password) < self::MIN_PASSWORD_LENGTH) {
            return 'Password must be at least ' . self::MIN_PASSWORD_LENGTH . ' characters';
        }
        $common = [
            'password', 'password1', 'passw0rd', '1234567890', '12345678', '123456789',
            'qwertyuiop', 'qwerty123', 'iloveyou', 'letmein123', 'changeme', 'admin123',
        ];
        if (in_array(strtolower($password), $common, true)) {
            return 'That password is too common — please choose a less guessable one';
        }
        return null;
    }

    private PDO $mysql;
    private array $jwtConfig;
    private array $rateLimitConfig;
    // Shared, persistent rate-limit store (works across requests/processes).
    private RateLimiter $rateLimiter;
    private ?EmailService $emailService;
    private int $signupFreeDays = 30;
    /** Lowercased bootstrap addresses reserved from public registration. */
    private array $adminEmails = [];
    /** Per-request memo of the global session epoch (system_meta 'session_epoch'). */
    private ?int $sessionEpochCache = null;
    private ?int $sessionGenerationCache = null;

    public function __construct(MySQLConnection $mysql, array $jwtConfig, array $rateLimitConfig = [], ?EmailService $emailService = null, int $signupFreeDays = 30, array $adminEmails = [])
    {
        $this->mysql = $mysql->getConnection();
        $this->jwtConfig = $jwtConfig;
        $this->signupFreeDays = max(1, $signupFreeDays);
        $this->rateLimitConfig = array_merge([
            'maxAttempts' => 5,           // Max attempts per IP+email combo
            'maxEmailAttempts' => 10,     // Max attempts per email (across all IPs)
            'decayMinutes' => 15,
        ], $rateLimitConfig);
        $this->rateLimiter = new RateLimiter($this->mysql);
        $this->emailService = $emailService;
        $this->adminEmails = array_values(array_filter(array_map(
            static fn ($e) => strtolower(trim((string) $e)),
            $adminEmails
        ), static fn ($e) => $e !== ''));
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
    public function register(string $email, string $password, ?string $name = null, ?string $timezone = null): array
    {
        if (in_array(strtolower(trim($email)), $this->adminEmails, true)) {
            throw new \RuntimeException(
                'This address is reserved for administrator bootstrap and cannot be registered publicly.'
            );
        }
        if ($name !== null && mb_strlen($name) > self::MAX_NAME_LENGTH) {
            throw new \InvalidArgumentException('Name must be ' . self::MAX_NAME_LENGTH . ' characters or fewer.');
        }

        // A browser-detected timezone at signup gives the account a sensible
        // default display zone. Validate against the IANA list; anything else
        // is simply ignored (the account starts unset → falls back to app/UTC).
        $tz = $timezone !== null ? trim($timezone) : '';
        if ($tz !== '' && !in_array($tz, \DateTimeZone::listIdentifiers(), true)) {
            $tz = '';
        }

        $userId = $this->generateUuid();
        $passwordHash = password_hash($password, PASSWORD_DEFAULT);
        $now = date('Y-m-d H:i:s');

        try {
            // Every new account starts with a free Cloud window (30 days normally; longer in beta —
            // see BETA_MODE). $signupFreeDays is a server-controlled int, safe to interpolate.
            $stmt = $this->mysql->prepare("
                INSERT INTO users (id, email, password_hash, name, timezone, cloud_until, created_at, updated_at)
                VALUES (:id, :email, :password_hash, :name, :timezone, DATE_ADD(NOW(), INTERVAL {$this->signupFreeDays} DAY), :created_at, :updated_at)
            ");

            $stmt->execute([
                'id' => $userId,
                'email' => $email,
                'password_hash' => $passwordHash,
                'name' => $name,
                'timezone' => $tz === '' ? null : $tz,
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
            'user' => $this->userPayload($user),
            'token' => $token,
        ];
    }

    /**
     * The user payload the SPA stores at sign-in. Carries the same computed
     * decorations /auth/me returns (isDemo, isAdmin) — without them the Admin
     * nav entry only appeared after a full page refresh re-fetched /auth/me.
     */
    public function userPayload(User $user): array
    {
        $demoEmail = strtolower((string) ($_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local'));
        return $user->toArray() + [
            'isDemo' => strtolower($user->email) === $demoEmail,
            'isAdmin' => $this->isPlatformAdmin($user),
            'mfaEnabled' => $this->isMfaEnabled($user->id),
        ];
    }

    /** Whether TOTP MFA is switched on (drives the Settings card + signup nudge). */
    private function isMfaEnabled(string $userId): bool
    {
        try {
            $stmt = $this->mysql->prepare("SELECT mfa_enabled FROM users WHERE id = :id");
            $stmt->execute(['id' => $userId]);
            return (bool) $stmt->fetchColumn();
        } catch (\Exception $e) {
            return false; // column not migrated yet
        }
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

        // Atomically increment + gate on the returned count. The previous
        // count()-then-hit()-on-failure pattern was a TOCTOU: a concurrent burst
        // from many IPs could all read count < limit and all pass the per-email
        // gate (the documented distributed-attack defense). Every attempt is now
        // counted up front; a successful login clears both keys below, so legitimate
        // logins aren't penalized.
        $window = $this->decaySeconds();
        $ipCount = $this->rateLimiter->hit($rateLimitKey, $window);
        $emailCount = $this->rateLimiter->hit($emailKey, $window);
        if ($ipCount === RateLimiter::UNAVAILABLE || $emailCount === RateLimiter::UNAVAILABLE) {
            // Login is a HIGH-RISK action: a limiter-store outage fails CLOSED
            // (audit RATE-001) — otherwise the outage window is an unlimited
            // brute-force window. Mapped to a retryable 503 upstream.
            throw new RateLimiterUnavailableException();
        }
        if ($ipCount > $this->rateLimitConfig['maxAttempts']) {
            throw new \RuntimeException(
                "Too many login attempts. Please try again in " .
                ceil($this->getRateLimitRemainingSeconds($rateLimitKey) / 60) . " minute(s)."
            );
        }
        if ($emailCount > $this->rateLimitConfig['maxEmailAttempts']) {
            throw new \RuntimeException(
                "Too many login attempts for this account. Please try again in " .
                ceil($this->getEmailRateLimitRemainingSeconds($emailKey) / 60) . " minute(s)."
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
            throw new \RuntimeException('Invalid email or password');
        }

        if (!password_verify($password, $row['password_hash'])) {
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
            'user' => $this->userPayload($user),
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
     * Get rate limit key for per-email password-reset request limiting. A distinct
     * namespace from getEmailRateLimitKey (login) so the two budgets never collide.
     */
    private function getPasswordResetRateLimitKey(string $email): string
    {
        return hash('sha256', 'password_reset_email|' . strtolower(trim($email)));
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

            $user = $this->getUserById($decoded->sub);
            if ($user === null) {
                return null;
            }
            // Global session boot (admin panel "sign everyone out"): tokens issued
            // before the boot are rejected for everyone EXCEPT platform admins —
            // the admin who pressed the button must keep their session to manage
            // the maintenance window and let people back in.
            //
            // Audit FL-17: the authority is a MONOTONIC session generation ('sg'
            // claim), not the second-resolution timestamp — a token minted in the
            // same second as the boot carried iat == session_epoch and survived the
            // old comparison. Legacy tokens without 'sg' fall back to the timestamp
            // check, closed at the boundary (iat <= epoch rejects), so the
            // same-second hole no longer exists in either path.
            if (!$this->isPlatformAdmin($user)) {
                if (isset($decoded->sg)) {
                    if ((int) $decoded->sg < $this->getSessionGeneration()) {
                        return null;
                    }
                } else {
                    $iat = isset($decoded->iat) ? (int) $decoded->iat : 0;
                    $epoch = $this->getSessionEpoch();
                    if ($epoch > 0 && $iat <= $epoch) {
                        return null;
                    }
                }
            }
            return $user;
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

    // ── Platform administration (admin panel) ───────────────────────────────

    /**
     * Platform admin authorization comes only from the durable users.is_admin
     * flag. Configured email strings are reservation hints, never authority.
     */
    public function isPlatformAdmin(User $user): bool
    {
        $demoEmail = strtolower((string) ($_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local'));
        if (strtolower($user->email) === $demoEmail) {
            return false;
        }
        return $user->isAdmin;
    }

    /**
     * The global session epoch (unix seconds): non-admin tokens issued before it
     * are rejected. 0 = never booted. Memoized for the request; fails open (0)
     * when system_meta is missing (pre-migration DB).
     */
    public function getSessionEpoch(): int
    {
        if ($this->sessionEpochCache !== null) {
            return $this->sessionEpochCache;
        }
        try {
            $stmt = $this->mysql->query("SELECT meta_value FROM system_meta WHERE meta_key = 'session_epoch'");
            $val = $stmt ? $stmt->fetchColumn() : false;
            $this->sessionEpochCache = ($val !== false && $val !== null) ? (int) $val : 0;
        } catch (\Throwable) {
            $this->sessionEpochCache = 0;
        }
        return $this->sessionEpochCache;
    }

    /**
     * The monotonic global session generation (audit FL-17): every issued JWT
     * carries the generation current at mint time ('sg'); "boot all sessions"
     * increments it, and validation rejects non-admin tokens minted under an
     * older generation. Unlike the second-resolution epoch, two boots in the
     * same second still produce distinct generations. 0 = never booted.
     * Memoized per request; fails open (0) on a pre-migration DB.
     */
    public function getSessionGeneration(): int
    {
        if ($this->sessionGenerationCache !== null) {
            return $this->sessionGenerationCache;
        }
        try {
            $stmt = $this->mysql->query("SELECT meta_value FROM system_meta WHERE meta_key = 'session_generation'");
            $val = $stmt ? $stmt->fetchColumn() : false;
            $this->sessionGenerationCache = ($val !== false && $val !== null) ? (int) $val : 0;
        } catch (\Throwable) {
            $this->sessionGenerationCache = 0;
        }
        return $this->sessionGenerationCache;
    }

    /**
     * Sign every non-admin user out everywhere: increments the monotonic session
     * generation (the authority — see getSessionGeneration) and stamps the legacy
     * timestamp epoch for pre-'sg' tokens. Admin sessions survive (they must be
     * able to reopen the site). Returns the new epoch.
     */
    public function bootAllSessions(): int
    {
        $epoch = time();
        $stmt = $this->mysql->prepare("
            INSERT INTO system_meta (meta_key, meta_value) VALUES ('session_epoch', :v)
            ON DUPLICATE KEY UPDATE meta_value = :v2
        ");
        $stmt->execute(['v' => (string) $epoch, 'v2' => (string) $epoch]);
        $this->sessionEpochCache = $epoch;

        // Atomic increment: concurrent boots each get their own generation.
        $gen = $this->mysql->prepare("
            INSERT INTO system_meta (meta_key, meta_value) VALUES ('session_generation', '1')
            ON DUPLICATE KEY UPDATE meta_value = CAST(CAST(meta_value AS UNSIGNED) + 1 AS CHAR)
        ");
        $gen->execute();
        $this->sessionGenerationCache = null;
        $this->getSessionGeneration();

        return $epoch;
    }

    /**
     * Presence for the admin panel's "logged-in users" count. Self-throttling:
     * writes at most once a minute per user (the WHERE clause makes repeat
     * calls within the window a no-op). Best-effort — never breaks auth.
     */
    public function touchLastSeen(User $user): void
    {
        try {
            $stmt = $this->mysql->prepare("
                UPDATE users SET last_seen_at = NOW()
                WHERE id = :id AND (last_seen_at IS NULL OR last_seen_at < DATE_SUB(NOW(), INTERVAL 60 SECOND))
            ");
            $stmt->execute(['id' => $user->id]);
        } catch (\Throwable) {
            // pre-migration DB (no column yet) — presence is best-effort
        }
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

        // Per-account display timezone. Validated against the real IANA list so
        // a bad value can't reach the client-side Intl formatter; '' clears it
        // (falls back to the app timezone, then UTC).
        if (array_key_exists('timezone', $data)) {
            $tz = trim((string) $data['timezone']);
            if ($tz !== '' && !in_array($tz, \DateTimeZone::listIdentifiers(), true)) {
                throw new \InvalidArgumentException('Invalid timezone');
            }
            $updates[] = "timezone = :timezone";
            $params['timezone'] = $tz === '' ? null : $tz;
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
            if (($pwError = self::passwordError($data['password'])) !== null) {
                throw new \InvalidArgumentException($pwError);
            }
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
    public function requestPasswordReset(string $email, string $resetUrlBase, bool $countAttempt = true): void
    {
        // Per-email rate limit, checked BEFORE the existence lookup below and keyed on the
        // raw submitted email string itself (never on whether an account was found). This
        // way, hitting the limit only reveals "this email string has been submitted N times
        // in the window" - a fact the caller already knows, since they are the one submitting
        // it - and reveals nothing about whether an account exists behind it.
        if ($countAttempt) {
            $this->consumePasswordResetAttempt($email);
        }

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
     * Consume the enumeration-safe, per-email password-reset budget before
     * any URL resolution or account lookup. Keeping this callable separately
     * lets the controller throttle even when APP_URL is misconfigured.
     */
    public function consumePasswordResetAttempt(string $email): void
    {
        $resetKey = $this->getPasswordResetRateLimitKey($email);
        $resetCount = $this->rateLimiter->hit($resetKey, self::PASSWORD_RESET_DECAY_SECONDS);
        if ($resetCount === RateLimiter::UNAVAILABLE) {
            throw new RateLimiterUnavailableException();
        }
        if ($resetCount > self::PASSWORD_RESET_MAX_ATTEMPTS) {
            throw new \RuntimeException(
                "Too many password reset requests for this email. Please try again in " .
                ceil($this->rateLimiter->secondsUntilReset(self::PASSWORD_RESET_DECAY_SECONDS) / 60) . " minute(s)."
            );
        }
    }

    /**
     * Complete a password reset using a token from requestPasswordReset.
     * Throws on invalid/expired/used tokens. Bumps token_version to revoke any
     * existing sessions.
     */
    public function resetPassword(string $token, string $newPassword): void
    {
        if (($pwError = self::passwordError($newPassword)) !== null) {
            throw new \InvalidArgumentException($pwError);
        }
        $tokenHash = hash('sha256', trim($token));

        // Atomic single-use claim (audit FL-AUTH-002): the conditional UPDATE is the gate —
        // only one concurrent redemption can flip used_at from NULL, so a raced duplicate
        // fails here instead of changing the password again after the winner. The claim
        // lives INSIDE the transaction, so a later failure (e.g. the users update) rolls
        // it back and the token survives for a clean retry.
        $this->mysql->beginTransaction();
        try {
            $claim = $this->mysql->prepare("
                UPDATE password_resets SET used_at = NOW()
                WHERE token_hash = :hash AND used_at IS NULL AND expires_at > NOW()
            ");
            $claim->execute(['hash' => $tokenHash]);
            if ($claim->rowCount() === 0) {
                $this->mysql->rollBack();
                throw new \RuntimeException('This reset link is invalid or has expired.');
            }
            $stmt = $this->mysql->prepare("SELECT user_id FROM password_resets WHERE token_hash = :hash LIMIT 1");
            $stmt->execute(['hash' => $tokenHash]);
            $userId = (string) $stmt->fetchColumn();
            $this->mysql->prepare("
                UPDATE users
                SET password_hash = :hash, token_version = token_version + 1, updated_at = :now
                WHERE id = :uid
            ")->execute([
                'hash' => password_hash($newPassword, PASSWORD_DEFAULT),
                'now' => date('Y-m-d H:i:s'),
                'uid' => $userId,
            ]);
            $this->mysql->commit();
        } catch (\Throwable $e) {
            if ($this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            throw $e;
        }
    }

    /**
     * Verify a user's current password (for sensitive actions like account
     * deletion that require re-authentication).
     */
    public function verifyPassword(string $userId, string $password): bool
    {
        $stmt = $this->mysql->prepare("SELECT password_hash FROM users WHERE id = :id");
        $stmt->execute(['id' => $userId]);
        $row = $stmt->fetch();
        return $row && password_verify($password, $row['password_hash']);
    }

    /**
     * Delete the user row. Caller is responsible for deleting owned resources
     * (forms, apps) first; FK cascades clean up memberships, reset tokens, etc.
     */
    public function deleteAccount(string $userId): void
    {
        $this->mysql->prepare("DELETE FROM users WHERE id = :id")->execute(['id' => $userId]);
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

    /** Lifetime of the password→MFA-code bridge token, in seconds. */
    public const MFA_PENDING_TTL = 300;

    /**
     * Short-lived single-purpose token bridging the password step and the MFA
     * code step: it proves "password already verified for this user" for five
     * minutes and is useless as a session (distinct audience + purpose claim —
     * validateToken() rejects it). Every token carries a random jti; the caller
     * must register it as a one-time server-side challenge (MfaService) so the
     * SAME token can never be exchanged for more than one session (audit MFA-001).
     *
     * @return array{token: string, jti: string}
     */
    public function issueMfaPendingToken(User $user): array
    {
        $now = time();
        $jti = bin2hex(random_bytes(16));
        $token = JWT::encode([
            'iss' => $this->jwtConfig['issuer'] ?? 'formlogic',
            'aud' => 'formlogic-mfa',
            'purpose' => 'mfa_pending',
            'sub' => $user->id,
            'jti' => $jti,
            'iat' => $now,
            'nbf' => $now,
            'exp' => $now + self::MFA_PENDING_TTL,
            'tv' => $this->getTokenVersion($user->id),
        ], $this->jwtConfig['secret'], $this->jwtConfig['algorithm']);
        return ['token' => $token, 'jti' => $jti];
    }

    /**
     * Validate an MFA-pending token; returns its user + jti, or null. Purely
     * stateless — the one-time-use guarantee lives in the mfa_challenges row
     * the jti points at (attempt-counted, atomically claimed on success).
     *
     * @return array{user: User, jti: string}|null
     */
    public function consumeMfaPendingToken(string $token): ?array
    {
        try {
            $decoded = JWT::decode($token, new Key($this->jwtConfig['secret'], $this->jwtConfig['algorithm']));
            $expectedIssuer = $this->jwtConfig['issuer'] ?? 'formlogic';
            if (!isset($decoded->sub, $decoded->iss, $decoded->aud, $decoded->purpose, $decoded->jti)
                || $decoded->iss !== $expectedIssuer
                || $decoded->aud !== 'formlogic-mfa'
                || $decoded->purpose !== 'mfa_pending'
                || !is_string($decoded->jti)
                || $decoded->jti === ''
            ) {
                return null;
            }
            $tokenTv = isset($decoded->tv) ? (int) $decoded->tv : 0;
            if ($tokenTv !== $this->getTokenVersion($decoded->sub)) {
                return null;
            }
            $user = $this->getUserById($decoded->sub);
            return $user !== null ? ['user' => $user, 'jti' => $decoded->jti] : null;
        } catch (\Exception $e) {
            return null;
        }
    }

    /**
     * Find-or-create the shared public "Demo" account. It has an unusable random
     * password (the demo is entered via a passwordless minted token, never a login),
     * and a far-future cloud_until so demo apps are never plan-gated. Idempotent.
     */
    public function ensureDemoUser(string $email, string $name = 'Demo'): User
    {
        $stmt = $this->mysql->prepare("SELECT * FROM users WHERE email = :email");
        $stmt->execute(['email' => $email]);
        $row = $stmt->fetch();
        if ($row) {
            return User::fromArray($row);
        }

        $userId = $this->generateUuid();
        $passwordHash = password_hash(bin2hex(random_bytes(32)), PASSWORD_DEFAULT);
        $now = date('Y-m-d H:i:s');
        try {
            $stmt = $this->mysql->prepare("
                INSERT INTO users (id, email, password_hash, name, cloud_until, created_at, updated_at)
                VALUES (:id, :email, :password_hash, :name, DATE_ADD(NOW(), INTERVAL 100 YEAR), :created_at, :updated_at)
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
            // Lost a create race — the row now exists, so just read it back.
            if ($e->getCode() === '23000' || strpos($e->getMessage(), 'Duplicate entry') !== false) {
                $stmt = $this->mysql->prepare("SELECT * FROM users WHERE email = :email");
                $stmt->execute(['email' => $email]);
                $row = $stmt->fetch();
                if ($row) {
                    return User::fromArray($row);
                }
            }
            throw $e;
        }

        return $this->getUserById($userId);
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
            'sg' => $this->getSessionGeneration(), // monotonic boot generation (audit FL-17)
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
