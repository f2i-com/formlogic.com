<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * The ICE (STUN/TURN) servers an Aokie Companion is told to use: in the signed discovery document
 * and in every plugin and mobile admission. What comes back is the exact shape the native
 * Companion parses (it rejects unknown members): a list of `{urls, username, credential[, expiresAt]}`
 * entries, the relay policy, and `expiresAt` — the earliest expiry among the TURN entries returned,
 * because the Companion checks that it equals that, and null when there are none.
 *
 * Two ways to configure it; TURN REST wins when both are set:
 *
 *  1. TURN REST minting (AOKIE_COMPANION_TURN_REST_SECRET + AOKIE_COMPANION_TURN_REST_URLS): the
 *     scheme coturn's `use-auth-secret` expects and Aokie's self-host bundle documents
 *     (deploy/companion-self-host/README.md, "Expiring TURN REST credentials"). Each admission
 *     gets its own short-lived credential, so nothing has to be renewed by hand:
 *         username   = <expiry unix seconds>:<opaque id>
 *         credential = base64(HMAC-SHA1(secret, username))
 *     The opaque id is a keyed hash of the endpoint (role, app, device), so coturn's per-user quota
 *     still means something, TURN logs carry no device ids, and it is lowercase hex, which can
 *     never contain the ':' that separates it from the expiry.
 *
 *  2. A static list (AOKIE_COMPANION_ICE_SERVERS_JSON) whose TURN entries carry an `expiresAt`. A
 *     malformed list fails closed, with an \UnexpectedValueException that says why in the log (the
 *     Companion only ever sees a 503). A TURN entry whose credential has LAPSED no longer takes
 *     every discovery and admission down with it: it is left out, a warning is logged, and every
 *     STUN and unexpired TURN entry still applies — STUN alone still lets phones connect directly.
 *     Only a relay-only deployment, which cannot work without TURN, keeps failing.
 *
 * Discovery is public and unauthenticated, so it never mints a credential per request. It lists the
 * STUN URLs and, only when the deployment is relay-only — the Companion refuses such a document
 * without a TURN entry — one shared bootstrap credential that changes once per lifetime window, so
 * every anonymous caller in a window sees the same username, just as a static list has always
 * exposed one credential. Fresh, per-endpoint credentials go to the authenticated admissions only.
 */
final class AokieCompanionIceConfiguration
{
    public const MAX_SERVERS = 8;
    public const MAX_URLS_PER_SERVER = 8;
    /** The Companion refuses a TURN credential with this many seconds or fewer left... */
    public const TURN_MIN_REMAINING_SECONDS = 30;
    /** ...and one more than this far ahead. */
    public const TURN_MAX_REMAINING_SECONDS = 86400;

    public const REST_DEFAULT_TTL_SECONDS = 600;
    /** The same bounds Aokie's reference minter enforces (coturn's allocation lifetime tops out at 3600). */
    public const REST_MIN_TTL_SECONDS = 60;
    public const REST_MAX_TTL_SECONDS = 3600;

    private const OPAQUE_ID_LENGTH = 32;

    /** @var \Closure(string): void */
    private readonly \Closure $log;

    /**
     * Every value is the raw setting ('' when unset); nothing is validated until a configuration
     * is asked for, so constructing one never throws.
     *
     * @param (callable(string): void)|null $log receives operator-facing warnings; error_log() by default
     */
    public function __construct(
        private readonly string $relayOnly = '',
        private readonly string $staticServersJson = '',
        private readonly string $turnRestSecret = '',
        private readonly string $turnRestUrls = '',
        private readonly string $turnRestTtlSeconds = '',
        ?callable $log = null,
    ) {
        $this->log = $log !== null
            ? \Closure::fromCallable($log)
            : static function (string $message): void {
                error_log($message);
            };
    }

    /**
     * @param callable(string): string $environment reads one setting by name, '' when unset
     * @param (callable(string): void)|null $log
     */
    public static function fromEnvironment(callable $environment, ?callable $log = null): self
    {
        return new self(
            trim($environment('AOKIE_COMPANION_RELAY_ONLY')),
            trim($environment('AOKIE_COMPANION_ICE_SERVERS_JSON')),
            trim($environment('AOKIE_COMPANION_TURN_REST_SECRET')),
            trim($environment('AOKIE_COMPANION_TURN_REST_URLS')),
            trim($environment('AOKIE_COMPANION_TURN_REST_TTL_SECONDS')),
            $log,
        );
    }

    /**
     * The public discovery document's ICE bootstrap. Never mints a credential of its own per request.
     *
     * @return array{servers:list<array<string,mixed>>,relayOnly:bool,expiresAt:?int}
     * @throws \UnexpectedValueException when the operator's ICE/relay policy is unsafe or incomplete
     */
    public function forDiscovery(?int $now = null): array
    {
        return $this->resolve($now ?? time(), null);
    }

