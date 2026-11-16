<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\AIService;
use FormLogic\Services\AppAiService;
use FormLogic\Services\AppAiSiteSettings;
use FormLogic\Services\AppListening;
use FormLogic\Services\AppService;
use FormLogic\Services\AppVisitors;
use FormLogic\Services\ListenRefusal;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\PlanService;
use FormLogic\Tests\Support\Recording;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * FormLogic's listening for a hosted app (AppListening), before anything is sent anywhere: when it
 * is on, what counts as a recording, and what of one is passed on. The speech server's part is
 * AppListenRouteTest's.
 */
final class AppListeningTest extends TestCase
{
    private const SPEECH = ['url' => 'http://127.0.0.1:9/v1', 'key' => '', 'model' => '', 'voice' => ''];
    private const APP = ['id' => 'app-1', 'ownerId' => 'owner', 'settings' => ['softnApp' => true, 'softnListen' => 'allow']];

    /** @var list<string> */
    private array $files = [];

    protected function tearDown(): void
    {
        foreach ($this->files as $file) @unlink($file);
        $this->files = [];
    }

    // ------------------------------------------------------------------ the owner's setting

    public function testTheSettingsKeepOnlyAllow(): void
    {
        $service = (new \ReflectionClass(AppService::class))->newInstanceWithoutConstructor();
        $sanitize = new \ReflectionMethod(AppService::class, 'sanitizeAppSettings');
        foreach (['softnListen', 'softnApps'] as $setting) {
            $this->assertSame('allow', $sanitize->invoke($service, [$setting => 'allow'])[$setting]);
            foreach (['ask', 'off', 'ALLOW', true, 1, ['allow'], null, ''] as $odd) {
                $this->assertArrayNotHasKey($setting, $sanitize->invoke($service, [$setting => $odd]), $setting . ' ' . var_export($odd, true));
            }
        }
        // Each is its own choice, and neither touches the files choice beside them.
        $this->assertSame(['softnFiles' => 'ask', 'softnApps' => 'allow'], $sanitize->invoke($service, ['softnFiles' => 'ask', 'softnListen' => 'yes', 'softnApps' => 'allow']));
    }

    // ------------------------------------------------------------------ when it is on

    private function listening(bool $speechServer = true, bool $appAi = true): AppListening
    {
        $site = $this->createMock(AIService::class);
        $site->method('envSpeech')->willReturn($speechServer ? self::SPEECH : null);
        $ai = $this->createMock(AppAiService::class);
        $ai->method('siteSpeaksFor')->willReturn($appAi);
        return new AppListening($ai, $site);
    }

    public function testItIsOnOnlyWhereTheOwnerAllowedItAndTheSitesSpeechServerWouldBeAsked(): void
    {
        $this->assertTrue($this->listening()->on(self::APP));
        $this->assertFalse($this->listening(speechServer: false)->on(self::APP), 'no speech server named, or the site\'s AI off');
        $this->assertFalse($this->listening(appAi: false)->on(self::APP), 'App AI would not ask the site\'s speech server for this app');
        foreach ([[], ['softnListen' => 'ask'], ['softnListen' => true], ['softnListen' => 'Allow'], ['softnFiles' => 'allow', 'softnApps' => 'allow']] as $settings) {
            $this->assertFalse($this->listening()->on(['settings' => $settings] + self::APP), json_encode($settings));
        }
        $this->assertFalse($this->listening()->on(['settings' => null] + self::APP));
        // A site with no App AI, or no AI of its own, listens for nobody.
        $this->assertFalse((new AppListening(null, $this->createMock(AIService::class)))->on(self::APP));
        $this->assertFalse((new AppListening($this->createMock(AppAiService::class), null))->on(self::APP));
    }

    public function testAnAppWhoseOwnerDidNotAllowItAsksNothingOfTheSite(): void
    {
        $site = $this->createMock(AIService::class);
        $site->expects($this->never())->method('envSpeech');
        $ai = $this->createMock(AppAiService::class);
        $ai->expects($this->never())->method('siteSpeaksFor');
        $this->assertFalse((new AppListening($ai, $site))->on(['settings' => ['softnApp' => true]] + self::APP));
    }

