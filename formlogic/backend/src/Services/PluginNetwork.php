<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Helpers\IpSafety;
use FormLogic\Support\Environment;
use RuntimeException;

/**
 * The network a plugin was granted (`formlogicPlugin.network`, docs/PLUGINS.md). Nothing here knows
 * what any plugin asks for.
 *
 * A plugin's code runs in the SoftN runner's sandbox, which has no network, and stays so. On a route
 * the site calls (one under /api/site/), it may answer with a request for the site to make and the
 * route of its own to continue at; the site makes the request, held to the grant, and calls the
 * plugin back with what came back, `{status, body}`. The plugin decides. As the camera check's page
 * holds the camera for a plugin (CameraCheckService), the site holds the network.
 *
 * What the site holds a request to:
 *  - https only, to a host the plugin names in its manifest exactly (shown to the administrator
 *    at install, and again on an update that adds one), on port 443, with no user, password or
 *    fragment in the address, which is written out again from the parts checked;
 *  - the host's addresses are looked up here, before the request's time starts: one that is
 *    loopback, private, link-local or not otherwise public (IpSafety) refuses the request, and the
 *    connection is pinned to the address checked, through no proxy, so no second look-up can send
 *    it elsewhere. Where the site reaches the internet through an HTTPS proxy (`https_proxy` or
 *    `HTTPS_PROXY`, the host not in `no_proxy` or `NO_PROXY`), the request goes through it instead,
 *    tunnelled (CONNECT, TLS end to end), and the proxy looks the host up and decides what is
 *    reachable; every other rule holds as before;
 *  - no redirect is followed (a 3xx is the answer), 5 seconds to connect and 8 in all, and an
 *    answer over 32 KB is refused;
 *  - at most two requests in one call of the plugin's (one step, such as sending a sign-in code);
 *  - an app owner's secret (PluginAppSettings) goes only where the request names it by key
 *    (`{"secret": "authToken"}`, in a header's value or HTTP basic auth), and only to a host it may
 *    be sent to (its `sendTo`); it is filled in here, and the plugin's code never has one. Each of
 *    them an answer carries back (as it is, URL-encoded, in any case, or as a number) is blanked
 *    first; after a request that carried one, an answer that is not JSON reaches the plugin as null.
 * A request the site refuses, or that has no answer, ends the call (an exception): the plugin is
 * not called back.
 */
