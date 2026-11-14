<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\NativeAppService;
use PHPUnit\Framework\TestCase;

/**
 * FormLogic's own small settings in an installed app's private folder: listed by kind, removed from
 * every app at once (a plugin removed), and changed under a lock of their own. Never the app's
 * configuration, and never a name that is not one of these.
 */
final class NativeAppPrivateFilesTest extends TestCase
{
    private string $storage;

    protected function setUp(): void
    {
        $this->storage = sys_get_temp_dir() . '/formlogic-private-files-' . bin2hex(random_bytes(6));
        mkdir($this->storage, 0700, true);
    }

    protected function tearDown(): void
    {
        $root = realpath($this->storage);
        if ($root === false || !str_starts_with(basename($root), 'formlogic-private-files-')) return;
        foreach (new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST) as $file) {
            if ($file->isDir() && !$file->isLink()) rmdir($file->getPathname()); else unlink($file->getPathname());
        }
        rmdir($root);
    }

    /** An installed app's private folder, with $files in it. */
    private function app(string $appId, array $files): string
    {
        $root = $this->storage . '/' . hash('sha256', $appId);
        mkdir($root . '/private', 0700, true);
        file_put_contents($root . '/project.json', '{}');
        foreach ($files as $name => $text) file_put_contents($root . '/private/' . $name, $text);
        return $root . '/private';
    }

    public function testAnAppsPrivateFilesAreListedByKind(): void
    {
        $this->app('app-1', ['plugin-bbb.json' => '{}', 'plugin-aaa.json' => '{}', 'config.json' => '{}', 'verify.json' => '{}', 'plugin-aaa.lock' => '', 'plugin-Bad.json' => '{}']);
        $native = new NativeAppService($this->storage);
        $this->assertSame(['plugin-aaa.json', 'plugin-bbb.json'], $native->privateFileNames('app-1', 'plugin-'));
        $this->assertSame([], $native->privateFileNames('not-installed', 'plugin-'));
        $this->expectException(\InvalidArgumentException::class);
        $native->privateFileNames('app-1', '../');
    }

    public function testOneFileIsRemovedFromEveryAppThatHasIt(): void
    {
        $one = $this->app('app-1', ['plugin-aaa.json' => '{}', 'plugin-aaa.lock' => '', 'plugin-bbb.json' => '{}']);
        $two = $this->app('app-2', ['plugin-aaa.json' => '{}']);
        $three = $this->app('app-3', ['verify.json' => '{}']);
        $native = new NativeAppService($this->storage);
        $this->assertSame(2, $native->removePrivateFileEverywhere('plugin-aaa.json'));
        $this->assertSame(['plugin-bbb.json'], array_values(array_diff(scandir($one), ['.', '..'])));
        $this->assertSame([], array_values(array_diff(scandir($two), ['.', '..'])));
        $this->assertSame(['verify.json'], array_values(array_diff(scandir($three), ['.', '..'])));
        foreach (['config.json', '../x.json', 'plugin-aaa.lock'] as $name) {
            try {
                $native->removePrivateFileEverywhere($name);
                $this->fail('removed ' . $name);
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
    }

    public function testASettingIsChangedUnderItsOwnLock(): void
    {
        $folder = $this->app('app-1', []);
        $native = new NativeAppService($this->storage);
        $seen = $native->withPrivateFileLock('app-1', 'plugin-aaa.json', function () use ($folder): string {
            // Held: another taking it now would wait.
            $other = fopen($folder . '/plugin-aaa.lock', 'c');
            $free = flock($other, LOCK_EX | LOCK_NB);
            fclose($other);
            return $free ? 'free' : 'held';
        });
        $this->assertSame('held', $seen);
        $this->assertFileExists($folder . '/plugin-aaa.lock');
        try {
            $native->withPrivateFileLock('not-installed', 'plugin-aaa.json', fn () => null);
            $this->fail('locked for an app not installed');
        } catch (\RuntimeException $e) {
            $this->assertSame(409, $e->getCode());
        }
    }
}
