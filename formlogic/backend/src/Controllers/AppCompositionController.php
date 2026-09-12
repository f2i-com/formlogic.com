<?php
declare(strict_types=1);
namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\{AppCompositionService, AuditService};
use Psr\Http\Message\{ResponseInterface as Response, ServerRequestInterface as Request};

class AppCompositionController
{
    use JsonResponseTrait;
    public function __construct(private AppCompositionService $composition, private AuditService $audit) {}
    public function compose(Request $request, Response $response, array $args): Response
    {
        if ($blocked = $this->blockIfDemo($request, $response, 'App composition is unavailable in the shared demo.')) return $blocked;
        $body = $request->getParsedBody();
        if (!is_array($body) || !is_string($body['sourceAppId'] ?? null) || (isset($body['formIds']) && (!is_array($body['formIds']) || array_filter($body['formIds'], static fn($id) => !is_string($id)))) || (isset($body['moveAutomation']) && !is_bool($body['moveAutomation'])) || !is_array($body['approvedConnectorGrants'] ?? [])) return $this->jsonError($response, 'Invalid composition request', 400);
        try {
            $result = $this->composition->compose((string)$request->getAttribute('userId'), $body['sourceAppId'], (string)$args['id'], $body['formIds'] ?? null, $body['moveAutomation'] ?? false, $body['approvedConnectorGrants'] ?? []);
            $this->audit->log('app.compose', 'app', (string)$args['id'], (string)$request->getAttribute('userId'), null, ['sourceAppId' => $body['sourceAppId'], 'automationMoved' => $body['moveAutomation'] ?? false]);
            return $this->jsonResponse($response, $result);
        } catch (\InvalidArgumentException $e) { return $this->jsonError($response, $e->getMessage(), 400); }
        catch (\RuntimeException $e) { return $this->jsonError($response, $e->getCode() === 403 ? $e->getMessage() : 'App composition failed. No changes were saved.', $e->getCode() === 403 ? 403 : 409); }
    }
}
