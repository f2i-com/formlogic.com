<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\NativeAppController;
use FormLogic\Services\{AppService, AppUserService, NativeAppService, PlanService, FlowService, RuntimeEngineService};
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * A game's pictures and sounds, served as one pack the browser keeps: the project a page fetches
 * leaves them out, the pack is admitted exactly as the project is, cached privately by its hash,
 * and rebuilt when the app changes. A page from before the pack still gets its media inline. And
 * whether an app may use files on the person's device is the owner's choice, sent to the page.
 */
final class NativeAppMediaPackTest extends TestCase
{
    private ?string $storage = null;

    protected function tearDown(): void
    {
        if ($this->storage === null || !is_dir($this->storage)) return;
        $root = realpath($this->storage);
        $temp = realpath(sys_get_temp_dir()) . DIRECTORY_SEPARATOR;
        if ($root === false || !str_starts_with($root, $temp) || !str_starts_with(basename($root), 'formlogic-native-media-')) throw new \RuntimeException('Unexpected fixture path');
        $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($iterator as $file) { if ($file->isDir() && !$file->isLink()) rmdir($file->getPathname()); else unlink($file->getPathname()); }
        rmdir($root);
    }

    private const PNG = "\x89PNG\r\n\x1a\n\x00\xff\x80\x07";

    /** An installed app, written as an install leaves it, with the media given. */
    private function install(string $access = 'application', array $media = [], int $version = 1, ?\Closure $encode = null): string
    {
        $this->storage ??= sys_get_temp_dir() . '/formlogic-native-media-' . bin2hex(random_bytes(8));
        $root = $this->storage . '/' . hash('sha256', 'notes');
        if (!is_dir($root . '/private')) mkdir($root . '/private', 0700, true);
        file_put_contents($root . '/project.json', json_encode([
            'home' => false, 'version' => $version, 'access' => $access,
            'files' => ['manifest.json' => '{"id":"notes","main":"ui/main.ui"}', 'ui/main.ui' => '<Text>Notes</Text>'],
            'assets' => array_map($encode ?? 'base64_encode', $media),
        ]));
        return $root;
    }

    private function controller(array $settings = ['softnApp' => true], ?AppUserService $users = null): NativeAppController
    {
        $app = ['id' => 'notes', 'slug' => 'notes', 'ownerId' => 'owner', 'name' => 'Notes', 'status' => 'published', 'settings' => $settings];
        $apps = $this->createMock(AppService::class);
        $apps->method('getAppBySlug')->willReturn($app);
        $apps->method('getApp')->willReturn($app);
        $apps->method('isRuntimeVisible')->willReturn(true);
        $engines = $this->createMock(RuntimeEngineService::class);
        $engines->method('effective')->willReturn(['id' => 'zipp-web-python', 'requested' => 'zipp-web-python', 'stored' => null, 'revision' => '0123456789abcdef']);
        return new NativeAppController($apps, $users ?? $this->createMock(AppUserService::class), new NativeAppService($this->storage, $this->storage . '/no-runtime'),
            $this->createMock(PlanService::class), $this->createMock(FlowService::class), $engines);
    }

