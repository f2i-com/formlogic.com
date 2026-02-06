<?php

declare(strict_types=1);

namespace FormLogic\Models;

class AppUser
{
    public function __construct(
        public string $id,
        public string $appId,
        public string $userId,
        public string $roleId,
        public string $status = 'active',
        public ?string $invitedBy = null,
        public ?string $invitedAt = null,
        public ?string $joinedAt = null
    ) {}

    public static function fromArray(array $data): self
    {
        return new self(
            id: $data['id'],
            appId: $data['app_id'] ?? $data['appId'],
            userId: $data['user_id'] ?? $data['userId'],
            roleId: $data['role_id'] ?? $data['roleId'],
            status: $data['status'] ?? 'active',
            invitedBy: $data['invited_by'] ?? $data['invitedBy'] ?? null,
            invitedAt: $data['invited_at'] ?? $data['invitedAt'] ?? null,
            joinedAt: $data['joined_at'] ?? $data['joinedAt'] ?? null
        );
    }

    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'appId' => $this->appId,
            'userId' => $this->userId,
            'roleId' => $this->roleId,
            'status' => $this->status,
            'invitedBy' => $this->invitedBy,
            'invitedAt' => $this->invitedAt,
            'joinedAt' => $this->joinedAt,
        ];
    }
}
