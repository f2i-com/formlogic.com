<?php

declare(strict_types=1);

namespace FormLogic\Services\Packages;

/**
 * Deterministic package-dependency resolution (ADR-010 / PKG-105 first slice).
 *
 * v1 scope: a requested ROOT's declared dependencies resolve against the owner's INSTALLED
 * package graph only — there is no catalog fetch, so a missing dependency is a typed refusal
 * telling the user what to install first, never a silent skip. Transitive closure holds by
 * induction: every installed package resolved ITS dependencies at its own install time, and
 * a depended-upon package cannot be uninstalled while a required edge points at it.
 *
 * Range grammar (the v1 contract grammar, syntax-validated by ApplicationPackageV2Validator):
 *   X.Y.Z    exact — equal triple AND equal prerelease.
 *   ^X.Y.Z   >=X.Y.Z with the same major; npm-style zero rule: ^0.Y.Z pins the minor too.
 *   ~X.Y.Z   >=X.Y.Z with the same major AND minor.
 *   >=X.Y.Z  floor only.
 * Prerelease rule (deliberately conservative + deterministic): a prerelease version satisfies
 * ONLY an exact range with the identical prerelease; ^/~/>= never match prereleases, and a
 * prerelease range floor matches only its exact version.
 */
class DependencyResolver
{
    /**
     * Resolve a root's declared dependencies against the installed graph.
     *
     * @param list<array<string,mixed>> $dependencies Declared deps: {id, version(range), optional?, reason?}.
     * @param array<string,array{version:string,installationId:string}> $installed package_id => installed exact version.
     * @param string $rootPackageId The package being installed (self-dependency is refused).
     * @return array{
     *   ok: bool,
     *   resolved: list<array{id:string,range:string,resolvedVersion:string,installationId:string,required:bool}>,
     *   missingOptional: list<array{id:string,range:string}>,
     *   problems: list<array{code:string,id:string,message:string}>
     * }
     */
    public static function resolve(array $dependencies, array $installed, string $rootPackageId): array
    {
        $resolved = [];
        $missingOptional = [];
        $problems = [];

        foreach ($dependencies as $dep) {
            $id = (string) ($dep['id'] ?? '');
            $range = (string) ($dep['version'] ?? '');
            $required = (($dep['optional'] ?? false) !== true);

            if ($id === $rootPackageId) {
                $problems[] = ['code' => 'self_dependency', 'id' => $id, 'message' => "\"$id\" cannot depend on itself"];
                continue;
            }
            if (!isset($installed[$id])) {
                if ($required) {
                    $problems[] = ['code' => 'missing_dependency', 'id' => $id, 'message' => "requires \"$id\" $range, which is not installed"];
                } else {
                    $missingOptional[] = ['id' => $id, 'range' => $range];
                }
                continue;
            }
            $have = $installed[$id]['version'];
            if (!self::satisfies($have, $range)) {
                // An installed-but-incompatible OPTIONAL dependency is still a problem: silently
                // proceeding would activate the package against a version it declared unusable.
                $problems[] = [
                    'code' => 'incompatible_dependency',
                    'id' => $id,
                    'message' => "requires \"$id\" $range, but v$have is installed",
                ];
                continue;
            }
            $resolved[] = [
                'id' => $id,
                'range' => $range,
                'resolvedVersion' => $have,
                'installationId' => $installed[$id]['installationId'],
                'required' => $required,
            ];
        }

        return [
            'ok' => $problems === [],
            'resolved' => $resolved,
            'missingOptional' => $missingOptional,
            'problems' => $problems,
        ];
    }

    /** Does exact `$version` satisfy `$range` under the v1 grammar? Malformed input never matches. */
    public static function satisfies(string $version, string $range): bool
    {
        $v = self::parse($version);
        if ($v === null) {
            return false;
        }
        $op = '';
        $base = $range;
        foreach (['>=', '^', '~'] as $candidate) {
            if (str_starts_with($range, $candidate)) {
                $op = $candidate;
                $base = substr($range, strlen($candidate));
                break;
            }
        }
        $b = self::parse($base);
        if ($b === null) {
            return false;
        }

        if ($op === '') {
            return $v === $b; // exact: triple AND prerelease identical
        }
        // Conservative prerelease rule: operators never admit prereleases, and a prerelease
        // floor admits only its own exact version.
        if ($v['pre'] !== '' || $b['pre'] !== '') {
            return $v === $b;
        }
        if (self::compareTriple($v, $b) < 0) {
            return false;
        }
        return match ($op) {
            '>=' => true,
            '^' => $b['major'] > 0
                ? $v['major'] === $b['major']
                : ($v['major'] === 0 && $v['minor'] === $b['minor']),
            '~' => $v['major'] === $b['major'] && $v['minor'] === $b['minor'],
            default => false,
        };
    }

    /** @return array{major:int,minor:int,patch:int,pre:string}|null */
    private static function parse(string $version): ?array
    {
        if (preg_match('/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/', $version, $m) !== 1) {
            return null;
        }
        return ['major' => (int) $m[1], 'minor' => (int) $m[2], 'patch' => (int) $m[3], 'pre' => $m[4] ?? ''];
    }

    /** @param array{major:int,minor:int,patch:int,pre:string} $a @param array{major:int,minor:int,patch:int,pre:string} $b */
    private static function compareTriple(array $a, array $b): int
    {
        return [$a['major'], $a['minor'], $a['patch']] <=> [$b['major'], $b['minor'], $b['patch']];
    }
}
