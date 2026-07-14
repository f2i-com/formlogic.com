<?php

declare(strict_types=1);

namespace FormLogic\Models;

class User
{
    public function __construct(
        public string $id,
        public string $email,
        public ?string $name = null,
        public ?string $passwordHash = null,
        public ?string $createdAt = null,
        public ?string $updatedAt = null,
        /** IANA timezone the user prefers record times shown in (null = unset). */
        public ?string $timezone = null,
        /** Platform administrator (users.is_admin) — NOT app-level RBAC. */
        public bool $isAdmin = false
    ) {}

    public static function fromArray(array $data): self
    {
        return new self(
            id: $data['id'],
            email: $data['email'],
            name: $data['name'] ?? null,
            passwordHash: $data['password_hash'] ?? null,
            createdAt: $data['created_at'] ?? null,
            updatedAt: $data['updated_at'] ?? null,
            timezone: $data['timezone'] ?? null,
            isAdmin: (bool) ($data['is_admin'] ?? false)
        );
    }

    public function toArray(bool $includePassword = false): array
    {
        $data = [
            'id' => $this->id,
            'email' => $this->email,
            'name' => $this->name,
            'createdAt' => $this->createdAt,
            'updatedAt' => $this->updatedAt,
            'timezone' => $this->timezone,
        ];

        if ($includePassword && $this->passwordHash) {
            $data['passwordHash'] = $this->passwordHash;
        }

        return $data;
    }
}
