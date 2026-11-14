<?php

declare(strict_types=1);

namespace FormLogic\Services;

use PDO;

/**
 * Phone sign-in codes for a SoftN app, sent and checked by the plugin that provides them
 * (docs/PLUGINS.md, "Sign-in codes"). Nothing here knows any provider.
 *
 * An app names a provider for its codes in its manifest (`config.app.verificationProvider`;
 * Coffee.Dating names "twilio-verify"). SoftN leaves delivery to the host's operator, and FormLogic
 * is that operator here: the enabled plugin that sends codes for that name (`formlogicPlugin.signInCodes`,
 * PluginService::signInCodesProvider) is asked, at the two routes of its backend the site calls, to
 * send each code and to check each one a person types. It reaches its provider only through the
 * requests the site makes for it (PluginNetwork), with what the app's owner set for it
 * (PluginAppSettings): their secrets filled in by the site, never seen by its code, the app's code,
 * a page, a log or an answer. The app's backend learns only what the plugin decided.
 *
 * The contract, the one the app's backend and SoftN's operator adapter share:
 *  - POST /api/auth/send-code: the backend is asked first, with `req.context.verificationProvider`
 *    set. It applies its own limits (per phone, per address, overall) and, if it admits the request,
 *    answers 202 with `challenge_id`, having stored the challenge in `otp_challenges` as `queued`
 *    with `code_hash` `verify:pending`. Only then is a code sent (so the app's limits stand between
 *    a caller and the owner's bill), and the challenge becomes `ready` with the provider's id for it.
 *  - POST /api/auth/verify: the attempt is counted on the challenge before the provider is asked
 *    (five at most), and the backend is told the provider's yes in `req.context.verification`
 *    (`challengeId`, `phone`, `sid`, `attempt`), which it checks against the challenge it stored. An
 *    attempt no code was checked on (unavailable) is given back.
 *
 * The plugin answers each of its two routes, after any requests it asks the site to make, with
 * `{result}`: sending, `sent` (with `id`, the provider's id for the code, held to ID_PATTERN) or
 * `busy`; checking, `approved`, `wrong`, `expired` or `busy`. Anything else, word for word, is
 * `unavailable`.
 *
 * An app in development (its host configuration says so: never set by FormLogic) shows its own codes
 * and is passed straight through, as is every other request.
 */
final class NativePhoneVerification
{
    public const PATHS = ['/api/auth/send-code', '/api/auth/verify'];
    /** A provider's id for a code it sent, as a challenge keeps it (`verify:{id}`). Never "pending", which marks one not sent yet. */
    public const ID_PATTERN = '/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/D';

    /** @param ?\Closure(): int $clock seconds, for tests */
    public function __construct(
        private NativeAppService $native,
        private PluginService $plugins,
        private PluginAppSettings $settings,
        private PluginNetwork $network,
        private ?LegacyPhoneVerification $legacy = null,
        private ?\Closure $clock = null,
    ) {
    }

    // ---------------------------------------------------------------- the owner's settings

    /** The provider the installed app names for its sign-in codes, or null. */
    public function provider(string $appId): ?string
    {
        try { $manifest = $this->native->installedManifest($appId); } catch (\Throwable) { return null; }
        $name = $manifest['config']['app']['verificationProvider'] ?? null;
        return is_string($name) && trim($name) !== '' ? trim($name) : null;
    }

