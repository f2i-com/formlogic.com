<?php
declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\HostedAppController;
use FormLogic\Services\{AppService, AppUserService, AuditService, HostedAppService, NativeAppService, RuntimeEngineService};
use FormLogic\Support\HostedActorContext;
use FormLogic\Tests\Support\HostedControllerRequest;
use FormLogic\Tests\Support\RecordsHostedControllerCalls;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Response;

/**
 * Service-free companion for the 13 runtime/manage branches of AppEngineEndpointTest.
 * Reuses its exact request builder and call recorder. No original integration class,
 * setup, constructor, database, installed runtime file, or credential is executed.
 */
final class AppEngineCallerAdmissionTest extends TestCase
{
    use RecordsHostedControllerCalls;

    private function fixture(): array
    {
        $state = (object) [
            'app' => ['id' => 'engine-app', 'ownerId' => 'owner-a', 'name' => 'Engine fixture', 'status' => 'published'],
            'member' => ['appId' => 'engine-app', 'userId' => 'member-a', 'roleId' => 'member-role', 'status' => 'active'],
            'deployment' => ['version' => 1, 'client' => ['manifest.json' => '{"main":"ui/main.ui"}', 'ui/main.ui' => '<Text>Synthetic</Text>']],
            'policy' => ['default' => 'zipp-web-python', 'allowed' => ['zipp-web-python', 'zipp-web', 'host-js'], 'revision' => 1, 'torch' => false],
            'installed' => ['zipp-web-python', 'zipp-web', 'host-js'], 'features' => ['python-logic/1'],
            'owner' => ['verifiedAt' => 'synthetic-verification', 'isDemo' => false], 'stored' => null,
            'resolverFailure' => false, 'runArguments' => [], 'resolverLanguages' => [], 'torchRefused' => false,
        ];
        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturnCallback(static fn() => $state->app);
        $apps->method('getAppBySlug')->willReturnCallback(static fn() => $state->app);
        $apps->method('isRuntimeVisible')->willReturn(true);
        $users = $this->createMock(AppUserService::class);
        $users->method('getAppUser')->willReturnCallback(static fn() => $state->member);
        $hosting = $this->createMock(HostedAppService::class);
        $hosting->method('get')->willReturnCallback(static fn() => $state->deployment);
        $hosting->method('clientLanguages')->willReturnCallback(static fn() => RuntimeEngineService::languagesOf($state->deployment['client']));
        $hosting->method('publish')->willReturnCallback(static function (string $appId, array $package, int $expectedVersion) use ($state): array {
            self::assertSame($state->app['id'], $appId);
            self::assertSame($state->deployment['version'], $expectedVersion);
            $state->deployment = ['version' => $expectedVersion + 1, 'client' => $package['client']];
            return $state->deployment;
        });
        $hosting->method('run')->willReturnCallback(static function (...$args) use ($state): int { $state->runArguments[] = $args; return 1; });
        $engines = $this->createMock(RuntimeEngineService::class);
        $engines->method('effective')->willReturnCallback(static function (string $appId, array $languages = []) use ($state): array {
            self::assertSame($state->app['id'], $appId);
            $state->resolverLanguages[] = $languages;
            if ($state->resolverFailure) throw new \RuntimeException('Synthetic resolver unavailable');
            return self::decision($state, $languages);
        });
        $engines->method('assertInstalledRuns')->willReturnCallback(static function (array $languages) use ($state): void {
            if (!RuntimeEngineService::featuresRun($state->features, $languages)) throw new \RuntimeException('Synthetic Python feature unavailable');
        });
        $engines->method('ownerPolicy')->willReturnCallback(static fn() => $state->policy + ['installed' => $state->installed]);
        $engines->method('assertTorchAllowed')->willReturnCallback(static function () use ($state): void {
            if ($state->torchRefused) throw new \RuntimeException('This app uses torch, which this site does not allow.', 403);
        });
        $controller = new HostedAppController(
            $apps, $users, $this->observeHostedService(HostedAppService::class, $hosting),
            $this->observeHostedService(RuntimeEngineService::class, $engines),
            $this->createMock(AuditService::class), $this->createMock(NativeAppService::class),
        );
        return [$controller, $state];
    }

