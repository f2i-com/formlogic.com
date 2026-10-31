<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\FlowController;
use FormLogic\Services\AppCompositionService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FlowKvService;
use FormLogic\Services\NativeAppService;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/** What reaches an app's members, and the state that belongs to an app. */
final class AccessLimitsTest extends E2eeTestCase
{
    private function anApp(): array
    {
        $app = self::$apps->createApp(['name' => 'App ' . bin2hex(random_bytes(3))], $this->userId);
        self::$pdo->prepare("UPDATE apps SET status = 'published' WHERE id = ?")->execute([$app['id']]);
        return self::$apps->getApp((string) $app['id']);
    }

    private function aForm(): string
    {
        return (string) self::$forms->createForm([
            'title' => 'Form', 'userId' => $this->userId, 'status' => 'published',
            'fields' => [['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false]],
        ])['id'];
    }

    public function testAFormTakenOutOfAnAppStopsFeedingItsQueue(): void
    {
        $app = $this->anApp();
        $appId = (string) $app['id'];
        $formId = $this->aForm();
        self::$apps->addFormToApp($appId, $formId);
        self::$flows->createFlow($appId, $this->userId, ['name' => 'On submit', 'slug' => 'on-submit']);
        self::$flows->createBinding($appId, ['flow' => 'on-submit', 'event' => 'form.submitted', 'mode' => 'async', 'formId' => $formId]);

        $this->assertSame(1, self::$flows->enqueueSubmissionBindings($formId, 'r1', ['name' => 'x']));
        self::$apps->removeFormFromApp($appId, $formId);
        $this->assertSame(0, self::$flows->enqueueSubmissionBindings($formId, 'r2', ['name' => 'x']));
        self::$apps->addFormToApp($appId, $formId);
        $this->assertSame(1, self::$flows->enqueueSubmissionBindings($formId, 'r3', ['name' => 'x']), 'and it picks up again if the form comes back');
    }

    public function testAMembersQueueReadsPastRunsTheyMayNotSee(): void
    {
        $app = $this->anApp();
        $appId = (string) $app['id'];
        $hidden = $this->aForm();
        $visible = $this->aForm();
        $flow = self::$flows->createFlow($appId, $this->userId, ['name' => 'Queue', 'slug' => 'queue']);
        foreach (array_merge(array_fill(0, 201, $hidden), [$visible]) as $i => $formId) {
            self::$flows->enqueueRun($flow, ['triggerEvent' => 'manual', 'correlationId' => "c{$i}", 'idempotencyKey' => "queue-{$i}", 'inputSnapshot' => [], 'formId' => $formId]);
        }
        $users = $this->createMock(AppUserService::class);
        $users->method('getAppUser')->willReturn(['status' => 'active']);
        $users->method('hasPermission')->willReturnCallback(static fn (string $a, string $u, string $p, ?string $f = null): bool => $p === 'execute_flows' || $f === $visible);

        $request = (new ServerRequestFactory())->createServerRequest('GET', 'http://localhost/x')->withAttribute('userId', 'a-member');
        $response = (new FlowController(self::$flows, self::$apps, $users))->queuedRuns($request, (new ResponseFactory())->createResponse(), ['slug' => $app['slug']]);
        $response->getBody()->rewind();
        $runs = json_decode((string) $response->getBody(), true)['runs'];

        $this->assertCount(1, $runs);
        $this->assertSame($visible, $runs[0]['formId']);
    }

    public function testFlowStorageGoesWithTheFlowsAndThenWithTheApp(): void
    {
        $source = $this->anApp();
        $target = $this->anApp();
        $formId = $this->aForm();
        self::$apps->addFormToApp((string) $source['id'], $formId);
        self::$flows->createFlow((string) $source['id'], $this->userId, ['name' => 'Counter', 'slug' => 'counter']);
        $kv = new FlowKvService(self::$mysql);
        $kv->put($this->userId, (string) $source['id'], 'app', 'count', 7);
        $kv->put($this->userId, (string) $source['id'], 'app', 'shared', 'from-source');
        $kv->put($this->userId, (string) $target['id'], 'app', 'shared', 'from-target');

        (new AppCompositionService(self::$mysql, self::$apps, self::$forms))->compose($this->userId, (string) $source['id'], (string) $target['id'], [$formId], true);

        $this->assertSame(7, $kv->get($this->userId, (string) $target['id'], 'app', 'count')['v']);
        $this->assertSame('from-target', $kv->get($this->userId, (string) $target['id'], 'app', 'shared')['v'], 'what is there stays');
    }

    public function testAnUpdateTurnsNewRequestsAwayAndAStaleMarkerDoesNot(): void
    {
        $root = self::$tmpRoot . '/native-' . bin2hex(random_bytes(4));
        mkdir($root . '/private', 0777, true);
        $native = (new \ReflectionClass(NativeAppService::class))->newInstanceWithoutConstructor();
        $shared = new \ReflectionMethod($native, 'sharedLock');
        $exclusive = new \ReflectionMethod($native, 'exclusiveLock');
        $pending = $root . '/private/update.pending';

        touch($pending);
        try {
            $shared->invoke($native, $root);
            $this->fail('a new request went in ahead of the update');
        } catch (\RuntimeException $e) {
            $this->assertSame(409, $e->getCode());
        }
        touch($pending, time() - 3600);
        $held = $shared->invoke($native, $root);
        $this->assertIsResource($held, 'left by a crash, it stops counting');
        fclose($held);
        unlink($pending);

        $lock = $exclusive->invoke($native, $root, 'busy', true);
        $this->assertIsResource($lock);
        $this->assertFileDoesNotExist($pending);
        fclose($lock);
    }
}
