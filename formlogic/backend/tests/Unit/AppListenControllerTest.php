<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Middleware\BodySizeLimitMiddleware;
use FormLogic\Middleware\RateLimitMiddleware;
use FormLogic\Services\AppUserService;
use FormLogic\Services\RateLimiter;
use FormLogic\Tests\Support\ListeningFixture;
use FormLogic\Tests\Support\Recording;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * What a hosted app may ask of FormLogic's own page, as its owner chose: to be listened for
 * (`project.listen`, and POST /api/app/{slug}/native/listen) and to offer an app it made
 * (`project.offers`). Here: what the page is told, who may send a recording, what is refused before
 * anything is sent, and how the route is wired. The speech server's part is AppListenRouteTest's.
 */
final class AppListenControllerTest extends TestCase
{
    use ListeningFixture;

    private const ALLOWED = ['softnApp' => true, 'softnListen' => 'allow'];

    // ------------------------------------------------------------------ what the page is told

    public function testThePageIsToldItMayListenOnlyWhereTheOwnerAllowedItAndTheSiteCan(): void
    {
        $this->install();
        $this->assertTrue($this->opened($this->controller(self::ALLOWED, $this->listening()))['project']['listen']);
        // The owner did not allow it, whatever the site can do.
        foreach ([['softnApp' => true], ['softnApp' => true, 'softnListen' => 'ask'], ['softnApp' => true, 'softnListen' => true], ['softnApp' => true, 'softnFiles' => 'allow', 'softnApps' => 'allow']] as $settings) {
            $this->assertFalse($this->opened($this->controller($settings, $this->listening()))['project']['listen'], json_encode($settings));
        }
        // The owner allowed it, and the site cannot: no speech server (or its AI off), App AI not
        // serving this app from the site, or a site with no listening at all.
        $this->assertFalse($this->opened($this->controller(self::ALLOWED, $this->listening(speech: null)))['project']['listen']);
        $this->assertFalse($this->opened($this->controller(self::ALLOWED, $this->listening(appAi: false)))['project']['listen']);
        $this->assertFalse($this->opened($this->controller(self::ALLOWED, null))['project']['listen']);
    }

    public function testThePageIsToldTheAppMayOfferAppsOnlyWhereTheOwnerAllowedIt(): void
    {
        $this->install();
        $this->assertTrue($this->opened($this->controller(['softnApp' => true, 'softnApps' => 'allow'], null))['project']['offers']);
        foreach ([['softnApp' => true], ['softnApp' => true, 'softnApps' => 'ask'], ['softnApp' => true, 'softnApps' => true], ['softnApp' => true, 'softnApps' => ['allow']], self::ALLOWED + ['softnFiles' => 'allow']] as $settings) {
            $this->assertFalse($this->opened($this->controller($settings, $this->listening()))['project']['offers'], json_encode($settings));
        }
        // Each choice is its own: both, and the files choice beside them, as they were set.
        $project = $this->opened($this->controller(self::ALLOWED + ['softnApps' => 'allow', 'softnFiles' => 'ask'], $this->listening()))['project'];
        $this->assertSame([true, true, 'ask'], [$project['listen'], $project['offers'], $project['files']]);
        // An app that asks for neither is told so in so many words, and nothing else about it changes.
        $plain = $this->opened($this->controller(['softnApp' => true], null))['project'];
        $this->assertSame([false, false], [$plain['listen'], $plain['offers']]);
        $this->assertArrayNotHasKey('files', $plain);
    }

    // ------------------------------------------------------------------ refused before anything is sent

    public function testARecordingForAnAppThatIsNotListenedForIsRefused(): void
    {
        $this->install();
        $audio = ['audio' => base64_encode(Recording::wav(1.0))];
        $off = [403, ['error' => true, 'message' => 'Listening is not turned on for this app.', 'code' => 'listen_off']];
        $this->assertSame($off, self::read($this->listen($this->controller(['softnApp' => true], $this->listening()), $audio)), 'the owner did not allow it');
        $this->assertSame($off, self::read($this->listen($this->controller(self::ALLOWED, $this->listening(speech: null)), $audio)), 'no speech server');
        $this->assertSame($off, self::read($this->listen($this->controller(self::ALLOWED, $this->listening(appAi: false)), $audio)), 'App AI is not on this site\'s AI for the app');
        $this->assertSame($off, self::read($this->listen($this->controller(self::ALLOWED, null), $audio)), 'a site with no listening');
        $this->assertSame([], $this->heard);
    }

