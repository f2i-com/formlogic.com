<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\Packages\DependencyResolver;
use PHPUnit\Framework\TestCase;

/**
 * ADR-010 / PKG-105: the v1 range grammar is deterministic and conservative — exact / ^ / ~ / >=,
 * npm-style caret-zero rule, prereleases only ever match exactly, malformed input never matches.
 */
class DependencyResolverTest extends TestCase
{
    /** @return array<string, array{0:string,1:string,2:bool}> */
    public static function rangeMatrix(): array
    {
        return [
            'exact match' => ['1.2.3', '1.2.3', true],
            'exact mismatch patch' => ['1.2.4', '1.2.3', false],
            'caret same major above floor' => ['1.9.0', '^1.2.3', true],
            'caret at floor' => ['1.2.3', '^1.2.3', true],
            'caret below floor' => ['1.2.2', '^1.2.3', false],
            'caret next major' => ['2.0.0', '^1.2.3', false],
            'caret zero-major pins minor' => ['0.2.9', '^0.2.3', true],
            'caret zero-major next minor' => ['0.3.0', '^0.2.3', false],
            'tilde same minor' => ['1.2.9', '~1.2.3', true],
            'tilde next minor' => ['1.3.0', '~1.2.3', false],
            'tilde below floor' => ['1.2.2', '~1.2.3', false],
            'floor above' => ['3.0.0', '>=1.2.3', true],
            'floor at' => ['1.2.3', '>=1.2.3', true],
            'floor below' => ['1.2.2', '>=1.2.3', false],
            'floor higher-minor lower-patch' => ['1.3.0', '>=1.2.9', true],
            'prerelease satisfies only identical exact' => ['1.2.3-beta.1', '1.2.3-beta.1', true],
            'prerelease vs exact release' => ['1.2.3-beta.1', '1.2.3', false],
            'prerelease never satisfies caret' => ['1.3.0-rc.1', '^1.2.3', false],
            'prerelease floor admits only itself' => ['1.2.4', '>=1.2.3-rc.1', false],
            'prerelease floor exact self' => ['1.2.3-rc.1', '>=1.2.3-rc.1', true],
            'malformed version never matches' => ['1.2', '^1.0.0', false],
            'malformed range never matches' => ['1.2.3', '1.x', false],
        ];
    }

    /** @dataProvider rangeMatrix */
    public function testSatisfies(string $version, string $range, bool $expected): void
    {
        $this->assertSame($expected, DependencyResolver::satisfies($version, $range), "$version vs $range");
    }

    public function testResolveSplitsSatisfiedMissingAndIncompatible(): void
    {
        $installed = [
            'com.dep.ok' => ['version' => '2.5.0', 'installationId' => 'inst-ok'],
            'com.dep.old' => ['version' => '1.0.0', 'installationId' => 'inst-old'],
            'com.dep.opt' => ['version' => '3.1.4', 'installationId' => 'inst-opt'],
        ];
        $result = DependencyResolver::resolve([
            ['id' => 'com.dep.ok', 'version' => '^2.1.0'],
            ['id' => 'com.dep.old', 'version' => '^2.0.0'],
            ['id' => 'com.dep.gone', 'version' => '>=1.0.0'],
            ['id' => 'com.dep.opt', 'version' => '^3.0.0', 'optional' => true],
            ['id' => 'com.dep.optgone', 'version' => '^1.0.0', 'optional' => true],
        ], $installed, 'com.acme.root');

        $this->assertFalse($result['ok']);
        $codes = array_map(static fn (array $p) => $p['code'] . ':' . $p['id'], $result['problems']);
        $this->assertSame(['incompatible_dependency:com.dep.old', 'missing_dependency:com.dep.gone'], $codes);
        // The satisfied required + optional deps resolve with exact locks.
        $this->assertSame(
            [['com.dep.ok', '2.5.0', true], ['com.dep.opt', '3.1.4', false]],
            array_map(static fn (array $r) => [$r['id'], $r['resolvedVersion'], $r['required']], $result['resolved'])
        );
        // A missing OPTIONAL dependency never blocks — it is reported, not errored.
        $this->assertSame([['id' => 'com.dep.optgone', 'range' => '^1.0.0']], $result['missingOptional']);
    }

    public function testResolveRefusesSelfDependencyAndInstalledIncompatibleOptional(): void
    {
        $installed = ['com.dep.opt' => ['version' => '1.0.0', 'installationId' => 'i']];
        $result = DependencyResolver::resolve([
            ['id' => 'com.acme.root', 'version' => '^1.0.0'],
            // Installed-but-incompatible OPTIONAL still refuses: silently proceeding would run
            // against a version the package declared unusable.
            ['id' => 'com.dep.opt', 'version' => '^2.0.0', 'optional' => true],
        ], $installed, 'com.acme.root');
        $this->assertFalse($result['ok']);
        $codes = array_map(static fn (array $p) => $p['code'], $result['problems']);
        $this->assertSame(['self_dependency', 'incompatible_dependency'], $codes);
    }

    public function testEmptyDependencyListResolvesTrivially(): void
    {
        $result = DependencyResolver::resolve([], [], 'com.acme.root');
        $this->assertTrue($result['ok']);
        $this->assertSame([], $result['resolved']);
        $this->assertSame([], $result['problems']);
    }
}