    /**
     * What the owner sees: the provider the app names, the plugin that sends its codes on this site
     * (or none), the settings that plugin asks of them (never a secret, only whether one is kept, and
     * where it may be sent), and whether everything it needs is there. With no plugin for them,
     * whether details are kept all the same (`keptWithoutPlugin`), for the owner to forget.
     */
    public function describe(string $appId): array
    {
        $this->legacy?->upgrade($appId);
        $name = $this->provider($appId);
        $plugin = $name === null ? null : $this->plugins->signInCodesProvider($name, false);
        if ($plugin === null) {
            // For a plugin removed since, one the app named before, or from before codes were a plugin's.
            $kept = $this->settings->keptAny($appId) || ($this->legacy?->kept($appId) ?? false);
            return ['provider' => $name, 'asked' => $name !== null, 'plugin' => null, 'fields' => [], 'values' => (object) [], 'kept' => (object) [], 'imports' => (object) [], 'configured' => false, 'keptWithoutPlugin' => $kept];
        }
        $schema = $plugin['granted']['appSettings'];
        $shown = $this->settings->describe($appId, $plugin['manifestId'], $schema);
        $imports = [];
        $fields = [];
        foreach ($schema as $field) {
            if (is_string($field['importFrom'] ?? null)) {
                $imports[$field['key']] = $field['importFrom'];
            }
            // What a form needs to show it; its checks are the server's.
            unset($field['pattern'], $field['message'], $field['missing'], $field['importFrom']);
            $fields[] = $field;
        }
        return [
            'provider' => $name,
            'asked' => true,
            'plugin' => ['id' => $plugin['manifestId'], 'name' => $plugin['name'], 'label' => $plugin['granted']['signInCodes']['label'], 'enabled' => $plugin['enabled']],
            'fields' => $fields,
            'values' => (object) $shown['values'],
            'kept' => (object) $shown['kept'],
            'imports' => (object) $imports,
            'configured' => $shown['configured'],
            'keptWithoutPlugin' => false,
        ];
    }

    /**
     * Keep the owner's settings for the plugin that sends the app's codes (PluginAppSettings::save),
     * as an import's do too. What the app kept from before codes were a plugin's is moved first,
     * never after: it never overwrites what its owner saves now.
     */
    public function save(string $appId, mixed $values): array
    {
        $this->legacy?->upgrade($appId);
        $plugin = $this->pluginFor($appId);
        $this->settings->save($appId, $plugin['manifestId'], $plugin['granted']['appSettings'], $values);
        return $this->describe($appId);
    }

    /** Whether save() would take $values, keeping nothing: throws as it would. */
    public function check(string $appId, mixed $values): void
    {
        $this->legacy?->upgrade($appId);
        $plugin = $this->pluginFor($appId);
        $this->settings->check($appId, $plugin['manifestId'], $plugin['granted']['appSettings'], $values);
    }

    /**
     * The owner turns the codes off, or forgets what is kept: the settings of the plugin that sends
     * the app's codes go; where no plugin does, every plugin's settings the app keeps go. What it
     * kept from before codes were a plugin's goes in either case.
     */
    public function clear(string $appId): array
    {
        $this->legacy?->forget($appId);
        $name = $this->provider($appId);
        $plugin = $name === null ? null : $this->plugins->signInCodesProvider($name, false);
        if ($plugin !== null) {
            $this->settings->clear($appId, $plugin['manifestId']);
        } else {
            $this->settings->forgetAll($appId);
        }
        return $this->describe($appId);
    }

    /**
     * What an app's earlier host kept for its sign-in codes, in the configuration an import brings
     * (that host's private/config.json): each setting the plugin sending the app's codes says such a
     * host keeps (`importFrom`), when every one it names is there. Null otherwise.
     */
    public function heldIn(string $appId, array $config): ?array
    {
        $name = $this->provider($appId);
        $plugin = $name === null ? null : $this->plugins->signInCodesProvider($name, false);
        $held = [];
        foreach ($plugin['granted']['appSettings'] ?? [] as $field) {
            if (!is_string($field['importFrom'] ?? null)) {
                continue;
            }
            $value = $config;
            foreach (explode('.', $field['importFrom']) as $step) {
                $value = is_array($value) ? ($value[$step] ?? null) : null;
            }
            if (!is_string($value) || trim($value) === '') {
                return null;
            }
            $held[$field['key']] = trim($value);
        }
        return $held === [] ? null : $held;
    }

