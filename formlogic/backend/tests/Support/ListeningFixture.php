<?php

declare(strict_types=1);

namespace FormLogic\Tests\Support;

use FormLogic\Controllers\NativeAppController;
use FormLogic\Services\{AIService, AppAiService, AppListening, AppService, AppUserService, FlowService, NativeAppService, PlanService, RuntimeEngineService};
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * An installed SoftN app ("notes") and the controller its page calls, for the tests of FormLogic's
 * listening: the real NativeAppController and AppListening over a project written as an install
 * leaves it, with no runner, no database and, unless a test names one, no speech server.
 */
trait ListeningFixture
{
    private ?string $storage = null;
    /** What App AI was told was heard: [app id, seconds] each. */
    private array $heard = [];

    protected function tearDown(): void
    {
        if ($this->storage === null || !is_dir($this->storage)) return;
        $root = realpath($this->storage);
        $temp = realpath(sys_get_temp_dir()) . DIRECTORY_SEPARATOR;
        if ($root === false || !str_starts_with($root, $temp) || !str_starts_with(basename($root), 'formlogic-listen-')) throw new \RuntimeException('Unexpected fixture path');
        $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($iterator as $file) { if ($file->isDir() && !$file->isLink()) rmdir($file->getPathname()); else unlink($file->getPathname()); }
        rmdir($root);
        $this->storage = null;
    }

    /** The app's project, written as an install leaves it. */
    private function install(string $access = 'application'): void
    {
        $this->storage ??= sys_get_temp_dir() . '/formlogic-listen-' . bin2hex(random_bytes(8));
        $root = $this->storage . '/' . hash('sha256', 'notes');
        if (!is_dir($root . '/private')) mkdir($root . '/private', 0700, true);
        file_put_contents($root . '/project.json', json_encode([
            'home' => false, 'version' => 1, 'access' => $access,
            'files' => ['manifest.json' => '{"id":"notes","main":"ui/main.ui"}', 'ui/main.ui' => '<Text>Notes</Text>'],
            'assets' => [],
        ]));
    }

    /**
     * What listens: $speech is the site's speech server (AIService::envSpeech()), or null for none;
     * $appAi, whether App AI would ask it for the app (AppAiService::siteSpeaksFor).
     */
    private function listening(?array $speech = ['url' => 'http://127.0.0.1:9/v1', 'key' => '', 'model' => '', 'voice' => ''], bool $appAi = true, int $timeout = 30): AppListening
    {
        $site = $this->createMock(AIService::class);
        $site->method('envSpeech')->willReturn($speech);
        $ai = $this->createMock(AppAiService::class);
        $ai->method('siteSpeaksFor')->willReturn($appAi);
        $ai->method('heard')->willReturnCallback(function (string $appId, float $seconds): void { $this->heard[] = [$appId, $seconds]; });
        return new AppListening($ai, $site, $timeout);
    }

    private function controller(array $settings, ?AppListening $listening, ?AppUserService $users = null, bool $visible = true): NativeAppController
    {
        $this->storage ??= sys_get_temp_dir() . '/formlogic-listen-' . bin2hex(random_bytes(8));
        $app = ['id' => 'notes', 'slug' => 'notes', 'ownerId' => 'owner', 'name' => 'Notes', 'status' => 'published', 'settings' => $settings];
        $apps = $this->createMock(AppService::class);
        $apps->method('getAppBySlug')->willReturn($app);
        $apps->method('getApp')->willReturn($app);
        $apps->method('isRuntimeVisible')->willReturn($visible);
        $engines = $this->createMock(RuntimeEngineService::class);
        $engines->method('effective')->willReturn(['id' => 'zipp-web-python', 'requested' => 'zipp-web-python', 'stored' => null, 'revision' => '0123456789abcdef']);
        return new NativeAppController($apps, $users ?? $this->createMock(AppUserService::class), new NativeAppService($this->storage, $this->storage . '/no-runtime'),
            $this->createMock(PlanService::class), $this->createMock(FlowService::class), $engines, listening: $listening);
    }

    /** The app's project as its page is sent it (GET /api/app/notes/native). */
    private function opened(NativeAppController $controller, ?string $user = null): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/api/app/notes/native?media=pack')->withQueryParams(['media' => 'pack']);
        if ($user !== null) $request = $request->withAttribute('userId', $user);
        return json_decode((string) $controller->runtime($request, new Response(), ['slug' => 'notes'])->getBody(), true);
    }

    /** POST /api/app/notes/native/listen with $body, as the site's page sends a recording. */
    private function listen(NativeAppController $controller, mixed $body, ?string $user = null): ResponseInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/app/notes/native/listen')->withHeader('Content-Type', 'application/json')->withParsedBody($body);
        if ($user !== null) $request = $request->withAttribute('userId', $user);
        return $controller->listen($request, new Response(), ['slug' => 'notes']);
    }

    /** An answer as the page reads it: [status, body]. */
    private static function read(ResponseInterface $response): array
    {
        return [$response->getStatusCode(), json_decode((string) $response->getBody(), true)];
    }

    /** Run $work with PHP's error log kept in a file: [what it answered, what was logged]. */
    private static function logged(callable $work): array
    {
        $file = (string) tempnam(sys_get_temp_dir(), 'listen-log-');
        $previous = ini_set('error_log', $file);
        try {
            $result = $work();
        } finally {
            ini_set('error_log', $previous === false ? '' : $previous);
        }
        $text = (string) file_get_contents($file);
        @unlink($file);
        return [$result, $text];
    }
}
