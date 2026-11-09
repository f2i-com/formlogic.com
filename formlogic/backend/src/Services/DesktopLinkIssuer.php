<?php

declare(strict_types=1);

namespace FormLogic\Services;

use Psr\Log\LoggerInterface;

/**
 * What linking a computer makes: a long-lived, revocable flk_ key holding exactly the granted scopes,
 * tied to a fresh desktop_connections row named for the device. One issuer for both ways a computer
 * links, so they answer alike byte for byte: the browser link's OAuth token exchange
 * (McpOAuthController::issueDesktopKey) and an OAIY server's one-time code (DesktopLinkCodeService).
 * The key is revocable from Settings → API keys and by deleting the connection.
 */
final class DesktopLinkIssuer
{
    public function __construct(private ApiKeyService $apiKeys, private FlowService $flows, private ?LoggerInterface $logger = null)
    {
    }

    /**
     * Mint the key and its connection. A failure after the key was minted revokes it (audit FL-19):
     * a failed link must never leave an active, never-disclosed key consuming the account's quota.
     * $onCompensated(apiKeyId, revoked) hears of that, for the caller's audit.
     *
     * $aiOnly marks the key an "AI only" link's (ApiKeyService::markAiOnly): it answers the AI lane and
     * checks in, and nothing else.
     *
     * @param list<string> $scopes
     * @return array{key: array, connection: array}
     */
    public function issue(string $userId, ?string $device, array $scopes, string $runtimeName, ?callable $onCompensated = null, bool $aiOnly = false): array
    {
        $keyName = mb_substr($device !== null ? "{$runtimeName} on {$device}" : $runtimeName, 0, 255);
        $key = null;
        try {
            $key = $this->apiKeys->createKey($userId, $keyName, $scopes);
            if ($aiOnly) $this->apiKeys->markAiOnly((string) $key['id']);
            $connection = $this->flows->createOAuthDesktopConnection($userId, $device, $key['id'], $runtimeName);
        } catch (\Throwable $e) {
            if ($key !== null) {
                try {
                    $revoked = $this->apiKeys->revokeKey($key['id'], $userId);
                    if ($onCompensated !== null) $onCompensated((string) $key['id'], $revoked);
                } catch (\Throwable $revokeError) {
                    $this->logger?->error('Desktop link compensation failed: orphaned key remains active', [
                        'apiKeyId' => $key['id'],
                        'reason' => $revokeError->getMessage(),
                    ]);
                }
            }
            throw $e;
        }
        return ['key' => $key, 'connection' => $connection];
    }

    /**
     * The token exchange's answer for a linked computer. access_token == formlogic_api_key, so a
     * generic OAuth client still finds a bearer, while the documented field is formlogic_api_key.
     * Long-lived and revocable: no expires_in, no refresh token.
     *
     * @param list<string> $scopes
     */
    public static function tokenBody(array $key, array $connection, array $scopes): array
    {
        return [
            'access_token' => $key['key'],
            'token_type' => 'Bearer',
            'scope' => implode(' ', $scopes),
            'formlogic_api_key' => $key['key'],
            'api_key_id' => $key['id'],
            'desktop_connection_id' => $connection['id'],
            'device_name' => $connection['deviceName'],
        ];
    }
}
