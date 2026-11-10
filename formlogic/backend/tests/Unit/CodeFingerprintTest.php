<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Support\CodeFingerprint;
use PHPUnit\Framework\TestCase;

/**
 * The server code's fingerprint: what a long-running worker compares to tell that FormLogic was
 * updated under it. It changes with any change to the code a worker could load, and with nothing else.
 */
final class CodeFingerprintTest extends TestCase
{
    private string $backend = '';

    protected function setUp(): void
    {
        $this->backend = sys_get_temp_dir() . '/formlogic-fingerprint-' . bin2hex(random_bytes(4));
        foreach (['src/Services', 'config', 'bin/runtime', 'vendor/composer', 'public', 'storage'] as $folder) mkdir($this->backend . '/' . $folder, 0777, true);
        $this->put('src/Services/Worker.php', '<?php // one');
        $this->put('src/Helper.php', '<?php // helper');
        $this->put('config/settings.php', '<?php return [];');
        $this->put('bin/app-ai-worker.php', '<?php // script');
        $this->put('vendor/composer/installed.php', '<?php return ["a" => "1.0.0"];');
        $this->put('bin/runtime/SOURCE.json', '{}');
        $this->put('public/index.html', '<html>');
        $this->put('storage/app-ai.json', '{}');
    }

    protected function tearDown(): void
    {
        $files = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($this->backend, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($files as $file) $file->isDir() ? @rmdir($file->getPathname()) : @unlink($file->getPathname());
        @rmdir($this->backend);
    }

    /** Write a file as it was written at a fixed moment, so only what a test changes changes. */
    private function put(string $name, string $content, int $at = 1794000000): void
    {
        file_put_contents($this->backend . '/' . $name, $content);
        touch($this->backend . '/' . $name, $at);
    }

    private function now(): string
    {
        return CodeFingerprint::onDisk($this->backend);
    }

    public function testItIsTheSameUntilTheCodeChanges(): void
    {
        $before = $this->now();
        $this->assertMatchesRegularExpression('/^[a-f0-9]{16}$/D', $before);
        $this->assertSame($before, $this->now());
        // What is not the server's code: the browser's files, what the site keeps, the native runtime's own.
        $this->put('public/index.html', '<html><body>new</body>');
        $this->put('storage/app-ai.json', '{"allowApps":true}');
        $this->put('bin/runtime/SOURCE.json', '{"version":"2"}');
        $this->put('bin/runtime/tool.php', '<?php // not a script of ours');
        $this->put('src/notes.txt', 'not code');
        $this->assertSame($before, $this->now());
    }

    public function testAnOrdinaryUpdateChangesItWhateverItTouches(): void
    {
        $before = $this->now();
        // A source file with new content.
        $this->put('src/Services/Worker.php', '<?php // one, and more');
        $changed = $this->now();
        $this->assertNotSame($before, $changed);
        // The same size, written at another time (an update that changed a name of equal length).
        $this->put('src/Services/Worker.php', '<?php // two, and more', 1794000060);
        $retimed = $this->now();
        $this->assertNotSame($changed, $retimed);
        // A new file, with no schema change anywhere.
        $this->put('src/Services/New.php', '<?php // new');
        $added = $this->now();
        $this->assertNotSame($retimed, $added);
        // A file removed.
        unlink($this->backend . '/src/Helper.php');
        $removed = $this->now();
        $this->assertNotSame($added, $removed);
        // The worker's own script, the settings, and what Composer installed.
        $this->put('bin/app-ai-worker.php', '<?php // script, changed');
        $script = $this->now();
        $this->assertNotSame($removed, $script);
        $this->put('config/settings.php', '<?php return ["x" => 1];');
        $settings = $this->now();
        $this->assertNotSame($script, $settings);
        $this->put('vendor/composer/installed.php', '<?php return ["a" => "1.0.1"];', 1794000300);
        $this->assertNotSame($settings, $this->now());
    }

    public function testItIsPutBackWhenTheCodeIs(): void
    {
        $before = $this->now();
        $this->put('src/Helper.php', '<?php // helper, changed', 1794000100);
        $this->assertNotSame($before, $this->now());
        $this->put('src/Helper.php', '<?php // helper');
        $this->assertSame($before, $this->now(), 'the same files, sizes and times are the same code');
    }

    public function testThisInstallationHasOne(): void
    {
        $this->assertMatchesRegularExpression('/^[a-f0-9]{16}$/D', CodeFingerprint::onDisk());
        $this->assertSame(CodeFingerprint::onDisk(), CodeFingerprint::onDisk());
    }
}
