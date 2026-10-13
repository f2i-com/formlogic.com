<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\HostedAppController;
use FormLogic\Middleware\AuthMiddleware;
use FormLogic\Models\User;
use FormLogic\Services\{AppService, AppUserService, AuditService, AuthService, HostedAppService, NativeAppService, RuntimeEngineService};
use FormLogic\Support\HostedActorContext;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/** Actual controller and PSR-7 requests; all services are inert in-memory doubles. */
final class HostedAppActorAdmissionTest extends TestCase
{
    private const SESSION = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    private static function actor(string $user = 'member-a', string $app = 'app-a', ?string $role = 'role-a', bool $owner = false, string $session = self::SESSION): array
    {
        return ['version' => 1, 'appId' => $app, 'userId' => $user, 'roleId' => $role, 'isOwner' => $owner, 'sessionId' => $session];
    }

    /** Returns a mutable host authority and a sentinel journal, never a database. */
    private function fixture(): array
    {
        $state = (object) [
            'app' => ['id' => 'app-a', 'ownerId' => 'owner-a', 'name' => 'Synthetic app', 'status' => 'published'],
            'membership' => ['appId' => 'app-a', 'userId' => 'member-a', 'roleId' => 'role-a', 'status' => 'active'],
            'calls' => [], 'records' => [], 'mutations' => 0, 'publishes' => 0, 'engineCalls' => 0, 'failure' => null,
            'deployment' => ['version' => 1, 'client' => ['manifest.json' => '{"main":"ui/main.ui"}', 'ui/main.ui' => '<Text>Synthetic</Text>']],
        ];
        $apps = $this->createMock(AppService::class);
        $apps->method('getAppBySlug')->willReturnCallback(static fn() => $state->app);
        $apps->method('getApp')->willReturnCallback(static fn() => $state->app);
        $apps->method('isRuntimeVisible')->willReturnCallback(static fn(array $app, string $user) => $app['status'] === 'published' || ($app['status'] === 'draft' && $app['ownerId'] === $user));
        $users = $this->createMock(AppUserService::class);
        $users->method('getAppUser')->willReturnCallback(static fn() => $state->membership);
        $hosting = $this->createMock(HostedAppService::class);
        $hosting->method('get')->willReturnCallback(static fn() => $state->deployment);
        $hosting->method('publish')->willReturnCallback(static function () use ($state): array { $state->publishes++; return $state->deployment; });
        $hosting->method('clientLanguages')->willReturn(['javascript']);
        $hosting->method('run')->willReturnCallback(static function (string $app, string $action, array $input, string $user, bool $owner) use ($state): array {
            $state->calls[] = ['appId' => $app, 'action' => $action, 'input' => $input, 'userId' => $user, 'owner' => $owner];
            if ($state->failure !== null) throw $state->failure;
            // Sentinel models an existing owner-only action. This test verifies
            // the controller cannot let a client claim select its owner argument.
            if ($action === 'configureCredits' && !$owner) throw new \RuntimeException('Action not found or access denied', 404);
            if ($action === 'getProject') return ['privateFor' => $user];
            $key = $app . '/' . $user . '/' . ($input['id'] ?? 'request-a');
            if (!isset($state->records[$key])) {
                $state->records[$key] = ['id' => $input['id'] ?? 'request-a', 'author' => $user, 'appId' => $app];
                $state->mutations++;
            }
            return $state->records[$key];
        });
        $engines = $this->createMock(RuntimeEngineService::class);
        $engines->method('effective')->willReturnCallback(static function () use ($state): array {
            $state->engineCalls++;
            return ['id' => 'host-js', 'revision' => '0123456789abcdef'];
        });
        $engines->method('ownerPolicy')->willReturn([]);
        return [new HostedAppController($apps, $users, $hosting, $engines, $this->createMock(AuditService::class), $this->createMock(NativeAppService::class)), $state];
    }

