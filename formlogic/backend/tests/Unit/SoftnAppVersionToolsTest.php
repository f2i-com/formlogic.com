<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Services\{AppService, ChatToolDeniedException, ChatToolsContext, ChatToolsService, FormService, NativeAppService, ResponseService};
use PHPUnit\Framework\TestCase;

/**
 * An app's history of versions over MCP: an AI that changed an app can see what it was before, read
 * a version, and go back to one, as its owner can on the app's History section. The app is
 * installed for real into a folder of its own (no backend, so nothing is started), and the tools
 * are called as an MCP client calls them.
 */
final class SoftnAppVersionToolsTest extends TestCase
{
    private const APP = ['id' => 'notes-app', 'ownerId' => 'owner', 'name' => 'Notes', 'slug' => 'notes', 'status' => 'published', 'settings' => ['softnApp' => true]];

    private ?string $storage = null;
    private NativeAppService $native;

    protected function setUp(): void
    {
        $this->storage = sys_get_temp_dir() . '/formlogic-version-tools-' . bin2hex(random_bytes(8));
        mkdir($this->storage, 0700);
        $this->native = new NativeAppService($this->storage, $this->storage . '/no-runtime');
        unset($_ENV['NATIVE_HISTORY_MB']);
    }

    protected function tearDown(): void
    {
        if ($this->storage === null || !is_dir($this->storage)) return;
        $root = realpath($this->storage);
        $temp = realpath(sys_get_temp_dir()) . DIRECTORY_SEPARATOR;
        if ($root === false || !str_starts_with($root, $temp) || !str_starts_with(basename($root), 'formlogic-version-tools-')) throw new \RuntimeException('Unexpected fixture path');
        $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($iterator as $file) { if ($file->isDir() && !$file->isLink()) rmdir($file->getPathname()); else unlink($file->getPathname()); }
        rmdir($root);
    }

    /** An app with no backend: a page, and whatever else is given. */
    private static function project(string $heading, array $files = []): array
    {
        return ['access' => 'members', 'home' => true, 'assets' => [],
            'files' => $files + ['manifest.json' => '{"id":"notes","name":"Notes","main":"index.html"}', 'index.html' => "<h1>{$heading}</h1>"]];
    }

    /** An app that is there, and someone else's. */
    private const THEIRS = ['id' => 'their-app', 'ownerId' => 'someone-else'] + self::APP;

    private function tools(): ChatToolsService
    {
        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturnCallback(static fn (string $id) => match ($id) { self::APP['id'] => self::APP, self::THEIRS['id'] => self::THEIRS, default => null });
        return new ChatToolsService($this->createMock(FormService::class), $apps, $this->createMock(ResponseService::class), native: $this->native);
    }

    private static function mcp(array $scopes = ['apps:read', 'apps:write', 'screens:write']): ChatToolsContext
    {
        return new ChatToolsContext('owner', source: 'mcp', siteUrl: 'https://forms.example', requireScope: static function (string $scope) use ($scopes): void {
            if (!in_array($scope, $scopes, true)) throw new ChatToolDeniedException('This MCP token lacks the required scope: ' . $scope, 'scope');
        });
    }

    public function testAnAiReadsTheHistoryAndGoesBackToAVersion(): void
    {
        // Version 1 by the owner on the page; 2 and 3 by an AI over MCP, the last one breaking the page.
        $this->native->install(self::APP['id'], self::project('Notes'), 0, null, ['by' => 'owner', 'how' => 'page']);
        $this->native->install(self::APP['id'], self::project('Notes, with dates', ['data/days.json' => '[1,2]']), 1, null, ['by' => 'owner', 'how' => 'mcp', 'summary' => 'Dates on each note']);
        $this->native->install(self::APP['id'], self::project('<broken'), 2, null, ['by' => 'someone-else', 'how' => 'mcp', 'summary' => 'A change that broke it']);
        $tools = $this->tools();

        $list = $tools->call('list_native_app_versions', ['appId' => self::APP['id']], self::mcp());
        $this->assertSame(3, $list['current']);
        $this->assertSame([3, 2, 1], array_column($list['versions'], 'version'));
        $this->assertSame(2, $list['kept']);
        $this->assertSame('Dates on each note', $list['versions'][1]['summary']);
        $this->assertSame('mcp', $list['versions'][1]['how']);
        // Who made each is said only as whether it was the person asking: no one's id is handed out.
        $this->assertSame([false, true, true], array_column($list['versions'], 'byYou'));
        foreach ($list['versions'] as $row) $this->assertArrayNotHasKey('by', $row);
        $this->assertSame(['appId' => self::APP['id'], 'softnApp' => true], array_intersect_key($list, ['appId' => 1, 'softnApp' => 1]));

        // Version 2 against now: the page changed, and the data file is in version 2 only.
        $two = $tools->call('get_native_app_version', ['appId' => self::APP['id'], 'version' => 2], self::mcp());
        $this->assertSame(2, $two['version']['version']);
        $this->assertSame(['index.html'], array_column($two['differs']['changed'], 'path'));
        // `removed`: in that version and not in the app now.
        $this->assertSame(['data/days.json'], array_column($two['differs']['removed'], 'path'));
        $this->assertSame([], $two['differs']['added']);
        $file = $tools->call('get_native_app_version', ['appId' => self::APP['id'], 'version' => 2, 'file' => 'index.html'], self::mcp());
        $this->assertSame('<h1>Notes, with dates</h1>', $file['source']);
        $this->assertTrue($file['whole']);

        // Going back: a new version (4) with version 2's content, recorded as a going back by the person asking.
        $back = $tools->call('restore_native_app_version', ['appId' => self::APP['id'], 'version' => 2, 'expectedVersion' => 3], self::mcp());
        $this->assertSame(4, $back['version']);
        $this->assertSame(2, $back['restored']);
        $now = $this->native->get(self::APP['id']);
        $this->assertSame('<h1>Notes, with dates</h1>', $now['files']['index.html']);
        $this->assertSame('[1,2]', $now['files']['data/days.json']);
        $this->assertSame('members', $now['access'], 'who may enter stays as it is');
        $after = $tools->call('list_native_app_versions', ['appId' => self::APP['id']], self::mcp());
        $this->assertSame(['rollback', 2, true], [$after['versions'][0]['how'], $after['versions'][0]['restored'], $after['versions'][0]['byYou']]);
    }

