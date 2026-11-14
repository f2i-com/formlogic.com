<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\NativeAppService;
use FormLogic\Services\PluginNetwork;
use PHPUnit\Framework\TestCase;

/**
 * The network a plugin is granted: the site makes the requests a plugin's site route asks for, held
 * to the hosts it was granted, over https on 443, to public addresses only (or through the site's
 * own HTTPS proxy), never following a redirect, with a bounded answer and at most two requests a
 * step; and an app owner's secret goes only where a request names it and only to the hosts it may
 * be sent to, filled in by the site, and never back to the plugin in any form.
 */
final class PluginNetworkTest extends TestCase
{
    private const HOSTS = ['api.sms.example', 'other.sms.example'];
    private const PUBLIC = '93.184.216.34';

    /** @var list<array> the requests that went out */
    private array $sent = [];
    /** @var list<array{status: int, body: string}> what goes out is answered next */
    private array $answers = [];
    /** @var list<string> the addresses the host resolves to */
    private array $addresses = [self::PUBLIC];
    private int $lookUps = 0;
    /** @var array<string, string> the site's environment */
    private array $env = [];
    /** @var list<array{route: string, input: array}> what the plugin's code was handed */
    private array $handed = [];
    /** @var callable(string, array): array the plugin's code */
    private $plugin;

    /** What the plugin was granted: two hosts, and a token and a key that may go to the first only. */
    private static function granted(array $over = []): array
    {
        return $over + [
            'network' => self::HOSTS,
            'siteRoutes' => ['/api/site/send', '/api/site/sent', '/api/site/start', '/api/site/again'],
            'appSettings' => [
                ['key' => 'token', 'type' => 'secret', 'sendTo' => ['api.sms.example']],
                ['key' => 'key', 'type' => 'secret', 'sendTo' => ['api.sms.example']],
                ['key' => 'account', 'type' => 'text'],
            ],
        ];
    }

    private function network(): PluginNetwork
    {
        $native = $this->createMock(NativeAppService::class);
        $native->method('request')->willReturnCallback(function (string $appId, array $request, array $identity) {
            // As the runner hands it over: JSON, and back.
            $input = json_decode(json_encode($request['body'], JSON_THROW_ON_ERROR), true);
            $this->handed[] = ['route' => $request['path'], 'input' => $input, 'identity' => $identity];
            return ['status' => 200, 'body' => ($this->plugin)($request['path'], $input)];
        });
        return new PluginNetwork(
            $native,
            function (array $request): array {
                $this->sent[] = $request;
                return array_shift($this->answers) ?? ['status' => 200, 'body' => '{}'];
            },
            function (string $host): array {
                $this->lookUps++;
                return $this->addresses;
            },
            fn (string $name): ?string => $this->env[$name] ?? null,
        );
    }

    private function refusal(callable $act): string
    {
        try {
            $act();
        } catch (\RuntimeException $e) {
            return $e->getMessage();
        }
        return 'made';
    }

    private function fetch(array $request, array $secrets = []): array
    {
        return $this->network()->fetch(self::granted(), $request, $secrets);
    }

    public function testARequestGoesOnlyToAGrantedHostOverHttpsOnItsOwnPort(): void
    {
        $this->assertStringContainsString('not granted evil.example', $this->refusal(fn () => $this->fetch(['url' => 'https://evil.example/x'])));
        $this->assertStringContainsString('not granted api.sms.example.', $this->refusal(fn () => $this->fetch(['url' => 'https://api.sms.example./x'])), 'the exact name, not one with a trailing dot');
        $this->assertStringContainsString('not granted sub.api.sms.example', $this->refusal(fn () => $this->fetch(['url' => 'https://sub.api.sms.example/'])));
        $this->assertStringContainsString('https only', $this->refusal(fn () => $this->fetch(['url' => 'http://api.sms.example/x'])));
        $this->assertStringContainsString('port 443', $this->refusal(fn () => $this->fetch(['url' => 'https://api.sms.example:8443/x'])));
        $this->assertStringContainsString('a user, a password or a fragment', $this->refusal(fn () => $this->fetch(['url' => 'https://evil.example@api.sms.example/x'])));
        $this->assertStringContainsString('a user, a password or a fragment', $this->refusal(fn () => $this->fetch(['url' => 'https://api.sms.example@evil.example/x'])));
        $this->assertStringContainsString('a user, a password or a fragment', $this->refusal(fn () => $this->fetch(['url' => 'https://api.sms.example/x#y'])));
        $this->assertStringContainsString('does not reach', $this->refusal(fn () => $this->fetch(['url' => "https://api.sms.example/x y"])));
        $this->assertStringContainsString('does not reach', $this->refusal(fn () => $this->fetch(['url' => 'https://api.sms.example\\@evil.example/'])));
        $this->assertStringContainsString('method', $this->refusal(fn () => $this->fetch(['method' => 'CONNECT', 'url' => 'https://api.sms.example/'])));
        $this->assertSame([], $this->sent, 'nothing went out');

        // The address is written out again from what was checked: its host in lower case, no port.
        $this->assertSame(200, $this->fetch(['url' => 'HTTPS://API.SMS.example:443/v1/send?a=1'])['status']);
        $this->assertSame('https://api.sms.example/v1/send?a=1', $this->sent[0]['url']);
        $this->assertSame(['GET', null], [$this->sent[0]['method'], $this->sent[0]['proxy']]);
    }