    public function testAnAnswerThatCannotBeHadIsNoAndTheAppStillOpens(): void
    {
        $site = $this->createMock(AIService::class);
        $site->method('envSpeech')->willReturn(self::SPEECH);
        $ai = $this->createMock(AppAiService::class);
        $ai->method('siteSpeaksFor')->willThrowException(new \PDOException('SQLSTATE[HY000] [2002] gone away'));
        $logged = ini_set('error_log', PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null');
        try {
            $this->assertFalse((new AppListening($ai, $site))->on(self::APP));
        } finally {
            ini_set('error_log', (string) $logged);
        }
    }

    /** App AI itself, with the app's settings as the owner and the administrator may have them. */
    private function appAi(array $settings, array $site = [], bool $speechServer = true, bool $provider = true, ?PlanService $plans = null, ?MySQLConnection $mysql = null): AppAiService
    {
        $file = sys_get_temp_dir() . '/formlogic-listen-' . bin2hex(random_bytes(6)) . '.json';
        $this->files[] = $file;
        $siteSettings = new AppAiSiteSettings($file);
        $siteSettings->save($site + ['allowApps' => true]);
        $ai = $this->createMock(AIService::class);
        $ai->method('isConfigured')->willReturn($provider);
        $ai->method('envSpeech')->willReturn($speechServer ? self::SPEECH : null);
        $service = $this->getMockBuilder(AppAiService::class)
            ->setConstructorArgs([$mysql ?? $this->createMock(MySQLConnection::class), $siteSettings, new AppVisitors(null), $this->createMock(NativeAppService::class), null, $ai, $plans])
            ->onlyMethods(['settings'])
            ->getMock();
        $service->method('settings')->willReturn($settings + [
            'appId' => 'app-1', 'mode' => 'site', 'own' => null, 'perRequesterDay' => 10, 'perIpDay' => 20, 'perIpHour' => 10, 'perAppDay' => 500,
            'blocked' => false, 'blockedReason' => null, 'pausedUntil' => null,
        ]);
        return $service;
    }

    /**
     * The site's speech server is asked for an app exactly where one of its lines would be said
     * (AppAiService::availability), whatever its manifest declares.
     */
    public function testTheSitesSpeechServerIsAskedForAnAppOnlyWhereALineOfItsWouldBeSaid(): void
    {
        $this->assertTrue($this->appAi([])->siteSpeaksFor(self::APP), 'on this site\'s AI, apps allowed, a speech server named');
        $this->assertFalse($this->appAi(['mode' => 'off'])->siteSpeaksFor(self::APP), 'AI for this app is off');
        $this->assertFalse($this->appAi(['mode' => 'own'])->siteSpeaksFor(self::APP), 'the owner\'s own OAIY, with no computer chosen');
        $this->assertFalse($this->appAi([], ['allowApps' => false])->siteSpeaksFor(self::APP), 'the administrator does not let apps use the site\'s AI');
        $this->assertFalse($this->appAi([], ['paused' => true])->siteSpeaksFor(self::APP), 'the administrator paused AI for apps');
        $this->assertFalse($this->appAi(['blocked' => true])->siteSpeaksFor(self::APP), 'the administrator stopped this app\'s AI');
        $this->assertFalse($this->appAi(['pausedUntil' => gmdate('Y-m-d H:i:s', time() + 600)])->siteSpeaksFor(self::APP), 'its AI is resting');
        $this->assertTrue($this->appAi(['pausedUntil' => gmdate('Y-m-d H:i:s', time() - 600)])->siteSpeaksFor(self::APP), 'and has rested');
        $this->assertFalse($this->appAi([], [], speechServer: false)->siteSpeaksFor(self::APP), 'no speech server named');
        $this->assertFalse($this->appAi([], [], provider: false)->siteSpeaksFor(self::APP), 'the site\'s AI is off, or has no provider');

        $lapsed = $this->createMock(PlanService::class);
        $lapsed->method('isEnforced')->willReturn(true);
        $lapsed->method('isCloudActive')->willReturn(false);
        $this->assertFalse($this->appAi([], [], plans: $lapsed)->siteSpeaksFor(self::APP), 'the owner\'s plan has lapsed');
    }

    /** An owner's own OAIY does not speak for apps yet, so nothing is listened for on one, even one that is there. */
    public function testAnAppOnItsOwnersOwnComputerIsNotListenedFor(): void
    {
        $pinned = $this->createMock(\PDOStatement::class);
        $pinned->method('execute')->willReturn(true);
        $pinned->method('fetchColumn')->willReturn('the-key-it-was-pinned-to');
        $pdo = $this->createMock(\PDO::class);
        $pdo->method('prepare')->willReturn($pinned);
        $mysql = $this->createMock(MySQLConnection::class);
        $mysql->method('getConnection')->willReturn($pdo);
        $own = ['connectionId' => 'c-1', 'instanceId' => 'i-1', 'publicKey' => 'the-key-it-was-pinned-to', 'providerId' => 'oaiy', 'pictureModel' => 'flux', 'chatModel' => null, 'deviceName' => 'Desk'];
        $service = $this->appAi(['mode' => 'own', 'own' => $own], mysql: $mysql);
        $this->assertTrue($service->availability(self::APP, ['kinds' => ['chat', 'speech']])['enabled'], 'the computer is there, and chats');
        $this->assertFalse($service->siteSpeaksFor(self::APP));
    }

    // ------------------------------------------------------------------ the recording

    public function testARecordingIsReadAndPassedOnAsItsSoundAlone(): void
    {
        $plain = Recording::wav(1.5);
        $read = AppListening::recording(base64_encode($plain));
        $this->assertSame(1.5, $read['seconds']);
        $this->assertSame($plain, $read['wav'], 'a recorder\'s own file is what is sent');

        // What else a file carries is left behind: a list of who made it, a chunk after the sound.
        $carrying = Recording::file(Recording::format(1, 1, 16000, 16) . Recording::chunk('LIST', 'INFOISFT' . pack('V', 5) . 'Lavf') . Recording::chunk('data', str_repeat("\0", 48000)) . Recording::chunk('id3 ', 'a name, a place'));
        $this->assertSame($plain, AppListening::recording(base64_encode($carrying))['wav']);

        // A data URL, as a page's FileReader gives one, in any of the names a WAV goes by.
        foreach (['data:audio/wav;base64,', 'data:audio/x-wav;base64,', 'DATA:AUDIO/WAVE;BASE64,', 'data:audio/vnd.wave;base64,'] as $prefix) {
            $this->assertSame($plain, AppListening::recording($prefix . base64_encode($plain))['wav'], $prefix);
        }
    }

    public function testHowLongItIsComesFromItsFormatAndItsSound(): void
    {
        $this->assertSame(2.0, AppListening::recording(base64_encode(Recording::wav(2.0, 48000, 2, 16)))['seconds']);
        $this->assertSame(0.25, AppListening::recording(base64_encode(Recording::wav(0.25, 8000, 1, 8)))['seconds']);
        $this->assertSame(1.0, AppListening::recording(base64_encode(Recording::wav(1.0, 44100, 1, 24)))['seconds']);
        // A last sample cut short is not sound: whole frames alone are counted and sent.
        $ragged = Recording::file(Recording::format(1, 2, 16000, 16) . 'data' . pack('V', 64003) . str_repeat("\0", 64003));
        $read = AppListening::recording(base64_encode($ragged));
        $this->assertSame(1.0, $read['seconds']);
        $this->assertSame(44 + 64000, strlen($read['wav']));
        // A recording written as it was made may say a length past its end: what is there is taken.
        $streamed = Recording::file(Recording::format(1, 1, 16000, 16) . 'data' . pack('V', 0xFFFFFFFF) . str_repeat("\0", 16000));
        $this->assertSame(0.5, AppListening::recording(base64_encode($streamed))['seconds']);
        // WAVE_FORMAT_EXTENSIBLE that says PCM is PCM, and is sent on as plain PCM.
        $extensible = Recording::file('fmt ' . pack('VvvVVvv', 40, 0xFFFE, 1, 16000, 32000, 2, 16) . pack('vvV', 22, 16, 4) . pack('v', 1) . str_repeat("\0", 14) . 'data' . pack('V', 32000) . str_repeat("\0", 32000));
        $read = AppListening::recording(base64_encode($extensible));
        $this->assertSame(1.0, $read['seconds']);
        $this->assertSame(Recording::wav(1.0), $read['wav']);
    }

    /** @return array<string, array{mixed}> */
    public static function notRecordings(): array
    {
        $sound = 'data' . pack('V', 32000) . str_repeat("\0", 32000);
        return [
            'nothing' => [null],
            'no words' => [''],
            'a list' => [[base64_encode(Recording::wav(1.0))]],
            'not base64' => ['this is not base64 at all!'],
            'base64 of something else' => [base64_encode('ID3' . str_repeat("\0", 400))],
            'RIFF that is not WAVE' => [base64_encode('RIFF' . pack('V', 400) . 'AVI ' . str_repeat("\0", 400))],
            'a header alone' => [base64_encode('RIFF' . pack('V', 4) . 'WAVE')],
            'no format' => [base64_encode(Recording::file($sound))],
            'no sound' => [base64_encode(Recording::file(Recording::format(1, 1, 16000, 16)))],
            'a format cut short' => [base64_encode(Recording::file('fmt ' . pack('Vvv', 4, 1, 1) . $sound))],
            'empty sound' => [base64_encode(Recording::wav(0.0))],
            'less than one sample' => [base64_encode(Recording::file(Recording::format(1, 1, 16000, 16) . 'data' . pack('V', 1) . "\0\0"))],
            'floating point' => [base64_encode(Recording::wav(1.0, 16000, 1, 32, tag: 3))],
            'ADPCM' => [base64_encode(Recording::wav(1.0, tag: 2))],
            'MP3 in a WAV' => [base64_encode(Recording::wav(1.0, tag: 0x55))],
            'no channels' => [base64_encode(Recording::file(Recording::format(1, 0, 16000, 16) . $sound))],
            'six channels' => [base64_encode(Recording::wav(1.0, 16000, 6))],
            'one sample a second' => [base64_encode(Recording::file(Recording::format(1, 1, 1, 16) . $sound))],
            'too many samples a second' => [base64_encode(Recording::wav(0.1, 192000))],
            'twelve bits' => [base64_encode(Recording::file('fmt ' . pack('VvvVVvv', 16, 1, 1, 16000, 32000, 2, 12) . $sound))],
            'another kind of data URL' => ['data:audio/mpeg;base64,' . base64_encode(Recording::wav(1.0))],
            'a data URL that is not base64' => ['data:audio/wav,' . base64_encode(Recording::wav(1.0))],
            'a data URL with no comma' => ['data:audio/wav;base64'],
        ];
    }

    #[DataProvider('notRecordings')]
    public function testWhatIsNotARecordingIsRefused(mixed $audio): void
    {
        try {
            AppListening::recording($audio);
            $this->fail('taken as a recording');
        } catch (ListenRefusal $refused) {
            $this->assertSame(['invalid_audio', 400], [$refused->reason, $refused->status]);
            $this->assertNotSame('', $refused->getMessage());
        }
    }

    public function testAMinuteIsTheMostAndARecordersLastBufferIsNotHeldAgainstIt(): void
    {
        $this->assertSame(60.0, AppListening::recording(base64_encode(Recording::wav(60.0)))['seconds']);
        $this->assertSame(1920044, strlen(Recording::wav(60.0)), 'a minute as the page records it: 1.92 MB');
        $this->assertSame(60.9, AppListening::recording(base64_encode(Recording::wav(60.9)))['seconds'], 'the minute ended inside a buffer');
        $long = [
            'a second over' => Recording::wav(61.1),
            // Small, and long: the length is the sound's, not the file's.
            'two minutes of telephone sound' => Recording::wav(120.0, 8000, 1, 8),
            // Short, and too large to be a minute of speech as the page records it.
            'larger than is read' => Recording::wav(13.0, 48000, 2, 16),
        ];
        foreach ($long as $what => $wav) {
            try {
                AppListening::recording(base64_encode($wav));
                $this->fail($what . ' was taken');
            } catch (ListenRefusal $refused) {
                $this->assertSame(['too_long', 413], [$refused->reason, $refused->status], $what);
            }
        }
        // Far too large is refused before it is decoded.
        try {
            AppListening::recording(str_repeat('A', 4 * 1024 * 1024));
            $this->fail('four megabytes were decoded');
        } catch (ListenRefusal $refused) {
            $this->assertSame('too_long', $refused->reason);
        }
    }

    public function testNothingIsHeardForAnAppItIsNotOnFor(): void
    {
        $site = $this->createMock(AIService::class);
        $site->method('envSpeech')->willReturn(self::SPEECH);
        $ai = $this->createMock(AppAiService::class);
        $ai->method('siteSpeaksFor')->willReturn(false);
        $ai->expects($this->never())->method('heard');
        try {
            (new AppListening($ai, $site))->hear(self::APP, base64_encode(Recording::wav(1.0)));
            $this->fail('heard');
        } catch (ListenRefusal $refused) {
            $this->assertSame(['listen_off', 403], [$refused->reason, $refused->status]);
        }
    }

    // ------------------------------------------------------------------ the app's allowances

    /** Listening for APP, where App AI says what it may take from the app's allowances and is told what is given back. */
    private function counted(array $take, ?array &$givenBack = null): AppListening
    {
        $site = $this->createMock(AIService::class);
        $site->method('envSpeech')->willReturn(self::SPEECH);
        $ai = $this->createMock(AppAiService::class);
        $ai->method('siteSpeaksFor')->willReturn(true);
        $ai->method('takeForListening')->willReturn($take);
        $givenBack = [];
        $ai->method('giveBackListening')->willReturnCallback(function (array $taken) use (&$givenBack): void { $givenBack[] = $taken; });
        return new AppListening($ai, $site, 2);
    }

    public function testASpentAllowanceRefusesTheRecordingBeforeAnythingIsSent(): void
    {
        $listening = $this->counted(['refused' => ['code' => 'limit_reached', 'message' => 'This app has used its AI for today. Try again tomorrow (UTC).']]);
        try {
            // (The speech server named here is nowhere: had it been asked, this would be listen_failed.)
            $this->loggedRun(fn() => $listening->hear(self::APP, base64_encode(Recording::wav(1.0)), ['kind' => 'visitor', 'id' => 'v-1'], '203.0.113.7'));
            $this->fail('A spent allowance is refused.');
        } catch (ListenRefusal $refused) {
            $this->assertSame(['limit_reached', 429, 'This app has used its AI for today. Try again tomorrow (UTC).'], [$refused->reason, $refused->status, $refused->getMessage()]);
        }
    }

    public function testARecordingThatCannotBeReadCostsNothing(): void
    {
        $site = $this->createMock(AIService::class);
        $site->method('envSpeech')->willReturn(self::SPEECH);
        $ai = $this->createMock(AppAiService::class);
        $ai->method('siteSpeaksFor')->willReturn(true);
        $ai->expects($this->never())->method('takeForListening');
        try {
            (new AppListening($ai, $site, 2))->hear(self::APP, 'not a recording');
            $this->fail('Not a recording.');
        } catch (ListenRefusal $refused) {
            $this->assertSame('invalid_audio', $refused->reason);
        }
    }

    public function testWhatTheSpeechServerDidNotPutIntoWordsIsGivenBack(): void
    {
        $taken = [['app-1', 'requester', 'v:v-1', '2026-11-16'], ['app-1', 'app', '', '2026-11-16'], ['', 'site', '', '2026-11-16']];
        $listening = $this->counted(['taken' => $taken], $givenBack);
        $previous = ini_set('error_log', (string) ($this->files[] = (string) tempnam(sys_get_temp_dir(), 'listen-log-')));
        try {
            $listening->hear(self::APP, base64_encode(Recording::wav(1.0)), ['kind' => 'visitor', 'id' => 'v-1'], '203.0.113.7');
            $this->fail('The speech server is nowhere.');
        } catch (ListenRefusal $refused) {
            $this->assertSame('listen_failed', $refused->reason);
        } finally {
            ini_set('error_log', $previous === false ? '' : $previous);
        }
        $this->assertSame([$taken], $givenBack);
    }

    /** $work run with PHP's error log kept out of the test's output: [what it answered, what was logged]. */
    private function loggedRun(callable $work): array
    {
        $file = (string) tempnam(sys_get_temp_dir(), 'listen-log-');
        $this->files[] = $file;
        $previous = ini_set('error_log', $file);
        try {
            return [$work(), ''];
        } finally {
            ini_set('error_log', $previous === false ? '' : $previous);
        }
    }
}
