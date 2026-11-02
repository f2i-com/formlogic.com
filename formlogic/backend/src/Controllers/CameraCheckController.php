<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\AuditService;
use FormLogic\Services\CameraCheckService;
use FormLogic\Services\CameraCheckSettings;
use FormLogic\Services\SiteAiBusyException;
use FormLogic\Services\SiteAiDesktopSettings;
use FormLogic\Services\SiteAiTooLargeException;
use FormLogic\Services\SiteDesktopAi;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * The camera check (CameraCheckService): a member's check on the main site, and which AI reads
 * the pictures, set on Admin → Plugins. A session made for an app's own domain never reaches these.
 */
final class CameraCheckController
{
    use JsonResponseTrait;

    public function __construct(
        private CameraCheckService $checks,
        private CameraCheckSettings $settings,
        private SiteDesktopAi $desktop,
        private ?AuditService $audit = null,
    ) {
    }

    /** POST /api/camera-checks {plugin, app, kind}: start one, for one of an app's requirements. */
    public function start(Request $request, Response $response): Response
    {
        $body = (array) ($request->getParsedBody() ?? []);
        return $this->run($response, fn () => $this->checks->start(
            (string) $request->getAttribute('userId'), (string) ($body['plugin'] ?? ''), (string) ($body['app'] ?? ''), (string) ($body['kind'] ?? '')
        ), 201);
    }

    /** POST /api/camera-checks/{id}/pictures {frames}: the pictures, one per step. */
    public function frames(Request $request, Response $response, array $args): Response
    {
        $body = (array) ($request->getParsedBody() ?? []);
        return $this->run($response, fn () => $this->checks->submit((string) $request->getAttribute('userId'), (string) $args['id'], $body['frames'] ?? null), 202);
    }

    /** GET /api/camera-checks/{id}: where it stands; the ask that finds OAIY's answer has the plugin decide. */
    public function status(Request $request, Response $response, array $args): Response
    {
        return $this->run($response, fn () => $this->checks->status((string) $request->getAttribute('userId'), (string) $args['id']));
    }

    /** DELETE /api/camera-checks/{id}: the member left before sending it. */
    public function cancel(Request $request, Response $response, array $args): Response
    {
        return $this->run($response, function () use ($request, $args) {
            $this->checks->cancel((string) $request->getAttribute('userId'), (string) $args['id']);
            return ['cancelled' => true];
        });
    }

    /** GET /api/admin/camera-check: the choice, and the administrator's computers that could take it. */
    public function adminGet(Request $request, Response $response): Response
    {
        $current = $this->settings->current();
        return $this->noStore($this->jsonResponse($response, [
            'current' => $current === null ? null : [
                'connectionId' => $current['connectionId'],
                'deviceName' => $current['deviceName'] ?? '',
                'fingerprint' => SiteAiDesktopSettings::fingerprint($current['publicKey']),
                'providerId' => $current['providerId'],
                'model' => $current['model'],
                'online' => $this->settings->online($current),
                'yours' => $current['ownerUserId'] === $request->getAttribute('userId'),
            ],
            'candidates' => $this->settings->candidates((string) $request->getAttribute('userId')),
            'engineProvider' => SiteDesktopAi::PROVIDER,
        ]));
    }

    /** PUT /api/admin/camera-check {connectionId, providerId, model?}. */
    public function adminPut(Request $request, Response $response): Response
    {
        $body = (array) ($request->getParsedBody() ?? []);
        return $this->run($response, function () use ($request, $body) {
            $chosen = $this->settings->choose((string) $request->getAttribute('userId'), (string) ($body['connectionId'] ?? ''),
                (string) ($body['providerId'] ?? ''), is_string($body['model'] ?? null) ? $body['model'] : null);
            $this->log($request, 'admin.camera_check', $chosen['connectionId'], ['providerId' => $chosen['providerId'], 'model' => $chosen['model'],
                'fingerprint' => SiteAiDesktopSettings::fingerprint($chosen['publicKey'])]);
            return ['saved' => true];
        });
    }

    /** DELETE /api/admin/camera-check: camera checks off; what plugins issue through them waits until it is back. */
    public function adminDelete(Request $request, Response $response): Response
    {
        return $this->run($response, function () use ($request) {
            $this->settings->clear();
            $this->log($request, 'admin.camera_check_off', null);
            return ['saved' => true];
        });
    }

    /** POST /api/admin/camera-check/probe {plugin}: does the chosen model read pictures? Poll GET /api/camera-checks/{id}. */
    public function adminProbe(Request $request, Response $response): Response
    {
        $body = (array) ($request->getParsedBody() ?? []);
        return $this->run($response, fn () => $this->checks->startProbe((string) $request->getAttribute('userId'), (string) ($body['plugin'] ?? '')), 202);
    }

    /** POST /api/admin/camera-check/trial {plugin, min}: a plugin's whole check on the administrator, recording nothing. */
    public function adminTrial(Request $request, Response $response): Response
    {
        $body = (array) ($request->getParsedBody() ?? []);
        return $this->run($response, fn () => $this->checks->startTrial((string) $request->getAttribute('userId'), (string) ($body['plugin'] ?? ''), $body['min'] ?? null), 201);
    }

    private function run(Response $response, callable $work, int $status = 200): Response
    {
        try {
            return $this->noStore($this->jsonResponse($response, $work(), $status));
        } catch (SiteAiBusyException $e) {
            return $this->noStore($this->jsonResponse($response, ['error' => true, 'code' => $e->reason, 'message' => $e->getMessage()], 503))
                ->withHeader('Retry-After', (string) SiteAiBusyException::RETRY_AFTER_SECONDS);
        } catch (SiteAiTooLargeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'code' => 'camera_check_too_large', 'message' => $e->getMessage()], 413);
        } catch (\InvalidArgumentException $e) {
            return $this->noStore($this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400));
        } catch (\RuntimeException $e) {
            error_log('Camera check: ' . $e->getMessage());
            return $this->noStore($this->jsonResponse($response, ['error' => true, 'message' => 'The camera check could not reach the site\'s OAIY: ' . $e->getMessage()], 502));
        }
    }

    private function log(Request $request, string $action, ?string $resource, array $details = []): void
    {
        try {
            $this->audit?->log($action, 'admin', $resource, $request->getAttribute('userId'), \FormLogic\Helpers\IpResolver::fromEnvironment()->getClientIp($request), $details);
        } catch (\Throwable) {
            // audit is best-effort
        }
    }

    private function noStore(Response $response): Response
    {
        return $response->withHeader('Cache-Control', 'no-store');
    }
}
