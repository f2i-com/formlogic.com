<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\DesktopAiRelayService;
use FormLogic\Services\SiteAiBusyException;
use FormLogic\Services\SiteAiDesktopSettings;
use FormLogic\Services\SiteDesktopAi;
use FormLogic\Tests\Support\InMemoryAiRelay;
use FormLogic\Tests\Support\LinkedComputers;
use PHPUnit\Framework\TestCase;

/**
 * How the server reads the sealed lane it sends turns down (SiteDesktopAi): an answer read whole,
 * a lost frame costing its own words only, a turn nobody waits for stopped on the computer too
 * (however the request ended), each computer's lane counted under its lock, a listing asked and
 * read back without a PHP worker waiting on it, and refusals that name whose computer it is. The
 * lane is held in memory (InMemoryAiRelay); the computers, in SQLite (LinkedComputers).
 */
final class SiteDesktopAiLaneTest extends TestCase
{
    private const SECRET = 'site-desktop-ai-lane-test-secret-0123456789';

    private LinkedComputers $computers;
    private InMemoryAiRelay $relay;
    private SiteAiDesktopSettings $settings;
    private string $settingsPath = '';
    private string $desktopSecret = '';
    private string $admin = '';
    private string $member = '';
    private string $connection = '';

    protected function setUp(): void
    {
        $keys = sodium_crypto_box_keypair();
        $this->desktopSecret = sodium_crypto_box_secretkey($keys);
        $this->computers = new LinkedComputers();
        $this->admin = $this->computers->user('u-admin', true);
        $this->member = $this->computers->user('u-member');
        $this->connection = $this->computers->link($this->admin, 'inst-site-ai', base64_encode(sodium_crypto_box_publickey($keys)));
        $this->settingsPath = sys_get_temp_dir() . '/site-ai-lane-' . bin2hex(random_bytes(6)) . '.json';
        $this->settings = new SiteAiDesktopSettings($this->computers, $this->settingsPath);
        $this->relay = new InMemoryAiRelay();
    }

    protected function tearDown(): void
    {
        @unlink($this->settingsPath);
    }

    /** The site's AI on the administrator's computer, whose wait plays that computer once: it claims the turn, then $answer($id, $turn, $pair). */
    private function site(?\Closure $answer = null): SiteDesktopAi
    {
        $this->settings->choose($this->admin, $this->connection);
        $played = false;
        return new SiteDesktopAi($this->relay, $this->settings, function () use (&$played, $answer): void {
            if ($played || $answer === null) {
                return;
            }
            $played = true;
            $id = $this->relay->newest();
            [$turn, $pair] = $this->relay->claimAs($id, $this->desktopSecret);
            $answer($id, $turn, $pair);
        }, self::SECRET);
    }

    /** A SiteDesktopAi that must never wait: a listing answers at once, whatever the computer does. */
    private function listings(): SiteDesktopAi
    {
        return new SiteDesktopAi($this->relay, $this->settings, static function (): void {
            throw new \LogicException('a listing never waits for the computer');
        }, self::SECRET);
    }

    private const SAY_HELLO = [['role' => 'user', 'content' => 'Say hello.']];

    // ------------------------------------------------------------------ reading an answer

    public function testAFrameLostOnTheWayCostsItsOwnWordsNotTheWholeAnswer(): void
    {
        $answer = $this->site(function (string $id, array $turn, string $pair): void {
            $this->relay->answer($id, ['v' => 1, 'kind' => 'delta', 'delta' => 'Hel'], 0, $pair);
            // OAIY sealed counter 1, its post failed, and it went on with 2 (its tunnel logs the gap).
            $this->relay->answer($id, ['v' => 1, 'kind' => 'delta', 'delta' => 'lo'], 2, $pair);
            $this->relay->answer($id, ['v' => 1, 'kind' => 'final'], 3, $pair);
            $this->relay->finish($id);
        })->chat(self::SAY_HELLO, $this->member, null, null, 30);
        $this->assertSame('Hello', $answer['content']);
    }

