<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Models\User;
use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use PDO;

class AuthService
{
    private PDO $mysql;
    private array $jwtConfig;
    private array $rateLimitConfig;

    // In-memory rate limit tracking (for single-server deployments)
    // For production with multiple servers, use Redis or database
    private static array $loginAttempts = [];

    // Separate tracking for email-only rate limiting (protects against distributed attacks)
    private static array $emailAttempts = [];

    public function __construct(MySQLConnection $mysql, array $jwtConfig, array $rateLimitConfig = [])
    {
        $this->mysql = $mysql->getConnection();
        $this->jwtConfig = $jwtConfig;
        $this->rateLimitConfig = array_merge([
            'maxAttempts' => 5,           // Max attempts per IP+email combo
            'maxEmailAttempts' => 10,     // Max attempts per email (across all IPs)
            'decayMinutes' => 15,
        ], $rateLimitConfig);
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
        $this->cleanupExpiredAttempts($key);

        $attempts = self::$loginAttempts[$key] ?? [];
        return count($attempts) >= $this->rateLimitConfig['maxAttempts'];
    }

    /**
     * Check if an email is rate limited (across all IPs)
     */
    private function isEmailRateLimited(string $emailKey): bool
    {
        $this->cleanupExpiredEmailAttempts($emailKey);

        $attempts = self::$emailAttempts[$emailKey] ?? [];
        return count($attempts) >= $this->rateLimitConfig['maxEmailAttempts'];
    }

    /**
     * Get remaining seconds until rate limit expires (IP+email combo)
     */
    private function getRateLimitRemainingSeconds(string $key): int
    {
        $attempts = self::$loginAttempts[$key] ?? [];
        if (empty($attempts)) {
            return 0;
        }

        $oldestAttempt = min($attempts);
        $expiresAt = $oldestAttempt + ($this->rateLimitConfig['decayMinutes'] * 60);
        return max(0, $expiresAt - time());
    }

    /**
     * Get remaining seconds until email rate limit expires
     */
    private function getEmailRateLimitRemainingSeconds(string $emailKey): int
    {
        $attempts = self::$emailAttempts[$emailKey] ?? [];
        if (empty($attempts)) {
            return 0;
        }

        $oldestAttempt = min($attempts);
        $expiresAt = $oldestAttempt + ($this->rateLimitConfig['decayMinutes'] * 60);
        return max(0, $expiresAt - time());
    }

    /**
     * Record a failed login attempt for both IP+email and email-only tracking
     */
    private function recordFailedLogin(string $key, string $emailKey): void
    {
        $now = time();

        // Record IP+email attempt
        if (!isset(self::$loginAttempts[$key])) {
            self::$loginAttempts[$key] = [];
        }
        self::$loginAttempts[$key][] = $now;

        // Record email-only attempt
        if (!isset(self::$emailAttempts[$emailKey])) {
            self::$emailAttempts[$emailKey] = [];
        }
        self::$emailAttempts[$emailKey][] = $now;
    }

    /**
     * Clear rate limit for a key (on successful login)
     */
    private function clearRateLimit(string $key): void
    {
        unset(self::$loginAttempts[$key]);
    }

    /**
     * Clear email rate limit (on successful login)
     */
    private function clearEmailRateLimit(string $emailKey): void
    {
        unset(self::$emailAttempts[$emailKey]);
    }

    /**
     * Clean up expired login attempts (IP+email combo)
     */
    private function cleanupExpiredAttempts(string $key): void
    {
        if (!isset(self::$loginAttempts[$key])) {
            return;
        }

        $cutoff = time() - ($this->rateLimitConfig['decayMinutes'] * 60);
        self::$loginAttempts[$key] = array_filter(
            self::$loginAttempts[$key],
            fn($timestamp) => $timestamp > $cutoff
        );

        if (empty(self::$loginAttempts[$key])) {
            unset(self::$loginAttempts[$key]);
        }
    }

    /**
     * Clean up expired email attempts
     */
    private function cleanupExpiredEmailAttempts(string $emailKey): void
    {
        if (!isset(self::$emailAttempts[$emailKey])) {
            return;
        }

        $cutoff = time() - ($this->rateLimitConfig['decayMinutes'] * 60);
        self::$emailAttempts[$emailKey] = array_filter(
            self::$emailAttempts[$emailKey],
            fn($timestamp) => $timestamp > $cutoff
        );

        if (empty(self::$emailAttempts[$emailKey])) {
            unset(self::$emailAttempts[$emailKey]);
        }
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
            $updates[] = "name = :name";
            $params['name'] = $data['name'];
        }

        if (isset($data['email'])) {
            // Check if email is taken by another user
            $stmt = $this->mysql->prepare("SELECT id FROM users WHERE email = :email AND id != :check_id");
            $stmt->execute(['email' => $data['email'], 'check_id' => $userId]);
            if ($stmt->fetch()) {
                throw new \RuntimeException('Unable to update email address');
            }

            $updates[] = "email = :email";
            $params['email'] = $data['email'];
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
        }

        if (empty($updates)) {
            return $this->getUserById($userId);
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
