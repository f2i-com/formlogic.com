<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\AppService;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\NativePhoneVerification;
use FormLogic\Services\PluginAppSettings;
use FormLogic\Services\PluginNetwork;
use FormLogic\Services\PluginService;
use FormLogic\Tests\Support\PluginsOnSqlite;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * The plugin that ships with FormLogic for Twilio Verify (resources/plugins/twilio-verify), its own
 * ZIPP code installed in the real SoftN runner as the site installs it, sending and checking a
 * Coffee.Dating sign-in code end to end: the site makes its requests to a fake Twilio (no real
 * credentials anywhere: the SIDs are made up, and built from parts so nothing mistakes them for
 * real ones), and the app's backend is played as the other tests play it.
 */
final class TwilioVerifyPluginTest extends TestCase
{
    private const PHONE = '+61412345678';
    private const TOKEN = 'test-auth-token-not-real';

    private static ?NativeAppService $runner = null;
    private static string $storage = '';
    private static string $pluginApp = 'twilio-verify-plugin-test';

    private string $account = '';
    private string $service = '';
    private PluginsOnSqlite $plugins;
    private PDO $db;
    private array $files = [];
    /** @var list<array> what went to "Twilio" */
    private array $sent = [];
    /** @var list<array{status: int, body: string}> */
    private array $answers = [];
    /** @var list<array> what the plugin's code was handed */
    private array $handed = [];
    private array $contexts = [];
    private int $now = 1_800_000_000;
    private array $saved = [];

