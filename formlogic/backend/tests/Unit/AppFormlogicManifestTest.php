<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\AppFormlogicManifest;
use FormLogic\Services\NativeAppService;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** The FormLogic sections of a SoftN app's manifest: what they may say, and the reason when they may not. */
final class AppFormlogicManifestTest extends TestCase
{
    private static function manifest(array $extra = [], ?array $routes = null): array
    {
        return [
            'name' => 'Logo maker', 'main' => 'ui/main.ui',
            'server' => ['entry' => 'server/main.logic', 'requires' => ['apiVersion' => 1, 'capabilities' => ['sql']], 'database' => ['kind' => 'private-sqlite'],
                'routes' => $routes ?? [
                    ['path' => '/api/site/ai/deliver', 'method' => 'POST', 'handler' => 'deliver'],
                    ['path' => '/api/download', 'method' => 'POST', 'handler' => 'download'],
                ]],
        ] + $extra;
    }

    private const AI = ['uses' => ['pictures', 'chat'], 'purpose' => 'Draws logos and talks them through.', 'jobs' => ['table' => 'ai_jobs', 'deliver' => '/api/site/ai/deliver']];
    private const PAYMENTS = ['purpose' => 'Pay 5¢ to download a logo.', 'items' => [['id' => 'download', 'label' => 'Download a logo', 'priceCents' => 5]], 'routes' => ['/api/download']];

    public function testBothSectionsAreReadAsDeclared(): void
    {
        $manifest = self::manifest(['formlogicAi' => self::AI, 'formlogicPayments' => self::PAYMENTS]);
        AppFormlogicManifest::validate($manifest);
        $this->assertSame(['uses' => ['pictures', 'chat'], 'kinds' => ['picture', 'chat'], 'purpose' => 'Draws logos and talks them through.', 'table' => 'ai_jobs', 'deliver' => '/api/site/ai/deliver', 'parts' => null], AppFormlogicManifest::ai($manifest));
        $this->assertSame(['purpose' => 'Pay 5¢ to download a logo.', 'items' => ['download' => ['label' => 'Download a logo', 'priceCents' => 5]], 'routes' => ['/api/download']], AppFormlogicManifest::payments($manifest));
        $this->assertTrue(AppFormlogicManifest::asksForVisitors($manifest));
    }

    public function testAManifestWithoutThemAsksForNothing(): void
    {
        $manifest = self::manifest();
        AppFormlogicManifest::validate($manifest);
        $this->assertNull(AppFormlogicManifest::ai($manifest));
        $this->assertNull(AppFormlogicManifest::payments($manifest));
        $this->assertFalse(AppFormlogicManifest::asksForVisitors($manifest), 'Coffee.Dating and every app like it: no visitors, no context');
    }

