<?php

declare(strict_types=1);

namespace FormLogic\Helpers;

/**
 * The request headers an app's backend is given, whichever way the request reached this site:
 * from the app's own page (NativeAppController) or through the app's API
 * (ExternalAppApiController). One rule for both, so a handler reads the same headers on either.
 */
final class AppRequestHeaders
{
    /**
     * What a browser or client says to this site and to nobody else: its session, the token that
     * goes with it, its API key, and the tokens of the site's own pages. When an app's API is
     * called over HTTP the headers are this site's own request's, so these are taken out before
     * any other rule is applied. (`x-formlogic*` names go by their prefix, in fromApp().)
     */
    public const SITE_OWN = ['authorization', 'cookie', 'x-csrf-token', 'x-admin-confirmation', 'x-demo-sandbox-token', 'mcp-session-id'];

    /**
     * The headers an app's own request carries to its backend, by name in lower case. Left out are
     * the names the host answers for and a caller must not say for it: the host and the address
     * asked for, the method (an override, which would get round the methods an app's API allows),
     * where the caller is (`forwarded`, `x-forwarded-*`, `x-real-ip`: the host says that, as the
     * request's client_ip), the connection's own, and anything of FormLogic's. Held to 64 headers
     * of 8 KB each; a longer one is left out, never cut. A container backend keeps its page's
     * cookie header, as its sessions are its own to keep; a SoftN handler ($cookies false) is
     * given none, as on SoftN's hosts.
     *
     * @param array<array-key, mixed> $sent
     * @return array<string, string>
     */
    public static function fromApp(array $sent, bool $cookies = true): array
    {
        $refused = [
            'host', 'origin', 'referer', 'forwarded', 'connection', 'keep-alive', 'transfer-encoding',
            'te', 'trailer', 'upgrade', 'content-length', 'x-real-ip', 'x-http-method-override', 'x-method-override',
            'x-original-url', 'x-rewrite-url', 'proxy-authorization', 'proxy-authenticate',
        ];
        if (!$cookies) $refused[] = 'cookie';
        $headers = [];
        foreach ($sent as $k => $v) {
            if (!is_string($k) || !is_scalar($v)) continue;
            $lk = strtolower(trim($k));
            // Enforce strict token-with-hyphens (blocks underscore CGI spoofing like x_formlogic_user_id).
            if ($lk === '' || strlen($lk) > 128 || preg_match('/^[a-z0-9-]+$/', $lk) !== 1) continue;
            if (
                str_starts_with($lk, 'x-formlogic')
                || str_starts_with($lk, 'x-forwarded-')
                || str_starts_with($lk, 'proxy-')
                || str_starts_with($lk, 'sec-')
                || in_array($lk, $refused, true)
            ) continue;
            $sv = preg_replace('/[\r\n\0]+/', '', (string) $v) ?? '';
            if (strlen($sv) > 8192) continue;
            $headers[$lk] = $sv;
            if (count($headers) >= 64) break;
        }
        return $headers;
    }
}
