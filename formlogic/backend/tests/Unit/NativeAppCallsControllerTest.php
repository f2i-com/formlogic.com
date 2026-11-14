<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\NativeAppCallsController;
use FormLogic\Http\AdminActingAsRoutes;
use FormLogic\Models\User;
use FormLogic\Services\{AppService, NativeAppCalls};
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * The owner's route for an app's recent calls (GET /api/apps/{id}/native/calls): who is admitted,
 * how many calls are asked for, what a failed read says, and that it is wired as the app's other
 * owner reads are, with no way in for an administrator acting as the owner.
 */
final class NativeAppCallsControllerTest extends TestCase
{
    private const APP = ['id' => 'tasks-id', 'slug' => 'tasks', 'ownerId' => 'owner', 'name' => 'Task board', 'status' => 'published', 'settings' => ['softnApp' => true]];
    private const CALL = ['id' => 9, 'at' => '2026-11-14T09:00:00.120+00:00', 'method' => 'POST', 'path' => '/api/items', 'status' => 422, 'ms' => 31, 'error' => 'Give a title of 1 to 200 characters', 'caller' => 'visitor'];

    /** @var list<array{string, int}> what the record was asked for: the app and the number */
    private array $asked = [];

    private function controller(?\Throwable $failure = null): NativeAppCallsController
    {
        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturnCallback(static fn (string $id): ?array => $id === self::APP['id'] ? self::APP : null);
        $calls = $this->createMock(NativeAppCalls::class);
        $calls->method('recent')->willReturnCallback(function (string $appId, int $limit) use ($failure): array {
            $this->asked[] = [$appId, $limit];
            if ($failure !== null) throw $failure;
            return [self::CALL];
        });
        return new NativeAppCallsController($apps, $calls);
    }

    private function call(?string $user = 'owner', array $query = [], string $id = self::APP['id'], ?NativeAppCallsController $controller = null, bool $demo = false): ResponseInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/api/apps/' . $id . '/native/calls')->withQueryParams($query);
        if ($user !== null) $request = $request->withAttribute('userId', $user)->withAttribute('user', new User(id: $user, email: $demo ? ($_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local') : 'owner@example.test'));
        return ($controller ?? $this->controller())->index($request, new Response(), ['id' => $id]);
    }

    private static function body(ResponseInterface $response): array
    {
        return json_decode((string) $response->getBody(), true);
    }

    public function testTheOwnerIsGivenTheAppsNewestCallsAndWhatIsKept(): void
    {
        $response = $this->call();
        $this->assertSame(200, $response->getStatusCode(), (string) $response->getBody());
        $this->assertSame('no-store', $response->getHeaderLine('Cache-Control'));
        $this->assertSame(['calls' => [self::CALL], 'limit' => 50, 'keep' => ['calls' => 500, 'days' => 14]], self::body($response));
        $this->assertSame([['tasks-id', 50]], $this->asked);
    }

    public function testTheNumberAskedForIsHeldToWhatIsKept(): void
    {
        foreach ([['20', 20], ['500', 500], ['501', 500], ['999999', 500], ['0', 1], ['1', 1]] as [$limit, $given]) {
            $this->assertSame($given, self::body($this->call('owner', ['limit' => $limit]))['limit'], $limit);
        }
        // Anything but a plain number is the page's own number.
        foreach (['-5', '10.5', 'all', '1e3', ' 20', ['20']] as $odd) {
            $this->assertSame(50, self::body($this->call('owner', ['limit' => $odd]))['limit'], var_export($odd, true));
        }
    }

    public function testAnotherPersonNoOneAndAnAppThatIsNotThereAreAllTheSame404(): void
    {
        foreach ([['someone-else', self::APP['id']], [null, self::APP['id']], ['owner', 'no-such-app']] as [$who, $id]) {
            $response = $this->call($who, [], $id);
            $this->assertSame(404, $response->getStatusCode());
            $this->assertSame(['error' => true, 'message' => 'App not found or access denied'], self::body($response));
        }
        $this->assertSame([], $this->asked, 'nobody else\'s request reads the record');
    }

    public function testTheSharedDemoReadsItsOwnAppsCalls(): void
    {
        $this->assertSame(200, $this->call('owner', [], self::APP['id'], null, true)->getStatusCode());
    }

    public function testARecordThatCannotBeReadIsSaidAsThatAndNotAsNoCalls(): void
    {
        $log = tempnam(sys_get_temp_dir(), 'fl-calls-log-');
        $previous = ini_set('error_log', (string) $log);
        try {
            $response = $this->call('owner', [], self::APP['id'], $this->controller(new \PDOException('SQLSTATE[42S02]: Base table or view not found')));
        } finally {
            ini_set('error_log', $previous === false ? '' : $previous);
        }
        $said = (string) file_get_contents((string) $log);
        unlink((string) $log);
        $this->assertSame(503, $response->getStatusCode());
        $this->assertSame('calls_unavailable', self::body($response)['code']);
        $this->assertStringNotContainsString('SQLSTATE', (string) $response->getBody());
        $this->assertStringContainsString('Base table or view not found', $said, 'the reason is in the server\'s log');
    }

    /**
     * Read as the app's history is read (the same limiter, signed in), and never mirrored for an
     * administrator acting as the owner: an app's backend is none of theirs.
     */
    public function testTheRouteIsWiredAsTheOwnersOtherReadsAre(): void
    {
        $source = str_replace("\r\n", "\n", (string) file_get_contents(dirname(__DIR__, 2) . '/public/index.php'));
        $count = preg_match_all("~\\\$app->(get|post|put|delete|map)\\(([^,]*'/api/apps/\\{id\\}/native/calls[^']*')[^;]*?NativeAppCallsController::class\\)->(\\w+)\\(.*?\\}\\)((?:->add\\([^;]*?\\))*);~s", $source, $routes, PREG_SET_ORDER);
        $this->assertSame(1, $count, 'one route, a read');
        [, $method, $path, $action, $chain] = $routes[0];
        $this->assertSame(['get', "'/api/apps/{id}/native/calls'", 'index', '->add($hostingReadLimiter)->add($authRequired)'], [$method, $path, $action, $chain]);
        foreach (AdminActingAsRoutes::ROUTES as $row) {
            $this->assertStringNotContainsString('/native', $row[1]);
            $this->assertNotSame(NativeAppCallsController::class, $row[2]);
        }
        // The runtime is handed the record, or nothing would ever be written down.
        $this->assertMatchesRegularExpression('~NativeAppController::class, function \(Container \$c\) \{.*?NativeAppCalls::class\)\s*\);~s', $source);
    }
}
