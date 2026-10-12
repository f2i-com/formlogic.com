<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\NativeAppController;
use FormLogic\Services\{AppService, AppUserService, NativeAppService, PlanService, FlowService, RuntimeEngineService};
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * Offline controller boundary: real lifecycle policy/client projection; retrieval, membership,
 * engine and native execution are declared doubles. No database, JWT, process or HTTP server.
 */
final class NativeRuntimeIsolationTest extends TestCase
{
    private const ENGINE = ['id' => 'zipp-web-python', 'revision' => '0123456789abcdef'];

    /** @return array{NativeAppController, \ArrayObject, \ArrayObject} */
    private function fixture(string $access, string $status = 'published', ?string $membership = 'active', string $appId = 'database-app-id'): array
    {
        $calls = new \ArrayObject();
        $state = new \ArrayObject(['status' => $status, 'roleId' => 'editor']);
        $record = static function (string $method, array $args = []) use ($calls): void {
            $calls[$method] = [...($calls[$method] ?? []), $args];
        };
        // Do not stub isRuntimeVisible: a constant true here conceals archived-owner bypasses.
        $apps = $this->getMockBuilder(AppService::class)->disableOriginalConstructor()->onlyMethods(['getAppBySlug', 'getApp'])->getMock();
        $app = static fn () => ['id' => $appId, 'ownerId' => 'owner', 'name' => 'Test app', 'status' => $state['status'], 'settings' => ['softnApp' => true]];
        $apps->method('getAppBySlug')->willReturnCallback($app);
        $apps->method('getApp')->willReturnCallback($app);
        $users = $this->createMock(AppUserService::class);
        $users->method('getAppUser')->willReturnCallback(static function (...$args) use ($record, $membership, $state) {
            $record('membership', $args);
            return $membership === null ? null : ['status' => $membership, 'roleId' => $state['roleId']];
        });
        $spoof = ['access' => 'application', 'appId' => 'manifest-app-id', 'userId' => 'other-user', 'roleId' => 'owner'];
        $project = ['access' => $access, 'version' => 7, 'assets' => [], 'storageScope' => $spoof, 'files' => [
            'manifest.json' => json_encode(['id' => 'manifest-app-id', 'storageScope' => $spoof, 'config' => ['storageScope' => $spoof], 'server' => ['entry' => 'server/main.logic']], JSON_THROW_ON_ERROR),
            'ui/main.ui' => '<Text>Test</Text>', 'server/main.logic' => 'private server source',
        ]];
        $native = $this->createMock(NativeAppService::class);
        foreach (['get', 'project'] as $method) {
            $native->method($method)->willReturnCallback(static function (...$args) use ($record, $method, $project) { $record($method, $args); return $project; });
        }
        $native->method('clientLanguages')->willReturnCallback(static function (...$args) use ($record) { $record('clientLanguages', $args); return ['javascript']; });
        $native->method('request')->willReturnCallback(static function (...$args) use ($record) { $record('request', $args); return ['status' => 200, 'body' => ['ok' => true]]; });
        $native->method('dispatchRecordEvents')->willReturnCallback(static function (...$args) use ($record) { $record('events', $args); return 0; });
        $native->method('install')->willReturnCallback(static function (...$args) use ($record, $project) { $record('install', $args); return $project; });
        $native->method('records')->willReturnCallback(static function (...$args) use ($record) { $record('records', $args); return ['installed' => true, 'tables' => []]; });
        $native->method('manageRecord')->willReturnCallback(static function (...$args) use ($record) { $record('manageRecord', $args); return ['ok' => true]; });
        $native->method('available')->willReturn(false);
        $engines = $this->createMock(RuntimeEngineService::class);
        $engines->method('effective')->willReturnCallback(static function (...$args) use ($record) { $record('engine', $args); return self::ENGINE; });
        $engines->method('ownerPolicy')->willReturn([]);
        $engines->method('assertInstalledRuns')->willReturnCallback(static function (...$args) use ($record) { $record('installed', $args); });
        $engines->method('assertTorchAllowed')->willReturnCallback(static function (...$args) use ($record) { $record('torch', $args); });
        $engines->method('torchRefusal')->willReturn(null);
        $flows = $this->createMock(FlowService::class);
        $flows->method('nativeRecordSubscriptions')->willReturnCallback(static function (...$args) use ($record) { $record('subscriptions', $args); return []; });
        return [new NativeAppController($apps, $users, $native, $this->createMock(PlanService::class), $flows, $engines), $calls, $state];
    }

