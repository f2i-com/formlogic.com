<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Issues the short-lived, socket-bound admission understood by the Aokie v2
 * signalling gateway.  It intentionally mirrors `aokie-protocol::v2` rather
 * than minting a general FormLogic credential: the bearer contains one app,
 * one native endpoint, one role, exact grants, and a maximum five-minute TTL.
 */
final class AokieCompanionAdmissionSigner
{
    public const AUDIENCE = 'aokie-v2-gateway';
    public const TOKEN_PREFIX = 'aokie-adm-v2';
    public const MAX_TTL_SECONDS = 300;
    public const MAX_SAFE_INTEGER = 9_007_199_254_740_991;
    /** verify() tolerance for clock drift between the issuer and a verifier. */
    public const CLOCK_SKEW_SECONDS = 30;
    /** issue() never comes close to this; anything longer is definitionally junk. */
    private const MAX_TOKEN_LENGTH = 16384;

    private const ROLES = ['mobile', 'plugin'];
    private const GRANTS = [
        'state_read',
        'caller_read',
        'captions_read',
        'participants_read',
        'participant_identity_read',
        'audio_levels_read',
        'monitor',
        'consult',
        'takeover',
        'resume_aokie',
        'rtc_signal',
        'assistance_read',
        'assistance_respond',
        'end_caller',
    ];

    public function __construct(
        private readonly string $secret,
        private readonly string $gatewayUrl,
    ) {
        if (strlen($secret) < 32 || strlen($secret) > 4096) {
            throw new \InvalidArgumentException('Aokie admission HMAC secret must be 32..4096 bytes');
        }
        if (!self::validGatewayUrl($gatewayUrl)) {
            throw new \InvalidArgumentException('Aokie gateway URL must be wss://, or loopback ws:// in development, and target /v2/realtime');
        }
    }

    public static function fromEnvironment(): ?self
    {
        $secret = trim((string) ($_ENV['AOKIE_COMPANION_ADMISSION_HMAC_SECRET'] ?? getenv('AOKIE_COMPANION_ADMISSION_HMAC_SECRET') ?: ''));
        $gateway = trim((string) ($_ENV['AOKIE_COMPANION_GATEWAY_URL'] ?? getenv('AOKIE_COMPANION_GATEWAY_URL') ?: ''));
        if ($secret === '' && $gateway === '') {
            return null;
        }
        if ($secret === '' || $gateway === '') {
            throw new \RuntimeException('Aokie Companion admission configuration is incomplete');
        }
        return new self($secret, $gateway);
    }

