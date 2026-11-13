<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Middleware\SecurityHeadersMiddleware;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * The policy a JavaScript app's built site is sent under, and the one place the API's security
 * headers let it through: a response at a site's own address that carries exactly the policy for
 * that address. That response may be framed (by this site's own pages, and by the addresses the
 * environment says its pages are served from); every other one keeps the API's policy and its
 * refusal to be framed.
 */
final class SiteFramePolicyTest extends TestCase
{
    private const ORIGIN = 'https://apps.example.test';
    /** Its host, which the policy names the site's own files by: under both schemes, whichever one this server takes itself to be reached by. */
    private const HOST = 'apps.example.test';
    private const TICKET = 'v3-20001-0123456789abcdef0123456789abcdef01234567-0123456789abcdef0123456789abcdef';
    private const PREFIX = '/api/app/shop/site/' . self::TICKET . '/';
    /** The API's own policy, which every other response is held to. */
    private const API_POLICY = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
    /** Where the environment says this installation's pages are served from, when that is not the API's own address. */
    private const FRAMERS = ['CORS_ORIGIN', 'CORS_ALLOWED_ORIGINS'];
    /** Every setting that names this installation: those, and where its pages are. */
    private const NAMED = ['CORS_ORIGIN', 'CORS_ALLOWED_ORIGINS', 'APP_URL'];

    /** @var array<string, array{0: mixed, 1: mixed, 2: string|false}> what the environment said before a test, to put back after it */
    private array $said = [];

    protected function setUp(): void
    {
        // The usual installation, its pages and its API on one address: the environment names no other.
        foreach (self::NAMED as $name) {
            $this->said[$name] = [$_ENV[$name] ?? null, $_SERVER[$name] ?? null, getenv($name)];
            unset($_ENV[$name], $_SERVER[$name]);
            putenv($name);
        }
    }

    protected function tearDown(): void
    {
        foreach ($this->said as $name => [$env, $server, $process]) {
            if ($env === null) unset($_ENV[$name]); else $_ENV[$name] = $env;
            if ($server === null) unset($_SERVER[$name]); else $_SERVER[$name] = $server;
            putenv($process === false ? $name : $name . '=' . $process);
        }
    }

    private static function policy(string $origin = self::ORIGIN, string $prefix = self::PREFIX): string
    {
        return SecurityHeadersMiddleware::siteFramePolicy($origin, $prefix);
    }

    /**
     * A site's own files as its policy names them: the address they are served under, over plain
     * HTTP and over HTTPS, in that order. Both, because a server behind a proxy often does not
     * know which it is reached by; and each in full, because a browser's engine (Safari's)
     * matches no address written without a scheme for a page that has no origin.
     *
     * @return array{0: string, 1: string}
     */
    private static function own(string $host = self::HOST, string $prefix = self::PREFIX): array
    {
        return ['http://' . $host . $prefix, 'https://' . $host . $prefix];
    }

    /**
     * A policy as a browser reads it: each directive's name and what it lists.
     *
     * @return array<string, list<string>>
     */
    private static function directives(string $policy): array
    {
        $read = [];
        foreach (explode(';', $policy) as $directive) {
            $words = preg_split('/\s+/', trim($directive), -1, PREG_SPLIT_NO_EMPTY) ?: [];
            $name = (string) array_shift($words);
            self::assertNotSame('', $name, 'no empty directive');
            // A browser goes by the first of a name and ignores the rest.
            self::assertArrayNotHasKey($name, $read, "{$name} is given once");
            $read[$name] = $words;
        }
        return $read;
    }

    /** A response carrying the policy given (none for null), as the API's security headers send it on for the address asked. */
    private static function through(string $address, ?string $policy): ResponseInterface
    {
        $handler = new class($policy) implements RequestHandlerInterface {
            public function __construct(private ?string $policy) {}
            public function handle(ServerRequestInterface $request): ResponseInterface { return $this->policy === null ? new Response() : (new Response())->withHeader('Content-Security-Policy', $this->policy); }
        };
        return (new SecurityHeadersMiddleware())->process((new ServerRequestFactory())->createServerRequest('GET', $address), $handler);
    }

    private function assertHeldToTheApisPolicy(ResponseInterface $response, string $what): void
    {
        $this->assertSame(self::API_POLICY, $response->getHeaderLine('Content-Security-Policy'), $what);
        $this->assertSame('DENY', $response->getHeaderLine('X-Frame-Options'), $what);
        $this->assertSame('strict-origin-when-cross-origin', $response->getHeaderLine('Referrer-Policy'), $what);
    }

