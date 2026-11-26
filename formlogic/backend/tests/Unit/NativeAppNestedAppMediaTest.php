<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Services\NativeAppService;
use PHPUnit\Framework\TestCase;

/**
 * An app a web app's page nests (`<softn-app src="assets/widgets/clock.softn">`): a `.softn`
 * archive kept among the app's media. Under assets/ it is kept byte for byte, held to a media
 * file's limits and handed to the page in the media pack with the rest; it is never a source
 * file, and nothing of the private tree may be one. Before, every `.softn` was refused as a file
 * of a kind this host does not keep, so an app hosted here could nest none.
 */
final class NativeAppNestedAppMediaTest extends TestCase
{
    private ?string $storage = null;

    protected function tearDown(): void
    {
        if ($this->storage === null || !is_dir($this->storage)) return;
        $root = realpath($this->storage);
        $temp = realpath(sys_get_temp_dir()) . DIRECTORY_SEPARATOR;
        if ($root === false || !str_starts_with($root, $temp) || !str_starts_with(basename($root), 'formlogic-native-nested-')) throw new \RuntimeException('Unexpected fixture path');
        $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($iterator as $file) { if ($file->isDir() && !$file->isLink()) rmdir($file->getPathname()); else unlink($file->getPathname()); }
        rmdir($root);
    }

    /** A nested app's archive as the page is given it: a ZIP's first bytes, then every byte value once. */
    private static function archive(): string
    {
        return "PK\x03\x04" . implode('', array_map('chr', range(0, 255)));
    }

    /** A web app whose page nests the clock. */
    private static function files(): array
    {
        return [
            'manifest.json' => json_encode(['name' => 'Board', 'version' => '1.0.0', 'engine' => 2, 'main' => 'index.html'], JSON_THROW_ON_ERROR),
            'index.html' => '<!doctype html><html><body><softn-app src="assets/widgets/clock.softn" style="display:block;height:240px"></softn-app></body></html>',
        ];
    }

    private static function refusal(array $project): string
    {
        try { NativeAppService::validateProject($project); }
        catch (\InvalidArgumentException $refused) { return $refused->getMessage(); }
        return 'kept';
    }

    public function testANestedAppIsAMediaFileUnderAssetsAndNowhereElse(): void
    {
        foreach (['assets/widgets/clock.softn', 'assets/clock.softn', 'assets/Widgets/Clock.SOFTN'] as $path) {
            $this->assertSame(1, preg_match(NativeAppService::MEDIA_PATH, $path), $path);
        }
        // Not beside the page (SoftN's own example keeps one there; here it goes with the media), not in
        // the private tree, not a name with a second ending, and not a .zip: an archive this host keeps is
        // named as an app.
        foreach (['widgets/clock.softn', 'clock.softn', 'backend/clock.softn', 'server/clock.softn', 'private/clock.softn', 'site/clock.softn', 'assets/clock.softn.php', 'assets/clock.zip', 'assets/clock softn'] as $path) {
            $this->assertSame(0, preg_match(NativeAppService::MEDIA_PATH, $path), $path);
        }
    }

    public function testItIsKeptByteForByteAsMediaAndNeverAsSource(): void
    {
        $bytes = self::archive();
        [$files, $media] = NativeAppService::validateProject(['files' => self::files(), 'assets' => ['assets/widgets/clock.softn' => base64_encode($bytes), 'assets/logo.png' => base64_encode("\x89PNG")]]);
        $this->assertSame($bytes, $media['assets/widgets/clock.softn']);
        $this->assertSame(array_keys(self::files()), array_keys($files));
        $this->assertSame(array_keys(self::files()), array_keys(NativeAppService::clientFiles(['files' => $files])));

        // Sent as a source file it is refused: it is no text the page or the runner is handed.
        $this->assertStringContainsString('Invalid app source file: assets/widgets/clock.softn', self::refusal(['files' => self::files() + ['assets/widgets/clock.softn' => $bytes], 'assets' => []]));
        // Sent as media anywhere but assets/, as any other media file is.
        foreach (['widgets/clock.softn', 'backend/clock.softn', 'server/clock.softn', 'assets/../clock.softn'] as $path) {
            $this->assertSame("Invalid media file: {$path}", self::refusal(['files' => self::files(), 'assets' => [$path => base64_encode($bytes)]]), $path);
        }
        $this->assertSame('Invalid media data: the content of assets/widgets/clock.softn is not base64.', self::refusal(['files' => self::files(), 'assets' => ['assets/widgets/clock.softn' => '%%%']]));
    }

