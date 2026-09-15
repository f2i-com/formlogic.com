<?php

declare(strict_types=1);

namespace FormLogic\Tests\Support;

/**
 * What the generated bin/runtime/SOURCE.json (scripts/runtime-provenance.mjs)
 * says about one sandbox launcher, for the parity harness's backend leg.
 */
final class SandboxProvenance
{
    /**
     * {release, revision} of the ZIPP release `$binary` was built from: the
     * SOURCE.json in the binary's own directory, and only if that record lists
     * this very file's sha256 among its launchers. Null otherwise, never a
     * guess: an overridden binary with no record beside it, a swapped binary
     * beside a stale record, or a record without a ZIPP release all give null,
     * and scripts/check-expression-parity.mjs refuses a leg without it.
     *
     * @return array{release: string, revision: string}|null
     */
    public static function launcherZipp(?string $binary): ?array
    {
        if (!is_string($binary) || $binary === '' || !is_file($binary)) {
            return null;
        }
        $sha256 = hash_file('sha256', $binary);
        $raw = @file_get_contents(dirname($binary) . '/SOURCE.json');
        $source = is_string($raw) ? json_decode($raw, true) : null;
        if (!is_array($source) || !is_array($source['zipp'] ?? null) || !is_array($source['launchers'] ?? null)) {
            return null;
        }
        $release = $source['zipp']['release'] ?? null;
        $revision = $source['zipp']['revision'] ?? null;
        if (!is_string($release) || $release === '' || !is_string($revision) || $revision === '') {
            return null;
        }
        foreach ($source['launchers'] as $launcher) {
            if (is_array($launcher) && ($launcher['sha256'] ?? null) === $sha256) {
                return ['release' => $release, 'revision' => $revision];
            }
        }
        return null;
    }
}