    public function testTheSandboxGivesThePageNoOriginOfItsOwnAndNoHoldOnTheWindowThatFramesIt(): void
    {
        $policy = self::policy();
        $sandbox = self::directives($policy)['sandbox'] ?? null;
        $this->assertSame(explode(' ', SecurityHeadersMiddleware::SITE_FRAME_SANDBOX), $sandbox, 'the list the frame names too');
        $this->assertStringStartsWith('sandbox ', $policy);
        $this->assertContains('allow-scripts', $sandbox, 'the app runs');
        $this->assertNotContains('allow-same-origin', $sandbox);
        foreach ($sandbox as $allowed) {
            $this->assertStringStartsWith('allow-', $allowed);
            $this->assertStringStartsNotWith('allow-top-navigation', $allowed);
        }
        // Nor anywhere else in the policy.
        $this->assertStringNotContainsString('allow-same-origin', $policy);
        $this->assertStringNotContainsString('allow-top-navigation', $policy);
    }

    public function testEveryKindOfLoadIsHeldToTheSitesOwnFiles(): void
    {
        $policy = self::policy();
        $read = self::directives($policy);
        // The site's own address, as far as its ticket and no shorter, under each of the two schemes.
        $own = self::own();
        $this->assertSame(['http://apps.example.test/api/app/shop/site/' . self::TICKET . '/', 'https://apps.example.test/api/app/shop/site/' . self::TICKET . '/'], $own);

        $this->assertSame(["'none'"], $read['default-src'] ?? null, 'whatever is not named below is refused');
        // What a build loads, each from the site's own address, by whichever scheme the page came.
        foreach (['script-src', 'style-src', 'img-src', 'font-src', 'media-src', 'connect-src', 'worker-src', 'manifest-src'] as $name) {
            foreach ($own as $address) $this->assertContains($address, $read[$name] ?? [], "{$name} takes the site's own files at {$address}");
            $this->assertSame($own, array_slice($read[$name], 0, 2), "{$name} names them first, and once each");
        }
        // And no fetch directive names anywhere else, or anything wider: each source is one of those
        // two addresses exactly, or a word that names no host (inline, eval, data: and blob:, which
        // are the page's own).
        $local = ["'none'", "'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'", 'data:', 'blob:'];
        $fetch = array_filter($read, static fn (string $name): bool => str_ends_with($name, '-src'), ARRAY_FILTER_USE_KEY);
        $this->assertGreaterThanOrEqual(11, count($fetch));
        foreach ($fetch as $name => $sources) {
            $this->assertNotSame([], $sources, "{$name} lists something");
            foreach ($sources as $source) {
                $this->assertTrue(in_array($source, $own, true) || in_array($source, $local, true), "{$name} lets in {$source}");
            }
            $this->assertSame($sources, array_values(array_unique($sources)), "{$name} names nothing twice");
            if (in_array("'none'", $sources, true)) $this->assertSame(["'none'"], $sources, "{$name}: 'none' stands alone");
        }
        // Requests go to the site's own files and nowhere else: not the API, not another app, not another site.
        $this->assertSame($own, $read['connect-src']);
        $this->assertSame(["'none'"], $read['frame-src'] ?? null);
        $this->assertSame(["'none'"], $read['object-src'] ?? null);
        $this->assertSame($own, $read['base-uri'] ?? null);
        $this->assertSame(["'none'"], $read['form-action'] ?? null);
        // Those two are every address the whole policy names: no shorter one (the host alone, the
        // API, the app without its ticket), and none without a scheme.
        $words = array_merge(...array_values($read));
        $addresses = array_filter($words, static fn (string $word): bool => str_contains($word, '/') || str_contains($word, self::HOST));
        $this->assertSame($own, array_values(array_unique($addresses)));
        // Only this site's own pages may frame it: the last thing the policy says, and with no
        // other address named in the environment, all it says of framing.
        $this->assertSame(["'self'"], $read['frame-ancestors'] ?? null);
        $this->assertStringEndsWith("; frame-ancestors 'self'", $policy);

        // Nothing else stands for "this whole site" or "anywhere": 'self' is who may frame the
        // page, never where the page may load from.
        foreach ($read as $name => $sources) {
            if ($name !== 'frame-ancestors') $this->assertNotContains("'self'", $sources, "{$name} takes the whole of this site");
        }
        $this->assertSame(1, substr_count($policy, "'self'"));
        $this->assertStringNotContainsString('*', $policy);
        // A scheme is named only as part of one of those addresses, never alone (which would take every address under it).
        foreach (['http:', 'https:', 'ws:', 'wss:', 'filesystem:'] as $scheme) {
            foreach ($read as $name => $sources) $this->assertNotContains($scheme, $sources, "{$name} takes any {$scheme} address");
        }
    }

