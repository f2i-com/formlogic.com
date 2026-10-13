<?php

declare(strict_types=1);

namespace FormLogic\Support;

use FormLogic\Models\User;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * The host's admission identity for a private named-action mount.
 *
 * The header is a comparison, never authentication or a source of run() authority.
 * The session fingerprint is not a bearer credential. Only AuthMiddleware, AFTER
 * token validation, supplies its request attribute; headers and action input cannot.
 */
final class HostedActorContext
{
    public const SESSION_ATTRIBUTE = 'formlogic.authenticatedSessionId';
    public const HEADER = 'X-FormLogic-Hosted-Actor';
    public const MAX_HEADER_BYTES = 2048;

    /** Call only for a credential that the authentication service has validated. */
    public static function sessionId(string $validatedToken): string
    {
        return hash('sha256', "formlogic.hosted-actor.session.v1\0" . $validatedToken);
    }

    /** Resolve exclusively from authenticated request and current host service rows. */
    public static function fromRequest(Request $request, array $app, ?array $membership): ?array
    {
        $userId = $request->getAttribute('userId');
        $user = $request->getAttribute('user');
        $sessionId = $request->getAttribute(self::SESSION_ATTRIBUTE);
        $appId = $app['id'] ?? null;
        if (!self::identifier($userId) || !$user instanceof User || $user->id !== $userId
            || !is_string($appId) || preg_match('/^[a-zA-Z0-9_-]{1,100}$/D', $appId) !== 1
            || !self::sessionFingerprint($sessionId)) return null;

        $owner = ($app['ownerId'] ?? null) === $userId;
        if (!$owner && (($membership['status'] ?? null) !== 'active'
            || ($membership['appId'] ?? null) !== $appId
            || ($membership['userId'] ?? null) !== $userId
            || !self::identifier($membership['roleId'] ?? null))) return null;

        return [
            'version' => 1, 'appId' => $appId, 'userId' => $userId,
            'roleId' => $owner ? null : $membership['roleId'],
            'isOwner' => $owner, 'sessionId' => $sessionId,
        ];
    }

    /** Strict, bounded wire schema. Missing, duplicate, escaped or extra keys fail closed. */
    public static function initiatingActor(Request $request): ?array
    {
        $values = $request->getHeader(self::HEADER);
        if (count($values) !== 1) return null;
        $raw = $values[0];
        if ($raw === '' || strlen($raw) > self::MAX_HEADER_BYTES || str_contains($raw, '\\')) return null;
        try { $value = json_decode($raw, true, 3, JSON_THROW_ON_ERROR); }
        catch (\JsonException) { return null; }
        if (!is_array($value) || count($value) !== 6) return null;
        $keys = array_keys($value);
        sort($keys);
        if ($keys !== ['appId', 'isOwner', 'roleId', 'sessionId', 'userId', 'version']) return null;
        // Identifiers cannot contain quotes, so these are object keys rather than
        // text embedded in a value. Reject duplicate keys that json_decode accepts.
        preg_match_all('/"(version|appId|userId|roleId|isOwner|sessionId)"\s*:/', $raw, $found);
        if (count($found[1]) !== 6 || count(array_unique($found[1])) !== 6) return null;
        if ($value['version'] !== 1 || !is_string($value['appId'])
            || preg_match('/^[a-zA-Z0-9_-]{1,100}$/D', $value['appId']) !== 1
            || !self::identifier($value['userId']) || !is_bool($value['isOwner'])
            || !self::sessionFingerprint($value['sessionId'])
            || ($value['isOwner'] ? $value['roleId'] !== null : !self::identifier($value['roleId']))) return null;

        return [
            'version' => 1, 'appId' => $value['appId'], 'userId' => $value['userId'],
            'roleId' => $value['roleId'], 'isOwner' => $value['isOwner'], 'sessionId' => $value['sessionId'],
        ];
    }

    private static function identifier(mixed $value): bool
    {
        return is_string($value) && preg_match('/^[a-zA-Z0-9_.:-]{1,200}$/D', $value) === 1;
    }

    private static function sessionFingerprint(mixed $value): bool
    {
        return is_string($value) && preg_match('/^[a-f0-9]{64}$/D', $value) === 1;
    }
}