    public function testAFrameFromTheComputerMustComeAfterTheLastAndFromIt(): void
    {
        $pair = sodium_crypto_box_keypair_from_secretkey_and_publickey(sodium_crypto_box_secretkey(sodium_crypto_box_keypair()), sodium_crypto_box_publickey(sodium_crypto_box_keypair()));
        $third = SiteDesktopAi::seal(['kind' => 'delta', 'delta' => 'x'], 1, 2, $pair);
        $this->assertSame(2, SiteDesktopAi::openAfter($third, 0, $pair)[0], 'a gap is taken');
        $this->assertSame(['kind' => 'delta', 'delta' => 'x'], SiteDesktopAi::openAfter($third, -1, $pair)[1]);
        foreach ([[$third, 2, 'the same counter again'], [$third, 5, 'a lower one'], [SiteDesktopAi::seal(['kind' => 'delta'], 0, 3, $pair), -1, 'the browser\'s own direction']] as [$frame, $last, $what]) {
            try {
                SiteDesktopAi::openAfter($frame, $last, $pair);
                $this->fail('opened: ' . $what);
            } catch (\RuntimeException $e) {
                $this->assertSame('OAIY sent a frame out of order.', $e->getMessage(), $what);
            }
        }
    }

    public function testAnAnswerOfMoreThanAPageIsReadWholeOnceItIsDone(): void
    {
        $answer = $this->site(function (string $id, array $turn, string $pair): void {
            for ($i = 0; $i < 250; $i++) {
                $this->relay->answer($id, ['v' => 1, 'kind' => 'delta', 'delta' => 'x'], $i, $pair);
            }
            // Done with no final frame: the status says it ended, and every frame is there to read.
            $this->relay->finish($id);
        })->chat(self::SAY_HELLO, $this->member, null, null, 30);
        $this->assertSame(str_repeat('x', 250), $answer['content']);
    }

    /** OAIY seals at most 256 KiB in a frame; the lane keeps up to 4 MiB for browsers. The server reads a page at a time, and no frame larger than OAIY's. */
    public function testTheServerReadsFewFramesAtATimeAndNoneLargerThanOaiySends(): void
    {
        $this->site(function (string $id, array $turn, string $pair): void {
            $this->relay->answer($id, ['v' => 1, 'kind' => 'final', 'text' => 'ok'], 0, $pair);
            $this->relay->finish($id);
        })->chat(self::SAY_HELLO, $this->member, null, null, 30);
        $asked = array_unique(array_map(static fn (array $f): string => $f[0] . '/' . $f[1], $this->relay->fetched), SORT_STRING);
        $this->assertSame(['32/' . SiteDesktopAi::MAX_FRAME_BYTES], array_values($asked));
        $this->assertSame(262144 + 24 + 16, SiteDesktopAi::MAX_FRAME_BYTES);

        $this->relay = new InMemoryAiRelay();
        try {
            $this->site(function (string $id): void {
                $this->relay->oversized($id);
                $this->relay->finish($id);
            })->chat(self::SAY_HELLO, $this->member, null, null, 30);
            $this->fail('a frame larger than OAIY sends was read');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('larger than any it sends', $e->getMessage());
        }
    }

    public function testAReaderThatHasEnoughTextStopsReadingTheRest(): void
    {
        $site = $this->site();
        [$id, $pair] = $site->send($this->settings->current(), ['kind' => 'chat', 'messages' => self::SAY_HELLO], $this->member);
        [, $desktopPair] = $this->relay->claimAs($id, $this->desktopSecret);
        for ($i = 0; $i < 10; $i++) {
            $this->relay->answer($id, ['v' => 1, 'kind' => 'delta', 'delta' => 'abc'], $i, $desktopPair);
        }
        $this->assertSame(str_repeat('abc', 10), $site->collect($id, $this->admin, $pair)['content']);
        $this->assertSame('abcabc', $site->collect($id, $this->admin, $pair, 5)['content'], 'stops once it has five bytes');
    }

