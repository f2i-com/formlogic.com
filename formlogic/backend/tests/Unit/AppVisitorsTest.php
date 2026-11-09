<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\AppAiService;
use FormLogic\Services\AppVisitors;
use FormLogic\Support\SessionOriginPolicy;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * The visitor credential (AppVisitors): an HttpOnly cookie the server signs, honoured only on a
 * request FormLogic's own page marked, from an origin it accepts; and the ids apps see.
 */
final class AppVisitorsTest extends TestCase
{
    private function visitors(bool $secure = false, array $origins = ['https://formlogic.example']): AppVisitors
    {
        return new AppVisitors(null, ['secure' => $secure], new SessionOriginPolicy($origins), str_repeat("\x07", 32));
    }

    private function request(array $headers = [], array $cookies = [], string $host = 'formlogic.example'): ServerRequestInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', 'https://' . $host . '/api/app/logos/native/request')->withHeader('Host', $host);
        foreach ($headers as $name => $value) $request = $request->withHeader($name, $value);
        return $request->withCookieParams($cookies);
    }

    public function testACookieThisSiteSignedOpensAndATamperedOneDoesNot(): void
    {
        $visitors = $this->visitors();
        [$cookie, $secret] = $visitors->mint();
        $this->assertSame(48, strlen($cookie));
        $this->assertSame($secret, $visitors->open($cookie));
        $tampered = substr($cookie, 0, 10) . ($cookie[10] === 'A' ? 'B' : 'A') . substr($cookie, 11);
        $this->assertNull($visitors->open($tampered), 'one character changed');
        $this->assertNull($visitors->open(substr($cookie, 0, 47)), 'cut short');
        $this->assertNull($visitors->open('v2' . substr($cookie, 2)), 'another version');
        $this->assertNull($visitors->open(null));
        $other = new AppVisitors(null, [], null, str_repeat("\x08", 32));
        $this->assertNull($other->open($cookie), 'signed with another site\'s key');
    }

    public function testEachAppSeesItsOwnUnlinkableIdForOneBrowser(): void
    {
        $visitors = $this->visitors();
        [, $secret] = $visitors->mint();
        $logos = $visitors->idFor('app-logos', $secret);
        $this->assertMatchesRegularExpression('/^[0-9a-f]{32}$/D', $logos);
        $this->assertSame($logos, $visitors->idFor('app-logos', $secret), 'stable for the same browser and app');
        $this->assertNotSame($logos, $visitors->idFor('app-cafe', $secret), 'another app sees another id');
        [, $other] = $visitors->mint();
        $this->assertNotSame($logos, $visitors->idFor('app-logos', $other), 'another browser is another visitor');
    }

    public function testAnAddressCountsByItsIpv6SlashSixtyFourAndIsNeverKeptItself(): void
    {
        $visitors = $this->visitors();
        $this->assertSame($visitors->ipKey('2001:db8:1:2::10'), $visitors->ipKey('2001:db8:1:2:ffff::1'), 'one /64 is one subscriber');
        $this->assertNotSame($visitors->ipKey('2001:db8:1:2::10'), $visitors->ipKey('2001:db8:1:3::10'));
        $this->assertNotSame($visitors->ipKey('203.0.113.7'), $visitors->ipKey('203.0.113.8'));
        $this->assertMatchesRegularExpression('/^[0-9a-f]{16}$/D', $visitors->ipKey('203.0.113.7'));
        $this->assertStringNotContainsString('203', $visitors->ipKey('203.0.113.7'));
    }

    public function testOnlyAMarkedRequestFromAnAcceptedOriginActsAsItsVisitor(): void
    {
        $visitors = $this->visitors(true);
        $this->assertFalse($visitors->marked($this->request()), 'no marker: the page did not send it');
        $this->assertFalse($visitors->marked($this->request([AppVisitors::HEADER => '0'])));
        $this->assertTrue($visitors->marked($this->request([AppVisitors::HEADER => '1'])), 'no Origin: not a browser carrying someone\'s cookie');
        $this->assertTrue($visitors->marked($this->request([AppVisitors::HEADER => '1', 'Origin' => 'https://formlogic.example'])), 'the site\'s own origin');
        $this->assertFalse($visitors->marked($this->request([AppVisitors::HEADER => '1', 'Origin' => 'https://evil.example'])), 'a page anywhere else');
        $this->assertTrue($visitors->marked($this->request([AppVisitors::HEADER => '1', 'Origin' => 'https://logos.example', 'Sec-Fetch-Site' => 'same-origin'], [], 'logos.example')), 'an app\'s own domain, reached directly');
        $this->assertFalse($visitors->marked($this->request([AppVisitors::HEADER => '1', 'Origin' => 'https://logos.example', 'Sec-Fetch-Site' => 'cross-site'], [], 'logos.example')), 'Fetch Metadata must agree');
        $this->assertFalse($visitors->marked($this->request([AppVisitors::HEADER => '1', 'Origin' => 'http://logos.example'], [], 'logos.example')), 'plain http where cookies are Secure');
    }

    public function testResolveMintsOnceAndThenKeepsTheBrowsersId(): void
    {
        $visitors = $this->visitors();
        $this->assertNull($visitors->resolve($this->request([AppVisitors::HEADER => '1']), 'app-logos', false), 'an unmarked request has no visitor');
        $first = $visitors->resolve($this->request([AppVisitors::HEADER => '1']), 'app-logos', true);
        $this->assertNotNull($first['setCookie'], 'a new browser gets its cookie');
        preg_match('/^formlogic_visitor=([^;]+)/', $first['setCookie'], $m);
        $again = $visitors->resolve($this->request([AppVisitors::HEADER => '1'], [AppVisitors::COOKIE => $m[1]]), 'app-logos', true);
        $this->assertSame($first['id'], $again['id']);
        $this->assertNull($again['setCookie'], 'a known browser keeps its cookie');
        $forged = $visitors->resolve($this->request([AppVisitors::HEADER => '1'], [AppVisitors::COOKIE => 'v1.' . str_repeat('A', 22) . '.' . str_repeat('A', 22)]), 'app-logos', true);
        $this->assertNotSame($first['id'], $forged['id']);
        $this->assertNotNull($forged['setCookie'], 'a cookie this site did not sign is replaced, never trusted');
    }

    public function testTheCookieIsHttpOnlyLaxUnderApiAndSecureWhereTheSiteIs(): void
    {
        $cookie = $this->visitors(true)->setCookie('v1.x.y');
        $this->assertStringContainsString('formlogic_visitor=v1.x.y', $cookie);
        foreach (['HttpOnly', 'SameSite=Lax', 'Path=/api/', 'Max-Age=34560000', 'Secure'] as $part) $this->assertStringContainsString($part, $cookie);
        $this->assertStringNotContainsString('Domain=', $cookie, 'host-only: an app\'s own domain keeps its own');
        $this->assertStringNotContainsString('Secure', $this->visitors(false)->setCookie('v1.x.y'));
    }

    public function testTheRuntimeGetRenewsAKnownCookieAndMintsAMissingOne(): void
    {
        $visitors = $this->visitors();
        [$cookie] = $visitors->mint();
        $this->assertStringContainsString('formlogic_visitor=' . $cookie . ';', $visitors->cookieFor($this->request([], [AppVisitors::COOKIE => $cookie])));
        $this->assertStringNotContainsString($cookie, $visitors->cookieFor($this->request()));
    }

    public function testBindingIdsCarryTheRequesterAndAddressAndFitTheRunner(): void
    {
        $visitor = AppAiService::binding(['kind' => 'visitor', 'id' => str_repeat('a', 32)], str_repeat('b', 16));
        $member = AppAiService::binding(['kind' => 'user', 'id' => '0f8e8f2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b'], str_repeat('c', 16));
        $this->assertSame(57, strlen($visitor));
        $this->assertSame(61, strlen($member));
        foreach ([$visitor, $member] as $binding) $this->assertMatchesRegularExpression('/^[a-zA-Z0-9_-]{1,100}$/D', $binding, 'the runner\'s binding id rule');
        $this->assertSame(['kind' => 'visitor', 'id' => str_repeat('a', 32), 'ipKey' => str_repeat('b', 16)], AppAiService::parseBinding($visitor));
        $this->assertSame(['kind' => 'user', 'id' => '0f8e8f2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b', 'ipKey' => str_repeat('c', 16)], AppAiService::parseBinding($member));
        $this->assertNull(AppAiService::parseBinding('42'), 'a flow binding');
        $this->assertNull(AppAiService::parseBinding('fl-ai-v-short-' . str_repeat('b', 16)));
        // A request nobody is known for still carries one, so its jobs are taken and answered.
        $nobody = AppAiService::binding(null, str_repeat('d', 16));
        $this->assertSame('fl-ai-n-' . str_repeat('d', 16), $nobody);
        $this->assertSame(['kind' => AppAiService::NOBODY, 'id' => '', 'ipKey' => str_repeat('d', 16)], AppAiService::parseBinding($nobody));
    }

    public function testTheBindingJoinsAFlowsEntryOrAddsOneAndGivesUpAtTheRunnersLimits(): void
    {
        $flow = [['event' => 'app.record.created.ai_jobs', 'bindings' => ['17']], ['event' => 'app.record.updated.users', 'bindings' => ['18']]];
        $this->assertSame([
            ['event' => 'app.record.created.ai_jobs', 'bindings' => ['17', 'fl-ai-x']], $flow[1],
            ['event' => 'app.record.updated.ai_jobs', 'bindings' => ['fl-ai-x']], ['event' => 'app.record.deleted.ai_jobs', 'bindings' => ['fl-ai-x']],
        ], AppAiService::withBinding($flow, 'ai_jobs', 'fl-ai-x'), 'a flow\'s entry is joined: a second would capture the write twice');
        $this->assertSame(array_map(static fn(string $operation) => ['event' => "app.record.{$operation}.ai_jobs", 'bindings' => ['fl-ai-x']], ['created', 'updated', 'deleted']),
            AppAiService::withBinding([], 'ai_jobs', 'fl-ai-x'), 'a job asked for, and one cancelled by its status or by deleting its row');
        $full = array_map(static fn(int $i) => ['event' => 'app.record.created.t' . $i, 'bindings' => ['b' . $i]], range(1, 98));
        $this->assertNull(AppAiService::withBinding($full, 'ai_jobs', 'fl-ai-x'), 'a 101st entry would fail the request in the runner');
        $crowded = [['event' => 'app.record.deleted.ai_jobs', 'bindings' => array_map('strval', range(1, 100))]];
        $this->assertNull(AppAiService::withBinding($crowded, 'ai_jobs', 'fl-ai-x'));
    }
}
