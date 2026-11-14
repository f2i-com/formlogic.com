<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\NativeAppController;
use FormLogic\Models\User;
use FormLogic\Services\{AppService, AppUserService, FlowService, NativeAppCalls, NativeAppService, PlanService, RuntimeEngineService};
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * What the app's runtime writes down of each call to its backend (NativeAppCalls), for the API
 * section of its owner's page: the method, the path, the status as it was answered (by the backend,
 * or by FormLogic refusing it), the time it took, the first words of an error, and who called. Only
 * calls to the backend: the app's opening, its media and the version check are not calls. And a
 * call is answered the same whether or not it could be written down.
 */
final class NativeAppCallRecordTest extends TestCase
{
    /** @var list<array{appId: string, method: string, path: string, status: int, ms: int, error: ?string, caller: string, at: ?\DateTimeImmutable}> */
    private array $recorded = [];

    private function controller(string $access, ?\Closure $answer = null, bool $recorderThrows = false): NativeAppController
    {
        $apps = $this->createMock(AppService::class);
        $apps->method('getAppBySlug')->willReturn(['id' => 'tasks-id', 'slug' => 'tasks', 'ownerId' => 'owner', 'name' => 'Task board', 'status' => 'published', 'settings' => ['softnApp' => true]]);
        $apps->method('isRuntimeVisible')->willReturn(true);
        $users = $this->createMock(AppUserService::class);
        $users->method('getAppUser')->willReturnCallback(static fn (string $app, string $user): ?array => $user === 'member' ? ['status' => 'active', 'roleId' => 'member'] : null);
        $project = ['access' => $access, 'version' => 3, 'assets' => [], 'files' => [
            'manifest.json' => '{"id":"tasks","server":{"entry":"server/main.logic","routes":[{"path":"/api/items","method":"POST","handler":"createItem"}]}}',
            'index.html' => '<h1>Tasks</h1>', 'server/main.logic' => 'function createItem(req) {}',
        ]];
        $native = $this->createMock(NativeAppService::class);
        $native->method('project')->willReturn($project);
        $native->method('runtimeProject')->willReturn(['project' => $project, 'media' => ['file' => '', 'sha256' => str_repeat('a', 64), 'size' => 0, 'count' => 0]]);
        $native->method('request')->willReturnCallback($answer ?? static fn (): array => ['status' => 201, 'body' => (object) ['id' => 7]]);
        $engines = $this->createMock(RuntimeEngineService::class);
        $engines->method('effective')->willReturn(['id' => 'zipp-web', 'requested' => 'zipp-web', 'stored' => null, 'revision' => '0123456789abcdef']);
        $calls = $this->createMock(NativeAppCalls::class);
        $calls->method('record')->willReturnCallback(function (string $appId, string $method, string $path, int $status, int $ms, ?string $error, string $caller, ?\DateTimeImmutable $at = null) use ($recorderThrows): bool {
            if ($recorderThrows) throw new \RuntimeException('The record is not there');
            $this->recorded[] = compact('appId', 'method', 'path', 'status', 'ms', 'error', 'caller', 'at');
            return true;
        });
        return new NativeAppController($apps, $users, $native, $this->createMock(PlanService::class), $this->createMock(FlowService::class), $engines, calls: $calls);
    }

