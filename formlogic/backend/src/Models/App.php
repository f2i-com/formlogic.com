<?php

declare(strict_types=1);

namespace FormLogic\Models;

class App
{
    public function __construct(
        public string $id,
        public string $name,
        public string $slug,
        public ?string $ownerId = null,
        public ?string $description = null,
        public ?string $logoUrl = null,
        public string $status = 'draft',
        public array $settings = [],
        public array $theme = [],
        public array $navConfig = [],
        public array $customScreen = [],
        public array $reports = [],
        public array $customLogic = [],
        public ?string $createdAt = null,
        public ?string $updatedAt = null
    ) {}

    public static function fromArray(array $data): self
    {
        return new self(
            id: $data['id'],
            name: $data['name'],
            slug: $data['slug'],
            ownerId: $data['owner_id'] ?? $data['ownerId'] ?? null,
            description: $data['description'] ?? null,
            logoUrl: $data['logo_url'] ?? $data['logoUrl'] ?? null,
            status: $data['status'] ?? 'draft',
            settings: is_string($data['settings'] ?? null)
                ? json_decode($data['settings'], true) ?? []
                : ($data['settings'] ?? []),
            theme: is_string($data['theme'] ?? null)
                ? json_decode($data['theme'], true) ?? []
                : ($data['theme'] ?? []),
            navConfig: is_string($data['nav_config'] ?? $data['navConfig'] ?? null)
                ? json_decode($data['nav_config'] ?? $data['navConfig'], true) ?? []
                : ($data['nav_config'] ?? $data['navConfig'] ?? []),
            customScreen: is_string($data['custom_screen'] ?? null)
                ? json_decode($data['custom_screen'], true) ?? []
                : ($data['customScreen'] ?? []),
            reports: is_string($data['reports'] ?? null)
                ? json_decode($data['reports'], true) ?? []
                : ($data['reports'] ?? []),
            customLogic: is_string($data['custom_logic'] ?? null)
                ? json_decode($data['custom_logic'], true) ?? []
                : ($data['customLogic'] ?? []),
            createdAt: $data['created_at'] ?? $data['createdAt'] ?? null,
            updatedAt: $data['updated_at'] ?? $data['updatedAt'] ?? null
        );
    }

    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'slug' => $this->slug,
            'ownerId' => $this->ownerId,
            'description' => $this->description,
            'logoUrl' => $this->logoUrl,
            'status' => $this->status,
            'settings' => $this->settings,
            'theme' => $this->theme,
            'navConfig' => $this->navConfig,
            'customScreen' => $this->customScreen,
            'reports' => $this->reports,
            'customLogic' => $this->customLogic,
            'createdAt' => $this->createdAt,
            'updatedAt' => $this->updatedAt,
        ];
    }
}