    public function testAHostThatResolvesToAnAddressThatIsNotPublicIsNeverReached(): void
    {
        foreach ([['127.0.0.1'], ['10.1.2.3'], ['172.16.0.9'], ['192.168.1.1'], ['169.254.169.254'], ['100.100.100.200'], ['0.0.0.0'], ['::1'], ['fd00::1'], ['fe80::1'], ['::ffff:127.0.0.1'], ['64:ff9b:1::808:808'], [self::PUBLIC, '192.168.1.1']] as $addresses) {
            $this->addresses = $addresses;
            $this->assertStringContainsString('not public', $this->refusal(fn () => $this->fetch(['url' => 'https://api.sms.example/x'])), implode(',', $addresses));
        }
        $this->addresses = [];
        $this->assertStringContainsString('does not resolve', $this->refusal(fn () => $this->fetch(['url' => 'https://api.sms.example/x'])));
        $this->assertSame([], $this->sent);

        // A public one is pinned: the request goes to the address checked, IPv4 before IPv6.
        $this->addresses = ['2606:2800:220:1:248:1893:25c8:1946', self::PUBLIC];
        $this->fetch(['url' => 'https://api.sms.example/x']);
        $this->assertSame(self::PUBLIC, $this->sent[0]['address']);
    }

    /**
     * Where the site reaches the internet through an HTTPS proxy, a request goes through it, and the
     * proxy looks the host up: none is done here, and nothing is pinned. A host no_proxy names, or a
     * domain it is in, goes straight, checked and pinned as ever. Every other rule holds either way.
     */
    public function testThroughTheSitesProxyTheProxyLooksTheHostUp(): void
    {
        $this->addresses = ['10.0.0.9'];
        $this->env = ['https_proxy' => 'http://user:pass@proxy.internal:3128'];
        $this->fetch(['url' => 'https://api.sms.example/x']);
        $this->assertSame(['http://user:pass@proxy.internal:3128', null], [$this->sent[0]['proxy'], $this->sent[0]['address']]);
        $this->assertSame(0, $this->lookUps, 'no look-up here');
        // A bare host and port is an HTTP proxy; the upper-case name is read where the lower is not.
        $this->env = ['HTTPS_PROXY' => 'proxy.internal:3128'];
        $this->fetch(['url' => 'https://api.sms.example/x']);
        $this->assertSame('http://proxy.internal:3128', $this->sent[1]['proxy']);
        // The scheme, the host, the port and the size still hold, and a redirect is still the answer.
        $this->assertStringContainsString('not granted evil.example', $this->refusal(fn () => $this->fetch(['url' => 'https://evil.example/x'])));
        $this->assertStringContainsString('https only', $this->refusal(fn () => $this->fetch(['url' => 'http://api.sms.example/x'])));
        $this->assertStringContainsString('port 443', $this->refusal(fn () => $this->fetch(['url' => 'https://api.sms.example:8443/x'])));
        $this->answers[] = ['status' => 200, 'body' => str_repeat('x', PluginNetwork::MAX_ANSWER_BYTES + 1)];
        $this->assertStringContainsString('larger than a plugin is given', $this->refusal(fn () => $this->fetch(['url' => 'https://api.sms.example/x'])));
        $this->answers[] = ['status' => 302, 'body' => ''];
        $this->assertSame(302, $this->fetch(['url' => 'https://api.sms.example/x'])['status']);

        // No proxy for a host no_proxy names, or for every host with *.
        foreach (['sms.example', '.sms.example', 'api.sms.example:443', 'other.example, api.sms.example', '*'] as $skip) {
            $this->addresses = [self::PUBLIC];
            $this->env = ['https_proxy' => 'http://proxy.internal:3128', 'no_proxy' => $skip];
            $this->fetch(['url' => 'https://api.sms.example/x']);
            $this->assertSame([null, self::PUBLIC], [end($this->sent)['proxy'], end($this->sent)['address']], $skip);
        }
        $this->env = ['https_proxy' => 'http://proxy.internal:3128', 'NO_PROXY' => 'example.org,mysms.example'];
        $this->fetch(['url' => 'https://api.sms.example/x']);
        $this->assertSame('http://proxy.internal:3128', end($this->sent)['proxy'], 'mysms.example is not sms.example');

        // A proxy that is not an HTTP one to tunnel through is not used, and nothing goes out.
        $this->env = ['https_proxy' => 'socks5://proxy.internal:1080'];
        $count = count($this->sent);
        $this->assertStringContainsString('not an HTTP proxy', $this->refusal(fn () => $this->fetch(['url' => 'https://api.sms.example/x'])));
        $this->assertCount($count, $this->sent);
    }