    public function testThePolicyIsForOneAddressOnOneHostAndPortWhicheverSchemeItWasReachedBy(): void
    {
        $this->assertSame(self::policy(), self::policy(), 'the same for the same address');
        $other = self::policy(self::ORIGIN, '/api/app/other/site/' . self::TICKET . '/');
        $this->assertStringNotContainsString(self::PREFIX, $other, 'another app\'s site may not load this one\'s files');
        $this->assertSame(self::own(self::HOST, '/api/app/other/site/' . self::TICKET . '/'), self::directives($other)['connect-src']);
        $this->assertStringContainsString('connect-src http://' . self::HOST . '/api/app/other/site/' . self::TICKET . '/ https://' . self::HOST . '/api/app/other/site/' . self::TICKET . '/;', $other);
        // A port is part of the address the site's files are named by; who may frame it is said the same way on any.
        $port = self::policy('https://apps.example.test:8443');
        $this->assertSame(["'self'"], self::directives($port)['frame-ancestors']);
        $this->assertSame(['http://apps.example.test:8443' . self::PREFIX, 'https://apps.example.test:8443' . self::PREFIX], self::directives($port)['connect-src']);
        $this->assertSame(self::own('apps.example.test:8443'), self::directives($port)['base-uri']);
        $this->assertSame(array_merge(self::own('apps.example.test:8443'), ["'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'", 'blob:']), self::directives($port)['script-src']);
        $this->assertStringNotContainsString('apps.example.test/', $port, 'and nothing of the same host on its usual port');
        $this->assertNotSame(self::policy(), $port);
        $other = self::policy('https://other.example.test');
        $this->assertNotSame(self::policy(), $other, 'another host has another');
        $this->assertSame(self::own('other.example.test'), self::directives($other)['connect-src']);
        // The scheme this server takes itself to be reached by is no part of it: the site's files
        // are named under both whichever it is, so one behind a proxy, which often takes itself to
        // be on plain HTTP, sends the policy that holds the HTTPS page.
        $this->assertSame(self::policy(), self::policy('http://apps.example.test'));
        $this->assertSame($port, self::policy('http://apps.example.test:8443'));
        $this->assertSame(self::own(), self::directives(self::policy('http://apps.example.test'))['connect-src']);
    }

    public function testWherePagesAreServedFromAnotherAddressThatAddressMayFrameTheSiteToo(): void
    {
        $usual = self::policy();
        $this->assertStringEndsWith("; frame-ancestors 'self'", $usual);

        // The page on one name and the API on another: the name the API answers pages on.
        $_ENV['CORS_ORIGIN'] = 'https://www.example.test';
        $this->assertSame($usual . ' https://www.example.test', self::policy(), 'nothing else of the policy changes');
        $this->assertSame(["'self'", 'https://www.example.test'], self::directives(self::policy())['frame-ancestors']);

        // And every other one it answers pages on, in the order given: each once, without the
        // space around it or the slash after it, with its port, or for every name under one.
        $_ENV['CORS_ALLOWED_ORIGINS'] = 'https://admin.example.test, http://localhost:5173 ,https://*.example.test,https://b.example.test:8443/,https://www.example.test,https://admin.example.test';
        $framers = ['https://www.example.test', 'https://admin.example.test', 'http://localhost:5173', 'https://*.example.test', 'https://b.example.test:8443'];
        $this->assertSame($usual . ' ' . implode(' ', $framers), self::policy());
        $this->assertSame(array_merge(["'self'"], $framers), self::directives(self::policy())['frame-ancestors']);
        // The site's files are still named by the address it is served from, and no other.
        $this->assertSame(self::own(), self::directives(self::policy())['connect-src']);
        $this->assertSame(self::own(), self::directives(self::policy())['base-uri']);
        $this->assertSame(self::directives($usual)['script-src'], self::directives(self::policy())['script-src']);

        // The list alone, with no first address named.
        unset($_ENV['CORS_ORIGIN']);
        $this->assertSame(array_merge(["'self'"], array_slice($framers, 1), ['https://www.example.test']), self::directives(self::policy())['frame-ancestors']);

        // The policy let through at a site's address is the one made here and now: the one that
        // names those addresses, and not the one of an installation that names none.
        $named = self::policy();
        $response = self::through(self::ORIGIN . self::PREFIX . 'index.html', $named);
        $this->assertSame($named, $response->getHeaderLine('Content-Security-Policy'));
        $this->assertFalse($response->hasHeader('X-Frame-Options'));
        $this->assertHeldToTheApisPolicy(self::through(self::ORIGIN . self::PREFIX . 'index.html', $usual), 'the policy of an installation whose environment names no address');

        // Neither variable set again, it is the usual policy.
        unset($_ENV['CORS_ALLOWED_ORIGINS']);
        $this->assertSame($usual, self::policy());
    }

