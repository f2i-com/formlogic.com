<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\NativeAppService;
use PHPUnit\Framework\TestCase;
use RuntimeException;

/**
 * One app's requests cannot take every native worker. A worker is held for a whole request, and a
 * slow query lasts about twenty seconds, so four of them used to turn every other app away.
 */
final class NativeWorkerShareTest extends TestCase
{
    private string $storage = '';

    protected function setUp(): void
    {
        $this->storage = sys_get_temp_dir() . '/fl-worker-share-' . bin2hex(random_bytes(4));
        mkdir($this->storage . '/.runtime-slots', 0700, true);
    }

    protected function tearDown(): void
    {
        unset($_ENV['NATIVE_WORKERS_PER_APP'], $_ENV['NATIVE_WORKERS'], $_ENV['NATIVE_WORKERS_PER_OWNER']);
        $this->remove($this->storage);
    }

    /** The folder an app is kept in, as the service names it. */
    private static function root(string $appId): string
    {
        return hash('sha256', $appId);
    }

    /** The lock names of an account's share, as the service names them. */
    private static function shareOf(string $account, int ...$places): array
    {
        return array_map(static fn (int $place): string => 'owner-' . substr(hash('sha256', $account), 0, 32) . '-' . $place, $places);
    }

    /** Whoever serves these apps says whose they are, as a controller does before it asks for a worker. */
    private function owns(string $account, string ...$appIds): void
    {
        $service = new NativeAppService($this->storage);
        foreach ($appIds as $appId) {
            $service->ownedBy($appId, $account);
        }
    }

    private function remove(string $dir): void
    {
        foreach (scandir($dir) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $path = $dir . '/' . $entry;
            is_dir($path) ? $this->remove($path) : @unlink($path);
        }
        @rmdir($dir);
    }

    /** @return list<resource> */
    private function hold(string ...$names): array
    {
        $held = [];
        foreach ($names as $name) {
            $lock = fopen($this->storage . '/.runtime-slots/' . $name . '.lock', 'c');
            self::assertTrue(flock($lock, LOCK_EX | LOCK_NB));
            $held[] = $lock;
        }
        return $held;
    }

    /** A request as far as the workers: it has none, or it goes on and fails on the fake runtime. */
    private function refusedAsBusy(string $appRoot): bool
    {
        $runtime = $this->storage . '/runtime';
        @mkdir($runtime);
        file_put_contents($runtime . '/host-protocol.json', '{}');
        @mkdir($this->storage . '/' . $appRoot . '/private', 0700, true);
        $service = new NativeAppService($this->storage, $runtime, PHP_BINARY);
        $invoke = new \ReflectionMethod($service, 'invoke');
        try {
            $invoke->invoke($service, $this->storage . '/' . $appRoot, ['method' => 'GET', 'path' => '/api/x']);
        } catch (RuntimeException $e) {
            return $e->getCode() === 429;
        }
        return false;
    }

    public function testAnAppHoldingItsShareWaitsWhileOthersRun(): void
    {
        $held = $this->hold('app-a-0', 'app-a-1', '0', '1');
        self::assertTrue($this->refusedAsBusy('app-a'), 'A third request of app A has to wait its turn');
        self::assertFalse($this->refusedAsBusy('app-b'), 'and app B still gets one of the two left');
        unset($held);
    }

    public function testASiteWithOneBusyAppCanGiveItMore(): void
    {
        $_ENV['NATIVE_WORKERS_PER_APP'] = '4';
        $held = $this->hold('app-a-0', 'app-a-1', 'app-a-2', '0', '1', '2');
        self::assertFalse($this->refusedAsBusy('app-a'), 'A fourth request of app A gets the last worker');
        unset($held);
    }

    public function testTheShareCannotPassTheWorkersThereAre(): void
    {
        $_ENV['NATIVE_WORKERS_PER_APP'] = '50';
        $held = $this->hold('app-a-0', 'app-a-1', 'app-a-2', 'app-a-3');
        self::assertTrue($this->refusedAsBusy('app-a'), 'Four is the most an app can hold, whatever the setting says');
        unset($held);
    }

