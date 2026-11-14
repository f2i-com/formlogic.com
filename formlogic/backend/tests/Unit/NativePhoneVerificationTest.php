<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Services\AppService;
use FormLogic\Services\LegacyPhoneVerification;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\NativePhoneVerification;
use FormLogic\Services\PluginAppSettings;
use FormLogic\Services\PluginNetwork;
use FormLogic\Services\PluginService;
use FormLogic\Tests\Support\PluginsOnSqlite;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * A SoftN app's phone sign-in codes, as SoftN's operator adapter (Coffee.Dating's verify.mjs) has
 * them, sent and checked by the plugin that provides the provider the app names: the app's backend
 * admits a request before a code is paid for, the attempt is counted before the plugin is asked, the
 * backend learns only what the plugin decided, and the owner's secret never leaves the site. The
 * plugin here is an example of any: its code is played by PHP, its provider by a fake transport,
 * and everything between them is the site's own.
 */
final class NativePhoneVerificationTest extends TestCase
{
    private const PHONE = '+61412345678';
    private const PLUGIN_APP = 'plugin-app';
    private const ACCOUNT = 'AC1234';

    private PluginsOnSqlite $plugins;
    private PDO $db;
    /** @var array<string, array<string, string>> each app's private files */
    private array $files = [];
    /** @var list<array> what went out to the provider */
    private array $sent = [];
    /** @var list<array{status: int, body: string}> what the provider answers next */
    private array $answers = [];
    /** @var list<array> what the plugin's code was handed */
    private array $handed = [];
    /** @var list<array> the contexts the backend was run with */
    private array $contexts = [];
    private int $now = 1_800_000_000;
    private array $hostConfig = ['development' => false];
    private ?string $provider = 'example-sms';
    private array $addresses = ['93.184.216.34'];
    /** @var ?callable what the plugin answers instead, at a route */
    private $override = null;
    /** Every worker slot is taken: the plugin's backend is not run. */
    private bool $slotsBusy = false;
    private array $saved = [];

    protected function setUp(): void
    {
        $this->saved = ['env' => getenv('DATA_ENCRYPTION_KEY'), 'ENV' => $_ENV['DATA_ENCRYPTION_KEY'] ?? null];
        putenv('DATA_ENCRYPTION_KEY');
        unset($_ENV['DATA_ENCRYPTION_KEY']);
        $this->plugins = new PluginsOnSqlite();
        $this->db = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
        $this->db->exec("CREATE TABLE otp_challenges(id TEXT PRIMARY KEY, phone TEXT NOT NULL, code_hash TEXT NOT NULL, ip_hash TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER, expires_at INTEGER)");
    }

    protected function tearDown(): void
    {
        if ($this->saved['env'] === false) putenv('DATA_ENCRYPTION_KEY'); else putenv('DATA_ENCRYPTION_KEY=' . $this->saved['env']);
        if ($this->saved['ENV'] === null) unset($_ENV['DATA_ENCRYPTION_KEY']); else $_ENV['DATA_ENCRYPTION_KEY'] = $this->saved['ENV'];
    }

    /** An example plugin that sends codes for "example-sms" through api.sms.example. */
    private static function pluginManifest(): array
    {
        $route = fn (string $path, string $handler) => ['path' => $path, 'method' => 'POST', 'handler' => $handler, 'transaction' => 'read', 'authorization' => 'anonymous'];
        return [
            'id' => 'example.codes', 'version' => '1.0.0', 'main' => 'ui/main.ui',
            'server' => ['entry' => 'server/main.logic', 'requires' => ['apiVersion' => 1, 'capabilities' => []], 'database' => ['kind' => 'private-sqlite', 'migrations' => []], 'routes' => [
                $route('/api/site/codes/send', 'send'), $route('/api/site/codes/sent', 'sent'), $route('/api/site/codes/check', 'check'), $route('/api/site/codes/checked', 'checked'),
            ]],
            'formlogicPlugin' => [
                'id' => 'example.codes', 'name' => 'Example codes', 'passes' => [],
                'network' => ['api.sms.example'],
                'signInCodes' => ['provider' => 'example-sms', 'label' => 'By example text', 'sendRoute' => '/api/site/codes/send', 'checkRoute' => '/api/site/codes/check'],
                'appSettings' => [
                    ['key' => 'account', 'label' => 'Account', 'type' => 'text', 'pattern' => 'AC[0-9]{4}', 'message' => 'Enter the account: AC and four digits.', 'importFrom' => 'sms.ACCOUNT'],
                    ['key' => 'token', 'label' => 'Token', 'type' => 'secret', 'missing' => 'Enter the token.', 'importFrom' => 'sms.TOKEN'],
                ],
            ],
        ];
    }

    /** The example plugin's code: what any plugin's backend would answer the site. */
    private function plugin(string $route, array $input): array
    {
        if ($this->override !== null && ($answer = ($this->override)($route, $input)) !== null) return $answer;
        $auth = ['basic' => ['user' => $input['appSettings']['account'], 'password' => ['secret' => 'token']]];
        $response = $input['response'] ?? null;
        return match ($route) {
            '/api/site/codes/send' => ['request' => ['method' => 'POST', 'url' => 'https://api.sms.example/v1/codes', 'form' => ['to' => $input['phone']], 'auth' => $auth], 'continue' => '/api/site/codes/sent'],
            '/api/site/codes/sent' => match (true) {
                $response['status'] === 202 => ['result' => 'sent', 'id' => $response['body']['id']],
                $response['status'] === 429 => ['result' => 'busy'],
                default => ['result' => 'unavailable'],
            },
            '/api/site/codes/check' => ['request' => ['method' => 'POST', 'url' => 'https://api.sms.example/v1/codes/' . $input['id'] . '/check', 'form' => ['code' => $input['code']], 'auth' => $auth], 'continue' => '/api/site/codes/checked'],
            '/api/site/codes/checked' => match (true) {
                $response['status'] === 404 => ['result' => 'expired'],
                $response['status'] === 429 => ['result' => 'busy'],
                $response['status'] !== 200 => ['result' => 'unavailable'],
                ($response['body']['valid'] ?? null) === true => ['result' => 'approved'],
                default => ['result' => 'wrong'],
            },
        };
    }

    private function native(): NativeAppService
    {
        $native = $this->createMock(NativeAppService::class);
        $native->method('readPrivateFile')->willReturnCallback(fn (string $app, string $name) => $this->files[$app][$name] ?? null);
        $native->method('writePrivateFile')->willReturnCallback(function (string $app, string $name, string $text) { $this->files[$app][$name] = $text; });
        $native->method('removePrivateFile')->willReturnCallback(function (string $app, string $name) { unset($this->files[$app][$name]); });
        $native->method('hostConfig')->willReturnCallback(fn () => $this->hostConfig);
        $native->method('installedManifest')->willReturnCallback(fn (string $appId) => $appId === self::PLUGIN_APP
            ? self::pluginManifest()
            : ($this->provider === null ? [] : ['config' => ['app' => ['verificationProvider' => $this->provider]]]));
        $native->method('withDatabase')->willReturnCallback(fn (string $app, callable $use) => $use($this->db));
        $native->method('withPrivateFileLock')->willReturnCallback(fn (string $app, string $name, callable $work) => $work());
        $native->method('privateFileNames')->willReturnCallback(fn (string $app, string $prefix) => array_values(array_filter(array_keys($this->files[$app] ?? []), fn (string $name) => str_starts_with($name, $prefix))));
        $native->method('request')->willReturnCallback(function (string $appId, array $request): array {
            $this->assertSame(self::PLUGIN_APP, $appId, 'only the plugin is called through the network');
            if ($this->slotsBusy) throw new \RuntimeException('Every worker is busy. Try again shortly.', 429);
            $input = json_decode(json_encode($request['body'], JSON_THROW_ON_ERROR), true);
            $this->handed[] = ['route' => $request['path'], 'input' => $input];
            return ['status' => 200, 'body' => $this->plugin($request['path'], $input)];
        });
        return $native;
    }

    private function service(): NativePhoneVerification
    {
        $native = $this->native();
        $plugins = new PluginService($this->plugins, $this->createMock(AppService::class), $native);
        $network = new PluginNetwork($native, function (array $request): array {
            $this->sent[] = $request;
            return array_shift($this->answers) ?? ['status' => 500, 'body' => ''];
        }, fn () => $this->addresses, fn () => null);
        $settings = new PluginAppSettings($native);
        // Wired as the site wires it: the old details' one place among it.
        return new NativePhoneVerification($native, $plugins, $settings, $network, new LegacyPhoneVerification($native, $plugins, $settings), fn () => $this->now);
    }

    /** The app's backend, as Coffee.Dating handles these two routes once the host has spoken. */
    private function backend(array $request): callable
    {
        return function (array $context) use ($request): array {
            $this->contexts[] = $context;
            if ($request['path'] === '/api/auth/send-code') {
                if (($request['body']['phone'] ?? '') === 'refuse') return ['status' => 429, 'body' => (object) ['error' => 'Too many code requests.']];
                $id = bin2hex(random_bytes(16));
                $this->db->prepare("INSERT INTO otp_challenges(id, phone, code_hash, state, created_at, expires_at) VALUES(?,?,?,?,?,?)")
                    ->execute([$id, self::PHONE, ($context['verificationProvider'] ?? null) === 'example-sms' ? 'verify:pending' : 'local', 'queued', $this->now, $this->now + 600]);
                return ['status' => 202, 'body' => (object) ['success' => true, 'challenge_id' => $id, 'expires_in' => 600]];
            }
            $approved = $context['verification'] ?? null;
            $challenge = $this->challenge();
            if (!$approved || $approved['challengeId'] !== $challenge['id'] || $approved['phone'] !== self::PHONE || $approved['sid'] !== substr($challenge['code_hash'], 7) || $approved['attempt'] !== (int) $challenge['attempts']) {
                return ['status' => 401, 'body' => (object) ['error' => 'Code expired or invalid.']];
            }
            $this->db->prepare("UPDATE otp_challenges SET state='used' WHERE id=?")->execute([$challenge['id']]);
            return ['status' => 200, 'body' => (object) ['token' => 'session-token']];
        };
    }

    private function challenge(): array
    {
        return $this->db->query('SELECT * FROM otp_challenges ORDER BY rowid DESC LIMIT 1')->fetch();
    }

    /** The plugin installed, and the owner's settings for it. */
    private function configure(NativePhoneVerification $service, string $token = 'secret-token'): void
    {
        $this->plugins->plugin('example.codes', self::PLUGIN_APP);
        $service->save('app', ['account' => self::ACCOUNT, 'token' => $token]);
    }

    private static function sent(string $id): array
    {
        return ['status' => 202, 'body' => json_encode(['id' => $id])];
    }

    private function send(NativePhoneVerification $service, string $phone = '0412 345 678'): array
    {
        $request = ['method' => 'POST', 'path' => '/api/auth/send-code', 'body' => ['phone' => $phone]];
        return $service->handle('app', $request, $this->backend($request));
    }

    private function verify(NativePhoneVerification $service, string $code = '123456', ?string $id = null): array
    {
        $request = ['method' => 'POST', 'path' => '/api/auth/verify', 'body' => ['phone' => '0412 345 678', 'challenge_id' => $id ?? $this->challenge()['id'], 'code' => $code]];
        return $service->handle('app', $request, $this->backend($request));
    }

    public function testOnlyTheTwoSignInRequestsOfAnAppThatNamesAProviderAreItsToAnswer(): void
    {
        $service = $this->service();
        $this->assertTrue($service->applies('app', ['method' => 'POST', 'path' => '/api/auth/send-code']));
        $this->assertTrue($service->applies('app', ['method' => 'POST', 'path' => '/api/auth/verify']));
        $this->assertFalse($service->applies('app', ['method' => 'GET', 'path' => '/api/auth/verify']));
        $this->assertFalse($service->applies('app', ['method' => 'POST', 'path' => '/api/profile']));
        // In development the app shows its own codes, and nothing is sent.
        $this->hostConfig['development'] = true;
        $this->assertFalse($service->applies('app', ['method' => 'POST', 'path' => '/api/auth/send-code']));
        $this->hostConfig['development'] = false;
        $this->provider = null;
        $this->assertFalse($service->applies('app', ['method' => 'POST', 'path' => '/api/auth/send-code']), 'an app that names no provider');
    }

    public function testNothingIsAdmittedOrSentUntilAPluginSendsThemAndTheOwnerHasSetItUp(): void
    {
        $service = $this->service();
        $result = $this->send($service);
        $this->assertSame([503, 'Sign-in messaging is not configured yet.', 'verification_unavailable'], [$result['status'], $result['body']->error, $result['body']->code], 'no plugin sends them');
        $this->plugins->plugin('example.codes', self::PLUGIN_APP);
        $this->assertSame(503, $this->send($service)['status'], 'the owner has not set it up');
        $this->assertSame('Enter the token.', $this->refusalOf(fn () => $service->save('app', ['account' => self::ACCOUNT])));
        $this->provider = 'other-sms';
        $this->assertSame(503, $this->send($service)['status'], 'no plugin sends the provider this app names');
        $this->assertSame([], $this->contexts, 'the backend was not asked');
        $this->assertSame([], $this->sent);
        $this->assertSame([], $this->handed);
    }

    public function testAPluginTheAdministratorTurnedOffSendsNothing(): void
    {
        $service = $this->service();
        $this->configure($service);
        $this->plugins->getConnection()->exec('UPDATE plugins SET enabled = 0');
        $this->assertSame(503, ($fresh = $this->service())->handle('app', ['method' => 'POST', 'path' => '/api/auth/send-code', 'body' => []], fn () => $this->fail('the backend is not asked'))['status']);
        $this->assertFalse($fresh->describe('app')['plugin']['enabled']);
        $this->assertSame([], $this->sent);
    }

    public function testACodeIsSentOnlyForARequestTheAppAdmitted(): void
    {
        $service = $this->service();
        $this->configure($service);
        $refused = $this->send($service, 'refuse');
        $this->assertSame(429, $refused['status']);
        $this->assertSame([], $this->sent, 'the app\'s own limits stand before the owner\'s bill');

        $this->answers[] = self::sent('code-1.a:b_c');
        $sent = $this->send($service);
        $this->assertSame(202, $sent['status']);
        $this->assertSame([['verificationProvider' => 'example-sms']], array_slice($this->contexts, -1));
        $this->assertSame('https://api.sms.example/v1/codes', $this->sent[0]['url']);
        $this->assertSame('to=%2B61412345678', $this->sent[0]['body']);
        $this->assertContains('Authorization: Basic ' . base64_encode(self::ACCOUNT . ':secret-token'), $this->sent[0]['headers']);
        $challenge = $this->challenge();
        $this->assertSame(['ready', 'verify:code-1.a:b_c'], [$challenge['state'], $challenge['code_hash']]);
        // What the plugin's code was handed: the number, the owner's settings but the secret, and the answer.
        $this->assertSame(['phone' => self::PHONE, 'appSettings' => ['account' => self::ACCOUNT]], array_intersect_key($this->handed[0]['input'], ['phone' => 1, 'appSettings' => 1]));
        $this->assertSame(202, $this->handed[1]['input']['response']['status']);
        $this->assertStringNotContainsString('secret-token', json_encode($this->handed));
    }

    public function testAProviderThatCannotSendFailsTheChallengeAndSaysSo(): void
    {
        $service = $this->service();
        $this->configure($service);
        $this->answers[] = ['status' => 429, 'body' => '{}'];
        $busy = $this->send($service);
        $this->assertSame([429, 'failed'], [$busy['status'], $this->challenge()['state']]);
        $this->answers[] = ['status' => 500, 'body' => 'oops'];
        $this->assertSame([503, 'failed'], [$this->send($service)['status'], $this->challenge()['state']]);
        // An id the site would not keep is no id: "pending" marks a code not sent, and an id is a safe word.
        foreach (['pending', '../x', str_repeat('a', 129), ''] as $id) {
            $this->answers[] = self::sent($id);
            $this->assertSame([503, 'failed'], [$this->send($service)['status'], $this->challenge()['state']], $id);
        }
        // A provider the site may not reach: refused, and the plugin is not called back.
        $this->addresses = ['10.0.0.8'];
        $calls = count($this->handed);
        $this->assertSame([503, 'failed'], [$this->send($service)['status'], $this->challenge()['state']]);
        $this->assertCount($calls + 1, $this->handed);
    }

    public function testAChallengeReplacedMeanwhileIsNotMadeReady(): void
    {
        $service = $this->service();
        $this->configure($service);
        $request = ['method' => 'POST', 'path' => '/api/auth/send-code', 'body' => ['phone' => '0412 345 678']];
        $backend = $this->backend($request);
        $this->answers[] = self::sent('code-2');
        $result = $service->handle('app', $request, function (array $context) use ($backend) {
            $answer = $backend($context);
            // A newer request for the number used this one up while the code was on its way.
            $this->db->exec("UPDATE otp_challenges SET state='used'");
            return $answer;
        });
        $this->assertSame([409, 'challenge_replaced'], [$result['status'], $result['body']->code]);
    }

    public function testAChallengeAlreadySentIsNeverSentAgain(): void
    {
        $service = $this->service();
        $this->configure($service);
        $this->answers[] = self::sent('code-3');
        $this->send($service);
        $id = $this->challenge()['id'];
        $calls = count($this->sent);
        // A backend that answers 202 again with a challenge it admitted before.
        $request = ['method' => 'POST', 'path' => '/api/auth/send-code', 'body' => ['phone' => '0412 345 678']];
        $again = $service->handle('app', $request, fn () => ['status' => 202, 'body' => (object) ['challenge_id' => $id]]);
        $this->assertSame([409, 'challenge_replaced'], [$again['status'], $again['body']->code]);
        $this->assertCount($calls, $this->sent);
    }

    public function testACodeIsCheckedByThePluginAndTheBackendToldItsAnswer(): void
    {
        $service = $this->service();
        $this->configure($service);
        $this->answers[] = self::sent('code-4');
        $this->send($service);
        $id = $this->challenge()['id'];

        $this->answers[] = ['status' => 200, 'body' => json_encode(['valid' => false])];
        $wrong = $this->verify($service, '000000');
        $this->assertSame([401, 'wrong_code'], [$wrong['status'], $wrong['body']->code]);
        $this->assertSame(1, (int) $this->challenge()['attempts'], 'counted before the plugin was asked');
        $this->assertSame('https://api.sms.example/v1/codes/code-4/check', end($this->sent)['url']);
        $this->assertSame(['id' => 'code-4', 'phone' => self::PHONE, 'code' => '000000', 'challenge' => $id], array_intersect_key(end($this->handed)['input'], ['id' => 1, 'phone' => 1, 'code' => 1, 'challenge' => 1]));

        $this->answers[] = ['status' => 200, 'body' => json_encode(['valid' => true])];
        $signedIn = $this->verify($service, '123456', $id);
        $this->assertSame(200, $signedIn['status']);
        $this->assertSame(['verification' => ['challengeId' => $id, 'phone' => self::PHONE, 'sid' => 'code-4', 'attempt' => 2]], end($this->contexts));
        $this->assertSame('used', $this->challenge()['state']);
        // Used is used.
        $this->assertSame(401, $this->verify($service, '123456', $id)['status']);
    }

    /** Only the word `approved` approves: a plugin's `true`, or anything else, is no approval. */
    public function testOnlyTheWordApprovedSignsAnyoneIn(): void
    {
        $service = $this->service();
        $this->configure($service);
        $this->answers[] = self::sent('code-6');
        $this->send($service);
        foreach ([true, 1, '1', 'APPROVED', ['approved'], null] as $said) {
            $this->override = fn (string $route) => $route === '/api/site/codes/check' ? ['result' => $said] : null;
            $result = $this->verify($service, '123456');
            $this->assertSame([503, 'verification_unavailable'], [$result['status'], $result['body']->code], json_encode($said));
        }
        $this->assertSame([['verificationProvider' => 'example-sms']], $this->contexts, 'the backend was never told of an approval');
        $this->assertSame('ready', $this->challenge()['state']);
    }

    /**
     * An attempt no code was checked on is given back: the plugin or its provider could not check it,
     * or every worker slot was busy. One that was checked (wrong, expired, the provider busy) stands.
     */
    public function testAnAttemptNoCodeWasCheckedOnIsGivenBack(): void
    {
        $service = $this->service();
        $this->configure($service);
        $this->answers[] = self::sent('code-7');
        $this->send($service);
        $this->answers[] = ['status' => 503, 'body' => '{}'];
        $this->assertSame(503, $this->verify($service)['status']);
        $this->assertSame(0, (int) $this->challenge()['attempts'], 'the provider was down');
        $this->slotsBusy = true;
        $this->assertSame(503, $this->verify($service)['status']);
        $this->assertSame(0, (int) $this->challenge()['attempts'], 'the plugin was not run');
        $this->slotsBusy = false;
        $this->answers[] = ['status' => 200, 'body' => json_encode(['valid' => false])];
        $this->assertSame(401, $this->verify($service)['status']);
        $this->assertSame(1, (int) $this->challenge()['attempts'], 'a wrong code stands');
        $this->answers[] = ['status' => 429, 'body' => '{}'];
        $this->assertSame(429, $this->verify($service)['status']);
        $this->assertSame(2, (int) $this->challenge()['attempts'], 'a busy provider stands');
        // Never below none: an attempt the challenge no longer counts is not given back twice.
        $this->override = function (string $route) {
            if ($route !== '/api/site/codes/check') return null;
            $this->db->exec('UPDATE otp_challenges SET attempts=0');
            return ['result' => 'unavailable'];
        };
        $this->assertSame(503, $this->verify($service)['status']);
        $this->assertSame(0, (int) $this->challenge()['attempts']);
        // Five tries still count to five.
        $this->override = null;
        for ($i = 0; $i < 5; $i++) {
            $this->answers[] = ['status' => 200, 'body' => json_encode(['valid' => false])];
            $this->verify($service, '000000');
        }
        $this->assertSame([429, 'rate_limited'], [($r = $this->verify($service))['status'], $r['body']->code]);
    }

    /**
     * With no plugin to send the app's codes any more, its owner is told details are kept, and may
     * forget them: every plugin's settings the app keeps, a removed one's too, and its old details.
     */
    public function testAnOwnerMayForgetDetailsNoPluginUsesNow(): void
    {
        $service = $this->service();
        $this->configure($service);
        $this->files['app']['verify.json'] = '{"provider":"twilio-verify"}';
        $this->files['app'][PluginAppSettings::fileName('gone.codes')] = '{"plugin":"gone.codes","values":{},"secrets":{}}';
        $this->assertFalse($service->describe('app')['keptWithoutPlugin']);
        // Its plugin removed: nothing sends the app's codes, and what is kept can be forgotten.
        $this->plugins->getConnection()->exec('DELETE FROM plugins');
        $service = $this->service();
        $shown = $service->describe('app');
        $this->assertSame([null, true], [$shown['plugin'], $shown['keptWithoutPlugin']]);
        $this->assertFalse($service->clear('app')['keptWithoutPlugin']);
        $this->assertSame([], $this->files['app']);
        // Or the app names no provider any more.
        $this->files['app'][PluginAppSettings::fileName('example.codes')] = '{"plugin":"example.codes"}';
        $this->provider = null;
        $this->assertTrue($service->describe('app')['keptWithoutPlugin']);
        $service->clear('app');
        $this->assertSame([], $this->files['app']);
    }

    /** Turning the codes off clears the plugin's settings for the app, and its old details with them. */
    public function testTurningTheCodesOffForgetsTheOldDetailsToo(): void
    {
        $service = $this->service();
        $this->configure($service);
        $this->files['app']['verify.json'] = '{"provider":"twilio-verify"}';
        $other = PluginAppSettings::fileName('other.codes');
        $this->files['app'][$other] = '{"plugin":"other.codes"}';
        $this->assertFalse($service->clear('app')['configured']);
        $this->assertSame([$other], array_keys($this->files['app']), 'another plugin\'s settings are its own');
    }

    public function testFiveAttemptsAndNoMore(): void
    {
        $service = $this->service();
        $this->configure($service);
        $this->answers[] = self::sent('code-5');
        $this->send($service);
        for ($i = 0; $i < 5; $i++) {
            $this->answers[] = ['status' => 200, 'body' => json_encode(['valid' => false])];
            $this->assertSame(401, $this->verify($service, '000000')['status']);
        }
        $calls = count($this->sent);
        $this->assertSame([429, 'rate_limited'], [($r = $this->verify($service, '123456'))['status'], $r['body']->code]);
        $this->assertCount($calls, $this->sent, 'the provider is not asked again');
        // A code the provider has forgotten (expired there) is an expired code; a busy one, busy.
        $this->db->exec('UPDATE otp_challenges SET attempts=0');
        $this->answers[] = ['status' => 404, 'body' => '{}'];
        $this->assertSame([401, 'invalid_code'], [($r = $this->verify($service))['status'], $r['body']->code]);
        $this->answers[] = ['status' => 429, 'body' => '{}'];
        $this->assertSame([429, 'verification_unavailable'], [($r = $this->verify($service))['status'], $r['body']->code]);
        $this->answers[] = ['status' => 503, 'body' => '{}'];
        $this->assertSame([503, 'verification_unavailable'], [($r = $this->verify($service))['status'], $r['body']->code]);
        // An expired challenge is never checked at all.
        $this->now += 601;
        $calls = count($this->sent);
        $this->assertSame(401, $this->verify($service)['status']);
        $this->assertCount($calls, $this->sent);
        // Nor one the site never marked as sent.
        $this->db->exec("UPDATE otp_challenges SET code_hash='verify:pending', expires_at=" . ($this->now + 600));
        $this->assertSame([401, 'invalid_code'], [($r = $this->verify($service))['status'], $r['body']->code]);
    }

    public function testTheOwnerSeesWhichPluginSendsTheCodesAndNeverASecret(): void
    {
        $service = $this->service();
        $this->assertSame(['provider' => 'example-sms', 'asked' => true, 'plugin' => null], array_slice($service->describe('app'), 0, 3));
        $this->assertStringContainsString('No plugin on this site sends sign-in codes for "example-sms"', $this->refusalOf(fn () => $service->save('app', ['account' => self::ACCOUNT, 'token' => 't'])));

        $this->plugins->plugin('example.codes', self::PLUGIN_APP);
        $shown = json_decode(json_encode($service->describe('app')), true);
        $this->assertSame(['id' => 'example.codes', 'name' => 'Plugin example.codes', 'label' => 'By example text', 'enabled' => true], $shown['plugin']);
        $this->assertSame(['account', 'token'], array_column($shown['fields'], 'key'));
        $this->assertArrayNotHasKey('pattern', $shown['fields'][0], 'its checks are the server\'s');
        $this->assertSame(['account' => 'sms.ACCOUNT', 'token' => 'sms.TOKEN'], $shown['imports']);
        $this->assertSame([['account' => ''], ['token' => false], false], [$shown['values'], $shown['kept'], $shown['configured']]);

        $this->assertSame('Enter the account: AC and four digits.', $this->refusalOf(fn () => $service->save('app', ['account' => 'AC12', 'token' => 'secret-token'])));
        $saved = json_decode(json_encode($service->save('app', ['account' => self::ACCOUNT, 'token' => 'secret-token'])), true);
        $this->assertSame([['account' => self::ACCOUNT], ['token' => true], true], [$saved['values'], $saved['kept'], $saved['configured']]);
        $this->assertStringNotContainsString('secret-token', json_encode($saved));
        $this->assertFalse($service->clear('app')['configured']);
    }

    public function testWhatAnEarlierHostKeptIsReadOnlyWhereThePluginSays(): void
    {
        $service = $this->service();
        $config = ['keyHex' => str_repeat('a', 64), 'sms' => ['ACCOUNT' => ' AC1234 ', 'TOKEN' => 'tok', 'OTHER' => 'not taken']];
        $this->assertNull($service->heldIn('app', $config), 'no plugin sends the app\'s codes');
        $this->plugins->plugin('example.codes', self::PLUGIN_APP);
        $this->assertSame(['account' => 'AC1234', 'token' => 'tok'], $service->heldIn('app', $config));
        $this->assertNull($service->heldIn('app', ['sms' => ['ACCOUNT' => 'AC1234', 'TOKEN' => '']]), 'every one it names, or none');
        $this->assertNull($service->heldIn('app', ['sms' => 'AC1234']));
        $service->check('app', $service->heldIn('app', $config));
        $this->assertSame('Enter the account: AC and four digits.', $this->refusalOf(fn () => $service->check('app', ['account' => 'nope', 'token' => 'tok'])));
        $this->assertSame([], $this->files, 'a check keeps nothing');
        $this->provider = null;
        $this->assertNull($service->heldIn('app', $config));
    }

    private function refusalOf(callable $act): string
    {
        try {
            $act();
        } catch (\InvalidArgumentException $e) {
            return $e->getMessage();
        }
        return 'taken';
    }
}
