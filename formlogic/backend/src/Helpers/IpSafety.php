<?php

declare(strict_types=1);

namespace FormLogic\Helpers;

/**
 * SSRF-safety for outbound access to a user-supplied host: reject hostnames that resolve to
 * private / loopback / link-local / reserved / cloud-metadata IPs. Call resolvesToPublicHost()
 * immediately BEFORE any connect/probe — DNS can change after a domain was first verified, so the
 * fetch-time check is the load-bearing one.
 *
 * Mirrors the IP-range policy WebhookService uses for webhook URLs (FILTER_FLAG_NO_PRIV_RANGE |
 * FILTER_FLAG_NO_RES_RANGE + IPv4-mapped-IPv6 unwrap), extracted so any new consumer (the custom-domain
 * TLS/ingress probe) shares one authority instead of drifting.
 */
class IpSafety
{
    /** Hosts/IPs that must never be reached (cloud metadata + loopback, incl. IPv4-mapped IPv6). */
    private const BLOCKED_HOSTS = [
        'localhost', '127.0.0.1', '169.254.169.254', 'metadata.google.internal',
        'metadata.azure.internal', '0.0.0.0', '::1', '::ffff:127.0.0.1',
        '::ffff:0:127.0.0.1', '::ffff:169.254.169.254', '::ffff:0.0.0.0',
    ];

    /** True when $ip is a public, routable address (not private/reserved/loopback/link-local). */
    public static function isPublicIp(string $ip): bool
    {
        return !self::isPrivateAddress($ip);
    }