    public function testNothingNamedInTheEnvironmentThatIsNotTheShapeOfAnAddressMayFrameTheSite(): void
    {
        $usual = self::policy();
        $dropped = [
            // Anyone, or any name at all.
            '*', 'https://*', 'http://*', 'https://*.', 'https://*.*.example.test', 'https://exa*mple.test', '*.example.test',
            // No scheme, another scheme, a scheme and nothing more.
            'www.example.test', '//www.example.test', 'ftp://www.example.test', 'wss://www.example.test', 'javascript:alert(1)', 'data:', 'https:', 'https://',
            // More than a scheme, a host and a port: a path, a query, someone's name, a port that is none.
            'https://www.example.test/app', 'https://www.example.test?x=1', 'https://www.example.test#x', 'https://user@www.example.test',
            'https://www.example.test:', 'https://www.example.test:123456', 'https://www.example.test:80a', 'https://[::1]',
            // What would end the directive, or add a word to it.
            'https://www.example.test; script-src *', 'https://www.example.test;', "https://www.example.test 'unsafe-inline'", "https://www.example.test\nscript-src *",
            'https://www.exam ple.test', 'https://www.example.test"', "'none'", "'self'", "'unsafe-inline'",
            'null', '', ' ',
        ];
        foreach ($dropped as $named) {
            $shown = json_encode($named);
            $_ENV['CORS_ORIGIN'] = $named;
            unset($_ENV['CORS_ALLOWED_ORIGINS']);
            $this->assertSame($usual, self::policy(), "{$shown} as the first address");
            unset($_ENV['CORS_ORIGIN']);
            $_ENV['CORS_ALLOWED_ORIGINS'] = $named;
            $this->assertSame($usual, self::policy(), "{$shown} as the only other address");
            // Among addresses that are: it is left out, and they are kept.
            $_ENV['CORS_ALLOWED_ORIGINS'] = "https://a.example.test,{$named},https://b.example.test";
            $this->assertSame($usual . ' https://a.example.test https://b.example.test', self::policy(), "{$shown} among others");
        }
        // All of them at once, in both: the policy has the directives it should, and no more.
        $_ENV['CORS_ORIGIN'] = implode(' ', $dropped);
        $_ENV['CORS_ALLOWED_ORIGINS'] = implode(',', $dropped);
        $this->assertSame($usual, self::policy());
        $this->assertSame(["'self'"], self::directives(self::policy())['frame-ancestors']);
    }

    public function testAResponseAtASiteAddressCarryingExactlyItsPolicyKeepsItAndMayBeFramed(): void
    {
        $policy = self::policy();
        foreach (['index.html', '', 'assets/app.js', 'docs/', 'orders/12', 'index.html?formlogic-raw=1', 'Build/game.wasm.br'] as $path) {
            $response = self::through(self::ORIGIN . self::PREFIX . $path, $policy);
            $this->assertSame($policy, $response->getHeaderLine('Content-Security-Policy'), "'{$path}'");
            $this->assertFalse($response->hasHeader('X-Frame-Options'), "'{$path}' may be framed, by the pages its policy names");
            // The address holds the ticket: it is not sent on to wherever the page links or loads from.
            $this->assertSame('no-referrer', $response->getHeaderLine('Referrer-Policy'), "'{$path}'");
            $this->assertSame('nosniff', $response->getHeaderLine('X-Content-Type-Options'), "'{$path}'");
        }
        // Reached on a port of its own, the policy that is let through is the one naming that port.
        $onPort = 'https://apps.example.test:8443';
        $response = self::through($onPort . self::PREFIX . 'index.html', self::policy($onPort));
        $this->assertSame(self::policy($onPort), $response->getHeaderLine('Content-Security-Policy'));
        $this->assertFalse($response->hasHeader('X-Frame-Options'));
        $this->assertHeldToTheApisPolicy(self::through($onPort . self::PREFIX . 'index.html', $policy), 'the policy for the same address on the usual port');
        // Reached over plain HTTP, or taking itself to be (a proxy in front of it holds the lock):
        // the policy names the site's files under both schemes, so it is the same one, and is let through as it is.
        $response = self::through('http://apps.example.test' . self::PREFIX . 'index.html', $policy);
        $this->assertSame($policy, $response->getHeaderLine('Content-Security-Policy'));
        $this->assertFalse($response->hasHeader('X-Frame-Options'));
        $this->assertSame('no-referrer', $response->getHeaderLine('Referrer-Policy'));
    }

