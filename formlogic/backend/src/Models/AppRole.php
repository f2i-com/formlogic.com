<?php

declare(strict_types=1);

namespace FormLogic\Models;

class AppRole
{
    public function __construct(
        public string $id,
        public string $appId,
        public string $name,
        public ?string $description = null,
        public bool $isSystem = false,
        public int $sortOrder = 0
    ) {}

    public static function fromArray(array $data): self
    {
        return new self(
            id: $data['id'],
            appId: $data['app_id'] ?? $data['appId'],
            name: $data['name'],
            description: $data['description'] ?? null,
            isSystem: (bool)($data['is_system'] ?? $data['isSystem'] ?? false),
            sortOrder: (int)($data['sort_order'] ?? $data['sortOrder'] ?? 0)
        );
    }

    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'appId' => $this->appId,
            'name' => $this->name,
            'description' => $this->description,
            'isSystem' => $this->isSystem,
            'sortOrder' => $this->sortOrder,
        ];
    }
}
