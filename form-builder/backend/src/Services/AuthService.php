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

    public function __construct(MySQLConnection $mysql, array $jwtConfig)
    {
        $this->mysql = $mysql->getConnection();
        $this->jwtConfig = $jwtConfig;
    }

    /**
     * Register a new user
     */
    public function register(string $email, string $password, ?string $name = null): array
    {
        // Check if email already exists
        $stmt = $this->mysql->prepare("SELECT id FROM users WHERE email = :email");
        $stmt->execute(['email' => $email]);

        if ($stmt->fetch()) {
            throw new \Exception('Email already registered');
        }

        $userId = $this->generateUuid();
        $passwordHash = password_hash($password, PASSWORD_BCRYPT);
        $now = date('Y-m-d H:i:s');

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

        $user = $this->getUserById($userId);
        $token = $this->generateToken($user);

        return [
            'user' => $user->toArray(),
            'token' => $token,
        ];
    }

    /**
     * Login a user
     */
    public function login(string $email, string $password): array
    {
        $stmt = $this->mysql->prepare("SELECT * FROM users WHERE email = :email");
        $stmt->execute(['email' => $email]);
        $row = $stmt->fetch();

        if (!$row) {
            throw new \Exception('Invalid email or password');
        }

        if (!password_verify($password, $row['password_hash'])) {
            throw new \Exception('Invalid email or password');
        }

        $user = User::fromArray($row);
        $token = $this->generateToken($user);

        return [
            'user' => $user->toArray(),
            'token' => $token,
        ];
    }

    /**
     * Validate a JWT token and return the user
     */
    public function validateToken(string $token): ?User
    {
        try {
            $decoded = JWT::decode($token, new Key($this->jwtConfig['secret'], $this->jwtConfig['algorithm']));

            if (!isset($decoded->sub)) {
                return null;
            }

            return $this->getUserById($decoded->sub);
        } catch (\Exception $e) {
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
                throw new \Exception('Email already in use');
            }

            $updates[] = "email = :email";
            $params['email'] = $data['email'];
        }

        if (isset($data['password'])) {
            $updates[] = "password_hash = :password_hash";
            $params['password_hash'] = password_hash($data['password'], PASSWORD_BCRYPT);
        }

        if (empty($updates)) {
            return $this->getUserById($userId);
        }

        $updates[] = "updated_at = :updated_at";
        $params['updated_at'] = date('Y-m-d H:i:s');

        $sql = "UPDATE users SET " . implode(', ', $updates) . " WHERE id = :id";
        $stmt = $this->mysql->prepare($sql);
        $stmt->execute($params);

        return $this->getUserById($userId);
    }

    /**
     * Generate a JWT token for a user
     */
    private function generateToken(User $user): string
    {
        $now = time();
        $payload = [
            'iss' => 'formlogic',
            'sub' => $user->id,
            'email' => $user->email,
            'iat' => $now,
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
