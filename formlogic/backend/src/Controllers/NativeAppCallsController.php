<?php

declare(strict_types=1);
namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\{AppService, NativeAppCalls};
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * What an app's backend was asked lately (NativeAppCalls), for its owner: the recent calls of the
 * API section of the app's page, for SoftN and JavaScript apps alike.
 *
 * Admitted as the app's history is (NativeAppVersionsController): the signed-in person owns the
 * app, or the answer is the same 404 as for an app that does not exist. It only reads, so the
 * shared demo reads its own apps' (they have none: their backends do not run for the demo). Not
 * mirrored for an administrator acting as the owner (AdminActingAsRoutes), as nothing else of an
 * app's backend is.
 */
class NativeAppCallsController
{
    use JsonResponseTrait;

    /** How many calls the page asks for when it names no number. */
    public const DEFAULT_LIMIT = 50;
    private const NOT_READ = 'The app’s calls could not be read just now. Try again shortly; if it keeps happening, the server’s log says why.';

    // Both required: this controller is autowired, and PHP-DI skips optional parameters (see NativeAppController).
    public function __construct(private AppService $apps, private NativeAppCalls $calls) {}

    /** GET /api/apps/{id}/native/calls[?limit=1…500] */
    public function index(Request $request, Response $response, array $args): Response
    {
        $app = $this->apps->getApp((string) ($args['id'] ?? ''));
        $user = $request->getAttribute('userId');
        if (!$app || !$user || $app['ownerId'] !== $user) return $this->jsonError($response, 'App not found or access denied', 404);
        $response = $response->withHeader('Cache-Control', 'no-store')->withHeader('X-Content-Type-Options', 'nosniff');
        $asked = $request->getQueryParams()['limit'] ?? null;
        $limit = is_string($asked) && preg_match('/^[0-9]{1,6}$/D', $asked) === 1 ? max(1, min(NativeAppCalls::KEEP, (int) $asked)) : self::DEFAULT_LIMIT;
        try {
            $calls = $this->calls->recent((string) $app['id'], $limit);
        } catch (\Throwable $e) {
            error_log('App calls not read for app ' . $app['id'] . ': ' . get_class($e) . ' ' . $e->getMessage());
            return $this->jsonError($response, self::NOT_READ, 503, 'calls_unavailable');
        }
        return $this->jsonResponse($response, ['calls' => $calls, 'limit' => $limit, 'keep' => ['calls' => NativeAppCalls::KEEP, 'days' => NativeAppCalls::DAYS]]);
    }
}
