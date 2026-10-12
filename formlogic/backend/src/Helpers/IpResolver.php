<?php

declare(strict_types=1);

namespace FormLogic\Helpers;

use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Secure IP address resolver that prevents IP spoofing attacks.
 *
 * By default, only trusts REMOTE_ADDR. When behind a trusted proxy (load balancer,
 * reverse proxy), you can configure trusted proxy IPs to enable reading from
 * X-Forwarded-For headers.
 *
 * SECURITY NOTE: Never blindly trust X-Forwarded-For headers as they can be
 * easily spoofed by attackers to bypass rate limiting and corrupt audit logs.
 */
class IpResolver
{
    /**
     * List of trusted proxy IP addresses or CIDR ranges.
     * Only requests from these IPs will have their X-Forwarded-For headers trusted.
     */
    private array $trustedProxies;

    /**
     * Headers to check for forwarded IP (in order of preference).
     * These are only checked if the request comes from a trusted proxy.
     */
    private const FORWARDED_HEADERS = [
        'HTTP_X_FORWARDED_FOR',
        'HTTP_X_REAL_IP',
        'HTTP_CLIENT_IP',
    ];

    /**
     * Private/reserved IP ranges that are commonly used by proxies.
     * These can optionally be auto-trusted for development environments.
     */
    private const PRIVATE_RANGES = [
        '10.0.0.0/8',
        '172.16.0.0/12',
        '192.168.0.0/16',
        '127.0.0.0/8',
        '::1/128',
        'fc00::/7',
    ];

    /** The headers TRUSTED_PROXY_HEADER may name, as server-param keys. */
    private const HEADER_NAMES = [
        'x-forwarded-for' => 'HTTP_X_FORWARDED_FOR',
        'x-real-ip' => 'HTTP_X_REAL_IP',
        'client-ip' => 'HTTP_CLIENT_IP',
    ];

    /** @var list<string> the forwarding headers read from a trusted proxy, in order */
    private array $forwardedHeaders;

    /** @var array<string, int> when each set of configuration problems was last logged by this process */
    private static array $problemsLoggedAt = [];

    /**
     * @param ?string $forwardedHeader the one header the trusted proxies write (x-forwarded-for,
     *   x-real-ip or client-ip, however written: see forwardedHeaderName). A client can send every
     *   one of them and a proxy passes on those it does not set, so naming it means the others
     *   are never read: a proxy that sets only X-Real-IP would otherwise hand on a client's own
     *   X-Forwarded-For, which is read first. Null keeps the order X-Forwarded-For, X-Real-IP,
     *   Client-IP, and so does a name outside those three: read as "trust no header", one typo
     *   made every client the proxy's own address, which is one rate-limit budget for the whole
     *   site. forwardedHeaderProblem() is what tells the operator about the typo.
     */
    public function __construct(array $trustedProxies = [], ?string $forwardedHeader = null)
    {
        $this->trustedProxies = $trustedProxies;
        $name = self::forwardedHeaderName($forwardedHeader);
        $this->forwardedHeaders = $name !== null ? [self::HEADER_NAMES[$name]] : self::FORWARDED_HEADERS;
    }

    /**
     * Which of the three headers a TRUSTED_PROXY_HEADER value names (a HEADER_NAMES key), or
     * null when it names none of them (or nothing). A header name is read however an operator
     * writes one: any case, "_" for "-", PHP's own "HTTP_" spelling, a trailing colon.
     */
    private static function forwardedHeaderName(?string $value): ?string
    {
        $name = str_replace('_', '-', strtolower(rtrim(trim((string) $value), ':')));
        if (str_starts_with($name, 'http-')) {
            $name = substr($name, 5);
        }
        return isset(self::HEADER_NAMES[$name]) ? $name : null;
    }

    /**
     * What is wrong with a TRUSTED_PROXY_HEADER value, in a sentence for the operator, or null
     * when it is unset or names a header this resolver reads.
     */
    public static function forwardedHeaderProblem(?string $value): ?string
    {
        if ($value === null || trim($value) === '' || self::forwardedHeaderName($value) !== null) {
            return null;
        }
        return 'TRUSTED_PROXY_HEADER is "' . self::printable($value) . '", which is not a header this server reads: set '
            . implode(', ', array_keys(self::HEADER_NAMES)) . ', or leave it unset. It is being read as unset ('
            . 'X-Forwarded-For, then X-Real-IP, then Client-IP), so a header your proxy does not write is taken from the client.';
    }

