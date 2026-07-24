<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Helpers\PackCapabilities;
use FormLogic\Services\Packages\InstallPlanService;
use FormLogic\Services\PackService;
use FormLogic\Services\SigningService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Package install plans (ADR-010 / PKG-106, first slice: the Application Package v2 lane).
 *
 *   POST /api/packages/install-plans               — propose (review, NO mutations)
 *   GET  /api/packages/install-plans/{id}          — the stored review
 *   POST /api/packages/install-plans/{id}/confirm  — digest-bound, single-use commit
 *   POST /api/packages/install-plans/{id}/cancel   — owner-explicit discard
 *
 * Pack v1 sources continue on the SAFE-001 direct describe→import lane for now; unifying
 * them behind this API is the Phase 1 target the Marketplace redesign (MKT-601+) completes.
 */
class PackageInstallPlanController
{
    use JsonResponseTrait;

    public function __construct(
        private InstallPlanService $plans,
        private ?SigningService $signingService = null,
    ) {
    }

    /** Workspace policy: only positively-verified (signed) application packages may install. */
    private function requireVerifiedPackages(): bool
    {
        return (($_ENV['REQUIRE_VERIFIED_PACKAGES'] ?? getenv('REQUIRE_VERIFIED_PACKAGES')) === 'true');
    }

    /**
     * SAFE-001 (mirrors PackController::readApprovedGrants): the reviewed connector-grant
     * array is REQUIRED at confirm — omission fails closed, never activates everything.
     *
     * @param array<string,mixed> $body
     * @return list<string>|null
     */
    private function readApprovedGrants(array $body): ?array
    {
        $raw = $body['approvedConnectorGrants'] ?? null;
        if (is_string($raw)) {
            $raw = json_decode($raw, true);
        }
        if (!is_array($raw)) {
            return null;
        }
        $out = [];
        foreach ($raw as $g) {
            if (is_string($g) && $g !== '') {
                $out[] = $g;
            }
        }
        return array_values($out);
    }

    /** REL-705: 503 for install lanes while the v2 plane is switched off. */
    private function featureDisabled(Response $response): Response
    {
        return $this->jsonResponse($response, [
            'error' => true,
            'code' => 'feature_disabled',
            'message' => 'Application Package v2 installs are disabled on this deployment.',
        ], 503);
    }

    public function propose(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        if (!\FormLogic\Services\Packages\PackagesFeature::v2Enabled()) {
            return $this->featureDisabled($response);
        }
        $body = $request->getParsedBody() ?? [];
        $package = is_array($body['package'] ?? null) ? $body['package'] : null;
        if (!is_array($package)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Package data is required'], 400);
        }
        if (($package['formatVersion'] ?? null) !== 2) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'unsupported_source',
                'message' => 'Install plans currently cover Application Package v2 aggregates — Pack v1 sources use the direct describe/import lane.',
            ], 400);
        }

        // Trust: identical semantics to the import lane (signature over the outer signed object;
        // a present-but-invalid signature rejects by default; allowUnverified is the same
        // explicit escape; the workspace verified-only policy applies to plans too).
        $trust = 'community';
        if (isset($body['signature'])) {
            $alg = (string) ($body['alg'] ?? '');
            $ok = $this->signingService && $this->signingService->verify([
                'payload' => $package,
                'signature' => (string) $body['signature'],
                'alg' => $alg,
            ]);
            $trust = PackService::classifyTrust(true, (bool) $ok, $alg);
            $allowUnverified = (($body['allowUnverified'] ?? null) === true) || (($body['allowUnverified'] ?? null) === 'true');
            if ($trust === 'unverified' && !$allowUnverified) {
                return $this->jsonResponse($response, [
                    'error' => true,
                    'code' => 'signature_invalid',
                    'message' => 'The application package signature did not verify. Re-download it, or set allowUnverified to review it anyway.',
                ], 400);
            }
        }
        if ($this->requireVerifiedPackages() && !in_array($trust, ['official', 'local-only'], true)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'unverified_package',
                'message' => 'This workspace only allows verified (signed) application packages.',
            ], 403);
        }

        try {
            $plan = $this->plans->propose($package, (string) $userId, $trust, isset($body['signature']) ? 'signed-json' : 'json', PackCapabilities::describeV2($package));
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'code' => 'invalid_package', 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to propose the install plan'], 500);
        }
        return $this->jsonResponse($response, array_merge(['formatVersion' => 2], $plan), 201);
    }

    public function get(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $plan = $this->plans->get((string) ($args['id'] ?? ''), (string) $userId);
        if ($plan === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Install plan not found'], 404);
        }
        return $this->jsonResponse($response, $plan);
    }

    public function confirm(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        if (!\FormLogic\Services\Packages\PackagesFeature::v2Enabled()) {
            return $this->featureDisabled($response);
        }
        $planId = (string) ($args['id'] ?? '');
        $body = $request->getParsedBody() ?? [];
        $approved = $this->readApprovedGrants(is_array($body) ? $body : []);
        if ($approved === null) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'grant_review_required',
                'message' => 'approvedConnectorGrants is required: send the reviewed connector-grant array (an empty array approves none).',
            ], 400);
        }
        $planDigest = is_string($body['planDigest'] ?? null) ? $body['planDigest'] : '';
        if ($planDigest === '') {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'plan_digest_required',
                'message' => 'planDigest is required — echo the digest from the proposed plan you reviewed.',
            ], 400);
        }

        // The workspace verified-only policy applies at CONFIRM too (the env can change
        // between propose and confirm; the stored trust is what the plan was reviewed under).
        $plan = $this->plans->get($planId, (string) $userId);
        if ($plan === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Install plan not found'], 404);
        }
        if ($this->requireVerifiedPackages() && !in_array($plan['trust'], ['official', 'local-only'], true)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'unverified_package',
                'message' => 'This workspace only allows verified (signed) application packages.',
            ], 403);
        }

        try {
            $result = $this->plans->confirm($planId, (string) $userId, $planDigest, $approved);
        } catch (\RuntimeException $e) {
            $msg = $e->getMessage();
            $conflict = str_starts_with($msg, 'plan_not_confirmable') || str_starts_with($msg, 'plan_digest_mismatch');
            return $this->jsonResponse($response, ['error' => true, 'message' => $msg], $conflict ? 409 : 400);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to confirm the install plan'], 500);
        }

        return $this->jsonResponse($response, [
            'success' => true,
            'trust' => $plan['trust'],
            'formatVersion' => 2,
            'planId' => $planId,
            'installationId' => $result['installationId'],
            'packageId' => $result['packageId'],
            'kind' => $result['kind'],
            'nodeTypes' => $result['nodeTypes'],
            // Shape parity with the import lane so shared UI result views render.
            'forms' => [],
            'apps' => [],
            'withheldGrants' => [],
            'warnings' => [],
        ], 201);
    }

    public function cancel(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $ok = $this->plans->cancel((string) ($args['id'] ?? ''), (string) $userId);
        if (!$ok) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Install plan not found or not cancellable'], 404);
        }
        return $this->jsonResponse($response, ['success' => true]);
    }
}
