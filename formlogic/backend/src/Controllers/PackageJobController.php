<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\Packages\InstallJobService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * DESK-502: the authenticated progress/audit API over install jobs.
 *
 *   GET    /api/package-jobs             — the owner's recent jobs
 *   GET    /api/package-jobs/{id}        — one job's live progress
 *   POST   /api/package-jobs/{id}/cancel — owner-initiated stop
 *
 * The claim token NEVER leaves this server through these routes. It is a device's proof of
 * ownership, and handing it to a browser would let any page that can read a job drive
 * someone's install. The browser gets state and progress, which is all a progress UI needs.
 */
class PackageJobController
{
    use JsonResponseTrait;

    public function __construct(private InstallJobService $jobs)
    {
    }

    /** Strip the device's claim token from anything returned to a browser. */
    private function forBrowser(array $job): array
    {
        unset($job['claimToken']);
        return $job;
    }

    public function list(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        // Resolve abandoned jobs first, so a listing never shows work that will never finish.
        $this->jobs->expireStale();
        $jobs = array_map(fn (array $job): array => $this->forBrowser($job), $this->jobs->listForOwner((string) $userId));
        return $this->jsonResponse($response, ['jobs' => $jobs]);
    }

    public function get(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $this->jobs->expireStale();
        $job = $this->jobs->get((string) ($args['id'] ?? ''), (string) $userId);
        if ($job === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Job not found'], 404);
        }
        return $this->jsonResponse($response, ['job' => $this->forBrowser($job)]);
    }

    public function cancel(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $cancelled = $this->jobs->cancel((string) ($args['id'] ?? ''), (string) $userId);
        if (!$cancelled) {
            // Missing, foreign, or already finished — all the same answer, so this cannot be
            // used to probe which jobs exist.
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Job not found or already finished'], 404);
        }
        return $this->jsonResponse($response, ['success' => true]);
    }
}
