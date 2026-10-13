<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Models\User;
use FormLogic\Support\HostedActorContext;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;

final class HostedActorContextTest extends TestCase
{
    private static function actor(): array
    {
        return ['version' => 1, 'appId' => 'app-a', 'userId' => 'member-a', 'roleId' => 'role-a', 'isOwner' => false, 'sessionId' => str_repeat('a', 64)];
    }

    public function testReorderedKeysAreNormalizedWithoutChoosingAuthority(): void
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/')->withHeader(HostedActorContext::HEADER, json_encode(array_reverse(self::actor(), true)));
        self::assertSame(self::actor(), HostedActorContext::initiatingActor($request));
        self::assertNull(HostedActorContext::fromRequest($request, ['id' => 'app-a', 'ownerId' => 'member-a'], null), 'a header cannot create host authority');
    }

    public static function invalidHeaders(): iterable
    {
        $actor = self::actor();
        yield 'missing' => [null];
        yield 'empty' => [''];
        yield 'truncated' => ['{'];
        yield 'null' => ['null'];
        yield 'list' => ['[]'];
        yield 'empty object' => ['{}'];
        yield 'duplicate HTTP fields' => [[json_encode($actor), json_encode($actor)]];
        yield 'duplicate JSON key' => [str_replace('"version":1', '"version":1,"version":1', json_encode($actor))];
        yield 'escaped JSON key' => [str_replace('"version"', '"\\u0076ersion"', json_encode($actor))];
        yield 'nested identity' => [json_encode(['actor' => $actor])];
        yield 'extra authority field' => [json_encode($actor + ['admin' => true])];
        foreach (['version' => '1', 'appId' => '../other', 'userId' => '', 'roleId' => null, 'isOwner' => 1, 'sessionId' => str_repeat('g', 64)] as $key => $value) {
            yield 'invalid ' . $key => [json_encode(array_replace($actor, [$key => $value]))];
        }
        yield 'wrong version' => [json_encode(array_replace($actor, ['version' => 2]))];
        yield 'owner with member role' => [json_encode(array_replace($actor, ['isOwner' => true]))];
        yield 'uppercase fingerprint' => [json_encode(array_replace($actor, ['sessionId' => str_repeat('A', 64)]))];
        yield 'oversized' => [str_replace('"version":1', '"version":' . str_repeat(' ', HostedActorContext::MAX_HEADER_BYTES) . '1', json_encode($actor))];
    }

    #[DataProvider('invalidHeaders')]
    public function testMalformedInitiatorsFailClosed(string|array|null $header): void
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/');
        if ($header !== null) $request = $request->withHeader(HostedActorContext::HEADER, $header);
        self::assertNull(HostedActorContext::initiatingActor($request));
    }

    public function testHostContextUsesCurrentMembershipAndRequiresAllTrustedAttributes(): void
    {
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/')
            ->withAttribute('userId', 'member-a')->withAttribute('user', new User('member-a', 'synthetic@example.invalid'))
            ->withAttribute(HostedActorContext::SESSION_ATTRIBUTE, str_repeat('a', 64));
        $app = ['id' => 'app-a', 'ownerId' => 'owner'];
        $membership = ['appId' => 'app-a', 'userId' => 'member-a', 'roleId' => 'role-a', 'status' => 'active'];
        self::assertSame(self::actor(), HostedActorContext::fromRequest($request, $app, $membership));
        foreach (['userId', 'user', HostedActorContext::SESSION_ATTRIBUTE] as $attribute) {
            self::assertNull(HostedActorContext::fromRequest($request->withoutAttribute($attribute), $app, $membership));
        }
        foreach (['appId' => 'app-b', 'userId' => 'member-b', 'roleId' => '', 'status' => 'suspended'] as $key => $value) {
            self::assertNull(HostedActorContext::fromRequest($request, $app, array_replace($membership, [$key => $value])));
        }
        self::assertNull(HostedActorContext::fromRequest($request->withAttribute('user', new User('member-b', 'synthetic@example.invalid')), $app, $membership));
        self::assertSame(array_replace(self::actor(), ['roleId' => null, 'isOwner' => true]), HostedActorContext::fromRequest($request, array_replace($app, ['ownerId' => 'member-a']), null));
    }
}
