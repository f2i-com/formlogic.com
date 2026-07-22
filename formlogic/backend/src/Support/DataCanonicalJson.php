<?php

declare(strict_types=1);

namespace FormLogic\Support;

/**
 * flcanon/1 — RFC 8785 (JCS) restricted to an integer-only subset, plus the
 * domain-separated signing preimages for the data-nodes protocol
 * (docs/FORMLOGIC_DATA_NODES.md §1-§3).
 *
 * Mirrored byte-for-byte by ui/src/lib/data/canonical.ts and
 * desktop/src-tauri/src/data/canonical.rs; all three assert
 * docs/contracts/data-sync-vectors.json (backend/tests/Unit/DataSyncVectorsTest.php).
 *
 * Objects are stdClass (json_decode default) or non-list PHP arrays; JSON arrays are
 * PHP list arrays. An empty PHP array serializes as [] — producers must use (object)[]
 * or stdClass for an empty JSON object. Floats are ALWAYS rejected (json_decode turns
 * "1e3"/"-0"/overflowing ints into floats, so lenient inputs fail here by construction).
 * Verification never re-parses leniently: verifiers parse received bytes, re-serialize,
 * and require byte equality — inherently rejecting duplicate keys, floats, and
 * whitespace/escape variants.
 */
final class DataCanonicalJson
{
    public const DOMAIN_PLACEMENT = 'flplacement:1';
    public const DOMAIN_OPERATION = 'flop:1';
    public const DOMAIN_CHECKPOINT = 'flcheckpoint:1';
    public const DOMAIN_BACKUP = 'flbackup:1';
    public const DOMAIN_NODE_CERT = 'flnodecert:1';
    public const DOMAIN_LOGICAL_ROOT = 'flroot:1';
    public const DOMAIN_HIGH_WATER = 'flhw:1';

    private const MAX_SAFE_INT = 9007199254740991; // 2^53 - 1
    private const MAX_DEPTH = 64;

    /** flcanon/1 serialization of any canonical value. */
    public static function encode(mixed $value): string
    {
        return self::serialize($value, 0);
    }

    /** preimage = ASCII(domain) . "\n" . flcanon(structure). Top level must be an object. */
    public static function preimage(string $domain, mixed $structure): string
    {
        return $domain . "\n" . self::encode(self::requireObject($structure));
    }

    /** SHA-256 lowercase hex over the domain-separated preimage. */
    public static function hashHex(string $domain, mixed $structure): string
    {
        return hash('sha256', self::preimage($domain, $structure));
    }

    /** Ed25519 detached signature (base64, padded) over the preimage WITHOUT the signature field. */
    public static function signB64(string $domain, mixed $structure, string $ed25519SkRaw): string
    {
        $object = self::withoutSignature(self::requireObject($structure));
        return base64_encode(sodium_crypto_sign_detached(self::preimage($domain, $object), $ed25519SkRaw));
    }

    /** Verify a signed structure's `signature` field against the domain preimage. */
    public static function verify(string $domain, mixed $structure, string $ed25519PkRaw): bool
    {
        try {
            $object = self::requireObject($structure);
        } catch (\RuntimeException) {
            return false;
        }
        $vars = get_object_vars($object);
        $signature = $vars['signature'] ?? null;
        if (!is_string($signature) || strlen($signature) !== 88) {
            return false;
        }
        $raw = base64_decode($signature, true);
        if (!is_string($raw) || strlen($raw) !== 64 || base64_encode($raw) !== $signature) {
            return false;
        }
        try {
            $preimage = self::preimage($domain, self::withoutSignature($object));
        } catch (\RuntimeException) {
            return false;
        }
        return sodium_crypto_sign_verify_detached($raw, $preimage, $ed25519PkRaw);
    }

    /** keyId = first 16 hex of SHA-256(raw pk) (docs/FORMLOGIC_DATA_NODES.md §2). */
    public static function keyId(string $ed25519PkRaw): string
    {
        return substr(hash('sha256', $ed25519PkRaw), 0, 16);
    }

    public static function fingerprint(string $ed25519PkRaw): string
    {
        return hash('sha256', $ed25519PkRaw);
    }

    /**
     * v1 logical root (docs/FORMLOGIC_DATA_NODES.md §3): entries sorted by the UTF-8
     * bytes of their flcanon serialization (memcmp), hashed under flroot:1.
     *
     * @param array<int,mixed> $entries
     */
    public static function logicalRootHex(string $datasetId, array $entries): string
    {
        $pairs = [];
        foreach ($entries as $entry) {
            $pairs[] = [self::encode($entry), $entry];
        }
        usort($pairs, static fn(array $a, array $b): int => strcmp($a[0], $b[0]));
        $sorted = array_map(static fn(array $p): mixed => $p[1], $pairs);
        $body = (object) ['v' => 1, 'datasetId' => $datasetId, 'entries' => $sorted];
        return hash('sha256', self::DOMAIN_LOGICAL_ROOT . "\n" . self::encode($body));
    }

