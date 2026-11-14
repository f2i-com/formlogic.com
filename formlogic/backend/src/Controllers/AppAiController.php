<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Helpers\IpResolver;
use FormLogic\Services\AppAiService;
use FormLogic\Services\AppAiSiteSettings;
use FormLogic\Services\AppAiWorker;
use FormLogic\Services\AppService;
use FormLogic\Services\AuditService;
use FormLogic\Support\CodeFingerprint;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * App AI's settings (AppAiService): the owner's "AI for this app" and the administrator's "AI for apps"
 * (docs/HOSTED_APPS.md, "App AI, visitors and payments").
 *
 * - `GET/PUT /api/apps/{id}/ai`, `POST /api/apps/{id}/ai/test`, `GET /api/apps/{id}/ai/test/{job}`:
 *   the app's owner. An administrator acting as them may look but not change anything, since these
 *   settings decide whose computer the app's visitors' requests go to and what they cost.
 * - `GET/PUT /api/admin/app-ai`, `PUT /api/admin/app-ai/apps/{id}`: the administrator.
 * - `POST /api/admin/app-ai/test`, `GET /api/admin/app-ai/test/{job}`: the administrator's own test
 *   of the site's AI, for the setup checklist.
 */
final class AppAiController
{
    use JsonResponseTrait;

    private string $results;
    /** @var \Closure(): string the server code's fingerprint as it is on disk now (CodeFingerprint) */
    private \Closure $code;

    /** What the administrator is told about the worker, wherever it is said: above the checklist, and by the test. */
    public const WORKER_MESSAGES = [
        'stale' => 'The AI worker was started before the last update. Restart it.',
        'missing' => 'The AI worker isn\'t running. Start it: php bin/app-ai-worker.php --watch under a supervisor, or every minute from cron.',
    ];

    public function __construct(
        private AppService $apps,
        private AppAiService $ai,
        private AppAiSiteSettings $site,
        private ?AuditService $audit = null,
        ?string $results = null,
        private ?OaiyComputerController $computers = null,
        ?\Closure $code = null,
    ) {
        $this->results = $results ?? AppAiWorker::resultsPath();
        $this->code = $code ?? static fn(): string => CodeFingerprint::onDisk();
    }

    /**
     * The worker on this server (AppAiWorker::state): {state: ok|stale|missing, idleSeconds, mode,
     * message}. `message` is what to do when it is not ok, else null.
     */
    private function worker(): array
    {
        $worker = AppAiWorker::state($this->results, ($this->code)());
        return $worker + ['message' => self::WORKER_MESSAGES[$worker['state']] ?? null];
    }

    /**
     * GET /api/apps/{id}/ai/providers?connectionId=: what one of the owner's own computers offers
     * ("Use my OAIY"), asked of it now, as OaiyComputerController asks the administrator's. Only the
     * owner's own computers can be asked (SiteAiDesktopSettings::pin), and not by an administrator
     * acting as the owner: listing is part of choosing where the app's AI goes.
     */
    public function ownerProviders(Request $request, Response $response, array $args): Response
    {
        if ($this->ownedApp($request, $args) === null || $this->computers === null) return $this->jsonError($response, 'App not found or access denied', 404);
        if ($refused = $this->refuseActingAs($request, $response)) return $refused;
        return $this->computers->providers($request, $response);
    }

    /** GET /api/apps/{id}/ai/models?connectionId=&providerId=: that provider's models, each with its `type` (`image` for pictures). */
    public function ownerModels(Request $request, Response $response, array $args): Response
    {
        if ($this->ownedApp($request, $args) === null || $this->computers === null) return $this->jsonError($response, 'App not found or access denied', 404);
        if ($refused = $this->refuseActingAs($request, $response)) return $refused;
        return $this->computers->models($request, $response);
    }

    /** GET /api/apps/{id}/ai */
    public function ownerGet(Request $request, Response $response, array $args): Response
    {
        $app = $this->ownedApp($request, $args);
        if ($app === null) return $this->jsonError($response, 'App not found or access denied', 404);
        return $this->jsonResponse($response->withHeader('Cache-Control', 'no-store'), ['data' => $this->ai->ownerView($app)]);
    }