    public function testAnEarlierVersionsLongFileIsReadInPartsWithoutGoingBack(): void
    {
        // A file longer than an answer carries: its parts by offset, as a project's own file is read; nothing tells the
        // AI to go back to the version to read the rest.
        $long = str_repeat('<p>line of the old page</p>' . "\n", 20_000);
        $this->native->install(self::APP['id'], self::project('Notes', ['big.html' => $long]), 0, null, ['by' => 'owner', 'how' => 'page']);
        $this->native->install(self::APP['id'], self::project('Notes'), 1, null, ['by' => 'owner', 'how' => 'page']);
        $tools = $this->tools();
        $read = '';
        $offset = 0;
        for ($parts = 0; $parts < 10; $parts++) {
            $part = $tools->call('get_native_app_version', ['appId' => self::APP['id'], 'version' => 1, 'file' => 'big.html', 'offset' => $offset], self::mcp());
            $read .= $part['source'];
            $this->assertSame($offset, $part['offset']);
            $this->assertStringNotContainsStringIgnoringCase('going back', (string) ($part['note'] ?? ''));
            $offset += strlen($part['source']);
            if ($offset >= $part['bytes']) break;
            $this->assertStringContainsString('Read on with offset: ' . $offset, $part['note']);
        }
        $this->assertGreaterThan(1, $parts + 1, 'it came in more than one part');
        $this->assertSame($long, $read, 'the parts are the whole file');
        $this->assertSame(2, $this->native->get(self::APP['id'])['version'], 'reading changed nothing: the app is at the version it was');
    }

    public function testGoingBackIsRefusedWithoutWhatAnUpdateNeedsOrOnAStaleVersion(): void
    {
        $this->native->install(self::APP['id'], self::project('One'), 0);
        $this->native->install(self::APP['id'], self::project('Two'), 1);
        $tools = $this->tools();
        // Reading is a read of the app; going back is an install, which asks for screen editing too.
        try {
            $tools->call('restore_native_app_version', ['appId' => self::APP['id'], 'version' => 1, 'expectedVersion' => 2], self::mcp(['apps:read', 'apps:write']));
            $this->fail('Going back without screen editing was allowed');
        } catch (ChatToolDeniedException) {}
        try {
            $tools->call('list_native_app_versions', ['appId' => self::APP['id']], self::mcp(['forms:read']));
            $this->fail('The history was read without the apps scope');
        } catch (ChatToolDeniedException) {}
        // A version that is not the app's current one any more: refused, and nothing installed.
        try {
            $tools->call('restore_native_app_version', ['appId' => self::APP['id'], 'version' => 1, 'expectedVersion' => 1], self::mcp());
            $this->fail('Going back from a version that is not the current one was allowed');
        } catch (\InvalidArgumentException $e) {
            $this->assertSame('The app is at version 2, not 1: it changed since you read it. Read list_native_app_versions again and go back from there. Nothing was installed.', $e->getMessage());
        }
        $this->assertSame(2, $this->native->get(self::APP['id'])['version']);
        foreach ([0, -1, '1', null] as $bad) {
            try {
                $tools->call('get_native_app_version', ['appId' => self::APP['id'], 'version' => $bad], self::mcp());
                $this->fail('A version that is not a number was taken: ' . var_export($bad, true));
            } catch (\InvalidArgumentException $e) {
                $this->assertStringContainsString('version number', $e->getMessage());
            }
        }
        // Another person's app, installed and with a history of its own, is not found, as for every
        // app tool, by any of the three; and one that is not there at all reads the same.
        $this->native->install(self::THEIRS['id'], self::project('Theirs'), 0);
        $this->native->install(self::THEIRS['id'], self::project('Theirs, later'), 1);
        foreach ([['list_native_app_versions', []], ['get_native_app_version', ['version' => 1]], ['get_native_app_version', ['version' => 1, 'file' => 'index.html']],
            ['restore_native_app_version', ['version' => 1, 'expectedVersion' => 2]]] as [$tool, $args]) {
            foreach ([self::THEIRS['id'], 'no-such-app'] as $appId) {
                try {
                    $tools->call($tool, ['appId' => $appId] + $args, self::mcp());
                    $this->fail("{$tool} reached {$appId}");
                } catch (ChatToolDeniedException $e) {
                    $this->assertSame('App not found or access denied', $e->getMessage(), "{$tool} {$appId}");
                }
            }
        }
        $this->assertSame(2, $this->native->get(self::THEIRS['id'])['version'], 'their app was not gone back');
    }
}
