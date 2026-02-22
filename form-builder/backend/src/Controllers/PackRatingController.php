<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\PackRatingService;
use FormLogic\Services\PackCatalogService;
use FormLogic\Services\AuditService;
use FormLogic\Helpers\IpResolver;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class PackRatingController
{
    private PackRatingService $ratingService;
    private PackCatalogService $catalogService;
    private ?AuditService $auditService;
    private IpResolver $ipResolver;

    public function __construct(
        PackRatingService $ratingService,
        PackCatalogService $catalogService,
        ?AuditService $auditService = null
    ) {
        $this->ratingService = $ratingService;
        $this->catalogService = $catalogService;
        $this->auditService = $auditService;
        $this->ipResolver = IpResolver::fromEnvironment();
    }

    /**
     * POST /api/packs/catalog/{slug}/ratings
     * Submit or update a rating.
     */
    public function rate(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $slug = $args['slug'] ?? '';
        $catalog = $this->catalogService->getCatalogBySlug($slug);
        if (!$catalog) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Pack not found'], 404);
        }

        $body = $request->getParsedBody();
        $rating = (int)($body['rating'] ?? 0);
        $review = $body['review'] ?? null;

        try {
            $result = $this->ratingService->ratePack($catalog['id'], $userId, $rating, $review);

            // Recalculate avg
            $this->catalogService->recalculateRating($catalog['id']);

            return $this->jsonResponse($response, ['success' => true, 'rating' => $result]);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to submit rating'], 500);
        }
    }

    /**
     * GET /api/packs/catalog/{slug}/ratings
     * List ratings for a pack.
     */
    public function listRatings(Request $request, Response $response, array $args): Response
    {
        $slug = $args['slug'] ?? '';
        $catalog = $this->catalogService->getCatalogBySlug($slug);
        if (!$catalog) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Pack not found'], 404);
        }

        $params = $request->getQueryParams();
        $page = max(1, (int)($params['page'] ?? 1));
        $limit = min(50, max(1, (int)($params['limit'] ?? 20)));

        try {
            $result = $this->ratingService->getPackRatings($catalog['id'], $page, $limit);

            // Include current user's rating if authenticated
            $userId = $request->getAttribute('userId');
            if ($userId) {
                $userRating = $this->ratingService->getUserRating($catalog['id'], $userId);
                $result['userRating'] = $userRating ? [
                    'rating' => (int)$userRating['rating'],
                    'review' => $userRating['review'],
                ] : null;
            }

            return $this->jsonResponse($response, $result);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to fetch ratings'], 500);
        }
    }

    /**
     * DELETE /api/packs/catalog/{slug}/ratings
     * Delete current user's rating.
     */
    public function deleteRating(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $slug = $args['slug'] ?? '';
        $catalog = $this->catalogService->getCatalogBySlug($slug);
        if (!$catalog) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Pack not found'], 404);
        }

        try {
            $this->ratingService->deleteRating($catalog['id'], $userId);
            $this->catalogService->recalculateRating($catalog['id']);
            return $this->jsonResponse($response, ['success' => true]);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to delete rating'], 500);
        }
    }

    private function jsonResponse(Response $response, array $data, int $status = 200): Response
    {
        $json = json_encode($data);
        if ($json === false) {
            $json = json_encode(['error' => true, 'message' => 'Internal server error']);
            $status = 500;
        }
        $response->getBody()->write($json);
        return $response
            ->withStatus($status)
            ->withHeader('Content-Type', 'application/json');
    }
}
