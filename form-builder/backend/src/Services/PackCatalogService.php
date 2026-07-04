<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

class PackCatalogService
{
    private PDO $mysql;

    public function __construct(MySQLConnection $mysql)
    {
        $this->mysql = $mysql->getConnection();
    }

    /**
     * Browse published packs with filtering, search, and pagination.
     */
    public function listPublicPacks(array $filters = [], string $sort = 'popular', int $page = 1, int $limit = 20): array
    {
        $where = ["pc.status = 'published'"];
        $params = [];

        // Only show public packs for browse (unlisted accessible by direct slug)
        $where[] = "pc.visibility = 'public'";

        if (!empty($filters['search'])) {
            // Use '!' as the LIKE escape char (not backslash): a backslash escape in a double-quoted
            // PHP string collapses to ESCAPE '\' in SQL, whose \' escapes the quote and breaks the query.
            // Bind two distinct placeholders (not one reused :search) — PDO with emulation off rejects a
            // named placeholder used more than once.
            $where[] = "(pc.name LIKE :searchName ESCAPE '!' OR pc.description LIKE :searchDesc ESCAPE '!')";
            $escaped = strtr($filters['search'], ['!' => '!!', '%' => '!%', '_' => '!_']);
            $params['searchName'] = '%' . $escaped . '%';
            $params['searchDesc'] = '%' . $escaped . '%';
        }

        if (!empty($filters['category'])) {
            $where[] = "pc.category = :category";
            $params['category'] = $filters['category'];
        }

        if (!empty($filters['tag'])) {
            $where[] = "JSON_CONTAINS(pc.tags, :tag)";
            $params['tag'] = json_encode($filters['tag']);
        }

        $whereClause = implode(' AND ', $where);

        $orderBy = match ($sort) {
            'newest' => 'pc.created_at DESC',
            'top_rated' => 'pc.avg_rating DESC, pc.rating_count DESC',
            'name' => 'pc.name ASC',
            default => 'pc.download_count DESC', // popular
        };

        $offset = ($page - 1) * $limit;

        // Count total
        $countStmt = $this->mysql->prepare("SELECT COUNT(*) FROM pack_catalog pc WHERE {$whereClause}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        // Fetch packs with publisher info and latest version
        $sql = "
            SELECT pc.*,
                   u.name AS publisher_name,
                   u.email AS publisher_email,
                   u.email AS publisher_email,
                   pv.version AS latest_version,
                   pv.form_count,
                   pv.app_count
            FROM pack_catalog pc
            JOIN users u ON u.id = pc.publisher_id
            LEFT JOIN pack_versions pv ON pv.id = (
                    SELECT pv2.id FROM pack_versions pv2 WHERE pv2.catalog_id = pc.id
                    ORDER BY pv2.created_at DESC, pv2.id DESC LIMIT 1
                )
            WHERE {$whereClause}
            ORDER BY {$orderBy}
            LIMIT :limit OFFSET :offset
        ";

        $stmt = $this->mysql->prepare($sql);
        foreach ($params as $key => $val) {
            $stmt->bindValue($key, $val);
        }
        $stmt->bindValue('limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue('offset', $offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll();

        $packs = array_map(fn($row) => $this->formatPack($row), $rows);

        return [
            'packs' => $packs,
            'total' => $total,
            'page' => $page,
            'limit' => $limit,
            'totalPages' => (int) ceil($total / $limit),
        ];
    }

    /**
     * Browsable facets derived dynamically from the published/public catalog: the set of
     * categories and tags actually in use, each with a pack count. The marketplace renders these
     * as filter chips, so browsing adapts automatically as packs are published/archived — there is
     * no hardcoded taxonomy to maintain.
     *
     * @return array{categories: list<array{name:string,count:int}>, tags: list<array{name:string,count:int}>}
     */
    public function getFacets(): array
    {
        $where = "pc.status = 'published' AND pc.visibility = 'public'";

        // Categories: a single indexed column, aggregate in SQL.
        $catStmt = $this->mysql->query(
            "SELECT pc.category AS name, COUNT(*) AS cnt
             FROM pack_catalog pc
             WHERE {$where} AND pc.category IS NOT NULL AND pc.category <> ''
             GROUP BY pc.category
             ORDER BY cnt DESC, name ASC"
        );
        $categories = array_map(
            fn($r) => ['name' => (string)$r['name'], 'count' => (int)$r['cnt']],
            $catStmt->fetchAll()
        );

        // Tags live in a JSON array column; aggregate in PHP (the public catalog is small).
        $tagStmt = $this->mysql->query("SELECT pc.tags FROM pack_catalog pc WHERE {$where}");
        $counts = [];
        foreach ($tagStmt->fetchAll() as $row) {
            $tags = json_decode($row['tags'] ?? '[]', true);
            if (!is_array($tags)) {
                continue;
            }
            foreach ($tags as $tag) {
                if (!is_string($tag)) {
                    continue;
                }
                $tag = trim($tag);
                if ($tag === '') {
                    continue;
                }
                $counts[$tag] = ($counts[$tag] ?? 0) + 1;
            }
        }
        // Sort by count desc, then name asc for stable display.
        uksort($counts, function ($a, $b) use ($counts) {
            if ($counts[$a] !== $counts[$b]) {
                return $counts[$b] <=> $counts[$a];
            }
            return strcasecmp($a, $b);
        });
        $tags = [];
        foreach ($counts as $name => $cnt) {
            $tags[] = ['name' => $name, 'count' => $cnt];
        }

        return ['categories' => $categories, 'tags' => $tags];
    }

    /**
     * Attach captured dashboard screenshots to a pack by slug — one per app (the detail view shows
     * them as a gallery). Also mirrors the first shot into the single `screenshot` column for any
     * legacy single-image use. Called by the screenshot-capture pipeline. Idempotent.
     *
     * @param list<array{label:string,url:string}> $shots
     */
    public function setPackScreenshots(string $slug, array $shots): void
    {
        $primary = $shots[0]['url'] ?? null;
        $stmt = $this->mysql->prepare("UPDATE pack_catalog SET screenshot = :s, screenshots = :ss WHERE slug = :slug");
        $stmt->execute([
            's' => $primary,
            'ss' => json_encode(array_values($shots)),
            'slug' => $slug,
        ]);
    }

    /**
     * Get full pack detail by slug, including versions and rating summary.
     */
    public function getPackDetail(string $slug, ?string $viewerId = null): ?array
    {
        $stmt = $this->mysql->prepare("
            SELECT pc.*,
                   u.name AS publisher_name,
                   u.email AS publisher_email,
                   u.email AS publisher_email,
                   pv.version AS latest_version,
                   pv.form_count,
                   pv.app_count,
                   pv.pack_data AS latest_pack_data
            FROM pack_catalog pc
            JOIN users u ON u.id = pc.publisher_id
            LEFT JOIN pack_versions pv ON pv.id = (
                    SELECT pv2.id FROM pack_versions pv2 WHERE pv2.catalog_id = pc.id
                    ORDER BY pv2.created_at DESC, pv2.id DESC LIMIT 1
                )
            WHERE pc.slug = :slug AND pc.status != 'archived'
              AND (pc.visibility IS NULL OR pc.visibility <> 'private' OR pc.publisher_id = :viewer)
        ");
        $stmt->execute(['slug' => $slug, 'viewer' => $viewerId ?? '']);
        $pack = $stmt->fetch();

        if (!$pack) {
            return null;
        }

        $result = $this->formatPack($pack);

        // "What's inside" for the marketplace detail page: the actual form/app
        // names, parsed from the latest version's stored pack JSON. Detail-only —
        // browse/list queries never pay for decoding the pack_data blob.
        $formTitles = [];
        $appNames = [];
        if (!empty($pack['latest_pack_data'])) {
            $packData = json_decode((string) $pack['latest_pack_data'], true);
            if (is_array($packData)) {
                $forms = is_array($packData['forms'] ?? null) ? $packData['forms'] : [];
                foreach ($forms as $form) {
                    if (is_array($form) && is_string($form['title'] ?? null) && $form['title'] !== '') {
                        $formTitles[] = $form['title'];
                    }
                }
                $apps = is_array($packData['apps'] ?? null) ? $packData['apps'] : [];
                foreach ($apps as $app) {
                    if (is_array($app) && is_string($app['name'] ?? null) && $app['name'] !== '') {
                        $appNames[] = $app['name'];
                    }
                }
            }
        }
        $result['formTitles'] = $formTitles;
        $result['appNames'] = $appNames;

        // Get all versions
        $vStmt = $this->mysql->prepare("
            SELECT id, version, changelog, form_count, app_count, created_at
            FROM pack_versions
            WHERE catalog_id = :catalog_id
            ORDER BY created_at DESC
        ");
        $vStmt->execute(['catalog_id' => $pack['id']]);
        $result['versions'] = $vStmt->fetchAll();

        return $result;
    }

    /**
     * Publish a new pack to the catalog.
     */
    public function publishPack(array $packData, string $userId, array $metadata): array
    {
        $catalogId = $this->generateUuid();
        $versionId = $this->generateUuid();

        $slug = $metadata['slug'] ?? $this->generateSlug($metadata['name'] ?? 'pack');
        $slug = $this->ensureUniqueSlug($slug);
        $version = $metadata['version'] ?? '1.0.0';
        $packJson = $this->encodePackDataWithCap($packData);

        $this->mysql->beginTransaction();
        try {
            // Create catalog entry
            $stmt = $this->mysql->prepare("
                INSERT INTO pack_catalog (id, slug, publisher_id, name, description, icon, tags, category, visibility, status)
                VALUES (:id, :slug, :publisher_id, :name, :description, :icon, :tags, :category, :visibility, 'published')
            ");
            $stmt->execute([
                'id' => $catalogId,
                'slug' => $slug,
                'publisher_id' => $userId,
                'name' => $metadata['name'] ?? 'Untitled Pack',
                'description' => $metadata['description'] ?? null,
                'icon' => $metadata['icon'] ?? null,
                'tags' => json_encode($metadata['tags'] ?? []),
                'category' => $metadata['category'] ?? null,
                'visibility' => $metadata['visibility'] ?? 'public',
            ]);

            // Create initial version
            $formCount = count($packData['forms'] ?? []);
            $appCount = count($packData['apps'] ?? []);

            $vStmt = $this->mysql->prepare("
                INSERT INTO pack_versions (id, catalog_id, version, changelog, pack_data, form_count, app_count)
                VALUES (:id, :catalog_id, :version, :changelog, :pack_data, :form_count, :app_count)
            ");
            $vStmt->execute([
                'id' => $versionId,
                'catalog_id' => $catalogId,
                'version' => $version,
                'changelog' => $metadata['changelog'] ?? 'Initial release',
                'pack_data' => $packJson,
                'form_count' => $formCount,
                'app_count' => $appCount,
            ]);

            $this->mysql->commit();

            return [
                'catalogId' => $catalogId,
                'versionId' => $versionId,
                'slug' => $slug,
            ];
        } catch (\Exception $e) {
            $this->mysql->rollBack();
            throw $e;
        }
    }

    /**
     * Publish a new version to an existing pack.
     */
    public function publishVersion(string $catalogId, string $version, array $packData, ?string $changelog, string $userId): array
    {
        // Verify ownership
        $this->verifyOwnership($catalogId, $userId);

        $version = trim($version);
        if ($version === '') {
            throw new \RuntimeException('Version is required');
        }

        // Pre-check uniqueness so a duplicate version (the publish dialog
        // pre-fills the pack's existing version, so this is likely) surfaces as a
        // clean 400 instead of an opaque 500 from the UNIQUE-key violation.
        $dup = $this->mysql->prepare("SELECT id FROM pack_versions WHERE catalog_id = :catalog_id AND version = :version LIMIT 1");
        $dup->execute(['catalog_id' => $catalogId, 'version' => $version]);
        if ($dup->fetch()) {
            throw new \RuntimeException("Version {$version} already exists for this pack");
        }

        $packJson = $this->encodePackDataWithCap($packData);
        $versionId = $this->generateUuid();
        $formCount = count($packData['forms'] ?? []);
        $appCount = count($packData['apps'] ?? []);

        try {
            $stmt = $this->mysql->prepare("
                INSERT INTO pack_versions (id, catalog_id, version, changelog, pack_data, form_count, app_count)
                VALUES (:id, :catalog_id, :version, :changelog, :pack_data, :form_count, :app_count)
            ");
            $stmt->execute([
                'id' => $versionId,
                'catalog_id' => $catalogId,
                'version' => $version,
                'changelog' => $changelog,
                'pack_data' => $packJson,
                'form_count' => $formCount,
                'app_count' => $appCount,
            ]);
        } catch (\PDOException $e) {
            // Lost the race against a concurrent publish of the same version.
            if (str_contains($e->getMessage(), '1062') || str_contains($e->getMessage(), 'Duplicate entry')) {
                throw new \RuntimeException("Version {$version} already exists for this pack");
            }
            throw $e;
        }

        return ['versionId' => $versionId, 'version' => $version];
    }

    /**
     * JSON-encode pack data and reject it if it exceeds the maximum stored size,
     * so a single publish/version can't persist an unbounded blob (DoS / storage).
     */
    private function encodePackDataWithCap(array $packData): string
    {
        $json = json_encode($packData);
        if ($json === false) {
            throw new \RuntimeException('Invalid pack data');
        }
        if (strlen($json) > 5 * 1024 * 1024) {
            throw new \RuntimeException('Pack data exceeds the maximum allowed size (5MB)');
        }
        return $json;
    }

    /**
     * Update pack metadata (name, description, tags, icon, visibility).
     */
    public function updatePackMeta(string $catalogId, array $metadata, string $userId): void
    {
        $this->verifyOwnership($catalogId, $userId);

        $fields = [];
        $params = ['id' => $catalogId];

        foreach (['name', 'description', 'icon', 'category', 'visibility'] as $field) {
            if (array_key_exists($field, $metadata)) {
                $fields[] = "{$field} = :{$field}";
                $params[$field] = $metadata[$field];
            }
        }

        if (array_key_exists('tags', $metadata)) {
            $fields[] = "tags = :tags";
            $params['tags'] = json_encode($metadata['tags']);
        }

        if (empty($fields)) {
            return;
        }

        $sql = "UPDATE pack_catalog SET " . implode(', ', $fields) . " WHERE id = :id";
        $stmt = $this->mysql->prepare($sql);
        $stmt->execute($params);
    }

    /**
     * Archive (soft-delete) a pack.
     */
    public function archivePack(string $catalogId, string $userId): void
    {
        $this->verifyOwnership($catalogId, $userId);

        $stmt = $this->mysql->prepare("UPDATE pack_catalog SET status = 'archived' WHERE id = :id");
        $stmt->execute(['id' => $catalogId]);
    }

    /**
     * List packs published by the current user.
     */
    public function getMyPublishedPacks(string $userId): array
    {
        $stmt = $this->mysql->prepare("
            SELECT pc.*,
                   u.name AS publisher_name,
                   u.email AS publisher_email,
                   u.email AS publisher_email,
                   pv.version AS latest_version,
                   pv.form_count,
                   pv.app_count
            FROM pack_catalog pc
            JOIN users u ON u.id = pc.publisher_id
            LEFT JOIN pack_versions pv ON pv.id = (
                    SELECT pv2.id FROM pack_versions pv2 WHERE pv2.catalog_id = pc.id
                    ORDER BY pv2.created_at DESC, pv2.id DESC LIMIT 1
                )
            WHERE pc.publisher_id = :user_id AND pc.status != 'archived'
            ORDER BY pc.updated_at DESC
        ");
        $stmt->execute(['user_id' => $userId]);
        $rows = $stmt->fetchAll();

        return array_map(fn($row) => $this->formatPack($row), $rows);
    }

    /**
     * Atomically increment download counter.
     */
    public function incrementDownloadCount(string $catalogId): void
    {
        $stmt = $this->mysql->prepare("UPDATE pack_catalog SET download_count = download_count + 1 WHERE id = :id");
        $stmt->execute(['id' => $catalogId]);
    }

    /**
     * Get pack data for a specific version (for download/install).
     */
    public function getPackVersion(string $catalogId, ?string $versionId = null): ?array
    {
        if ($versionId) {
            $stmt = $this->mysql->prepare("SELECT * FROM pack_versions WHERE id = :id AND catalog_id = :catalog_id");
            $stmt->execute(['id' => $versionId, 'catalog_id' => $catalogId]);
        } else {
            // Latest version
            $stmt = $this->mysql->prepare("
                SELECT * FROM pack_versions WHERE catalog_id = :catalog_id ORDER BY created_at DESC LIMIT 1
            ");
            $stmt->execute(['catalog_id' => $catalogId]);
        }

        $row = $stmt->fetch();
        if (!$row) {
            return null;
        }

        $row['pack_data'] = json_decode($row['pack_data'], true);
        return $row;
    }

    /**
     * Get catalog ID by slug.
     */
    public function getCatalogBySlug(string $slug): ?array
    {
        $stmt = $this->mysql->prepare("SELECT * FROM pack_catalog WHERE slug = :slug AND status != 'archived'");
        $stmt->execute(['slug' => $slug]);
        return $stmt->fetch() ?: null;
    }

    /**
     * Check for updates: compare installed version against latest.
     */
    public function checkForUpdates(string $catalogId, string $installedVersion): ?array
    {
        $stmt = $this->mysql->prepare("
            SELECT id, version, changelog, created_at
            FROM pack_versions
            WHERE catalog_id = :catalog_id
            ORDER BY created_at DESC
            LIMIT 1
        ");
        $stmt->execute(['catalog_id' => $catalogId]);
        $latest = $stmt->fetch();

        if (!$latest || $latest['version'] === $installedVersion) {
            return null;
        }

        return [
            'versionId' => $latest['id'],
            'version' => $latest['version'],
            'changelog' => $latest['changelog'],
            'publishedAt' => $latest['created_at'],
        ];
    }

    /**
     * Seed the 6 official static packs into the catalog.
     */
    public function seedOfficialPacks(string $publisherId, array $packsData): int
    {
        $seeded = 0;

        foreach ($packsData as $entry) {
            $slug = $this->generateSlug($entry['name']);

            // Check if already seeded
            $stmt = $this->mysql->prepare("SELECT id FROM pack_catalog WHERE slug = :slug");
            $stmt->execute(['slug' => $slug]);
            if ($stmt->fetch()) {
                continue;
            }

            $this->publishPack($entry['pack'], $publisherId, [
                'name' => $entry['name'],
                'slug' => $slug,
                'description' => $entry['description'] ?? null,
                'icon' => $entry['icon'] ?? null,
                'tags' => $entry['tags'] ?? [],
                'category' => $entry['category'] ?? null,
                'visibility' => 'public',
                'version' => $entry['pack']['packMeta']['version'] ?? '1.0.0',
                'changelog' => 'Official pack',
            ]);

            // Mark as featured
            $stmt = $this->mysql->prepare("UPDATE pack_catalog SET featured = 1 WHERE slug = :slug");
            $stmt->execute(['slug' => $slug]);

            $seeded++;
        }

        return $seeded;
    }

    /**
     * Recalculate avg_rating and rating_count for a pack.
     */
    public function recalculateRating(string $catalogId): void
    {
        $stmt = $this->mysql->prepare("
            SELECT COUNT(*) AS cnt, COALESCE(AVG(rating), 0) AS avg
            FROM pack_ratings
            WHERE catalog_id = :catalog_id
        ");
        $stmt->execute(['catalog_id' => $catalogId]);
        $row = $stmt->fetch();

        $update = $this->mysql->prepare("
            UPDATE pack_catalog SET avg_rating = :avg, rating_count = :cnt WHERE id = :id
        ");
        $update->execute([
            'avg' => round((float)$row['avg'], 2),
            'cnt' => (int)$row['cnt'],
            'id' => $catalogId,
        ]);
    }

    // --- Private helpers ---

    private function verifyOwnership(string $catalogId, string $userId): void
    {
        $stmt = $this->mysql->prepare("SELECT publisher_id FROM pack_catalog WHERE id = :id");
        $stmt->execute(['id' => $catalogId]);
        $row = $stmt->fetch();

        if (!$row) {
            throw new \RuntimeException('Pack not found');
        }
        if ($row['publisher_id'] !== $userId) {
            throw new \RuntimeException('You do not own this pack');
        }
    }

    private function formatPack(array $row): array
    {
        return [
            'id' => $row['id'],
            'slug' => $row['slug'],
            'name' => $row['name'],
            'description' => $row['description'],
            'icon' => $row['icon'],
            'screenshot' => $row['screenshot'] ?? null,
            'screenshots' => json_decode($row['screenshots'] ?? '[]', true) ?: [],
            'tags' => json_decode($row['tags'] ?? '[]', true),
            'category' => $row['category'],
            'visibility' => $row['visibility'],
            'status' => $row['status'],
            'downloadCount' => (int)($row['download_count'] ?? 0),
            'avgRating' => (float)($row['avg_rating'] ?? 0),
            'ratingCount' => (int)($row['rating_count'] ?? 0),
            'featured' => (bool)($row['featured'] ?? false),
            'publisherId' => $row['publisher_id'],
            'publisherName' => $row['publisher_name'] ?? null,
            // Trust signal for the install prompt — computed server-side from the publisher's real
            // identity, NOT the spoofable display name. The email itself is not exposed to clients.
            'official' => (($row['publisher_email'] ?? null) === ($_ENV['OFFICIAL_EMAIL'] ?? 'official@formlogic.local')),
            'latestVersion' => $row['latest_version'] ?? null,
            'formCount' => (int)($row['form_count'] ?? 0),
            'appCount' => (int)($row['app_count'] ?? 0),
            'createdAt' => $row['created_at'],
            'updatedAt' => $row['updated_at'],
        ];
    }

    private function generateSlug(string $name): string
    {
        $slug = strtolower(trim($name));
        $slug = preg_replace('/[^a-z0-9\s-]/', '', $slug);
        $slug = preg_replace('/[\s-]+/', '-', $slug);
        return trim($slug, '-');
    }

    private function ensureUniqueSlug(string $slug): string
    {
        $original = $slug;
        $counter = 1;

        while (true) {
            $stmt = $this->mysql->prepare("SELECT COUNT(*) FROM pack_catalog WHERE slug = :slug");
            $stmt->execute(['slug' => $slug]);
            if ((int)$stmt->fetchColumn() === 0) {
                return $slug;
            }
            $slug = $original . '-' . (++$counter);
        }
    }

    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
