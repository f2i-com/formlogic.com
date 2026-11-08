<?php

declare(strict_types=1);

namespace FormLogic\Services;

use PDO;
use RuntimeException;

/**
 * Phone sign-in codes by text for a SoftN app, through the app owner's Twilio Verify service: the
 * "twilio-verify" provider an app names in its manifest (`config.app.verificationProvider`), as
 * Coffee.Dating does. SoftN leaves delivery to the host's operator (its PHP host's
 * operator/verify.mjs did this for Coffee.Dating); FormLogic is that operator here.
 *
 * The owner gives their Twilio account SID, Verify service SID and auth token (the app's Settings).
 * They are kept in the app's private folder, the token sealed with the site's data key where one is
 * set, and none of it ever reaches the app's code, its page, a log or an answer: the app's backend
 * learns only what the provider decided, in its request context.
 *
 * The contract, the one the app's backend and SoftN's operator adapter share:
 *  - POST /api/auth/send-code: the backend is asked first, with `req.context.verificationProvider`
 *    set. It applies its own limits (per phone, per address, overall) and, if it admits the request,
 *    answers 202 with `challenge_id`, having stored the challenge in `otp_challenges` as `queued`
 *    with `code_hash` `verify:pending`. Only then is a text sent (so the app's limits stand between
 *    a caller and the owner's SMS bill), and the challenge becomes `ready` with the provider's id.
 *  - POST /api/auth/verify: the attempt is counted on the challenge before the provider is asked
 *    (five at most), and the backend is told the provider's yes in `req.context.verification`
 *    (`challengeId`, `phone`, `sid`, `attempt`), which it checks against the challenge it stored.
 *
 * An app in development (its host configuration says so: never set by FormLogic) shows its own codes
 * and is passed straight through, as is every other request.
 */
final class NativePhoneVerification
{
    public const PROVIDER = 'twilio-verify';
    public const PATHS = ['/api/auth/send-code', '/api/auth/verify'];
    private const SETTINGS_FILE = 'verify.json';
    private const SEAL_CONTEXT = 'native-app-verify:';
    private const ENDPOINT = 'https://verify.twilio.com/v2/Services/';
    private const ACCOUNT = '/^AC[0-9a-fA-F]{32}$/D';
    private const SERVICE = '/^VA[0-9a-fA-F]{32}$/D';
    private const VERIFICATION = '/^VE[0-9a-fA-F]{32}$/D';

    /**
     * @param ?\Closure(string $url, array<string,string> $fields, string $accountSid, string $authToken): array{status: int, body: string} $transport
     *   How a request reaches the provider: tests give a fake one. Production has none, and uses curl.
     * @param ?\Closure(): int $clock seconds, for tests
     */
    public function __construct(private NativeAppService $native, private ?\Closure $transport = null, private ?\Closure $clock = null) {}

    // ---------------------------------------------------------------- settings (the owner's)

    /** What the owner sees: whether it is set up, and the two ids, never the token. */
    public function describe(string $appId): array
    {
        $settings = $this->settings($appId);
        return [
            'provider' => self::PROVIDER,
            'configured' => $settings !== null,
            'accountSid' => $settings['accountSid'] ?? null,
            'serviceSid' => $settings['serviceSid'] ?? null,
            'asked' => $this->asked($appId),
        ];
    }

    /** The details are ones Twilio gives: refused here as save() would refuse them. An empty token is checked by save(). */
    public static function assertDetails(mixed $accountSid, mixed $serviceSid, mixed $authToken): void
    {
        $accountSid = is_string($accountSid) ? trim($accountSid) : '';
        $serviceSid = is_string($serviceSid) ? trim($serviceSid) : '';
        $authToken = is_string($authToken) ? trim($authToken) : '';
        if (!preg_match(self::ACCOUNT, $accountSid)) throw new \InvalidArgumentException('Enter the Twilio account SID: AC followed by 32 letters and digits, from the Twilio console.');
        if (!preg_match(self::SERVICE, $serviceSid)) throw new \InvalidArgumentException('Enter the Verify service SID: VA followed by 32 letters and digits, from Twilio Verify → Services.');
        if ($authToken !== '' && (strlen($authToken) > 128 || !preg_match('/^[\x21-\x7e]+$/D', $authToken))) throw new \InvalidArgumentException('That auth token is not one Twilio gives.');
    }