    /** PUT /api/apps/{id}/ai {mode, perRequesterDay, perIpDay, perIpHour, perAppDay, own?: {connectionId, providerId?, pictureModel?, chatModel?} | null} */
    public function ownerPut(Request $request, Response $response, array $args): Response
    {
        $app = $this->ownedApp($request, $args);
        if ($app === null) return $this->jsonError($response, 'App not found or access denied', 404);
        if ($refused = $this->refuseActingAs($request, $response)) return $refused;
        $body = $request->getParsedBody();
        try {
            $view = $this->ai->saveSettings($app, is_array($body) ? $body : [], (string) $request->getAttribute('userId'));
        } catch (\InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400, 'invalid_request');
        }
        $this->record($request, 'app.ai.settings', (string) $app['id'], ['mode' => $view['settings']['mode']]);
        return $this->jsonResponse($response, ['data' => $view]);
    }

    /** POST /api/apps/{id}/ai/test {kind: picture|chat}: a real small job, as the owner, never delivered to the app. */
    public function ownerTest(Request $request, Response $response, array $args): Response
    {
        $app = $this->ownedApp($request, $args);
        if ($app === null) return $this->jsonError($response, 'App not found or access denied', 404);
        if ($refused = $this->refuseActingAs($request, $response)) return $refused;
        $body = $request->getParsedBody();
        $kind = is_array($body) && ($body['kind'] ?? null) === 'chat' ? 'chat' : 'picture';
        try {
            $jobId = $this->ai->queueTest($app, $kind);
        } catch (\PDOException $e) {
            return $this->databaseFailed($response, 'app test', $e);
        } catch (\RuntimeException $e) {
            return $this->jsonError($response, $e->getMessage(), 409, 'ai_unavailable');
        }
        return $this->jsonResponse($response, ['data' => ['jobId' => $jobId]], 202);
    }

    /** GET /api/apps/{id}/ai/test/{job}: how a test is getting on, and its picture or reply once it is there. */
    public function ownerTestResult(Request $request, Response $response, array $args): Response
    {
        $app = $this->ownedApp($request, $args);
        if ($app === null) return $this->jsonError($response, 'App not found or access denied', 404);
        $result = $this->ai->testResult((string) $app['id'], (string) ($args['job'] ?? ''), $this->results);
        if ($result === null) return $this->jsonError($response, 'Unknown test', 404);
        return $this->jsonResponse($response->withHeader('Cache-Control', 'no-store'), ['data' => $result]);
    }

    /** GET /api/admin/app-ai: the settings, every app using AI, and what the administrator should know. */
    public function adminGet(Request $request, Response $response): Response
    {
        return $this->jsonResponse($response->withHeader('Cache-Control', 'no-store'), ['data' => $this->adminView($request, $this->site->current())]);
    }

    /** PUT /api/admin/app-ai: the whole settings object. */
    public function adminPut(Request $request, Response $response): Response
    {
        $body = $request->getParsedBody();
        try {
            $saved = $this->site->save(is_array($body) ? $body : []);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400, 'invalid_request');
        } catch (\RuntimeException $e) {
            return $this->jsonError($response, $e->getMessage(), 500);
        }
        $this->record($request, 'admin.app_ai.settings', null, ['allowApps' => $saved['allowApps'], 'paused' => $saved['paused'], 'pictureModel' => $saved['pictureModel'], 'siteDay' => $saved['siteDay'], 'chatMaxOutput' => $saved['chatMaxOutput']]);
        return $this->jsonResponse($response, ['data' => $this->adminView($request, $saved)]);
    }

    /** PUT /api/admin/app-ai/apps/{id} {blocked: bool, reason?}: stop (or allow again) one app's AI. */
    public function adminBlock(Request $request, Response $response, array $args): Response
    {
        $appId = (string) ($args['id'] ?? '');
        if (!$this->apps->getApp($appId)) return $this->jsonError($response, 'App not found', 404);
        $body = $request->getParsedBody();
        $blocked = is_array($body) && ($body['blocked'] ?? null) === true;
        $reason = is_array($body) && is_string($body['reason'] ?? null) && trim($body['reason']) !== '' ? mb_substr(trim($body['reason']), 0, 200) : null;
        $this->ai->block($appId, $blocked, $reason, (string) $request->getAttribute('userId'));
        $this->record($request, 'admin.app_ai.block', $appId, ['blocked' => $blocked]);
        return $this->jsonResponse($response, ['data' => $this->adminView($request, $this->site->current())]);
    }

    /**
     * POST /api/admin/app-ai/test {kind: picture|chat}: the administrator's own test of the site's AI,
     * a real small job through the worker, where apps' requests on the site's AI go. No app's, and
     * needing none: it works before apps are allowed. Refused, and told why, when no worker would run
     * it (`worker_missing`) or the one running was started before the last update (`worker_stale`):
     * such a test would only wait, or be failed by code that does not know it.
     */
    public function adminTest(Request $request, Response $response): Response
    {
        $body = $request->getParsedBody();
        $kind = is_array($body) && ($body['kind'] ?? null) === 'chat' ? 'chat' : 'picture';
        $worker = $this->worker();
        if ($worker['state'] !== 'ok') return $this->jsonError($response, (string) $worker['message'], 409, 'worker_' . $worker['state']);
        try {
            $jobId = $this->ai->queueSiteTest((string) $request->getAttribute('userId'), $kind);
        } catch (\PDOException $e) {
            return $this->databaseFailed($response, 'site test', $e);
        } catch (\RuntimeException $e) {
            return $this->jsonError($response, $e->getMessage(), 409, 'ai_unavailable');
        }
        $this->record($request, 'admin.app_ai.test', null, ['kind' => $kind]);
        return $this->jsonResponse($response, ['data' => ['jobId' => $jobId]], 202);
    }

    /**
     * GET /api/admin/app-ai/test/{job}: how the administrator's test is getting on, its picture or
     * reply once it is there, and while it waits, what it is waiting for (`waiting`: `worker` when
     * the worker stopped since the test was let start, with `workerMessage` saying what to do;
     * `computer` when the site's computer is offline). A failure is told in the administrator's own
     * words (AppAiService::siteTestFailure): `code`, `message` and `advice`.
     */
    public function adminTestResult(Request $request, Response $response, array $args): Response
    {
        $result = $this->ai->testResult(AppAiService::SITE_TEST, (string) ($args['job'] ?? ''), $this->results);
        if ($result === null) return $this->jsonError($response, 'Unknown test', 404);
        if ($result['status'] === 'queued') {
            $worker = $this->worker();
            $setup = $this->ai->adminSetup();
            if ($worker['state'] !== 'ok') $result += ['waiting' => 'worker', 'workerMessage' => $worker['message']];
            elseif ($setup['source'] === 'computer' && !$setup['computer']['online']) $result['waiting'] = 'computer';
        }
        return $this->jsonResponse($response->withHeader('Cache-Control', 'no-store'), ['data' => $result]);
    }

    private function adminView(Request $request, array $settings): array
    {
        $worker = $this->worker();
        $setup = $this->ai->adminSetup();
        // Apps can make pictures only with a worker to send their requests.
        $setup['ready'] = $setup['ready'] && $worker['state'] === 'ok';
        return [
            'settings' => $settings,
            // The setup checklist's facts: where the site's AI runs, what apps would get, and the
            // worker: whether one runs, and runs the code that is here now (`workerIdleSeconds` is
            // the seconds since its last pass, null when it never ran: kept for older pages).
            'setup' => $setup + ['worker' => $worker, 'workerIdleSeconds' => $worker['idleSeconds']],
            'apps' => $this->ai->adminOverview(),
            'warnings' => array_merge(self::proxyWarnings($request), $this->ai->adminWarnings(), $this->workerWarnings()),
        ];
    }

    /** Apps' jobs waiting for minutes while no worker has run: bin/app-ai-worker.php is not scheduled, or is failing. */
    private function workerWarnings(): array
    {
        if (!$this->ai->jobsWaitingFor(180)) return [];
        $idle = AppAiWorker::idleSeconds($this->results);
        if ($idle !== null && $idle < 180) return [];
        return [[
            'code' => 'worker_idle',
            'message' => 'Apps\' AI requests are waiting, but bin/app-ai-worker.php has not run ' . ($idle === null ? 'on this server' : 'for ' . (int) round($idle / 60) . ' minutes') . '. Schedule it every minute (DEPLOYMENT.md, "Every scheduled job"), and check its log.',
        ]];
    }

    /**
     * Whether this site reads visitors' addresses as it should behind a proxy: a request that came
     * through Cloudflare (its header, or one of its addresses as the peer) while TRUSTED_PROXIES is
     * unset means every visitor reads as one of a few Cloudflare addresses, and the per-address
     * allowances become one shared allowance.
     *
     * @return list<array{code: string, message: string}>
     */
    public static function proxyWarnings(Request $request): array
    {
        $trusted = trim((string) (getenv('TRUSTED_PROXIES') ?: ($_ENV['TRUSTED_PROXIES'] ?? '')));
        if ($trusted !== '') return [];
        $peer = (string) ($request->getServerParams()['REMOTE_ADDR'] ?? '');
        if ($request->getHeaderLine('CF-Connecting-IP') === '' && !IpResolver::inCloudflare($peer)) return [];
        return [[
            'code' => 'trusted_proxies_unset',
            'message' => 'This site is reached through Cloudflare, but TRUSTED_PROXIES is not set, so every visitor reads as one of a few Cloudflare addresses and the per-address allowances are shared by everyone. Set TRUSTED_PROXIES to Cloudflare\'s ranges (and any proxy of your own in front of PHP), and TRUSTED_PROXY_HEADER to X-Forwarded-For.',
        ]];
    }

    /**
     * A test that could not be queued because the database failed. Its own words name the tables and
     * the server, so they are logged, and the person is told only that it did not start.
     */
    private function databaseFailed(Response $response, string $what, \PDOException $e): Response
    {
        error_log('App AI ' . $what . ': the database failed: ' . $e->getMessage());
        return $this->jsonError($response, 'The test could not be started. Try again in a moment.', 500, 'test_failed');
    }

    private function ownedApp(Request $request, array $args): ?array
    {
        $app = $this->apps->getApp((string) ($args['id'] ?? ''));
        $user = $request->getAttribute('userId');
        if (!$app || !is_string($user) || $user === '' || ($app['ownerId'] ?? null) !== $user) return null;
        return $app;
    }

    private function refuseActingAs(Request $request, Response $response): ?Response
    {
        $actor = $request->getAttribute('adminActorId');
        return is_string($actor) && $actor !== ''
            ? $this->jsonError($response, 'An administrator acting as the owner cannot change where the app\'s AI goes.', 403, 'acting_as_denied')
            : null;
    }

    private function record(Request $request, string $action, ?string $appId, array $details): void
    {
        try {
            $this->audit?->log($action, 'app', $appId, (string) $request->getAttribute('userId'), IpResolver::fromEnvironment()->getClientIp($request), $details);
        } catch (\Throwable) {
            // The audit log is best-effort here: the change itself is made.
        }
    }
}
