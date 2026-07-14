<?php

declare(strict_types=1);

namespace FormLogic\Models;

class AppUserGroup
{
    public function __construct(
        public string $id,
        public string $appId,
        public string $name,
        public ?string $description = null
    ) {}

    public static function fromArray(array $data): self
    {
        return new self(
            id: $data['id'],
            appId: $data['app_id'] ?? $data['appId'],
            name: $data['name'],
            description: $data['description'] ?? null
        );
    }

    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'appId' => $this->appId,
            'name' => $this->name,
            'description' => $this->description,
        ];
    }
}