    /**
     * Keep the owner's Twilio details for the app. An empty token keeps the one already kept: the
     * owner never sees it again, so changing an id must not ask for it.
     */
    public function save(string $appId, mixed $accountSid, mixed $serviceSid, mixed $authToken): array
    {
        self::assertDetails($accountSid, $serviceSid, $authToken);
        $accountSid = trim((string) $accountSid);
        $serviceSid = trim((string) $serviceSid);
        $authToken = is_string($authToken) ? trim($authToken) : '';
        if ($authToken === '') {
            $kept = $this->settings($appId);
            if ($kept === null) throw new \InvalidArgumentException('Enter the Twilio auth token.');
            $authToken = $kept['authToken'];
        }
        $encryption = \FormLogic\Support\DataEncryption::fromEnvironment();
        $stored = $encryption->enabled()
            ? ['authToken' => $encryption->seal($authToken, self::SEAL_CONTEXT . $appId), 'sealed' => true]
            : ['authToken' => $authToken, 'sealed' => false];
        $this->native->writePrivateFile($appId, self::SETTINGS_FILE, json_encode(['provider' => self::PROVIDER, 'accountSid' => $accountSid, 'serviceSid' => $serviceSid] + $stored, JSON_THROW_ON_ERROR));
        return $this->describe($appId);
    }

    public function clear(string $appId): array
    {
        $this->native->removePrivateFile($appId, self::SETTINGS_FILE);
        return $this->describe($appId);
    }

    /** @return array{accountSid: string, serviceSid: string, authToken: string}|null */
    private function settings(string $appId): ?array
    {
        $text = $this->native->readPrivateFile($appId, self::SETTINGS_FILE);
        if ($text === null) return null;
        $kept = json_decode($text, true);
        if (!is_array($kept) || ($kept['provider'] ?? null) !== self::PROVIDER || !is_string($kept['accountSid'] ?? null) || !is_string($kept['serviceSid'] ?? null) || !is_string($kept['authToken'] ?? null)) return null;
        $token = $kept['authToken'];
        if (($kept['sealed'] ?? false) === true) {
            try { $token = \FormLogic\Support\DataEncryption::fromEnvironment()->open($token, self::SEAL_CONTEXT . $appId); }
            catch (\Throwable) { return null; }
        }
        return ['accountSid' => $kept['accountSid'], 'serviceSid' => $kept['serviceSid'], 'authToken' => $token];
    }

    /** Whether the installed app names this provider for its sign-in codes. */
    public function asked(string $appId): bool
    {
        try { $manifest = $this->native->installedManifest($appId); } catch (\Throwable) { return false; }
        return ($manifest['config']['app']['verificationProvider'] ?? null) === self::PROVIDER;
    }

    // ---------------------------------------------------------------- requests (the app's visitors)

    /** Whether this is a request for the provider to answer: its path, the app asking, and not in development. */
    public function applies(string $appId, array $request): bool
    {
        return ($request['method'] ?? '') === 'POST' && in_array($request['path'] ?? '', self::PATHS, true)
            && ($this->native->hostConfig($appId)['development'] ?? false) !== true && $this->asked($appId);
    }

    /**
     * Answer a sign-in request through the provider. $invoke runs the app's backend with the given
     * context added to its own, and answers `['status' => int, 'body' => mixed]`.
     *
     * @param callable(array): array $invoke
     */
    public function handle(string $appId, array $request, callable $invoke): array
    {
        $settings = $this->settings($appId);
        // Not set up: refused before any challenge is admitted or a text is paid for.
        if ($settings === null) return self::fail(503, 'Sign-in messaging is not configured yet.', 'verification_unavailable');
        return ($request['path'] ?? '') === '/api/auth/send-code' ? $this->sendCode($appId, $settings, $invoke) : $this->verify($appId, $request, $settings, $invoke);
    }

