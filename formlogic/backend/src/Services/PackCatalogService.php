<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

class PackCatalogService
{
    /** Marketplace item types (spec §30). Only 'application_package' has a runtime install target today. */
    public const ITEM_TYPES = ['application_package', 'connector', 'theme', 'widget', 'quickjs_library', 'sdk_component', 'template'];
    public const TRUST_LEVELS = ['official', 'verified', 'community', 'private'];

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
            // Tags are searched too, not just filtered on. A package declares how it wants to be
            // found (v2 packages via package.keywords), and a keyword nobody can type into the
            // search box is decoration — the user would have to already know the tag exists and
            // then find the chip for it.
            $where[] = "(pc.name LIKE :searchName ESCAPE '!' OR pc.description LIKE :searchDesc ESCAPE '!' OR JSON_SEARCH(pc.tags, 'one', :searchTag, '!') IS NOT NULL)";
            $escaped = strtr($filters['search'], ['!' => '!!', '%' => '!%', '_' => '!_']);
            $params['searchName'] = '%' . $escaped . '%';
            $params['searchDesc'] = '%' . $escaped . '%';
            $params['searchTag'] = '%' . $escaped . '%';
        }

        if (!empty($filters['category'])) {
            $where[] = "pc.category = :category";
            $params['category'] = $filters['category'];
        }

        // Marketplace facets (spec §30): filter by artifact type + trust level. Values are validated
        // against the fixed enums so a bad query param is ignored rather than passed to SQL.
        if (!empty($filters['itemType']) && in_array($filters['itemType'], self::ITEM_TYPES, true)) {
            $where[] = "pc.item_type = :itemType";
            $params['itemType'] = $filters['itemType'];
        }
        if (!empty($filters['trustLevel']) && in_array($filters['trustLevel'], self::TRUST_LEVELS, true)) {
            $where[] = "pc.trust_level = :trustLevel";
            $params['trustLevel'] = $filters['trustLevel'];
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
                   pv.format_version,
                   pv.form_count,
                   pv.app_count,
                   pv.node_count
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

        // item_type: validated against the fixed enum; anything unknown falls back to the default.
        $itemType = (isset($metadata['itemType']) && in_array($metadata['itemType'], self::ITEM_TYPES, true))
            ? $metadata['itemType'] : 'application_package';
        $visibility = $metadata['visibility'] ?? 'public';
        // trust_level is derived SERVER-SIDE (never from client input): a private listing is 'private';
        // a listing published by the platform's official account is 'official'; everything else is
        // 'community'. NOTE: signature-backed 'verified' is deferred — the publish flow does not yet
        // submit a package signature; when it does, SigningService::verify() will upgrade this to
        // 'verified'/'official' (spec §30.1).
        $trustLevel = $this->deriveTrustLevel($userId, $visibility);

        $this->mysql->beginTransaction();
        try {
            // Create catalog entry
            $stmt = $this->mysql->prepare("
                INSERT INTO pack_catalog (id, slug, publisher_id, name, description, icon, tags, category, item_type, trust_level, visibility, status)
                VALUES (:id, :slug, :publisher_id, :name, :description, :icon, :tags, :category, :item_type, :trust_level, :visibility, 'published')
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
                'item_type' => $itemType,
                'trust_level' => $trustLevel,
                'visibility' => $visibility,
            ]);

            // Create initial version
            $counts = self::countsFor($packData);
            $formCount = $counts['forms'];
            $appCount = $counts['apps'];

            $vStmt = $this->mysql->prepare("
                INSERT INTO pack_versions (id, catalog_id, version, format_version, changelog, pack_data, form_count, app_count, node_count)
                VALUES (:id, :catalog_id, :version, :format_version, :changelog, :pack_data, :form_count, :app_count, :node_count)
            ");
            $vStmt->execute([
                'id' => $versionId,
                'catalog_id' => $catalogId,
                'version' => $version,
                'changelog' => $metadata['changelog'] ?? 'Initial release',
                'pack_data' => $packJson,
                'format_version' => $counts['formats'],
                'form_count' => $formCount,
                'app_count' => $appCount,
                'node_count' => $counts['nodes'],
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
        $counts = self::countsFor($packData);
        $formCount = $counts['forms'];
        $appCount = $counts['apps'];

        try {
            $stmt = $this->mysql->prepare("
                INSERT INTO pack_versions (id, catalog_id, version, format_version, changelog, pack_data, form_count, app_count, node_count)
                VALUES (:id, :catalog_id, :version, :format_version, :changelog, :pack_data, :form_count, :app_count, :node_count)
            ");
            $stmt->execute([
                'id' => $versionId,
                'catalog_id' => $catalogId,
                'version' => $version,
                'changelog' => $changelog,
                'pack_data' => $packJson,
                'format_version' => $counts['formats'],
                'form_count' => $formCount,
                'app_count' => $appCount,
                'node_count' => $counts['nodes'],
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
     * Synchronize an emitted pack into an existing catalog entry without ever
     * making a version row lie about the packMeta.version it contains.
     *
     * Same source version: refresh that latest row in place (useful for a
     * rebuilt/signature-refreshed artifact). Different source version: publish
     * a new immutable version row through the normal ownership/size gates.
     *
     * @return array{versionId:string,version:string,action:string}
     */
    public function syncPublishedPackVersion(
        string $catalogId,
        array $packData,
        string $userId,
        ?string $changelog = null
    ): array {
        $meta = is_array($packData['packMeta'] ?? null) ? $packData['packMeta'] : [];
        $sourceVersion = trim((string) ($meta['version'] ?? ''));
        if ($sourceVersion === '' || strlen($sourceVersion) > 50) {
            throw new \RuntimeException('packMeta.version is required (max 50 chars)');
        }
        $this->verifyOwnership($catalogId, $userId);
        $latest = $this->getPackVersion($catalogId);
        $exactStmt = $this->mysql->prepare(
            'SELECT * FROM pack_versions WHERE catalog_id = :catalog_id AND version = :version LIMIT 1'
        );
        $exactStmt->execute(['catalog_id' => $catalogId, 'version' => $sourceVersion]);
        $exact = $exactStmt->fetch() ?: null;
        // created_at has second precision. A just-published row can tie the
        // previous row, so getPackVersion() may return either one during this
        // process. An exact source-version row at the maximum timestamp is a
        // current row and is safe to refresh. An OLDER exact row means the
        // source is a downgrade; refuse rather than rewriting history.
        if ($exact !== null && $latest !== null
            && strcmp((string) $exact['created_at'], (string) $latest['created_at']) < 0) {
            throw new \RuntimeException('Source pack version is older than the current catalog version');
        }
        if ($exact !== null) {
            $latest = $exact;
        }
        if ($latest === null) {
            $published = $this->publishVersion($catalogId, $sourceVersion, $packData, $changelog, $userId);
            return $published + ['action' => 'published'];
        }
        if ((string) $latest['version'] !== $sourceVersion) {
            $published = $this->publishVersion($catalogId, $sourceVersion, $packData, $changelog, $userId);
            return $published + ['action' => 'published'];
        }

        $packJson = $this->encodePackDataWithCap($packData);
        $stmt = $this->mysql->prepare(
            'UPDATE pack_versions
                SET pack_data = :pack_data, form_count = :form_count, app_count = :app_count
              WHERE id = :id AND catalog_id = :catalog_id AND version = :version'
        );
        $stmt->execute([
            'pack_data' => $packJson,
            'form_count' => count($packData['forms'] ?? []),
            'app_count' => count($packData['apps'] ?? []),
            'id' => $latest['id'],
            'catalog_id' => $catalogId,
            'version' => $sourceVersion,
        ]);
        if ($stmt->rowCount() > 1) {
            throw new \RuntimeException('Catalog version refresh was ambiguous');
        }
        return [
            'versionId' => (string) $latest['id'],
            'version' => $sourceVersion,
            'action' => 'refreshed',
        ];
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
                'itemType' => $entry['itemType'] ?? null,
                'visibility' => 'public',
                // A v2 aggregate carries its version in package.version, a v1 pack in packMeta;
                // an explicit entry version wins over both so the loader can normalise.
                'version' => $entry['version'] ?? ($entry['pack']['packMeta']['version'] ?? '1.0.0'),
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

    /**
     * Server-derived trust level at publish time — NEVER from client input. A private listing is 'private';
     * a listing from the platform's official account is 'official'; otherwise 'community'. (Signature-backed
     * 'verified' is deferred until the publish flow submits a package signature — see publishPack().)
     */
    private function deriveTrustLevel(string $userId, string $visibility): string
    {
        if ($visibility === 'private') {
            return 'private';
        }
        $stmt = $this->mysql->prepare("SELECT email FROM users WHERE id = :id LIMIT 1");
        $stmt->execute(['id' => $userId]);
        $email = $stmt->fetchColumn();
        $officialEmail = $_ENV['OFFICIAL_EMAIL'] ?? 'official@formlogic.local';
        return (is_string($email) && $email === $officialEmail) ? 'official' : 'community';
    }

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

    /**
     * What IS this payload — a Pack v1, or an Application Package v2 aggregate?
     *
     * Read from the payload's own `formatVersion`, never inferred from its shape. The two
     * install through completely different lanes (v1 imports directly; v2 goes through
     * propose/confirm with a grant review), and guessing wrong would run the wrong one.
     */
    public static function formatVersionOf(array $packData): int
    {
        return ($packData['formatVersion'] ?? null) === 2 ? 2 : 1;
    }

    /**
     * Listing counts for a payload. A v1 pack is measured in forms and apps; a node-only
     * extension has neither, and rendering it as "0 forms · 0 apps" says nothing about what it
     * actually gives you — so it is measured in contributed nodes instead.
     *
     * @return array{formats:int,forms:int,apps:int,nodes:int}
     */
    private static function countsFor(array $packData): array
    {
        $format = self::formatVersionOf($packData);
        if ($format === 2) {
            $nodes = is_array($packData['contributions']['flowNodes'] ?? null)
                ? count($packData['contributions']['flowNodes'])
                : 0;
            // A v2 aggregate MAY also carry pack content (ADR-010 allows it); count what is there.
            $inner = is_array($packData['content']['pack'] ?? null) ? $packData['content']['pack'] : [];
            return [
                'formats' => 2,
                'forms' => count($inner['forms'] ?? []),
                'apps' => count($inner['apps'] ?? []),
                'nodes' => $nodes,
            ];
        }
        return [
            'formats' => 1,
            'forms' => count($packData['forms'] ?? []),
            'apps' => count($packData['apps'] ?? []),
            'nodes' => 0,
        ];
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
            // Marketplace artifact type + server-derived trust level (spec §30). Older rows created before
            // the columns existed decode to the enum defaults.
            'itemType' => $row['item_type'] ?? 'application_package',
            'trustLevel' => $row['trust_level'] ?? 'community',
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
            // Which lane installs this. The client routes on it rather than sniffing the
            // payload, and an older row with no column reads as 1 — which is what it is.
            'formatVersion' => (int)($row['format_version'] ?? 1),
            'formCount' => (int)($row['form_count'] ?? 0),
            'appCount' => (int)($row['app_count'] ?? 0),
            'nodeCount' => (int)($row['node_count'] ?? 0),
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