    /**
     * Four workers was a constant, and the share is each app's: two apps of one account hold all
     * four, and every other app on the site was answered busy. A site that hosts apps for many
     * accounts says how many its server runs at once.
     */
    public function testASiteCanRunMoreWorkersThanFour(): void
    {
        $held = $this->hold('app-a-0', 'app-a-1', 'app-b-0', 'app-b-1', '0', '1', '2', '3');
        self::assertTrue($this->refusedAsBusy('app-c'), 'With four workers, two busy apps leave none');

        $_ENV['NATIVE_WORKERS'] = '6';
        self::assertFalse($this->refusedAsBusy('app-c'), 'With six, a third app is served');
        // And an app's share can then be more than four, up to the workers there are.
        $_ENV['NATIVE_WORKERS_PER_APP'] = '50';
        $more = $this->hold('app-d-0', 'app-d-1', 'app-d-2', 'app-d-3', '4');
        self::assertFalse($this->refusedAsBusy('app-d'), 'A fifth request of one app gets the sixth worker');
        unset($held, $more);
    }

    public function testAnUnusableNumberOfWorkersLeavesFour(): void
    {
        foreach (['0', '-3', 'many'] as $value) {
            $_ENV['NATIVE_WORKERS'] = $value;
            $held = $this->hold('0', '1', '2', '3');
            self::assertTrue($this->refusedAsBusy('app-a'), "NATIVE_WORKERS=$value: four, as if it were not set");
            unset($held);
        }
    }

    /** @dataProvider unusableShares */
    public function testAnUnusableSettingLeavesTheDefault(string $value): void
    {
        $_ENV['NATIVE_WORKERS_PER_APP'] = $value;
        $held = $this->hold('app-a-0', 'app-a-1');
        self::assertTrue($this->refusedAsBusy('app-a'), 'Two, as if it were not set');
        unset($held);
    }

    /** @return array<string, array{0: string}> */
    public static function unusableShares(): array
    {
        return ['zero' => ['0'], 'negative' => ['-1'], 'words' => ['lots']];
    }

    public function testEveryWorkerBusyTurnsAnAppAway(): void
    {
        $held = $this->hold('0', '1', '2', '3');
        self::assertTrue($this->refusedAsBusy('app-a'));
        unset($held);
    }

    /**
     * The share above is each app's, so two apps of one account held every worker between them and
     * every other account's apps were answered busy. An account has a share of its own: all but one
     * of the site's workers, unless the site says otherwise.
     */
    public function testOneAccountsAppsLeaveAWorkerForAnotherAccount(): void
    {
        [$first, $second, $other] = [self::root('shop'), self::root('blog'), self::root('someone-elses')];
        $this->owns('account-1', 'shop', 'blog');
        $this->owns('account-2', 'someone-elses');
        // Two requests of one app and one of the other: three of the four workers, the account's share.
        $held = $this->hold($first . '-0', $first . '-1', $second . '-0', '0', '1', '2', ...self::shareOf('account-1', 0, 1, 2));

        self::assertTrue($this->refusedAsBusy($second), 'A fourth request of the account waits, though its app has a place and a worker is free');
        foreach ([$second . '-1', '3'] as $free) {
            $lock = fopen($this->storage . '/.runtime-slots/' . $free . '.lock', 'c');
            self::assertTrue(flock($lock, LOCK_EX | LOCK_NB), "$free must not stay taken after the refusal");
            fclose($lock);
        }
        self::assertFalse($this->refusedAsBusy($other), 'and another account\'s app gets the worker that was left');
        unset($held);
    }

