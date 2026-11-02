<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\AccessGateService;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppService;
use FormLogic\Services\AuditService;
use FormLogic\Services\PluginService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * What signed-in people ask of plugins on the main site: a plugin page's context, the passes an
 * owner can require, and their own passes. A session made for an app's own domain is refused here
 * by AppDomainSession, so a plugin's page is never shown on a custom domain: the domain sends the
 * member over and gets them back to `return`, a path of this site or an address on that app's own
 * connected domain.
 */
final class PluginController
{
    use JsonResponseTrait;

    public function __construct(
        private AppService $apps,
        private AccessGateService $gate,
        private PluginService $plugins,
        private AppDomainService $domains,
        private ?AuditService $audit = null,
    ) {
    }

    /** GET /api/admin/plugins: what is installed, and what ships with FormLogic to install. */
    public function adminList(Request $request, Response $response): Response
    {
        $installed = array_map(fn (array $plugin) => $plugin + ['update' => $this->plugins->pendingUpdate($plugin)], $this->plugins->installed());
        $have = array_column($installed, 'manifestId');
        $available = [];
        foreach ($this->plugins->builtins() as $id => $plugin) {
            if (!in_array($id, $have, true)) {
                unset($plugin['dir']);
                $available[] = $plugin;
            }
        }
        return $this->jsonResponse($response, ['installed' => $installed, 'available' => $available]);
    }

    /** POST /api/admin/plugins/{plugin}/install: install a plugin that ships with FormLogic. */
    public function adminInstall(Request $request, Response $response, array $args): Response
    {
        try {
            $plugin = $this->plugins->installBuiltin((string) $args['plugin'], (string) $request->getAttribute('userId'));
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Throwable $e) {
            error_log('Plugin install failed: ' . $e->getMessage());
            return $this->jsonResponse($response, ['error' => true, 'message' => 'The plugin could not be installed: its SoftN runtime did not start. See the server log.'], 503);
        }
        $this->log($request, 'admin.plugin_install', $plugin['manifestId'], ['version' => $plugin['version'], 'grants' => array_column($plugin['grants'], 'kind')]);
        return $this->jsonResponse($response, ['plugin' => $plugin], 201);
    }

    /** POST /api/admin/plugins/{plugin}/update: take the version that ships with this FormLogic, and what it asks. */
    public function adminUpdatePlugin(Request $request, Response $response, array $args): Response
    {
        try {
            $plugin = $this->plugins->updateBuiltin((string) $args['plugin']);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Throwable $e) {
            error_log('Plugin update failed: ' . $e->getMessage());
            return $this->jsonResponse($response, ['error' => true, 'message' => 'The plugin could not be updated: its SoftN runtime refused the new version. See the server log.'], 503);
        }
        $this->log($request, 'admin.plugin_update', $plugin['manifestId'], ['version' => $plugin['version'], 'grants' => array_column($plugin['grants'], 'kind')]);
        return $this->jsonResponse($response, ['plugin' => $plugin]);
    }

    /** PUT /api/admin/plugins/{plugin} {enabled}: turn it on or off. Off, the apps that require it are closed. */
    public function adminUpdate(Request $request, Response $response, array $args): Response
    {
        $body = $request->getParsedBody();
        if (!is_array($body) || !is_bool($body['enabled'] ?? null)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Say whether the plugin is enabled.'], 400);
        }
        try {
            $plugin = $this->plugins->setEnabled((string) $args['plugin'], $body['enabled']);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 404);
        }
        $this->log($request, $body['enabled'] ? 'admin.plugin_enable' : 'admin.plugin_disable', $plugin['manifestId']);
        return $this->jsonResponse($response, ['plugin' => $plugin]);
    }

    /** DELETE /api/admin/plugins/{plugin}: remove it and withdraw every pass it issued. */
    public function adminRemove(Request $request, Response $response, array $args): Response
    {
        try {
            $this->plugins->remove((string) $args['plugin']);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 404);
        }
        $this->log($request, 'admin.plugin_remove', (string) $args['plugin']);
        return $this->jsonResponse($response, ['removed' => true]);
    }

    private function log(Request $request, string $action, string $pluginId, array $details = []): void
    {
        try {
            $this->audit?->log($action, 'admin', $pluginId, $request->getAttribute('userId'), \FormLogic\Helpers\IpResolver::fromEnvironment()->getClientIp($request), $details);
        } catch (\Throwable) {
            // audit is best-effort
        }
    }

    /**
     * GET /api/plugins/{plugin}/context?app={slug}&kind={kind}[&return=...]: what a plugin's page is
     * for. The app's requirement it is meeting, the app, the plugin's own project to run, and where
     * to go afterwards. The page asks its host for it (pluginContext); nothing here comes from the page.
     */
    public function context(Request $request, Response $response, array $args): Response
    {
        $userId = (string) $request->getAttribute('userId');
        $query = $request->getQueryParams();
        $plugin = $this->plugins->find((string) ($args['plugin'] ?? ''));
        if ($plugin === null || !$plugin['enabled']) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'That plugin is not available on this site.'], 404);
        }
        $app = $this->visibleApp($query['app'] ?? null, $userId);
        if ($app === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }
        $kind = (string) ($query['kind'] ?? '');
        $requirement = null;
        foreach ($this->gate->requirementsOf($app) as $candidate) {
            if ($candidate['plugin'] === $plugin['manifestId'] && $candidate['kind'] === $kind) {
                $requirement = $candidate;
            }
        }
        if ($requirement === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'That app does not ask for this.'], 404);
        }
        $pluginApp = $this->apps->getApp($plugin['appId']);
        $satisfied = ($app['ownerId'] ?? null) === $userId || $this->gate->satisfies($userId, $requirement);
        return $this->noStore($this->jsonResponse($response, [
            'plugin' => ['id' => $plugin['manifestId'], 'name' => $plugin['name'], 'slug' => $pluginApp['slug'] ?? null],
            'app' => ['name' => $app['name'], 'slug' => $app['slug']],
            'requirement' => $this->gate->describe($app, $requirement, $satisfied),
            'returnTo' => $this->returnTo($app, $query['return'] ?? null) ?? '/app/' . rawurlencode((string) $app['slug']),
        ]));
    }

    /** GET /api/plugins/passes: what an app owner can require, from the plugins enabled on this site. */
    public function passKinds(Request $request, Response $response): Response
    {
        return $this->jsonResponse($response, ['passes' => $this->plugins->passKinds()]);
    }

    /** GET /api/verification/receipts: the caller's own passes. */
    public function receipts(Request $request, Response $response): Response
    {
        return $this->noStore($this->jsonResponse($response, ['receipts' => $this->gate->receiptsFor((string) $request->getAttribute('userId'))]));
    }

    /** DELETE /api/verification/receipts/{id}: withdraw one; the apps it opened are gated again. */
    public function revoke(Request $request, Response $response, array $args): Response
    {
        if (!$this->gate->revoke((string) $request->getAttribute('userId'), (string) ($args['id'] ?? ''))) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'No such pass'], 404);
        }
        return $this->jsonResponse($response, ['revoked' => true]);
    }

    private function visibleApp(mixed $slug, string $userId): ?array
    {
        if (!is_string($slug) || !preg_match(AppService::SLUG_FORMAT, $slug)) {
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
