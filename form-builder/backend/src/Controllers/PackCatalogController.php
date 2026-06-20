<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\PackCatalogService;
use FormLogic\Services\PackFileService;
use FormLogic\Services\AuditService;
use FormLogic\Helpers\IpResolver;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class PackCatalogController
{
    private PackCatalogService $catalogService;
    private PackFileService $fileService;
    private ?AuditService $auditService;
    private IpResolver $ipResolver;

    public function __construct(
        PackCatalogService $catalogService,
        PackFileService $fileService,
        ?AuditService $auditService = null
    ) {
        $this->catalogService = $catalogService;
        $this->fileService = $fileService;
        $this->auditService = $auditService;
        $this->ipResolver = IpResolver::fromEnvironment();
    }

    /**
     * GET /api/packs/catalog
     * Browse published packs (public).
     */
    public function browse(Request $request, Response $response): Response
    {
        $params = $request->getQueryParams();

        $filters = [];
        if (!empty($params['search'])) {
            $filters['search'] = $params['search'];
        }
        if (!empty($params['category'])) {
            $filters['category'] = $params['category'];
        }
        if (!empty($params['tag'])) {
            $filters['tag'] = $params['tag'];
        }

        $sort = $params['sort'] ?? 'popular';
        $page = max(1, (int)($params['page'] ?? 1));
        $limit = min(50, max(1, (int)($params['limit'] ?? 20)));

        try {
            $result = $this->catalogService->listPublicPacks($filters, $sort, $page, $limit);
            return $this->jsonResponse($response, $result);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to browse packs'], 500);
        }
    }

    /**
     * GET /api/packs/catalog/{slug}
     * Get full pack detail.
     */
    public function detail(Request $request, Response $response, array $args): Response
    {
        $slug = $args['slug'] ?? '';

        try {
            // Private packs are only visible to their publisher (viewer may be null
            // on this auth-optional route). Public/unlisted are visible by slug.
            $pack = $this->catalogService->getPackDetail($slug, $request->getAttribute('userId'));
            if (!$pack) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Pack not found'], 404);
            }
            return $this->jsonResponse($response, ['pack' => $pack]);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to get pack detail'], 500);
        }
    }

    /**
     * POST /api/packs/catalog
     * Publish a new pack.
     */
    public function publish(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $body = $request->getParsedBody();
        $packData = $body['pack'] ?? null;

        if (!$packData || !is_array($packData)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Pack data is required'], 400);
        }

        $name = trim($body['name'] ?? '');
        if (strlen($name) < 2 || strlen($name) > 255) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Pack name must be 2-255 characters'], 400);
        }

        $description = $body['description'] ?? null;
        if ($description !== null && strlen($description) > 5000) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Description must be under 5000 characters'], 400);
        }

        $tags = $body['tags'] ?? [];
        if (!is_array($tags) || count($tags) > 20) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Tags must be an array with at most 20 items'], 400);
        }

        $visibility = $body['visibility'] ?? 'public';
        if (!in_array($visibility, ['public', 'private', 'unlisted'], true)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Invalid visibility value'], 400);
        }

        $metadata = [
            'name' => $name,
            'slug' => $body['slug'] ?? null,
            'description' => $description,
            'icon' => $body['icon'] ?? null,
            'tags' => $tags,
            'category' => $body['category'] ?? null,
            'visibility' => $visibility,
            'version' => $body['version'] ?? '1.0.0',
            'changelog' => $body['changelog'] ?? 'Initial release',
        ];

        try {
            $result = $this->catalogService->publishPack($packData, $userId, $metadata);

            if ($this->auditService) {
                $this->auditService->log(
                    'pack.publish',
                    'pack_catalog',
                    $result['catalogId'],
                    $userId,
                    $this->ipResolver->getClientIp($request),
                    ['name' => $metadata['name'], 'slug' => $result['slug']]
                );
            }

            return $this->jsonResponse($response, [
                'success' => true,
                'catalogId' => $result['catalogId'],
                'versionId' => $result['versionId'],
                'slug' => $result['slug'],
            ], 201);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to publish pack'], 500);
        }
    }

    /**
     * POST /api/packs/catalog/{slug}/versions
     * Add a new version to an existing pack.
     */
    public function publishVersion(Request $request, Response $response, array $args): Response
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
        $packData = $body['pack'] ?? null;
        $version = $body['version'] ?? null;

        // Strict emptiness check so the literal version "0" isn't rejected by
        // PHP truthiness.
        if (!$packData || !is_array($packData) || !is_string($version) || trim($version) === '') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Pack data and version are required'], 400);
        }

        try {
            $result = $this->catalogService->publishVersion(
                $catalog['id'],
                $version,
                $packData,
                $body['changelog'] ?? null,
                $userId
            );

            return $this->jsonResponse($response, ['success' => true] + $result, 201);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to publish version'], 500);
        }
    }

    /**
     * PUT /api/packs/catalog/{slug}
     * Update pack metadata.
     */
    public function update(Request $request, Response $response, array $args): Response
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

        try {
            $this->catalogService->updatePackMeta($catalog['id'], $body, $userId);
            return $this->jsonResponse($response, ['success' => true]);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to update pack'], 500);
        }
    }

    /**
     * DELETE /api/packs/catalog/{slug}
     * Archive a pack.
     */
    public function archive(Request $request, Response $response, array $args): Response
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
            $this->catalogService->archivePack($catalog['id'], $userId);

            if ($this->auditService) {
                $this->auditService->log(
                    'pack.archive',
                    'pack_catalog',
                    $catalog['id'],
                    $userId,
                    $this->ipResolver->getClientIp($request),
                    ['slug' => $slug]
                );
            }

            return $this->jsonResponse($response, ['success' => true]);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to archive pack'], 500);
        }
    }

    /**
     * GET /api/packs/catalog/mine
     * List current user's published packs.
     */
    public function myPacks(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        try {
            $packs = $this->catalogService->getMyPublishedPacks($userId);
            return $this->jsonResponse($response, ['packs' => $packs]);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to fetch packs'], 500);
        }
    }

    /**
     * GET /api/packs/catalog/{slug}/download
     * Download pack JSON data (increments counter).
     */
    public function download(Request $request, Response $response, array $args): Response
    {
        $slug = $args['slug'] ?? '';
        $catalog = $this->catalogService->getCatalogBySlug($slug);
        if (!$catalog) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Pack not found'], 404);
        }

        // Don't disclose a private pack's data to anyone but its publisher
        // (this route is auth-optional, so viewer may be null). Public/unlisted
        // packs remain downloadable by slug.
        $viewerId = $request->getAttribute('userId');
        if (($catalog['visibility'] ?? 'public') === 'private' && ($catalog['publisher_id'] ?? null) !== $viewerId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Pack not found'], 404);
        }

        try {
            // Optional ?version=<versionId> to install a specific historical
            // version; defaults to the latest.
            $versionId = $request->getQueryParams()['version'] ?? null;
            $version = $this->catalogService->getPackVersion($catalog['id'], is_string($versionId) && $versionId !== '' ? $versionId : null);
            if (!$version) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'No version available'], 404);
            }

            $this->catalogService->incrementDownloadCount($catalog['id']);

            return $this->jsonResponse($response, [
                'pack' => $version['pack_data'],
                'version' => $version['version'],
                'catalogId' => $catalog['id'],
                'versionId' => $version['id'],
            ]);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to download pack'], 500);
        }
    }

    /**
     * POST /api/packs/catalog/upload
     * Upload .zip file, parse and return PackData for review.
     */
    public function uploadZip(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $uploadedFiles = $request->getUploadedFiles();
        $file = $uploadedFiles['file'] ?? null;

        if (!$file || $file->getError() !== UPLOAD_ERR_OK) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'No file uploaded or upload error'], 400);
        }

        $tmpPath = null;
        try {
            // Move to temp location for processing
            $tmpPath = tempnam(sys_get_temp_dir(), 'pack_');
            $file->moveTo($tmpPath);

            $packData = $this->fileService->processZipUpload([
                'tmp_name' => $tmpPath,
                'size' => $file->getSize(),
                'type' => $file->getClientMediaType(),
            ]);

            return $this->jsonResponse($response, [
                'success' => true,
                'pack' => $packData,
                'formCount' => count($packData['forms'] ?? []),
                'appCount' => count($packData['apps'] ?? []),
            ]);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to process upload'], 500);
        } finally {
            // Always remove the temp upload — processZipUpload throws on many
            // attacker-controllable conditions (bad MIME, oversized, bad manifest),
            // and leaking a ~50MB temp file per failed upload is a disk-exhaustion DoS.
            if ($tmpPath !== null && file_exists($tmpPath)) {
                unlink($tmpPath);
            }
        }
    }

    /**
     * POST /api/packs/catalog/seed
     * Seed official packs (admin only).
     */
    public function seed(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        // Only allow seeding when the catalog is empty (initial bootstrap)
        $existing = $this->catalogService->listPublicPacks([], 'popular', 1, 1);
        if (($existing['total'] ?? 0) > 0) {
            return $this->jsonResponse($response, ['success' => true, 'seeded' => 0, 'message' => 'Catalog already has packs']);
        }

        $body = $request->getParsedBody();
        $packsData = $body['packs'] ?? [];

        if (empty($packsData)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Packs data is required'], 400);
        }

        try {
            $seeded = $this->catalogService->seedOfficialPacks($userId, $packsData);
            return $this->jsonResponse($response, ['success' => true, 'seeded' => $seeded]);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to seed packs'], 500);
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
