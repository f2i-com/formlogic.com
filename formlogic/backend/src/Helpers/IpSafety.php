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
        // Unwrap an IPv4-mapped IPv6 address so the IPv4 range checks apply.
        if (preg_match('/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i', $ip, $m)) {
            $ip = $m[1];
        }
        return filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false;
    }

    /**
     * Resolve $host (A + AAAA, following any CNAME chain the resolver walks) and return true only if it
     * resolves to at least one IP and EVERY resolved IP is public. Any private/reserved/blocked IP → false.
     *
     * @param string|null $error set to a user-facing reason when false
     */
    public static function resolvesToPublicHost(string $host, ?string &$error = null): bool
    {
        $error = null;
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
        return true;
    }
}