    private function get(NativeAppController $controller, string $path, array $query = [], array $headers = [], ?string $user = null): ResponseInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest('GET', $path . ($query ? '?' . http_build_query($query) : ''))->withQueryParams($query);
        foreach ($headers as $name => $value) $request = $request->withHeader($name, $value);
        if ($user !== null) $request = $request->withAttribute('userId', $user);
        return $controller->runtime($request, new Response(), ['slug' => 'notes']);
    }

    private static function body(ResponseInterface $response): array
    {
        return json_decode((string) $response->getBody(), true);
    }

    /** The pack read back: path => bytes, checked against its own header. */
    private static function unpack(string $pack): array
    {
        self::assertSame('FLMEDIA1', substr($pack, 0, 8));
        $length = unpack('N', substr($pack, 8, 4))[1];
        $header = json_decode(substr($pack, 12, $length), true);
        $base = 12 + $length;
        $files = [];
        foreach ($header['files'] as $file) $files[$file['path']] = substr($pack, $base + $file['offset'], $file['size']);
        self::assertSame(strlen($pack), $base + array_sum(array_column($header['files'], 'size')), 'nothing after the last file');
        return $files;
    }

    public function testAPageThatAsksForThePackGetsTheProjectWithoutItsMediaAndThePacksAddress(): void
    {
        $this->install('application', ['assets/a.png' => self::PNG, 'assets/b.mp3' => str_repeat("\x01\x02\x03", 4000)]);
        $controller = $this->controller();
        $body = self::body($this->get($controller, '/api/app/notes/native', ['media' => 'pack']));
        $this->assertSame([], $body['project']['assets']);
        $media = $body['project']['media'];
        $this->assertSame(2, $media['count']);
        // What the browser will download: the pack, its index included.
        $this->assertSame(strlen((string) $this->get($controller, '/api/app/notes/native/media')->getBody()), $media['size']);
        $this->assertGreaterThan(strlen(self::PNG) + 12000, $media['size']);
        $this->assertMatchesRegularExpression('/^[0-9a-f]{64}$/', $media['sha256']);
        $this->assertSame('/app/notes/native/media?h=' . $media['sha256'], $media['url']);
        $this->assertArrayNotHasKey('files', $body['project'], 'files are off unless the owner chose');
    }

    public function testThePackHoldsEveryFileByteForByteAndIsKeptPrivatelyByItsHash(): void
    {
        $media = ['assets/a.png' => self::PNG, 'assets/audio/b.mp3' => random_bytes(70000), 'assets/empty.txt' => ''];
        $this->install('application', $media);
        $controller = $this->controller();
        $hash = self::body($this->get($controller, '/api/app/notes/native', ['media' => 'pack']))['project']['media']['sha256'];

        $response = $this->get($controller, '/api/app/notes/native/media', ['h' => $hash]);
        $this->assertSame(200, $response->getStatusCode());
        $pack = (string) $response->getBody();
        $this->assertSame($media, self::unpack($pack));
        $this->assertSame($hash, hash('sha256', $pack), 'the address names the bytes it serves');
        $this->assertSame('private, max-age=31536000, immutable', $response->getHeaderLine('Cache-Control'), 'never a shared cache: a members-only app\'s pictures');
        $this->assertSame('"' . $hash . '"', $response->getHeaderLine('ETag'));
        $this->assertSame((string) strlen($pack), $response->getHeaderLine('Content-Length'));

        // An address naming another version is answered, but checked again each time.
        $this->assertSame('private, no-cache', $this->get($controller, '/api/app/notes/native/media', ['h' => str_repeat('0', 64)])->getHeaderLine('Cache-Control'));
        // And the browser's copy is confirmed without sending it again.
        $again = $this->get($controller, '/api/app/notes/native/media', ['h' => $hash], ['If-None-Match' => '"' . $hash . '"']);
        $this->assertSame(304, $again->getStatusCode());
        $this->assertSame('', (string) $again->getBody());
    }

    public function testAnAppBehindAPassHasItsMediaCheckedEachTime(): void
    {
        $this->install('application', ['assets/a.png' => self::PNG]);
        $controller = $this->controller(['softnApp' => true, 'requires' => [['plugin' => 'age-gate', 'pass' => 'age', 'min' => 18]]]);
        $hash = self::body($this->get($controller, '/api/app/notes/native', ['media' => 'pack']))['project']['media']['sha256'];
        $this->assertSame('private, no-cache', $this->get($controller, '/api/app/notes/native/media', ['h' => $hash])->getHeaderLine('Cache-Control'));
    }

    public function testThePackIsMadeOnceAndAgainWhenTheAppChanges(): void
    {
        $root = $this->install('application', ['assets/a.png' => self::PNG]);
        $controller = $this->controller();
        $first = self::body($this->get($controller, '/api/app/notes/native', ['media' => 'pack']))['project']['media']['sha256'];
        $cache = glob($root . '/runtime-cache/*');
        $this->assertCount(2, $cache, 'the project without its media, and the pack');
        $made = array_map('filemtime', $cache);
        clearstatcache();
        $this->assertSame($first, self::body($this->get($controller, '/api/app/notes/native', ['media' => 'pack']))['project']['media']['sha256']);
        $this->assertSame($made, array_map('filemtime', glob($root . '/runtime-cache/*')), 'read, not made again');

        // A new version of the app: a new pack, and the old one gone.
        $this->install('application', ['assets/a.png' => self::PNG, 'assets/c.png' => self::PNG . 'x'], 2);
        $body = self::body($this->get($controller, '/api/app/notes/native', ['media' => 'pack']));
        $this->assertSame(2, $body['project']['version']);
        $this->assertSame(2, $body['project']['media']['count']);
        $this->assertNotSame($first, $body['project']['media']['sha256']);
        $this->assertCount(2, glob($root . '/runtime-cache/*'), 'the old version\'s cache is removed');
        $this->assertSame([], glob($root . '/runtime-cache/*.pending-*'));
    }

    public function testMediaWhoseBase64HasLineBreaksOrNoPaddingIsPackedWhole(): void
    {
        // validateProject() takes both (PHP's strict base64 skips whitespace and needs no padding), as
        // a project sent through the API or MCP from Python's encodebytes or chunk_split has them.
        $media = ['assets/a.png' => random_bytes(1000), 'assets/b.png' => random_bytes(1001), 'assets/c.png' => random_bytes(1002)];
        foreach ([static fn(string $bytes) => chunk_split(base64_encode($bytes), 76, "\r\n"), static fn(string $bytes) => rtrim(base64_encode($bytes), '=')] as $encode) {
            $this->install('application', $media, 1, $encode);
            NativeAppService::validateProject(json_decode((string) file_get_contents($this->storage . '/' . hash('sha256', 'notes') . '/project.json'), true));
            $controller = $this->controller();
            $response = $this->get($controller, '/api/app/notes/native', ['media' => 'pack']);
            $this->assertSame(200, $response->getStatusCode(), (string) $response->getBody());
            $this->assertSame($media, self::unpack((string) $this->get($controller, '/api/app/notes/native/media')->getBody()));
        }
    }

    public function testAPageFromBeforeThePackStillGetsItsMediaInTheProject(): void
    {
        $this->install('application', ['assets/a.png' => self::PNG]);
        $body = self::body($this->get($this->controller(), '/api/app/notes/native'));
        $this->assertSame(['assets/a.png' => base64_encode(self::PNG)], $body['project']['assets']);
        $this->assertArrayNotHasKey('media', $body['project']);
    }

    public function testThePackIsRefusedToWhoeverTheProjectIsRefusedTo(): void
    {
        $this->install('members', ['assets/a.png' => self::PNG]);
        $users = $this->createMock(AppUserService::class);
        $users->method('getAppUser')->willReturnCallback(static fn(string $app, string $user) => $user === 'member' ? ['status' => 'active', 'roleId' => 'viewer'] : ['status' => 'pending']);
        $controller = $this->controller(['softnApp' => true], $users);
        foreach ([null, 'stranger'] as $who) {
            $response = $this->get($controller, '/api/app/notes/native/media', [], [], $who);
            $this->assertContains($response->getStatusCode(), [401, 403], 'no pictures for ' . ($who ?? 'someone signed out'));
            $this->assertStringNotContainsString('FLMEDIA1', (string) $response->getBody());
        }
        $member = $this->get($controller, '/api/app/notes/native/media', [], [], 'member');
        $this->assertSame(200, $member->getStatusCode());
        // Checked with the server each time it is used, so a browser's copy is read only by someone admitted.
        $hash = self::body($this->get($controller, '/api/app/notes/native', ['media' => 'pack'], [], 'member'))['project']['media']['sha256'];
        $this->assertSame('private, no-cache', $this->get($controller, '/api/app/notes/native/media', ['h' => $hash], [], 'member')->getHeaderLine('Cache-Control'));
        $this->assertSame(['assets/a.png' => self::PNG], self::unpack((string) $member->getBody()));
    }

    public function testFilesAreSentToThePageAsTheOwnerChose(): void
    {
        $this->install('application', []);
        foreach (['ask', 'allow'] as $choice) {
            $body = self::body($this->get($this->controller(['softnApp' => true, 'softnFiles' => $choice]), '/api/app/notes/native', ['media' => 'pack']));
            $this->assertSame($choice, $body['project']['files']);
        }
        foreach ([true, 'yes', 'Allow', ['allow']] as $odd) {
            $body = self::body($this->get($this->controller(['softnApp' => true, 'softnFiles' => $odd]), '/api/app/notes/native', ['media' => 'pack']));
            $this->assertArrayNotHasKey('files', $body['project'], 'only the two choices grant anything');
        }
    }

    public function testTheSettingKeepsOnlyTheTwoChoices(): void
    {
        $service = (new \ReflectionClass(AppService::class))->newInstanceWithoutConstructor();
        $sanitize = new \ReflectionMethod(AppService::class, 'sanitizeAppSettings');
        $this->assertSame('ask', $sanitize->invoke($service, ['softnFiles' => 'ask'])['softnFiles']);
        $this->assertSame('allow', $sanitize->invoke($service, ['softnFiles' => 'allow'])['softnFiles']);
        foreach (['off', 'ALLOW', true, 1, ['allow'], null, ''] as $odd) {
            $this->assertArrayNotHasKey('softnFiles', $sanitize->invoke($service, ['softnFiles' => $odd]), var_export($odd, true));
        }
    }

    public function testMemoryIsAskedForAsAProjectNeedsIt(): void
    {
        $this->assertSame(128 * 1024 * 1024, NativeAppService::memoryBytes('128M'));
        $this->assertSame(1024 ** 3, NativeAppService::memoryBytes('1G'));
        $this->assertSame(-1, NativeAppService::memoryBytes('-1'));
        $before = ini_get('memory_limit');
        try {
            ini_set('memory_limit', '256M');
            $this->assertTrue(NativeAppService::raiseMemoryFor(64 * 1024 * 1024), 'the largest project gets the room it needs');
            $this->assertGreaterThanOrEqual(96 * 1024 * 1024 + 4 * 64 * 1024 * 1024, NativeAppService::memoryBytes((string) ini_get('memory_limit')));
            $this->assertTrue(NativeAppService::raiseMemoryFor(1024), 'and a small one never lowers it');
            ini_set('memory_limit', '2G');
            $this->assertFalse(NativeAppService::raiseMemoryFor(500 * 1024 * 1024), 'more than 1.5 GB is not asked for');
            $this->assertSame('2G', ini_get('memory_limit'), 'and a host that gives more keeps it');
            $this->assertGreaterThanOrEqual(96 * 1024 * 1024 + 4 * 64 * 1024 * 1024, NativeAppService::memoryBytes((string) ini_get('memory_limit')));
        } finally {
            ini_set('memory_limit', (string) $before);
        }
    }
}