    /**
     * The classifier behind every outbound-request guard (form scripts, webhooks,
     * the MCP client-metadata fetch). Classifies IPv6 by its 16 BYTES, never by the
     * textual form: dns_get_record() reports AAAA answers as hex groups, and the
     * previous dotted-only unwrap of `::ffff:a.b.c.d` let `::ffff:a9fe:a9fe`
     * (169.254.169.254) through as public.
     */
    public static function isPrivateAddress(string $ip): bool
    {
        $ip = trim($ip, "[] \t\n\r");
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false) {
            if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) {
                return true;
            }
            // Ranges PHP's filter does not treat as reserved but that are never a
            // legitimate outbound target: carrier-grade NAT 100.64.0.0/10 (where some
            // cloud metadata services live, e.g. 100.100.100.200), the IETF
            // protocol-assignments block 192.0.0.0/24, and benchmarking 198.18.0.0/15.
            $n = ip2long($ip);
            if ($n === false) {
                return true;
            }
            $inCidr = static fn (string $base, int $bits): bool =>
                ($n >> (32 - $bits)) === (ip2long($base) >> (32 - $bits));
            return $inCidr('100.64.0.0', 10) || $inCidr('192.0.0.0', 24) || $inCidr('198.18.0.0', 15);
        }

        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) === false) {
            return true; // not an address at all: refuse
        }
        $expanded = @inet_pton($ip);
        if ($expanded === false || strlen($expanded) !== 16) {
            return true;
        }
        /** @var list<int> $b */
        $b = array_values(unpack('C16', $expanded));
        $v4At = static fn (int $off): string => sprintf('%d.%d.%d.%d', $b[$off], $b[$off + 1], $b[$off + 2], $b[$off + 3]);
        $zeroThrough = static function (int $count) use ($b): bool {
            for ($i = 0; $i < $count; $i++) {
                if ($b[$i] !== 0) {
                    return false;
                }
            }
            return true;
        };

        // :: (unspecified) and ::1 (loopback)
        if ($zeroThrough(15) && ($b[15] === 0 || $b[15] === 1)) {
            return true;
        }
        // IPv4-mapped ::ffff:0:0/96 — the embedded IPv4 decides, whatever the spelling.
        if ($zeroThrough(10) && $b[10] === 0xff && $b[11] === 0xff) {
            return self::isPrivateAddress($v4At(12));
        }
        // IPv4-compatible ::a.b.c.d (deprecated; nothing legitimate is reached this way).
        if ($zeroThrough(12)) {
            return true;
        }
        // NAT64 64:ff9b::/96 — the embedded IPv4 decides.
        if ($b[0] === 0x00 && $b[1] === 0x64 && $b[2] === 0xff && $b[3] === 0x9b) {
            return self::isPrivateAddress($v4At(12));
        }
        // 6to4 2002:a.b.c.d::/48 — the embedded IPv4 decides.
        if ($b[0] === 0x20 && $b[1] === 0x02) {
            return self::isPrivateAddress($v4At(2));
        }
        // Teredo 2001:0::/32 embeds an obfuscated IPv4; nothing here should need it.
        if ($b[0] === 0x20 && $b[1] === 0x01 && $b[2] === 0x00 && $b[3] === 0x00) {
            return true;
        }
        // Documentation 2001:db8::/32
        if ($b[0] === 0x20 && $b[1] === 0x01 && $b[2] === 0x0d && $b[3] === 0xb8) {
            return true;
        }
        // Discard-only 100::/64
        if ($b[0] === 0x01 && $b[1] === 0x00 && $b[2] === 0 && $b[3] === 0 && $b[4] === 0 && $b[5] === 0 && $b[6] === 0 && $b[7] === 0) {
            return true;
        }
        // Link-local fe80::/10
        if ($b[0] === 0xfe && ($b[1] & 0xc0) === 0x80) {
            return true;
        }
        // Unique local fc00::/7
        if (($b[0] & 0xfe) === 0xfc) {
            return true;
        }
        // Site-local (deprecated) fec0::/10
        if ($b[0] === 0xfe && ($b[1] & 0xc0) === 0xc0) {
            return true;
        }
        // Multicast ff00::/8 — never a unicast destination.
        if ($b[0] === 0xff) {
            return true;
        }
        return false;
    }

    /**
     * Resolve $host (A + AAAA, following any CNAME chain the resolver walks) and return true only if it
     * resolves to at least one IP and EVERY resolved IP is public. Any private/reserved/blocked IP → false.
     *
     * @param string|null $error set to a user-facing reason when false
     */
    public static function resolvesToPublicHost(string $host, ?string &$error = null, ?string &$approvedIp = null): bool
    {
        $error = null;
        $approvedIp = null;
        $host = strtolower(trim($host, " \t\n\r\0\x0B[]"));
        if ($host === '' || in_array($host, self::BLOCKED_HOSTS, true)) {
            $error = 'Host is not allowed';
            return false;
        }
        // A raw IP literal: check it directly (no resolution).
        if (filter_var($host, FILTER_VALIDATE_IP) !== false) {
            if (!self::isPublicIp($host)) {
                $error = 'Host is a private or reserved IP';
                return false;
            }
            $approvedIp = $host;
            return true;
        }

        $ips = [];
        $v4 = @gethostbynamel($host);
        if (is_array($v4)) {
            $ips = $v4;
        }
        if (function_exists('dns_get_record')) {
            $aaaa = @dns_get_record($host, DNS_AAAA);
            if (is_array($aaaa)) {
                foreach ($aaaa as $rec) {
                    if (!empty($rec['ipv6'])) {
                        $ips[] = (string) $rec['ipv6'];
                    }
                }
            }
        }
        if (empty($ips)) {
            $error = 'Host does not resolve';
            return false;
        }
        foreach ($ips as $ip) {
            if (in_array(strtolower($ip), self::BLOCKED_HOSTS, true) || !self::isPublicIp($ip)) {
                $error = 'Host resolves to a private or reserved IP';
                return false;
            }
        }
        // The first approved address, for callers that pin the connection to what
        // they checked (a check-then-fetch without pinning is DNS-rebindable).
        $approvedIp = (string) $ips[0];
        return true;
    }
}
