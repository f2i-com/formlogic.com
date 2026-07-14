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

// Let the built-in server serve a real static asset from the doc root (dist).
if ($uri !== '/' && is_file($dist . $uri)) {
    return false;
}

// SPA fallback (client-side routes).
header('Content-Type: text/html; charset=UTF-8');
readfile($dist . '/index.html');
return true;
