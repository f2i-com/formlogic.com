<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * The ICE (STUN/TURN) servers an Aokie Companion is told to use: in the signed discovery document
 * and in every plugin and mobile admission. What comes back is the exact shape the native
 * Companion parses (it rejects unknown members): a list of `{urls, username, credential[, expiresAt]}`
 * entries, the relay policy, and `expiresAt` — the earliest expiry among the TURN entries, because
 * the Companion checks that it equals that, and null when there are none.
 *
 * Configured with AOKIE_COMPANION_ICE_SERVERS_JSON, whose TURN entries must carry an `expiresAt`
 * 31 seconds to 24 hours ahead, and AOKIE_COMPANION_RELAY_ONLY. Anything malformed, or a TURN
 * credential that is out of that window, is refused with an \UnexpectedValueException.
 */
final class AokieCompanionIceConfiguration
{
    public const MAX_SERVERS = 8;
    public const MAX_URLS_PER_SERVER = 8;
    /** The Companion refuses a TURN credential with this many seconds or fewer left... */
    public const TURN_MIN_REMAINING_SECONDS = 30;
    /** ...and one more than this far ahead. */
    public const TURN_MAX_REMAINING_SECONDS = 86400;

    /**
     * Every value is the raw setting ('' when unset); nothing is validated until a configuration
     * is asked for, so constructing one never throws.
     */
    public function __construct(
        private readonly string $relayOnly = '',
        private readonly string $staticServersJson = '',
    ) {
    }

    /** @param callable(string): string $environment reads one setting by name, '' when unset */
    public static function fromEnvironment(callable $environment): self
    {
        return new self(
            trim($environment('AOKIE_COMPANION_RELAY_ONLY')),
            trim($environment('AOKIE_COMPANION_ICE_SERVERS_JSON')),
        );
    }

    /**
     * @return array{servers:list<array<string,mixed>>,relayOnly:bool,expiresAt:?int}
     * @throws \UnexpectedValueException when the operator's ICE/relay policy is unsafe
     */
    public function resolve(?int $now = null): array
    {
        $now ??= time();
        if (!in_array($this->relayOnly, ['', 'true', 'false'], true)) {
            throw new \UnexpectedValueException('AOKIE_COMPANION_RELAY_ONLY must be true or false');
        }
        $relayOnly = $this->relayOnly === 'true';
        $raw = $this->staticServersJson;
        if ($raw === '') {
            if ($relayOnly) {
                throw new \UnexpectedValueException('relayOnly requires a configured TURN server');
            }
            return ['servers' => [], 'relayOnly' => false, 'expiresAt' => null];
        }
        try {
            $servers = json_decode($raw, true, 32, JSON_THROW_ON_ERROR);
        } catch (\JsonException $error) {
            throw new \UnexpectedValueException('Invalid ICE JSON', 0, $error);
        }
        if (!is_array($servers) || !array_is_list($servers) || count($servers) > self::MAX_SERVERS) {
            throw new \UnexpectedValueException('ICE servers must be a list of at most eight entries');
        }
        $validated = [];
        $turnExpiry = null;
        $hasTurnServer = false;
        foreach ($servers as $server) {
            if (!is_array($server)
                || array_diff(array_keys($server), ['urls', 'username', 'credential', 'expiresAt']) !== []
                || !is_array($server['urls'] ?? null)
                || !array_is_list($server['urls'])
                || $server['urls'] === []
                || count($server['urls']) > self::MAX_URLS_PER_SERVER) {
                throw new \UnexpectedValueException('ICE server shape is invalid');
            }
            $urls = [];
            $hasTurn = false;
            foreach ($server['urls'] as $url) {
                if (!is_string($url)
                    || $url === ''
                    || strlen($url) > 2048
                    // PHP escapes U+2028/U+2029 in its compact signing JSON,
                    // while serde_json emits them literally. Reject those two
                    // separators before signing so native verification cannot
                    // become runtime-dependent.
                    || preg_match('/[\x00-\x1F\x7F\x{2028}\x{2029}]/u', $url)
                    || preg_match('/^(?:stun|stuns|turn|turns):/i', $url) !== 1) {
                    throw new \UnexpectedValueException('ICE server URL is invalid');
                }
                if (preg_match('/^turns?:/i', $url) === 1) {
                    $hasTurn = true;
                    $hasTurnServer = true;
                }
                $urls[] = $url;
            }
            $username = $server['username'] ?? '';
            $credential = $server['credential'] ?? '';
            if (!is_string($username)
                || !is_string($credential)
                || strlen($username) > 512
                || strlen($credential) > 2048
                || preg_match('/[\x00-\x1F\x7F\x{2028}\x{2029}]/u', $username)
                || preg_match('/[\x00-\x1F\x7F\x{2028}\x{2029}]/u', $credential)) {
                throw new \UnexpectedValueException('ICE server credentials are invalid');
            }
            $entry = [
                'urls' => $urls,
                'username' => $username,
                'credential' => $credential,
            ];
            if ($hasTurn) {
                $expiresAt = $server['expiresAt'] ?? null;
                if ($username === '' || $credential === '' || !is_int($expiresAt)
                    || $expiresAt <= $now + self::TURN_MIN_REMAINING_SECONDS
                    || $expiresAt > $now + self::TURN_MAX_REMAINING_SECONDS) {
                    throw new \UnexpectedValueException('TURN credentials require an expiresAt Unix timestamp 31 seconds to 24 hours in the future');
                }
                $entry['expiresAt'] = $expiresAt;
                $turnExpiry = $turnExpiry === null ? $expiresAt : min($turnExpiry, $expiresAt);
            } elseif ($username !== '' || $credential !== '' || array_key_exists('expiresAt', $server)) {
                throw new \UnexpectedValueException('STUN-only entries must not contain TURN credentials or expiry');
            }
            $validated[] = $entry;
        }
        if ($relayOnly && !$hasTurnServer) {
            throw new \UnexpectedValueException('relayOnly requires at least one TURN or TURNS URL');
        }
        return ['servers' => $validated, 'relayOnly' => $relayOnly, 'expiresAt' => $turnExpiry];
    }
}