    public function testASiteSaysHowManyWorkersOneAccountMayHold(): void
    {
        [$first, $second, $third] = [self::root('shop'), self::root('blog'), self::root('wiki')];
        $this->owns('account-1', 'shop', 'blog', 'wiki');

        $_ENV['NATIVE_WORKERS_PER_OWNER'] = '2';
        $held = $this->hold($first . '-0', $second . '-0', '0', '1', ...self::shareOf('account-1', 0, 1));
        self::assertTrue($this->refusedAsBusy($third), 'Two is the account\'s share now, whichever of its apps asks');
        unset($held);

        // 0: a site that hosts one account's apps keeps no share for it, and the apps' own shares are all there is.
        $_ENV['NATIVE_WORKERS_PER_OWNER'] = '0';
        $held = $this->hold($first . '-0', $first . '-1', $second . '-0', '0', '1', '2', ...self::shareOf('account-1', 0, 1, 2));
        self::assertFalse($this->refusedAsBusy($second), 'The account takes the fourth worker too');
        unset($held);

        // More than the workers there are is every worker: nothing is counted.
        $_ENV['NATIVE_WORKERS_PER_OWNER'] = '50';
        $held = $this->hold($first . '-0', $first . '-1', $second . '-0', '0', '1', '2', ...self::shareOf('account-1', 0, 1, 2));
        self::assertFalse($this->refusedAsBusy($second));
        unset($held);
    }

    public function testTheAccountsShareFollowsTheWorkersThereAre(): void
    {
        [$first, $second] = [self::root('shop'), self::root('blog')];
        $this->owns('account-1', 'shop', 'blog');

        // Two workers: one for the account, one always left.
        $_ENV['NATIVE_WORKERS'] = '2';
        $held = $this->hold($first . '-0', '0', ...self::shareOf('account-1', 0));
        self::assertTrue($this->refusedAsBusy($second), 'With two workers an account holds one');
        unset($held);

        // One worker: there is none to leave, so no account is held to a share.
        $_ENV['NATIVE_WORKERS'] = '1';
        $held = $this->hold($first . '-0', ...self::shareOf('account-1', 0));
        self::assertFalse($this->refusedAsBusy($second), 'With one worker the account\'s other app takes it when it is free');
        unset($held);

        // A setting that is no number leaves the default, all but one.
        $_ENV['NATIVE_WORKERS'] = '4';
        foreach (['-1', 'lots'] as $value) {
            $_ENV['NATIVE_WORKERS_PER_OWNER'] = $value;
            $held = $this->hold($first . '-0', $first . '-1', $second . '-0', '0', '1', '2', ...self::shareOf('account-1', 0, 1, 2));
            self::assertTrue($this->refusedAsBusy($second), "NATIVE_WORKERS_PER_OWNER=$value: three, as if it were not set");
            unset($held);
        }
    }

    public function testAnAppIsCountedForTheAccountItWasLastSaidToBelongTo(): void
    {
        $app = self::root('shop');
        $this->owns('account-1', 'shop');
        $this->owns('account-2', 'shop');
        // The first account's share is full, and is no longer this app's to wait on.
        $held = $this->hold('0', '1', '2', ...self::shareOf('account-1', 0, 1, 2));
        self::assertFalse($this->refusedAsBusy($app));
        unset($held);
        $held = $this->hold('0', '1', '2', ...self::shareOf('account-2', 0, 1, 2));
        self::assertTrue($this->refusedAsBusy($app));
        unset($held);
        // An app nobody has named an owner for is held to its own share and the site's, as before.
        $held = $this->hold('0', '1', '2');
        self::assertFalse($this->refusedAsBusy(self::root('unnamed')));
        unset($held);
    }

    public function testAFailedTurnGivesItsAppShareBack(): void
    {
        $held = $this->hold('0', '1', '2', '3');
        self::assertTrue($this->refusedAsBusy('app-a'));
        $free = fopen($this->storage . '/.runtime-slots/app-a-0.lock', 'c');
        self::assertTrue(flock($free, LOCK_EX | LOCK_NB), 'The share must not stay taken after a refusal');
        unset($held);
    }
}