    private static function requireObject(mixed $structure): \stdClass
    {
        if ($structure instanceof \stdClass) {
            return $structure;
        }
        if (is_array($structure)) {
            if ($structure !== [] && array_is_list($structure)) {
                throw new \RuntimeException('canonical_invalid: signed structures must be objects');
            }
            return (object) $structure;
        }
        throw new \RuntimeException('canonical_invalid: signed structures must be objects');
    }

    private static function withoutSignature(\stdClass $object): \stdClass
    {
        $vars = get_object_vars($object);
        unset($vars['signature']);
        return (object) $vars;
    }

    private static function serialize(mixed $value, int $depth): string
    {
        if ($depth > self::MAX_DEPTH) {
            throw new \RuntimeException('canonical_invalid: nesting too deep');
        }
        if ($value === null) {
            return 'null';
        }
        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }
        if (is_int($value)) {
            if ($value > self::MAX_SAFE_INT || $value < -self::MAX_SAFE_INT) {
                throw new \RuntimeException('canonical_invalid: integer beyond 2^53-1');
            }
            return (string) $value;
        }
        if (is_float($value)) {
            throw new \RuntimeException('canonical_invalid: non-integer number');
        }
        if (is_string($value)) {
            return self::escapeString($value);
        }
        if ($value instanceof \stdClass) {
            return self::serializeObject(get_object_vars($value), $depth);
        }
        if (is_array($value)) {
            if ($value === [] || array_is_list($value)) {
                $parts = [];
                foreach ($value as $item) {
                    $parts[] = self::serialize($item, $depth + 1);
                }
                return '[' . implode(',', $parts) . ']';
            }
            return self::serializeObject($value, $depth);
        }
        throw new \RuntimeException('canonical_invalid: unsupported type ' . get_debug_type($value));
    }

    /** @param array<array-key,mixed> $vars */
    private static function serializeObject(array $vars, int $depth): string
    {
        $keys = array_map('strval', array_keys($vars));
        usort($keys, static fn(string $a, string $b): int => strcmp(self::utf16be($a), self::utf16be($b)));
        $parts = [];
        foreach ($keys as $key) {
            $parts[] = self::escapeString($key) . ':' . self::serialize($vars[$key], $depth + 1);
        }
        return '{' . implode(',', $parts) . '}';
    }

    /**
     * JCS string escaping: \" \\ \b \f \n \r \t, \u00xx lowercase for other C0 controls,
     * raw UTF-8 elsewhere. Byte-level replacement of C0 bytes is UTF-8-safe
     * (continuation bytes are >= 0x80).
     */
    private static function escapeString(string $s): string
    {
        if (!preg_match('//u', $s)) {
            throw new \RuntimeException('canonical_invalid: string is not valid UTF-8');
        }
        $out = strtr($s, [
            '\\' => '\\\\',
            '"' => '\\"',
            "\x08" => '\\b',
            "\x09" => '\\t',
            "\x0a" => '\\n',
            "\x0c" => '\\f',
            "\x0d" => '\\r',
        ]);
        $out = (string) preg_replace_callback(
            '/[\x00-\x1f]/',
            static fn(array $m): string => sprintf('\\u%04x', ord($m[0])),
            $out,
        );
        return '"' . $out . '"';
    }

    /**
     * UTF-8 -> UTF-16BE binary string, so strcmp gives the exact JCS UTF-16
     * code-unit key ordering (differs from code-point order for non-BMP keys).
     * Input is already validated UTF-8.
     */
    private static function utf16be(string $s): string
    {
        $out = '';
        $len = strlen($s);
        $i = 0;
        while ($i < $len) {
            $b0 = ord($s[$i]);
            if ($b0 < 0x80) {
                $cp = $b0;
                $i += 1;
            } elseif (($b0 & 0xe0) === 0xc0) {
                $cp = (($b0 & 0x1f) << 6) | (ord($s[$i + 1]) & 0x3f);
                $i += 2;
            } elseif (($b0 & 0xf0) === 0xe0) {
                $cp = (($b0 & 0x0f) << 12) | ((ord($s[$i + 1]) & 0x3f) << 6) | (ord($s[$i + 2]) & 0x3f);
                $i += 3;
            } else {
                $cp = (($b0 & 0x07) << 18) | ((ord($s[$i + 1]) & 0x3f) << 12)
                    | ((ord($s[$i + 2]) & 0x3f) << 6) | (ord($s[$i + 3]) & 0x3f);
                $i += 4;
            }
            if ($cp > 0xffff) {
                $cp -= 0x10000;
                $out .= pack('n', 0xd800 | ($cp >> 10));
                $out .= pack('n', 0xdc00 | ($cp & 0x3ff));
            } else {
                $out .= pack('n', $cp);
            }
        }
        return $out;
    }
}