    /**
     * One authenticated endpoint's admission. $role is 'plugin' or 'mobile'; the ids are the same
     * ones the admission token is issued for.
     *
     * @return array{servers:list<array<string,mixed>>,relayOnly:bool,expiresAt:?int}
     * @throws \UnexpectedValueException when the operator's ICE/relay policy is unsafe or incomplete
     */
    public function forAdmission(string $role, string $appId, string $subjectId, ?int $now = null): array
    {
        return $this->resolve($now ?? time(), $role . "\0" . $appId . "\0" . $subjectId);
    }

    /**
     * The credential coturn's use-auth-secret accepts: "<expiry>:<opaque id>" and the base64 of its
     * HMAC-SHA1 under the shared secret. Pure, so it can be checked against known answers.
     *
     * @return array{username:string,credential:string}
     */
    public static function mintTurnRestCredential(string $secret, int $expiresAt, string $opaqueId): array
    {
        $username = $expiresAt . ':' . $opaqueId;
        return [
            'username' => $username,
            'credential' => base64_encode(hash_hmac('sha1', $username, $secret, true)),
        ];
    }

    /**
     * A stable, non-reversible id for one endpoint (or for "discovery"), safe to put in a TURN
     * username: lowercase hex, keyed with the shared secret.
     */
    public static function opaqueId(string $secret, string $subject): string
    {
        return substr(hash_hmac('sha256', "aokie-turn-id\0" . $subject, $secret), 0, self::OPAQUE_ID_LENGTH);
    }

    /**
     * @param ?string $admittedSubject the endpoint an authenticated admission is for; null for public discovery
     * @return array{servers:list<array<string,mixed>>,relayOnly:bool,expiresAt:?int}
     */
    private function resolve(int $now, ?string $admittedSubject): array
    {
        try {
            if (!in_array($this->relayOnly, ['', 'true', 'false'], true)) {
                throw new \UnexpectedValueException('AOKIE_COMPANION_RELAY_ONLY must be true or false');
            }
            $relayOnly = $this->relayOnly === 'true';
            if ($this->turnRestSecret !== '' || $this->turnRestUrls !== '') {
                return $this->fromTurnRest($relayOnly, $now, $admittedSubject);
            }
            return $this->fromStaticList($relayOnly, $now);
        } catch (\UnexpectedValueException $error) {
            // The 503 the Companion sees says nothing about why; the operator's log has to.
            $this->warn('configuration refused, so discovery and every admission answer 503 ice_configuration_invalid until it is fixed: ' . $error->getMessage());
            throw $error;
        }
    }

    /**
     * @return array{servers:list<array<string,mixed>>,relayOnly:bool,expiresAt:?int}
     */
    private function fromTurnRest(bool $relayOnly, int $now, ?string $admittedSubject): array
    {
        $secret = $this->turnRestSecret;
        if ($secret === '' || $this->turnRestUrls === '') {
            throw new \UnexpectedValueException('TURN REST minting needs both AOKIE_COMPANION_TURN_REST_SECRET and AOKIE_COMPANION_TURN_REST_URLS');
        }
        // The same rules the self-host bundle applies to the secret coturn shares with the issuer.
        if (strlen($secret) < 32 || strlen($secret) > 4096
            || str_contains($secret, 'REPLACE') || str_contains($secret, 'CHANGE_ME')) {
            throw new \UnexpectedValueException('AOKIE_COMPANION_TURN_REST_SECRET must be 32 to 4096 bytes and not a placeholder');
        }
        $ttl = self::REST_DEFAULT_TTL_SECONDS;
        if ($this->turnRestTtlSeconds !== '') {
            if (preg_match('/^[0-9]{1,5}\z/', $this->turnRestTtlSeconds) !== 1) {
                throw new \UnexpectedValueException('AOKIE_COMPANION_TURN_REST_TTL_SECONDS must be a whole number of seconds');
            }
            $ttl = (int) $this->turnRestTtlSeconds;
            if ($ttl < self::REST_MIN_TTL_SECONDS || $ttl > self::REST_MAX_TTL_SECONDS) {
                throw new \UnexpectedValueException('AOKIE_COMPANION_TURN_REST_TTL_SECONDS must be between ' . self::REST_MIN_TTL_SECONDS . ' and ' . self::REST_MAX_TTL_SECONDS);
            }
        }

        $urls = preg_split('/[\s,]+/', $this->turnRestUrls, -1, PREG_SPLIT_NO_EMPTY);
        if ($urls === false || $urls === [] || count($urls) > self::MAX_URLS_PER_SERVER) {
            throw new \UnexpectedValueException('AOKIE_COMPANION_TURN_REST_URLS must list between one and ' . self::MAX_URLS_PER_SERVER . ' URLs');
        }
        $stun = [];
        $turn = [];
        foreach ($urls as $url) {
            try {
                $isTurn = self::urlIsTurn(self::checkedUrl($url));
            } catch (\UnexpectedValueException) {
                throw new \UnexpectedValueException('AOKIE_COMPANION_TURN_REST_URLS holds an invalid ICE URL (stun:, stuns:, turn: or turns: only, separated by commas)');
            }
            if ($isTurn) {
                $turn[] = $url;
            } else {
                $stun[] = $url;
            }
        }
        if ($turn === []) {
            throw new \UnexpectedValueException('AOKIE_COMPANION_TURN_REST_URLS must include at least one turn: or turns: URL');
        }

        $servers = [];
        if ($stun !== []) {
            $servers[] = ['urls' => $stun, 'username' => '', 'credential' => ''];
        }
        if ($admittedSubject !== null) {
            $expiresAt = $now + $ttl;
            $opaqueId = self::opaqueId($secret, $admittedSubject);
        } elseif ($relayOnly) {
            // Discovery cannot be authenticated, yet a relay-only Companion will not accept it
            // without TURN. One credential per lifetime window, the same for every caller, and
            // never closer than a full lifetime to lapsing (so always above the 30 seconds the
            // Companion insists on).
            $expiresAt = (intdiv($now, $ttl) + 2) * $ttl;
            $opaqueId = self::opaqueId($secret, 'discovery');
        } else {
            return ['servers' => $servers, 'relayOnly' => false, 'expiresAt' => null];
        }
        $minted = self::mintTurnRestCredential($secret, $expiresAt, $opaqueId);
        $servers[] = [
            'urls' => $turn,
            'username' => $minted['username'],
            'credential' => $minted['credential'],
            'expiresAt' => $expiresAt,
        ];
        return ['servers' => $servers, 'relayOnly' => $relayOnly, 'expiresAt' => $expiresAt];
    }