    private function request(string $method = 'POST', ?array $actor = null, string $user = 'member-a', ?string $session = self::SESSION): ServerRequestInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, '/api/app/synthetic/actions/createRequest')
            ->withAttribute('userId', $user)->withAttribute('user', new User($user, 'synthetic@example.invalid'))
            ->withParsedBody(['id' => 'stable-request-a', 'title' => 'Synthetic draft']);
        if ($session !== null) $request = $request->withAttribute(HostedActorContext::SESSION_ATTRIBUTE, $session);
        if ($actor !== null) $request = $request->withHeader(HostedActorContext::HEADER, json_encode($actor));
        return $request;
    }

    private static function body(ResponseInterface $response): array
    {
        self::assertSame('no-store', $response->getHeaderLine('Cache-Control'));
        self::assertSame('nosniff', $response->getHeaderLine('X-Content-Type-Options'));
        return json_decode((string) $response->getBody(), true, 64, JSON_THROW_ON_ERROR);
    }

    public function testRuntimeAdmissionIsTrustedAndDoesNotExposeActionSource(): void
    {
        [$controller, $state] = $this->fixture();
        $response = $controller->runtime($this->request('GET')->withHeader(HostedActorContext::HEADER, json_encode(self::actor('forged-owner', 'app-b', null, true))), new Response(), ['slug' => 'synthetic']);
        self::assertSame(200, $response->getStatusCode());
        $body = self::body($response);
        self::assertSame(self::actor(), $body['actor']);
        self::assertArrayNotHasKey('actions', $body['deployment']);
        self::assertSame([], $state->calls);
    }

    public static function staleActors(): iterable
    {
        yield 'account' => [self::actor('member-b')];
        yield 'app' => [self::actor('member-a', 'app-b')];
        yield 'membership role' => [self::actor('member-a', 'app-a', 'role-b')];
        yield 'owner claim' => [self::actor('member-a', 'app-a', null, true)];
        yield 'session' => [self::actor('member-a', 'app-a', 'role-a', false, str_repeat('b', 64))];
    }

    #[DataProvider('staleActors')]
    public function testStaleIdentityIsRefusedBeforeAnyActionOrEngineResolution(array $actor): void
    {
        [$controller, $state] = $this->fixture();
        foreach (['createRequest', 'getWallet', 'getProject', 'configureCredits'] as $action) {
            $request = $this->request('POST', $actor)->withHeader('X-FormLogic-Client-Engine', 'host-js;stale');
            $response = $controller->runtime($request, new Response(), ['slug' => 'synthetic', 'action' => $action]);
            self::assertSame(409, $response->getStatusCode());
            self::assertSame('actor_changed', self::body($response)['code']);
            self::assertSame(self::actor(), self::body($response)['actor']);
        }
        self::assertSame([], $state->calls);
        self::assertSame(0, $state->mutations);
        self::assertSame(0, $state->engineCalls);
    }

    public function testMissingInitiatingIdentityCannotWrite(): void
    {
        [$controller, $state] = $this->fixture();
        $response = $controller->runtime($this->request(), new Response(), ['slug' => 'synthetic', 'action' => 'createRequest']);
        self::assertSame(409, $response->getStatusCode());
        self::assertSame('actor_context_required', self::body($response)['code']);
        self::assertSame(self::actor(), self::body($response)['actor']);
        self::assertSame([], $state->calls);
    }

    public function testMissingMiddlewareContextBlocksRuntimeAndAction(): void
    {
        [$controller, $state] = $this->fixture();
        foreach (['GET', 'POST'] as $method) {
            $response = $controller->runtime($this->request($method, self::actor(), 'member-a', null), new Response(), ['slug' => 'synthetic', 'action' => 'createRequest']);
            self::assertSame(503, $response->getStatusCode());
            self::assertSame('actor_context_unavailable', self::body($response)['code']);
            self::assertNull(self::body($response)['actor']);
            self::assertArrayNotHasKey('deployment', self::body($response));
        }
        self::assertSame([], $state->calls);
        self::assertSame(0, $state->engineCalls);
    }

    public function testSameActorRetryPreservesInputAndOnlySentinelFirstWriteMutates(): void
    {
        [$controller, $state] = $this->fixture();
        $request = $this->request('POST', self::actor());
        $first = self::body($controller->runtime($request, new Response(), ['slug' => 'synthetic', 'action' => 'createRequest']));
        $second = self::body($controller->runtime($request, new Response(), ['slug' => 'synthetic', 'action' => 'createRequest']));
        self::assertSame($first, $second);
        self::assertSame('member-a', $first['result']['author']);
        self::assertSame('stable-request-a', $first['result']['id']);
        self::assertCount(2, $state->calls);
        self::assertSame($request->getParsedBody(), $state->calls[0]['input']);
        self::assertSame($state->calls[0]['input'], $state->calls[1]['input']);
        self::assertSame(1, $state->mutations);
    }

    public function testAccountSwitchCannotCreateOrReplayAsNewAccount(): void
    {
        [$controller, $state] = $this->fixture();
        $actorA = self::actor();
        $controller->runtime($this->request('POST', $actorA), new Response(), ['slug' => 'synthetic', 'action' => 'createRequest']);
        $state->membership['userId'] = 'member-b';
        $switched = $this->request('POST', $actorA, 'member-b', str_repeat('b', 64));
        foreach (['createRequest', 'getProject'] as $action) {
            $response = $controller->runtime($switched, new Response(), ['slug' => 'synthetic', 'action' => $action]);
            self::assertSame(409, $response->getStatusCode());
            self::assertSame('member-b', self::body($response)['actor']['userId']);
            self::assertArrayNotHasKey('result', self::body($response));
        }
        self::assertCount(1, $state->calls);
        self::assertSame(1, $state->mutations);
        self::assertArrayNotHasKey('app-a/member-b/stable-request-a', $state->records);
    }

    public function testCookieSwitchThroughActualMiddlewareRejectsOldAdmission(): void
    {
        [$controller, $state] = $this->fixture();
        $auth = $this->createMock(AuthService::class);
        // Mock-only markers exercise cookie selection without minting a token,
        // account or session, connecting to a database, or setting any cookie.
        $auth->method('validateToken')->willReturnCallback(static fn(string $marker) => match ($marker) {
            'synthetic-cookie-marker-a' => new User('member-a', 'synthetic@example.invalid'),
            'synthetic-cookie-marker-b' => new User('member-b', 'synthetic@example.invalid'),
            default => null,
        });
        $middleware = new AuthMiddleware($auth);
        $handler = new class($controller) implements RequestHandlerInterface {
            public string $action = 'createRequest';
            public function __construct(private HostedAppController $controller) {}
            public function handle(ServerRequestInterface $request): ResponseInterface {
                return $this->controller->runtime($request, new Response(), ['slug' => 'synthetic', 'action' => $this->action]);
            }
        };
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/api/app/synthetic/hosting')
            ->withCookieParams(['formlogic_auth' => 'synthetic-cookie-marker-a']);
        $admission = self::body($middleware->process($request, $handler))['actor'];
        self::assertSame('member-a', $admission['userId']);
        $request = $request->withMethod('POST')->withHeader(HostedActorContext::HEADER, json_encode($admission))
            ->withParsedBody(['id' => 'stable-request-a', 'title' => 'A draft']);
        self::assertSame(200, $middleware->process($request, $handler)->getStatusCode());
        $state->membership['userId'] = 'member-b';
        $request = $request->withCookieParams(['formlogic_auth' => 'synthetic-cookie-marker-b']);
        foreach (['createRequest', 'getProject'] as $action) {
            $handler->action = $action;
            $response = $middleware->process($request, $handler);
            self::assertSame(409, $response->getStatusCode());
            self::assertSame('actor_changed', self::body($response)['code']);
            self::assertSame('member-b', self::body($response)['actor']['userId']);
            self::assertArrayNotHasKey('result', self::body($response));
        }
        self::assertCount(1, $state->calls);
        self::assertSame(1, $state->mutations);
        self::assertArrayNotHasKey('app-a/member-b/stable-request-a', $state->records);
    }

    public function testRevokedMembershipAndHiddenAppsDoNotRevealActorOrResult(): void
    {
        [$controller, $state] = $this->fixture();
        foreach (['suspended', 'pending', 'removed'] as $status) {
            $state->membership['status'] = $status;
            $response = $controller->runtime($this->request('POST', self::actor()), new Response(), ['slug' => 'synthetic', 'action' => 'getProject']);
            self::assertSame(403, $response->getStatusCode());
            self::assertNull(self::body($response)['actor']);
            self::assertArrayNotHasKey('result', self::body($response));
        }
        $state->membership['status'] = 'active';
        $state->app['status'] = 'draft';
        $response = $controller->runtime($this->request('POST', self::actor()), new Response(), ['slug' => 'synthetic', 'action' => 'getProject']);
        self::assertSame(404, $response->getStatusCode());
        self::assertNull(self::body($response)['actor']);
        self::assertSame([], $state->calls);
    }

    public function testFreshReadUnderChangedAuthorityIsStampedForThatAuthorityOnly(): void
    {
        [$controller, $state] = $this->fixture();
        $state->membership['userId'] = 'member-b';
        $state->membership['roleId'] = 'role-b';
        $actor = self::actor('member-b', 'app-a', 'role-b', false, str_repeat('b', 64));
        $response = $controller->runtime($this->request('POST', $actor, 'member-b', str_repeat('b', 64)), new Response(), ['slug' => 'synthetic', 'action' => 'getProject']);
        self::assertSame(200, $response->getStatusCode());
        self::assertSame($actor, self::body($response)['actor']);
        self::assertSame(['privateFor' => 'member-b'], self::body($response)['result']);
        self::assertSame(0, $state->mutations);
    }

    public function testAnonymousRequestAndMissingAppRevealNoPrivateProjection(): void
    {
        [$controller, $state] = $this->fixture();
        $request = $this->request('POST', self::actor())->withoutAttribute('userId')->withoutAttribute('user');
        $response = $controller->runtime($request, new Response(), ['slug' => 'synthetic', 'action' => 'getProject']);
        self::assertSame(404, $response->getStatusCode());
        self::assertNull(self::body($response)['actor']);
        $state->app = null;
        $response = $controller->runtime($this->request('GET'), new Response(), ['slug' => 'missing']);
        self::assertSame(404, $response->getStatusCode());
        self::assertNull(self::body($response)['actor']);
        self::assertArrayNotHasKey('deployment', self::body($response));
        self::assertSame([], $state->calls);
    }

    public function testInputAndHeaderCannotImpersonateOwnerForPrivateAction(): void
    {
        [$controller, $state] = $this->fixture();
        $input = ['id' => 'private-attempt', 'userId' => 'owner-a', 'isOwner' => true, 'roleId' => 'owner', 'actor' => self::actor('owner-a', 'app-a', null, true)];
        $request = $this->request('POST', self::actor())->withParsedBody($input);
        $response = $controller->runtime($request, new Response(), ['slug' => 'synthetic', 'action' => 'configureCredits']);
        self::assertSame(404, $response->getStatusCode());
        self::assertSame(self::actor(), self::body($response)['actor']);
        self::assertSame('member-a', $state->calls[0]['userId']);
        self::assertFalse($state->calls[0]['owner']);
        self::assertSame(0, $state->mutations);
        $forged = $request->withHeader(HostedActorContext::HEADER, json_encode(self::actor('owner-a', 'app-a', null, true)));
        self::assertSame(409, $controller->runtime($forged, new Response(), ['slug' => 'synthetic', 'action' => 'configureCredits'])->getStatusCode());
        self::assertCount(1, $state->calls, 'forged header is refused before the private action');
    }

    public static function actionErrors(): iterable
    {
        yield 'invalid input' => [new \InvalidArgumentException('Invalid synthetic input'), 400];
        yield 'private missing action' => [new \RuntimeException('Action not found or access denied', 404), 404];
        yield 'idempotency conflict' => [new \RuntimeException('Synthetic conflict', 409), 409];
        yield 'action rejection' => [new \RuntimeException('Synthetic rejection', 422), 422];
        yield 'runtime unavailable' => [new \RuntimeException('Synthetic unavailable'), 503];
        yield 'unexpected error' => [new \LogicException('Synthetic unexpected'), 503];
    }

    #[DataProvider('actionErrors')]
    public function testResolvedActionErrorsRetainTrustedIdentity(\Throwable $failure, int $status): void
    {
        [$controller, $state] = $this->fixture();
        $state->failure = $failure;
        $response = $controller->runtime($this->request('POST', self::actor()), new Response(), ['slug' => 'synthetic', 'action' => 'createRequest']);
        self::assertSame($status, $response->getStatusCode());
        self::assertSame(self::actor(), self::body($response)['actor']);
        self::assertArrayNotHasKey('result', self::body($response));
        self::assertSame(0, $state->mutations);
    }

    public function testEngineRefusalIsStampedButCannotExecuteAnAction(): void
    {
        [$controller, $state] = $this->fixture();
        $response = $controller->runtime($this->request('POST', self::actor())->withHeader('X-FormLogic-Client-Engine', 'host-js;old'), new Response(), ['slug' => 'synthetic', 'action' => 'createRequest']);
        self::assertSame(409, $response->getStatusCode());
        self::assertSame('engine_changed', self::body($response)['code']);
        self::assertSame(self::actor(), self::body($response)['actor']);
        self::assertSame([], $state->calls);
    }

    public function testOwnerPreviewGetAndPublishReceiveTrustedAdmission(): void
    {
        [$controller] = $this->fixture();
        $actor = self::actor('owner-a', 'app-a', null, true);
        foreach (['GET', 'PUT'] as $method) {
            $request = $this->request($method, null, 'owner-a')->withParsedBody(['package' => ['client' => []], 'expectedVersion' => 0]);
            $response = $controller->manage($request, new Response(), ['id' => 'app-a']);
            self::assertSame(200, $response->getStatusCode());
            self::assertSame($actor, self::body($response)['actor']);
        }
    }

    public function testOwnerPreviewWithoutMiddlewareContextCannotPublish(): void
    {
        [$controller, $state] = $this->fixture();
        $response = $controller->manage($this->request('PUT', null, 'owner-a', null)->withParsedBody(['package' => ['client' => []], 'expectedVersion' => 0]), new Response(), ['id' => 'app-a']);
        self::assertSame(503, $response->getStatusCode());
        self::assertNull(self::body($response)['actor']);
        self::assertSame(0, $state->engineCalls);
        self::assertSame(0, $state->publishes);
    }
}
