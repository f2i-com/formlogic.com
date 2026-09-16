<?php
/**
 * Single-origin router for the E2E CI job (and local full-stack smoke) — serves the built SPA and the
 * API from ONE origin so cookies are same-origin (no cross-site Secure-cookie-over-HTTP problem):
 *
 *   php -S 127.0.0.1:8080 -t formlogic/ui/dist formlogic/ci/router.php
 *
 * `/api/*` is handed to the real Slim front controller; existing static files are served by the built-in
 * server; everything else falls back to the SPA's index.html (client-side routing). The SPA must be built
 * with VITE_API_URL=/api so it calls this same origin.
 *
 * The hosted app runtime and the embedded editors are the exception to "let the built-in server serve
 * static files": production gets their headers from ui/public/.htaccess (docs/HOSTED_APPS.md, "static-asset
 * CORS requirements"), which PHP's built-in server never reads. The runtime runs in a sandboxed iframe with
 * an opaque origin, so its module scripts and wasm are cross-origin fetches that need
 * `Access-Control-Allow-Origin: *`, and the entry documents need the framing headers; without them the
 * frame stays blank and no golden path can render a hosted app.
 */

$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$dist = __DIR__ . '/../ui/dist';

// API → the real backend entry point (its own __DIR__ keeps autoload/.env resolution correct).
if ($uri === '/api' || str_starts_with($uri, '/api/')) {
    require __DIR__ . '/../backend/public/index.php';
    return true;
}

// OAuth discovery documents for the MCP connector flow — the backend serves these at the domain ROOT
// (mirrors the ui/public/.htaccess well-known rules): the RFC 9728 protected-resource subtree and the
// RFC 8414 authorization-server metadata. /oauth/authorize is an SPA route (fallback below).
if (preg_match('#^/\.well-known/(oauth-protected-resource(/.*)?|oauth-authorization-server)$#', $uri)) {
    require __DIR__ . '/../backend/public/index.php';
    return true;
}

// The hosted runtime and the embedded editors, with the headers the .htaccess gives them in production.
if (preg_match('#^/(hosted-runtime|app-editors)/#', $uri)) {
    $root = realpath($dist);
    $file = $root !== false ? realpath($root . $uri) : false;
    if ($file !== false && str_starts_with($file, $root . DIRECTORY_SEPARATOR) && is_file($file)) {
        $types = [
            'js' => 'application/javascript', 'mjs' => 'application/javascript', 'wasm' => 'application/wasm',
            'json' => 'application/json', 'css' => 'text/css', 'html' => 'text/html; charset=UTF-8',
            'svg' => 'image/svg+xml', 'png' => 'image/png', 'woff2' => 'font/woff2', 'woff' => 'font/woff',
            'ico' => 'image/x-icon', 'map' => 'application/json', 'txt' => 'text/plain; charset=UTF-8',
            'onnx' => 'application/octet-stream', 'bin' => 'application/octet-stream',
        ];
        $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
        header('Content-Type: ' . ($types[$ext] ?? 'application/octet-stream'));
        header('X-Content-Type-Options: nosniff');
        header('Access-Control-Allow-Origin: *');
        // Mirrors ui/public/.htaccess IS_APP_FRAME, host.html included: the hosted runtime's
        // second entry document serves host-js under a policy carrying 'unsafe-eval', so it is
        // framed under exactly the same rule as index.html and never a looser one.
        if (preg_match('#^/(hosted-runtime/(index\.html|host\.html)?|app-editors/(builder|studio)/(index\.html)?)$#', $uri)) {
            header('X-Frame-Options: SAMEORIGIN');
            header("Content-Security-Policy: frame-ancestors 'self'; base-uri 'self'; object-src 'none'");
        }
        header('Content-Length: ' . filesize($file));
        readfile($file);
        return true;
    }
}

// Let the built-in server serve a real static asset from the doc root (dist).
if ($uri !== '/' && is_file($dist . $uri)) {
    return false;
}

// SPA fallback (client-side routes).
header('Content-Type: text/html; charset=UTF-8');
readfile($dist . '/index.html');
return true;
