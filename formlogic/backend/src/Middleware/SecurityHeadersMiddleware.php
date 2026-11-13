<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

use FormLogic\Support\Environment;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;

class SecurityHeadersMiddleware implements MiddlewareInterface
{
    /** The policy an image a person may open as a page is sent under: nothing in it runs, it has no origin, it may style itself. */
    public const SANDBOXED_IMAGE = "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
    /**
     * The policy the site's own page is sent under from here (AppLookController::sitePage, the site's
     * root): the one ui/public/.htaccess gives it as a file, which check-security-invariants holds
     * equal. The page's own <meta> policy says what it may run.
     */
    public const SITE_PAGE = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'";

    /** The addresses a JavaScript app's built site is served under (SiteAppController): /api/app/<slug>/site/<ticket>/… */
    public const SITE_FRAME_PATH = '~^(/api/app/[A-Za-z0-9_.\~-]+/site/[a-z0-9-]+/)~D';

    /**
     * What a built site's page may do in its sandbox: run scripts, show its own dialogs, open a
     * link in a new tab (which is then an ordinary tab), hand the person a file, take the pointer
     * for a game. Not here, and so refused: an origin of its own (allow-same-origin) and moving
     * the window that frames it (allow-top-navigation). The frame that shows the site names the
     * same list (ui: SiteAppFrame).
     */
    public const SITE_FRAME_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock';

    /**
     * The policy every file of a JavaScript app's built site is sent under. The site is someone's
     * compiled front end, run as it is, so the policy is what holds it:
     *  - `sandbox` with no allow-same-origin: the page has no origin. It cannot read this site's
     *    cookies or storage, its requests carry no session, and it may not move the window that
     *    frames it. That holds when the address is opened directly too, not only in the frame.
     *  - every kind of load is held to the site's own files (`$own`, an address prefix): no other
     *    site, and nothing else of this one, the API included. Its backend is reached through the
     *    page that frames it.
     *  - only this site's own pages may frame it: the address it is served from, and where this
     *    installation's pages are served from when that is another address (siteFramers).
     * `$origin` is this site as the browser reached it (scheme, host, port). `$prefix` is the
     * site's address as SITE_FRAME_PATH reads it, whose characters cannot end a directive.
     *
     * The site's own files are named under both schemes (http://host/path/ https://host/path/),
     * so the policy holds whether or not this server knows it is behind HTTPS, which behind a
     * proxy it often does not. Not without a scheme, which would say the same in fewer words:
     * Safari matches no address written that way for a page with no origin, and the app could
     * then not read its own first page.
     *
     * `$outside`: other sites the app's owner has said it may reach (its manifest's
     * site.outside: an API it calls, a font service, a script it loads). Each is one address of
     * a site and nothing more (SITE_OUTSIDE), and is added to what the page may load and call.
     * They widen what the app can reach on the internet, never what it can reach here: the
     * sandbox, and so the page having no origin, is the same with them. A wss:// address is for
     * a connection only.
     *
     * @param list<string> $outside
     */
    public static function siteFramePolicy(string $origin, string $prefix, array $outside = []): string
    {
        $host = (string) preg_replace('~^[a-z][a-z0-9+.-]*://~i', '', $origin);
        $own = "http://{$host}{$prefix} https://{$host}{$prefix}";
        // This site's own name is never an outside site: named there, it would open the whole of
        // it to the app's requests, the API included, where the app is held to its own files. Its
        // own name is the one this request came in on and every other this installation is known
        // by; "*." before one of them, or before a name above one, says the same and is left out too.
        $names = [$host, ...self::ownNames()];
        $outside = array_values(array_filter(self::siteOutside($outside), static fn (string $site): bool => !self::siteOutsideIsOwn($site, $names)));
        $loads = implode('', array_map(static fn (string $site): string => str_starts_with($site, 'https://') ? ' ' . $site : '', $outside));
        $calls = implode('', array_map(static fn (string $site): string => ' ' . $site, $outside));
        return implode('; ', [
            'sandbox ' . self::SITE_FRAME_SANDBOX,
            "default-src 'none'",
            "script-src {$own}{$loads} 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
            "style-src {$own}{$loads} 'unsafe-inline'",
            "img-src {$own}{$loads} data: blob:",
            "font-src {$own}{$loads} data:",
            "media-src {$own}{$loads} data: blob:",
            "connect-src {$own}{$calls}",
            "worker-src {$own} blob:",
            "manifest-src {$own}",
            "frame-src 'none'",
            "object-src 'none'",
            // The page is given a <base> among its own files (resources/site-boot.js), and no other.
            "base-uri {$own}",
            "form-action 'none'",
            "frame-ancestors 'self'" . self::siteFramers(),
        ]);
    }