    public function testAResponseAtASiteAddressCarryingAnyOtherPolicyOrNoneGetsTheApisAndStaysUnframeable(): void
    {
        $policy = self::policy();
        $otherTicket = 'v3-20001-' . str_repeat('f', 40) . '-' . str_repeat('f', 32);
        $others = [
            'no policy at all' => null,
            'an empty one' => '',
            'the policy with one more directive' => $policy . '; script-src *',
            'the policy with a directive before it' => "script-src *; {$policy}",
            'the policy given an origin of its own' => str_replace('allow-scripts', 'allow-scripts allow-same-origin', $policy),
            'the policy let to move the window' => str_replace('allow-scripts', 'allow-scripts allow-top-navigation', $policy),
            'the policy without its sandbox' => substr($policy, strlen('sandbox ' . SecurityHeadersMiddleware::SITE_FRAME_SANDBOX . '; ')),
            'the policy framed by anyone' => str_replace("frame-ancestors 'self'", 'frame-ancestors *', $policy),
            'the policy framed by a site the environment does not name' => $policy . ' https://other.example.test',
            'the policy framed by this site named by its address' => str_replace("frame-ancestors 'self'", 'frame-ancestors ' . self::ORIGIN, $policy),
            // The site's own files named another way, or more than its own files named.
            'the policy with its files named without a scheme' => str_replace(implode(' ', self::own()), self::HOST . self::PREFIX, $policy),
            'the policy with its files named under one scheme alone' => str_replace(implode(' ', self::own()), self::own()[1], $policy),
            'the policy with its files named in the other order' => str_replace(implode(' ', self::own()), implode(' ', array_reverse(self::own())), $policy),
            'the policy for every file of this site' => str_replace(self::PREFIX, '/', $policy),
            'the policy for the whole of the API' => str_replace(self::PREFIX, '/api/', $policy),
            'the policy for the app without its ticket' => str_replace(self::PREFIX, '/api/app/shop/site/', $policy),
            'the policy for any site under either scheme' => str_replace(implode(' ', self::own()), 'http: https:', $policy),
            'the policy written another way' => str_replace('; ', ';', $policy),
            'the policy in capitals' => strtoupper($policy),
            'the policy for another address of the same app' => self::policy(self::ORIGIN, '/api/app/shop/site/' . $otherTicket . '/'),
            'the policy for another app' => self::policy(self::ORIGIN, '/api/app/other/site/' . self::TICKET . '/'),
            'the policy for another site' => self::policy('https://other.example.test'),
            'the policy for this site on another port' => self::policy('https://apps.example.test:8443'),
            'a sandbox of someone\'s own' => "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'",
            'a loose one' => "default-src 'self'",
        ];
        foreach ($others as $what => $carried) {
            $this->assertNotSame($policy, $carried, "{$what} really is another policy");
            foreach (['index.html', '', 'assets/app.js'] as $path) {
                $this->assertHeldToTheApisPolicy(self::through(self::ORIGIN . self::PREFIX . $path, $carried), "{$what}, at '{$path}'");
            }
        }
        $this->assertStringNotContainsString($policy, (string) $others['the policy without its sandbox'], 'that one really is another policy');
    }

    public function testASitePolicyAtAnAddressThatIsNotASitesIsReplaced(): void
    {
        $policy = self::policy();
        $elsewhere = [
            '/api/apps', '/api/app/shop', '/api/app/shop/native', '/api/app/shop/native/media', '/api/app/shop/look/icon.svg',
            // Not all of a site's address.
            '/api/app/shop/site', '/api/app/shop/site/', '/api/app/shop/site/' . self::TICKET, '/api/app//site/' . self::TICKET . '/index.html',
            // A site's address somewhere it is not served.
            '/app/shop/site/' . self::TICKET . '/index.html', '/x/api/app/shop/site/' . self::TICKET . '/index.html', '/API/app/shop/site/' . self::TICKET . '/index.html',
            '/api/app/shop/Site/' . self::TICKET . '/index.html', '/api/apps/shop/site/' . self::TICKET . '/index.html', '/', '',
        ];
        foreach ($elsewhere as $path) {
            $this->assertHeldToTheApisPolicy(self::through(self::ORIGIN . $path, $policy), "a site's policy at {$path}");
            // Nor the policy that address would have, were it a site's.
            $this->assertHeldToTheApisPolicy(self::through(self::ORIGIN . $path, self::policy(self::ORIGIN, rtrim($path, '/') . '/')), "its own would-be policy at {$path}");
        }
        // A slug or a ticket with a character that could end a directive is no site's address, so a
        // policy made from it (which would carry a directive of the sender's own) is never let through.
        foreach (['/api/app/shop;x/site/' . self::TICKET . '/', '/api/app/shop/site/v3-20001;x/', "/api/app/shop'x/site/" . self::TICKET . '/', "/api/app/shop/site/v3'x/", '/api/app/shop/site/' . strtoupper(self::TICKET) . '/'] as $prefix) {
            $this->assertHeldToTheApisPolicy(self::through(self::ORIGIN . $prefix . 'index.html', self::policy(self::ORIGIN, $prefix)), $prefix);
        }
        $injected = '/api/app/shop/site/v3; script-src * ; x/';
        $this->assertHeldToTheApisPolicy(self::through(self::ORIGIN . '/api/app/shop/site/v3;%20script-src%20*%20;%20x/index.html', self::policy(self::ORIGIN, $injected)), 'a ticket that is a directive');
    }

