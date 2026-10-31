<?php

declare(strict_types=1);

namespace FormLogic\Support;

use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * The session an app's connected domain holds, limited to that app.
 *
 * Whoever owns a domain controls where its name points. A platform session stored on it could
 * be collected by repointing the name, then replayed against the platform as a Bearer token:
 * that is every member's whole account, for any app owner who wanted it. So a domain never
 * receives one, and nobody signs in there at all (AppDomainSignInService). Its token carries its
 * own audience, which validateToken() refuses, so every platform route stays closed without
 * having to name it here; AuthMiddleware admits it through this class alone, for that app's
 * runtime routes on that host, while the domain stays connected to it and the member stays in.
 */
final class AppDomainSession
{
    public const AUDIENCE = 'formlogic-app-domain';

    /** Set by CsrfMiddleware on a code exchange it admitted for a connected domain: {appId, host}. */
    public const SIGN_IN_ATTRIBUTE = 'appDomainSignIn';

    /** Set by AuthMiddleware on a request it admitted with such a session: {user, appId, host, signInId}. */
    public const ATTRIBUTE = 'appDomainSession';

    /**
     * What drives the app owner's own computer. On the owner's own session these stay shut, as
     * queued runs do (FlowController): a name can expire or be taken, and whoever holds it then
     * collects the session of the owner's next visit. A member's grants reach no more than the
     * app's own connectors, so a member keeps them.
     */
    private const OWNER_DESKTOP = '~^/api/app/[^/]+/(connector-commands|connector-capability|service-capability|service-invoke/desktop\.)~';

    /** The code on a refusal. A 403, because a 401 would sign the visitor out of the app. */
    public const OUT_OF_SCOPE = 'app_domain_session_scope';

    /**
     * @param \Closure(string): ?array{id: string, ownerId?: string, slug: string} $connectedApp the live app of a host
     * @param \Closure(string): bool $openSignIn whether the member is still signed in
     * @param (\Closure(string, string): bool)|null $appHasForm whether an app holds a form
     */
    public function __construct(private \Closure $connectedApp, private \Closure $openSignIn, private ?\Closure $appHasForm = null)
    {
    }

    /** @param array{user: \FormLogic\Models\User, appId: string, host: string, signInId: string} $session */
    public function admits(Request $request, array $session): bool
    {
        if (self::hostOf($request) !== $session['host']) {
            return false;
        }
        // Read for every request: removing the domain or unpublishing the app ends these sessions.
        $app = ($this->connectedApp)($session['host']);
        if ($app === null || $app['id'] !== $session['appId'] || !($this->openSignIn)($session['signInId'])) {
            return false;
        }
        // Percent-decoded, as the router matches it (see CsrfMiddleware::process).
        $path = rawurldecode($request->getUri()->getPath());
        // By method too: PUT and DELETE on /api/auth/me change the account and erase it, and a
        // credential change there mints a platform cookie.
        if ($path === '/api/auth/me') {
            return $request->getMethod() === 'GET';
        }
        if ($path === '/api/auth/logout') {
            return $request->getMethod() === 'POST';
        }
        // A file of one of this app's forms, which has one address on every host. FileController
        // applies the member's permissions on the form, as it does anywhere.
        if ($request->getMethod() === 'GET' && $this->appHasForm !== null && preg_match('~^/api/files/([^/]+)/~D', $path, $file) === 1) {
            return ($this->appHasForm)($app['id'], $file[1]);
        }
        if (($app['ownerId'] ?? null) === $session['user']->id && preg_match(self::OWNER_DESKTOP, $path) === 1) {
            return false;
        }
        return preg_match('~^/api/app/([^/]+)(?:/|$)~D', $path, $match) === 1
            && strcasecmp($match[1], $app['slug']) === 0;
    }

    private static function hostOf(Request $request): string
    {
        return rtrim(strtolower((string) preg_replace('/:\d+$/D', '', trim($request->getHeaderLine('Host')))), '.');
    }
}