    public function testARedirectIsNotFollowedButIsTheAnswer(): void
    {
        $this->answers[] = ['status' => 302, 'body' => 'Moved to https://evil.example/'];
        $this->assertSame(['status' => 302, 'body' => 'Moved to https://evil.example/'], $this->fetch(['url' => 'https://api.sms.example/x']));
        $this->assertCount(1, $this->sent, 'one request, and no second one where it pointed');
    }

    public function testAnAnswerLargerThanAPluginIsGivenIsRefused(): void
    {
        $this->answers[] = ['status' => 200, 'body' => str_repeat('x', PluginNetwork::MAX_ANSWER_BYTES + 1)];
        $this->assertStringContainsString('larger than a plugin is given', $this->refusal(fn () => $this->fetch(['url' => 'https://api.sms.example/x'])));
        $this->answers[] = ['status' => 200, 'body' => json_encode(['ok' => true, 'pad' => str_repeat('y', 100)])];
        $this->assertTrue($this->fetch(['url' => 'https://api.sms.example/x'])['body']->ok, 'JSON is handed over as JSON');
    }

    public function testHeadersAndBodiesAreOnlyWhatTheSiteSends(): void
    {
        foreach ([
            ['Host' => 'evil.example'], ['Content-Length' => '1'], ['Content-Type' => 'text/plain'], ['Transfer-Encoding' => 'chunked'],
            ['X-Ok' => "a\r\nX-Evil: 1"], ['Bad Name' => 'x'], ['X-Long' => str_repeat('a', 1025)],
        ] as $headers) {
            $this->assertNotSame('made', $this->refusal(fn () => $this->fetch(['url' => 'https://api.sms.example/x', 'headers' => $headers])), json_encode($headers));
        }
        $this->assertStringContainsString('a form and JSON', $this->refusal(fn () => $this->fetch(['method' => 'POST', 'url' => 'https://api.sms.example/x', 'form' => ['a' => 'b'], 'json' => []])));
        $this->assertStringContainsString('none on a GET', $this->refusal(fn () => $this->fetch(['url' => 'https://api.sms.example/x', 'form' => ['a' => 'b']])));
        $this->assertStringContainsString('at most 16 KB', $this->refusal(fn () => $this->fetch(['method' => 'POST', 'url' => 'https://api.sms.example/x', 'json' => str_repeat('z', 17000)])));
        $this->assertSame([], $this->sent);

        $this->fetch(['method' => 'POST', 'url' => 'https://api.sms.example/x', 'headers' => ['Accept' => 'application/json'], 'form' => ['To' => '+61412345678', 'Channel' => 'sms']]);
        $this->assertSame(['Accept: application/json', 'Content-Type: application/x-www-form-urlencoded'], $this->sent[0]['headers']);
        $this->assertSame('To=%2B61412345678&Channel=sms', $this->sent[0]['body']);
        $this->fetch(['method' => 'PUT', 'url' => 'https://api.sms.example/x', 'json' => ['a' => [1, 2]]]);
        $this->assertSame('{"a":[1,2]}', $this->sent[1]['body']);
    }