    public function testTheSiteAddressRuleTakesNoSlugOrTicketThatCouldEndADirective(): void
    {
        $rule = SecurityHeadersMiddleware::SITE_FRAME_PATH;
        // A site's address, read as far as its ticket: that much, and no more, goes into the policy.
        foreach (['index.html', '', 'assets/app.js', 'a; script-src *', "a' b\" c", '../../x'] as $rest) {
            $this->assertSame(1, preg_match($rule, self::PREFIX . $rest, $found), "'{$rest}'");
            $this->assertSame(self::PREFIX, $found[1], "'{$rest}'");
        }
        // The slugs an app may have.
        foreach (['shop', 'my-shop', 'Shop_2', 'a.b~c', '0'] as $slug) {
            $this->assertSame(1, preg_match($rule, "/api/app/{$slug}/site/" . self::TICKET . '/index.html', $found), $slug);
            $this->assertSame("/api/app/{$slug}/site/" . self::TICKET . '/', $found[1]);
        }
        // What ends a directive or a header's value, as it is and as an address would encode it.
        foreach ([';', ' ', "'", '"', ',', "\n", "\r", "\t", '%3B', '%20', '%27', '%22', '<', '>', '*', ':', '\\'] as $bad) {
            $shown = json_encode($bad);
            $this->assertSame(0, preg_match($rule, "/api/app/sh{$bad}op/site/" . self::TICKET . '/index.html'), "{$shown} in a slug");
            $this->assertSame(0, preg_match($rule, "/api/app/{$bad}/site/" . self::TICKET . '/index.html'), "{$shown} as a slug");
            $this->assertSame(0, preg_match($rule, "/api/app/shop/site/v3{$bad}20001/index.html"), "{$shown} in a ticket");
            $this->assertSame(0, preg_match($rule, "/api/app/shop/site/{$bad}/index.html"), "{$shown} as a ticket");
        }
        // A ticket is in small letters, and there is one.
        $this->assertSame(0, preg_match($rule, '/api/app/shop/site/' . strtoupper(self::TICKET) . '/index.html'));
        $this->assertSame(0, preg_match($rule, '/api/app/shop/site//index.html'));
        $this->assertSame(0, preg_match($rule, '/api/app/shop/site/' . self::TICKET), 'no file asked for, not even the site\'s own address');
        // So whatever address is read, the policy made from it has the directives it should and no more.
        $this->assertSame(
            ['sandbox', 'default-src', 'script-src', 'style-src', 'img-src', 'font-src', 'media-src', 'connect-src', 'worker-src', 'manifest-src', 'frame-src', 'object-src', 'base-uri', 'form-action', 'frame-ancestors'],
            array_keys(self::directives(self::policy(self::ORIGIN, '/api/app/a.b~c_D-9/site/' . self::TICKET . '/')))
        );
    }

    // ── Other sites an app's owner lets it reach (manifest site.outside) ───────────────────────

    public function testOutsideSitesWidenWhatTheAppLoadsAndCallsAndNothingThatHoldsIt(): void
    {
        $plain = self::directives(self::policy());
        $with = self::directives(SecurityHeadersMiddleware::siteFramePolicy(self::ORIGIN, self::PREFIX, ['https://api.example.com', 'wss://live.example.com', 'https://*.cdn.example.net:8443']));
        foreach (['script-src', 'style-src', 'img-src', 'font-src', 'media-src'] as $loads) {
            $this->assertContains('https://api.example.com', $with[$loads], $loads);
            $this->assertContains('https://*.cdn.example.net:8443', $with[$loads], $loads);
            // A wss:// address is for a connection only.
            $this->assertNotContains('wss://live.example.com', $with[$loads], $loads);
        }
        $this->assertSame([...self::own(), 'https://api.example.com', 'wss://live.example.com', 'https://*.cdn.example.net:8443'], $with['connect-src']);
        // What holds the app is as it was: the sandbox, no frames, no forms, its own base, who may frame it.
        foreach (['sandbox', 'default-src', 'worker-src', 'manifest-src', 'frame-src', 'object-src', 'base-uri', 'form-action', 'frame-ancestors'] as $same) {
            $this->assertSame($plain[$same], $with[$same], $same);
        }
        $this->assertNotContains('allow-same-origin', $with['sandbox']);
    }

