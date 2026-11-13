<?php

declare(strict_types=1);
namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\{AppService, AuthService, NativeAppService, NativeAppVersions, RuntimeEngineService};
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * An app's history of versions, for its owner (NativeAppVersions): the list, one version and what
 * differs between it and the app as it is, one of its source files, going back to it, pinning
 * it, and taking it out of the history. For SoftN and JavaScript apps alike.
 *
 * Admitted as NativeAppController::manage admits the app's project: the signed-in person owns
 * the app, or the answer is the same 404 as for an app that does not exist. The shared demo reads
 * and changes nothing.
 */
class NativeAppVersionsController
{
    use JsonResponseTrait;

    private const DEMO_READ_ONLY = 'The shared demo is read-only: you can look at this app’s versions, but not go back to one, pin one or remove one.';
    /** NativeAppService's recovery-required refusals, as NativeAppController names them to an owner. */
    private const RECOVERY_REQUIRED = '/^(?:The app (?:database )?needs operator recovery|Restore the app database before installing another update)/';
    private const BUSY_RETRY_SECONDS = 2;

    // Every dependency is required: this controller is autowired, and PHP-DI's reflection
    // autowiring skips optional parameters (see NativeAppController).
    public function __construct(private AppService $apps, private NativeAppVersions $versions, private RuntimeEngineService $engines, private AuthService $auth) {}

    /** GET /api/apps/{id}/native/versions */
    public function index(Request $request, Response $response, array $args): Response
    {
        return $this->owned($request, $response, $args, function (array $app, string $user): array {
            $list = $this->versions->list((string) $app['id']);
            $list['versions'] = $this->named($list['versions'], $user);
            return $list;
        });
    }

    /** GET /api/apps/{id}/native/versions/{n} */
    public function show(Request $request, Response $response, array $args): Response
    {
        return $this->owned($request, $response, $args, function (array $app, string $user) use ($args): array {
            $found = $this->versions->get((string) $app['id'], self::number($args));
            $found['version'] = $this->named([$found['version']], $user)[0];
            return $found;
        });
    }

    /** GET /api/apps/{id}/native/versions/{n}/file?path=… */
    public function file(Request $request, Response $response, array $args): Response
    {
        return $this->owned($request, $response, $args, fn (array $app): array => $this->versions->file((string) $app['id'], self::number($args), $request->getQueryParams()['path'] ?? null));
    }

    /** POST /api/apps/{id}/native/versions/{n}/restore {expectedVersion} */
    public function restore(Request $request, Response $response, array $args): Response
    {
        return $this->owned($request, $response, $args, function (array $app, string $user) use ($request, $args): array {
            $body = $request->getParsedBody();
            if (!is_array($body) || !is_int($body['expectedVersion'] ?? null) || $body['expectedVersion'] < 1) throw new \InvalidArgumentException('Provide expectedVersion, the app’s current version.');
            // Held to the engine's rules as a publish from the page is: a version that uses torch where it is off is refused, and says why.
            $check = function (array $project) use ($app): void {
                $torch = $this->engines->torchRefusal($app, NativeAppService::clientFiles($project));
                if ($torch !== null) throw new \InvalidArgumentException($torch);
            };
            return $this->versions->restore((string) $app['id'], self::number($args), $body['expectedVersion'], $user, $check);
        });
    }

    /** PUT /api/apps/{id}/native/versions/{n} {pinned} */
    public function pin(Request $request, Response $response, array $args): Response
    {
        return $this->owned($request, $response, $args, function (array $app) use ($request, $args): array {
            $body = $request->getParsedBody();
            if (!is_array($body) || !is_bool($body['pinned'] ?? null)) throw new \InvalidArgumentException('Provide pinned: true or false.');
            return $this->versions->pin((string) $app['id'], self::number($args), $body['pinned']);
        });
    }

    /**
     * DELETE /api/apps/{id}/native/versions/{n}
     *
     * Takes one earlier version out of the history, for good: a key or a picture that was removed
     * from the app need not stay readable until thirty more publishes. Never the current version,
     * and a pinned one only once it is unpinned (409, saying so). The app itself is not touched.
     */
    public function remove(Request $request, Response $response, array $args): Response
    {
        return $this->owned($request, $response, $args, fn (array $app): array => $this->versions->remove((string) $app['id'], self::number($args)));
    }

    private static function number(array $args): int
    {
        $n = (string) ($args['n'] ?? '');
        if (preg_match('/^[1-9][0-9]{0,8}$/D', $n) !== 1) throw new \RuntimeException('There is no such version.', 404);
        return (int) $n;
    }

    /**
     * Who made each version, for the page: whether it was the person asking, and otherwise the
     * maker's name where the site knows one. An id alone names no one to a reader.
     *
     * @param list<array<string, mixed>> $rows
     * @return list<array<string, mixed>>
     */
    private function named(array $rows, string $user): array
    {
        $names = [];
        foreach ($rows as $i => $row) {
            $by = $row['by'] ?? null;
            $rows[$i]['byYou'] = $by === $user;
            $rows[$i]['byName'] = null;
            if (!is_string($by) || $by === $user) continue;
            if (!array_key_exists($by, $names)) {
                try { $names[$by] = $this->auth->getUserById($by)?->name; } catch (\Throwable) { $names[$by] = null; }
            }
            $rows[$i]['byName'] = is_string($names[$by]) && trim($names[$by]) !== '' ? trim($names[$by]) : null;
        }
        return $rows;
    }

    /**
     * Admit the app's owner and answer with what $operation returns, as NativeAppController's
     * manage() and respond() do for the project itself.
     *
     * @param callable(array<string, mixed>, string): array<string, mixed> $operation
     */
    private function owned(Request $request, Response $response, array $args, callable $operation): Response
    {
        $app = $this->apps->getApp((string) ($args['id'] ?? ''));
        $user = $request->getAttribute('userId');
        if (!$app || !$user || $app['ownerId'] !== $user) return $this->jsonError($response, 'App not found or access denied', 404);
        // DemoReadOnlyMiddleware refuses these first; this is the second guard, should that ever change.
        if ($request->getMethod() !== 'GET' && ($blocked = $this->blockIfDemo($request, $response, self::DEMO_READ_ONLY))) return $blocked;
        $response = $response->withHeader('Cache-Control', 'no-store')->withHeader('X-Content-Type-Options', 'nosniff');
        try {
            return $this->jsonResponse($response, $operation($app, (string) $user));
        } catch (\InvalidArgumentException|\JsonException $e) {
            return $this->jsonError($response, $e->getMessage(), 400);
        } catch (\RuntimeException $e) {
            // Going back starts the app's backend, and every worker may be busy: told how long to wait, as a publish is.
            if ($e->getCode() === 429) {
                return $this->jsonResponse($response->withHeader('Retry-After', (string) self::BUSY_RETRY_SECONDS), ['error' => true, 'message' => $e->getMessage(), 'retryAfter' => self::BUSY_RETRY_SECONDS], 429);
            }
            if (in_array($e->getCode(), [402, 403, 404, 409, 413, 422, 501], true)) return $this->jsonError($response, $e->getMessage(), $e->getCode());
            error_log('Native app versions error: ' . $e->getMessage());
            if ($e->getCode() === 0 && preg_match(self::RECOVERY_REQUIRED, $e->getMessage())) return $this->jsonError($response, $e->getMessage(), 503, 'recovery_required');
            return $this->jsonError($response, 'The native app host is unavailable. Check its runtime configuration.', 503);
        }
    }
}