    private static function decision(object $state, ?array $languages = null): array
    {
        return RuntimeEngineService::resolve($state->stored, $state->policy, $state->installed, $state->owner, $languages ?? RuntimeEngineService::languagesOf($state->deployment['client']));
    }

    private function request(object $state, string $method = 'GET', string $surface = 'runtime', array $headers = [], ?array $body = null, string $user = 'owner-a'): ServerRequestInterface
    {
        $path = $surface === 'manage' ? '/api/apps/engine-app/hosting' : '/api/app/engine-fixture/' . ($method === 'POST' ? 'actions/noop' : 'hosting');
        return HostedControllerRequest::create($method, $path, $user, $state->app, $user === 'owner-a' ? null : $state->member, $body, $headers);
    }

    private function call(HostedAppController $controller, ServerRequestInterface $request, string $surface = 'runtime'): ResponseInterface
    {
        return $surface === 'manage' ? $controller->manage($request, new Response(), ['id' => 'engine-app'])
            : $controller->runtime($request, new Response(), ['slug' => 'engine-fixture', 'action' => 'noop']);
    }

    private function body(ResponseInterface $response, int $status = 200): array
    {
        self::assertSame($status, $response->getStatusCode());
        self::assertSame('no-store', $response->getHeaderLine('Cache-Control'));
        self::assertSame('nosniff', $response->getHeaderLine('X-Content-Type-Options'));
        return json_decode((string) $response->getBody(), true, 64, JSON_THROW_ON_ERROR);
    }

    private static function engineHeader(object $state): array
    {
        $decision = self::decision($state);
        return ['X-FormLogic-Client-Engine' => $decision['id'] . ';' . $decision['revision']];
    }

    public function testTheManageGetCarriesTheChoiceTheOutcomeAndTheChoosableEngines(): void
    {
        [$controller, $state] = $this->fixture();
        $body = $this->body($this->call($controller, $this->request($state, 'GET', 'manage'), 'manage'));
        self::assertSame(self::decision($state), $body['engine']);
        self::assertSame($state->policy['allowed'], $body['enginePolicy']['allowed']);
        $this->assertHostedServiceCalls(RuntimeEngineService::class, 'effective', 1);
        $this->assertHostedServiceCalls(RuntimeEngineService::class, 'ownerPolicy', 1);
        $this->assertHostedServiceCalls(HostedAppService::class, 'get', 1);
        $this->assertHostedServiceCalls(HostedAppService::class, 'run', 0);
    }

    public function testTheRuntimeGetCarriesTheEngineAndItsRevisionAndStaysNoStore(): void
    {
        [$controller, $state] = $this->fixture();
        $body = $this->body($this->call($controller, $this->request($state)));
        self::assertSame(['id' => self::decision($state)['id'], 'revision' => self::decision($state)['revision']], $body['engine']);
        self::assertSame(HostedControllerRequest::SESSION, $body['actor']['sessionId']);
        $this->assertHostedServiceCalls(RuntimeEngineService::class, 'effective', 1);
        $this->assertHostedServiceCalls(RuntimeEngineService::class, 'assertInstalledRuns', 1);
        $this->assertHostedServiceCalls(RuntimeEngineService::class, 'assertTorchAllowed', 1);
        $this->assertHostedServiceCalls(HostedAppService::class, 'get', 1);
        $this->assertHostedServiceCalls(HostedAppService::class, 'run', 0);
    }

    public function testAnAppRefusedForTorchSaysSoAndIsNotCalledUnavailable(): void
    {
        [$controller, $state] = $this->fixture();
        $state->torchRefused = true;
        $body = $this->body($this->call($controller, $this->request($state)), 403);
        self::assertSame('This app uses torch, which this site does not allow.', $body['message']);
        self::assertSame(HostedControllerRequest::SESSION, $body['actor']['sessionId']);
        $this->assertHostedServiceCalls(HostedAppService::class, 'run', 0);
    }