    public function testOnlyASitesAddressIsTakenAsAnOutsideSite(): void
    {
        $taken = SecurityHeadersMiddleware::siteOutside([
            'https://api.example.com', 'HTTPS://Fonts.Example.com:8443', 'wss://live.example.com', 'https://*.cdn.example.net', 'https://api.example.com',
            // Not a site's address: plain http, a path, a query, a bare star, no dot, a made-up scheme, no text at all.
            'http://plain.example.com', 'https://api.example.com/v1', 'https://api.example.com?x=1', 'https://*', 'https://localhost', 'ftp://files.example.com', 'data:', '*', "'self'", 7, null, ['https://x.example.com'],
            // A number and not a name: the visitor's own machine, the network it is on, any address at all, however it is written.
            'https://127.0.0.1', 'https://192.168.1.10:8443', 'wss://10.0.0.5', 'https://203.0.113.5', 'https://*.0.0.1', 'https://2130706433', 'https://0x7f.0.0.1', 'https://127.1', 'https://example.123', 'https://[::1]',
            // Every name under an ending (*.com) is not one site. Under a name is.
            'https://*.com', 'https://*.test',
            // Longer than any address of a site.
            'https://' . str_repeat('a.', 140) . 'example.com',
            // What would end a directive or begin another.
            'https://x.example.com; script-src *', "https://x.example.com 'unsafe-hashes'", "https://x.example.com\nscript-src *", 'https://x.example.com,https://y.example.com',
        ]);
        $this->assertSame(['https://api.example.com', 'https://fonts.example.com:8443', 'wss://live.example.com', 'https://*.cdn.example.net'], $taken);
        // And the policy written from such a list is the policy written from what was taken.
        $this->assertSame(
            SecurityHeadersMiddleware::siteFramePolicy(self::ORIGIN, self::PREFIX, ['https://ok.example.com']),
            SecurityHeadersMiddleware::siteFramePolicy(self::ORIGIN, self::PREFIX, ['https://x.example.com; script-src *', 'https://ok.example.com', 'http://plain.example.com'])
        );
        // No more than the most an app may name.
        $many = array_map(static fn (int $n): string => "https://s{$n}.example.com", range(1, SecurityHeadersMiddleware::SITE_OUTSIDE_MOST + 5));
        $this->assertCount(SecurityHeadersMiddleware::SITE_OUTSIDE_MOST, SecurityHeadersMiddleware::siteOutside($many));
    }

    public function testThisSitesOwnNameIsNeverAnOutsideSite(): void
    {
        // Named there, it would open the whole of this site to the app's requests, the API included.
        foreach (['https://' . self::HOST, 'wss://' . self::HOST, 'https://' . self::HOST . ':8443', 'https://*.' . self::HOST] as $own) {
            $this->assertSame(self::policy(), SecurityHeadersMiddleware::siteFramePolicy(self::ORIGIN, self::PREFIX, [$own]), $own);
        }
        // On a port of its own, the same holds for the name with and without the port.
        foreach (['https://' . self::HOST, 'https://' . self::HOST . ':8443'] as $own) {
            $this->assertSame(self::policy(self::ORIGIN . ':8443'), SecurityHeadersMiddleware::siteFramePolicy(self::ORIGIN . ':8443', self::PREFIX, [$own]), $own);
        }
    }

    public function testAStarredNameThatWouldCoverThisSiteIsNotAnOutsideSiteEither(): void
    {
        // Found by review, 2026-11-13: only the name itself was looked for, so "*." before the
        // name above it, which a browser reads as covering this site, opened the whole of it.
        foreach (['https://*.example.test', 'wss://*.example.test', 'https://*.example.test:8443'] as $above) {
            $this->assertSame(self::policy(), SecurityHeadersMiddleware::siteFramePolicy(self::ORIGIN, self::PREFIX, [$above]), $above);
        }
        // Two names up, as *.co.uk is above example.co.uk.
        $deep = 'https://forms.apps.example.test';
        $this->assertSame(self::policy($deep), SecurityHeadersMiddleware::siteFramePolicy($deep, self::PREFIX, ['https://*.example.test', 'https://*.apps.example.test']));
        // A name beside it, or one that only ends the same, is another site and is kept.
        $beside = self::directives(SecurityHeadersMiddleware::siteFramePolicy(self::ORIGIN, self::PREFIX, ['https://api.example.test', 'https://*.cdn.example.test', 'https://notapps.example.test', 'https://xapps.example.test']));
        $this->assertSame([...self::own(), 'https://api.example.test', 'https://*.cdn.example.test', 'https://notapps.example.test', 'https://xapps.example.test'], $beside['connect-src']);
    }