    public function testWhatIsNotARecordingOrIsTooLongIsRefusedInItsOwnWords(): void
    {
        $this->install();
        $controller = $this->controller(self::ALLOWED, $this->listening());
        $invalid = ['error' => true, 'message' => 'That recording could not be read. It must be a WAV file of PCM sound.', 'code' => 'invalid_audio'];
        foreach ([null, [], ['audio' => ''], ['audio' => 'not base64!'], ['audio' => base64_encode('words')], ['sound' => base64_encode(Recording::wav(1.0))], ['audio' => [base64_encode(Recording::wav(1.0))]], ['audio' => base64_encode(Recording::wav(1.0, tag: 3))]] as $body) {
            $this->assertSame([400, $invalid], self::read($this->listen($controller, $body)), json_encode($body));
        }
        $this->assertSame([400, ['error' => true, 'message' => 'That recording is empty.', 'code' => 'invalid_audio']], self::read($this->listen($controller, ['audio' => base64_encode(Recording::wav(0.0))])));
        $long = [413, ['error' => true, 'message' => 'That recording is too long. FormLogic listens for up to a minute at a time.', 'code' => 'too_long']];
        $this->assertSame($long, self::read($this->listen($controller, ['audio' => base64_encode(Recording::wav(75.0, 8000, 1, 8))])));
        $this->assertSame($long, self::read($this->listen($controller, ['audio' => 'data:audio/wav;base64,' . base64_encode(Recording::wav(70.0))])));
        $this->assertSame([], $this->heard);
        $answer = $this->listen($controller, ['audio' => '']);
        $this->assertSame('no-store', $answer->getHeaderLine('Cache-Control'));
    }

    // ------------------------------------------------------------------ who may send one

    public function testOnlyWhoMayOpenTheAppMaySendARecording(): void
    {
        $audio = ['audio' => ''];
        // An app nobody may see, and one with nothing installed.
        $this->assertSame([404, ['error' => true, 'message' => 'App not found or access denied']], self::read($this->listen($this->controller(self::ALLOWED, $this->listening(), visible: false), $audio)));
        $this->assertSame([404, ['error' => true, 'message' => 'Native app not found']], self::read($this->listen($this->controller(self::ALLOWED, $this->listening()), $audio)));

        // A members' app: its active members and its owner, nobody else.
        $this->install('members');
        $users = $this->createMock(AppUserService::class);
        $users->method('getAppUser')->willReturnCallback(static fn(string $app, string $user) => match ($user) { 'member' => ['status' => 'active', 'roleId' => 'viewer'], 'waiting' => ['status' => 'pending', 'roleId' => 'viewer'], default => null });
        $controller = $this->controller(self::ALLOWED, $this->listening(), $users);
        $denied = [403, ['error' => true, 'message' => 'Sign in with an active app membership to continue']];
        $this->assertSame($denied, self::read($this->listen($controller, $audio)), 'nobody signed in');
        $this->assertSame($denied, self::read($this->listen($controller, $audio, 'stranger')));
        $this->assertSame($denied, self::read($this->listen($controller, $audio, 'waiting')));
        // Admitted, and told what was wrong with what they sent.
        $this->assertSame('invalid_audio', self::read($this->listen($controller, $audio, 'member'))[1]['code']);
        $this->assertSame('invalid_audio', self::read($this->listen($controller, $audio, 'owner'))[1]['code']);

        // An app anyone may open: a visitor with no account.
        $this->install('application');
        $this->assertSame('invalid_audio', self::read($this->listen($this->controller(self::ALLOWED, $this->listening()), $audio))[1]['code']);
    }

    // ------------------------------------------------------------------ the route

    private static function index(): string
    {
        return str_replace("\r\n", "\n", (string) file_get_contents(dirname(__DIR__, 2) . '/public/index.php'));
    }

    public function testTheRouteRidesTheGateAndABudgetOfItsOwn(): void
    {
        $index = self::index();
        $this->assertStringContainsString("\$listenLimiter = new RateLimitMiddleware(\$rateLimiter, 20, 60, 'app_listen', true, true, null, true);", $index);
        // Admitted as the app's requests are: the gate, then who is asking.
        $route = <<<'PHP'
        $app->post('/api/app/{slug}/native/listen', function ($request, $response) use ($container, $getArgs) {
            return $container->get(\FormLogic\Controllers\NativeAppController::class)->listen($request, $response, $getArgs($request));
        })->add($appAccessGate)->add($listenLimiter)->add($authOptional);
        PHP;
        $this->assertStringContainsString(str_replace("\r\n", "\n", $route), $index);
        $this->assertSame(1, substr_count($index, '->add($listenLimiter)'), 'the listen route alone draws on it');
        // The controller is given what listens, built on App AI and the site's own AI settings.
        $this->assertStringContainsString('return new \FormLogic\Services\AppListening($c->get(\FormLogic\Services\AppAiService::class), $c->get(AIService::class));', $index);
        $this->assertStringContainsString('$c->get(\FormLogic\Services\NativeAppCalls::class),' . "\n" . '        $c->get(\FormLogic\Services\AppListening::class)' . "\n" . '    );', $index);
    }