    public function testAnActionWithNoEngineHeaderIsAnsweredAsBefore(): void
    {
        [$controller, $state] = $this->fixture();
        $input = ['stableId' => 'synthetic-retry'];
        $request = $this->request($state, 'POST', body: $input);
        self::assertFalse($request->hasHeader('X-FormLogic-Client-Engine'));
        self::assertSame(1, $this->body($this->call($controller, $request))['result']);
        self::assertSame([['engine-app', 'noop', $input, 'owner-a', true]], $state->runArguments);
        $this->assertHostedServiceCalls(RuntimeEngineService::class, 'effective', 0);
        $this->assertHostedServiceCalls(HostedAppService::class, 'run', 1);
    }

    public function testAMatchingEngineHeaderIsAccepted(): void
    {
        [$controller, $state] = $this->fixture();
        self::assertSame(1, $this->body($this->call($controller, $this->request($state, 'POST', headers: self::engineHeader($state), body: [])))['result']);
        $this->assertHostedServiceCalls(RuntimeEngineService::class, 'effective', 1);
        $this->assertHostedServiceCalls(HostedAppService::class, 'run', 1);
    }

    public function testAStaleEngineHeaderAnswers409EngineChanged(): void
    {
        [$controller, $state] = $this->fixture();
        foreach (['host-js;' . self::decision($state)['revision'], 'zipp-web-python;' . str_repeat('0', 16)] as $header) {
            $body = $this->body($this->call($controller, $this->request($state, 'POST', headers: ['X-FormLogic-Client-Engine' => $header], body: [])), 409);
            self::assertSame('engine_changed', $body['code']);
        }
        $this->assertHostedServiceCalls(RuntimeEngineService::class, 'effective', 2);
        $this->assertHostedServiceCalls(HostedAppService::class, 'run', 0);
    }

    public function testAPolicyChangeMovesTheRevisionSoAPageIsToldToRemount(): void
    {
        [$controller, $state] = $this->fixture();
        $old = self::engineHeader($state);
        $state->policy['revision']++;
        self::assertNotSame($old, self::engineHeader($state));
        $body = $this->body($this->call($controller, $this->request($state, 'POST', headers: $old, body: [])), 409);
        self::assertSame('engine_changed', $body['code']);
        $this->assertHostedServiceCalls(RuntimeEngineService::class, 'effective', 1);
        $this->assertHostedServiceCalls(HostedAppService::class, 'run', 0);
    }

    public function testAPythonAppRunsOnWebPythonEvenWhenItsOwnerChoseHostJavaScript(): void
    {
        [$controller, $state] = $this->fixture();
        $state->stored = 'host-js';
        $state->deployment['client']['logic/main.py'] = "count = 0\n";
        self::assertSame('host-js', self::decision($state, [])['id']);
        self::assertSame('zipp-web-python', $this->body($this->call($controller, $this->request($state)))['engine']['id']);
        $owner = $this->body($this->call($controller, $this->request($state, 'GET', 'manage'), 'manage'))['engine'];
        self::assertSame('python-required', $owner['reason']);
        self::assertSame('host-js', $owner['stored']);
        $this->assertHostedServiceCalls(RuntimeEngineService::class, 'effective', 2);
        $this->assertHostedServiceCalls(RuntimeEngineService::class, 'ownerPolicy', 1);
        $this->assertHostedServiceCalls(HostedAppService::class, 'run', 0);
    }

    public function testAPythonAppRunsOnWebPythonEvenWhereTheSiteDefaultIsTheJavaScriptOnlyBuild(): void
    {
        [$controller, $state] = $this->fixture();
        $state->policy['default'] = 'zipp-web';
        self::assertSame('zipp-web', $this->body($this->call($controller, $this->request($state)))['engine']['id']);
        $state->deployment['client']['logic/main.py'] = "count = 0\n";
        self::assertSame('zipp-web-python', $this->body($this->call($controller, $this->request($state)))['engine']['id']);
        $this->assertHostedServiceCalls(RuntimeEngineService::class, 'effective', 2);
        $this->assertHostedServiceCalls(RuntimeEngineService::class, 'assertInstalledRuns', 2);
        $this->assertHostedServiceCalls(HostedAppService::class, 'run', 0);
    }

