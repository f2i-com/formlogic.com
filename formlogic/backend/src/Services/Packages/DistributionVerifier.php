<?php

declare(strict_types=1);

namespace FormLogic\Services\Packages;

/**
 * DESK-501: the pre-staging gate for a signed service distribution.
 *
 * A distribution is an executable artifact a package wants installed on a machine. Everything
 * here runs BEFORE a single byte is written to disk, because the alternative — stage first,
 * verify after — leaves a window where a tampered or hostile artifact already exists locally,
 * and cleanup has to be perfect to close it.
 *
 * What it enforces, and why each one matters:
 *
 *   - **runtimeKind selects the installer.** A `desktop-plugin` artifact must never route
 *     through the managed-service installer or vice versa; they grant different privileges,
 *     so treating the field as advisory would let a package pick its own privilege level.
 *   - **Platform match.** An artifact built for another OS/arch cannot run here; staging it
 *     wastes a download and leaves a broken half-install to explain.
 *   - **Size ceiling, declared up front.** An artifact whose declared size exceeds the cap is
 *     refused before the fetch, so an oversized download cannot be used to fill a disk.
 *   - **Digest is well-formed AND matched.** A malformed digest is refused outright; a
 *     mismatch after fetch is a tamper, not a retry.
 *   - **No path escapes.** Every path an artifact declares must stay inside its staging
 *     directory — `..`, absolute paths and drive letters are all refused.
 *   - **Signature required by policy.** With verified-only enforcement on, an unsigned or
 *     failing distribution never reaches staging.
 *
 * Refusals are TYPED so a caller can tell "not for this machine" (skip) from "this does not
 * match what was signed" (a security event worth surfacing loudly).
 */
final class DistributionVerifier
{
    public const RUNTIME_MANAGED_SERVICE = 'managed-service';
    public const RUNTIME_DESKTOP_PLUGIN = 'desktop-plugin';

    /** Installer each runtime kind routes to. The mapping is the point of the field. */
    private const INSTALLER_BY_RUNTIME = [
        self::RUNTIME_MANAGED_SERVICE => 'managed-service-installer',
        self::RUNTIME_DESKTOP_PLUGIN => 'desktop-plugin-installer',
    ];

    /** Hard ceiling on a single declared artifact (512 MiB — the plugin upload cap). */
    public const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

    /**
     * Verify a distribution descriptor against the host it would install on.
     *
     * @param array<string,mixed> $distribution One `serviceDistributions[]` entry.
     * @param array{platform:string,arch:string,requireSigned?:bool,signatureVerified?:bool} $host
     * @return array{ok:bool,installer?:string,code?:string,message?:string}
     */
    public static function verify(array $distribution, array $host): array
    {
        $runtimeKind = is_string($distribution['runtimeKind'] ?? null) ? $distribution['runtimeKind'] : '';
        if (!isset(self::INSTALLER_BY_RUNTIME[$runtimeKind])) {
            return self::refuse('unsupported_runtime_kind', "runtimeKind {$runtimeKind} has no trusted installer");
        }

        // Policy first: an unsigned distribution must not be inspected further under a
        // verified-only posture — refusing early keeps the reason unambiguous.
        if (($host['requireSigned'] ?? false) === true && ($host['signatureVerified'] ?? false) !== true) {
            return self::refuse('unsigned_distribution', 'this workspace installs only signed distributions');
        }

        $artifact = is_array($distribution['artifact'] ?? null) ? $distribution['artifact'] : null;
        if ($artifact === null) {
            return self::refuse('invalid_artifact', 'the distribution declares no artifact');
        }

        $sha = is_string($artifact['sha256'] ?? null) ? $artifact['sha256'] : '';
        if (preg_match('/^[a-f0-9]{64}$/', $sha) !== 1) {
            return self::refuse('invalid_artifact', 'sha256 must be 64 lowercase hex characters');
        }

        // Size is declared, so an oversized artifact is refused BEFORE the download.
        if (isset($artifact['sizeBytes'])) {
            $size = $artifact['sizeBytes'];
            if (!is_int($size) || $size <= 0) {
                return self::refuse('invalid_artifact', 'sizeBytes must be a positive integer');
            }
            if ($size > self::MAX_ARTIFACT_BYTES) {
                return self::refuse('artifact_too_large', sprintf('artifact declares %d bytes (max %d)', $size, self::MAX_ARTIFACT_BYTES));
            }
        }

        // Platform targeting: absent means portable; present must include this host.
        $platforms = $artifact['platforms'] ?? null;
        if (is_array($platforms) && $platforms !== []) {
            $wanted = ($host['platform'] ?? '') . '-' . ($host['arch'] ?? '');
            $matches = false;
            foreach ($platforms as $candidate) {
                if (is_string($candidate) && ($candidate === $wanted || $candidate === ($host['platform'] ?? ''))) {
                    $matches = true;
                    break;
                }
            }
            if (!$matches) {
                return self::refuse('platform_unsupported', "no artifact for {$wanted}");
            }
        }

        // Any declared path must stay inside the staging dir once extracted.
        foreach (['entryPath', 'installPath'] as $key) {
            $path = $artifact[$key] ?? null;
            if ($path === null) {
                continue;
            }
            if (!is_string($path) || !self::isContainedRelativePath($path)) {
                return self::refuse('path_escape', "{$key} must be a staging-relative path with no traversal");
            }
        }

        return ['ok' => true, 'installer' => self::INSTALLER_BY_RUNTIME[$runtimeKind]];
    }

    /**
     * Confirm fetched bytes are what was signed. A mismatch is a TAMPER — never a retry, and
     * never something to stage "pending investigation".
     *
     * @param array<string,mixed> $artifact
     * @return array{ok:bool,code?:string,message?:string}
     */
    public static function verifyFetched(array $artifact, string $bytes): array
    {
        $expected = is_string($artifact['sha256'] ?? null) ? strtolower($artifact['sha256']) : '';
        if (preg_match('/^[a-f0-9]{64}$/', $expected) !== 1) {
            return self::refuse('invalid_artifact', 'sha256 must be 64 lowercase hex characters');
        }
        if (isset($artifact['sizeBytes']) && is_int($artifact['sizeBytes']) && strlen($bytes) !== $artifact['sizeBytes']) {
            return self::refuse('artifact_size_mismatch', sprintf('fetched %d bytes, declared %d', strlen($bytes), $artifact['sizeBytes']));
        }
        if (strlen($bytes) > self::MAX_ARTIFACT_BYTES) {
            return self::refuse('artifact_too_large', 'fetched artifact exceeds the size ceiling');
        }
        if (!hash_equals($expected, hash('sha256', $bytes))) {
            return self::refuse('artifact_digest_mismatch', 'the fetched artifact does not match its signed digest');
        }
        return ['ok' => true];
    }

    /** A path that stays inside its staging root: relative, no traversal, no drive/UNC. */
    private static function isContainedRelativePath(string $path): bool
    {
        if ($path === '' || str_contains($path, ':') || str_contains($path, "\0")) {
            return false;
        }
        if (str_starts_with($path, '/') || str_starts_with($path, '\\')) {
            return false;
        }
        foreach (preg_split('#[/\\\\]#', $path) ?: [] as $segment) {
            if ($segment === '..') {
                return false;
            }
        }
        return true;
    }

    /** @return array{ok:bool,code:string,message:string} */
    private static function refuse(string $code, string $message): array
    {
        return ['ok' => false, 'code' => $code, 'message' => $message];
    }
}