    /**
     * The secret goes where the request names it, and only there: the site fills it in, and any of the
     * owner's secrets an answer carries back, as given or as sent, is blanked before the plugin sees it.
     */
    public function testAnOwnersSecretIsFilledInByTheSiteAndNeverReachesThePlugin(): void
    {
        $secrets = ['token' => 'tok-' . bin2hex(random_bytes(8)), 'key' => 'key-' . bin2hex(random_bytes(8))];
        $basic = base64_encode('user-1:' . $secrets['token']);
        $this->plugin = function (string $route, array $input): array {
            if ($route === '/api/site/send') {
                return ['request' => [
                    'method' => 'POST', 'url' => 'https://api.sms.example/send',
                    'headers' => ['X-Key' => ['Bearer ', ['secret' => 'key']]],
                    'auth' => ['basic' => ['user' => 'user-1', 'password' => ['secret' => 'token']]],
                    'form' => ['to' => $input['phone']],
                ], 'continue' => '/api/site/sent', 'state' => ['n' => 1]];
            }
            return ['decided' => $input['response'], 'state' => $input['state'] ?? null];
        };
        // A host that echoes what it was sent.
        $this->answers[] = ['status' => 201, 'body' => json_encode(['echo' => ['authorization' => 'Basic ' . $basic, 'key' => 'Bearer ' . $secrets['key'], 'raw' => $secrets['token']], $secrets['token'] => 'as a name'])];
        $plugin = ['appId' => 'plugin-app', 'manifestId' => 'example.codes'];
        $answer = $this->network()->call($plugin, self::granted(), '/api/site/send', ['phone' => '+61412345678'], $secrets);

        foreach (['Authorization: Basic ' . $basic, 'X-Key: Bearer ' . $secrets['key'], 'Content-Type: application/x-www-form-urlencoded'] as $header) {
            $this->assertContains($header, $this->sent[0]['headers']);
        }
        $this->assertSame('to=%2B61412345678', $this->sent[0]['body']);
        $this->assertSame(201, $answer['decided']['status']);
        $this->assertSame(['authorization' => 'Basic ' . PluginNetwork::BLANKED, 'key' => PluginNetwork::BLANKED, 'raw' => PluginNetwork::BLANKED], $answer['decided']['body']['echo']);
        $this->assertSame(['n' => 1], $answer['state'], 'its state comes back with the answer');
        $handed = json_encode($this->handed);
        foreach ([...array_values($secrets), $basic] as $secret) {
            $this->assertStringNotContainsString($secret, $handed, 'never in what the plugin was handed');
        }
        $this->assertSame(['formlogic' => ['appId' => 'plugin-app']], $this->handed[0]['identity']);
    }

    /** A secret goes only to a host it may be sent to: another of the plugin's hosts is refused it. */
    public function testASecretIsSentOnlyToTheHostsItMayGoTo(): void
    {
        $secrets = ['token' => 'tok-1234567890'];
        $this->assertStringContainsString('the secret token to be sent to other.sms.example, where it may not go',
            $this->refusal(fn () => $this->fetch(['url' => 'https://other.sms.example/x', 'headers' => ['X-Key' => ['secret' => 'token']]], $secrets)));
        $this->assertStringContainsString('where it may not go',
            $this->refusal(fn () => $this->fetch(['url' => 'https://other.sms.example/x', 'auth' => ['basic' => ['user' => 'u', 'password' => ['secret' => 'token']]]], $secrets)));
        // A secret its manifest does not declare goes nowhere.
        $this->assertStringContainsString('where it may not go', $this->refusal(fn () => $this->fetch(['url' => 'https://api.sms.example/x', 'headers' => ['X-Key' => ['secret' => 'other']]], ['other' => 'x'])));
        $this->assertSame([], $this->sent);
        // The same request without the secret goes; and with it, to the host it may go to.
        $this->fetch(['url' => 'https://other.sms.example/x']);
        $this->fetch(['url' => 'https://api.sms.example/x', 'headers' => ['X-Key' => ['secret' => 'token']]], $secrets);
        $this->assertSame(['X-Key: tok-1234567890'], $this->sent[1]['headers']);
    }

    public function testASecretTheOwnerHasNotGivenIsNeverAskedFor(): void
    {
        $this->assertStringContainsString('has not given it: key', $this->refusal(fn () => $this->fetch(['url' => 'https://api.sms.example/x', 'headers' => ['X-Key' => ['secret' => 'key']]], ['token' => 't'])));
        $this->assertStringContainsString('{"secret": name}', $this->refusal(fn () => $this->fetch(['url' => 'https://api.sms.example/x', 'headers' => ['X-Key' => ['setting' => 'token']]], ['token' => 't'])));
        $this->assertStringContainsString('line break', $this->refusal(fn () => $this->fetch(['url' => 'https://api.sms.example/x', 'headers' => ['X-Key' => ['secret' => 'token']]], ['token' => "t\r\nX-Evil: 1"])));
        $this->assertSame([], $this->sent);
    }