    /** The two settings as the environment has them: [TRUSTED_PROXIES entries, TRUSTED_PROXY_HEADER]. */
    private static function environment(): array
    {
        $trustedProxies = [];
        $envValue = getenv('TRUSTED_PROXIES') ?: ($_ENV['TRUSTED_PROXIES'] ?? '');

        if (!empty($envValue)) {
            $trustedProxies = array_map('trim', explode(',', $envValue));
            $trustedProxies = array_filter($trustedProxies);
        }
        $header = getenv('TRUSTED_PROXY_HEADER') ?: ($_ENV['TRUSTED_PROXY_HEADER'] ?? null);

        return [array_values($trustedProxies), is_string($header) ? $header : null];
    }

    /**
     * Create an instance with trusted proxies from environment variable.
     *
     * Set TRUSTED_PROXIES env var to a comma-separated list of IPs/CIDRs.
     * Example: TRUSTED_PROXIES=10.0.0.0/8,172.16.0.1
     */
    public static function fromEnvironment(): self
    {
        [$trustedProxies, $header] = self::environment();
        self::logProblems(self::problems($trustedProxies, $header));

        return new self($trustedProxies, $header);
    }

    /**
     * What is wrong with the two settings, one sentence each, for the operator.
     *
     * @param list<string> $trustedProxies
     * @return list<string>
     */
    private static function problems(array $trustedProxies, ?string $header): array
    {
        $problems = [];
        foreach ($trustedProxies as $entry) {
            if (!self::usableRange($entry)) {
                $problems[] = 'TRUSTED_PROXIES entry "' . self::printable($entry) . '" is not an IP address or a CIDR range, so it matches no proxy'
                    . ' (a proxy that is not matched is counted as the client, for every request it forwards).';
            } elseif (!self::isAddressOrRange($entry)) {
                $problems[] = 'TRUSTED_PROXIES entry "' . self::printable($entry) . '" has more than one "/": only the first prefix length is read.';
            }
        }
        $headerProblem = self::forwardedHeaderProblem($header);
        if ($headerProblem !== null) {
            $problems[] = $headerProblem;
        } elseif ($header !== null && trim($header) !== '' && $trustedProxies === []) {
            $problems[] = 'TRUSTED_PROXY_HEADER is set but TRUSTED_PROXIES is empty, so no forwarding header is read at all.';
        }
        return $problems;
    }

    /**
     * Say what is wrong in PHP's error log, for the operator who does not open the Doctor page.
     * PHP has no start-up to log at, and this runs on every request, so the same problems are
     * written at most once an hour (a marker file in the temp directory keeps the time).
     *
     * @param list<string> $problems
     */
    private static function logProblems(array $problems): void
    {
        if ($problems === []) {
            return;
        }
        $marker = self::problemMarker($problems);
        // Where the marker cannot be kept, at least once per request, not once per resolver.
        $last = @filemtime($marker);
        if ($last === false) {
            $last = self::$problemsLoggedAt[$marker] ?? false;
        }
        if ($last !== false && time() - $last < 3600) {
            return;
        }
        self::$problemsLoggedAt[$marker] = time();
        @touch($marker);
        error_log('FormLogic client addresses: ' . implode(' ', $problems) . ' (Admin > Doctor shows this as the client_addresses check.)');
    }

    /** @param list<string> $problems */
    private static function problemMarker(array $problems): string
    {
        return sys_get_temp_dir() . '/formlogic-client-addresses-' . substr(hash('sha256', implode("\n", $problems)), 0, 16) . '.warned';
    }

    /**
     * The client-address settings as the operator's health report shows them (the
     * `client_addresses` check of GET /api/health/deep, drawn by the admin Doctor page): ok
     * while TRUSTED_PROXIES and TRUSTED_PROXY_HEADER can be used as written, otherwise not ok
     * with a warning naming each problem. Never critical: a setting that cannot be used is
     * read as unset, so the site still serves. What it costs is that clients may no longer be
     * told apart (an unusable TRUSTED_PROXIES entry leaves the proxy untrusted, and every
     * client is then counted as the proxy) or may choose their own address.
     *
     * @return array{ok: bool, critical: bool, detail: string, warning?: string}
     */
    public static function healthCheck(): array
    {
        [$trustedProxies, $header] = self::environment();
        $problems = self::problems($trustedProxies, $header);

        $check = [
            'ok' => $problems === [],
            'critical' => false,
            'detail' => $trustedProxies === []
                ? 'no trusted proxy: every client is its connecting address'
                : count($trustedProxies) . ' trusted proxy entr' . (count($trustedProxies) === 1 ? 'y' : 'ies') . ', reading '
                    . (self::forwardedHeaderName($header) ?? 'x-forwarded-for, x-real-ip, client-ip (in that order)'),
        ];
        if ($problems !== []) {
            $check['warning'] = implode(' ', $problems);
        }
        return $check;
    }