    public static function badSections(): array
    {
        return [
            'ai not an object' => [['formlogicAi' => ['pictures']], 'must be an object'],
            'unknown use' => [['formlogicAi' => ['uses' => ['video']] + self::AI], 'not one of'],
            'no uses' => [['formlogicAi' => ['uses' => []] + self::AI], 'needs "uses"'],
            'no purpose' => [['formlogicAi' => ['purpose' => ' '] + self::AI], 'needs a "purpose"'],
            'purpose too long' => [['formlogicAi' => ['purpose' => str_repeat('a', 201)] + self::AI], 'needs a "purpose"'],
            'bad table' => [['formlogicAi' => ['jobs' => ['table' => 'ai jobs', 'deliver' => '/api/site/ai/deliver']] + self::AI], 'needs "jobs"'],
            'sqlite table' => [['formlogicAi' => ['jobs' => ['table' => 'sqlite_master', 'deliver' => '/api/site/ai/deliver']] + self::AI], 'SQLite\'s own'],
            'deliver outside /api/site/' => [['formlogicAi' => ['jobs' => ['table' => 'ai_jobs', 'deliver' => '/api/deliver']] + self::AI], 'under /api/site/'],
            'deliver route undeclared' => [['formlogicAi' => ['jobs' => ['table' => 'ai_jobs', 'deliver' => '/api/site/elsewhere']] + self::AI], 'declares no POST route'],
            'parts outside /api/site/' => [['formlogicAi' => ['jobs' => ['table' => 'ai_jobs', 'deliver' => '/api/site/ai/deliver', 'parts' => '/api/parts']] + self::AI], 'parts route must be under /api/site/'],
            'parts at the deliver route' => [['formlogicAi' => ['jobs' => ['table' => 'ai_jobs', 'deliver' => '/api/site/ai/deliver', 'parts' => '/api/site/ai/deliver']] + self::AI], 'cannot be its deliver route'],
            'parts route undeclared' => [['formlogicAi' => ['jobs' => ['table' => 'ai_jobs', 'deliver' => '/api/site/ai/deliver', 'parts' => '/api/site/ai/part']] + self::AI], 'takes parts at /api/site/ai/part'],
            'payments item id' => [['formlogicPayments' => ['items' => [['id' => 'Down Load', 'label' => 'x', 'priceCents' => 5]]] + self::PAYMENTS], 'lower-case'],
            'payments price too high' => [['formlogicPayments' => ['items' => [['id' => 'download', 'label' => 'x', 'priceCents' => 501]]] + self::PAYMENTS], 'from 1 to 500'],
            'payments price not whole' => [['formlogicPayments' => ['items' => [['id' => 'download', 'label' => 'x', 'priceCents' => 4.5]]] + self::PAYMENTS], 'from 1 to 500'],
            'payments duplicate item' => [['formlogicPayments' => ['items' => [['id' => 'a', 'label' => 'x', 'priceCents' => 5], ['id' => 'a', 'label' => 'y', 'priceCents' => 6]]] + self::PAYMENTS], 'twice'],
            'payments route undeclared' => [['formlogicPayments' => ['routes' => ['/api/elsewhere']] + self::PAYMENTS], 'declares no POST route'],
            'payments on a site route' => [['formlogicPayments' => ['routes' => ['/api/site/ai/deliver']] + self::PAYMENTS], 'under /api/site/'],
        ];
    }

    #[DataProvider('badSections')]
    public function testAMalformedSectionIsRefusedWithTheReason(array $extra, string $reason): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage($reason);
        AppFormlogicManifest::validate(self::manifest($extra));
    }

    /** An app may name a second route, for an answer passed on as it is made. One that names none takes whole answers alone. */
    public function testAnAppMayTakeAnswersInParts(): void
    {
        $this->assertNull(AppFormlogicManifest::ai(self::manifest(['formlogicAi' => self::AI]))['parts']);
        $manifest = self::manifest(['formlogicAi' => ['jobs' => ['table' => 'ai_jobs', 'deliver' => '/api/site/ai/deliver', 'parts' => '/api/site/ai/part']] + self::AI]);
        $manifest['server']['routes'][] = ['path' => '/api/site/ai/part', 'method' => 'POST', 'handler' => 'part', 'transaction' => 'write', 'authorization' => 'anonymous'];
        AppFormlogicManifest::validate($manifest);
        $this->assertSame('/api/site/ai/part', AppFormlogicManifest::ai($manifest)['parts']);
    }

    /** Speech is a use of its own: an app that has Narrator's voice asks for it by name. */
    public function testAnAppMayAskForSpeech(): void
    {
        $declared = AppFormlogicManifest::ai(self::manifest(['formlogicAi' => ['uses' => ['chat', 'speech']] + self::AI]));
        $this->assertSame([['chat', 'speech'], ['chat', 'speech']], [$declared['uses'], $declared['kinds']]);
        $this->assertSame('speech', AppFormlogicManifest::AI_USES['speech']);
    }

    public function testASectionNeedsTheAppsOwnBackend(): void
    {
        $manifest = ['name' => 'Page only', 'main' => 'ui/main.ui', 'formlogicAi' => self::AI];
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('needs the app\'s own backend');
        AppFormlogicManifest::validate($manifest);
    }

    public function testAnInstallIsRefusedOverAMalformedSection(): void
    {
        $manifest = self::manifest(['formlogicAi' => ['uses' => ['pictures'], 'purpose' => 'x', 'jobs' => ['table' => 'ai_jobs', 'deliver' => '/api/deliver']]]);
        $project = ['files' => ['manifest.json' => json_encode($manifest), 'ui/main.ui' => '<Text>x</Text>', 'server/main.logic' => 'function deliver(req) { return {status: 200, body: {}}; }'], 'assets' => []];
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('under /api/site/');
        NativeAppService::validateProject($project);
    }
}