    public static function setUpBeforeClass(): void
    {
        $runtime = dirname(__DIR__, 2) . '/resources/softn-native';
        if (!is_file($runtime . '/runner.mjs') || !getenv('FORMLOGIC_NODE_BIN')) {
            return;
        }
        self::$storage = sys_get_temp_dir() . '/formlogic-twilio-plugin-' . bin2hex(random_bytes(6));
        mkdir(self::$storage, 0700, true);
        self::$runner = new NativeAppService(self::$storage, $runtime, (string) getenv('FORMLOGIC_NODE_BIN'));
        // The plugin's folder as a project, as PluginService installs one that ships with FormLogic.
        $dir = dirname(__DIR__, 2) . '/resources/plugins/twilio-verify';
        $files = [];
        foreach (new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS)) as $file) {
            $files[str_replace('\\', '/', substr((string) $file, strlen($dir) + 1))] = (string) file_get_contents((string) $file);
        }
        ksort($files);
        self::$runner->install(self::$pluginApp, ['home' => true, 'version' => 0, 'files' => $files, 'assets' => [], 'access' => 'members'], 0, null, ['by' => 'test', 'how' => 'plugin']);
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$runner !== null) {
            try { self::$runner->remove(self::$pluginApp); } catch (\Throwable) {}
        }
        $root = self::$storage !== '' ? realpath(self::$storage) : false;
        if ($root !== false && str_starts_with(basename($root), 'formlogic-twilio-plugin-')) {
            foreach (new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST) as $file) {
                if ($file->isDir() && !$file->isLink()) @rmdir($file->getPathname()); else @unlink($file->getPathname());
            }
            @rmdir($root);
        }
        self::$runner = null;
    }

    protected function setUp(): void
    {
        if (self::$runner === null) {
            $this->markTestSkipped('Prepare native runtime and set FORMLOGIC_NODE_BIN.');
        }
        $this->saved = ['env' => getenv('DATA_ENCRYPTION_KEY'), 'ENV' => $_ENV['DATA_ENCRYPTION_KEY'] ?? null];
        putenv('DATA_ENCRYPTION_KEY');
        unset($_ENV['DATA_ENCRYPTION_KEY']);
        // Made up, and written in parts.
        $this->account = 'A' . 'C' . bin2hex(random_bytes(16));
        $this->service = 'V' . 'A' . bin2hex(random_bytes(16));
        $this->plugins = new PluginsOnSqlite();
        $this->plugins->plugin('formlogic.twilio-verify', self::$pluginApp);
        $this->db = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
        $this->db->exec("CREATE TABLE otp_challenges(id TEXT PRIMARY KEY, phone TEXT NOT NULL, code_hash TEXT NOT NULL, ip_hash TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER, expires_at INTEGER)");
    }

    protected function tearDown(): void
    {
        if ($this->saved === []) return;
        if ($this->saved['env'] === false) putenv('DATA_ENCRYPTION_KEY'); else putenv('DATA_ENCRYPTION_KEY=' . $this->saved['env']);
        if ($this->saved['ENV'] === null) unset($_ENV['DATA_ENCRYPTION_KEY']); else $_ENV['DATA_ENCRYPTION_KEY'] = $this->saved['ENV'];
    }

    private function verification(): NativePhoneVerification
    {
        // The app's side is played here; the plugin's side is the real runner's.
        $native = $this->createMock(NativeAppService::class);
        $native->method('readPrivateFile')->willReturnCallback(fn (string $app, string $name) => $this->files[$app][$name] ?? null);
        $native->method('writePrivateFile')->willReturnCallback(function (string $app, string $name, string $text) { $this->files[$app][$name] = $text; });
        $native->method('hostConfig')->willReturn(['development' => false]);
        $native->method('installedManifest')->willReturnCallback(fn (string $appId) => $appId === self::$pluginApp
            ? self::$runner->installedManifest($appId)
            : ['config' => ['app' => ['verificationProvider' => 'twilio-verify']]]);
        $native->method('withDatabase')->willReturnCallback(fn (string $app, callable $use) => $use($this->db));
        $native->method('withPrivateFileLock')->willReturnCallback(fn (string $app, string $name, callable $work) => $work());
        $native->method('request')->willReturnCallback(function (string $appId, array $request, array $identity = []): array {
            $this->handed[] = $request;
            return self::$runner->request($appId, $request, $identity);
        });
        $plugins = new PluginService($this->plugins, $this->createMock(AppService::class), $native);
        $network = new PluginNetwork($native, function (array $request): array {
            $this->sent[] = $request;
            return array_shift($this->answers) ?? ['status' => 500, 'body' => ''];
        }, fn (string $host): array => $host === 'verify.twilio.com' ? ['93.184.216.34'] : [], fn () => null);
        $service = new NativePhoneVerification($native, $plugins, new PluginAppSettings($native), $network, null, fn () => $this->now);
        $service->save('app', ['accountSid' => $this->account, 'serviceSid' => $this->service, 'authToken' => self::TOKEN]);
        return $service;
    }

    private function backend(array $request): callable
    {
        return function (array $context) use ($request): array {
            $this->contexts[] = $context;
            if ($request['path'] === '/api/auth/send-code') {
                $id = bin2hex(random_bytes(16));
                $this->db->prepare("INSERT INTO otp_challenges(id, phone, code_hash, state, created_at, expires_at) VALUES(?,?,?,?,?,?)")
                    ->execute([$id, self::PHONE, ($context['verificationProvider'] ?? null) === 'twilio-verify' ? 'verify:pending' : 'local', 'queued', $this->now, $this->now + 600]);
                return ['status' => 202, 'body' => (object) ['success' => true, 'challenge_id' => $id]];
            }
            $approved = $context['verification'] ?? null;
            if (!$approved) return ['status' => 401, 'body' => (object) ['error' => 'Code expired or invalid.']];
            $this->db->prepare("UPDATE otp_challenges SET state='used' WHERE id=?")->execute([$approved['challengeId']]);
            return ['status' => 200, 'body' => (object) ['token' => 'session-token']];
        };
    }

    private function send(NativePhoneVerification $service): array
    {
        $request = ['method' => 'POST', 'path' => '/api/auth/send-code', 'body' => ['phone' => '0412 345 678']];
        return $service->handle('app', $request, $this->backend($request));
    }

    private function verify(NativePhoneVerification $service, string $code): array
    {
        $request = ['method' => 'POST', 'path' => '/api/auth/verify', 'body' => ['challenge_id' => $this->challenge()['id'], 'code' => $code]];
        return $service->handle('app', $request, $this->backend($request));
    }

    private function challenge(): array
    {
        return $this->db->query('SELECT * FROM otp_challenges ORDER BY rowid DESC LIMIT 1')->fetch();
    }

    /** Twilio's answer about a verification: for this service and number unless said otherwise. */
    private function twilio(int $status, array $fields): array
    {
        return ['status' => $status, 'body' => json_encode($fields + ['service_sid' => $this->service, 'to' => self::PHONE])];
    }

    private static function verificationSid(string $digit): string
    {
        return 'V' . 'E' . str_repeat($digit, 32);
    }

    public function testItStartsAVerificationAndChecksACodeThroughTwilioAsFormLogicOnceDidItself(): void
    {
        $service = $this->verification();
        $sid = self::verificationSid('a');
        $this->answers[] = $this->twilio(201, ['status' => 'pending', 'sid' => $sid]);
        $this->assertSame(202, $this->send($service)['status']);
        $this->assertSame(['ready', 'verify:' . $sid], [$this->challenge()['state'], $this->challenge()['code_hash']]);
        $this->assertSame([['verificationProvider' => 'twilio-verify']], $this->contexts);
        $start = $this->sent[0];
        $this->assertSame(['POST', 'https://verify.twilio.com/v2/Services/' . $this->service . '/Verifications', 'To=%2B61412345678&Channel=sms', '93.184.216.34'],
            [$start['method'], $start['url'], $start['body'], $start['address']]);
        $this->assertContains('Accept: application/json', $start['headers']);
        $this->assertContains('Authorization: Basic ' . base64_encode($this->account . ':' . self::TOKEN), $start['headers']);

        // A code that is not the one: Twilio says still pending.
        $this->answers[] = $this->twilio(200, ['status' => 'pending', 'sid' => $sid]);
        $wrong = $this->verify($service, '000000');
        $this->assertSame([401, 'wrong_code'], [$wrong['status'], $wrong['body']->code]);
        $this->assertSame(['https://verify.twilio.com/v2/Services/' . $this->service . '/VerificationCheck', 'VerificationSid=' . $sid . '&Code=000000'], [$this->sent[1]['url'], $this->sent[1]['body']]);

        $this->answers[] = $this->twilio(200, ['status' => 'approved', 'sid' => $sid]);
        $this->assertSame(200, $this->verify($service, '123456')['status']);
        $this->assertSame(['challengeId' => $this->challenge()['id'], 'phone' => self::PHONE, 'sid' => $sid, 'attempt' => 2], end($this->contexts)['verification']);

        // Its code was handed the owner's account and service SIDs and Twilio's answers, never the token.
        $handed = json_encode(array_column($this->handed, 'body'));
        $this->assertStringContainsString($this->service, $handed);
        $this->assertStringNotContainsString(self::TOKEN, $handed);
        $this->assertStringNotContainsString(base64_encode($this->account . ':' . self::TOKEN), $handed);
    }

    public function testAnAnswerThatIsNotTwilioSayingPendingForThisServiceAndNumberSendsNothing(): void
    {
        $service = $this->verification();
        foreach ([
            [$this->twilio(201, ['status' => 'pending', 'sid' => self::verificationSid('b'), 'to' => '+61400000000']), 503],
            [$this->twilio(201, ['status' => 'pending', 'sid' => self::verificationSid('b'), 'service_sid' => 'V' . 'A' . str_repeat('0', 32)]), 503],
            [$this->twilio(201, ['status' => 'approved', 'sid' => self::verificationSid('b')]), 503],
            [$this->twilio(201, ['status' => 'pending', 'sid' => 'XX' . str_repeat('b', 32)]), 503],
            [['status' => 201, 'body' => 'not json'], 503],
            [['status' => 429, 'body' => '{}'], 429],
            [['status' => 400, 'body' => '{"code": 60200}'], 503],
        ] as [$answer, $status]) {
            $this->answers[] = $answer;
            $this->assertSame([$status, 'failed'], [$this->send($service)['status'], $this->challenge()['state']], $answer['body']);
        }
    }

    public function testTwilioForgettingAVerificationExpiresTheCodeAndABusyTwilioIsBusy(): void
    {
        $service = $this->verification();
        $sid = self::verificationSid('c');
        $this->answers[] = $this->twilio(201, ['status' => 'pending', 'sid' => $sid]);
        $this->send($service);
        $this->answers[] = ['status' => 404, 'body' => '{"code": 20404}'];
        $this->assertSame([401, 'invalid_code'], [($r = $this->verify($service, '111111'))['status'], $r['body']->code]);
        $this->answers[] = ['status' => 429, 'body' => '{}'];
        $this->assertSame([429, 'verification_unavailable'], [($r = $this->verify($service, '111111'))['status'], $r['body']->code]);
        $this->answers[] = $this->twilio(200, ['status' => 'approved', 'sid' => self::verificationSid('d')]);
        $this->assertSame([401, 'wrong_code'], [($r = $this->verify($service, '111111'))['status'], $r['body']->code], 'approved, but for another verification');
        $this->answers[] = ['status' => 500, 'body' => ''];
        $this->assertSame([503, 'verification_unavailable'], [($r = $this->verify($service, '111111'))['status'], $r['body']->code]);
        $this->assertSame(3, (int) $this->challenge()['attempts'], 'a check Twilio could not answer is given back; the others stand');
    }

    public function testItsRoutesRefuseWhatTheSiteWouldNeverSend(): void
    {
        $call = fn (string $path, array $body) => self::$runner->request(self::$pluginApp, ['method' => 'POST', 'path' => $path, 'query' => (object) [], 'body' => $body,
            'headers' => (object) ['authorization' => '', 'idempotency-key' => ''], 'client_ip' => '127.0.0.1', 'photos' => false], ['formlogic' => ['appId' => self::$pluginApp]]);
        $settings = ['accountSid' => $this->account, 'serviceSid' => $this->service];
        $this->assertSame(['result' => 'unavailable'], $call('/api/site/codes/send', ['phone' => self::PHONE, 'appSettings' => ['accountSid' => 'AC1', 'serviceSid' => $this->service]])['body']);
        $this->assertSame(['result' => 'unavailable'], $call('/api/site/codes/send', ['phone' => self::PHONE, 'appSettings' => ['accountSid' => $this->account, 'serviceSid' => '../x']])['body'], 'nothing but a service SID goes in its address');
        $this->assertSame(['result' => 'expired'], $call('/api/site/codes/check', ['id' => 'not-a-sid', 'phone' => self::PHONE, 'code' => '123456', 'appSettings' => $settings])['body']);
        $this->assertSame(['result' => 'unavailable'], $call('/api/site/codes/sent', ['phone' => self::PHONE, 'appSettings' => $settings])['body'], 'no answer, nothing sent');
        $asked = $call('/api/site/codes/send', ['phone' => self::PHONE, 'appSettings' => $settings])['body'];
        $this->assertSame(['secret' => 'authToken'], $asked['request']['auth']['basic']['password'], 'it names the token; it never has it');
        $this->assertSame('/api/site/codes/sent', $asked['continue']);
    }
}