    /** Whether a TRUSTED_PROXIES entry is written as it should be: an address, or address/bits. */
    private static function isAddressOrRange(string $entry): bool
    {
        return substr_count($entry, '/') <= 1 && self::usableRange($entry);
    }

    /**
     * Whether ipMatchesCidr can match an entry at all: a valid address, and after a "/" a prefix
     * length that is a number within the address's size. (Anything after a second "/" is
     * ignored, as it always was: "10.0.0.0/8/2" keeps matching as 10.0.0.0/8.)
     */
    private static function usableRange(string $entry): bool
    {
        $parts = explode('/', $entry);
        if (filter_var($parts[0], FILTER_VALIDATE_IP) === false) {
            return false;
        }
        if (count($parts) === 1) {
            return true;
        }
        $max = filter_var($parts[0], FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) !== false ? 128 : 32;
        return ctype_digit($parts[1]) && (int) $parts[1] <= $max;
    }

    /** A configured value as it can be shown in a message: printable ASCII, not too long. */
    private static function printable(string $value): string
    {
        return substr((string) preg_replace('/[^\x20-\x7E]/', '?', trim($value)), 0, 80);
    }

    /**
     * What a rate limit counts an address as: an IPv4 address itself; an IPv6 address by its /64,
     * since one subscriber is normally handed a whole /64 and may use any address in it (keyed by
     * the full address, each client had 2^64 budgets); an IPv4 address mapped into IPv6 as that
     * IPv4 address. Anything that is not an address is returned unchanged.
     */
    public static function rateLimitSubject(string $ip): string
    {
        $ip = self::unmapped($ip);
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) === false) {
            return $ip;
        }
        $bytes = inet_pton($ip);
        if ($bytes === false || strlen($bytes) !== 16) {
            return $ip;
        }
        return inet_ntop(substr($bytes, 0, 8) . str_repeat("\0", 8)) . '/64';
    }

    /**
     * An IPv4 address written as IPv4-mapped IPv6 (::ffff:a.b.c.d, how a dual-stack listener
     * reports an IPv4 peer) as that IPv4 address; anything else unchanged.
     */
    private static function unmapped(string $ip): string
    {
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) === false) {
            return $ip;
        }
        $bytes = inet_pton($ip);
        if ($bytes !== false && strlen($bytes) === 16 && substr($bytes, 0, 12) === str_repeat("\0", 10) . "\xff\xff") {
            return (string) inet_ntop(substr($bytes, 12));
        }
        return $ip;
    }

    /**
     * Get the client IP address from the request.
     *
     * @param Request $request The PSR-7 request object
     * @return string The client IP address (defaults to 127.0.0.1 if not determinable)
     */
    public function getClientIp(Request $request): string
    {
        $serverParams = $request->getServerParams();
        $remoteAddr = $serverParams['REMOTE_ADDR'] ?? '127.0.0.1';

        // If no trusted proxies configured, always use REMOTE_ADDR
        if (empty($this->trustedProxies)) {
            return $this->sanitizeIp($remoteAddr);
        }

        // Check if the direct connection is from a trusted proxy
        if (!$this->isTrustedProxy($remoteAddr)) {
            // Direct connection is not from a trusted proxy, use REMOTE_ADDR
            return $this->sanitizeIp($remoteAddr);
        }

        // Connection is from a trusted proxy, check forwarded headers
        foreach ($this->forwardedHeaders as $header) {
            if (!empty($serverParams[$header])) {
                $ip = $this->extractIpFromForwardedHeader($serverParams[$header]);
                if ($ip !== null) {
                    return $ip;
                }
            }
        }

        // Fallback to REMOTE_ADDR if no valid forwarded IP found
        return $this->sanitizeIp($remoteAddr);
    }

    /**
     * Extract the original client IP from a forwarded header value.
     *
     * X-Forwarded-For format: client, proxy1, proxy2, ...
     * We need to find the rightmost IP that is NOT a trusted proxy,
     * as that's the actual client IP.
     */
    private function extractIpFromForwardedHeader(string $headerValue): ?string
    {
        $ips = array_map('trim', explode(',', $headerValue));

        // Iterate from right to left to find the first non-trusted IP
        // This prevents attackers from prepending fake IPs to the header
        for ($i = count($ips) - 1; $i >= 0; $i--) {
            $ip = $this->sanitizeIp($ips[$i]);

            if (!$this->isValidIp($ip)) {
                continue;
            }

            // If this IP is not a trusted proxy, it's the client IP
            if (!$this->isTrustedProxy($ip)) {
                return $ip;
            }
        }

        // If all IPs are trusted proxies, return the leftmost (client)
        $firstIp = $this->sanitizeIp($ips[0]);
        return $this->isValidIp($firstIp) ? $firstIp : null;
    }

    /**
     * Check if an IP address is from a trusted proxy.
     */
    private function isTrustedProxy(string $ip): bool
    {
        foreach ($this->trustedProxies as $trusted) {
            if ($this->ipMatchesCidr($ip, $trusted)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Check if an IP matches a CIDR range or exact IP.
     */
    private function ipMatchesCidr(string $ip, string $cidr): bool
    {
        // An entry with no usable address or prefix length matches nothing (healthCheck reports
        // it). Read loosely, "10.0.0.0/" was a /0 that trusted every peer, and "10.0.0.0/33" a
        // negative shift that threw on every request.
        if (!self::usableRange($cidr)) {
            return false;
        }
        // ::ffff:a.b.c.d is the IPv4 address a.b.c.d, on either side.
        $ip = self::unmapped($ip);

        // Handle exact IP match: the same address, however either side spells it
        if (strpos($cidr, '/') === false) {
            $address = filter_var($ip, FILTER_VALIDATE_IP) !== false ? inet_pton($ip) : false;
            return $address !== false && $address === inet_pton(self::unmapped($cidr));
        }

        // Handle CIDR notation
        [$subnet, $bits] = explode('/', $cidr);
        $bits = (int) $bits;
        if ($bits >= 96 && self::unmapped($subnet) !== $subnet) {
            $subnet = self::unmapped($subnet);
            $bits -= 96;
        }

        // Handle IPv6
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6)) {
            if (!filter_var($subnet, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6)) {
                return false;
            }
            return $this->ipv6MatchesCidr($ip, $subnet, $bits);
        }

        // Handle IPv4
        if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            return false;
        }
        if (!filter_var($subnet, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            return false;
        }

        $ipLong = ip2long($ip);
        $subnetLong = ip2long($subnet);
        $mask = -1 << (32 - $bits);

        return ($ipLong & $mask) === ($subnetLong & $mask);
    }

    /**
     * Check if an IPv6 address matches a CIDR range.
     */
    private function ipv6MatchesCidr(string $ip, string $subnet, int $bits): bool
    {
        $ipBin = inet_pton($ip);
        $subnetBin = inet_pton($subnet);

        if ($ipBin === false || $subnetBin === false) {
            return false;
        }

        // Compare the first $bits bits
        $fullBytes = intdiv($bits, 8);
        $remainingBits = $bits % 8;

        // Compare full bytes
        for ($i = 0; $i < $fullBytes; $i++) {
            if ($ipBin[$i] !== $subnetBin[$i]) {
                return false;
            }
        }

        // Compare remaining bits
        if ($remainingBits > 0 && $fullBytes < 16) {
            $mask = 0xFF << (8 - $remainingBits);
            if ((ord($ipBin[$fullBytes]) & $mask) !== (ord($subnetBin[$fullBytes]) & $mask)) {
                return false;
            }
        }

        return true;
    }

    /**
     * Sanitize an IP address string.
     */
    private function sanitizeIp(string $ip): string
    {
        // Remove port if present (e.g., "[::1]:8080" or "127.0.0.1:8080")
        if (preg_match('/^\[([^\]]+)\](?::\d+)?$/', $ip, $matches)) {
            $ip = $matches[1];
        } elseif (preg_match('/^(\d+\.\d+\.\d+\.\d+):\d+$/', $ip, $matches)) {
            $ip = $matches[1];
        }

        return trim($ip);
    }

    /**
     * Check if an IP address is valid.
     */
    private function isValidIp(string $ip): bool
    {
        return filter_var($ip, FILTER_VALIDATE_IP) !== false;
    }

    /**
     * Add a trusted proxy IP or CIDR range.
     */
    public function addTrustedProxy(string $ipOrCidr): self
    {
        $this->trustedProxies[] = $ipOrCidr;
        return $this;
    }

    /**
     * Trust all private/reserved IP ranges.
     * Useful for development environments.
     *
     * WARNING: Do not use in production without understanding the implications.
     */
    public function trustPrivateNetworks(): self
    {
        foreach (self::PRIVATE_RANGES as $range) {
            if (!in_array($range, $this->trustedProxies, true)) {
                $this->trustedProxies[] = $range;
            }
        }
        return $this;
    }
}