    /**
     * @return array{servers:list<array<string,mixed>>,relayOnly:bool,expiresAt:?int}
     */
    private function fromStaticList(bool $relayOnly, int $now): array
    {
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
        /** @var list<array{int,string,int}> $lapsed entry position, its first URL, when its credential ran out */
        $lapsed = [];
        foreach ($servers as $position => $server) {
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
                if (self::urlIsTurn(self::checkedUrl($url))) {
                    $hasTurn = true;
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
                // Missing or malformed, or further ahead than a short-lived credential may be:
                // a mistake in the configuration, so it stays loud.
                if ($username === '' || $credential === '' || !is_int($expiresAt)
                    || $expiresAt > $now + self::TURN_MAX_REMAINING_SECONDS) {
                    throw new \UnexpectedValueException('TURN credentials require an expiresAt Unix timestamp 31 seconds to 24 hours in the future');
                }
                if ($expiresAt <= $now + self::TURN_MIN_REMAINING_SECONDS) {
                    // Lapsed (or about to be: the Companion refuses one with 30 seconds left).
                    $lapsed[] = [$position, $urls[0], $expiresAt];
                    continue;
                }
                $hasTurnServer = true;
                $entry['expiresAt'] = $expiresAt;
                $turnExpiry = $turnExpiry === null ? $expiresAt : min($turnExpiry, $expiresAt);
            } elseif ($username !== '' || $credential !== '' || array_key_exists('expiresAt', $server)) {
                throw new \UnexpectedValueException('STUN-only entries must not contain TURN credentials or expiry');
            }
            $validated[] = $entry;
        }
        if ($lapsed !== []) {
            $this->warn(sprintf(
                '%d TURN %s in AOKIE_COMPANION_ICE_SERVERS_JSON lapsed and %s left out (%s); every STUN and unexpired TURN entry still applies. '
                . 'Renew the credentials in that list, or set AOKIE_COMPANION_TURN_REST_SECRET and AOKIE_COMPANION_TURN_REST_URLS so FormLogic mints them itself.',
                count($lapsed),
                count($lapsed) === 1 ? 'entry' : 'entries',
                count($lapsed) === 1 ? 'was' : 'were',
                implode('; ', array_map(
                    static fn (array $gone): string => sprintf('entry %d, %s, ran out %s', $gone[0] + 1, $gone[1], gmdate('Y-m-d\TH:i:s\Z', $gone[2])),
                    $lapsed,
                )),
            ));
        }
        if ($relayOnly && !$hasTurnServer) {
            throw new \UnexpectedValueException('relayOnly requires at least one TURN or TURNS URL with an unexpired credential');
        }
        return ['servers' => $validated, 'relayOnly' => $relayOnly, 'expiresAt' => $turnExpiry];
    }

    /**
     * One ICE URL, or a refusal.
     *
     * @throws \UnexpectedValueException
     */
    private static function checkedUrl(mixed $url): string
    {
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
        return $url;
    }

    private static function urlIsTurn(string $url): bool
    {
        return preg_match('/^turns?:/i', $url) === 1;
    }

    private function warn(string $message): void
    {
        ($this->log)('Aokie Companion ICE: ' . $message);
    }
}