    public function testTheInstalledRuntimeServesAJavaScriptAppTheWebVariantAndClampsAPythonAppOntoWebPython(): void
    {
        // The install record is synthetic here; the original installed-runtime
        // branch remains unrun. Exercise the same five admitted controller calls.
        [$controller, $state] = $this->fixture();
        $state->policy['default'] = 'zipp-web';
        self::assertSame('zipp-web', $this->body($this->call($controller, $this->request($state)))['engine']['id']);
        self::assertSame('zipp-web', $this->body($this->call($controller, $this->request($state, 'GET', 'manage'), 'manage'))['engine']['id']);
        self::assertContains('zipp-web', $this->body($this->call($controller, $this->request($state, 'GET', 'manage'), 'manage'))['enginePolicy']['installed']);
        $state->deployment['client']['logic/main.py'] = "count = 0\n";
        self::assertSame('zipp-web-python', $this->body($this->call($controller, $this->request($state)))['engine']['id']);
        self::assertSame('python-required', $this->body($this->call($controller, $this->request($state, 'GET', 'manage'), 'manage'))['engine']['reason']);
        $this->assertHostedServiceCalls(RuntimeEngineService::class, 'effective', 5);
        $this->assertHostedServiceCalls(RuntimeEngineService::class, 'ownerPolicy', 3);
        $this->assertHostedServiceCalls(HostedAppService::class, 'run', 0);
    }

    public function testAnActionFromAClampedPythonFrameIsNotToldTheEngineChanged(): void
    {
        [$controller, $state] = $this->fixture();
        $state->stored = 'host-js';
        $state->deployment['client']['logic/main.py'] = "count = 0\n";
        $mounted = $this->body($this->call($controller, $this->request($state)))['engine'];
        self::assertSame('zipp-web-python', $mounted['id']);
        self::assertSame(1, $this->body($this->call($controller, $this->request($state, 'POST', headers: ['X-FormLogic-Client-Engine' => $mounted['id'] . ';' . $mounted['revision']], body: [])))['result']);
        self::assertSame([['javascript', 'python'], ['javascript', 'python']], $state->resolverLanguages);
        $this->assertHostedServiceCalls(RuntimeEngineService::class, 'effective', 2);
        $this->assertHostedServiceCalls(HostedAppService::class, 'run', 1);
    }

    public function testAnInstallThatDoesNotAdvertiseThePythonContractServesNoPythonAppAtAll(): void
    {
        [$controller, $state] = $this->fixture();
        $state->features = [];
        $this->body($this->call($controller, $this->request($state)));
        $state->deployment['client']['logic/main.py'] = "count = 0\n";
        $body = $this->body($this->call($controller, $this->request($state)), 503);
        self::assertSame('App hosting is temporarily unavailable', $body['message']);
        self::assertArrayNotHasKey('code', $body);
        self::assertArrayNotHasKey('deployment', $body);
        $this->assertHostedServiceCalls(RuntimeEngineService::class, 'assertInstalledRuns', 2);
        $this->assertHostedServiceCalls(RuntimeEngineService::class, 'effective', 1);
        $this->assertHostedServiceCalls(HostedAppService::class, 'run', 0);
    }

    public function testTheManagePutCarriesTheEngineDecidedFromTheBundleJustPublished(): void
    {
        [$controller, $state] = $this->fixture();
        $state->stored = 'host-js';
        $client = $state->deployment['client'] + ['logic/main.py' => "count = 0\n"];
        $body = $this->body($this->call($controller, $this->request($state, 'PUT', 'manage', body: ['expectedVersion' => 1, 'package' => ['client' => $client]]), 'manage'));
        self::assertSame(2, $body['deployment']['version']);
        self::assertSame('zipp-web-python', $body['engine']['id']);
        self::assertSame('python-required', $body['engine']['reason']);
        self::assertSame($body['engine'], $this->body($this->call($controller, $this->request($state, 'GET', 'manage'), 'manage'))['engine']);
        $this->assertHostedServiceCalls(RuntimeEngineService::class, 'effective', 2);
        $this->assertHostedServiceCalls(HostedAppService::class, 'publish', 1);
        $this->assertHostedServiceCalls(HostedAppService::class, 'run', 0);
    }

