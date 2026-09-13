<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Services\{FolderPackCatalog, HostedAppService, SandboxRunner};
use PHPUnit\Framework\TestCase;

final class FolderPackCatalogTest extends TestCase
{
    public function testAllPackFeaturesSurviveConversion(): void
    {
        $root = dirname(__DIR__, 2) . '/resources';
        $loaded = (new FolderPackCatalog($root . '/packs', '/nonexistent'))->load();
        self::assertSame([], $loaded['errors']);
        self::assertCount(29, $loaded['entries']);
        foreach ($loaded['entries'] as $id => $entry) {
            $original = json_decode(file_get_contents($root . '/marketplace-packs/' . $id . '.json'), true, 128, JSON_THROW_ON_ERROR)['pack'];
            $actual = $entry['pack'];
            unset($original['signing']);
            foreach ($actual['apps'] as $i => &$app) {
                self::assertArrayHasKey('hostedProject', $app, $id);
                self::assertSame(true, $app['settings']['hostedDashboard']);
                unset($app['hostedProject'], $app['settings']['hostedDashboard']);
                if (!isset($original['apps'][$i]['settings'])) unset($app['settings']);
            }
            unset($app);
            self::assertSame($original, $actual, "$id must preserve forms, links, roles, reports, scripts and flows");
        }
    }

    public function testFolderChangesOverridesAndFailuresAreVisibleWithoutRebuild(): void
    {
        $dir = sys_get_temp_dir() . '/fl-pack-' . bin2hex(random_bytes(8));
        mkdir($dir); mkdir($dir . '/clinic-appointment-intake');
        $folder = $dir . '/clinic-appointment-intake';
        $file = $folder . '/pack.json';
        $catalog = new FolderPackCatalog(null, $dir);
        try {
            file_put_contents($file, json_encode(['id' => 'clinic-appointment-intake', 'formatVersion' => 1, 'disabled' => true]));
            self::assertArrayNotHasKey('clinic-appointment-intake', $catalog->load()['entries']);
            file_put_contents($file, '{');
            $result = $catalog->load();
            self::assertArrayHasKey('clinic-appointment-intake', $result['entries'], 'Malformed override preserves bundled fallback');
            self::assertCount(1, $result['errors']);
            unlink($file);
            self::assertArrayHasKey('clinic-appointment-intake', $catalog->load()['entries']);
        } finally { if (is_file($file)) unlink($file); rmdir($folder); rmdir($dir); }
    }

    public function testEveryServerActionCompilesAndRunsInZipp(): void
    {
        $runner = new SandboxRunner();
        self::assertTrue($runner->isAvailable(), 'Local ZIPP runtime is required for pack validation');
        $dir = sys_get_temp_dir() . '/fl-pack-actions-' . bin2hex(random_bytes(8));
        $hosting = new HostedAppService($runner, $dir);
        try {
            foreach ((new FolderPackCatalog(null, '/nonexistent'))->load()['entries'] as $entry) {
                foreach ($entry['pack']['apps'] as $app) {
                    $id = $entry['id'] . '-' . $app['packAppId'];
                    $id = substr(hash('sha256', $id), 0, 32);
                    $hosting->publish($id, $app['hostedProject'], 0);
                    $guide = $hosting->run($id, 'packGuide', [], 'review-user', false);
                    self::assertSame($app['name'], $guide['name']);
                    self::assertCount(count($app['forms']), $guide['forms']);
                    self::assertArrayNotHasKey('actions', $hosting->get($id), 'Private action source must not reach runtime clients');
                    $hosting->remove($id);
                }
            }
        } finally {
            foreach (glob($dir . '/*.sqlite') ?: [] as $file) unlink($file);
            if (is_dir($dir)) rmdir($dir);
        }
    }
}
