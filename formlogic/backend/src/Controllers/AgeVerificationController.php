<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\AccessGateService;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Where a member meets an app's age gate, on the main site only: a session made for an app's own
 * domain is refused here by AppDomainSession, so no age check is ever asked for on a custom domain.
 * The domain sends the member here and gets them back to `return`, which must be a path of this site
 * or an address of that app's own connected domain.
 */
final class AgeVerificationController
{
    use JsonResponseTrait;

    public function __construct(
        private AppService $apps,
        private AccessGateService $gate,
        private AppDomainService $domains,
    ) {
    }

    /** GET /api/verification/age?app={slug}[&return=...]: the app's gate as the caller stands, and the methods offered. */
    public function status(Request $request, Response $response): Response
    {
        $userId = (string) $request->getAttribute('userId');
        $query = $request->getQueryParams();
        $app = $this->visibleApp($query['app'] ?? null, $userId);
        if ($app === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }
        $requirement = $this->gate->requirementOf($app);
        return $this->noStore($this->jsonResponse($response, [
            'app' => ['name' => $app['name'], 'slug' => $app['slug']],
            'ageGate' => $this->gate->statusFor($app, $userId),
            'methods' => $requirement === null ? [] : $this->gate->methodsFor($requirement),
            'returnTo' => $this->returnTo($app, $query['return'] ?? null),
        ]));
    }

    /** POST /api/verification/age/declare {app, confirm: true}: the member's own declaration, where the app accepts one. */
    public function declare(Request $request, Response $response): Response
    {
        $userId = (string) $request->getAttribute('userId');
        $body = $request->getParsedBody();
        $body = is_array($body) ? $body : [];
        $app = $this->visibleApp($body['app'] ?? null, $userId);
        if ($app === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }
        $requirement = $this->gate->requirementOf($app);
        if ($requirement === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'This app has no age requirement.'], 400);
        }
        if (($body['confirm'] ?? null) !== true) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Confirm your age to continue.'], 400);
        }
        if (!in_array('self_declaration', $this->gate->methodsFor($requirement), true)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'method_not_offered',
                'message' => 'This app needs a stronger check than your own declaration, and this site does not offer one yet.',
            ], 403);
        }
        $receipt = $this->gate->issue($userId, $requirement['minimumAge'], 'self_declaration');
        return $this->noStore($this->jsonResponse($response, [
            'receipt' => $receipt,
            'ageGate' => $this->gate->statusFor($app, $userId),
            'returnTo' => $this->returnTo($app, $body['return'] ?? null),
        ], 201));
    }

    /** GET /api/verification/receipts: the caller's own age checks. */
    public function receipts(Request $request, Response $response): Response
    {
        return $this->noStore($this->jsonResponse($response, ['receipts' => $this->gate->receiptsFor((string) $request->getAttribute('userId'))]));
    }

    /** DELETE /api/verification/receipts/{id}: withdraw one; the apps it opened are gated again. */
    public function revoke(Request $request, Response $response, array $args): Response
    {
        if (!$this->gate->revoke((string) $request->getAttribute('userId'), (string) ($args['id'] ?? ''))) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'No such age check'], 404);
        }
        return $this->jsonResponse($response, ['revoked' => true]);
    }

    private function visibleApp(mixed $slug, string $userId): ?array
    {
        if (!is_string($slug) || !preg_match('/^[a-z0-9][a-z0-9-]{0,60}$/', $slug)) {
            return null;
        }
        $app = $this->apps->getAppBySlug($slug);
        return $app !== null && $this->apps->isRuntimeVisible($app, $userId) ? $app : null;
    }

    /**
     * Where to send the member afterwards: a path of this site, or an address on a domain that
     * serves this very app. Anything else is dropped, so this is no open redirect.
     */
    private function returnTo(array $app, mixed $return): ?string
    {
        if (!is_string($return) || $return === '' || strlen($return) > 2000 || preg_match('/[\x00-\x20\\\\]/', $return)) {
            return null;
        }
        if (str_starts_with($return, '/') && !str_starts_with($return, '//')) {
            return $return;
        }
        $parts = parse_url($return);
        if (!is_array($parts) || !in_array($parts['scheme'] ?? '', ['https', 'http'], true) || ($parts['host'] ?? '') === ''
            || isset($parts['user']) || isset($parts['pass'])) {
            return null;
        }
        $host = $parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : '');
        $served = $this->domains->resolveAppSlugByHost($host);
        return $served !== null && $served['slug'] === $app['slug'] ? $return : null;
    }

    private function noStore(Response $response): Response
    {
        return $response->withHeader('Cache-Control', 'no-store');
    }
}
