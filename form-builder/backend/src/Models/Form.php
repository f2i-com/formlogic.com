<?php

declare(strict_types=1);

namespace FormLogic\Models;

class Form
{
    public function __construct(
        public string $id,
        public string $title,
        public ?string $description = null,
        public ?string $userId = null,
        public string $status = 'draft',
        public array $fields = [],
        public array $settings = [],
        public array $theme = [],
        public ?string $createdAt = null,
        public ?string $updatedAt = null,
        public ?string $publishedAt = null
    ) {}

    public static function fromArray(array $data): self
    {
        return new self(
            id: $data['id'],
            title: $data['title'],
            description: $data['description'] ?? null,
            userId: $data['user_id'] ?? $data['userId'] ?? null,
            status: $data['status'] ?? 'draft',
            fields: is_string($data['fields'] ?? null)
                ? json_decode($data['fields'], true) ?? []
                : ($data['fields'] ?? []),
            settings: is_string($data['settings'] ?? null)
                ? json_decode($data['settings'], true) ?? []
                : ($data['settings'] ?? []),
            theme: is_string($data['theme'] ?? null)
                ? json_decode($data['theme'], true) ?? []
                : ($data['theme'] ?? []),
            createdAt: $data['created_at'] ?? $data['createdAt'] ?? null,
            updatedAt: $data['updated_at'] ?? $data['updatedAt'] ?? null,
            publishedAt: $data['published_at'] ?? $data['publishedAt'] ?? null
        );
    }

    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'title' => $this->title,
            'description' => $this->description,
            'userId' => $this->userId,
            'status' => $this->status,
            'fields' => $this->fields,
            'settings' => $this->settings,
            'theme' => $this->theme,
            'createdAt' => $this->createdAt,
            'updatedAt' => $this->updatedAt,
            'publishedAt' => $this->publishedAt,
        ];
    }

    public function toDbArray(): array
    {
        return [
            'id' => $this->id,
            'title' => $this->title,
            'description' => $this->description,
            'user_id' => $this->userId,
            'status' => $this->status,
            'settings' => json_encode($this->settings),
            'theme' => json_encode($this->theme),
        ];
    }
}
