<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Services\NativeAppService;
use FormLogic\Services\NativePhoneVerification;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * A SoftN app's phone sign-in codes through its owner's Twilio Verify, as SoftN's operator adapter
 * (Coffee.Dating's verify.mjs) does: the app's backend admits a request before a text is paid for,
 * the attempt is counted before the provider is asked, the backend learns only the provider's
 * answer, and the owner's token never leaves the server.
 */
final class NativePhoneVerificationTest extends TestCase
{
    // Made up, and written in two parts so that nothing mistakes them for real ones.
    private const ACCOUNT = 'AC' . '0123456789abcdef0123456789abcdef';
    private const SERVICE = 'VA' . '0123456789abcdef0123456789abcdef';
    private const PHONE = '+61412345678';

    private PDO $db;
    /** @var array<string,string> the app's private files */
    private array $files = [];
    /** @var list<array{url: string, fields: array, account: string, token: string}> */
    private array $calls = [];
    /** @var list<array{status: int, body: string}> what the provider answers next */
    private array $answers = [];
    /** @var list<array> the contexts the backend was run with */
    private array $contexts = [];
    private int $now = 1_800_000_000;
    private array $hostConfig = ['development' => false];
    private array $saved = [];

    protected function setUp(): void
    {
        $this->saved = ['env' => getenv('DATA_ENCRYPTION_KEY'), 'ENV' => $_ENV['DATA_ENCRYPTION_KEY'] ?? null];
        putenv('DATA_ENCRYPTION_KEY');
        unset($_ENV['DATA_ENCRYPTION_KEY']);
        $this->db = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
        $this->db->exec("CREATE TABLE otp_challenges(id TEXT PRIMARY KEY, phone TEXT NOT NULL, code_hash TEXT NOT NULL, ip_hash TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER, expires_at INTEGER)");
    }

    protected function tearDown(): void
    {
        if ($this->saved['env'] === false) putenv('DATA_ENCRYPTION_KEY'); else putenv('DATA_ENCRYPTION_KEY=' . $this->saved['env']);
        if ($this->saved['ENV'] === null) unset($_ENV['DATA_ENCRYPTION_KEY']); else $_ENV['DATA_ENCRYPTION_KEY'] = $this->saved['ENV'];
    }

    private function service(bool $asked = true): NativePhoneVerification
    {
        $native = $this->createMock(NativeAppService::class);
        $native->method('readPrivateFile')->willReturnCallback(fn(string $app, string $name) => $this->files[$name] ?? null);
        $native->method('writePrivateFile')->willReturnCallback(function (string $app, string $name, string $text) { $this->files[$name] = $text; });
        $native->method('removePrivateFile')->willReturnCallback(function (string $app, string $name) { unset($this->files[$name]); });
        $native->method('hostConfig')->willReturnCallback(fn() => $this->hostConfig);
        $native->method('installedManifest')->willReturn($asked ? ['config' => ['app' => ['verificationProvider' => 'twilio-verify']]] : []);
        $native->method('withDatabase')->willReturnCallback(fn(string $app, callable $use) => $use($this->db));
        $transport = function (string $url, array $fields, string $account, string $token): array {
            $this->calls[] = ['url' => $url, 'fields' => $fields, 'account' => $account, 'token' => $token];
            return array_shift($this->answers) ?? ['status' => 500, 'body' => ''];
        };
        return new NativePhoneVerification($native, \Closure::fromCallable($transport), fn() => $this->now);
    }

    /** The app's backend, as Coffee.Dating's handles these two routes once the host has spoken. */
    private function backend(array $request): callable
    {
        return function (array $context) use ($request): array {
            $this->contexts[] = $context;
            if ($request['path'] === '/api/auth/send-code') {
                if (($request['body']['phone'] ?? '') === 'refuse') return ['status' => 429, 'body' => (object) ['error' => 'Too many code requests.']];
                $id = bin2hex(random_bytes(16));
                $this->db->prepare("INSERT INTO otp_challenges(id, phone, code_hash, state, created_at, expires_at) VALUES(?,?,?,?,?,?)")
                    ->execute([$id, self::PHONE, ($context['verificationProvider'] ?? null) === 'twilio-verify' ? 'verify:pending' : 'local', 'queued', $this->now, $this->now + 600]);
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

    private function configure(NativePhoneVerification $service): void
    {
        $service->save('app', self::ACCOUNT, self::SERVICE, 'secret-auth-token');
    }

    private static function provider(array $fields): array
    {
        return ['status' => 201, 'body' => json_encode($fields + ['service_sid' => self::SERVICE, 'to' => self::PHONE])];
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

    public function testOnlyTheTwoSignInRequestsOfAnAppThatAsksAreItsToAnswer(): void
    {
        $service = $this->service();
        $this->assertTrue($service->applies('app', ['method' => 'POST', 'path' => '/api/auth/send-code']));
        $this->assertTrue($service->applies('app', ['method' => 'POST', 'path' => '/api/auth/verify']));
        $this->assertFalse($service->applies('app', ['method' => 'GET', 'path' => '/api/auth/verify']));
        $this->assertFalse($service->applies('app', ['method' => 'POST', 'path' => '/api/profile']));
        $this->assertFalse($this->service(false)->applies('app', ['method' => 'POST', 'path' => '/api/auth/send-code']), 'an app that names no provider');
        // In development the app shows its own codes, and nothing is sent.
        $this->hostConfig['development'] = true;
        $this->assertFalse($service->applies('app', ['method' => 'POST', 'path' => '/api/auth/send-code']));
    }

    public function testNothingIsAdmittedOrSentUntilTheOwnerHasSetItUp(): void
    {
        $result = $this->send($this->service());
        $this->assertSame(503, $result['status']);
        $this->assertSame('verification_unavailable', $result['body']->code);
        $this->assertSame([], $this->contexts, 'the backend was not asked');
        $this->assertSame([], $this->calls);
    }

    public function testATextIsSentOnlyForARequestTheAppAdmitted(): void
    {
        $service = $this->service();
        $this->configure($service);
        $refused = $this->send($service, 'refuse');
        $this->assertSame(429, $refused['status']);
        $this->assertSame([], $this->calls, 'the app\'s own limits stand before the owner\'s SMS bill');

        $this->answers[] = self::provider(['status' => 'pending', 'sid' => 'VE' . str_repeat('a', 32)]);
        $sent = $this->send($service);
        $this->assertSame(202, $sent['status']);
        $this->assertSame([['verificationProvider' => 'twilio-verify']], array_slice($this->contexts, -1));
        $this->assertSame('https://verify.twilio.com/v2/Services/' . self::SERVICE . '/Verifications', $this->calls[0]['url']);
        $this->assertSame(['To' => self::PHONE, 'Channel' => 'sms'], $this->calls[0]['fields']);
        $this->assertSame([self::ACCOUNT, 'secret-auth-token'], [$this->calls[0]['account'], $this->calls[0]['token']]);
        $challenge = $this->challenge();
        $this->assertSame(['ready', 'verify:VE' . str_repeat('a', 32)], [$challenge['state'], $challenge['code_hash']]);
    }

    public function testAProviderThatCannotSendFailsTheChallengeAndSaysSo(): void
    {
        $service = $this->service();
        $this->configure($service);
        $this->answers[] = ['status' => 429, 'body' => '{}'];
        $busy = $this->send($service);
        $this->assertSame([429, 'failed'], [$busy['status'], $this->challenge()['state']]);
        $this->answers[] = ['status' => 500, 'body' => 'oops'];
        $this->assertSame(503, $this->send($service)['status']);
        // An answer that is not for this service or this number is no answer.
        $this->answers[] = ['status' => 201, 'body' => json_encode(['status' => 'pending', 'sid' => 'VE' . str_repeat('b', 32), 'service_sid' => self::SERVICE, 'to' => '+61400000000'])];
        $this->assertSame([503, 'failed'], [$this->send($service)['status'], $this->challenge()['state']]);
    }

    public function testAChallengeReplacedMeanwhileIsNotMadeReady(): void
    {
        $service = $this->service();
        $this->configure($service);
        $request = ['method' => 'POST', 'path' => '/api/auth/send-code', 'body' => ['phone' => '0412 345 678']];
        $backend = $this->backend($request);
        $this->answers[] = self::provider(['status' => 'pending', 'sid' => 'VE' . str_repeat('c', 32)]);
        $result = $service->handle('app', $request, function (array $context) use ($backend) {
            $answer = $backend($context);
            // A newer request for the number used this one up while the text was on its way.
            $this->db->exec("UPDATE otp_challenges SET state='used'");
            return $answer;
        });
        $this->assertSame(409, $result['status']);
        $this->assertSame('challenge_replaced', $result['body']->code);
    }

    public function testAChallengeAlreadySentIsNeverTextedAgain(): void
    {
        $service = $this->service();
        $this->configure($service);
        $this->answers[] = self::provider(['status' => 'pending', 'sid' => 'VE' . str_repeat('9', 32)]);
        $this->send($service);
        $id = $this->challenge()['id'];
        $calls = count($this->calls);
        // A backend that answers 202 again with a challenge it admitted before.
        $request = ['method' => 'POST', 'path' => '/api/auth/send-code', 'body' => ['phone' => '0412 345 678']];
        $again = $service->handle('app', $request, fn() => ['status' => 202, 'body' => (object) ['challenge_id' => $id]]);
        $this->assertSame([409, 'challenge_replaced'], [$again['status'], $again['body']->code]);
        $this->assertCount($calls, $this->calls);
    }

    public function testACodeIsCheckedWithTheProviderAndTheBackendToldItsAnswer(): void

    {
        $service = $this->service();
        $this->configure($service);
        $sid = 'VE' . str_repeat('d', 32);
        $this->answers[] = self::provider(['status' => 'pending', 'sid' => $sid]);
        $this->send($service);
        $id = $this->challenge()['id'];

        $this->answers[] = self::provider(['status' => 'pending', 'sid' => $sid]);
        $wrong = $this->verify($service, '000000');
        $this->assertSame([401, 'wrong_code'], [$wrong['status'], $wrong['body']->code]);
        $this->assertSame(1, (int) $this->challenge()['attempts'], 'counted before the provider was asked');
        $this->assertSame(['VerificationSid' => $sid, 'Code' => '000000'], end($this->calls)['fields']);

        $this->answers[] = self::provider(['status' => 'approved', 'sid' => $sid]);
        $signedIn = $this->verify($service, '123456', $id);
        $this->assertSame(200, $signedIn['status']);
        $this->assertSame(['verification' => ['challengeId' => $id, 'phone' => self::PHONE, 'sid' => $sid, 'attempt' => 2]], end($this->contexts));
        $this->assertSame('used', $this->challenge()['state']);
        // Used is used.
        $this->assertSame(401, $this->verify($service, '123456', $id)['status']);
    }

    public function testFiveAttemptsAndNoMore(): void
    {
        $service = $this->service();
        $this->configure($service);
        $sid = 'VE' . str_repeat('e', 32);
        $this->answers[] = self::provider(['status' => 'pending', 'sid' => $sid]);
        $this->send($service);
        for ($i = 0; $i < 5; $i++) {
            $this->answers[] = self::provider(['status' => 'pending', 'sid' => $sid]);
            $this->assertSame(401, $this->verify($service, '000000')['status']);
        }
        $calls = count($this->calls);
        $this->assertSame([429, 'rate_limited'], [($r = $this->verify($service, '123456'))['status'], $r['body']->code]);
        $this->assertCount($calls, $this->calls, 'the provider is not asked again');
        // A verification the provider has forgotten (expired there) is an expired code.
        $this->db->exec('UPDATE otp_challenges SET attempts=0');
        $this->answers[] = ['status' => 404, 'body' => '{}'];
        $this->assertSame([401, 'invalid_code'], [($r = $this->verify($service))['status'], $r['body']->code]);
        // An expired challenge is never checked at all.
        $this->now += 601;
        $calls = count($this->calls);
        $this->assertSame(401, $this->verify($service)['status']);
        $this->assertCount($calls, $this->calls);
    }

    public function testTheOwnerSeesTheIdsAndNeverTheToken(): void
    {
        $service = $this->service();
        $this->assertSame(['provider' => 'twilio-verify', 'configured' => false, 'accountSid' => null, 'serviceSid' => null, 'asked' => true], $service->describe('app'));
        foreach ([['AC123', self::SERVICE, 'x'], [self::ACCOUNT, 'VA123', 'x'], [self::ACCOUNT, self::SERVICE, '']] as [$account, $verify, $token]) {
            try { $service->save('app', $account, $verify, $token); $this->fail('taken'); } catch (\InvalidArgumentException) { $this->assertArrayNotHasKey('verify.json', $this->files); }
        }
        $shown = $service->save('app', self::ACCOUNT, self::SERVICE, 'secret-auth-token');
        $this->assertSame(['provider' => 'twilio-verify', 'configured' => true, 'accountSid' => self::ACCOUNT, 'serviceSid' => self::SERVICE, 'asked' => true], $shown);
        $this->assertStringNotContainsString('secret-auth-token', json_encode($shown));
        // A new service id keeps the token already kept.
        $other = 'VA' . str_repeat('f', 32);
        $service->save('app', self::ACCOUNT, $other, '');
        $this->answers[] = ['status' => 201, 'body' => json_encode(['status' => 'pending', 'sid' => 'VE' . str_repeat('a', 32), 'service_sid' => $other, 'to' => self::PHONE])];
        $this->send($service);
        $this->assertSame('secret-auth-token', end($this->calls)['token']);
        $service->clear('app');
        $this->assertFalse($service->describe('app')['configured']);
    }

    public function testWithASiteDataKeyTheTokenIsKeptSealed(): void
    {
        $key = \FormLogic\Support\DataEncryption::generateKey();
        putenv('DATA_ENCRYPTION_KEY=' . $key);
        $_ENV['DATA_ENCRYPTION_KEY'] = $key;
        $service = $this->service();
        $this->configure($service);
        $this->assertStringNotContainsString('secret-auth-token', $this->files['verify.json']);
        $this->assertTrue(json_decode($this->files['verify.json'], true)['sealed']);
        $this->answers[] = self::provider(['status' => 'pending', 'sid' => 'VE' . str_repeat('a', 32)]);
        $this->send($service);
        $this->assertSame('secret-auth-token', end($this->calls)['token']);
    }
}
