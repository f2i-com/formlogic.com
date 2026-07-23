<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;

/**
 * Per-user AI preferences (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md Phase 2, §5.5/§5.6):
 * which AI source answers hosted chat and flow 'Default' LLM nodes —
 *   site     → FormLogic-hosted Site AI (POST /api/ai/chat, allowance-metered);
 *   desktop  → the user's own desktop AI provider/model over the E2E tunnel;
 *   custom   → a browser-local provider from the user's AiServicesDialog registry.
 * chat_tool_mode ('auto'|'confirm') gates whether E2E chat tools execute immediately
 * or pause for a per-call approval. An absent row reads as the defaults.
 */
class UserAiSettingsService
{
    public const AI_SOURCES = ['site', 'desktop', 'custom'];
    public const CHAT_TOOL_MODES = ['auto', 'confirm'];
    /** Mirrors the desktop Codex lane's accepted reasoning efforts (codex.rs). */
    public const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    private const MAX_ID = 128;

    public const DEFAULTS = [
        'aiSource' => 'site',
        'desktopProviderId' => null,
        'desktopModel' => null,
        'customProviderId' => null,
        'chatToolMode' => 'auto',
        'desktopReasoning' => null,
    ];

    public function __construct(private MySQLConnection $mysql)
    {
    }

    /**
     * The user's settings (camelCase), defaults when no row exists yet.
     *
     * @return array{aiSource: string, desktopProviderId: ?string, desktopModel: ?string,
     *               customProviderId: ?string, chatToolMode: string, desktopReasoning: ?string, updatedAt: ?string}
     */
    public function get(string $userId): array
    {
        $stmt = $this->mysql->getConnection()->prepare(
            'SELECT ai_source, desktop_provider_id, desktop_model, custom_provider_id, chat_tool_mode, desktop_reasoning, updated_at
             FROM user_ai_settings WHERE user_id = ?'
        );
        $stmt->execute([$userId]);
        $row = $stmt->fetch(\PDO::FETCH_ASSOC);
        if (!$row) {
            return self::DEFAULTS + ['updatedAt' => null];
        }
        return [
            'aiSource' => (string) $row['ai_source'],
            'desktopProviderId' => $row['desktop_provider_id'] !== null ? (string) $row['desktop_provider_id'] : null,
            'desktopModel' => $row['desktop_model'] !== null ? (string) $row['desktop_model'] : null,
            'customProviderId' => $row['custom_provider_id'] !== null ? (string) $row['custom_provider_id'] : null,
            'chatToolMode' => (string) $row['chat_tool_mode'],
            'desktopReasoning' => $row['desktop_reasoning'] !== null ? (string) $row['desktop_reasoning'] : null,
            'updatedAt' => $row['updated_at'] !== null ? (string) $row['updated_at'] : null,
        ];
    }

    /**
     * Full-replace upsert. Absent keys fall back to defaults (PUT semantics);
     * unknown keys are ignored so newer clients don't fail against an older backend.
     *
     * @throws \InvalidArgumentException on an out-of-enum value or over-long id.
     */
    public function put(string $userId, array $data): array
    {
        $aiSource = array_key_exists('aiSource', $data)
            ? $this->enumValue($data['aiSource'], self::AI_SOURCES, 'aiSource')
            : self::DEFAULTS['aiSource'];
        $chatToolMode = array_key_exists('chatToolMode', $data)
            ? $this->enumValue($data['chatToolMode'], self::CHAT_TOOL_MODES, 'chatToolMode')
            : self::DEFAULTS['chatToolMode'];
        $desktopReasoning = null;
        if (($data['desktopReasoning'] ?? null) !== null && $data['desktopReasoning'] !== '') {
            $desktopReasoning = $this->enumValue($data['desktopReasoning'], self::REASONING_EFFORTS, 'desktopReasoning');
        }
        $desktopProviderId = $this->idValue($data['desktopProviderId'] ?? null, 'desktopProviderId');
        $desktopModel = $this->idValue($data['desktopModel'] ?? null, 'desktopModel');
        $customProviderId = $this->idValue($data['customProviderId'] ?? null, 'customProviderId');

        $stmt = $this->mysql->getConnection()->prepare(
            'INSERT INTO user_ai_settings
                (user_id, ai_source, desktop_provider_id, desktop_model, custom_provider_id, chat_tool_mode, desktop_reasoning)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                ai_source = VALUES(ai_source),
                desktop_provider_id = VALUES(desktop_provider_id),
                desktop_model = VALUES(desktop_model),
                custom_provider_id = VALUES(custom_provider_id),
                chat_tool_mode = VALUES(chat_tool_mode),
                desktop_reasoning = VALUES(desktop_reasoning)'
        );
        $stmt->execute([$userId, $aiSource, $desktopProviderId, $desktopModel, $customProviderId, $chatToolMode, $desktopReasoning]);
        return $this->get($userId);
    }

    /** @param string[] $allowed */
    private function enumValue(mixed $value, array $allowed, string $field): string
    {
        if (!is_string($value) || !in_array($value, $allowed, true)) {
            throw new \InvalidArgumentException($field . ' must be one of: ' . implode(', ', $allowed));
        }
        return $value;
    }

    private function idValue(mixed $value, string $field): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }
        if (!is_string($value) || strlen($value) > self::MAX_ID) {
            throw new \InvalidArgumentException($field . ' must be a string (max ' . self::MAX_ID . ' chars)');
        }
        return $value;
    }
}
