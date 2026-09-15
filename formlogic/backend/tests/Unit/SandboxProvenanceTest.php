<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Tests\Support\SandboxProvenance;
use PHPUnit\Framework\TestCase;

/**
 * The parity harness's backend leg names the ZIPP release its launcher was
 * built from only when the SOURCE.json beside that launcher lists the file's
 * own digest. A false positive would be silent (the comparator would accept a
 * leg run on some other build), so each way of not matching is pinned here,
 * without needing a launcher that runs.
 */
class SandboxProvenanceTest extends TestCase
{
    private const RELEASE = 'v0.0.18';
    private const REVISION = 'fc474d157588b1d5c07d3a4a56b1cb5a3e0c9d21';

    private string $dir;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/formlogic-sandbox-provenance-' . bin2hex(random_bytes(6));
        mkdir($this->dir . '/bin/runtime', 0o777, true);
        mkdir($this->dir . '/elsewhere', 0o777, true);
    }

    protected function tearDown(): void
    {
        foreach (['bin/runtime', 'elsewhere'] as $sub) {
            foreach (glob($this->dir . '/' . $sub . '/*') ?: [] as $file) {
                @unlink($file);
            }
            @rmdir($this->dir . '/' . $sub);
        }
        @rmdir($this->dir . '/bin');
        @rmdir($this->dir);
    }

    /** A launcher stand-in and the SOURCE.json provenance writes beside it, listing `$listed` digests. */
    private function launcher(string $bytes, ?array $listed = null, ?array $zipp = null): string
    {
        $binary = $this->dir . '/bin/runtime/formlogic-runtime-linux-x86_64';
        file_put_contents($binary, $bytes);
        $this->source(
            $zipp ?? ['release' => self::RELEASE, 'revision' => self::REVISION],
            $listed ?? [hash('sha256', $bytes), hash('sha256', 'the windows launcher')]
        );
        return $binary;
    }

    /** @param list<string> $digests */
    private function source(array $zipp, array $digests): void
    {
        file_put_contents($this->dir . '/bin/runtime/SOURCE.json', json_encode([
            'formatVersion' => 1,
            'zipp' => $zipp + ['repository' => 'https://github.com/f2i-com/zipp.org', 'version' => '0.0.18'],
            'launchers' => array_map(static fn (string $sha256): array => ['artifact' => 'formlogic-runtime-x', 'sha256' => $sha256], $digests),
        ]));
    }

    public function testTheRecordedLauncherNamesItsZippRelease(): void
    {
        $binary = $this->launcher('the linux launcher');

        self::assertSame(['release' => self::RELEASE, 'revision' => self::REVISION], SandboxProvenance::launcherZipp($binary));
    }

    public function testASwappedBinaryBesideTheRecordNamesNone(): void
    {
        $binary = $this->launcher('the linux launcher');
        file_put_contents($binary, 'a launcher built from something else');

        self::assertNull(SandboxProvenance::launcherZipp($binary));
    }

    public function testAStaleRecordNamesNone(): void
    {
        $binary = $this->launcher('the linux launcher', [hash('sha256', 'an older build'), hash('sha256', 'the windows launcher')]);

        self::assertNull(SandboxProvenance::launcherZipp($binary));
    }

    public function testAnOverriddenBinaryWithNoRecordBesideItNamesNone(): void
    {
        // FORMLOGIC_RUNTIME_BIN pointing elsewhere: bin/runtime's record lists these very bytes, but not beside this file.
        $this->launcher('the linux launcher');
        $overridden = $this->dir . '/elsewhere/formlogic-runtime-linux-x86_64';
        file_put_contents($overridden, 'the linux launcher');

        self::assertNull(SandboxProvenance::launcherZipp($overridden));
    }

    public function testAMissingBinaryOrNoneNamesNone(): void
    {
        $this->launcher('the linux launcher');

        self::assertNull(SandboxProvenance::launcherZipp($this->dir . '/bin/runtime/formlogic-runtime-windows-x86_64.exe'));
        self::assertNull(SandboxProvenance::launcherZipp(null));
        self::assertNull(SandboxProvenance::launcherZipp(''));
    }

    public function testARecordThatIsNotProvenanceNamesNone(): void
    {
        $binary = $this->launcher('the linux launcher');

        file_put_contents($this->dir . '/bin/runtime/SOURCE.json', '{"zipp": {"release": "v0.0.18", "revision": "' . self::REVISION . '"}, "launchers": [');
        self::assertNull(SandboxProvenance::launcherZipp($binary), 'malformed JSON');

        file_put_contents($this->dir . '/bin/runtime/SOURCE.json', json_encode(['zipp' => ['release' => self::RELEASE, 'revision' => self::REVISION]]));
        self::assertNull(SandboxProvenance::launcherZipp($binary), 'no launchers listed');

        $this->source(['release' => null, 'revision' => self::REVISION], [hash('sha256', 'the linux launcher')]);
        self::assertNull(SandboxProvenance::launcherZipp($binary), 'no ZIPP release');

        $this->source(['release' => self::RELEASE, 'revision' => ''], [hash('sha256', 'the linux launcher')]);
        self::assertNull(SandboxProvenance::launcherZipp($binary), 'no ZIPP revision');

        unlink($this->dir . '/bin/runtime/SOURCE.json');
        self::assertNull(SandboxProvenance::launcherZipp($binary), 'no SOURCE.json');
    }
}