    /** Twenty a minute for whoever is asking, in each app apart; past it, the limiter's 429 with how long to wait. */
    public function testTheTwentyFirstRecordingInAMinuteIsToldToWait(): void
    {
        $hits = [];
        $limiter = $this->createMock(RateLimiter::class);
        $limiter->method('hit')->willReturnCallback(function (string $key) use (&$hits): int { return $hits[$key] = ($hits[$key] ?? 0) + 1; });
        $limiter->method('secondsUntilReset')->willReturn(42);
        // As index.php builds it.
        $middleware = new RateLimitMiddleware($limiter, 20, 60, 'app_listen', true, true, null, true);
        $handler = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface { return new Response(200); }
        };
        $ask = static function (string $slug, ?string $user, string $ip = '203.0.113.10') use ($middleware, $handler): ResponseInterface {
            $request = (new ServerRequestFactory())->createServerRequest('POST', 'http://formlogic.local/api/app/' . $slug . '/native/listen', ['REMOTE_ADDR' => $ip]);
            return $middleware->process($user === null ? $request : $request->withAttribute('userId', $user), $handler);
        };
        for ($i = 1; $i <= 20; $i++) $this->assertSame(200, $ask('notes', 'member-1')->getStatusCode(), "recording $i");
        $refused = $ask('notes', 'member-1');
        $this->assertSame(429, $refused->getStatusCode());
        $this->assertSame(['error' => true, 'message' => 'Too many requests. Please try again later.', 'retryAfter' => 42], json_decode((string) $refused->getBody(), true));
        $this->assertSame('42', $refused->getHeaderLine('Retry-After'));
        // By account wherever they are; another member, another app and a visitor each have their own.
        $this->assertSame(429, $ask('notes', 'member-1', '198.51.100.7')->getStatusCode());
        $this->assertSame(200, $ask('notes', 'member-2')->getStatusCode());
        $this->assertSame(200, $ask('recipes', 'member-1')->getStatusCode());
        for ($i = 1; $i <= 20; $i++) $this->assertSame(200, $ask('notes', null)->getStatusCode(), "a visitor's recording $i");
        $this->assertSame(429, $ask('notes', null)->getStatusCode(), 'a visitor is counted by address');
        $this->assertSame(200, $ask('notes', null, '198.51.100.7')->getStatusCode());
    }

    /** A recording's request is JSON of 3 MB at most: a minute's WAV in base64 is 2.6 MB. */
    public function testTheRequestIsHeldToThreeMegabytesOfJson(): void
    {
        $this->assertStringContainsString("['path' => '#^/api/app/[^/]+/native/listen$#', 'method' => 'POST', 'maxBytes' => 3 * 1024 * 1024, 'contentTypes' => ['application/json'], 'auth' => false],", self::index());
        // As index.php builds it: 2 MB for everything else.
        $middleware = new BodySizeLimitMiddleware(2 * 1024 * 1024, [['path' => '#^/api/app/[^/]+/native/listen$#', 'method' => 'POST', 'maxBytes' => 3 * 1024 * 1024, 'contentTypes' => ['application/json'], 'auth' => false]]);
        $handler = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface { return new Response(200); }
        };
        $send = static function (int $bytes, string $type = 'application/json', string $path = '/api/app/notes/native/listen') use ($middleware, $handler): int {
            $request = (new ServerRequestFactory())->createServerRequest('POST', 'http://formlogic.local' . $path)->withHeader('Content-Type', $type)->withHeader('Content-Length', (string) $bytes);
            return $middleware->process($request, $handler)->getStatusCode();
        };
        $minute = strlen(json_encode(['audio' => base64_encode(Recording::wav(60.0))]));
        $this->assertLessThan(3 * 1024 * 1024, $minute);
        $this->assertSame(200, $send($minute));
        $this->assertSame(200, $send(3 * 1024 * 1024));
        $this->assertSame(413, $send(3 * 1024 * 1024 + 1));
        $this->assertSame(413, $send($minute, 'multipart/form-data; boundary=x'), 'JSON alone has the room');
        $this->assertSame(413, $send($minute, 'application/json', '/api/app/notes/native/listening'));
    }
}