    private function sendCode(string $appId, array $settings, callable $invoke): array
    {
        $result = $invoke(['verificationProvider' => self::PROVIDER]);
        if ((int) ($result['status'] ?? 0) !== 202) return $result;
        $id = self::field($result['body'] ?? null, 'challenge_id');
        if (!is_string($id) || !preg_match('/^\w{32}$/D', $id)) return self::fail(503, 'We could not send a code. Please try again shortly.', 'verification_unavailable');
        $challenge = $this->native->withDatabase($appId, static function (PDO $db) use ($id) {
            $statement = $db->prepare('SELECT * FROM otp_challenges WHERE id=?');
            $statement->execute([$id]);
            return $statement->fetch(PDO::FETCH_ASSOC) ?: null;
        });
        if (!is_array($challenge) || !is_string($challenge['phone'] ?? null)) return self::fail(503, 'We could not send a code. Please try again shortly.', 'verification_unavailable');
        // Only a challenge the backend has just admitted, waiting for its text: one it answered for
        // again (an earlier one, or one already sent) is never texted a second time.
        if (($challenge['state'] ?? null) !== 'queued' || ($challenge['code_hash'] ?? null) !== 'verify:pending') return self::fail(409, 'A newer code was requested. Use the latest sign-in request.', 'challenge_replaced');
        try {
            $sid = $this->start($settings, $challenge['phone']);
        } catch (RuntimeException $error) {
            $this->native->withDatabase($appId, static fn(PDO $db) => $db->prepare("UPDATE otp_challenges SET state='failed' WHERE id=? AND state='queued'")->execute([$id]));
            return self::fail($error->getCode() === 429 ? 429 : 503, 'We could not send a code. Please try again shortly.', 'verification_unavailable');
        }
        $now = $this->now();
        $updated = $this->native->withDatabase($appId, static function (PDO $db) use ($sid, $id, $now) {
            $statement = $db->prepare("UPDATE otp_challenges SET code_hash=?, state='ready' WHERE id=? AND state='queued' AND code_hash='verify:pending' AND expires_at>?");
            $statement->execute(['verify:' . $sid, $id, $now]);
            return $statement->rowCount();
        });
        if (!$updated) return self::fail(409, 'A newer code was requested. Use the latest sign-in request.', 'challenge_replaced');
        return $result;
    }

    private function verify(string $appId, array $request, array $settings, callable $invoke): array
    {
        $body = $request['body'] ?? null;
        $id = self::field($body, 'challenge_id');
        $code = self::field($body, 'code');
        if (!is_string($id) || !preg_match('/^\w{32}$/D', $id) || !is_string($code) || !preg_match('/^\d{4,10}$/D', $code)) return self::fail(400, 'Enter your code.', 'invalid_request');
        $now = $this->now();
        // The attempt is counted before the provider is asked, in its own transaction: no SQLite
        // lock is held while the provider answers.
        $reserved = $this->native->withDatabase($appId, static function (PDO $db) use ($id, $now) {
            $db->exec('BEGIN IMMEDIATE');
            try {
                $statement = $db->prepare('SELECT * FROM otp_challenges WHERE id=?');
                $statement->execute([$id]);
                $challenge = $statement->fetch(PDO::FETCH_ASSOC) ?: null;
                if (!$challenge || (int) $challenge['expires_at'] <= $now || in_array($challenge['state'], ['used', 'failed'], true) || !preg_match('/^verify:VE[0-9a-fA-F]{32}$/D', (string) $challenge['code_hash'])) { $db->exec('COMMIT'); return self::fail(401, 'Code expired or invalid. Request a new one.', 'invalid_code'); }
                if ($challenge['state'] !== 'ready') { $db->exec('COMMIT'); return self::fail(409, 'Your code is still being sent. Try again shortly.', 'verification_pending'); }
                if ((int) $challenge['attempts'] >= 5) { $db->exec('COMMIT'); return self::fail(429, 'Too many attempts. Request a new code.', 'rate_limited'); }
                $db->prepare('UPDATE otp_challenges SET attempts=attempts+1 WHERE id=?')->execute([$id]);
                $db->exec('COMMIT');
                return ['challenge' => $challenge];
            } catch (\Throwable $error) {
                $db->exec('ROLLBACK');
                throw $error;
            }
        });
        if (!isset($reserved['challenge'])) return $reserved;
        $challenge = $reserved['challenge'];
        $sid = substr((string) $challenge['code_hash'], 7);
        try {
            if (!$this->check($settings, $sid, (string) $challenge['phone'], $code)) return self::fail(401, 'That code is not correct.', 'wrong_code');
        } catch (RuntimeException $error) {
            if ($error->getCode() === 404) return self::fail(401, 'Code expired or invalid. Request a new one.', 'invalid_code');
            return self::fail($error->getCode() === 429 ? 429 : 503, 'We could not check your code. Please try again shortly.', 'verification_unavailable');
        }
        // The phone is the challenge's: the backend compares it with the one it was sent, so a code
        // for one number never signs in another.
        return $invoke(['verification' => ['challengeId' => $id, 'phone' => (string) $challenge['phone'], 'sid' => $sid, 'attempt' => (int) $challenge['attempts'] + 1]]);
    }