    /**
     * Where this installation's pages are served from when it is not the API's own address (the
     * page on one name, the API on another): the addresses the API already answers pages on
     * (CORS_ORIGIN, CORS_ALLOWED_ORIGINS), as a built site's frame may be on any of them. Each
     * is held to the shape of an address, so nothing read from the environment can add a
     * directive. Empty for the usual installation, where 'self' says it all.
     */
    private static function siteFramers(): string
    {
        $named = array_merge([(string) Environment::get('CORS_ORIGIN', '')], explode(',', (string) Environment::get('CORS_ALLOWED_ORIGINS', '')));
        $framers = [];
        foreach ($named as $one) {
            $one = rtrim(trim($one), '/');
            if (preg_match('~^https?://(?:\*\.)?[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$~D', $one) === 1) $framers[$one] = true;
        }
        return $framers === [] ? '' : ' ' . implode(' ', array_keys($framers));
    }

    /**
     * The names this installation is known by, beside the one a request came in on: where its
     * pages are (APP_URL) and the addresses the API answers pages on (CORS_ORIGIN,
     * CORS_ALLOWED_ORIGINS). Lower case, with no scheme, port or path; "*.name" where the
     * environment says every name under one.
     *
     * @return list<string>
     */
    public static function ownNames(): array
    {
        $named = array_merge([(string) Environment::get('APP_URL', ''), (string) Environment::get('CORS_ORIGIN', '')], explode(',', (string) Environment::get('CORS_ALLOWED_ORIGINS', '')));
        $names = [];
        foreach ($named as $one) {
            if (preg_match('~^(?:[a-z][a-z0-9+.-]*://)?((?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)\.?(?::\d{1,5})?(?:/.*)?$~Di', trim($one), $found) === 1) $names[strtolower($found[1])] = true;
        }
        return array_keys($names);
    }

    /**
     * Whether an outside site is this installation under one of its own names (`$own`: host
     * names, a port on one is not looked at, "*.name" for every name under one):
     *
     *   - the name itself, on any port, by https or wss, with or without "*." before it;
     *   - "*." before a name above it (*.example.com where this is apps.example.com, *.co.uk
     *     where this is example.co.uk), which a browser reads as covering it;
     *   - any name the installation says is its own by a "*.name" of its own.
     *
     * A name that merely shares an ending (api.example.com where this is apps.example.com) is
     * another site.
     *
     * @param list<string> $own
     */
    public static function siteOutsideIsOwn(string $site, array $own): bool
    {
        if (preg_match('~^[a-z]+://(\*\.)?([^:/]+)~', strtolower($site), $found) !== 1) return false;
        $wild = $found[1] !== '';
        $name = rtrim($found[2], '.');
        foreach ($own as $one) {
            $one = rtrim((string) preg_replace('~:\d+$~', '', strtolower(trim($one))), '.');
            if ($one === '' || $name === '') continue;
            if (str_starts_with($one, '*.')) {
                $under = substr($one, 2);
                if ($name === $under || str_ends_with($name, '.' . $under)) return true;
                if ($wild && str_ends_with($under, '.' . $name)) return true;
                continue;
            }
            if ($name === $one) return true;
            if ($wild && str_ends_with($one, '.' . $name)) return true;
        }
        return false;
    }

    /**
     * One outside site an app may be allowed to reach: https or wss, a host name (which may start
     * "*."), a port if it has one. No path, nothing else. A name and not a number: its last part
     * begins with a letter, so no IP address is one, and with them go the visitor's own machine
     * and the network it is on.
     */
    public const SITE_OUTSIDE = '~^(?:https|wss)://(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,20}[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?$~D';
    /** No address of a site is longer. */
    public const SITE_OUTSIDE_LENGTH = 300;
    /** How many an app may name. */
    public const SITE_OUTSIDE_MOST = 20;

    /**
     * A list of outside sites as the policy takes it: each held to SITE_OUTSIDE, in lower case,
     * once, in the order given, and no more than SITE_OUTSIDE_MOST. Anything else is left out, so
     * nothing given here can end a directive or begin another.
     *
     * @param array<mixed> $given
     * @return list<string>
     */
    public static function siteOutside(array $given): array
    {
        $sites = [];
        foreach ($given as $one) {
            if (!is_string($one)) continue;
            $one = strtolower(trim($one));
            if (strlen($one) <= self::SITE_OUTSIDE_LENGTH && preg_match(self::SITE_OUTSIDE, $one) === 1) $sites[$one] = true;
            if (count($sites) >= self::SITE_OUTSIDE_MOST) break;
        }
        return array_keys($sites);
    }