    public function testItIsHeldToAMediaFilesLimitAndCountsTowardsTheProjects(): void
    {
        // 32 MB a file, as every media file is: half of what SoftN itself nests (64 MiB).
        $over = base64_encode(str_repeat("\0", NativeAppService::MAX_MEDIA_FILE_BYTES + 1));
        $this->assertSame('assets/widgets/big.softn is larger than this host keeps (32 MB per media file).', self::refusal(['files' => self::files(), 'assets' => ['assets/widgets/big.softn' => $over]]));
        unset($over);
        // What the project holds in all: sources just under 64 MB are kept, and one small nested app
        // more takes the project over.
        $sources = self::files();
        for ($i = 0; $i < 44; $i++) $sources["styles/s{$i}.css"] = str_repeat('a', NativeAppService::MAX_SOURCE_FILE_BYTES);
        $this->assertSame('kept', self::refusal(['files' => $sources, 'assets' => []]));
        $this->assertSame('Native project exceeds 64 MB', self::refusal(['files' => $sources, 'assets' => ['assets/widgets/clock.softn' => base64_encode(str_repeat("\x01", 1200000))]]));
    }

    public function testThePageIsHandedItInTheMediaPackAsItWasKept(): void
    {
        $this->storage = sys_get_temp_dir() . '/formlogic-native-nested-' . bin2hex(random_bytes(8));
        $root = $this->storage . '/' . hash('sha256', 'board');
        mkdir($root . '/private', 0700, true);
        $media = ['assets/widgets/clock.softn' => self::archive(), 'assets/logo.png' => "\x89PNG\r\n\x1a\n"];
        file_put_contents($root . '/project.json', json_encode(['home' => false, 'version' => 1, 'access' => 'application', 'files' => self::files(), 'assets' => array_map('base64_encode', $media)], JSON_THROW_ON_ERROR));
        $service = new NativeAppService($this->storage, $this->storage . '/no-runtime');
        $this->assertSame(['assets/widgets/clock.softn', 'assets/logo.png'], $service->mediaPaths('board'));
        $stream = $service->runtimeProject('board', true)['media']['stream'];
        try { $pack = (string) stream_get_contents($stream); } finally { fclose($stream); }
        $this->assertSame('FLMEDIA1', substr($pack, 0, 8));
        $length = unpack('N', substr($pack, 8, 4))[1];
        $index = json_decode(substr($pack, 12, $length), true);
        $found = [];
        foreach ($index['files'] as $file) $found[$file['path']] = substr($pack, 12 + $length + $file['offset'], $file['size']);
        $this->assertSame($media, $found);
    }

    public function testAnArchiveReadOnTheServerKeepsIt(): void
    {
        if (!class_exists(\ZipArchive::class)) $this->markTestSkipped('ZipArchive is not installed');
        $this->storage = sys_get_temp_dir() . '/formlogic-native-nested-' . bin2hex(random_bytes(8));
        mkdir($this->storage, 0700, true);
        $path = $this->storage . '/board.softn';
        $zip = new \ZipArchive();
        $this->assertTrue($zip->open($path, \ZipArchive::CREATE));
        foreach (self::files() as $name => $text) $zip->addFromString($name, $text);
        $zip->addFromString('assets/widgets/clock.softn', self::archive());
        $zip->close();
        $project = NativeAppService::extractProjectFromArchive($path);
        $this->assertSame(['assets/widgets/clock.softn'], array_keys($project['assets']));
        $this->assertSame(self::archive(), base64_decode($project['assets']['assets/widgets/clock.softn'], true));
        $this->assertArrayNotHasKey('assets/widgets/clock.softn', $project['files']);
    }
}
