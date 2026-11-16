<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Tests\Support\ListeningFixture;
use FormLogic\Tests\Support\Recording;
use FormLogic\Tests\Support\StubImagesServer;
use PHPUnit\Framework\TestCase;

/**
 * A recording put into words (POST /api/app/{slug}/native/listen), through the real controller and
 * AppListening, against a stand-in for the site's speech server (tests/Support/stub-images-server.php,
 * which answers `/v1/audio/transcriptions` as OAIY Voice does): what is asked of the server, what
 * the page is answered, and that whatever goes wrong there is one plain refusal.
 */
final class AppListenRouteTest extends TestCase
{
    use ListeningFixture;

    private const ALLOWED = ['softnApp' => true, 'softnListen' => 'allow'];
    private const FAILED = [502, ['error' => true, 'message' => 'The recording could not be put into words. Try again in a moment.', 'code' => 'listen_failed']];

    private static ?StubImagesServer $stub = null;

    public static function setUpBeforeClass(): void
    {
        if (!function_exists('curl_init')) return;
        self::$stub = StubImagesServer::start();
    }

    public static function tearDownAfterClass(): void
    {
        self::$stub?->stop();
        self::$stub = null;
    }

    protected function setUp(): void
    {
        if (self::$stub === null) $this->markTestSkipped('Needs curl');
        self::$stub->clear();
        $this->install();
    }

    private static function speech(string $key = ''): array
    {
        return ['url' => self::$stub->url(), 'key' => $key, 'model' => 'a-voice-model', 'voice' => 'a-voice'];
    }

    public function testARecordingIsPutIntoWordsAndOnlyThatItHappenedIsCounted(): void
    {
        $controller = $this->controller(self::ALLOWED, $this->listening(self::speech('speech-key')));
        $wav = Recording::wav(1.5);
        $answer = $this->listen($controller, ['audio' => base64_encode($wav)]);
        // The words, without the space and the line end the server left around them, and how long it was.
        $this->assertSame([200, ['data' => ['text' => '24000 samples at 16000 Hz in 1.', 'seconds' => 1.5]]], self::read($answer));
        $this->assertSame('no-store', $answer->getHeaderLine('Cache-Control'));
        $this->assertSame([['notes', 1.5]], $this->heard, 'counted for the app, by its length alone');

        // Asked as OAIY Voice takes one: the recording and the form of the answer, nothing else.
        $sent = self::$stub->requests();
        $this->assertCount(1, $sent);
        $this->assertSame(['POST', '/v1/audio/transcriptions'], [$sent[0]['method'], $sent[0]['path']]);
        $this->assertSame(['audio' => ['length' => strlen(base64_encode($wav)), 'prefix' => substr(base64_encode($wav), 0, 30)], 'response_format' => 'json'], $sent[0]['body']);
        $this->assertSame(['Bearer speech-key', 'application/json', 'application/json'], [$sent[0]['headers']['authorization'] ?? null, $sent[0]['headers']['content-type'] ?? null, $sent[0]['headers']['accept'] ?? null]);
        $this->assertArrayNotHasKey('expect', $sent[0]['headers'], 'sent at once, not after a wait to be told to go on');
    }

    public function testAKeylessSpeechServerIsSentNoKeyAndADataUrlIsRead(): void
    {
        $controller = $this->controller(self::ALLOWED, $this->listening(self::speech()));
        $answer = $this->listen($controller, ['audio' => 'data:audio/wav;base64,' . base64_encode(Recording::wav(0.5, 48000, 2, 16))]);
        $this->assertSame([200, ['data' => ['text' => '24000 samples at 48000 Hz in 2.', 'seconds' => 0.5]]], self::read($answer));
        $this->assertArrayNotHasKey('authorization', self::$stub->requests()[0]['headers']);
    }

    /** What a file carries besides its sound stays here: the server is sent the sound under a plain header. */
    public function testOnlyTheSoundIsSentOn(): void
    {
        $controller = $this->controller(self::ALLOWED, $this->listening(self::speech()));
        $carrying = Recording::wav(1.0, before: Recording::chunk('LIST', 'INFOINAM' . pack('V', 12) . 'Ada Lovelace'));
        $this->assertSame(200, $this->listen($controller, ['audio' => base64_encode($carrying)])->getStatusCode());
        $plain = base64_encode(Recording::wav(1.0));
        $this->assertSame(['length' => strlen($plain), 'prefix' => substr($plain, 0, 30)], self::$stub->requests()[0]['body']['audio']);
    }

    public function testSilenceIsAnAnswerWithNoWords(): void
    {
        $controller = $this->controller(self::ALLOWED, $this->listening(self::speech()));
        // (A whole number of seconds is written `2` in JSON, which a page reads as the number it is.)
        $this->assertSame([200, ['data' => ['text' => '', 'seconds' => 2]]], self::read($this->listen($controller, ['audio' => base64_encode(Recording::wav(2.0, says: '[silent]'))])));
        $this->assertSame([['notes', 2.0]], $this->heard);
    }

