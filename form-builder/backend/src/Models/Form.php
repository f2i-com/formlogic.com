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
        public ?string $logicScript = null,
        public ?string $logicPrompt = null,
        public ?string $icon = null,
        public ?string $createdAt = null,
        public ?string $updatedAt = null,
        public ?string $publishedAt = null,
        public int $fieldCount = 0,
        public ?int $responseCount = null
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
            logicScript: $data['logic_script'] ?? $data['logicScript'] ?? null,
            logicPrompt: $data['logic_prompt'] ?? $data['logicPrompt'] ?? null,
            icon: $data['icon'] ?? null,
            createdAt: $data['created_at'] ?? $data['createdAt'] ?? null,
            updatedAt: $data['updated_at'] ?? $data['updatedAt'] ?? null,
            publishedAt: $data['published_at'] ?? $data['publishedAt'] ?? null,
            fieldCount: (int)($data['field_count'] ?? $data['fieldCount'] ?? 0),
            responseCount: isset($data['response_count'])
                ? (int)$data['response_count']
                : ($data['responseCount'] ?? null)
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
            'logicScript' => $this->logicScript,
            'logicPrompt' => $this->logicPrompt,
            'icon' => $this->icon,
            'createdAt' => $this->createdAt,
            'updatedAt' => $this->updatedAt,
            'publishedAt' => $this->publishedAt,
            'fieldCount' => $this->fieldCount,
            'responseCount' => $this->responseCount,
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
            'logic_script' => $this->logicScript,
            'logic_prompt' => $this->logicPrompt,
            'icon' => $this->icon,
        ];
    }
}