    public function testAResolverThatCannotAnswerTheStaleCheckIsTheGeneric503EveryOtherFailureIs(): void
    {
        [$controller, $state] = $this->fixture();
        $state->resolverFailure = true;
        $body = $this->body($this->call($controller, $this->request($state, 'POST', headers: self::engineHeader($state), body: [])), 503);
        self::assertSame('App hosting is temporarily unavailable', $body['message']);
        self::assertArrayNotHasKey('code', $body);
        self::assertSame(HostedControllerRequest::SESSION, $body['actor']['sessionId']);
        $this->assertHostedServiceCalls(RuntimeEngineService::class, 'effective', 1);
        $this->assertHostedServiceCalls(HostedAppService::class, 'run', 0);
    }

    public function testTheSharedBuilderDerivesMemberAdmissionWithoutPromotingBodyClaims(): void
    {
        [$controller, $state] = $this->fixture();
        $request = $this->request($state, 'POST', body: ['userId' => 'owner-a', 'isOwner' => true], user: 'member-a');
        $actor = json_decode($request->getHeaderLine(HostedActorContext::HEADER), true, 64, JSON_THROW_ON_ERROR);
        self::assertSame(['version' => 1, 'appId' => 'engine-app', 'userId' => 'member-a', 'roleId' => 'member-role', 'isOwner' => false, 'sessionId' => HostedControllerRequest::SESSION], $actor);
        self::assertSame($actor, $this->body($this->call($controller, $request))['actor']);
        self::assertSame('member-a', $state->runArguments[0][3]);
        self::assertFalse($state->runArguments[0][4]);
        $this->assertHostedServiceCalls(RuntimeEngineService::class, 'effective', 0);
        $this->assertHostedServiceCalls(HostedAppService::class, 'run', 1);
    }

    public function testSharedBuilderDoesNotAddActionAdmissionToOtherRoutes(): void
    {
        [$controller, $state] = $this->fixture();
        foreach ([['GET', 'runtime'], ['GET', 'manage'], ['PUT', 'manage']] as [$method, $surface]) {
            $request = $this->request($state, $method, $surface);
            self::assertFalse($request->hasHeader(HostedActorContext::HEADER));
            self::assertSame(HostedControllerRequest::SESSION, $request->getAttribute(HostedActorContext::SESSION_ATTRIBUTE));
        }
    }

    public function testAdmissionOmissionAndMismatchStillFailBeforeResolverOrAction(): void
    {
        [$controller, $state] = $this->fixture();
        $valid = $this->request($state, 'POST', headers: self::engineHeader($state), body: []);
        $actor = json_decode($valid->getHeaderLine(HostedActorContext::HEADER), true, 64, JSON_THROW_ON_ERROR);
        foreach ([
            [$valid->withoutAttribute(HostedActorContext::SESSION_ATTRIBUTE), 503, 'actor_context_unavailable'],
            [$valid->withoutHeader(HostedActorContext::HEADER), 409, 'actor_context_required'],
            [$valid->withAttribute(HostedActorContext::SESSION_ATTRIBUTE, str_repeat('d', 64)), 409, 'actor_changed'],
            [$valid->withHeader(HostedActorContext::HEADER, json_encode(array_replace($actor, ['userId' => 'other-user']))), 409, 'actor_changed'],
        ] as [$request, $status, $code]) {
            self::assertSame($code, $this->body($this->call($controller, $request), $status)['code']);
        }
        $this->assertHostedServiceCalls(RuntimeEngineService::class, 'effective', 0);
        $this->assertHostedServiceCalls(HostedAppService::class, 'run', 0);
        self::assertSame([], $state->runArguments);
    }
}
