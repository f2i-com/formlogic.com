<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\NativeAppController;
use FormLogic\Middleware\SecurityHeadersMiddleware;
use FormLogic\Services\{AppService, AppUserService, NativeAppService, PlanService, FlowService, RuntimeEngineService};
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * An app's media on its owner's page: the page is given each file's name, size and SHA-256, not its
 * bytes (a game's ran to tens of megabytes on every visit); a file's bytes are read one at a time,
 * by its owner, for a download or an editor; and a save that leaves a file as it was names it, and
 * the server keeps the copy it has. The apps are installed for real (NativeAppService::install, with
 * no backend, so nothing is started).
 */
final class NativeAppOwnerMediaTest extends TestCase
{
    private const APP_ID = 'notes-id';
    private const PNG = "\x89PNG\r\n\x1a\n\x00\xff\x80\x07";
    private const NOTES = ['manifest.json' => '{"id":"notes","main":"ui/main.ui"}', 'ui/main.ui' => '<Text>Notes</Text>'];

    private ?string $storage = null;
    private NativeAppService $native;
    private string $sound;

    protected function setUp(): void
    {
        $this->storage = sys_get_temp_dir() . '/formlogic-owner-media-' . bin2hex(random_bytes(8));
        mkdir($this->storage, 0700);
        $this->native = new NativeAppService($this->storage, $this->storage . '/no-runtime');
        $this->sound = random_bytes(70000);
    }

    protected function tearDown(): void
    {
        if ($this->storage === null || !is_dir($this->storage)) return;
        $root = realpath($this->storage);
        $temp = realpath(sys_get_temp_dir()) . DIRECTORY_SEPARATOR;
        if ($root === false || !str_starts_with($root, $temp) || !str_starts_with(basename($root), 'formlogic-owner-media-')) throw new \RuntimeException('Unexpected fixture path');
        $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($iterator as $file) { if ($file->isDir() && !$file->isLink()) rmdir($file->getPathname()); else unlink($file->getPathname()); }
        rmdir($root);
    }

    /** The app's media as installed: a picture, a sound in a folder, and an empty text file. */
    private function media(): array
    {
        return ['assets/a.png' => self::PNG, 'assets/sound/b.mp3' => $this->sound, 'assets/empty.txt' => ''];
    }

    private function installNotes(array $media, int $expected = 0, array $files = self::NOTES): array
    {
        return $this->native->install(self::APP_ID, ['access' => 'application', 'files' => $files, 'assets' => array_map('base64_encode', $media)], $expected);
    }

    private function controller(): NativeAppController
    {
        $app = ['id' => self::APP_ID, 'slug' => 'notes', 'ownerId' => 'owner', 'name' => 'Notes', 'status' => 'published', 'settings' => ['softnApp' => true]];
        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturn($app);
        $engines = $this->createMock(RuntimeEngineService::class);
        $engines->method('effective')->willReturn(['id' => 'zipp-web-python', 'requested' => 'zipp-web-python', 'stored' => null, 'revision' => '0123456789abcdef']);
        return new NativeAppController($apps, $this->createMock(AppUserService::class), $this->native, $this->createMock(PlanService::class), $this->createMock(FlowService::class), $engines);
    }

    /** One request to the owner's routes (manage()), as `$user`. */
    private function call(string $method, array $query = [], ?array $body = null, string $user = 'owner', array $headers = [], array $args = []): ResponseInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, '/api/apps/' . self::APP_ID . '/native' . (($args['operation'] ?? '') !== '' ? '/' . $args['operation'] : '') . ($query ? '?' . http_build_query($query) : ''))
            ->withQueryParams($query)->withAttribute('userId', $user);
        if ($body !== null) $request = $request->withParsedBody($body);
        foreach ($headers as $name => $value) $request = $request->withHeader($name, $value);
        return $this->controller()->manage($request, new Response(), ['id' => self::APP_ID] + $args);
    }

    private function file(string $path, string $kept, string $user = 'owner', array $headers = []): ResponseInterface
    {
        return $this->call('GET', ['path' => $path, 'kept' => $kept], null, $user, $headers, ['operation' => 'media']);
    }

    /** The body read, and the response's stream closed: a file still open cannot be removed on Windows when the fixture goes. */
    private static function read(ResponseInterface $response): string
    {
        $body = (string) $response->getBody();
        $response->getBody()->close();
        return $body;
    }

    private static function json(ResponseInterface $response): array
    {
        return json_decode(self::read($response), true);
    }

    private static function ref(string $bytes): array
    {
        return ['kept' => hash('sha256', $bytes), 'size' => strlen($bytes)];
    }

    public function testTheOwnersPageIsGivenEachMediaFileByNameAndSizeNotItsBytes(): void
    {
        $this->installNotes($this->media());
        $response = $this->call('GET', ['media' => 'refs']);
        $raw = self::read($response);
        $this->assertSame(200, $response->getStatusCode(), $raw);
        $project = json_decode($raw, true)['project'];
        $this->assertSame(array_map(self::ref(...), $this->media()), $project['assets'], 'each named, in the project\'s order');
        $this->assertSame(self::NOTES, $project['files']);
        $this->assertSame([1, 'application', false], [$project['version'], $project['access'], $project['home']]);
        $this->assertArrayHasKey('updatedAt', $project);
        $this->assertStringNotContainsString(substr(base64_encode($this->sound), 0, 40), $raw, 'no bytes of a file');
        $this->assertLessThan(2000, strlen($raw));

        // Anything that does not ask is sent every file in base64, as it always was.
        $full = self::json($this->call('GET'))['project'];
        $this->assertSame(array_map('base64_encode', $this->media()), $full['assets']);
    }

    public function testAnAppWithNoMediaIsGivenAnEmptyListAndNothingInstalledIsNoProject(): void
    {
        $this->assertNull(self::json($this->call('GET', ['media' => 'refs']))['project'], 'nothing installed');
        $this->installNotes([]);
        $raw = self::read($this->call('GET', ['media' => 'refs']));
        $this->assertStringContainsString('"assets":{}', $raw, 'an object, as the page reads it, never a list');
    }

    public function testASummaryMadeBeforeItNamedTheMediaIsMadeAgain(): void
    {
        $this->installNotes($this->media());
        $this->call('GET', ['media' => 'refs'])->getBody()->close();
        $root = $this->storage . '/' . hash('sha256', self::APP_ID) . '/runtime-cache';
        $summaries = glob($root . '/client-*.json') ?: [];
        $this->assertCount(1, $summaries);
        // As a FormLogic before this one wrote it: the project and its pack, no names.
        $old = json_decode((string) file_get_contents($summaries[0]), true);
        unset($old['kept']);
        file_put_contents($summaries[0], json_encode($old, JSON_UNESCAPED_SLASHES));

        $project = self::json($this->call('GET', ['media' => 'refs']))['project'];
        $this->assertSame(array_map(self::ref(...), $this->media()), $project['assets']);
        $this->assertArrayHasKey('kept', json_decode((string) file_get_contents($summaries[0]), true), 'written again with them');
    }

    public function testOneMediaFileIsSentToItsOwnerByteForByteAndCheckedEachTime(): void
    {
        $this->installNotes($this->media());
        $kept = hash('sha256', $this->sound);
        $response = $this->file('assets/sound/b.mp3', $kept);
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame($this->sound, self::read($response));
        $this->assertSame('application/octet-stream', $response->getHeaderLine('Content-Type'));
        $this->assertSame((string) strlen($this->sound), $response->getHeaderLine('Content-Length'));
        $this->assertSame('"' . $kept . '"', $response->getHeaderLine('ETag'));
        $this->assertSame('private, no-cache', $response->getHeaderLine('Cache-Control'), 'a browser\'s copy is read only after the server says it is still theirs');
        $this->assertSame('nosniff', $response->getHeaderLine('X-Content-Type-Options'));
        $this->assertSame(SecurityHeadersMiddleware::SANDBOXED_IMAGE, $response->getHeaderLine('Content-Security-Policy'));
        $this->assertSame('attachment; filename="b.mp3"', $response->getHeaderLine('Content-Disposition'));

        // A picture is sent as one, so the page can show it.
        $picture = $this->file('assets/a.png', hash('sha256', self::PNG));
        $this->assertSame([200, 'image/png', self::PNG], [$picture->getStatusCode(), $picture->getHeaderLine('Content-Type'), self::read($picture)]);
        $empty = $this->file('assets/empty.txt', hash('sha256', ''));
        $this->assertSame([200, '0', ''], [$empty->getStatusCode(), $empty->getHeaderLine('Content-Length'), self::read($empty)]);

        // The browser's copy is confirmed without sending it again.
        $again = $this->file('assets/sound/b.mp3', $kept, 'owner', ['If-None-Match' => '"' . $kept . '"']);
        $this->assertSame([304, ''], [$again->getStatusCode(), self::read($again)]);
    }

    public function testAFileIsTheBytesItIsNamedByWhereverTheAppHasThemAndNothingElse(): void
    {
        $this->installNotes($this->media());
        // A picture renamed in a draft: the page names it by its bytes, which the app has under its old name.
        $renamed = $this->file('assets/renamed.png', hash('sha256', self::PNG));
        $this->assertSame([200, 'image/png', self::PNG], [$renamed->getStatusCode(), $renamed->getHeaderLine('Content-Type'), self::read($renamed)]);
        $this->assertSame('attachment; filename="renamed.png"', $renamed->getHeaderLine('Content-Disposition'));
        // Bytes the app has nowhere: not found, whatever the name; never another file in their place.
        foreach (['assets/sound/b.mp3', 'assets/missing.png', 'project.json', '../project.json', 'assets/../project.json', 'ui/main.ui', 'private/config.json'] as $path) {
            $response = $this->file($path, hash('sha256', 'bytes this app does not have'));
            $this->assertSame(404, $response->getStatusCode(), "'{$path}'");
            $body = self::read($response);
            $this->assertStringNotContainsString('PNG', $body);
            $this->assertStringNotContainsString(substr($this->sound, 0, 32), $body);
        }
        $this->assertSame(400, $this->file('', hash('sha256', self::PNG))->getStatusCode());
        // What names the bytes must be a SHA-256.
        foreach (['', 'abc', str_repeat('g', 64), strtoupper(hash('sha256', self::PNG))] as $kept) {
            $this->assertSame(400, $this->file('assets/a.png', $kept)->getStatusCode(), "'{$kept}'");
        }
    }

    public function testAnEarlierVersionsFileIsReadFromTheHistoryForADraftThatStillNamesIt(): void
    {
        $this->installNotes($this->media());
        $refs = self::json($this->call('GET', ['media' => 'refs']))['project']['assets'];
        // Another tab publishes version 2 with another picture: version 1's is now only in the history.
        $other = "\x89PNG\r\n\x1a\nother";
        $this->installNotes(['assets/a.png' => $other] + $this->media(), 1);
        $old = $this->file('assets/a.png', $refs['assets/a.png']['kept']);
        $this->assertSame([200, self::PNG], [$old->getStatusCode(), self::read($old)], 'version 1\'s picture, from the history');

        // The draft made on version 1, published over version 2 when its owner says so: its picture is version 1's.
        $response = $this->call('PUT', ['media' => 'refs'], ['expectedVersion' => 2, 'project' => ['access' => 'application', 'files' => self::NOTES, 'assets' => $refs]]);
        $this->assertSame(200, $response->getStatusCode(), self::read($response));
        $installed = $this->native->project(self::APP_ID);
        $this->assertSame(3, $installed['version']);
        $this->assertSame(base64_encode(self::PNG), $installed['assets']['assets/a.png']);
        $this->assertSame(base64_encode($this->sound), $installed['assets']['assets/sound/b.mp3']);
    }

    public function testABrowsersCopyIsConfirmedAndASizeAskedForWithoutSendingTheFile(): void
    {
        $this->installNotes($this->media());
        $kept = hash('sha256', $this->sound);
        $again = $this->file('assets/sound/b.mp3', $kept, 'owner', ['If-None-Match' => '"' . $kept . '"']);
        $this->assertSame([304, '', '"' . $kept . '"'], [$again->getStatusCode(), self::read($again), $again->getHeaderLine('ETag')]);
        // Bytes the app no longer has are not confirmed: the browser's copy is of nothing the app holds.
        $gone = hash('sha256', 'not this app\'s');
        $this->assertSame(404, $this->file('assets/x.png', $gone, 'owner', ['If-None-Match' => '"' . $gone . '"'])->getStatusCode());
        $head = $this->call('HEAD', ['path' => 'assets/sound/b.mp3', 'kept' => $kept], null, 'owner', [], ['operation' => 'media']);
        $this->assertSame([200, (string) strlen($this->sound), ''], [$head->getStatusCode(), $head->getHeaderLine('Content-Length'), self::read($head)]);
    }

    public function testOnlyTheAppsOwnerIsSentItsMediaOrItsNames(): void
    {
        $this->installNotes($this->media());
        foreach (['someone-else', ''] as $who) {
            $response = $this->file('assets/sound/b.mp3', hash('sha256', $this->sound), $who);
            $this->assertSame(404, $response->getStatusCode(), "'{$who}'");
            $this->assertStringNotContainsString($this->sound, self::read($response));
            $this->assertSame(404, $this->call('GET', ['media' => 'refs'], null, $who)->getStatusCode());
        }
    }

    public function testABuiltSitesFileIsSentAsItsBytesEvenWhereItsInstalledCopyIsNotThem(): void
    {
        $site = ['site/index.html' => '<!doctype html><title>Shop</title>', 'site/assets/app.js' => 'console.log("shop");'];
        $this->native->install(self::APP_ID, ['access' => 'application', 'files' => ['manifest.json' => '{"name":"Shop","site":{"entry":"index.html"}}'], 'assets' => array_map('base64_encode', $site)], 0);
        $project = self::json($this->call('GET', ['media' => 'refs']))['project'];
        $this->assertSame(array_map(self::ref(...), $site), $project['assets']);
        $kept = hash('sha256', $site['site/assets/app.js']);
        $script = $this->file('site/assets/app.js', $kept);
        $this->assertSame([200, 'application/octet-stream', $site['site/assets/app.js']], [$script->getStatusCode(), $script->getHeaderLine('Content-Type'), self::read($script)]);

        // A copy that is no longer those bytes (the same length): the project's own are sent, never the copy's.
        $copy = $this->storage . '/' . hash('sha256', self::APP_ID) . '/app/site/assets/app.js';
        file_put_contents($copy, str_repeat('x', strlen($site['site/assets/app.js'])));
        $again = $this->file('site/assets/app.js', $kept);
        $this->assertSame([200, $site['site/assets/app.js']], [$again->getStatusCode(), self::read($again)]);
    }

    public function testASitesFilesWhoseNamesDifferOnlyInCaseAreEachTheirOwn(): void
    {
        // One file on a disk that does not tell case apart (Windows, macOS): the last written is the copy of both.
        $site = ['site/index.html' => '<!doctype html><script src="A.js"></script>', 'site/A.js' => 'console.log("upper");', 'site/a.js' => 'console.log("lower!");'];
        $this->native->install(self::APP_ID, ['access' => 'application', 'files' => ['manifest.json' => '{"name":"Shop","site":{"entry":"index.html"}}'], 'assets' => array_map('base64_encode', $site)], 0);
        $this->assertSame(array_map(static fn (string $bytes): array => [$bytes, hash('sha256', $bytes)], $site), self::unpack(self::read($this->pack())));
        foreach (['site/A.js', 'site/a.js'] as $path) $this->assertSame($site[$path], self::read($this->file($path, hash('sha256', $site[$path]))), $path);
    }

    /** The pack read back: path => [bytes, the SHA-256 its index names], checked against its own header. */
    private static function unpack(string $pack): array
    {
        self::assertSame('FLMEDIA1', substr($pack, 0, 8));
        $length = unpack('N', substr($pack, 8, 4))[1];
        $header = json_decode(substr($pack, 12, $length), true);
        $base = 12 + $length;
        $files = [];
        foreach ($header['files'] as $file) $files[$file['path']] = [substr($pack, $base + $file['offset'], $file['size']), $file['kept']];
        self::assertSame(strlen($pack), $base + array_sum(array_column($header['files'], 'size')), 'nothing after the last file');
        return $files;
    }

    private function pack(string $user = 'owner', array $headers = []): ResponseInterface
    {
        return $this->call('GET', [], null, $user, $headers, ['operation' => 'media']);
    }

    public function testEveryMediaFileComesInOnePackNamedAsThePageWasGivenThem(): void
    {
        $site = ['site/index.html' => '<!doctype html><title>Shop</title>', 'site/assets/app.js' => 'console.log("shop");'];
        $media = $this->media() + $site;
        $this->native->install(self::APP_ID, ['access' => 'application', 'files' => ['manifest.json' => '{"name":"Shop","site":{"entry":"index.html"}}'], 'assets' => array_map('base64_encode', $media)], 0);
        $response = $this->pack();
        $this->assertSame(200, $response->getStatusCode());
        $pack = self::read($response);
        $this->assertSame(array_map(static fn (string $bytes): array => [$bytes, hash('sha256', $bytes)], $media), self::unpack($pack), 'a built site\'s files too');
        $this->assertSame((string) strlen($pack), $response->getHeaderLine('Content-Length'));
        $this->assertSame('private, no-cache', $response->getHeaderLine('Cache-Control'));
        $this->assertSame(SecurityHeadersMiddleware::SANDBOXED_IMAGE, $response->getHeaderLine('Content-Security-Policy'));
        $etag = $response->getHeaderLine('ETag');
        $this->assertMatchesRegularExpression('/^"[a-f0-9]{32}"$/', $etag);

        // The browser's copy is confirmed without reading a file; a new version is another pack.
        $again = $this->pack('owner', ['If-None-Match' => $etag]);
        $this->assertSame([304, ''], [$again->getStatusCode(), self::read($again)]);
        $this->native->install(self::APP_ID, ['access' => 'application', 'files' => ['manifest.json' => '{"name":"Shop","site":{"entry":"index.html"}}'], 'assets' => array_map('base64_encode', $site)], 1);
        $newer = $this->pack('owner', ['If-None-Match' => $etag]);
        $this->assertSame(200, $newer->getStatusCode());
        $this->assertNotSame($etag, $newer->getHeaderLine('ETag'));
        $this->assertSame(array_keys($site), array_keys(self::unpack(self::read($newer))));
    }

    public function testThePackIsOnlyItsOwnersAndNothingInstalledIsNoPack(): void
    {
        $this->assertSame(404, $this->pack()->getStatusCode(), 'nothing installed');
        $this->installNotes($this->media());
        foreach (['someone-else', ''] as $who) {
            $response = $this->pack($who);
            $this->assertSame(404, $response->getStatusCode(), "'{$who}'");
            $this->assertStringNotContainsString('FLMEDIA1', self::read($response));
        }
    }

    public function testTheOwnersPackIsMadeOnceAndADamagedCacheIsReadPast(): void
    {
        $this->installNotes($this->media());
        $cache = $this->storage . '/' . hash('sha256', self::APP_ID) . '/runtime-cache';
        $owners = static fn (): array => glob($cache . '/owner-*.pack') ?: [];
        // Its size alone is said without making it.
        $head = $this->call('HEAD', [], null, 'owner', [], ['operation' => 'media']);
        $this->assertSame([200, ''], [$head->getStatusCode(), self::read($head)]);
        $this->assertSame([], $owners(), 'asking its size made nothing');
        $expected = array_map(static fn (string $bytes): array => [$bytes, hash('sha256', $bytes)], $this->media());
        $first = $this->pack();
        $this->assertSame($expected, self::unpack(self::read($first)));
        $this->assertSame($head->getHeaderLine('Content-Length'), $first->getHeaderLine('Content-Length'));
        $this->assertCount(1, $owners());
        $made = filemtime($owners()[0]);
        clearstatcache();
        $this->assertSame($expected, self::unpack(self::read($this->pack())));
        $this->assertSame($made, filemtime($owners()[0]), 'read, not made again');

        // The media pack damaged on disk: each file is read from the project itself instead, and checked.
        $packs = glob($cache . '/media-*.pack') ?: [];
        $this->assertCount(1, $packs);
        $bytes = (string) file_get_contents($packs[0]);
        file_put_contents($packs[0], substr($bytes, 0, -10) . str_repeat("\0", 10));
        $this->assertSame($this->sound, self::read($this->file('assets/sound/b.mp3', hash('sha256', $this->sound))));
        unlink($owners()[0]);
        $this->assertSame($expected, self::unpack(self::read($this->pack())), 'made again, past the damaged pack');

        // A new version: its own pack, and the old one's goes with the old cache.
        $this->installNotes(['assets/a.png' => self::PNG], 1);
        $this->assertSame(['assets/a.png' => [self::PNG, hash('sha256', self::PNG)]], self::unpack(self::read($this->pack())));
        $this->assertCount(1, $owners());
    }

    public function testAPackThatCannotBeMadeSaysSoInItsOwnWords(): void
    {
        $this->installNotes($this->media());
        // A disk that takes nothing more: the owner's pack is never written.
        $this->native = new class($this->storage, $this->storage . '/no-runtime') extends NativeAppService {
            protected function writeStream(string $path, $stream, string $bytes): int|false
            {
                return str_contains(basename($path), 'owner-') ? false : parent::writeStream($path, $stream, $bytes);
            }
        };
        $response = $this->pack();
        $this->assertSame(503, $response->getStatusCode());
        $body = self::json($response);
        $this->assertSame([NativeAppService::MEDIA_UNREADABLE, 'media_unreadable'], [$body['message'], $body['code'] ?? null]);
        $this->assertSame([], glob($this->storage . '/' . hash('sha256', self::APP_ID) . '/runtime-cache/owner-*') ?: [], 'nothing half written is left');
    }

    public function testASaveIsRefusedOnItsNamesBeforeAnythingIsRead(): void
    {
        $this->installNotes($this->media());
        $save = fn (array $assets): ResponseInterface => $this->call('PUT', ['media' => 'refs'], ['expectedVersion' => 1, 'project' => ['access' => 'application', 'files' => self::NOTES, 'assets' => $assets]]);
        $kept = ['kept' => hash('sha256', self::PNG)];
        foreach (['private/x.png', 'assets/../x.png', 'assets/x.exe', 'site/.hidden'] as $path) {
            $response = $save([$path => $kept]);
            $this->assertSame(400, $response->getStatusCode(), $path);
            $this->assertStringStartsWith('Invalid', self::json($response)['message'], $path);
        }
        $many = [];
        for ($file = 0; $file <= NativeAppService::MAX_MEDIA_FILES; $file++) $many["assets/copy-{$file}.png"] = $kept;
        $response = $save($many);
        $this->assertSame(400, $response->getStatusCode());
        $this->assertStringContainsString('at most 1000 media files', self::json($response)['message']);
        $this->assertSame(1, $this->native->project(self::APP_ID)['version']);
    }

    public function testASaveTakesTheMediaThePageLeftAsTheyWereFromTheInstalledVersion(): void
    {
        $this->installNotes($this->media());
        $refs = self::json($this->call('GET', ['media' => 'refs']))['project']['assets'];
        $new = random_bytes(5000);
        $files = ['ui/main.ui' => '<Text>Changed</Text>'] + self::NOTES;
        $response = $this->call('PUT', ['media' => 'refs'], ['expectedVersion' => 1, 'project' => ['access' => 'application', 'files' => $files, 'assets' => [
            // As it was, under the same name; a file renamed (named by its SHA-256 alone); a new one in base64.
            'assets/a.png' => $refs['assets/a.png'],
            'assets/sound/renamed.mp3' => ['kept' => $refs['assets/sound/b.mp3']['kept']],
            'assets/new.bin' => base64_encode($new),
        ]]]);
        $raw = self::read($response);
        $this->assertSame(200, $response->getStatusCode(), $raw);
        $answer = json_decode($raw, true)['project'];
        $this->assertSame(2, $answer['version']);
        $this->assertSame(['assets/a.png' => self::ref(self::PNG), 'assets/sound/renamed.mp3' => self::ref($this->sound), 'assets/new.bin' => self::ref($new)], $answer['assets'], 'the answer names them too');
        $this->assertStringNotContainsString(substr(base64_encode($this->sound), 0, 40), $raw);

        // What is installed: each file's own bytes, the one left out gone.
        $installed = $this->native->project(self::APP_ID);
        $this->assertSame(['assets/a.png' => base64_encode(self::PNG), 'assets/sound/renamed.mp3' => base64_encode($this->sound), 'assets/new.bin' => base64_encode($new)], $installed['assets']);
        $this->assertSame('<Text>Changed</Text>', $installed['files']['ui/main.ui']);
        // And what the page is given from now on is what the save answered.
        $this->assertSame($answer['assets'], self::json($this->call('GET', ['media' => 'refs']))['project']['assets']);
        $this->assertSame($this->sound, self::read($this->file('assets/sound/renamed.mp3', hash('sha256', $this->sound))));
    }

    public function testASaveThatAsksForNoNamesIsAnsweredWithTheBytesAsBefore(): void
    {
        $this->installNotes($this->media());
        $refs = self::json($this->call('GET', ['media' => 'refs']))['project']['assets'];
        $answer = self::json($this->call('PUT', [], ['expectedVersion' => 1, 'project' => ['access' => 'application', 'files' => self::NOTES, 'assets' => ['assets/a.png' => $refs['assets/a.png']]]]))['project'];
        $this->assertSame(['assets/a.png' => base64_encode(self::PNG)], $answer['assets']);
    }

    public function testASaveNamingAFileTheServerDoesNotHaveIsRefusedByNameAndChangesNothing(): void
    {
        $this->installNotes($this->media());
        $before = $this->native->project(self::APP_ID);
        $save = fn (array $assets, int $expected = 1): ResponseInterface => $this->call('PUT', ['media' => 'refs'], ['expectedVersion' => $expected, 'project' => ['access' => 'application', 'files' => self::NOTES, 'assets' => $assets]]);

        $unknown = $save(['assets/a.png' => ['kept' => hash('sha256', 'not this app\'s')]]);
        $this->assertSame(400, $unknown->getStatusCode());
        $this->assertStringContainsString('assets/a.png is no longer on the server', self::json($unknown)['message']);
        foreach ([['kept' => 'abc'], ['kept' => strtoupper(hash('sha256', self::PNG))], ['size' => 12], ['kept' => 12], []] as $odd) {
            $response = $save(['assets/a.png' => $odd]);
            $this->assertSame(400, $response->getStatusCode(), json_encode($odd));
            $this->assertStringContainsString('assets/a.png', self::json($response)['message']);
        }
        // A page that read another version than the one installed now: told to reload, as a publish is.
        foreach ([0, 2] as $expected) {
            $this->assertSame(409, $save(['assets/a.png' => self::ref(self::PNG)], $expected)->getStatusCode(), "expected {$expected}");
        }
        $this->assertSame($before, $this->native->project(self::APP_ID), 'nothing installed');
    }

    public function testNamesThatHoldMoreThanAnAppMayAreRefusedBeforeAnythingIsRead(): void
    {
        // A file of 4.5 MB, named fifteen times: 67.5 MB, over the 64 MB an app may hold, in a body of a few kilobytes.
        $large = random_bytes(4718592);
        $this->installNotes(['assets/large.bin' => $large]);
        $ref = self::ref($large);
        $assets = [];
        for ($copy = 0; $copy < 15; $copy++) $assets["assets/copy-{$copy}.bin"] = ['kept' => $ref['kept']];
        $before = memory_get_peak_usage();
        $response = $this->call('PUT', ['media' => 'refs'], ['expectedVersion' => 1, 'project' => ['access' => 'application', 'files' => self::NOTES, 'assets' => $assets]]);
        $this->assertSame(400, $response->getStatusCode());
        $this->assertStringContainsString('exceeds 64 MB', self::json($response)['message']);
        $this->assertLessThan(48 * 1024 * 1024, memory_get_peak_usage() - $before, 'refused before the copies were decoded');
        $this->assertSame(1, $this->native->project(self::APP_ID)['version']);
        // Thirteen of them, 58.5 MB, are an app it may hold.
        $this->assertSame(200, $this->call('PUT', ['media' => 'refs'], ['expectedVersion' => 1, 'project' => ['access' => 'application', 'files' => self::NOTES, 'assets' => array_slice($assets, 0, 13)]])->getStatusCode());
    }

    public function testValidationRefusesAProjectAsSoonAsItIsOverTheLimit(): void
    {
        $chunk = base64_encode(str_repeat("\x01", 30 * 1024 * 1024));
        try {
            NativeAppService::validateProject(['files' => self::NOTES, 'assets' => ['assets/a.bin' => $chunk, 'assets/b.bin' => $chunk, 'assets/c.bin' => $chunk, 'assets/d.bin' => $chunk]]);
            $this->fail('a project over 64 MB was taken');
        } catch (\InvalidArgumentException $refused) {
            $this->assertStringContainsString('exceeds 64 MB', $refused->getMessage());
        }
    }

    public function testAFirstInstallCannotKeepWhatWasNeverThere(): void
    {
        $response = $this->call('PUT', ['media' => 'refs'], ['expectedVersion' => 0, 'project' => ['access' => 'application', 'files' => self::NOTES, 'assets' => ['assets/a.png' => self::ref(self::PNG)]]]);
        $this->assertSame(409, $response->getStatusCode());
        $this->assertNull($this->native->project(self::APP_ID));
    }
}