    private function pluginFor(string $appId): array
    {
        $name = $this->provider($appId);
        if ($name === null) {
            throw new \InvalidArgumentException('This app asks for no sign-in codes.');
        }
        return $this->plugins->signInCodesProvider($name, false)
            ?? throw new \InvalidArgumentException('No plugin on this site sends sign-in codes for "' . substr($name, 0, 64) . '". Ask the site\'s administrator (Admin → Platform → Plugins).');
    }

    // ---------------------------------------------------------------- requests (the app's visitors)

    /** Whether this is a request for the provider to answer: its path, the app naming one, and not in development. */
    public function applies(string $appId, array $request): bool
    {
        return ($request['method'] ?? '') === 'POST' && in_array($request['path'] ?? '', self::PATHS, true)
            && ($this->native->hostConfig($appId)['development'] ?? false) !== true && $this->provider($appId) !== null;
    }

    /**
     * Answer a sign-in request through the plugin that sends the app's codes. $invoke runs the app's
     * backend with the given context added to its own, and answers `['status' => int, 'body' => mixed]`.
     *
     * @param callable(array): array $invoke
     */
    public function handle(string $appId, array $request, callable $invoke): array
    {
        $this->legacy?->upgrade($appId);
        $ready = $this->ready($appId);
        // No plugin sends them, it is off, or the owner has not set it up: refused before any challenge
        // is admitted or a code is paid for.
        if ($ready === null) return self::fail(503, 'Sign-in messaging is not configured yet.', 'verification_unavailable');
        return ($request['path'] ?? '') === '/api/auth/send-code' ? $this->sendCode($appId, $ready, $invoke) : $this->verify($appId, $request, $ready, $invoke);
    }

    /** The provider the app names, the enabled plugin that sends its codes, and the owner's settings for it, all there; or null. */
    private function ready(string $appId): ?array
    {
        $name = $this->provider($appId);
        $plugin = $name === null ? null : $this->plugins->signInCodesProvider($name);
        if ($plugin === null || !is_array($plugin['granted']['signInCodes'] ?? null)) return null;
        $schema = $plugin['granted']['appSettings'];
        if (!$this->settings->configured($appId, $plugin['manifestId'], $schema)) return null;
        return [
            'name' => $name, 'plugin' => $plugin,
            'values' => $this->settings->values($appId, $plugin['manifestId'], $schema),
            'secrets' => $this->settings->secrets($appId, $plugin['manifestId'], $schema),
        ];
    }