    public function testWhateverGoesWrongAtTheSpeechServerIsOnePlainRefusal(): void
    {
        $controller = $this->controller(self::ALLOWED, $this->listening(self::speech()));
        $cases = [
            '[broken]' => 'the speech server answered HTTP 500: the engine stopped',
            '[busy]' => 'the speech server answered HTTP 503: the media queue is full',
            '[toolarge]' => 'the speech server answered HTTP 413',
            '[wordless]' => 'the speech server answered without words',
            '[prose]' => 'the speech server answered without words',
            '[endless]' => 'the speech server answered more than words take',
        ];
        foreach ($cases as $says => $why) {
            [$answer, $log] = self::logged(fn() => $this->listen($controller, ['audio' => base64_encode(Recording::wav(1.0, says: $says))]));
            $this->assertSame(self::FAILED, self::read($answer), $says);
            $this->assertSame('no-store', $answer->getHeaderLine('Cache-Control'));
            // What the server said is for the log, never for the page.
            $this->assertStringContainsString('App listening: ' . $why, $log, $says);
        }
        $this->assertCount(count($cases), self::$stub->requests());
        $this->assertSame([], $this->heard, 'nothing was heard, so nothing is counted');
    }

    public function testASpeechServerThatIsNotThereOrDoesNotAnswerInTimeIsTheSameRefusal(): void
    {
        // Nothing listens on port 9.
        $nowhere = $this->controller(self::ALLOWED, $this->listening(['url' => 'http://127.0.0.1:9/v1', 'key' => 'k', 'model' => '', 'voice' => '']));
        [$answer, $log] = self::logged(fn() => $this->listen($nowhere, ['audio' => base64_encode(Recording::wav(1.0))]));
        $this->assertSame(self::FAILED, self::read($answer));
        $this->assertStringContainsString('App listening: the speech server could not be reached', $log);

        // One that takes three seconds, waited on for one.
        $slow = $this->controller(self::ALLOWED, $this->listening(self::speech(), timeout: 1));
        $started = microtime(true);
        [$answer, $log] = self::logged(fn() => $this->listen($slow, ['audio' => base64_encode(Recording::wav(1.0, says: '[slow:3]'))]));
        $this->assertLessThan(2.5, microtime(true) - $started);
        $this->assertSame(self::FAILED, self::read($answer));
        $this->assertStringContainsString('App listening: the speech server did not answer in 1 seconds', $log);
        $this->assertSame([], $this->heard);
    }

    public function testNothingIsSentForARecordingThatIsRefusedHere(): void
    {
        $audio = base64_encode(Recording::wav(1.0));
        $this->assertSame('listen_off', self::read($this->listen($this->controller(['softnApp' => true], $this->listening(self::speech())), ['audio' => $audio]))[1]['code']);
        $this->assertSame('listen_off', self::read($this->listen($this->controller(self::ALLOWED, $this->listening(self::speech(), appAi: false)), ['audio' => $audio]))[1]['code']);
        $controller = $this->controller(self::ALLOWED, $this->listening(self::speech()));
        $this->assertSame('invalid_audio', self::read($this->listen($controller, ['audio' => base64_encode('RIFF' . str_repeat("\0", 400))]))[1]['code']);
        $this->assertSame('too_long', self::read($this->listen($controller, ['audio' => base64_encode(Recording::wav(90.0, 8000, 1, 8))]))[1]['code']);
        $this->assertSame([], self::$stub->requests());
    }

    /** That a recording was put into words is counted where the day's other counts are, even when counting fails. */
    public function testTheWordsAreGivenWhetherOrNotTheCountWasWritten(): void
    {
        $site = $this->createMock(\FormLogic\Services\AIService::class);
        $site->method('envSpeech')->willReturn(self::speech());
        $ai = $this->createMock(\FormLogic\Services\AppAiService::class);
        $ai->method('siteSpeaksFor')->willReturn(true);
        $ai->method('heard')->willThrowException(new \PDOException('SQLSTATE[HY000]: gone away'));
        $controller = $this->controller(self::ALLOWED, new \FormLogic\Services\AppListening($ai, $site));
        [$answer, $log] = self::logged(fn() => $this->listen($controller, ['audio' => base64_encode(Recording::wav(1.0))]));
        $this->assertSame([200, ['data' => ['text' => '16000 samples at 16000 Hz in 1.', 'seconds' => 1]]], self::read($answer));
        $this->assertStringContainsString('App listening: not counted for app notes: PDOException', $log);
        $this->assertStringNotContainsString('16000 samples', $log, 'what was heard is never logged');
    }
}