    /**
     * After a request that carried a secret, a secret comes back to the plugin in no form: URL-encoded
     * either way, in another case, as a number, or in text the site does not read as JSON (which then
     * reaches it as null, its status kept). Without one, text is handed over as text.
     */
    public function testASecretComesBackInNoForm(): void
    {
        $token = 'Tok/en+' . random_int(100000, 999999) . '=x';
        $digits = (string) random_int(100000000, 999999999);
        $secrets = ['token' => $token, 'key' => $digits];
        $carrying = ['url' => 'https://api.sms.example/x', 'headers' => ['X-Token' => ['secret' => 'token'], 'X-Key' => ['secret' => 'key']]];
        $echo = function (mixed $body) use ($secrets, $carrying): mixed {
            $this->answers[] = ['status' => 200, 'body' => is_string($body) ? $body : json_encode($body)];
            return $this->fetch($carrying, $secrets)['body'];
        };
        $this->assertSame(['a' => PluginNetwork::BLANKED, 'b' => PluginNetwork::BLANKED, 'c' => 'x' . PluginNetwork::BLANKED . 'y', 'd' => PluginNetwork::BLANKED],
            (array) $echo(['a' => rawurlencode($token), 'b' => urlencode($token), 'c' => 'x' . strtoupper($token) . 'y', 'd' => strtolower(rawurlencode($token))]));
        $this->assertSame(PluginNetwork::BLANKED, $echo(['n' => (int) $digits])->n, 'a number that spells it');
        $this->assertSame(PluginNetwork::BLANKED, $echo(['n' => (float) $digits])->n);
        $this->assertSame(7, $echo(['n' => 7])->n, 'a number that does not, as it was');
        // Text that is not JSON, or JSON deeper than the site reads: nothing of it, its status kept.
        $this->answers[] = ['status' => 401, 'body' => 'unauthorized: ' . str_replace('/', '\/', $token)];
        $this->assertSame(['status' => 401, 'body' => null], $this->fetch($carrying, $secrets));
        $deep = str_repeat('[', 70) . json_encode($token) . str_repeat(']', 70);
        $this->answers[] = ['status' => 200, 'body' => $deep];
        $this->assertSame(['status' => 200, 'body' => null], $this->fetch($carrying, $secrets));
        // A request that carried none hands text over as text.
        $this->answers[] = ['status' => 503, 'body' => 'down for maintenance'];
        $this->assertSame(['status' => 503, 'body' => 'down for maintenance'], $this->fetch(['url' => 'https://api.sms.example/x'], $secrets));
    }

    public function testAtMostTwoRequestsInOneStepAndOnlyAtThePluginsOwnSiteRoutes(): void
    {
        $this->plugin = fn (string $route, array $input): array => ['request' => ['url' => 'https://api.sms.example/again'], 'continue' => '/api/site/again'];
        $plugin = ['appId' => 'plugin-app', 'manifestId' => 'example.codes'];
        $this->assertStringContainsString('more than 2 requests', $this->refusal(fn () => $this->network()->call($plugin, self::granted(), '/api/site/start', [])));
        $this->assertCount(2, $this->sent);

        $this->sent = [];
        $this->plugin = fn (string $route, array $input): array => ['request' => ['url' => 'https://api.sms.example/x'], 'continue' => '/api/pass'];
        $this->assertStringContainsString('no route of its own under /api/site/', $this->refusal(fn () => $this->network()->call($plugin, self::granted(), '/api/site/start', [])));
        $this->assertSame([], $this->sent, 'refused before anything went out');

        $this->plugin = fn (string $route, array $input): array => ['request' => ['url' => 'https://api.sms.example/x'], 'continue' => '/api/site/again', 'state' => str_repeat('s', 5000)];
        $this->assertStringContainsString('state is larger', $this->refusal(fn () => $this->network()->call($plugin, self::granted(), '/api/site/start', [])));

        // A plugin's refusal ends the step.
        $native = $this->createMock(NativeAppService::class);
        $native->method('request')->willReturn(['status' => 500, 'body' => ['error' => 'no']]);
        $this->assertStringContainsString('answered 500', $this->refusal(fn () => (new PluginNetwork($native, fn () => ['status' => 200, 'body' => ''], fn () => [self::PUBLIC], fn () => null))->call($plugin, self::granted(), '/api/site/start', [])));
    }
}
