<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Helpers\IpResolver;
use FormLogic\Support\SessionOriginPolicy;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * The visitors of apps that ask for them (AppFormlogicManifest::asksForVisitors): people with no
 * account, known to FormLogic by one browser, so an app can count their free AI rounds and keep their
 * prepaid balance.
 *
 * The browser holds a secret in an HttpOnly cookie the server sets (`formlogic_visitor`): script
 * cannot read it, and Safari's seven-day sweep of script-written storage leaves it. It counts only
 * on a request that also carries the `X-FormLogic-Visitor` marker, which FormLogic's own page adds
 * and which no other site can (a custom header needs CORS's preflight), from an allowed origin.
 * FormLogic's CSRF check does not cover it (CsrfMiddleware checks only requests with the sign-in
 * cookie), so this is the check.
 *
 * Each app sees its own id for a browser (`idFor`): the same browser cannot be followed from one app
 * to another. The cookie is checked by its signature alone, with no database row per browser; the
 * key that signs it is the site's, kept in system_meta and backed up with the database. It is not
 * derived from JWT_SECRET, which an operator rotates after an incident: that must never orphan
 * everyone's balance.
 */
final class AppVisitors
{
    public const COOKIE = 'formlogic_visitor';
    public const HEADER = 'X-FormLogic-Visitor';
    private const META_KEY = 'app_visitor_key';
    private const VERSION = 'v1';
    /** 400 days, the longest a browser keeps a cookie (Chrome's cap); renewed as it is used. */
    public const MAX_AGE = 34560000;
    private const ID_LABEL = 'fl-visitor-v1|';
    private const IP_LABEL = 'fl-visitor-ip-v1|';

    private ?string $key;

    /**
     * @param array{secure?: bool} $cookie the site's cookie settings (settings.php `cookie`)
     * @param ?string $key a fixed key (tests); null reads the site's from system_meta, making it once
     */
    public function __construct(private ?MySQLConnection $mysql, private array $cookie = [], private ?SessionOriginPolicy $origins = null, ?string $key = null)
    {
        $this->key = $key;
    }

    /** The site's visitor key: 32 bytes, made the first time it is needed and kept from then on. */
    public function key(): string
    {
        if ($this->key !== null) return $this->key;
        if ($this->mysql === null) throw new \RuntimeException('Visitors are not available on this server');
        $pdo = $this->mysql->getConnection();
        // Two first uses at once converge on one key: the second insert is ignored and both read it back.
        $pdo->prepare('INSERT IGNORE INTO system_meta (meta_key, meta_value) VALUES (?, ?)')->execute([self::META_KEY, bin2hex(random_bytes(32))]);
        $statement = $pdo->prepare('SELECT meta_value FROM system_meta WHERE meta_key = ?');
        $statement->execute([self::META_KEY]);
        $hex = (string) $statement->fetchColumn();
        if (!preg_match('/^[0-9a-f]{64}$/D', $hex)) throw new \RuntimeException('The site\'s visitor key is unreadable');
        return $this->key = hex2bin($hex);
    }

    /** A new browser: [the cookie's value, its secret]. */
    public function mint(): array
    {
        $secret = random_bytes(16);
        return [self::VERSION . '.' . self::b64($secret) . '.' . self::b64($this->tag($secret)), $secret];
    }

    /** The browser's secret from a cookie value, or null when it is not a cookie this site signed. */
    public function open(?string $cookie): ?string
    {
        if (!is_string($cookie) || strlen($cookie) !== 48 || !str_starts_with($cookie, self::VERSION . '.')) return null;
        $parts = explode('.', $cookie);
        if (count($parts) !== 3) return null;
        $secret = self::unb64($parts[1]);
        $tag = self::unb64($parts[2]);
        if ($secret === null || $tag === null || strlen($secret) !== 16 || strlen($tag) !== 16) return null;
        return hash_equals($this->tag($secret), $tag) ? $secret : null;
    }

    /** The id app $appId sees for this browser: 32 hex characters, unlinkable to its id in any other app. */
    public function idFor(string $appId, string $secret): string
    {
        return substr(hash_hmac('sha256', self::ID_LABEL . $appId . '|' . $secret, $this->key()), 0, 32);
    }

    /**
     * What a limit counts an address as (an IPv4 address; an IPv6 address by its /64, as
     * IpResolver::rateLimitSubject does), keyed so the address itself is never stored: 16 hex.
     */
    public function ipKey(string $ip): string
    {
        return substr(hash_hmac('sha256', self::IP_LABEL . IpResolver::rateLimitSubject($ip), $this->key()), 0, 16);
    }

    /**
     * Whether a request may act as its browser's visitor: FormLogic's own page marked it, from an
     * origin it accepts. A request without an Origin (not a browser's, so carrying no visitor's
     * cookie it did not set itself) passes; one from a page anywhere else does not.
     */
    public function marked(Request $request): bool
    {
        if (trim($request->getHeaderLine(self::HEADER)) !== '1') return false;
        if ($request->getHeader('Origin') === []) return true;
        if ($this->origins !== null && $this->origins->allows($request)) return true;
        return SessionOriginPolicy::sameHostOrigin($request, (bool) ($this->cookie['secure'] ?? false)) !== null;
    }

    /**
     * The visitor of $appId for this request: ['id' => …, 'setCookie' => ?string] (a Set-Cookie
     * value when a new browser was made), or null when the request may not act as one ($marked
     * false: no marker, or from elsewhere).
     */
    public function resolve(Request $request, string $appId, bool $marked): ?array
    {
        if (!$marked) return null;
        $value = $request->getCookieParams()[self::COOKIE] ?? null;
        $secret = $this->open(is_string($value) ? $value : null);
        $setCookie = null;
        if ($secret === null) {
            [$value, $secret] = $this->mint();
            $setCookie = $this->setCookie($value);
        }
        return ['id' => $this->idFor($appId, $secret), 'setCookie' => $setCookie];
    }

    /**
     * The Set-Cookie value for a page about to use an app that asks for visitors (the runtime GET,
     * once a page load): the browser's own cookie again, so its 400 days start over and a visitor
     * who keeps coming back keeps their id, or a new browser's.
     */
    public function cookieFor(Request $request): string
    {
        $value = $request->getCookieParams()[self::COOKIE] ?? null;
        if (is_string($value) && $this->open($value) !== null) return $this->setCookie($value);
        return $this->setCookie($this->mint()[0]);
    }

    /** The Set-Cookie header value: HttpOnly, SameSite=Lax, under /api/, host-only. */
    public function setCookie(string $value): string
    {
        $parts = [self::COOKIE . '=' . $value, 'Path=/api/', 'Max-Age=' . self::MAX_AGE, 'HttpOnly', 'SameSite=Lax'];
        if (($this->cookie['secure'] ?? false) === true) $parts[] = 'Secure';
        return implode('; ', $parts);
    }

    private function tag(string $secret): string
    {
        return substr(hash_hmac('sha256', self::VERSION . '.' . $secret, $this->key(), true), 0, 16);
    }

    private static function b64(string $bytes): string
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }

    private static function unb64(string $text): ?string
    {
        if (!preg_match('/^[A-Za-z0-9_-]{22}$/D', $text)) return null;
        $bytes = base64_decode(strtr($text, '-_', '+/') . '==', true);
        return $bytes === false ? null : $bytes;
    }
}