    public function testEveryNameTheInstallationIsKnownByIsItsOwn(): void
    {
        // Its pages on one name, the API on another, a second address it answers on: each is this
        // site, whichever of them the request came in on.
        $_ENV['APP_URL'] = 'https://www.example.test/';
        $_ENV['CORS_ORIGIN'] = 'https://Admin.Example.Test:8443';
        $_ENV['CORS_ALLOWED_ORIGINS'] = 'https://staging.example.test , https://*.tenants.example.test';
        $this->assertSame(['www.example.test', 'admin.example.test', 'staging.example.test', '*.tenants.example.test'], SecurityHeadersMiddleware::ownNames());
        foreach ([
            'https://www.example.test', 'wss://www.example.test', 'https://admin.example.test', 'https://admin.example.test:9000', 'https://staging.example.test',
            // Every name under one the installation says is all its own, and that name.
            'https://shop.tenants.example.test', 'https://a.b.tenants.example.test', 'https://tenants.example.test', 'https://*.tenants.example.test', 'https://*.shop.tenants.example.test',
            // And "*." before a name above any of them.
            'https://*.example.test',
        ] as $own) {
            $this->assertSame(self::policy(), SecurityHeadersMiddleware::siteFramePolicy(self::ORIGIN, self::PREFIX, [$own]), $own);
            $this->assertTrue(SecurityHeadersMiddleware::siteOutsideIsOwn($own, SecurityHeadersMiddleware::ownNames()), $own);
        }
        // Another site is still another site.
        $kept = self::directives(SecurityHeadersMiddleware::siteFramePolicy(self::ORIGIN, self::PREFIX, ['https://api.example.com', 'https://cdn.example.test']));
        $this->assertSame([...self::own(), 'https://api.example.com', 'https://cdn.example.test'], $kept['connect-src']);
        // What the environment names that is no address names nothing.
        $_ENV['APP_URL'] = "https://x.example.test; script-src *";
        $_ENV['CORS_ORIGIN'] = '';
        $_ENV['CORS_ALLOWED_ORIGINS'] = ' , *, https://, not an address';
        $this->assertSame([], SecurityHeadersMiddleware::ownNames());
        unset($_ENV['APP_URL'], $_ENV['CORS_ORIGIN'], $_ENV['CORS_ALLOWED_ORIGINS']);
    }

    public function testAPolicyNamingOutsideSitesIsTheSameWrittenAgainFromItself(): void
    {
        // The middleware writes the policy again from the sites a response's own policy names
        // (siteFramePolicyFor): that must come out the same, own names left out and all.
        $_ENV['CORS_ALLOWED_ORIGINS'] = 'https://www.example.test';
        $given = ['https://api.example.com', 'https://www.example.test', 'https://*.example.test', 'wss://live.example.com', 'https://' . self::HOST, 'https://*.cdn.example.net:8443', 'https://127.0.0.1'];
        $once = SecurityHeadersMiddleware::siteFramePolicy(self::ORIGIN, self::PREFIX, $given);
        $named = array_slice(self::directives($once)['connect-src'], 2);
        $this->assertSame(['https://api.example.com', 'wss://live.example.com', 'https://*.cdn.example.net:8443'], $named);
        $this->assertSame($once, SecurityHeadersMiddleware::siteFramePolicy(self::ORIGIN, self::PREFIX, $named));
        unset($_ENV['CORS_ALLOWED_ORIGINS']);
    }

    public function testAResponseNamingOutsideSitesIsLetThroughOnlyAsThisClassWouldWriteIt(): void
    {
        $send = function (string $policy): ResponseInterface {
            $handler = new class($policy) implements RequestHandlerInterface {
                public function __construct(private string $policy) {}
                public function handle(ServerRequestInterface $request): ResponseInterface { return (new Response())->withHeader('Content-Security-Policy', $this->policy); }
            };
            return (new SecurityHeadersMiddleware())->process((new ServerRequestFactory())->createServerRequest('GET', self::ORIGIN . self::PREFIX . 'index.html'), $handler);
        };
        $good = SecurityHeadersMiddleware::siteFramePolicy(self::ORIGIN, self::PREFIX, ['https://api.example.com', 'wss://live.example.com']);
        $kept = $send($good);
        $this->assertSame($good, $kept->getHeaderLine('Content-Security-Policy'));
        $this->assertSame('', $kept->getHeaderLine('X-Frame-Options'));
        // The same policy with something slipped in among its sites is not one this class writes.
        foreach ([
            str_replace('wss://live.example.com', "wss://live.example.com 'unsafe-inline'", $good),
            str_replace('wss://live.example.com', 'wss://live.example.com *', $good),
            str_replace('wss://live.example.com', 'wss://live.example.com http://plain.example.com', $good),
            str_replace('connect-src ', 'connect-src https://first.example.com ', $good),
            str_replace("frame-src 'none'", 'frame-src https://api.example.com', $good),
            str_replace('script-src ', 'script-src https://other.example.com ', $good),
        ] as $other) {
            $refused = $send($other);
            $this->assertSame(self::API_POLICY, $refused->getHeaderLine('Content-Security-Policy'), $other);
            $this->assertSame('DENY', $refused->getHeaderLine('X-Frame-Options'));
        }
    }
}
