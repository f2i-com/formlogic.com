<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\PackCatalogService;
use FormLogic\Services\PackFileService;
use FormLogic\Services\AuditService;
use FormLogic\Helpers\IpResolver;
use FormLogic\Controllers\Concerns\JsonResponseTrait;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class PackCatalogController
{
    use JsonResponseTrait;

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
        // Marketplace facets (spec §30): artifact type + trust level. The service validates the values
        // against its fixed enums, so an unknown value is simply ignored.
        if (!empty($params['itemType'])) {
            $filters['itemType'] = $params['itemType'];
        }
        if (!empty($params['trustLevel'])) {
            $filters['trustLevel'] = $params['trustLevel'];
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
     * GET /api/packs/catalog/facets
     * Browsable categories + tags derived from the live catalog (public).
     */
    public function facets(Request $request, Response $response): Response
    {
        try {
            $facets = $this->catalogService->getFacets();
            return $this->jsonResponse($response, $facets);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to load facets'], 500);
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
            // itemType is validated against the fixed enum in the service; trust_level is NOT accepted
            // from the client — it is derived server-side at publish time.
            'itemType' => $body['itemType'] ?? null,
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
    /**
     * The deployment's own official packs, read from `resources/marketplace-packs/*.json`
     * (emitted from the authored TypeScript catalog). Malformed or non-pack files are skipped
     * rather than failing the bootstrap; ordering is stable so seeding is deterministic.
     *
     * @return list<array<string,mixed>>
     */
    private function loadOfficialPacks(): array
    {
        $dir = dirname(__DIR__, 2) . '/resources/marketplace-packs';
        if (!is_dir($dir)) {
            return [];
        }
        $files = glob($dir . '/*.json') ?: [];
        sort($files, SORT_STRING);
        $packs = [];
        foreach ($files as $file) {
            $decoded = json_decode((string) file_get_contents($file), true);
            if (!is_array($decoded) || !is_string($decoded['name'] ?? null) || !is_array($decoded['pack'] ?? null)) {
                continue;
            }
            $packs[] = $decoded;
        }
        return array_merge($packs, $this->loadBundledExtensions());
    }

    /**
     * The Application Package v2 extensions this deployment ships, as catalog entries.
     *
     * They live in their own directory because they are a different aggregate, not a Pack v1
     * with extra fields — but they belong in the SAME catalog, because from a user's side
     * "browse what I can install" is one question. The listing shape is normalised here so the
     * seeder does not need to know which kind it is handling.
     *
     * `package.keywords` becomes the catalog's searchable tags: a package says how it wants to
     * be found once, in its own manifest, rather than in a separate listing someone maintains
     * alongside it and forgets to update.
     *
     * Invalid files are SKIPPED rather than failing the bootstrap — and skipping is safe,
     * because a package that does not validate could not be installed anyway.
     *
     * @return list<array<string,mixed>>
     */
    private function loadBundledExtensions(): array
    {
        $dir = dirname(__DIR__, 2) . '/resources/bundled-extensions';
        if (!is_dir($dir)) {
            return [];
        }
        $files = glob($dir . '/*.json') ?: [];
        sort($files, SORT_STRING);
        $out = [];
        foreach ($files as $file) {
            $aggregate = json_decode((string) file_get_contents($file), true);
            if (!is_array($aggregate)
                || \FormLogic\Helpers\ApplicationPackageV2Validator::validatePackage($aggregate) !== []) {
                continue;
            }
            $meta = is_array($aggregate['package'] ?? null) ? $aggregate['package'] : [];
            $keywords = array_values(array_filter(
                is_array($meta['keywords'] ?? null) ? $meta['keywords'] : [],
                'is_string'
            ));
            $out[] = [
                'name' => (string) ($meta['displayName'] ?? basename($file, '.json')),
                'description' => (string) ($meta['description'] ?? ''),
                'tags' => $keywords,
                'category' => 'Extensions',
                'itemType' => 'application_package',
                'version' => (string) ($meta['version'] ?? '1.0.0'),
                // The aggregate itself is the payload. publishPack reads its formatVersion and
                // records which lane installs it.
                'pack' => $aggregate,
            ];
        }
        return $out;
    }

    public function seed(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        // Seeding used to be bootstrap-only: it returned early the moment the catalog had any
        // rows. That made anything the deployment shipped LATER — a new official pack, a new
        // bundled extension — invisible forever on every deployment that had already
        // bootstrapped, which is every deployment that has been used.
        //
        // It now adds whatever is missing. That is safe because seeding is already idempotent
        // per slug (seedOfficialPacks skips a slug it finds) and because MKT-602 made the
        // content come from the SERVER'S OWN files rather than the request body: the worst a
        // repeat call can do is publish the deployment's own official content, which is what
        // this endpoint is for. A call with nothing missing writes nothing and reports 0.

        // MKT-602: the catalog is seeded from the SERVER'S OWN copy of the official packs
        // (resources/marketplace-packs, emitted from src/data/packs at build time). The client
        // used to POST the pack payloads it had bundled, which meant any authenticated user
        // could define what "official" means on a fresh tenant — content attributed to the
        // platform owner, chosen by whoever loaded the page first. Request bodies are now
        // ignored entirely: this endpoint TRIGGERS a bootstrap, it does not supply one.
        $packsData = $this->loadOfficialPacks();
        if ($packsData === []) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'no_official_packs',
                'message' => 'This deployment ships no marketplace packs to seed.',
            ], 404);
        }

        try {
            $seeded = $this->catalogService->seedOfficialPacks($userId, $packsData);
            return $this->jsonResponse($response, ['success' => true, 'seeded' => $seeded]);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to seed packs'], 500);
        }
    }
}
