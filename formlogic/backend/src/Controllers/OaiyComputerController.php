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
 * What one of the signed-in person's own linked OAIY computers offers, asked of it now over the
 * sealed lane: its providers, and one provider's models. Whatever runs on the administrator's OAIY
 * (the site's AI, camera checks) and an app's "Use my OAIY" choose from these; nothing here is
 * named in advance.
 *
 * A listing is asked for and then read, never waited for: a request without `listing` asks the
 * computer and answers 202 `{listing}`, the handle to ask again with; a request with it answers 200
 * with the listing once the computer has sent it, 202 `{listing}` while it has not, and an error
 * once it failed or SiteDesktopAi::LISTING_SECONDS passed. A PHP worker waiting on the computer was
 * held for as long as it took, and the built-in server has one: it answered nothing else meanwhile.
 * Only the person's own computer is asked (SiteAiDesktopSettings::pin), and only their own requests
 * are read back (the lane's owner scope), whatever handle is sent.
 */
final class OaiyComputerController
{
    use JsonResponseTrait;

    public function __construct(private SiteAiDesktopSettings $computers, private SiteDesktopAi $desktop)
    {
    }

    /** GET /api/admin/oaiy/providers?connectionId=[&listing=]: the providers that chat on that computer. */
    public function providers(Request $request, Response $response): Response
    {
        return $this->ask($request, $response, null, static function (array $final): array {
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

    /**
     * GET /api/admin/oaiy/models?connectionId=&providerId=[&listing=]: that provider's models, each
     * with its `type` where OAIY gives one (`image` for a picture model, as App AI's settings list
     * them; a language model has none).
     */
    public function models(Request $request, Response $response): Response
    {
        return $this->ask($request, $response, (string) ($request->getQueryParams()['providerId'] ?? ''), static function (array $final): array {
            $models = [];
            foreach (is_array($final['models'] ?? null) ? $final['models'] : [] as $model) {
                if (is_array($model) && is_string($model['id'] ?? null)) {
                    $models[] = ['id' => $model['id'], 'name' => is_string($model['name'] ?? null) ? $model['name'] : $model['id']]
                        + (is_string($model['type'] ?? null) && preg_match('/^[a-z0-9_-]{1,32}$/D', $model['type']) ? ['type' => $model['type']] : []);
                }
            }
            return ['models' => $models];
        });
    }

    /**
     * Ask for a listing, or read the one asked for (the class's comment). $providerId is null for the
     * providers, else the provider whose models are listed; $shape turns the computer's final frame
     * into what the page is given.
     *
     * @param callable(array): array $shape
     */
    private function ask(Request $request, Response $response, ?string $providerId, callable $shape): Response
    {
        $query = $request->getQueryParams();
        // `listing` is a listing's handle, or absent to ask for one. Anything else (`listing[]=1`) is
        // refused: read as absent, it asked the computer anew on the reads' budget (index.php sends a
        // request that names a listing to that budget, and one that names none to the asking's).
        if (array_key_exists('listing', $query) && !is_string($query['listing'])) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'listing is the handle a listing was asked with.'], 400);
        }
        $handle = (string) ($query['listing'] ?? '');
        try {
            $target = $this->computers->listingTarget((string) $request->getAttribute('userId'), (string) ($query['connectionId'] ?? ''), $providerId);
            if ($handle === '') {
                return $this->waiting($response, $this->desktop->listing($target, ['kind' => $providerId === null ? 'providers' : 'models']));
            }
            // `letGo=1`: the page stopped reading the listing before it came (another computer chosen,
            // the page closed, it gave up waiting), so the computer is not left answering nobody.
            // Only the page that holds the handle can name it: its token is random, and only a handle
            // this site gave out is honoured (SiteDesktopAi::listingOf).
            if (($query['letGo'] ?? null) === '1') {
                return $this->jsonResponse($response, ['letGo' => $this->desktop->letGoListing($target, $handle)])->withHeader('Cache-Control', 'no-store');
            }
            $final = $this->desktop->listed($target, $handle);
            if ($final === null) {
                return $this->waiting($response, $handle);
            }
            return $this->jsonResponse($response, $shape($final))->withHeader('Cache-Control', 'no-store');
        } catch (SiteAiBusyException $e) {
            return $this->jsonResponse($response, ['error' => true, 'code' => $e->reason, 'message' => $e->getMessage()], 503)
                ->withHeader('Retry-After', (string) SiteAiBusyException::RETRY_AFTER_SECONDS);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\PDOException $e) {
            // The database's own words name its tables and its server: logged, never shown.
            error_log('OAIY listing: the database failed: ' . $e->getMessage());
            return $this->jsonResponse($response, ['error' => true, 'message' => 'The computer could not be asked just now. Try again in a moment.'], 500);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'That computer did not answer: ' . $e->getMessage()], 502);
        }
    }

    /** 202: the listing is asked for and not back yet; ask again with `listing`. */
    private function waiting(Response $response, string $handle): Response
    {
        return $this->jsonResponse($response, ['listing' => $handle], 202)->withHeader('Cache-Control', 'no-store');
    }
}