    private function sendCode(string $appId, array $ready, callable $invoke): array
    {
        $result = $invoke(['verificationProvider' => $ready['name']]);
        if ((int) ($result['status'] ?? 0) !== 202) return $result;
        $id = self::field($result['body'] ?? null, 'challenge_id');
        if (!is_string($id) || !preg_match('/^\w{32}$/D', $id)) return self::fail(503, 'We could not send a code. Please try again shortly.', 'verification_unavailable');
        $challenge = $this->native->withDatabase($appId, static function (PDO $db) use ($id) {
            $statement = $db->prepare('SELECT * FROM otp_challenges WHERE id=?');
            $statement->execute([$id]);
            return $statement->fetch(PDO::FETCH_ASSOC) ?: null;
        });
        if (!is_array($challenge) || !is_string($challenge['phone'] ?? null)) return self::fail(503, 'We could not send a code. Please try again shortly.', 'verification_unavailable');
        // Only a challenge the backend has just admitted, waiting for its code: one it answered for
        // again (an earlier one, or one already sent) is never sent a second time.
        if (($challenge['state'] ?? null) !== 'queued' || ($challenge['code_hash'] ?? null) !== 'verify:pending') return self::fail(409, 'A newer code was requested. Use the latest sign-in request.', 'challenge_replaced');
        $sent = $this->ask($appId, $ready, 'sendRoute', ['phone' => $challenge['phone'], 'challenge' => $id]);
        $sid = $sent['id'] ?? null;
        if (($sent['result'] ?? null) !== 'sent' || !is_string($sid) || $sid === 'pending' || !preg_match(self::ID_PATTERN, $sid)) {
            $this->native->withDatabase($appId, static fn(PDO $db) => $db->prepare("UPDATE otp_challenges SET state='failed' WHERE id=? AND state='queued'")->execute([$id]));
            return self::fail(($sent['result'] ?? null) === 'busy' ? 429 : 503, 'We could not send a code. Please try again shortly.', 'verification_unavailable');
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

    private function verify(string $appId, array $request, array $ready, callable $invoke): array
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
                $hash = is_array($challenge) ? (string) $challenge['code_hash'] : '';
                if (!$challenge || (int) $challenge['expires_at'] <= $now || in_array($challenge['state'], ['used', 'failed'], true)
                    || !str_starts_with($hash, 'verify:') || $hash === 'verify:pending' || !preg_match(self::ID_PATTERN, substr($hash, 7))) { $db->exec('COMMIT'); return self::fail(401, 'Code expired or invalid. Request a new one.', 'invalid_code'); }
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
        $checked = $this->ask($appId, $ready, 'checkRoute', ['id' => $sid, 'phone' => (string) $challenge['phone'], 'code' => $code, 'challenge' => $id]);
        // Word for word (match is ===): an answer of `true`, or of anything else, is no approval.
        return match ($checked['result'] ?? null) {
            // The phone is the challenge's: the backend compares it with the one it was sent, so a
            // code for one number never signs in another.
            'approved' => $invoke(['verification' => ['challengeId' => $id, 'phone' => (string) $challenge['phone'], 'sid' => $sid, 'attempt' => (int) $challenge['attempts'] + 1]]),
            'wrong' => self::fail(401, 'That code is not correct.', 'wrong_code'),
            'expired' => self::fail(401, 'Code expired or invalid. Request a new one.', 'invalid_code'),
            'busy' => self::fail(429, 'We could not check your code. Please try again shortly.', 'verification_unavailable'),
            default => $this->unchecked($appId, $id),
        };
    }

    /**
     * No code was checked (the plugin, its provider or the site's network could not, or the worker
     * slots were all busy): the attempt counted for it is given back, in a transaction of its own and
     * never below none, so an outage costs nobody their tries.
     */
    private function unchecked(string $appId, string $challengeId): array
    {
        try {
            $this->native->withDatabase($appId, static function (PDO $db) use ($challengeId): void {
                $db->exec('BEGIN IMMEDIATE');
                try {
                    $db->prepare('UPDATE otp_challenges SET attempts=attempts-1 WHERE id=? AND attempts>0')->execute([$challengeId]);
                    $db->exec('COMMIT');
                } catch (\Throwable $error) {
                    $db->exec('ROLLBACK');
                    throw $error;
                }
            });
        } catch (\Throwable $error) {
            error_log('Sign-in codes for app ' . $appId . ': an attempt was not given back: ' . get_class($error));
        }
        return self::fail(503, 'We could not check your code. Please try again shortly.', 'verification_unavailable');
    }

    /**
     * One step through the plugin (its send or check route), with the requests it asks the site to
     * make: what it decided, or `unavailable` when it, its provider or the site's network failed.
     */
    private function ask(string $appId, array $ready, string $route, array $input): array
    {
        $plugin = $ready['plugin'];
        try {
            return $this->network->call($plugin, $plugin['granted'], $plugin['granted']['signInCodes'][$route], $input + [
                'appSettings' => (object) $ready['values'],
                'settings' => (object) $plugin['settings'],
            ], $ready['secrets']);
        } catch (\RuntimeException | \JsonException $error) {
            // Said in the log without anything the request carried: the reason is the site's own words.
            error_log('Sign-in codes for app ' . $appId . ' through ' . $plugin['manifestId'] . ': ' . $error->getMessage());
            return ['result' => 'unavailable'];
        }
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
