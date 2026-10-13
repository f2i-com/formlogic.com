<?php
declare(strict_types=1);

// Captured requests only. No routing, AuthController, credentials, database, or network.
require dirname(__DIR__, 2) . '/formlogic/backend/tests/Support/SourceOnlyBootstrap.php';

use FormLogic\Middleware\CsrfMiddleware;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

$captures = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
$results = [];
foreach ($captures as $capture) {
    $cases = [
        ['configured frontend', fn($r) => $r, [$capture['expectedOrigin']], 204, 1],
        ['missing Origin', fn($r) => $r->withoutHeader('Origin'), [$capture['expectedOrigin']], 403, 0],
        ['untrusted Origin', fn($r) => $r->withHeader('Origin', 'https://untrusted.invalid'), [$capture['expectedOrigin']], 403, 0],
        ['duplicate Origin', fn($r) => $r->withAddedHeader('Origin', $capture['expectedOrigin']), [$capture['expectedOrigin']], 403, 0],
        ['simple content type', fn($r) => $r->withHeader('Content-Type', 'text/plain'), [$capture['expectedOrigin']], 403, 0],
        ['missing configuration', fn($r) => $r, [], 403, 0],
        ['Host/metadata cannot replace Origin', fn($r) => $r->withoutHeader('Origin')->withHeader('Host', parse_url($capture['expectedOrigin'], PHP_URL_HOST))->withHeader('Referer', $capture['expectedOrigin'])->withHeader('Sec-Fetch-Site', 'same-origin'), [$capture['expectedOrigin']], 403, 0],
    ];
    foreach ($cases as [$label, $alter, $origins, $status, $calls]) {
        // Rebuild each request: the prepared Slim dependency aliases added-header arrays on clone.
        $request = (new ServerRequestFactory())->createServerRequest('POST', $capture['url']);
        foreach ($capture['headers'] as $name => $value) $request = $request->withHeader($name, $value);
        $request->getBody()->write($capture['body']);
        json_decode($capture['body'], true, 512, JSON_THROW_ON_ERROR);
        $input = $alter($request);
        $handler = new class implements RequestHandlerInterface {
            public int $calls = 0;
            public function handle(ServerRequestInterface $request): ResponseInterface { $this->calls++; return new Response(204); }
        };
        $guard = new CsrfMiddleware('formlogic_csrf', 'X-CSRF-Token', 'formlogic_auth', 'inert-capture-signing-context', $origins);
        $response = $guard->process($input, $handler);
        $actual = $response->getStatusCode();
        $ok = [$actual, $handler->calls] === [$status, $calls];
        $results[] = ['source' => $capture['source'], 'case' => $label, 'status' => $actual, 'handlerCalls' => $handler->calls, 'pass' => $ok, 'diagnostic' => $ok ? null : ['body' => (string)$response->getBody(), 'headers' => $input->getHeaders(), 'origins' => $origins]];
    }
}
$failed = count(array_filter($results, fn(array $r): bool => !$r['pass']));
echo json_encode(['checks' => count($results), 'failed' => $failed, 'results' => $results], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
exit($failed === 0 ? 0 : 1);
