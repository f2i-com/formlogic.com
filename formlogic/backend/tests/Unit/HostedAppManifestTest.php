<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Services\{HostedAppService, RuntimeEngineService, SandboxRunner};
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** Manifest normalization and policy checks only; no process, database or engine. */
final class HostedAppManifestTest extends TestCase
{
    private function package(array $config): array
    {
        return ['version' => 1, 'client' => [
            'manifest.json' => json_encode([
                'main' => 'ui/main.ui', 'files' => ['logic' => ['logic/main.py']],
                'config' => $config, 'server' => ['token' => 'PRIVATE-CANARY'],
                'engine' => 'host-js', 'private' => ['token' => 'PRIVATE-CANARY'],
            ], JSON_THROW_ON_ERROR),
            'ui/main.ui' => '<Text>Python</Text>', 'logic/main.py' => "value = 1\n",
        ], 'actions' => []];
    }

    private function normalize(array $package): array
    {
        $runner = $this->createMock(SandboxRunner::class);
        $runner->expects(self::never())->method('isAvailable');
        $runner->expects(self::never())->method('evaluateBatch');
        return (new HostedAppService($runner))->validate($package);
    }

    public function testOnlyPublicPythonPackageDeclarationSurvivesNormalization(): void
    {
        $original = $this->package([
            'python' => ['packages' => ['torch', 'torch'], 'indexUrl' => 'https://private.invalid/PRIVATE-CANARY'],
            'server' => ['token' => 'PRIVATE-CANARY'], 'engine' => 'host-js',
        ]);
        self::assertTrue(RuntimeEngineService::declaresTorch($original['client']));
        $clean = $this->normalize($original);
        $manifest = json_decode($clean['client']['manifest.json'], true, 512, JSON_THROW_ON_ERROR);
        self::assertSame(['python' => ['packages' => ['torch']]], $manifest['config']);
        self::assertTrue(RuntimeEngineService::declaresTorch($clean['client']));
        self::assertSame(['logic/main.py'], $manifest['files']['logic']);
        self::assertStringNotContainsString('PRIVATE-CANARY', json_encode($clean));
        self::assertArrayNotHasKey('engine', $manifest);
        self::assertArrayNotHasKey('server', $manifest);
        self::assertArrayNotHasKey('private', $manifest);
        self::assertSame($clean, $this->normalize($clean), 'Repeated validation preserves the declaration');
    }

    public function testUnrelatedPrivateConfigurationRemainsExcluded(): void
    {
        $clean = $this->normalize($this->package(['server' => ['token' => 'PRIVATE-CANARY']]));
        self::assertArrayNotHasKey('config', json_decode($clean['client']['manifest.json'], true));
        self::assertStringNotContainsString('PRIVATE-CANARY', json_encode($clean));
    }

    public function testEmptyPackageListIsPreservedWithoutDeclaringTorch(): void
    {
        $clean = $this->normalize($this->package(['python' => ['packages' => []]]));
        self::assertSame(['python' => ['packages' => []]], json_decode($clean['client']['manifest.json'], true)['config']);
        self::assertFalse(RuntimeEngineService::declaresTorch($clean['client']));
    }

    public static function invalidDeclarations(): array
    {
        return [
            'python null' => [null], 'python string' => ['torch'], 'python array' => [[]],
            'packages null' => [['packages' => null]], 'packages string' => [['packages' => 'torch']],
            'packages object' => [['packages' => (object) ['0' => 'torch']]],
            'unknown package' => [['packages' => ['pytorch']]], 'wrong case' => [['packages' => ['Torch']]],
            'URL' => [['packages' => ['https://example.invalid/torch']]],
            'local path' => [['packages' => ['C:/private/torch']]],
            'non-string' => [['packages' => [true]]], 'nested metadata' => [['packages' => [['name' => 'torch']]]],
        ];
    }

    #[DataProvider('invalidDeclarations')]
    public function testMalformedOrExternalPackageDeclarationIsRefused(mixed $python): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->normalize($this->package(['python' => $python]));
    }

    public static function deniedPolicies(): array
    {
        return ['site disabled' => [false, true], 'app disabled' => [true, false]];
    }

    #[DataProvider('deniedPolicies')]
    public function testNormalizedManifestStillEnforcesSiteAndAppPolicy(bool $site, bool $app): void
    {
        $clean = $this->normalize($this->package(['python' => ['packages' => ['torch']]]));
        $statement = $this->createMock(\PDOStatement::class);
        $statement->method('fetchColumn')->willReturn(json_encode([
            'default' => RuntimeEngineService::ZIPP_WEB_PYTHON,
            'allowed' => [RuntimeEngineService::ZIPP_WEB_PYTHON], 'torch' => $site,
        ]));
        $pdo = $this->createMock(\PDO::class);
        $pdo->method('prepare')->willReturn($statement);
        $mysql = $this->createMock(\FormLogic\Database\MySQLConnection::class);
        $mysql->method('getConnection')->willReturn($pdo);
        $engines = new RuntimeEngineService($mysql, '/nonexistent/provenance.json');
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionCode(403);
        $engines->assertTorchAllowed(['settings' => ['torch' => $app]], $clean['client']);
    }
}