    /**
     * The policy a response under a built site's address must carry to be let through as it is,
     * or null for any other address. `$given` is the policy the response carries: the outside
     * sites it names (read from its connect-src, which holds every one of them) are held to
     * SITE_OUTSIDE and the policy is written again from them here, so what is let through is
     * always a policy this class wrote, whatever the response said.
     */
    private static function siteFramePolicyFor(Request $request, string $given): ?string
    {
        if (preg_match(self::SITE_FRAME_PATH, $request->getUri()->getPath(), $found) !== 1) return null;
        $outside = [];
        if (preg_match('~(?:^|; )connect-src ([^;]*)~', $given, $calls) === 1) {
            // After the site's own two addresses come the outside ones.
            $outside = array_slice(explode(' ', $calls[1]), 2);
        }
        return self::siteFramePolicy(\FormLogic\Services\McpOAuthService::publicOrigin($request), $found[1], $outside);
    }

    private bool $isProduction;

    public function __construct(bool $isProduction = false)
    {
        $this->isProduction = $isProduction;
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        $response = $handler->handle($request);

        // Prevent clickjacking
        $response = $response->withHeader('X-Frame-Options', 'DENY');

        // Prevent MIME type sniffing
        $response = $response->withHeader('X-Content-Type-Options', 'nosniff');

        // XSS Protection (legacy but still useful for older browsers)
        $response = $response->withHeader('X-XSS-Protection', '1; mode=block');

        // Prevent proxy/browser caching of API responses (may contain sensitive
        // data). Don't clobber a handler that set its own policy — e.g. the file
        // endpoint marks immutable uploaded assets cacheable; unconditionally
        // overwriting that with no-store made its caching contract dead code.
        if (!$response->hasHeader('Cache-Control')) {
            $response = $response->withHeader('Cache-Control', 'no-store');
        }

        // Referrer Policy - don't leak referrer to other origins
        $response = $response->withHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

        // Permissions Policy - disable potentially dangerous browser features.
        // geolocation/camera stay SELF-only (not denied) to match the SPA
        // .htaccess: the form runtime's Location + Camera fields need them.
        $response = $response->withHeader(
            'Permissions-Policy',
            'geolocation=(self), microphone=(), camera=(self), payment=()'
        );

        // HSTS - only in production and over HTTPS
        if ($this->isProduction) {
            // The subdomains of a customer's domain are the customer's to decide about, and one
            // API call there would hold them to HTTPS for a year in that browser.
            $site = parse_url((string) Environment::nonEmpty('APP_URL', ''), PHP_URL_HOST);
            $ownName = is_string($site) && strcasecmp($site, $request->getUri()->getHost()) === 0;
            $response = $response->withHeader(
                'Strict-Transport-Security',
                'max-age=31536000' . ($ownName ? '; includeSubDomains' : '')
            );
        }

        // Content Security Policy - restrictive by default for API
        // This is a basic CSP for an API; frontend would have different needs
        $csp = implode('; ', [
            "default-src 'none'",
            "frame-ancestors 'none'",
            "base-uri 'none'",
            "form-action 'none'",
        ]);
        // An app owner's SVG (AppLookController::image) is sent under SANDBOXED_IMAGE, exactly: this
        // policy and a sandbox, with styles. Any other policy a response carries is replaced, as ever.
        if ($response->getHeaderLine('Content-Security-Policy') === self::SANDBOXED_IMAGE) {
            $csp = self::SANDBOXED_IMAGE;
        }
        // The site's own page, exactly: under this API's policy it could run nothing at all.
        if ($response->getHeaderLine('Content-Security-Policy') === self::SITE_PAGE) {
            $csp = self::SITE_PAGE;
        }
        // A file of a JavaScript app's built site, exactly: the sandbox policy for that address and
        // no other. It is shown in a frame of this site's own pages, which the policy names, so
        // the blanket refusal to be framed comes off this one response. Anything else at such an
        // address (an error, a refusal) keeps the API's policy and stays unframeable.
        $siteFrame = self::siteFramePolicyFor($request, $response->getHeaderLine('Content-Security-Policy'));
        if ($siteFrame !== null && $response->getHeaderLine('Content-Security-Policy') === $siteFrame) {
            $csp = $siteFrame;
            $response = $response->withoutHeader('X-Frame-Options')->withHeader('Referrer-Policy', 'no-referrer');
        }
        $response = $response->withHeader('Content-Security-Policy', $csp);

        return $response;
    }
}