    private function request(string $method, ?string $user, bool $stale = false): ServerRequestInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, '/', ['REMOTE_ADDR' => '203.0.113.1']);
        if ($user !== null) $request = $request->withAttribute('userId', $user);
        // These are client-controlled values. Neither storage scope nor trusted native identity
        // can be taken from them, the installed manifest, or the project's own metadata.
        $request = $request->withQueryParams(['appId' => 'query-app', 'userId' => 'other-user'])
            ->withParsedBody(['method' => 'GET', 'path' => '/api/test', 'body' => ['userId' => 'other-user'], 'context' => ['formlogic' => ['appId' => 'body-app', 'userId' => 'other-user']], 'storageScope' => ['access' => 'application']]);
        return $stale ? $request->withHeader('X-FormLogic-Client-Engine', 'host-js;stale-revision') : $request;
    }

    private static function body(ResponseInterface $response): array
    {
        return json_decode((string) $response->getBody(), true, 64, JSON_THROW_ON_ERROR);
    }

    private function assertNoExecution(\ArrayObject $calls): void
    {
        foreach (['request', 'events', 'subscriptions', 'install', 'records', 'manageRecord'] as $method) {
            $this->assertSame([], $calls[$method] ?? [], $method . ' must not run');
        }
    }

    public static function hiddenCases(): iterable
    {
        foreach (['application', 'members'] as $access) {
            foreach ([['archived', 'owner'], ['archived', 'member'], ['archived', null], ['draft', 'member'], ['draft', null]] as [$status, $user]) {
                foreach ([['GET', false], ['POST', false], ['POST', true]] as [$method, $stale]) {
                    yield implode('/', [$access, $status, $user ?? 'anonymous', $method, $stale ? 'stale' : 'plain']) => [$access, $status, $user, $method, $stale];
                }
            }
        }
    }

    #[DataProvider('hiddenCases')]
    public function testHiddenRuntimeStopsBeforeProjectMembershipAndEngine(string $access, string $status, ?string $user, string $method, bool $stale): void
    {
        [$controller, $calls] = $this->fixture($access, $status);
        $request = $this->request($method, $user, $stale);
        $response = $controller->runtime($request, new Response(), ['slug' => 'same-slug']);
        $this->assertSame(404, $response->getStatusCode());
        $this->assertSame(['error' => true, 'message' => 'App not found or access denied'], self::body($response));
        $this->assertSame([], $calls->getArrayCopy(), 'nothing beyond app lookup runs for a hidden app');
        $entry = $controller->entry($request, new Response(), ['slug' => 'same-slug']);
        $this->assertSame(['home' => false], self::body($entry));
        $this->assertSame([], $calls->getArrayCopy());
    }

    public static function admittedCases(): iterable
    {
        foreach ([['application', 'published', null], ['application', 'published', 'member'], ['application', 'published', 'owner'], ['application', 'draft', 'owner'], ['members', 'published', 'member'], ['members', 'published', 'owner'], ['members', 'draft', 'owner']] as [$access, $status, $user]) {
            foreach (['GET', 'POST'] as $method) yield implode('/', [$access, $status, $user ?? 'anonymous', $method]) => [$access, $status, $user, $method];
        }
    }

    #[DataProvider('admittedCases')]
    public function testAdmittedRuntimeHasOnlyTrustedStorageScopeAndIdentity(string $access, string $status, ?string $user, string $method): void
    {
        [$controller, $calls] = $this->fixture($access, $status);
        $response = $controller->runtime($this->request($method, $user), new Response(), ['slug' => 'same-slug']);
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame('no-store', $response->getHeaderLine('Cache-Control'));
        $this->assertSame([['database-app-id']], $calls['project']);
        $this->assertSame($access === 'members' && $user !== 'owner' ? [['database-app-id', $user]] : [], $calls['membership'] ?? []);
        $body = self::body($response);
        if ($method === 'GET') {
            $scope = ['access' => $access, 'appId' => 'database-app-id'];
            if ($access === 'members') $scope['userId'] = $user;
            $this->assertSame($scope, $body['project']['storageScope'] ?? null);
            $this->assertSame($access, $body['project']['access']);
            $this->assertArrayNotHasKey('server/main.logic', $body['project']['client']);
            $this->assertArrayNotHasKey('server', json_decode($body['project']['client']['manifest.json'], true));
            $this->assertNoExecution($calls);
        } else {
            $this->assertArrayNotHasKey('storageScope', $body);
            $this->assertCount(1, $calls['request']);
            $this->assertSame('database-app-id', $calls['request'][0][0]);
            $this->assertArrayNotHasKey('context', $calls['request'][0][1]);
            $this->assertSame($access === 'members' ? ['formlogic' => ['appId' => 'database-app-id', 'userId' => $user, 'roleId' => $user === 'owner' ? 'owner' : 'editor']] : [], $calls['request'][0][2]);
            $this->assertSame(7, $calls['request'][0][4]);
            $this->assertCount(1, $calls['events']);
        }
    }

    public static function deniedMemberCases(): iterable
    {
        foreach ([[null, null], ['outsider', null], ['member', 'pending'], ['member', 'suspended']] as [$user, $membership]) {
            foreach ([['GET', false], ['POST', false], ['POST', true]] as [$method, $stale]) {
                yield implode('/', [$user ?? 'anonymous', $membership ?? 'missing', $method, $stale ? 'stale' : 'plain']) => [$user, $membership, $method, $stale];
            }
        }
    }

    #[DataProvider('deniedMemberCases')]
    public function testDeniedMembersReceiveNoProjectScopeEngineOrExecution(?string $user, ?string $membership, string $method, bool $stale): void
    {
        [$controller, $calls] = $this->fixture('members', 'published', $membership);
        $response = $controller->runtime($this->request($method, $user, $stale), new Response(), ['slug' => 'same-slug']);
        $this->assertSame(403, $response->getStatusCode());
        $body = self::body($response);
        foreach (['project', 'storageScope', 'engine', 'result', 'code'] as $key) $this->assertArrayNotHasKey($key, $body);
        $this->assertSame([['database-app-id']], $calls['project'], 'settled project determines access mode');
        $this->assertSame($user === null ? [] : [['database-app-id', $user]], $calls['membership'] ?? []);
        foreach (['engine', 'clientLanguages', 'installed', 'torch'] as $key) $this->assertSame([], $calls[$key] ?? []);
        $this->assertNoExecution($calls);
    }

    public function testScopeDoesNotDependOnRoleOrSlugAndNeverUsesTheManifestAppId(): void
    {
        [$controller, , $state] = $this->fixture('members');
        $first = self::body($controller->runtime($this->request('GET', 'member'), new Response(), ['slug' => 'old-slug']));
        $state['roleId'] = 'new-role';
        $next = self::body($controller->runtime($this->request('GET', 'member'), new Response(), ['slug' => 'new-slug']));
        $this->assertSame(['access' => 'members', 'appId' => 'database-app-id', 'userId' => 'member'], $first['project']['storageScope'] ?? null);
        $this->assertSame($first['project']['storageScope'], $next['project']['storageScope']);
        [$other] = $this->fixture('members', 'published', 'active', 'other-installation');
        $otherBody = self::body($other->runtime($this->request('GET', 'member'), new Response(), ['slug' => 'old-slug']));
        $this->assertSame(['access' => 'members', 'appId' => 'other-installation', 'userId' => 'member'], $otherBody['project']['storageScope'] ?? null);
        $this->assertNotSame($first['project']['storageScope'], $otherBody['project']['storageScope']);
    }

    public static function staleCases(): iterable
    {
        yield 'independent application' => ['application', null];
        yield 'active member' => ['members', 'member'];
        yield 'owner' => ['members', 'owner'];
    }

    #[DataProvider('staleCases')]
    public function testAdmittedStaleEngineStillReturns409BeforeExecution(string $access, ?string $user): void
    {
        [$controller, $calls] = $this->fixture($access);
        $response = $controller->runtime($this->request('POST', $user, true), new Response(), ['slug' => 'same-slug']);
        $this->assertSame(409, $response->getStatusCode());
        $this->assertSame('engine_changed', self::body($response)['code']);
        $this->assertSame('no-store', $response->getHeaderLine('Cache-Control'));
        $this->assertArrayNotHasKey('project', self::body($response));
        $this->assertNoExecution($calls);
    }

    public static function lifecycleCases(): iterable
    {
        foreach (['application', 'members'] as $access) foreach (['GET', 'POST'] as $method) yield "$access/$method" => [$access, $method];
    }

    #[DataProvider('lifecycleCases')]
    public function testSameOwnerRequestStopsWhileArchivedAndResumesAsDraft(string $access, string $method): void
    {
        [$controller, $calls, $state] = $this->fixture($access);
        $request = $this->request($method, 'owner');
        foreach (['published' => 200, 'archived' => 404, 'draft' => 200] as $status => $expected) {
            $state['status'] = $status;
            $before = $calls->getArrayCopy();
            $response = $controller->runtime($request, new Response(), ['slug' => 'same-slug']);
            $this->assertSame($expected, $response->getStatusCode(), $status);
            if ($status === 'archived') $this->assertSame($before, $calls->getArrayCopy());
        }
        $this->assertCount(2, $calls['project']);
        $this->assertSame($method === 'POST' ? 2 : 0, count($calls['request'] ?? []));
    }

    public static function managementCases(): iterable
    {
        foreach (['owner', 'member', null] as $user) {
            foreach (['source', 'install', 'records', 'read', 'write', 'starter'] as $operation) yield ($user ?? 'anonymous') . "/$operation" => [$user, $operation];
        }
    }

    #[DataProvider('managementCases')]
    public function testArchivedManagementKeepsOwnerAuthority(?string $user, string $operation): void
    {
        [$controller, $calls] = $this->fixture('members', 'archived');
        $method = match ($operation) { 'source', 'records' => 'GET', 'install' => 'PUT', default => 'POST' };
        $request = $this->request($method, $user);
        $args = ['id' => 'database-app-id'];
        if ($operation === 'install') $request = $request->withParsedBody(['project' => ['files' => []], 'expectedVersion' => 7]);
        if (in_array($operation, ['records', 'read', 'write'], true)) {
            $args['operation'] = 'records';
            $request = $request->withParsedBody(['action' => $operation === 'read' ? 'read' : 'update']);
        }
        if ($operation === 'starter') $args['operation'] = 'starter';
        $response = $controller->manage($request, new Response(), $args);
        $this->assertSame($user === 'owner' ? 200 : 404, $response->getStatusCode());
        if ($user !== 'owner') {
            $this->assertSame([], $calls->getArrayCopy());
        } else {
            $expectedCall = match ($operation) { 'source' => 'project', 'install', 'starter' => 'install', 'records' => 'records', default => 'manageRecord' };
            $this->assertCount(1, $calls[$expectedCall]);
            $this->assertSame([], $calls['membership'] ?? []);
            $this->assertSame([], $calls['request'] ?? []);
        }
    }
}