    // ---------------------------------------------------------------- the provider

    private function start(array $settings, string $phone): string
    {
        $answer = $this->post($settings, 'Verifications', ['To' => $phone, 'Channel' => 'sms']);
        if (($answer['status'] ?? null) !== 'pending' || !is_string($answer['sid'] ?? null) || !preg_match(self::VERIFICATION, $answer['sid']) || ($answer['service_sid'] ?? null) !== $settings['serviceSid'] || ($answer['to'] ?? null) !== $phone) {
            throw new RuntimeException('Invalid verification response', 502);
        }
        return $answer['sid'];
    }

    private function check(array $settings, string $sid, string $phone, string $code): bool
    {
        $answer = $this->post($settings, 'VerificationCheck', ['VerificationSid' => $sid, 'Code' => $code]);
        return ($answer['status'] ?? null) === 'approved' && ($answer['sid'] ?? null) === $sid && ($answer['service_sid'] ?? null) === $settings['serviceSid'] && ($answer['to'] ?? null) === $phone;
    }

    /** One call to the provider: its JSON answer, or a RuntimeException carrying its status. */
    private function post(array $settings, string $endpoint, array $fields): array
    {
        $url = self::ENDPOINT . rawurlencode($settings['serviceSid']) . '/' . $endpoint;
        $reply = $this->transport !== null
            ? ($this->transport)($url, $fields, $settings['accountSid'], $settings['authToken'])
            : self::curl($url, $fields, $settings['accountSid'], $settings['authToken']);
        $status = (int) ($reply['status'] ?? 0);
        if ($status < 200 || $status >= 300) throw new RuntimeException('Verification provider unavailable', $status);
        $body = (string) ($reply['body'] ?? '');
        if (strlen($body) > 32768) throw new RuntimeException('Provider response limit', 502);
        $decoded = json_decode($body, true);
        if (!is_array($decoded)) throw new RuntimeException('Invalid verification response', 502);
        return $decoded;
    }

    /** @return array{status: int, body: string} */
    private static function curl(string $url, array $fields, string $accountSid, string $authToken): array
    {
        if (!function_exists('curl_init')) throw new RuntimeException('This server cannot reach the verification provider (PHP curl is not enabled)', 503);
        $handle = curl_init($url);
        $body = '';
        curl_setopt_array($handle, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => http_build_query($fields),
            CURLOPT_USERPWD => $accountSid . ':' . $authToken,
            CURLOPT_HTTPHEADER => ['Content-Type: application/x-www-form-urlencoded', 'Accept: application/json'],
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT => 8,
            // Bounded however the provider answers.
            CURLOPT_WRITEFUNCTION => static function ($curl, string $chunk) use (&$body): int {
                if (strlen($body) + strlen($chunk) > 32768) return 0;
                $body .= $chunk;
                return strlen($chunk);
            },
        ]);
        $ok = curl_exec($handle);
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        curl_close($handle);
        if ($ok === false && $status === 0) throw new RuntimeException('Verification provider unreachable', 503);
        return ['status' => $status, 'body' => $body];
    }

    // ---------------------------------------------------------------- small things

    private function now(): int
    {
        return $this->clock !== null ? ($this->clock)() : time();
    }

    private static function field(mixed $body, string $name): mixed
    {
        if (is_array($body)) return $body[$name] ?? null;
        if (is_object($body)) return $body->{$name} ?? null;
        return null;
    }

    private static function fail(int $status, string $error, string $code): array
    {
        return ['status' => $status, 'body' => (object) ['error' => $error, 'code' => $code]];
    }
}