    private function post(NativeAppController $controller, ?string $user, array $body): ResponseInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/app/tasks/native/request', ['REMOTE_ADDR' => '203.0.113.9'])->withParsedBody($body);
        if ($user !== null) $request = $request->withAttribute('userId', $user)->withAttribute('user', new User(id: $user, email: $user . '@example.test'));
        return $controller->runtime($request, new Response(), ['slug' => 'tasks']);
    }

    public function testAnAnsweredCallIsWrittenDownWithWhoMadeItAndNothingItCarried(): void
    {
        $response = $this->post($this->controller('members'), 'member', ['method' => 'POST', 'path' => '/api/items', 'query' => ['secret' => 'q'], 'body' => ['title' => 'Water the plants'], 'headers' => ['authorization' => 'Bearer t']]);
        $this->assertSame(200, $response->getStatusCode());
        $this->assertCount(1, $this->recorded);
        $call = $this->recorded[0];
        $this->assertSame(['tasks-id', 'POST', '/api/items', 201, null, 'member'], [$call['appId'], $call['method'], $call['path'], $call['status'], $call['error'], $call['caller']]);
        $this->assertGreaterThanOrEqual(0, $call['ms']);
        $this->assertStringNotContainsString('Water the plants', json_encode($this->recorded));
        $this->assertStringNotContainsString('Bearer', json_encode($this->recorded));
        $this->assertStringNotContainsString('203.0.113.9', json_encode($this->recorded));
    }

    public function testTheOwnerAndAVisitorAreToldApart(): void
    {
        $controller = $this->controller('application');
        $this->post($controller, 'owner', ['method' => 'GET', 'path' => '/api/items']);
        $this->post($controller, null, ['method' => 'GET', 'path' => '/api/items']);
        // Signed in, on an app anyone opens: a visitor to the backend, which is told nothing of them.
        $this->post($controller, 'someone', ['method' => 'GET', 'path' => '/api/items']);
        $this->assertSame(['owner', 'visitor', 'visitor'], array_column($this->recorded, 'caller'));
        $this->recorded = [];
        $this->post($this->controller('members'), 'owner', ['method' => 'GET', 'path' => '/api/items']);
        $this->assertSame(['owner'], array_column($this->recorded, 'caller'));
    }

    public function testACallTheBackendRefusedKeepsTheFirstWordsOfWhy(): void
    {
        $controller = $this->controller('application', static fn (): array => ['status' => 422, 'body' => (object) ['error' => "Give a title of 1 to 200 characters\n(see the form)"]]);
        $this->assertSame(200, $this->post($controller, 'owner', ['method' => 'POST', 'path' => '/api/items', 'body' => []])->getStatusCode(), 'the backend\'s own answer is the call\'s, whatever it says');
        $this->assertSame([422, 'Give a title of 1 to 200 characters (see the form)'], [$this->recorded[0]['status'], $this->recorded[0]['error']]);
        // A path no route has is the runner's 404. The owner's is written down as they asked for it.
        $missing = $this->controller('application', static fn (): array => ['status' => 404, 'body' => (object) ['error' => 'Endpoint not found.', 'code' => 'not_found']]);
        $this->post($missing, 'owner', ['method' => 'DELETE', 'path' => '/api/items/7']);
        $this->assertSame(['DELETE', '/api/items/7', 404, 'Endpoint not found.', 'owner'], [$this->recorded[1]['method'], $this->recorded[1]['path'], $this->recorded[1]['status'], $this->recorded[1]['error'], $this->recorded[1]['caller']]);
    }

    public function testAStrangersCallToAnAddressTheAppDoesNotHaveIsWrittenDownWithoutTheAddress(): void
    {
        // Anyone can send any address: a visitor's or a member's, to one the app does not declare, is written down
        // without it, so the owner's list never shows words a stranger put there.
        $missing = $this->controller('application', static fn (): array => ['status' => 404, 'body' => (object) ['error' => 'Endpoint not found.']]);
        $this->post($missing, null, ['method' => 'GET', 'path' => '/api/send-money-to-this-account']);
        $this->assertSame(['', 404, 'Endpoint not found.', 'visitor'], [$this->recorded[0]['path'], $this->recorded[0]['status'], $this->recorded[0]['error'], $this->recorded[0]['caller']]);
        $members = $this->controller('members', static fn (): array => ['status' => 404, 'body' => (object) ['error' => 'Endpoint not found.']]);
        $this->post($members, 'member', ['method' => 'GET', 'path' => '/api/whatever']);
        $this->assertSame(['', 'member'], [$this->recorded[1]['path'], $this->recorded[1]['caller']]);
        // An address the app declares keeps its name, a 404 its own code gave included (another method, or a record
        // that is not there).
        $this->post($missing, null, ['method' => 'GET', 'path' => '/api/items']);
        $this->assertSame('/api/items', $this->recorded[2]['path']);
        // A declared address keeps its name however it was answered.
        $fine = $this->controller('application');
        $this->post($fine, null, ['method' => 'POST', 'path' => '/api/items']);
        $this->assertSame('/api/items', $this->recorded[3]['path']);
    }

    public function testAStrangersCallRefusedBeforeAnyRouteIsWrittenDownWithoutItsAddressToo(): void
    {
        // FormLogic refuses it before the backend looks for a route (a body that is not JSON: 400; too large: 413; the
        // plan lapsed, busy, …): whatever the status, an address the app does not declare is not kept from anyone but
        // the owner.
        $controller = $this->controller('application');
        $this->assertSame(400, $this->post($controller, null, ['method' => 'POST', 'path' => '/api/your-account-is-locked-call-now', 'body' => 'not json'])->getStatusCode());
        $this->assertSame(['', 400, 'visitor'], [$this->recorded[0]['path'], $this->recorded[0]['status'], $this->recorded[0]['caller']]);
        $big = $this->controller('application', static fn () => throw new \RuntimeException('This request is larger than the app accepts.', 413));
        $this->post($big, null, ['method' => 'POST', 'path' => '/api/read-this-message', 'body' => []]);
        $this->assertSame(['', 413], [$this->recorded[1]['path'], $this->recorded[1]['status']]);
        // The owner's, and a declared address, keep theirs.
        $this->post($controller, 'owner', ['method' => 'POST', 'path' => '/api/typo-of-mine', 'body' => 'not json']);
        $this->assertSame('/api/typo-of-mine', $this->recorded[2]['path']);
        $this->post($controller, null, ['method' => 'POST', 'path' => '/api/items', 'body' => 'not json']);
        $this->assertSame('/api/items', $this->recorded[3]['path']);
    }

    public function testACallIsWrittenDownWithWhenItCameNotWhenItWasWritten(): void
    {
        $before = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $this->post($this->controller('application', static function (): array { usleep(120_000); return ['status' => 200, 'body' => []]; }), null, ['method' => 'GET', 'path' => '/api/items']);
        $at = $this->recorded[0]['at'];
        $this->assertInstanceOf(\DateTimeImmutable::class, $at);
        $this->assertLessThan(0.1, abs((float) $at->format('U.u') - (float) $before->format('U.u')), 'its arrival, not its answer a moment later');
        $this->assertGreaterThanOrEqual(120, $this->recorded[0]['ms']);
    }

    public function testACallPhpStoppedBeforeItWasAnsweredIsWrittenDownAsOneWithNoAnswer(): void
    {
        // What the shutdown function runtime() registers does when PHP ends the script on a fatal error (out of time or
        // memory); a test cannot end its own script, so it is handed the error PHP would have ended on.
        $controller = $this->controller('application');
        $arrived = new \DateTimeImmutable('-30 seconds', new \DateTimeZone('UTC'));
        $manifest = '{"server":{"routes":[{"path":"/api/items","method":"POST"}]}}';
        $controller->unansweredAtShutdown('tasks-id', ['method' => 'POST', 'path' => '/api/items', 'caller' => 'visitor'], hrtime(true), $arrived, $manifest, ['type' => E_ERROR, 'message' => 'Maximum execution time of 30 seconds exceeded', 'file' => '/srv/x.php', 'line' => 1]);
        $this->assertSame(['/api/items', 0, 'The call was stopped before it was answered: it took too long, or ran out of memory.', 'visitor'], [$this->recorded[0]['path'], $this->recorded[0]['status'], $this->recorded[0]['error'], $this->recorded[0]['caller']]);
        $this->assertEquals($arrived, $this->recorded[0]['at']);
        $this->assertStringNotContainsString('/srv/x.php', json_encode($this->recorded));
        // A stranger's to an address the app lacks: without it.
        $controller->unansweredAtShutdown('tasks-id', ['method' => 'POST', 'path' => '/api/made-up', 'caller' => 'visitor'], hrtime(true), $arrived, $manifest, ['type' => E_ERROR, 'message' => 'Allowed memory size exhausted']);
        $this->assertSame('', $this->recorded[1]['path']);
        // Any other ending (a warning, or none) is not one: the call was written down already.
        $controller->unansweredAtShutdown('tasks-id', ['method' => 'POST', 'path' => '/api/items', 'caller' => 'visitor'], hrtime(true), $arrived, $manifest, ['type' => E_WARNING, 'message' => 'a warning']);
        $this->assertCount(2, $this->recorded);
    }

    public function testACallPhpItselfFailedOnIsWrittenDownAsTheFiveHundredItWasGiven(): void
    {
        // An Error, which respond() does not answer: the site's error handler gives the caller a 500, and the call is
        // written down as that, in FormLogic's words, never the error's.
        $broken = $this->controller('application', static fn (): array => throw new \TypeError('Argument #1 must be of type array, string given in /srv/formlogic/src/Secret.php'));
        try {
            $this->post($broken, null, ['method' => 'POST', 'path' => '/api/items']);
            $this->fail('the error went on to the site\'s error handler');
        } catch (\TypeError) {
        }
        $this->assertSame(['/api/items', 500, 'FormLogic failed while answering this call. The server’s log says why.', 'visitor'], [$this->recorded[0]['path'], $this->recorded[0]['status'], $this->recorded[0]['error'], $this->recorded[0]['caller']]);
        $this->assertStringNotContainsString('Secret.php', json_encode($this->recorded));
    }

    public function testACallFormLogicRefusedOrCouldNotRunIsWrittenDownAsTheCallerWasAnswered(): void
    {
        $log = tempnam(sys_get_temp_dir(), 'fl-calls-log-');
        $previous = ini_set('error_log', (string) $log);
        try {
            $big = $this->controller('application', static fn () => throw new \RuntimeException('This request is larger than the app accepts.', 413));
            $this->assertSame(413, $this->post($big, null, ['method' => 'POST', 'path' => '/api/items', 'body' => []])->getStatusCode());
            $busy = $this->controller('application', static fn () => throw new \RuntimeException('The app is busy. Try again in a moment.', 429));
            $this->assertSame(429, $this->post($busy, null, ['method' => 'POST', 'path' => '/api/items', 'body' => []])->getStatusCode());
            // An unexpected failure is the host's generic 503, never its own words.
            $down = $this->controller('application', static fn () => throw new \RuntimeException('/srv/apps/tasks-id/private: permission denied'));
            $this->assertSame(503, $this->post($down, 'owner', ['method' => 'GET', 'path' => '/api/items'])->getStatusCode());
        } finally {
            ini_set('error_log', $previous === false ? '' : $previous);
            unlink((string) $log);
        }
        $this->assertSame([
            [413, 'This request is larger than the app accepts.', 'visitor'],
            [429, 'The app is busy. Try again in a moment.', 'visitor'],
            [503, 'The native app host is unavailable. Check its runtime configuration.', 'owner'],
        ], array_map(static fn (array $call): array => [$call['status'], $call['error'], $call['caller']], $this->recorded));
    }

    public function testOnlyCallsToTheBackendAreWrittenDown(): void
    {
        $controller = $this->controller('application');
        $get = static fn (string $path, array $query = []) => (new ServerRequestFactory())->createServerRequest('GET', $path)->withQueryParams($query)->withAttribute('userId', 'owner');
        // The app's opening, its version check and its media.
        $controller->runtime($get('/api/app/tasks/native'), new Response(), ['slug' => 'tasks']);
        $controller->runtime($get('/api/app/tasks/native', ['only' => 'version']), new Response(), ['slug' => 'tasks']);
        $controller->runtime($get('/api/app/tasks/native/media'), new Response(), ['slug' => 'tasks']);
        // A request that is not a call at all (no path), and one to the site's own routes.
        $this->assertSame(400, $this->post($controller, 'owner', ['method' => 'GET'])->getStatusCode());
        $this->assertSame(400, $this->post($controller, 'owner', ['method' => 'GET', 'path' => '/api/items?x=1'])->getStatusCode());
        $this->assertSame(404, $this->post($controller, 'owner', ['method' => 'POST', 'path' => '/api/site/deliver'])->getStatusCode());
        // Someone the app does not let in.
        $this->assertSame(403, $this->post($this->controller('members'), 'stranger', ['method' => 'GET', 'path' => '/api/items'])->getStatusCode());
        $this->assertSame([], $this->recorded);
    }

    public function testACallIsAnsweredTheSameWhenItCannotBeWrittenDown(): void
    {
        $log = tempnam(sys_get_temp_dir(), 'fl-calls-log-');
        $previous = ini_set('error_log', (string) $log);
        try {
            $response = $this->post($this->controller('application', null, true), 'owner', ['method' => 'POST', 'path' => '/api/items', 'body' => ['title' => 'x']]);
        } finally {
            ini_set('error_log', $previous === false ? '' : $previous);
        }
        $said = (string) file_get_contents((string) $log);
        unlink((string) $log);
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame(['result' => ['status' => 201, 'body' => ['id' => 7]]], json_decode((string) $response->getBody(), true));
        $this->assertStringContainsString('App call not recorded for app tasks-id', $said);
    }
}