final class PluginNetwork
{
    public const MAX_REQUESTS = 2;
    public const MAX_ANSWER_BYTES = 32768;
    private const MAX_REQUEST_BYTES = 16384;
    private const MAX_STATE_BYTES = 4096;
    private const MAX_HEADERS = 10;
    private const MAX_HEADER_VALUE = 1024;
    private const MAX_JSON_DEPTH = 64;
    private const CONNECT_SECONDS = 5;
    private const TOTAL_SECONDS = 8;
    private const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    /** What a plugin may not set: the site writes these, or they would change where or how a request goes. */
    private const RESERVED_HEADERS = ['host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'expect', 'proxy-authorization', 'proxy-connection'];
    /** What stands in an answer for a secret it carried back. */
    public const BLANKED = '[secret]';

    /**
     * @param ?\Closure(array{method: string, url: string, headers: list<string>, body: ?string, address: ?string, proxy: ?string}): array{status: int, body: string} $transport
     *   How a request goes out once checked: tests give a fake one; production has none, and uses curl.
     *   `address` is the one checked and pinned, or null when it goes through `proxy`.
     * @param ?\Closure(string): list<string> $resolver A host's addresses: tests give their own.
     * @param ?\Closure(string): ?string $environment The site's environment (its proxy): tests give their own.
     */
    public function __construct(
        private NativeAppService $native,
        private ?\Closure $transport = null,
        private ?\Closure $resolver = null,
        private ?\Closure $environment = null,
    ) {
    }

    /**
     * Call one of a plugin's site routes with $input, make the requests it asks for, and answer what
     * it says last (the body of a 2xx, an object). $granted: what the plugin was granted
     * (PluginService::granted): its hosts, its site routes, and where each owner's secret may go.
     * $secrets: an app owner's secrets for it, by key, for the requests it asks for; never in $input.
     *
     * The plugin answers either what the step decided, or
     * `{request: {method, url, headers?, form? | json?, auth?: {basic: {user, password}}}, continue: route, state?}`,
     * and is called at `continue` with $input, `response: {status, body}` and its `state`.
     */
    public function call(array $plugin, array $granted, string $route, array $input, array $secrets = []): array
    {
        $answer = $this->callPlugin($plugin, $route, $input);
        $made = 0;
        while (array_key_exists('request', $answer)) {
            if (++$made > self::MAX_REQUESTS) {
                throw new RuntimeException('The plugin asked for more than ' . self::MAX_REQUESTS . ' requests in one step.', 502);
            }
            $next = $answer['continue'] ?? null;
            if (!is_string($next) || !in_array($next, $granted['siteRoutes'] ?? [], true)) {
                throw new RuntimeException('The plugin named no route of its own under /api/site/ to continue at.', 502);
            }
            $state = $answer['state'] ?? null;
            if ($state !== null && strlen((string) json_encode($state)) > self::MAX_STATE_BYTES) {
                throw new RuntimeException('The plugin\'s state is larger than the site carries for it.', 502);
            }
            $response = $this->fetch($granted, $answer['request'], $secrets);
            $answer = $this->callPlugin($plugin, $next, array_merge($input, ['response' => $response], $state !== null ? ['state' => $state] : []));
        }
        return $answer;
    }

    /** One of the plugin's site routes, in its sandbox: its answer's body, when it is a 2xx with an object. */
    private function callPlugin(array $plugin, string $route, array $input): array
    {
        $result = $this->native->request((string) $plugin['appId'], [
            'method' => 'POST', 'path' => $route, 'query' => (object) [], 'body' => $input,
            'headers' => (object) ['authorization' => '', 'idempotency-key' => ''], 'client_ip' => '127.0.0.1', 'photos' => false,
        ], ['formlogic' => ['appId' => (string) $plugin['appId']]]);
        if (!is_int($result['status'] ?? null) || $result['status'] < 200 || $result['status'] > 299 || !is_array($result['body'] ?? null)) {
            throw new RuntimeException('The plugin answered ' . (is_int($result['status'] ?? null) ? $result['status'] : '?') . ' at ' . $route . '.', 502);
        }
        return $result['body'];
    }

    /**
     * One request a plugin asked for, made within its grant ($granted: its `network`, and its
     * `appSettings`, which say where each secret may go): `{status, body}`, the body as JSON where it
     * is JSON and its text otherwise, with every secret it carried back blanked.
     *
     * @return array{status: int, body: mixed}
     */
    public function fetch(array $granted, mixed $request, array $secrets = []): array
    {
        if (!is_array($request)) {
            throw new RuntimeException('The plugin asked for a request the site cannot make.', 502);
        }
        $method = $request['method'] ?? 'GET';
        if (!is_string($method) || !in_array($method, self::METHODS, true)) {
            throw new RuntimeException('The plugin asked for a method the site does not make: GET, POST, PUT, PATCH or DELETE.', 502);
        }
        [$host, $url] = self::address($request['url'] ?? null, array_values($granted['network'] ?? []));
        $sendTo = self::secretHosts($granted);
        // What must not reach the plugin again: each secret, and each value made with one.
        $sensitive = array_values(array_filter(array_map('strval', $secrets), static fn (string $secret) => $secret !== ''));
        $carried = false;
        $headers = [];
        $given = $request['headers'] ?? [];
        if (!is_array($given) || ($given !== [] && array_is_list($given)) || count($given) > self::MAX_HEADERS) {
            throw new RuntimeException('The plugin\'s headers are not ones the site sends.', 502);
        }
        foreach ($given as $name => $value) {
            $name = (string) $name;
            if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/D', $name) || in_array(strtolower($name), self::RESERVED_HEADERS, true) || isset($headers[strtolower($name)])) {
                throw new RuntimeException('The plugin asked for a header the site does not send: ' . substr($name, 0, 64) . '.', 502);
            }
            $headers[strtolower($name)] = $name . ': ' . self::value($value, $secrets, $sendTo, $host, $sensitive, $carried);
        }
        if (isset($request['auth'])) {
            $basic = is_array($request['auth']) && count($request['auth']) === 1 ? ($request['auth']['basic'] ?? null) : null;
            if (!is_array($basic) || isset($headers['authorization'])) {
                throw new RuntimeException('The plugin asked for an authorization the site does not send.', 502);
            }
            $user = self::value($basic['user'] ?? '', $secrets, $sendTo, $host, $sensitive, $carried);
            $password = self::value($basic['password'] ?? '', $secrets, $sendTo, $host, $sensitive, $carried);
            if (str_contains($user, ':')) {
                throw new RuntimeException('A user for HTTP basic auth has no colon.', 502);
            }
            $token = base64_encode($user . ':' . $password);
            $sensitive[] = $token;
            $headers['authorization'] = 'Authorization: Basic ' . $token;
        }
        $body = null;
        if (array_key_exists('form', $request) && array_key_exists('json', $request)) {
            throw new RuntimeException('The plugin asked for a form and JSON in one request.', 502);
        }
        if (array_key_exists('form', $request)) {
            $form = $request['form'];
            if (!is_array($form) || ($form !== [] && array_is_list($form))) {
                throw new RuntimeException('A form the plugin sends is named fields.', 502);
            }
            foreach ($form as $field => $text) {
                if (!is_string($text) && !is_int($text) && !is_float($text)) {
                    throw new RuntimeException('A form field the plugin sends is text or a number: ' . substr((string) $field, 0, 64) . '.', 502);
                }
            }
            $body = http_build_query($form);
            $headers['content-type'] = 'Content-Type: application/x-www-form-urlencoded';
        } elseif (array_key_exists('json', $request)) {
            $body = json_encode($request['json'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            if (!is_string($body)) {
                throw new RuntimeException('The plugin\'s JSON could not be written.', 502);
            }
            $headers['content-type'] = 'Content-Type: application/json';
        }
        if ($body !== null && ($method === 'GET' || strlen($body) > self::MAX_REQUEST_BYTES)) {
            throw new RuntimeException('The plugin\'s request carries a body the site does not send (none on a GET, at most 16 KB).', 502);
        }
        // Through the site's proxy, which looks the host up and decides what is reachable; or straight
        // to the address checked here.
        $proxy = $this->proxyFor($host);
        $address = $proxy === null ? $this->resolved($host) : null;
        $sent = ['method' => $method, 'url' => $url, 'headers' => array_values($headers), 'body' => $body, 'address' => $address, 'proxy' => $proxy];
        $reply = $this->transport !== null ? ($this->transport)($sent) : self::curl($sent);
        $status = $reply['status'] ?? null;
        $text = $reply['body'] ?? null;
        if (!is_int($status) || $status < 100 || $status > 599 || !is_string($text)) {
            throw new RuntimeException('No answer from ' . $host . '.', 502);
        }
        if (strlen($text) > self::MAX_ANSWER_BYTES) {
            throw new RuntimeException('The answer from ' . $host . ' is larger than a plugin is given (32 KB).', 502);
        }
        return ['status' => $status, 'body' => self::blanked(self::decoded($text, $carried), self::forms($sensitive))];
    }

    /**
     * A request's address: https, to one of the plugin's hosts exactly, on 443, with no user,
     * password or fragment. Written out again from what was checked.
     *
     * @return array{0: string, 1: string} the host and the address
     */
    private static function address(mixed $url, array $hosts): array
    {
        if (!is_string($url) || strlen($url) > 2048 || preg_match('/[^\x21-\x7e]|\\\\/', $url)) {
            throw new RuntimeException('The plugin asked for an address the site does not reach.', 502);
        }
        $parts = parse_url($url);
        if (!is_array($parts) || strtolower((string) ($parts['scheme'] ?? '')) !== 'https' || !isset($parts['host'])) {
            throw new RuntimeException('The site makes a plugin\'s requests over https only.', 502);
        }
        if (isset($parts['user']) || isset($parts['pass']) || isset($parts['fragment'])) {
            throw new RuntimeException('The plugin asked for an address with a user, a password or a fragment in it.', 502);
        }
        $host = strtolower($parts['host']);
        if (!in_array($host, $hosts, true)) {
            throw new RuntimeException('The plugin was not granted ' . substr($host, 0, 253) . '.', 502);
        }
        if (isset($parts['port']) && $parts['port'] !== 443) {
            throw new RuntimeException('The site reaches a plugin\'s hosts on port 443 only.', 502);
        }
        $path = $parts['path'] ?? '/';
        if (!str_starts_with($path, '/')) {
            throw new RuntimeException('The plugin asked for an address the site does not reach.', 502);
        }
        return [$host, 'https://' . $host . $path . (isset($parts['query']) ? '?' . $parts['query'] : '')];
    }

    /** @return array<string, list<string>> each secret the plugin asks owners for, with the hosts it may be sent to */
    private static function secretHosts(array $granted): array
    {
        $out = [];
        foreach ($granted['appSettings'] ?? [] as $field) {
            if (is_array($field) && ($field['type'] ?? null) === 'secret' && is_string($field['key'] ?? null)) {
                $out[$field['key']] = is_array($field['sendTo'] ?? null) ? array_values($field['sendTo']) : [];
            }
        }
        return $out;
    }

    /**
     * The HTTPS proxy the site reaches the internet through, for $host: `https_proxy` (or
     * `HTTPS_PROXY`), unless `no_proxy` (or `NO_PROXY`) is `*` or names the host or a domain it is
     * in. Null for none. One that is not an HTTP proxy to tunnel through refuses the request.
     */
    private function proxyFor(string $host): ?string
    {
        $proxy = $this->env('https_proxy') ?? $this->env('HTTPS_PROXY');
        if ($proxy === null) {
            return null;
        }
        foreach (explode(',', $this->env('no_proxy') ?? $this->env('NO_PROXY') ?? '') as $entry) {
            $entry = ltrim((string) preg_replace('/:\d+$/', '', strtolower(trim($entry))), '.');
            if ($entry === '*') {
                return null;
            }
            if ($entry !== '' && ($host === $entry || str_ends_with($host, '.' . $entry))) {
                return null;
            }
        }
        $url = preg_match('~^[a-z][a-z0-9+.-]*://~i', $proxy) ? $proxy : 'http://' . $proxy;
        $parts = parse_url($url);
        if (!is_array($parts) || !in_array(strtolower((string) ($parts['scheme'] ?? '')), ['http', 'https'], true) || !isset($parts['host'])
            || preg_match('/[\x00-\x20\x7f]/', $url)) {
            throw new RuntimeException('The site\'s HTTPS proxy is not an HTTP proxy a plugin\'s request can go through.', 503);
        }
        return $url;
    }

    private function env(string $name): ?string
    {
        $value = $this->environment !== null ? ($this->environment)($name) : Environment::get($name);
        return is_string($value) && trim($value) !== '' ? trim($value) : null;
    }

    /**
     * The address a host is reached at: looked up now, every address it has must be public (one that
     * is loopback, private, link-local or reserved refuses it), and the first, IPv4 before IPv6, is
     * the one the request is pinned to.
     */
    private function resolved(string $host): string
    {
        $addresses = $this->resolver !== null ? ($this->resolver)($host) : self::lookUp($host);
        if (!is_array($addresses) || $addresses === []) {
            throw new RuntimeException($host . ' does not resolve here.', 503);
        }
        $chosen = null;
        foreach ($addresses as $address) {
            if (!is_string($address) || IpSafety::isPrivateAddress($address)) {
                throw new RuntimeException($host . ' resolves to an address that is not public: the site does not reach it for a plugin.', 502);
            }
            $address = trim($address, '[]');
            if ($chosen === null || (str_contains($chosen, ':') && !str_contains($address, ':'))) {
                $chosen = $address;
            }
        }
        return (string) $chosen;
    }

    /**
     * A header's or basic auth's value: text, an owner's secret by key, or a list of both, joined. A
     * secret goes only to a host it may be sent to ($sendTo, by key); $carried says one went.
     */
    private static function value(mixed $value, array $secrets, array $sendTo, string $host, array &$sensitive, bool &$carried): string
    {
        $parts = is_array($value) && array_is_list($value) ? $value : [$value];
        if (count($parts) > 8) {
            throw new RuntimeException('A value the plugin sends has too many parts.', 502);
        }
        $out = '';
        $secret = false;
        foreach ($parts as $part) {
            if (is_string($part)) {
                $out .= $part;
            } elseif (is_array($part) && count($part) === 1 && is_string($part['secret'] ?? null)) {
                $key = $part['secret'];
                if (!in_array($host, $sendTo[$key] ?? [], true)) {
                    throw new RuntimeException('The plugin asked for the secret ' . substr($key, 0, 32) . ' to be sent to ' . $host . ', where it may not go.', 502);
                }
                if (!array_key_exists($key, $secrets)) {
                    throw new RuntimeException('The plugin asked for a secret the app\'s owner has not given it: ' . substr($key, 0, 32) . '.', 502);
                }
                $out .= (string) $secrets[$key];
                $secret = true;
            } else {
                throw new RuntimeException('A value the plugin sends is text, or {"secret": name}.', 502);
            }
        }
        if (strlen($out) > self::MAX_HEADER_VALUE || preg_match('/[\x00-\x1f\x7f]/', $out)) {
            throw new RuntimeException('A value the plugin sends is too long, or holds a line break.', 502);
        }
        if ($secret) {
            $sensitive[] = $out;
            $carried = true;
        }
        return $out;
    }

    /**
     * An answer's body: JSON as JSON (objects kept as objects), nothing as null, other text as text,
     * but for an answer to a request that carried a secret ($carried): text that is not JSON (or JSON
     * deeper than is read) is not looked through, and reaches the plugin as null.
     */
    private static function decoded(string $text, bool $carried): mixed
    {
        if ($text === '') {
            return null;
        }
        try {
            return json_decode($text, false, self::MAX_JSON_DEPTH, JSON_THROW_ON_ERROR | JSON_BIGINT_AS_STRING);
        } catch (\JsonException) {
            return !$carried && mb_check_encoding($text, 'UTF-8') ? $text : null;
        }
    }

    /**
     * What is blanked in an answer: each of $sensitive as it is and URL-encoded both ways (matched
     * whatever its case, in blanked()), the longest first, so a value made with a secret goes whole.
     *
     * @return list<string>
     */
    private static function forms(array $sensitive): array
    {
        $forms = [];
        foreach ($sensitive as $text) {
            foreach ([$text, rawurlencode($text), urlencode($text)] as $form) {
                if ($form !== '' && !in_array($form, $forms, true)) {
                    $forms[] = $form;
                }
            }
        }
        usort($forms, static fn (string $a, string $b): int => strlen($b) <=> strlen($a));
        return $forms;
    }

    /** $value with every one of $forms blanked wherever it stands in it, in any case, names of fields too, and any number that spells one. */
    private static function blanked(mixed $value, array $forms): mixed
    {
        if ($forms === []) {
            return $value;
        }
        if (is_string($value)) {
            return str_ireplace($forms, self::BLANKED, $value);
        }
        if (is_int($value) || is_float($value)) {
            foreach (array_unique([(string) $value, (string) json_encode($value)]) as $spelled) {
                foreach ($forms as $form) {
                    if (stripos($spelled, $form) !== false) {
                        return self::BLANKED;
                    }
                }
            }
            return $value;
        }
        if (is_array($value)) {
            return array_map(static fn (mixed $item): mixed => self::blanked($item, $forms), $value);
        }
        if ($value instanceof \stdClass) {
            $out = new \stdClass();
            foreach (get_object_vars($value) as $name => $item) {
                $out->{self::blanked((string) $name, $forms)} = self::blanked($item, $forms);
            }
            return $out;
        }
        return $value;
    }

    /** @return list<string> a host's addresses, as this server resolves them */
    private static function lookUp(string $host): array
    {
        $found = @gethostbynamel($host);
        $addresses = is_array($found) ? $found : [];
        if (function_exists('dns_get_record')) {
            $records = @dns_get_record($host, DNS_AAAA);
            foreach (is_array($records) ? $records : [] as $record) {
                if (is_string($record['ipv6'] ?? null) && $record['ipv6'] !== '') {
                    $addresses[] = $record['ipv6'];
                }
            }
        }
        return $addresses;
    }

    /** @param array{method: string, url: string, headers: list<string>, body: ?string, address: ?string, proxy: ?string} $request */
    private static function curl(array $request): array
    {
        if (!function_exists('curl_init')) {
            throw new RuntimeException('This server cannot make requests for plugins (PHP curl is not enabled).', 503);
        }
        $host = (string) parse_url($request['url'], PHP_URL_HOST);
        $proxied = $request['proxy'] !== null;
        $body = '';
        $over = false;
        $handle = curl_init($request['url']);
        $options = [
            CURLOPT_CUSTOMREQUEST => $request['method'],
            CURLOPT_HTTPHEADER => $request['headers'],
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_CONNECTTIMEOUT => self::CONNECT_SECONDS,
            CURLOPT_TIMEOUT => self::TOTAL_SECONDS,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            // Bounded however the host answers.
            CURLOPT_WRITEFUNCTION => static function ($curl, string $chunk) use (&$body, &$over): int {
                if (strlen($body) + strlen($chunk) > self::MAX_ANSWER_BYTES) {
                    $over = true;
                    return 0;
                }
                $body .= $chunk;
                return strlen($chunk);
            },
        ];
        if ($proxied) {
            // Through the site's own proxy, tunnelled: TLS stays end to end, and the proxy looks the host up.
            $options[CURLOPT_PROXY] = $request['proxy'];
            $options[CURLOPT_HTTPPROXYTUNNEL] = true;
            $options[CURLOPT_NOPROXY] = '';
        } else {
            // The address checked, and no other: no second look-up, and no proxy from the environment.
            $address = (string) $request['address'];
            $options[CURLOPT_RESOLVE] = [$host . ':443:' . (str_contains($address, ':') ? '[' . $address . ']' : $address)];
            $options[CURLOPT_PROXY] = '';
            $options[CURLOPT_NOPROXY] = '*';
        }
        if ($request['body'] !== null) {
            $options[CURLOPT_POSTFIELDS] = $request['body'];
        }
        // The CA bundle FormLogic ships, where the operator has not named their own (as WebhookService).
        $bundle = dirname(__DIR__, 2) . '/resources/cacert.pem';
        if (!ini_get('curl.cainfo') && !getenv('CURL_CA_BUNDLE') && is_file($bundle)) {
            $options[CURLOPT_CAINFO] = $bundle;
        }
        curl_setopt_array($handle, $options);
        $ok = curl_exec($handle);
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        $used = (string) curl_getinfo($handle, CURLINFO_PRIMARY_IP);
        curl_close($handle);
        if ($over) {
            throw new RuntimeException('The answer from ' . $host . ' is larger than a plugin is given (32 KB).', 502);
        }
        if ($ok === false || $status === 0) {
            throw new RuntimeException('No answer from ' . $host . '.', 503);
        }
        if (!$proxied && @inet_pton($used) !== @inet_pton((string) $request['address'])) {
            throw new RuntimeException('The request to ' . $host . ' did not go to the address checked.', 502);
        }
        return ['status' => $status, 'body' => $body];
    }
}