    /**
     * @param list<string> $scopes
     * @param list<string> $approvedPeerKeyThumbprints
     * @return array<string,mixed>
     */
    public function issue(
        string $appId,
        string $subjectId,
        string $role,
        array $scopes,
        string $holderKeyThumbprint,
        ?string $expectedPeerKeyThumbprint = null,
        array $approvedPeerKeyThumbprints = [],
        ?int $peerRosterRevision = null,
        ?string $peerRosterHash = null,
        int $ttlSeconds = 90,
        ?int $now = null,
        ?string $jti = null,
    ): array {
        $now ??= time();
        if (!self::safeId($appId) || !self::safeId($subjectId)) {
            throw new \InvalidArgumentException('Aokie admission appId and subjectId must be safe identifiers');
        }
        if (!in_array($role, self::ROLES, true)) {
            throw new \InvalidArgumentException('Aokie admission role must be mobile or plugin');
        }
        self::requireThumbprint($holderKeyThumbprint, 'holderKeyThumbprint');
        if ($role === 'mobile') {
            if ($expectedPeerKeyThumbprint === null) {
                throw new \InvalidArgumentException('Aokie mobile admissions require expectedPeerKeyThumbprint');
            }
            self::requireThumbprint($expectedPeerKeyThumbprint, 'expectedPeerKeyThumbprint');
            if ($approvedPeerKeyThumbprints !== [] || $peerRosterRevision !== null || $peerRosterHash !== null) {
                throw new \InvalidArgumentException('Aokie mobile admissions cannot carry a plugin peer roster');
            }
        } else {
            if ($expectedPeerKeyThumbprint !== null) {
                throw new \InvalidArgumentException('Aokie plugin admissions cannot carry expectedPeerKeyThumbprint');
            }
            $approvedPeerKeyThumbprints = self::validatePluginPeerPolicy(
                $approvedPeerKeyThumbprints,
                $peerRosterRevision,
                $peerRosterHash,
            );
        }
        $scopes = array_values(array_unique($scopes));
        if (count($scopes) > 16 || array_diff($scopes, self::GRANTS) !== []) {
            throw new \InvalidArgumentException('Aokie admission contains an unsupported grant');
        }
        if ($role === 'mobile' && !in_array('state_read', $scopes, true)) {
            throw new \InvalidArgumentException('Aokie mobile admissions require state_read');
        }
        $ttlSeconds = max(1, min(self::MAX_TTL_SECONDS, $ttlSeconds));
        $expiresAt = $now + $ttlSeconds;
        // Insertion order is stable by design. The Rust verifier accepts any
        // JSON object order, but deterministic output makes cross-language
        // fixtures and incident investigation substantially easier.
        $claims = [
            'aud' => self::AUDIENCE,
            'appId' => $appId,
            'subjectId' => $subjectId,
            'role' => $role,
            'holderKeyThumbprint' => $holderKeyThumbprint,
        ];
        if ($role === 'mobile') {
            $claims['expectedPeerKeyThumbprint'] = $expectedPeerKeyThumbprint;
        } else {
            $claims['approvedPeerKeyThumbprints'] = $approvedPeerKeyThumbprints;
            $claims['peerRosterRevision'] = $peerRosterRevision;
            $claims['peerRosterHash'] = $peerRosterHash;
        }
        $claims['scopes'] = $scopes;
        $claims['exp'] = $expiresAt;
        $claims['jti'] = $jti ?? ('adm_' . bin2hex(random_bytes(16)));
        if (!self::safeId($claims['jti'])) {
            throw new \InvalidArgumentException('Aokie admission jti must be a safe identifier');
        }
        $payload = json_encode($claims, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        $signature = hash_hmac('sha256', $payload, $this->secret, true);
        $token = self::TOKEN_PREFIX . '.' . bin2hex($payload) . '.' . bin2hex($signature);

        $response = [
            'accessToken' => $token,
            'tokenType' => 'Bearer',
            'expiresIn' => $ttlSeconds,
            'expiresAt' => $expiresAt,
            'gatewayUrl' => $this->gatewayUrl,
            'appId' => $appId,
            'subjectId' => $subjectId,
            'role' => $role,
            'holderKeyThumbprint' => $holderKeyThumbprint,
            'scopes' => $scopes,
        ];
        if ($role === 'mobile') {
            $response['expectedPeerKeyThumbprint'] = $expectedPeerKeyThumbprint;
        } else {
            $response['approvedPeerKeyThumbprints'] = $approvedPeerKeyThumbprints;
            $response['peerRosterRevision'] = $peerRosterRevision;
            $response['peerRosterHash'] = $peerRosterHash;
        }
        return $response;
    }

    /**
     * Verify a previously issued admission token and return its claims.
     *
     * This is the FormLogic-hosted counterpart of the Rust gateway's verifier:
     * exact prefix + hex(JSON) + HMAC-SHA256 over the raw payload bytes
     * (constant-time compare), required audience, and expiry with a bounded
     * clock-skew allowance. The bearer is UNTRUSTED input, so — matching
     * `McpTokenService::validate` — every invalid shape returns null rather
     * than throwing; issue()-side misuse keeps its typed exceptions.
     *
     * @return array<string,mixed>|null the verified claims, or null for any
     *         malformed, tampered, mis-audienced, or expired token
     */
    public function verify(string $token, ?int $now = null): ?array
    {
        $now ??= time();
        if ($token === '' || strlen($token) > self::MAX_TOKEN_LENGTH) {
            return null;
        }
        $parts = explode('.', $token);
        if (count($parts) !== 3 || $parts[0] !== self::TOKEN_PREFIX) {
            return null;
        }
        [, $payloadHex, $signatureHex] = $parts;
        if ($payloadHex === ''
            || strlen($payloadHex) % 2 !== 0
            || !ctype_xdigit($payloadHex)
            || strlen($signatureHex) !== 64
            || !ctype_xdigit($signatureHex)) {
            return null;
        }
        $payload = hex2bin($payloadHex);
        $signature = hex2bin($signatureHex);
        if ($payload === false || $signature === false) {
            return null;
        }
        $expected = hash_hmac('sha256', $payload, $this->secret, true);
        if (!hash_equals($expected, $signature)) {
            return null;
        }
        try {
            $claims = json_decode($payload, true, 8, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return null;
        }
        if (!is_array($claims) || array_is_list($claims)) {
            return null;
        }
        if (($claims['aud'] ?? null) !== self::AUDIENCE) {
            return null;
        }
        $exp = $claims['exp'] ?? null;
        if (!is_int($exp) || $exp < 0 || $exp > self::MAX_SAFE_INTEGER) {
            return null;
        }
        if ($now > $exp + self::CLOCK_SKEW_SECONDS) {
            return null;
        }
        // Structural claim checks mirror what issue() guarantees; a token that
        // passed the HMAC but violates these was minted by other software and
        // is refused rather than interpreted loosely.
        if (!is_string($claims['appId'] ?? null) || !self::safeId($claims['appId'])
            || !is_string($claims['subjectId'] ?? null) || !self::safeId($claims['subjectId'])
            || !is_string($claims['jti'] ?? null) || !self::safeId($claims['jti'])
            || !in_array($claims['role'] ?? null, self::ROLES, true)
            || !self::validThumbprint($claims['holderKeyThumbprint'] ?? null)) {
            return null;
        }
        $scopes = $claims['scopes'] ?? null;
        if (!is_array($scopes)
            || !array_is_list($scopes)
            || count($scopes) > 16
            || array_diff($scopes, self::GRANTS) !== []) {
            return null;
        }
        return $claims;
    }

    public function gatewayUrl(): string
    {
        return $this->gatewayUrl;
    }

    public static function safeId(string $value): bool
    {
        return $value !== ''
            && strlen($value) <= 200
            && preg_match('/^[A-Za-z0-9_.:-]+$/D', $value) === 1;
    }

    public static function validThumbprint(mixed $value): bool
    {
        if (!is_string($value) || preg_match('/^[A-Za-z0-9_-]{43}$/D', $value) !== 1) {
            return false;
        }
        $decoded = self::base64UrlDecode($value);
        return $decoded !== null
            && strlen($decoded) === 32
            && hash_equals(self::base64UrlEncode($decoded), $value);
    }

    public static function requireThumbprint(mixed $value, string $field): string
    {
        if (!self::validThumbprint($value)) {
            throw new \InvalidArgumentException("{$field} must be an RFC7638 SHA-256 base64url thumbprint");
        }
        return $value;
    }

    /** @return array{algorithm:string,publicKey:string,thumbprint:string} */
    public static function validateEndpointPublicKey(mixed $value): array
    {
        if (!is_array($value)
            || array_is_list($value)
            || array_diff(array_keys($value), ['algorithm', 'publicKey', 'thumbprint']) !== []
            || array_diff(['algorithm', 'publicKey', 'thumbprint'], array_keys($value)) !== []
            || ($value['algorithm'] ?? null) !== 'ed25519'
            || !is_string($value['publicKey'] ?? null)) {
            throw new \InvalidArgumentException('endpointPublicKey must be an exact Ed25519 public-key object');
        }
        $publicKey = $value['publicKey'];
        $decoded = self::base64UrlDecode($publicKey);
        if ($decoded === null || strlen($decoded) !== 32 || self::base64UrlEncode($decoded) !== $publicKey) {
            throw new \InvalidArgumentException('endpointPublicKey.publicKey must be a canonical 32-byte base64url value');
        }
        $thumbprint = self::requireThumbprint($value['thumbprint'] ?? null, 'endpointPublicKey.thumbprint');
        if (!hash_equals(self::endpointThumbprint($publicKey), $thumbprint)) {
            throw new \InvalidArgumentException('endpointPublicKey thumbprint does not match its public key');
        }
        return [
            'algorithm' => 'ed25519',
            'publicKey' => $publicKey,
            'thumbprint' => $thumbprint,
        ];
    }

    public static function endpointThumbprint(string $publicKey): string
    {
        $canonical = json_encode(
            ['crv' => 'Ed25519', 'kty' => 'OKP', 'x' => $publicKey],
            JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR,
        );
        return self::base64UrlEncode(hash('sha256', $canonical, true));
    }

    /**
     * Match `aokie_protocol::v2::peer_roster_hash` byte-for-byte.
     * @param list<string> $thumbprints
     */
    public static function peerRosterHash(int $revision, array $thumbprints): string
    {
        $sorted = $thumbprints;
        sort($sorted, SORT_STRING);
        $canonical = json_encode([
            'approvedPeerKeyThumbprints' => $sorted,
            'peerRosterRevision' => $revision,
        ], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        return self::base64UrlEncode(hash('sha256', "aokie/v2/peer-roster\0" . $canonical, true));
    }

    /**
     * @param mixed $thumbprints
     * @return list<string>
     */
    public static function validatePluginPeerPolicy(
        mixed $thumbprints,
        mixed $revision,
        mixed $rosterHash,
    ): array {
        if (!is_array($thumbprints)
            || !array_is_list($thumbprints)
            || $thumbprints === []
            || count($thumbprints) > 64) {
            throw new \InvalidArgumentException('approvedPeerKeyThumbprints must contain 1..64 keys');
        }
        $previous = null;
        foreach ($thumbprints as $thumbprint) {
            $thumbprint = self::requireThumbprint($thumbprint, 'approvedPeerKeyThumbprints');
            if ($previous !== null && strcmp($previous, $thumbprint) >= 0) {
                throw new \InvalidArgumentException('approvedPeerKeyThumbprints must be sorted and unique');
            }
            $previous = $thumbprint;
        }
        if (!is_int($revision) || $revision < 1 || $revision > self::MAX_SAFE_INTEGER) {
            throw new \InvalidArgumentException('peerRosterRevision must be a positive safe integer');
        }
        $rosterHash = self::requireThumbprint($rosterHash, 'peerRosterHash');
        if (!hash_equals(self::peerRosterHash($revision, $thumbprints), $rosterHash)) {
            throw new \InvalidArgumentException('peerRosterHash does not match the revision and approved peers');
        }
        /** @var list<string> $thumbprints */
        return $thumbprints;
    }

    private static function base64UrlEncode(string $value): string
    {
        return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
    }

    private static function base64UrlDecode(string $value): ?string
    {
        if ($value === '' || preg_match('/^[A-Za-z0-9_-]+$/D', $value) !== 1) {
            return null;
        }
        $padding = (4 - strlen($value) % 4) % 4;
        $decoded = base64_decode(strtr($value, '-_', '+/') . str_repeat('=', $padding), true);
        return $decoded === false ? null : $decoded;
    }

    private static function validGatewayUrl(string $url): bool
    {
        $parts = parse_url($url);
        if (!is_array($parts)
            || ($parts['path'] ?? '') !== '/v2/realtime'
            || isset($parts['user'])
            || isset($parts['pass'])
            || isset($parts['query'])
            || isset($parts['fragment'])
            || empty($parts['host'])) {
            return false;
        }
        $scheme = strtolower((string) ($parts['scheme'] ?? ''));
        if ($scheme === 'wss') {
            return true;
        }
        $environment = (string) ($_ENV['APP_ENV'] ?? getenv('APP_ENV') ?: 'production');
        return $scheme === 'ws'
            && $environment === 'development'
            && in_array(strtolower((string) $parts['host']), ['127.0.0.1', 'localhost', '::1'], true);
    }
}