    public function testCollectSaysWhetherTheComputerEverTookTheTurn(): void
    {
        $site = $this->site();
        [$id, $pair] = $site->send($this->settings->current(), ['kind' => 'chat', 'messages' => self::SAY_HELLO], $this->member);
        $this->relay->finish($id, 'expired');
        $this->assertSame(['expired', false], [$site->collect($id, $this->admin, $pair)['status'], $site->collect($id, $this->admin, $pair)['taken']], 'let go unclaimed: a busy or absent computer');
        [$other, $otherPair] = $site->send($this->settings->current(), ['kind' => 'chat', 'messages' => self::SAY_HELLO], $this->member);
        $this->relay->claimAs($other, $this->desktopSecret);
        $this->relay->finish($other, 'expired');
        $this->assertTrue($site->collect($other, $this->admin, $otherPair)['taken'], 'taken, then silent');
    }

    // ------------------------------------------------------------------ a turn nobody waits for

    public function testATurnTheReaderGivesUpOnIsCancelledOnTheComputerToo(): void
    {
        $this->settings->choose($this->admin, $this->connection);
        $site = new SiteDesktopAi($this->relay, $this->settings, function (): void {
            // The computer has taken the turn and is writing when the reader stops.
            $this->relay->claimAs($this->relay->newest(), $this->desktopSecret);
            throw new \RuntimeException('The reader stopped.');
        }, self::SECRET);
        try {
            $site->chat(self::SAY_HELLO, $this->member, null, null, 30);
            $this->fail('the reader stopped');
        } catch (\RuntimeException $e) {
            $this->assertSame('The reader stopped.', $e->getMessage());
        }
        $id = $this->relay->newest();
        $this->assertSame([$id], $this->relay->cancelled, 'cancelled, which reaches a turn being written, not only abandoned');
        $this->assertSame([], $this->relay->abandoned);
        $this->assertSame('expired', $this->relay->requests[$id]['status']);
    }

    public function testAListingTheReaderGivesUpOnIsCancelledToo(): void
    {
        $target = $this->settings->listingTarget($this->admin, $this->connection, null);
        $site = new SiteDesktopAi($this->relay, $this->settings, function (): void {
            $this->relay->claimAs($this->relay->newest(), $this->desktopSecret);
            throw new \RuntimeException('The reader stopped.');
        }, self::SECRET);
        try {
            $site->request($target, ['kind' => 'providers'], 20);
            $this->fail('the reader stopped');
        } catch (\RuntimeException) {
        }
        $this->assertSame([$this->relay->newest()], $this->relay->cancelled);
    }

