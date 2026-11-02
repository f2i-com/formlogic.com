<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\SiteAiBusyException;
use FormLogic\Services\SiteAiDesktopSettings;
use FormLogic\Services\SiteDesktopAi;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * What one of the administrator's linked OAIY computers offers, asked of it now over the sealed
 * lane: its providers, and one provider's models. Whatever runs on the administrator's OAIY (the
 * site's AI, camera checks) chooses from these; nothing here is named in advance.
 */
final class OaiyComputerController
{
    use JsonResponseTrait;

    public function __construct(private SiteAiDesktopSettings $computers, private SiteDesktopAi $desktop)
    {
    }

    /** GET /api/admin/oaiy/providers?connectionId=: the providers that chat on that computer. */
    public function providers(Request $request, Response $response): Response
    {
        $query = $request->getQueryParams();
        return $this->ask($response, function () use ($request, $query) {
            $target = $this->computers->listingTarget((string) $request->getAttribute('userId'), (string) ($query['connectionId'] ?? ''), null);
            $final = $this->desktop->request($target, ['kind' => 'providers'], 20);
            $providers = [];
            foreach (is_array($final['providers'] ?? null) ? $final['providers'] : [] as $provider) {
                if (is_array($provider) && is_string($provider['id'] ?? null) && ($provider['enabled'] ?? true) !== false
                    && in_array('chat', is_array($provider['capabilities'] ?? null) ? $provider['capabilities'] : ['chat'], true)) {
                    $providers[] = ['id' => $provider['id'], 'label' => is_string($provider['label'] ?? null) ? $provider['label'] : $provider['id'],
                        'model' => is_string($provider['model'] ?? null) ? $provider['model'] : null];
                }
            }
            return ['providers' => $providers, 'engineProvider' => SiteDesktopAi::PROVIDER];
        });
    }

    /** GET /api/admin/oaiy/models?connectionId=&providerId=: that provider's models. */
    public function models(Request $request, Response $response): Response
    {
        $query = $request->getQueryParams();
        return $this->ask($response, function () use ($request, $query) {
            $target = $this->computers->listingTarget((string) $request->getAttribute('userId'), (string) ($query['connectionId'] ?? ''), (string) ($query['providerId'] ?? ''));
            $final = $this->desktop->request($target, ['kind' => 'models'], 20);
            $models = [];
            foreach (is_array($final['models'] ?? null) ? $final['models'] : [] as $model) {
                if (is_array($model) && is_string($model['id'] ?? null)) {
                    $models[] = ['id' => $model['id'], 'name' => is_string($model['name'] ?? null) ? $model['name'] : $model['id']];
                }
            }
            return ['models' => $models];
        });
    }

    private function ask(Response $response, callable $work): Response
    {
        try {
            return $this->jsonResponse($response, $work())->withHeader('Cache-Control', 'no-store');
        } catch (SiteAiBusyException $e) {
            return $this->jsonResponse($response, ['error' => true, 'code' => $e->reason, 'message' => $e->getMessage()], 503)
                ->withHeader('Retry-After', (string) SiteAiBusyException::RETRY_AFTER_SECONDS);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'That computer did not answer: ' . $e->getMessage()], 502);
        }
    }
}
