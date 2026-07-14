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

    public function __construct(array $trustedProxies = [])
    {
        $this->trustedProxies = $trustedProxies;
    }

    /**
     * Create an instance with trusted proxies from environment variable.
     *
     * Set TRUSTED_PROXIES env var to a comma-separated list of IPs/CIDRs.
     * Example: TRUSTED_PROXIES=10.0.0.0/8,172.16.0.1
     */
    public static function fromEnvironment(): self
    {
        $trustedProxies = [];
        $envValue = getenv('TRUSTED_PROXIES') ?: ($_ENV['TRUSTED_PROXIES'] ?? '');

        if (!empty($envValue)) {
            $trustedProxies = array_map('trim', explode(',', $envValue));
            $trustedProxies = array_filter($trustedProxies);
        }

        return new self($trustedProxies);
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
        foreach (self::FORWARDED_HEADERS as $header) {
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
        // Handle exact IP match
        if (strpos($cidr, '/') === false) {
            return $ip === $cidr;
        }

        // Handle CIDR notation
        [$subnet, $bits] = explode('/', $cidr);
        $bits = (int) $bits;

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
