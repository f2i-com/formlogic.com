<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\{AppService, AppUserService, AuditService, HostedAppService, NativeAppService, RuntimeEngineService};
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class HostedAppController
{
    use JsonResponseTrait;

    // Required, not optional-with-a-default: this controller is autowired, and PHP-DI's reflection
    // autowiring SKIPS optional parameters (ReflectionBasedAutowiring::getParametersDefinition),
    // so an `= null` here would silently hand production a controller with no engine service.
    // $native is here for one reason: the engine endpoint below writes the apps.client_engine
    // column, which covers this app's hosted deployment AND its native client, so the effective
    // engine it records must account for both. Required, not optional-with-a-default, for the
    // autowiring reason above — an omitted one would silently record an effective engine derived
    // from half the app.
    public function __construct(
        private AppService $apps,
        private AppUserService $users,
        private HostedAppService $hosting,
        private RuntimeEngineService $engines,
        private AuditService $audit,
        private NativeAppService $native,
    ) {}

    public function manage(Request $request, Response $response, array $args): Response
    {
        $app = $this->apps->getApp((string) $args['id']);
        $userId = $request->getAttribute('userId');
        if (!$userId || !$app || $app['ownerId'] !== $userId) return $this->jsonError($response, 'App not found or access denied', 404);
        if ($blocked = $this->blockIfDemo($request, $response, 'App hosting is unavailable in the shared demo.')) return $blocked;
        if (($args['download'] ?? '') === 'database') {
            try {
                $path = $this->hosting->snapshot($app['id']);
                $stream = fopen($path, 'rb');
                if ($stream === false) { @unlink($path); throw new \RuntimeException('Download unavailable'); }
                register_shutdown_function(static function () use ($stream, $path): void {
                    if (is_resource($stream)) fclose($stream);
                    @unlink($path);
                });
                return $response->withBody(new \Slim\Psr7\Stream($stream))
                    ->withHeader('Content-Type', 'application/vnd.sqlite3')
                    ->withHeader('Content-Disposition', 'attachment; filename="app-database.sqlite"')
                    ->withHeader('Cache-Control', 'no-store')->withHeader('X-Content-Type-Options', 'nosniff');
            } catch (\Throwable $e) {
                error_log('Hosted database download failed: ' . $e->getMessage());
                return $this->jsonError($response, 'Database download is unavailable', 503);
            }
        }
        return $this->respond($response, function () use ($request, $app) {
            // The owner's settings view: what they asked for, what members actually get and why,
            // plus the engines this site allows them to choose between.
            if ($request->getMethod() === 'GET') return ['deployment' => $this->hosting->get($app['id'], true)] + $this->engineForOwner($app['id']);
            $body = $request->getParsedBody();
            if (!is_array($body) || !is_array($body['package'] ?? null) || !is_int($body['expectedVersion'] ?? null) || $body['expectedVersion'] < 0) {
                throw new \InvalidArgumentException('Provide a package and expectedVersion');
            }
            // The engine block again, from the bundle JUST published: a `.py` added or removed changes
            // the server's decision, and the owner's panel mounts its preview on this answer.
            $published = ['deployment' => $this->hosting->publish($app['id'], $body['package'], $body['expectedVersion'])];
            return $published + $this->engineAfterPublish($app['id']);
        });
    }

    /**
     * The owner's engine view after a publish that has already committed. A resolver failure here
     * is logged and leaves the block out rather than answering 503 for a publish that succeeded:
     * the panel keeps the engine it had, and the next GET shows the fresh one.
     */
    private function engineAfterPublish(string $appId): array
    {
        try {
            return $this->engineForOwner($appId);
        } catch (\Throwable $e) {
            error_log('Hosted app engine after publish unavailable: ' . $e->getMessage());
            return [];
        }
    }

    public function runtime(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        $app = $this->apps->getAppBySlug((string) $args['slug']);
        if (!$userId || !$app || !$this->apps->isRuntimeVisible($app, $userId)) return $this->jsonError($response, 'App not found or access denied', 404);
        $owner = $app['ownerId'] === $userId;
        if (!$owner && ($this->users->getAppUser($app['id'], $userId)['status'] ?? null) !== 'active') return $this->jsonError($response, 'Active app membership required', 403);
        if ($blocked = $this->blockIfDemo($request, $response, 'App hosting is unavailable in the shared demo.')) return $blocked;
        return $this->respond($response, function () use ($request, $response, $app, $args, $userId, $owner) {
            // The page was loaded on one engine; the server may have decided otherwise since (a
            // revocation, a policy edit). Inside respond(), so a resolver that cannot answer is the
            // same generic 503 every other failure here is; the refusal itself is a Response, which
            // respond() passes through, so it keeps the engine_changed code the parent remounts on.
            if ($stale = $this->refuseStaleEngine($request, $response, $app['id'])) return $stale;
            if ($request->getMethod() === 'GET') {
                $deployment = $this->hosting->get($app['id']);
                if (!$deployment) throw new \RuntimeException('This app has no hosted project', 404);
                // What this app's logic is written in, from the client file names about to be posted
                // into the frame and nothing else. A `.py` among them means Python, which only
                // zipp-web-python runs; the resolver clamps to it, and this install must already
                // know the rule or the app is not served at all.
                $languages = RuntimeEngineService::languagesOf($deployment['client'] ?? []);
                $this->engines->assertInstalledRuns($languages);
                return ['deployment' => $deployment, 'name' => $app['name']] + $this->engineForRuntime($app['id'], $languages);
            }
            $input = $request->getParsedBody();
            if (!is_array($input) || (array_is_list($input) && $input !== [])) throw new \InvalidArgumentException('Action input must be a JSON object');
            return ['result' => $this->hosting->run($app['id'], (string) $args['action'], $input, $userId, $owner)];
        });
    }

    /**
     * PUT /api/apps/{id}/engine { engine: 'zipp-web-python'|'zipp-web'|'host-js'|null }
     *
     * The owner's choice, in its own column. One column covers this app's hosted deployment, its
     * native client and its hosted dashboard home, because all three key on apps.id. Owner-only by
     * design: an admin acting as the owner may edit their app, but may not hand it an engine.
     *
     * 422 means the choice would NEVER take effect (this site does not allow that engine, or
     * host-js without a verified owner). A choice this install cannot serve YET is stored: the
     * install changes without the owner doing anything, and the settings UI shows the effective
     * engine and its reason meanwhile.
     */
    public function engine(Request $request, Response $response, array $args): Response
    {
        $app = $this->apps->getApp((string) $args['id']);
        $userId = $request->getAttribute('userId');
        if (!$userId || !$app || $app['ownerId'] !== $userId) return $this->jsonError($response, 'App not found or access denied', 404);
        if ($blocked = $this->blockIfDemo($request, $response, 'App hosting is unavailable in the shared demo.')) return $blocked;
        $body = $request->getParsedBody();
        if (!is_array($body) || !array_key_exists('engine', $body)) return $this->jsonError($response, 'Provide an engine, or null for the site default', 400);
        $engine = $body['engine'];
        if ($engine !== null && !is_string($engine)) return $this->jsonError($response, 'Provide an engine, or null for the site default', 400);
        $response = $response->withHeader('Cache-Control', 'no-store')->withHeader('X-Content-Type-Options', 'nosniff');
        try {
            $sp = $request->getServerParams();
            $effective = $this->engines->storeChoice($app['id'], $engine, $this->choiceLanguages($app['id']), $this->audit, (string) $userId, $sp['REMOTE_ADDR'] ?? null);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 422, 'engine_not_available');
        } catch (\Throwable $e) {
            // The audit row is part of the change: if it could not be written, nothing committed.
            error_log('App engine change failed: ' . $e->getMessage());
            return $this->jsonError($response, 'The engine change could not be recorded, so nothing was changed', 503);
        }
        return $this->jsonResponse($response, ['engine' => $effective, 'policy' => $this->engines->ownerPolicy()]);
    }

    /**
     * The settings view of the engine: the choice, the outcome, and what may be chosen. Derived from
     * the same client files a member's frame receives, so the owner is shown the engine (and the
     * reason) their members actually get.
     */
    private function engineForOwner(string $appId): array
    {
        return ['engine' => $this->engines->effective($appId, $this->languagesOf($appId)), 'enginePolicy' => $this->engines->ownerPolicy()];
    }

    /**
     * What a runtime mount needs: the id to run and the revision it must send back on actions.
     *
     * @param list<string> $languages
     */
    private function engineForRuntime(string $appId, array $languages): array
    {
        $effective = $this->engines->effective($appId, $languages);
        return ['engine' => ['id' => $effective['id'], 'revision' => $effective['revision']]];
    }

    /**
     * The logic languages of the HOSTED deployment — the bundle this controller's frame mounts,
     * so the server's answer and the shell's are derived from one file list.
     */
    private function languagesOf(string $appId): array
    {
        return $this->hosting->clientLanguages($appId);
    }

    /**
     * The logic languages the engine CHOICE governs: this app's hosted deployment and its native
     * client, merged. The mount paths above each answer for their own bundle, because each must
     * agree with the shell it hands files to; the column covers both, so a choice that cannot take
     * effect for either has not taken effect, and the audit row must not claim it did.
     */
    private function choiceLanguages(string $appId): array
    {
        return RuntimeEngineService::mergeLanguages(
            $this->hosting->clientLanguages($appId),
            $this->native->clientLanguages($appId),
        );
    }

    /**
     * 409 engine_changed when the parent's X-FormLogic-Client-Engine no longer matches what the
     * server decides now. The header grants nothing — a request without it is answered as before
     * and asks the resolver nothing. A request WITH it pays for the decision: the resolver's reads
     * (the app and owner row, the policy row, the installed-runtime record) and the deployment's
     * file names, the same price the GET that mounted the frame paid.
     */
    private function refuseStaleEngine(Request $request, Response $response, string $appId): ?Response
    {
        $header = $request->getMethod() === 'GET' ? '' : $request->getHeaderLine('X-FormLogic-Client-Engine');
        if ($header === '') return null;
        // The SAME decision the GET made, languages included: without them a Python app whose owner
        // stored another engine would be handed zipp-web-python on the GET and then told on every
        // action that the engine had changed, which is a remount loop, not a revocation.
        if (RuntimeEngineService::headerMatches($header, $this->engines->effective($appId, $this->languagesOf($appId)))) return null;
        return $this->jsonError(
            $response->withHeader('Cache-Control', 'no-store'),
            'This app is now set to run on a different engine. Reload to continue.',
            409,
            'engine_changed'
        );
    }

    /** $operation answers with an array to encode, or with a finished Response (a typed refusal). */
    private function respond(Response $response, callable $operation): Response
    {
        $response = $response->withHeader('Cache-Control', 'no-store')->withHeader('X-Content-Type-Options', 'nosniff');
        try {
            $result = $operation();
            return $result instanceof Response ? $result : $this->jsonResponse($response, $result);
        }
        catch (\InvalidArgumentException $e) { return $this->jsonError($response, $e->getMessage(), 400); }
        catch (\RuntimeException $e) {
            if (in_array($e->getCode(), [404, 409, 422], true)) return $this->jsonError($response, $e->getMessage(), $e->getCode());
            error_log('Hosted app failure: ' . $e->getMessage());
            return $this->jsonError($response, 'App hosting is temporarily unavailable', 503);
        }
        catch (\Throwable $e) {
            error_log('Hosted app failure: ' . $e->getMessage());
            return $this->jsonError($response, 'App hosting is temporarily unavailable', 503);
        }
    }
}