    /** PHP stops a request whose page was closed at its next flush, and skips every `finally`: the turn is cancelled as it shuts down. */
    public function testATurnWhoseRequestEndsMidReadIsCancelledAsPhpShutsDown(): void
    {
        $script = dirname(__DIR__) . '/Support/site-desktop-ai-shutdown.php';
        $run = static function (string $how) use ($script): array {
            $process = proc_open([PHP_BINARY, '-d', 'xdebug.mode=off', $script, $how], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            $out = (string) stream_get_contents($pipes[1]);
            $err = (string) stream_get_contents($pipes[2]);
            proc_close($process);
            $said = json_decode($out, true);
            self::assertIsArray($said, $out . $err);
            return $said;
        };
        $stopped = $run('stops');
        $this->assertCount(1, $stopped['cancelled'], 'the turn being written is cancelled');
        $this->assertSame(['expired'], $stopped['statuses']);
        $finished = $run('finishes');
        $this->assertSame([], $finished['cancelled'], 'a turn read to its end is left as it ended');
        $this->assertSame(['done'], $finished['statuses']);
    }

    // ------------------------------------------------------------------ each computer's lanes

    public function testTheLanesCapIsCountedUnderTheLaneLockNotBeforeIt(): void
    {
        $site = $this->site();
        $target = $this->settings->current();
        $picture = ['kind' => 'image', 'prompt' => 'A kite', 'size' => '512x512', 'incognito' => true];
        $site->send($target, ['kind' => 'chat', 'messages' => self::SAY_HELLO], $this->member);
        $site->send($target, $picture, $this->admin, DesktopAiRelayService::SOURCE_APP_AI);
        $this->assertSame([SiteDesktopAi::MAX_WAITING, SiteDesktopAi::MAX_PICTURES_WAITING], array_column($this->relay->enqueued, 'laneCap'));
        // Counted before it was queued, the lane read as free (nothing is in flight by that count):
        // the cap holds because it is counted as the turn is queued.
        $this->relay->inFlight = 0;
        try {
            $site->send($target, $picture, $this->admin, DesktopAiRelayService::SOURCE_APP_AI);
            $this->fail('a second picture');
        } catch (SiteAiBusyException $e) {
            $this->assertSame('site_ai_busy', $e->reason);
        }
        $this->assertCount(2, $this->relay->requests);
    }

    public function testWhatIsRefusedNamesWhoseComputerItIs(): void
    {
        // The owner's own computer, asked for its list while it is off: that computer, not the site's AI.
        $own = $this->computers->link($this->member, 'inst-own', base64_encode(random_bytes(32)), false);
        $target = $this->settings->listingTarget($this->member, $own, null);
        foreach ([fn () => $this->listings()->listing($target, ['kind' => 'providers']), fn () => $this->listings()->send($target, ['kind' => 'image', 'prompt' => 'A kite'], $this->member, DesktopAiRelayService::SOURCE_APP_AI)] as $ask) {
            try {
                $ask();
                $this->fail('an offline computer');
            } catch (SiteAiBusyException $e) {
                $this->assertSame(['site_ai_offline', 'That computer is offline. Open OAIY on it, then try again.'], [$e->reason, $e->getMessage()]);
            }
        }
        // A member on the site's computer: the site's AI is what they use.
        $site = $this->site();
        $this->computers->goOffline($this->connection);
        try {
            $site->chat(self::SAY_HELLO, $this->member, null, null, 30);
            $this->fail('an offline computer');
        } catch (SiteAiBusyException $e) {
            $this->assertSame('The computer the site\'s AI runs on is offline. Try again later.', $e->getMessage());
        }
        $this->assertSame([], $this->relay->requests, 'nothing was queued for a computer that is off');
    }

    // ------------------------------------------------------------------ a computer's listings

    public function testAListingIsAskedThenReadBackWithoutWaitingAndWithoutKeepingAnything(): void
    {
        $target = $this->settings->listingTarget($this->admin, $this->connection, 'oaiy-engine');
        $handle = $this->listings()->listing($target, ['kind' => 'models']);
        $this->assertMatchesRegularExpression('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f]{32}$/D', $handle);
        [$id] = explode('.', $handle);
        $this->assertNull($this->listings()->listed($target, $handle), 'not taken yet');
        [$turn, $pair] = $this->relay->claimAs($id, $this->desktopSecret);
        $this->assertSame(['models', 'oaiy-engine'], [$turn['kind'], $turn['providerId']]);
        $this->assertNull($this->listings()->listed($target, $handle), 'taken, not answered');
        $models = [['id' => 'model-a', 'name' => 'Model A', 'type' => 'image'], ['id' => 'model-b', 'name' => 'Model B']];
        $this->relay->answer($id, ['v' => 1, 'kind' => 'models', 'models' => $models], 0, $pair);
        $this->relay->answer($id, ['v' => 1, 'kind' => 'final'], 1, $pair);
        $this->relay->finish($id);
        // Read by another SiteDesktopAi, as the next request is: the handle and the server's secret are all it takes.
        $this->assertSame($models, $this->listings()->listed($target, $handle)['models'] ?? null);
        $this->assertSame([$this->admin], array_values(array_unique($this->relay->readAs)), 'read as the computer\'s owner, and only as them');
    }

    public function testAListingIsReadOnlyByItsOwnerAndOnlyWithItsOwnToken(): void
    {
        $target = $this->settings->listingTarget($this->admin, $this->connection, null);
        $handle = $this->listings()->listing($target, ['kind' => 'providers']);
        [$id, $token] = explode('.', $handle);
        [, $pair] = $this->relay->claimAs($id, $this->desktopSecret);
        $this->relay->answer($id, ['v' => 1, 'kind' => 'final', 'providers' => [['id' => 'oaiy-engine', 'label' => 'OAIY']]], 0, $pair);
        $this->relay->finish($id);

        // Someone else, sending the administrator's handle while asking about their own computer: their own requests only.
        $theirs = $this->computers->link($this->member, 'inst-member', base64_encode(random_bytes(32)));
        $this->relay->readAs = [];
        try {
            $this->listings()->listed($this->settings->listingTarget($this->member, $theirs, null), $handle);
            $this->fail('read another person\'s listing');
        } catch (\RuntimeException $e) {
            $this->assertSame('That computer\'s answer is no longer here. Ask again.', $e->getMessage());
        }
        $this->assertSame([$this->member], array_values(array_unique($this->relay->readAs)));
        // Nor can they name the administrator's computer.
        try {
            $this->settings->listingTarget($this->member, $this->connection, null);
            $this->fail('another account\'s computer');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('not linked to your account', $e->getMessage());
        }
        // The right request with any other token is no listing of this site's: refused before any of its frames is read.
        $fetched = count($this->relay->fetched);
        try {
            $this->listings()->listed($target, $id . '.' . strrev($token));
            $this->fail('opened with another token');
        } catch (\InvalidArgumentException $e) {
            $this->assertSame('That listing is not one this site asked for. Ask again.', $e->getMessage());
        }
        $this->assertSame($fetched, count($this->relay->fetched), 'no frame of it was read');
        foreach (['', 'not-a-handle', $id, $id . '.' . $token . 'x'] as $bad) {
            try {
                $this->listings()->listed($target, $bad);
                $this->fail('read a handle that is not one: ' . $bad);
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
        // A server with another secret reads nothing either: its token makes another key.
        $elsewhere = new SiteDesktopAi($this->relay, $this->settings, null, 'another-servers-secret-0123456789');
        $this->expectExceptionMessage('That listing is not one this site asked for.');
        $elsewhere->listed($target, $handle);
    }

    /**
     * A listing the page stops reading is let go at once, and only by its own handle; and no other
     * request of the owner's is a listing, whatever it is named with. Before, a request id with any
     * token was waited on as a listing and, 20 seconds on, cancelled: any of the owner's turns.
     */
    public function testAListingIsLetGoOnlyByItsOwnHandleAndNoOtherRequestPassesForOne(): void
    {
        $target = $this->settings->listingTarget($this->admin, $this->connection, null);
        $handle = $this->listings()->listing($target, ['kind' => 'providers']);
        [$id, $token] = explode('.', $handle);
        foreach ([$id . '.' . strrev($token), 'not-a-handle'] as $bad) {
            try {
                $this->listings()->letGoListing($target, $bad);
                $this->fail('let go by a handle that is not its own: ' . $bad);
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
        $this->assertSame([], $this->relay->cancelled, 'nothing was let go');
        $this->assertTrue($this->listings()->letGoListing($target, $handle));
        $this->assertSame([$id], $this->relay->cancelled);

        // A member's chat on the same computer, named as a listing with any token: not one, so neither
        // read nor, however old, let go.
        $site = $this->site();
        [$chat] = $site->send($this->settings->current(), ['kind' => 'chat', 'messages' => self::SAY_HELLO], $this->member);
        $this->relay->age($chat, SiteDesktopAi::LISTING_SECONDS + 5);
        foreach (['listed', 'letGoListing'] as $call) {
            try {
                $this->listings()->{$call}($target, $chat . '.' . $token);
                $this->fail($call . ' took a chat for a listing');
            } catch (\InvalidArgumentException $e) {
                $this->assertSame('That listing is not one this site asked for. Ask again.', $e->getMessage());
            }
        }
        $this->assertSame([$id], $this->relay->cancelled, 'the chat stands');
    }

    /** A reader that names no limit reads no more than MAX_COLLECTED_BYTES of text, however much a computer sends. */
    public function testAReaderThatNamesNoLimitReadsNoMoreThanTheCeiling(): void
    {
        $site = $this->site();
        [$id, $pair] = $site->send($this->settings->current(), ['kind' => 'chat', 'messages' => self::SAY_HELLO], $this->member);
        [, $desktopPair] = $this->relay->claimAs($id, $this->desktopSecret);
        $chunk = str_repeat('x', 200000);
        for ($i = 0; $i < 12; $i++) {
            $this->relay->answer($id, ['v' => 1, 'kind' => 'delta', 'delta' => $chunk], $i, $desktopPair);
        }
        $read = strlen($site->collect($id, $this->admin, $pair)['content']);
        $this->assertGreaterThanOrEqual(SiteDesktopAi::MAX_COLLECTED_BYTES, $read);
        $this->assertLessThan(SiteDesktopAi::MAX_COLLECTED_BYTES + strlen($chunk) + 1, $read, 'it stopped at the frame that reached the ceiling, not after all 2.4 MB');
    }

    /** A reader that decides on the whole answer (the camera check) takes no answer with a frame missing; a chat goes on without it. */
    public function testAGaplessReaderRefusesAnAnswerWithAFrameMissing(): void
    {
        $site = $this->site();
        [$id, $pair] = $site->send($this->settings->current(), ['kind' => 'chat', 'messages' => self::SAY_HELLO], $this->member);
        [, $desktopPair] = $this->relay->claimAs($id, $this->desktopSecret);
        $this->relay->answer($id, ['v' => 1, 'kind' => 'delta', 'delta' => '{"age":'], 0, $desktopPair);
        $this->relay->answer($id, ['v' => 1, 'kind' => 'delta', 'delta' => '30}'], 2, $desktopPair);
        $this->assertSame('{"age":30}', $site->collect($id, $this->admin, $pair)['content'], 'a chat goes on without the lost frame');
        $this->expectExceptionMessage('a frame missing');
        $site->collect($id, $this->admin, $pair, gapless: true);
    }

    public function testAListingThatFailsOrIsNotAnsweredInTimeIsSaidAndCancelled(): void
    {
        $target = $this->settings->listingTarget($this->admin, $this->connection, null);
        $told = function (\Closure $computer) use ($target): string {
            $handle = $this->listings()->listing($target, ['kind' => 'providers']);
            $computer(explode('.', $handle)[0]);
            try {
                $this->listings()->listed($target, $handle);
                return 'nothing';
            } catch (\RuntimeException $e) {
                return $e->getMessage();
            }
        };
        $this->assertSame('OAIY on that computer could not answer: no engine is running', $told(function (string $id): void {
            [, $pair] = $this->relay->claimAs($id, $this->desktopSecret);
            $this->relay->answer($id, ['v' => 1, 'kind' => 'error', 'message' => 'no engine is running'], 0, $pair);
            $this->relay->finish($id, 'failed');
        }));
        $this->assertSame('That computer did not pick this up in time. It may be off.', $told(fn (string $id) => $this->relay->finish($id, 'expired')));
        $this->assertSame(SiteDesktopAi::LISTING_SECONDS, 20);
        $late = $told(function (string $id): void {
            $this->relay->claimAs($id, $this->desktopSecret);
            $this->relay->age($id, SiteDesktopAi::LISTING_SECONDS);
        });
        $this->assertSame('That computer took too long to answer.', $late);
        $this->assertSame([$this->relay->newest()], $this->relay->cancelled, 'and the computer is told to stop');
    }

    public function testAListingNeedsTheServersSecret(): void
    {
        $target = $this->settings->listingTarget($this->admin, $this->connection, null);
        $this->expectExceptionMessage('Listings need the server\'s secret');
        (new SiteDesktopAi($this->relay, $this->settings))->listing($target, ['kind' => 'providers']);
    }
}
