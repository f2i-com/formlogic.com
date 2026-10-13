<?php
declare(strict_types=1);

namespace FormLogic\Tests\Support;

use FormLogic\Models\User;
use FormLogic\Support\HostedActorContext;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Factory\ServerRequestFactory;

/** Controller-level authority fixture; does not issue or validate credentials. */
final class HostedControllerRequest
{
    // A fictional validated-session tag, never a JWT, secret or login capability.
    public const SESSION = 'c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0';

    public static function create(string $method, string $path, string $userId, array $app, ?array $membership = null, ?array $body = null, array $headers = [], ?string $email = null): ServerRequestInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, $path, ['REMOTE_ADDR' => '203.0.113.11'])
            ->withAttribute('userId', $userId)
            ->withAttribute('user', new User(id: $userId, email: $email ?? $userId . '@test.invalid'))
            ->withAttribute(HostedActorContext::SESSION_ATTRIBUTE, self::SESSION);
        // Only named-action POSTs echo admission. Runtime GET and owner management
        // are different routes. Resolve owner/member from supplied current fixture
        // rows, never from action input or an assumed owner flag.
        if (strtoupper($method) === 'POST' && preg_match('~^/api/app/[^/]+/actions/[^/]+$~D', rawurldecode($request->getUri()->getPath())) === 1) {
            $actor = HostedActorContext::fromRequest($request, $app, $membership);
            if ($actor !== null) $request = $request->withHeader(HostedActorContext::HEADER, json_encode($actor, JSON_THROW_ON_ERROR));
        }
        // Explicit negative fixtures can override/remove the comparison afterward.
        foreach ($headers as $name => $value) $request = $request->withHeader($name, $value);
        return $body === null ? $request : $request->withParsedBody($body);
    }
}
