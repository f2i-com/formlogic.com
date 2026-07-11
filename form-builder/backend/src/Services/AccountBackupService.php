<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use PDO;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

/**
 * Account backup / export / import (Settings → Backup & restore) + the admin
 * structure-only backup manifest.
 *
 * EXPORT: one zip per account — apps/forms/flows structure (backup.json, all
 * REAL ids), a consistent snapshot of every per-form SQLite database
 * (data/forms/<oldFormId>.sqlite, wal_checkpoint(FULL) + copy), and the
 * uploaded files (files/<oldFormId>/<storedFilename>). manifest.json indexes
 * every other entry with a sha256; unlisted entries are rejected on import.
 * Unsigned v1 by design: a backup only re-enters the importer's OWN account,
 * and the HS256 signing key wouldn't verify on a fresh server — which is the
 * disaster-recovery case this exists for.
 *
 * IMPORT (all-or-nothing): validates the archive, restores the structure in
 * ONE MySQL transaction as NEW resources (never overwrites — a re-import
 * creates copies), then injects the records with a backup-wide id remap
 * (new form ids everywhere; new response ids with linked_record answers
 * remapped through them), keeping every MySQL mirror consistent
 * (response_metadata via ResponseService::restoreResponses, response_links
 * via a post-pass, forms.response_count synced) so the Doctor's dual-store
 * checks stay clean. Any data-phase failure compensates by deleting every
 * created resource.
 *
 * ADMIN MANIFEST: structure + sqlite file PATHS (relative/absolute, sizes)
 * per form — never record contents. Admins have server access, so the path
 * list is what lets them match data up manually.
 */
final class AccountBackupService
{
    public const FORMAT_VERSION = 1;
    public const KIND = 'formlogic.accountBackup';

    /** Uploaded-file basenames inside the zip: uuid-ish stem + short extension. */
    private const SAFE_UPLOAD_NAME = '/^[A-Za-z0-9\-]+(\.[A-Za-z0-9]{1,16})?$/';

    private PDO $pdo;
    private LoggerInterface $logger;
    private array $config;

    public function __construct(
        MySQLConnection $mysql,
        private SQLiteConnection $sqlite,
        private FormService $formService,
        private AppService $appService,
        private AppUserService $appUserService,
        private FlowService $flowService,
        private ResponseService $responseService,
        array $backupConfig,
        private string $formsPath,
        private string $uploadsPath,
        private ?PlanService $planService = null,
        ?LoggerInterface $logger = null,
    ) {
        $this->pdo = $mysql->getConnection();
        $this->logger = $logger ?? new NullLogger();
        $this->config = $backupConfig + [
            'maxZipSize' => 200 * 1024 * 1024,
            'maxEntryBytes' => 256 * 1024 * 1024,
            'maxTotalUncompressed' => 1024 * 1024 * 1024,
            'maxResponsesPerForm' => 200000,
            'maxForms' => 500,
            'maxApps' => 100,
            'maxFlows' => 200,
            'maxBindings' => 400,
        ];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin manifest (structure + paths, NEVER record data)
    // ─────────────────────────────────────────────────────────────────────────

    /** @return array|null null when the user doesn't exist */
    public function adminBackupManifest(string $targetUserId): ?array
    {
        $stmt = $this->pdo->prepare('SELECT id, email, name, plan, created_at FROM users WHERE id = :id');
        $stmt->execute(['id' => $targetUserId]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$user) {
            return null;
        }

        $forms = [];
        $formsStmt = $this->pdo->prepare("
            SELECT f.id, f.title, f.status, f.created_at, f.updated_at, f.response_count,
                   (SELECT GROUP_CONCAT(a.name SEPARATOR ', ')
                      FROM app_forms af JOIN apps a ON a.id = af.app_id
                     WHERE af.form_id = f.id) AS app_names
            FROM forms f WHERE f.user_id = :id ORDER BY f.created_at ASC
        ");
        $formsStmt->execute(['id' => $targetUserId]);
        foreach ($formsStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            // Full structure (fields live in the per-form SQLite) — structure is
            // admin-visible; record contents never are.
            $full = $this->formService->getForm((string) $row['id']);

            $dbPath = $this->sqlite->getFormDbPath((string) $row['id']);
            $walPath = $dbPath . '-wal';
            $uploadsDir = $this->uploadsPath . '/' . $this->sanitizeId((string) $row['id']);
            [$fileCount, $totalBytes] = $this->uploadDirStats($uploadsDir);

            $forms[] = [
                'id' => $row['id'],
                'title' => $row['title'],
                'status' => $row['status'],
                'createdAt' => $row['created_at'],
                'updatedAt' => $row['updated_at'],
                'responseCount' => $row['response_count'] !== null ? (int) $row['response_count'] : null,
                'apps' => $row['app_names'],
                'fields' => $full['fields'] ?? [],
                'settings' => $full['settings'] ?? [],
                'sqlite' => [
                    'relativePath' => 'storage/forms/' . basename($dbPath),
                    'absolutePath' => (realpath($dbPath) ?: $dbPath),
                    'exists' => is_file($dbPath),
                    'sizeBytes' => is_file($dbPath) ? (int) filesize($dbPath) : 0,
                    'walExists' => is_file($walPath),
                    'walSizeBytes' => is_file($walPath) ? (int) filesize($walPath) : 0,
                ],
                'uploads' => [
                    'relativePath' => 'storage/uploads/' . $this->sanitizeId((string) $row['id']),
                    'exists' => is_dir($uploadsDir),
                    'fileCount' => $fileCount,
                    'totalBytes' => $totalBytes,
                ],
            ];
        }

        $apps = $this->pdo->prepare("
            SELECT a.id, a.name, a.slug, a.status, a.created_at,
                   (SELECT COUNT(*) FROM app_forms af WHERE af.app_id = a.id) AS form_count,
                   (SELECT COUNT(*) FROM flow_definitions fd WHERE fd.app_id = a.id) AS flow_count,
                   (SELECT COUNT(*) FROM app_users au WHERE au.app_id = a.id) AS member_count
            FROM apps a WHERE a.owner_id = :id ORDER BY a.created_at ASC
        ");
        $apps->execute(['id' => $targetUserId]);

        $flows = $this->pdo->prepare("
            SELECT fd.id, fd.app_id, fd.name, fd.slug, fd.enabled, fd.version, a.name AS app_name
            FROM flow_definitions fd LEFT JOIN apps a ON a.id = fd.app_id
            WHERE fd.owner_user_id = :id ORDER BY fd.created_at ASC
        ");
        $flows->execute(['id' => $targetUserId]);

        return [
            'kind' => 'formlogic.adminBackupManifest',
            'formatVersion' => 1,
            'generatedAt' => date('c'),
            'user' => [
                'id' => $user['id'],
                'email' => $user['email'],
                'name' => $user['name'],
                'plan' => $user['plan'],
                'createdAt' => $user['created_at'],
            ],
            'forms' => $forms,
            'apps' => array_map(static fn (array $a) => [
                'id' => $a['id'], 'name' => $a['name'], 'slug' => $a['slug'], 'status' => $a['status'],
                'createdAt' => $a['created_at'],
                'formCount' => (int) $a['form_count'], 'flowCount' => (int) $a['flow_count'],
                'memberCount' => (int) $a['member_count'],
            ], $apps->fetchAll(PDO::FETCH_ASSOC)),
            'flows' => array_map(static fn (array $f) => [
                'id' => $f['id'], 'appId' => $f['app_id'], 'appName' => $f['app_name'],
                'name' => $f['name'], 'slug' => $f['slug'],
                'enabled' => (bool) $f['enabled'], 'version' => (int) $f['version'],
            ], $flows->fetchAll(PDO::FETCH_ASSOC)),
            'note' => 'Structure and file paths only. Record data (SQLite contents, answers, uploaded files) is never included.',
        ];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Export
    // ─────────────────────────────────────────────────────────────────────────

    /** Build the full account backup. Returns the path to a temp zip the caller streams then unlinks. */
    public function exportAccount(string $userId): string
    {
        if (!class_exists(\ZipArchive::class)) {
            throw new \RuntimeException('The PHP zip extension is required for backups.');
        }
        @set_time_limit(600);
        $this->sweepTmp();

        $stagingDir = $this->tmpDir() . '/export-' . bin2hex(random_bytes(6));
        if (!mkdir($stagingDir, 0700, true)) {
            throw new \RuntimeException('Could not create the backup staging directory');
        }
        $zipPath = $this->tmpDir() . '/backup-' . bin2hex(random_bytes(6)) . '.zip';

        try {
            $structure = $this->buildStructure($userId);

            $zip = new \ZipArchive();
            if ($zip->open($zipPath, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) !== true) {
                throw new \RuntimeException('Could not create the backup archive');
            }

            $entries = [];
            $responseTotal = 0;
            $fileTotal = 0;

            // Per-form record databases: checkpoint then copy — the staged copy is
            // private + immutable, safe to hash and add by path (streamed at close()).
            foreach ($structure['forms'] as $bf) {
                $formId = (string) $bf['id'];
                if (!$this->sqlite->formDatabaseExists($formId)) {
                    continue;
                }
                try {
                    $this->sqlite->getFormDatabase($formId)->exec('PRAGMA wal_checkpoint(FULL)');
                } catch (\Exception $e) {
                    $this->logger->warning('Backup: WAL checkpoint failed (continuing with main file)', [
                        'formId' => $formId, 'error' => $e->getMessage(),
                    ]);
                }
                $staged = $stagingDir . '/' . $formId . '.sqlite';
                if (!copy($this->sqlite->getFormDbPath($formId), $staged)) {
                    throw new \RuntimeException("Could not snapshot the database for form {$formId}");
                }
                try {
                    $responseTotal += (int) (new PDO('sqlite:' . $staged))->query('SELECT COUNT(*) FROM responses')->fetchColumn();
                } catch (\Exception $e) {
                    // Count is informational; the snapshot itself is what matters.
                }
                $name = 'data/forms/' . $formId . '.sqlite';
                $entries[$name] = hash_file('sha256', $staged);
                $zip->addFile($staged, $name);

                // Uploaded files for this form (immutable once written; .pending is staging).
                foreach ($this->collectUploadFiles($formId) as $entryName => $absPath) {
                    $entries[$entryName] = hash_file('sha256', $absPath);
                    $zip->addFile($absPath, $entryName);
                    $fileTotal++;
                }
            }

            $backupJson = json_encode($structure, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
            if ($backupJson === false) {
                throw new \RuntimeException('Could not serialize the backup structure');
            }
            $entries['backup.json'] = hash('sha256', $backupJson);
            $zip->addFromString('backup.json', $backupJson);

            $manifest = [
                'formatVersion' => self::FORMAT_VERSION,
                'kind' => self::KIND,
                'createdAt' => date('c'),
                'counts' => [
                    'forms' => count($structure['forms']),
                    'apps' => count($structure['apps']),
                    'flows' => count($structure['flows']),
                    'bindings' => count($structure['appBindings']) + count($structure['formBindings']),
                    'responses' => $responseTotal,
                    'files' => $fileTotal,
                ],
                'entries' => $entries,
            ];
            $zip->addFromString('manifest.json', (string) json_encode($manifest, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT));

            if (!$zip->close()) {
                throw new \RuntimeException('Could not finalize the backup archive');
            }

            return $zipPath;
        } catch (\Throwable $e) {
            @unlink($zipPath);
            throw $e;
        } finally {
            $this->removeDir($stagingDir);
        }
    }

    /** The structure document (backup.json) — all REAL ids; they are the import's remap keys. */
    private function buildStructure(string $userId): array
    {
        $forms = [];
        for ($offset = 0; ; $offset += 500) {
            $page = $this->formService->getAllForms($userId, ['limit' => 500, 'offset' => $offset, 'includeFields' => true]);
            foreach ($page as $f) {
                $forms[] = [
                    'id' => $f['id'],
                    'title' => $f['title'],
                    'description' => $f['description'],
                    'status' => $f['status'],
                    'publishedAt' => $f['publishedAt'] ?? null,
                    'icon' => $f['icon'] ?? null,
                    'settings' => is_array($f['settings'] ?? null) ? $f['settings'] : [],
                    'theme' => is_array($f['theme'] ?? null) ? $f['theme'] : [],
                    'logicScript' => $f['logicScript'] ?? null,
                    'logicPrompt' => $f['logicPrompt'] ?? null,
                    'customScreen' => is_array($f['customScreen'] ?? null) ? $f['customScreen'] : null,
                    'customLogic' => is_array($f['customLogic'] ?? null) ? $f['customLogic'] : null,
                    'fields' => is_array($f['fields'] ?? null) ? $f['fields'] : [],
                ];
            }
            if (count($page) < 500) {
                break;
            }
        }

        $apps = [];
        $appBindings = [];
        $flows = [];
        $appIdsStmt = $this->pdo->prepare('SELECT id FROM apps WHERE owner_id = :o ORDER BY created_at ASC');
        $appIdsStmt->execute(['o' => $userId]);
        foreach ($appIdsStmt->fetchAll(PDO::FETCH_COLUMN) as $appId) {
            $app = $this->appService->getApp((string) $appId);
            if (!$app) {
                continue;
            }
            // defaultRoleId is instance-local — carry the role NAME instead (pack precedent).
            $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
            $defaultRoleName = null;

            $roles = [];
            foreach ($this->appUserService->getRoles((string) $appId) as $role) {
                if (($role['name'] ?? '') === 'Owner') {
                    continue; // recreated with all permissions on import
                }
                if (($settings['defaultRoleId'] ?? null) === ($role['id'] ?? '__none__')) {
                    $defaultRoleName = $role['name'];
                }
                $roles[] = [
                    'name' => $role['name'],
                    'description' => $role['description'] ?? null,
                    'system' => !empty($role['isSystem']),
                    'permissions' => array_map(static fn (array $p) => [
                        'formId' => $p['formId'],
                        'permission' => $p['permission'],
                    ], $role['permissions'] ?? []),
                ];
            }
            unset($settings['defaultRoleId']);
            if ($defaultRoleName !== null) {
                $settings['defaultRoleName'] = $defaultRoleName;
            }

            $apps[] = [
                'id' => $app['id'],
                'name' => $app['name'],
                'description' => $app['description'],
                'status' => $app['status'],
                'logoUrl' => $app['logoUrl'],
                'settings' => $settings,
                'theme' => is_array($app['theme'] ?? null) ? $app['theme'] : [],
                'navConfig' => is_array($app['navConfig'] ?? null) ? $app['navConfig'] : [],
                'customScreen' => is_array($app['customScreen'] ?? null) ? $app['customScreen'] : null,
                'customLogic' => is_array($app['customLogic'] ?? null) ? $app['customLogic'] : null,
                'reports' => is_array($app['reports'] ?? null) ? $app['reports'] : [],
                'forms' => array_map(static fn (array $af) => [
                    'formId' => $af['formId'],
                    'displayName' => $af['displayName'],
                    'sortOrder' => $af['sortOrder'],
                    'isVisible' => $af['isVisible'],
                    'settings' => is_array($af['settings'] ?? null) ? $af['settings'] : [],
                ], $this->appService->getAppForms((string) $appId)),
                'roles' => $roles,
            ];

            foreach ($this->flowService->listFlows((string) $appId) as $flow) {
                $flows[] = $this->serializeFlow($flow);
            }
            foreach ($this->flowService->listBindings((string) $appId) as $b) {
                $appBindings[] = $this->serializeBinding($b);
            }
        }

        foreach ($this->flowService->listWorkspaceFlows($userId) as $flow) {
            $flows[] = $this->serializeFlow($flow);
        }

        // Workspace (app_id NULL) bindings on standalone forms, with the flow slug joined in.
        $formBindings = [];
        $fbStmt = $this->pdo->prepare("
            SELECT b.*, fd.slug AS flow_slug
            FROM app_flow_bindings b
            JOIN flow_definitions fd ON fd.id = b.flow_definition_id
            WHERE b.app_id IS NULL AND fd.owner_user_id = :o AND fd.app_id IS NULL
            ORDER BY b.sort_order ASC
        ");
        $fbStmt->execute(['o' => $userId]);
        foreach ($fbStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $formBindings[] = [
                'formId' => $row['form_id'],
                'flow' => $row['flow_slug'],
                'event' => $row['event_name'],
                'mode' => $row['mode'],
                'condition' => $this->decodeJson($row['condition_json'] ?? null),
                'inputMap' => $this->decodeJson($row['input_map_json'] ?? null),
                'outputActions' => $this->decodeJson($row['output_actions_json'] ?? null),
                'timeoutMs' => (int) $row['timeout_ms'],
                'retryPolicy' => $this->decodeJson($row['retry_policy_json'] ?? null),
                'fallbackPolicy' => $this->decodeJson($row['fallback_policy_json'] ?? null),
                'enabled' => (bool) $row['enabled'],
                'sortOrder' => (int) $row['sort_order'],
            ];
        }

        $userStmt = $this->pdo->prepare('SELECT id, email FROM users WHERE id = :id');
        $userStmt->execute(['id' => $userId]);
        $u = $userStmt->fetch(PDO::FETCH_ASSOC) ?: ['id' => $userId, 'email' => ''];

        return [
            'user' => ['id' => $u['id'], 'email' => $u['email']], // informational; NEVER trusted on import
            'forms' => $forms,
            'apps' => $apps,
            'flows' => $flows,
            'appBindings' => $appBindings,
            'formBindings' => $formBindings,
            // Honesty list: what a backup deliberately does NOT carry.
            'excluded' => [
                'webhooks (signing secrets)', 'app members and invitations', 'custom domains',
                'API keys and MCP tokens', 'form version history', 'script logs', 'pack installation records',
            ],
        ];
    }

    private function serializeFlow(array $flow): array
    {
        return [
            'id' => $flow['id'],
            'appId' => $flow['appId'],
            'name' => $flow['name'],
            'slug' => $flow['slug'],
            'description' => $flow['description'],
            'flowJson' => $flow['flowJson'],
            'inputSchema' => $flow['inputSchema'],
            'outputSchema' => $flow['outputSchema'],
            'nodeCapabilities' => $flow['nodeCapabilities'],
            'enabled' => (bool) $flow['enabled'],
        ];
    }

    private function serializeBinding(array $b): array
    {
        return [
            'appId' => $b['appId'],
            'formId' => $b['formId'],
            'connectorId' => $b['connectorId'],
            'flow' => $b['flow'],
            'event' => $b['event'],
            'mode' => $b['mode'],
            'condition' => $b['condition'],
            'inputMap' => $b['inputMap'],
            'outputActions' => $b['outputActions'],
            'timeoutMs' => $b['timeoutMs'],
            'retryPolicy' => $b['retryPolicy'],
            'fallbackPolicy' => $b['fallbackPolicy'],
            'enabled' => (bool) $b['enabled'],
            'sortOrder' => (int) ($b['sortOrder'] ?? 0),
        ];
    }

    /** @return array<string,string> zip entry name => absolute path */
    private function collectUploadFiles(string $formId): array
    {
        $dir = $this->uploadsPath . '/' . $this->sanitizeId($formId);
        if (!is_dir($dir)) {
            return [];
        }
        $out = [];
        foreach (scandir($dir) ?: [] as $name) {
            if ($name === '.' || $name === '..' || $name === '.pending') {
                continue;
            }
            $abs = $dir . '/' . $name;
            if (!is_file($abs) || preg_match(self::SAFE_UPLOAD_NAME, $name) !== 1) {
                continue;
            }
            $out['files/' . $formId . '/' . $name] = $abs;
        }
        return $out;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Import
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Restore a backup zip into $userId's account as NEW resources (all-or-nothing).
     *
     * @return array{apps: array<int,array{id:string,name:string}>, forms: array<int,array{id:string,title:string}>,
     *               flows:int, bindings:int, responses:int, files:int, warnings:string[]}
     */
    public function importAccount(string $zipPath, string $userId): array
    {
        if (!class_exists(\ZipArchive::class)) {
            throw new \RuntimeException('The PHP zip extension is required for backups.');
        }
        @set_time_limit(600);
        $this->sweepTmp();

        $size = is_file($zipPath) ? filesize($zipPath) : false;
        if ($size === false || $size > (int) $this->config['maxZipSize']) {
            throw new \RuntimeException('Backup exceeds the maximum size of ' . round(((int) $this->config['maxZipSize']) / 1024 / 1024) . 'MB');
        }
        $finfo = new \finfo(FILEINFO_MIME_TYPE);
        $mime = $finfo->file($zipPath);
        if (!in_array($mime, ['application/zip', 'application/x-zip-compressed'], true)) {
            throw new \RuntimeException('Invalid file type. Only backup .zip files are accepted.');
        }

        $zip = new \ZipArchive();
        if ($zip->open($zipPath) !== true) {
            throw new \RuntimeException('Could not open the backup zip');
        }

        $stagingDir = $this->tmpDir() . '/import-' . bin2hex(random_bytes(6));
        if (!mkdir($stagingDir, 0700, true)) {
            $zip->close();
            throw new \RuntimeException('Could not create the import staging directory');
        }

        try {
            PackFileService::assertSafeArchive($zip, (int) $this->config['maxEntryBytes'], (int) $this->config['maxTotalUncompressed']);

            $manifest = $this->readManifest($zip);
            $this->verifyEntryHashesStreaming($zip, $manifest['entries']);

            $structure = json_decode($this->readEntryBounded($zip, 'backup.json', 64 * 1024 * 1024), true);
            if (!is_array($structure)) {
                throw new \RuntimeException('backup.json is not valid JSON');
            }
            $this->validateStructure($structure, $manifest['entries']);

            // Extract + validate every shipped sqlite BEFORE anything is created.
            $stagedDbs = []; // oldFormId => staged path
            foreach ($manifest['entries'] as $name => $sha) {
                if (!str_starts_with($name, 'data/forms/') || !str_ends_with($name, '.sqlite')) {
                    continue;
                }
                $oldFormId = basename($name, '.sqlite');
                $staged = $stagingDir . '/' . $oldFormId . '.sqlite';
                $this->extractEntryStreaming($zip, $name, $staged);
                $this->validateShippedSqlite($staged);
                $stagedDbs[$oldFormId] = $staged;
            }

            $formsInBackup = $structure['forms'];
            if ($this->planService !== null && !$this->planService->canCreateForms($userId, count($formsInBackup))) {
                throw new \RuntimeException('Restoring this backup would exceed your plan\'s form limit.');
            }

            $warnings = [];
            $created = ['apps' => [], 'forms' => [], 'workspaceFlows' => []];

            // ── Phase 1: structure, in ONE MySQL transaction ──
            $maps = $this->restoreStructure($structure, $userId, $created, $warnings);

            // ── Phase 2: records + files + links (compensate fully on failure) ──
            try {
                $summary = $this->restoreRecords($structure, $maps, $stagedDbs, $zip, $manifest['entries'], $warnings);
            } catch (\Throwable $e) {
                $this->compensate($created, $userId);
                throw new \RuntimeException('Backup import failed and was rolled back: ' . $e->getMessage(), 0, $e);
            }

            return [
                'apps' => $created['apps'],
                'forms' => $created['forms'],
                'flows' => $maps['flowsCreated'],
                'bindings' => $maps['bindingsCreated'],
                'responses' => $summary['responses'],
                'files' => $summary['files'],
                'warnings' => $warnings,
            ];
        } finally {
            $zip->close();
            $this->removeDir($stagingDir);
        }
    }

    /** @return array{formatVersion:int, entries: array<string,string>} */
    private function readManifest(\ZipArchive $zip): array
    {
        $raw = $this->readEntryBounded($zip, 'manifest.json', 1024 * 1024);
        $manifest = json_decode($raw, true);
        if (!is_array($manifest)) {
            throw new \RuntimeException('manifest.json is missing or invalid');
        }
        if ((int) ($manifest['formatVersion'] ?? 0) !== self::FORMAT_VERSION || ($manifest['kind'] ?? '') !== self::KIND) {
            throw new \RuntimeException('Not a FormLogic account backup (or an unsupported version)');
        }
        $entries = $manifest['entries'] ?? null;
        if (!is_array($entries) || $entries === [] || !isset($entries['backup.json'])) {
            throw new \RuntimeException('manifest.json has no entry index');
        }
        foreach ($entries as $name => $sha) {
            if (!is_string($name) || !PackFileService::isSafeZipEntryName($name) || !is_string($sha) || !preg_match('/^[a-f0-9]{64}$/', $sha)) {
                throw new \RuntimeException('manifest.json entry index is malformed');
            }
        }
        return ['formatVersion' => self::FORMAT_VERSION, 'entries' => $entries];
    }

    /** Streaming sha256 of every indexed entry + reject any archive entry that isn't indexed. */
    private function verifyEntryHashesStreaming(\ZipArchive $zip, array $entries): void
    {
        foreach ($entries as $name => $expected) {
            $stream = $zip->getStream($name);
            if ($stream === false) {
                throw new \RuntimeException("Backup entry missing from archive: {$name}");
            }
            $ctx = hash_init('sha256');
            while (!feof($stream)) {
                $chunk = fread($stream, 1024 * 1024);
                if ($chunk === false) {
                    fclose($stream);
                    throw new \RuntimeException("Could not read backup entry: {$name}");
                }
                hash_update($ctx, $chunk);
            }
            fclose($stream);
            if (!hash_equals($expected, hash_final($ctx))) {
                throw new \RuntimeException("Backup integrity failure: {$name} does not match its checksum");
            }
        }
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $name = (string) $zip->getNameIndex($i);
            if ($name === 'manifest.json' || str_ends_with($name, '/')) {
                continue; // the index itself / directory placeholders
            }
            if (!isset($entries[$name])) {
                throw new \RuntimeException("Backup contains an unlisted entry: {$name}");
            }
        }
    }

    private function validateStructure(array $structure, array $entries): void
    {
        foreach (['forms', 'apps', 'flows', 'appBindings', 'formBindings'] as $key) {
            if (!is_array($structure[$key] ?? null)) {
                throw new \RuntimeException("backup.json is missing '{$key}'");
            }
        }
        if (count($structure['forms']) > (int) $this->config['maxForms']) {
            throw new \RuntimeException('Backup exceeds the maximum of ' . $this->config['maxForms'] . ' forms');
        }
        if (count($structure['apps']) > (int) $this->config['maxApps']) {
            throw new \RuntimeException('Backup exceeds the maximum of ' . $this->config['maxApps'] . ' apps');
        }
        if (count($structure['flows']) > (int) $this->config['maxFlows']) {
            throw new \RuntimeException('Backup exceeds the maximum of ' . $this->config['maxFlows'] . ' flows');
        }
        if (count($structure['appBindings']) + count($structure['formBindings']) > (int) $this->config['maxBindings']) {
            throw new \RuntimeException('Backup exceeds the maximum of ' . $this->config['maxBindings'] . ' flow bindings');
        }

        $formIds = [];
        foreach ($structure['forms'] as $i => $f) {
            $id = $f['id'] ?? null;
            if (!is_string($id) || $id === '' || !is_string($f['title'] ?? null)) {
                throw new \RuntimeException("backup.json form #{$i} is malformed");
            }
            $formIds[$id] = true;
        }
        // Every data/files entry must correspond to a form in the structure, with a safe basename.
        foreach ($entries as $name => $sha) {
            if (str_starts_with($name, 'data/forms/')) {
                $oldId = basename($name, '.sqlite');
                if (!str_ends_with($name, '.sqlite') || !isset($formIds[$oldId]) || str_contains($oldId, '/')) {
                    throw new \RuntimeException("Backup data entry does not match a form in backup.json: {$name}");
                }
            } elseif (str_starts_with($name, 'files/')) {
                $parts = explode('/', $name);
                if (count($parts) !== 3 || !isset($formIds[$parts[1]]) || preg_match(self::SAFE_UPLOAD_NAME, $parts[2]) !== 1) {
                    throw new \RuntimeException("Backup file entry is malformed: {$name}");
                }
            } elseif ($name !== 'backup.json') {
                throw new \RuntimeException("Backup contains an unexpected entry: {$name}");
            }
        }
    }

    private function validateShippedSqlite(string $path): void
    {
        $src = $this->openSqliteReadOnly($path);
        $check = $src->query('PRAGMA quick_check')->fetchColumn();
        if ($check !== 'ok') {
            throw new \RuntimeException('A backup database failed its integrity check');
        }
        $tables = $src->query("SELECT name FROM sqlite_master WHERE type = 'table'")->fetchAll(PDO::FETCH_COLUMN);
        if (!in_array('responses', $tables, true)) {
            throw new \RuntimeException('A backup database has no responses table');
        }
        $count = (int) $src->query('SELECT COUNT(*) FROM responses')->fetchColumn();
        if ($count > (int) $this->config['maxResponsesPerForm']) {
            throw new \RuntimeException('A backup database exceeds the per-form response limit');
        }
    }

    /**
     * Structure phase: forms → apps (memberships/roles/reports) → flows → bindings,
     * inside ONE MySQL transaction (createForm/createApp respect the open tx).
     *
     * @return array{formIdMap: array<string,string>, flowSlugMap: array<string,string>, flowsCreated:int, bindingsCreated:int}
     */
    private function restoreStructure(array $structure, string $userId, array &$created, array &$warnings): array
    {
        $this->pdo->beginTransaction();
        try {
            $formIdMap = [];
            foreach ($structure['forms'] as $bf) {
                $formIdMap[(string) $bf['id']] = $this->generateUuid();
            }

            foreach ($structure['forms'] as $bf) {
                $newId = $formIdMap[(string) $bf['id']];
                $status = in_array($bf['status'] ?? 'draft', ['draft', 'published', 'archived'], true) ? $bf['status'] : 'draft';
                $this->formService->createForm([
                    'id' => $newId,
                    'userId' => $userId,
                    'title' => (string) $bf['title'],
                    'description' => is_string($bf['description'] ?? null) ? $bf['description'] : null,
                    'status' => $status,
                    'settings' => is_array($bf['settings'] ?? null) ? $bf['settings'] : [],
                    'theme' => is_array($bf['theme'] ?? null) ? $bf['theme'] : [],
                    'logicScript' => is_string($bf['logicScript'] ?? null) ? $bf['logicScript'] : null,
                    'logicPrompt' => is_string($bf['logicPrompt'] ?? null) ? $bf['logicPrompt'] : null,
                    'customScreen' => is_array($bf['customScreen'] ?? null) ? $this->deepRemapIds($bf['customScreen'], $formIdMap) : null,
                    'customLogic' => is_array($bf['customLogic'] ?? null) ? $bf['customLogic'] : null,
                    'icon' => is_string($bf['icon'] ?? null) ? $bf['icon'] : null,
                    'fields' => $this->remapFields(is_array($bf['fields'] ?? null) ? $bf['fields'] : [], $formIdMap, $warnings),
                ]);
                $created['forms'][] = ['id' => $newId, 'title' => (string) $bf['title']];
                // createForm's INSERT has no published_at column — restore it directly.
                if (!empty($bf['publishedAt']) && is_string($bf['publishedAt'])) {
                    $this->pdo->prepare('UPDATE forms SET published_at = :p, updated_at = updated_at WHERE id = :id')
                        ->execute(['p' => $bf['publishedAt'], 'id' => $newId]);
                }
            }

            foreach ($structure['apps'] as $ba) {
                $settings = is_array($ba['settings'] ?? null) ? $ba['settings'] : [];
                $defaultRoleName = is_string($settings['defaultRoleName'] ?? null) ? $settings['defaultRoleName'] : null;
                unset($settings['defaultRoleName'], $settings['defaultRoleId']);
                $settings = $this->deepRemapIds($settings, $formIdMap);

                $app = $this->appService->createApp([
                    'name' => (string) $ba['name'],
                    'description' => is_string($ba['description'] ?? null) ? $ba['description'] : null,
                    'logoUrl' => is_string($ba['logoUrl'] ?? null) ? $ba['logoUrl'] : null,
                    'settings' => $settings,
                    'theme' => is_array($ba['theme'] ?? null) ? $ba['theme'] : [],
                    'navConfig' => $this->deepRemapIds(is_array($ba['navConfig'] ?? null) ? $ba['navConfig'] : [], $formIdMap),
                    'customScreen' => is_array($ba['customScreen'] ?? null) ? $this->deepRemapIds($ba['customScreen'], $formIdMap) : null,
                    'customLogic' => is_array($ba['customLogic'] ?? null) ? $ba['customLogic'] : null,
                ], $userId);
                $newAppId = (string) $app['id'];
                $created['apps'][] = ['id' => $newAppId, 'name' => (string) $ba['name']];

                $memberForms = is_array($ba['forms'] ?? null) ? $ba['forms'] : [];
                usort($memberForms, static fn ($a, $b) => ($a['sortOrder'] ?? 0) <=> ($b['sortOrder'] ?? 0));
                foreach ($memberForms as $af) {
                    $newFormId = $formIdMap[(string) ($af['formId'] ?? '')] ?? null;
                    if ($newFormId === null) {
                        $warnings[] = "App '{$ba['name']}' referenced a form that isn't in the backup — membership skipped.";
                        continue;
                    }
                    $this->appService->addFormToApp($newAppId, $newFormId, is_string($af['displayName'] ?? null) ? $af['displayName'] : null);
                    $this->appService->updateAppForm($newAppId, $newFormId, [
                        'isVisible' => (bool) ($af['isVisible'] ?? true),
                        // af.settings round-trips verbatim (it may carry packFormId machine keys).
                        'settings' => is_array($af['settings'] ?? null) ? $af['settings'] : [],
                    ]);
                }

                // Roles: system roles (Admin/Member) get permission overlays on the ones
                // createApp made; custom roles are recreated. Owner is never in a backup.
                $sysRolesByName = null;
                foreach (is_array($ba['roles'] ?? null) ? $ba['roles'] : [] as $br) {
                    $permissions = [];
                    foreach (is_array($br['permissions'] ?? null) ? $br['permissions'] : [] as $perm) {
                        $pf = $perm['formId'] ?? null;
                        if ($pf !== null) {
                            $mapped = $formIdMap[(string) $pf] ?? null;
                            if ($mapped === null) {
                                continue; // permission on a form outside the backup
                            }
                            $permissions[] = ['formId' => $mapped, 'permission' => $perm['permission']];
                        } else {
                            $permissions[] = ['formId' => null, 'permission' => $perm['permission']];
                        }
                    }
                    if (!empty($br['system'])) {
                        if ($sysRolesByName === null) {
                            $sysRolesByName = [];
                            foreach ($this->appUserService->getRoles($newAppId) as $sr) {
                                if (!empty($sr['isSystem'])) {
                                    $sysRolesByName[$sr['name']] = $sr;
                                }
                            }
                        }
                        $target = $sysRolesByName[$br['name'] ?? ''] ?? null;
                        if ($target && ($target['name'] ?? '') !== 'Owner' && !empty($permissions)) {
                            $this->appUserService->setRolePermissions($target['id'], $permissions, true);
                            $this->appUserService->setConnectorGrants($target['id'], $permissions, true);
                        }
                        continue;
                    }
                    $role = $this->appUserService->createRole($newAppId, [
                        'name' => (string) ($br['name'] ?? 'Role'),
                        'description' => is_string($br['description'] ?? null) ? $br['description'] : null,
                    ]);
                    if (!empty($permissions)) {
                        $this->appUserService->setRolePermissions($role['id'], $permissions, true);
                        $this->appUserService->setConnectorGrants($role['id'], $permissions, true);
                    }
                }

                if ($defaultRoleName !== null && $defaultRoleName !== '') {
                    foreach ($this->appUserService->getRoles($newAppId) as $rn) {
                        if (($rn['name'] ?? null) === $defaultRoleName) {
                            $settings['defaultRoleId'] = $rn['id'];
                            $this->appService->updateApp($newAppId, ['settings' => $settings]);
                            break;
                        }
                    }
                }

                if (!empty($ba['reports']) && is_array($ba['reports'])) {
                    $this->appService->updateApp($newAppId, ['reports' => $this->deepRemapIds($ba['reports'], $formIdMap)]);
                }
                if (($ba['status'] ?? null) === 'published') {
                    $this->appService->updateApp($newAppId, ['status' => 'published']);
                }

                // Remember the app id mapping for flows/bindings.
                $appIdMap[(string) $ba['id']] = $newAppId;
            }
            $appIdMap ??= [];

            // Flows: app flows into their new apps; workspace flows with slug dedupe
            // (assertWorkspaceSlugFree throws on a duplicate — a re-import must not fail).
            $flowsCreated = 0;
            $flowSlugMap = [];
            $existingWs = array_map(static fn (array $f) => $f['slug'], $this->flowService->listWorkspaceFlows($userId));
            foreach ($structure['flows'] as $bfl) {
                $data = [
                    'name' => (string) ($bfl['name'] ?? ($bfl['slug'] ?? 'Flow')),
                    'slug' => $bfl['slug'] ?? null,
                    'description' => is_string($bfl['description'] ?? null) ? $bfl['description'] : null,
                    'flowJson' => $this->deepRemapIds(is_array($bfl['flowJson'] ?? null) ? $bfl['flowJson'] : ['nodes' => [], 'edges' => []], $formIdMap),
                    'inputSchema' => is_array($bfl['inputSchema'] ?? null) ? $bfl['inputSchema'] : null,
                    'outputSchema' => is_array($bfl['outputSchema'] ?? null) ? $bfl['outputSchema'] : null,
                    'nodeCapabilities' => is_array($bfl['nodeCapabilities'] ?? null) ? $bfl['nodeCapabilities'] : null,
                    'enabled' => (bool) ($bfl['enabled'] ?? true),
                ];
                $oldAppId = $bfl['appId'] ?? null;
                if ($oldAppId !== null) {
                    $newAppId = $appIdMap[(string) $oldAppId] ?? null;
                    if ($newAppId === null) {
                        $warnings[] = "Flow '{$data['name']}' referenced an app that isn't in the backup — skipped.";
                        continue;
                    }
                    $this->flowService->createFlow($newAppId, $userId, $data);
                } else {
                    $slug = FlowService::sanitizeSlug($data['slug'] ?? $data['name']);
                    $final = $slug;
                    for ($n = 2; in_array($final, $existingWs, true); $n++) {
                        $final = FlowService::sanitizeSlug($slug . '-' . $n);
                    }
                    $existingWs[] = $final;
                    $flowSlugMap[$slug] = $final;
                    $data['slug'] = $final;
                    $wf = $this->flowService->createWorkspaceFlow($userId, $data);
                    $created['workspaceFlows'][] = (string) $wf['id'];
                }
                $flowsCreated++;
            }

            $bindingsCreated = 0;
            foreach ($structure['appBindings'] as $bb) {
                $newAppId = $appIdMap[(string) ($bb['appId'] ?? '')] ?? null;
                if ($newAppId === null) {
                    $warnings[] = 'A flow binding referenced an app that isn\'t in the backup — skipped.';
                    continue;
                }
                $data = $this->bindingData($bb, $formIdMap, $warnings);
                $this->flowService->createBinding($newAppId, $data);
                $bindingsCreated++;
            }
            foreach ($structure['formBindings'] as $bb) {
                $newFormId = $formIdMap[(string) ($bb['formId'] ?? '')] ?? null;
                if ($newFormId === null) {
                    $warnings[] = 'A form flow binding referenced a form that isn\'t in the backup — skipped.';
                    continue;
                }
                $data = $this->bindingData($bb, $formIdMap, $warnings);
                // The workspace flow may have been renamed by the slug dedupe above.
                $data['flow'] = $flowSlugMap[(string) ($bb['flow'] ?? '')] ?? $bb['flow'];
                $this->flowService->createFormBinding($userId, $newFormId, $data);
                $bindingsCreated++;
            }

            $this->pdo->commit();
            return [
                'formIdMap' => $formIdMap,
                'flowSlugMap' => $flowSlugMap,
                'flowsCreated' => $flowsCreated,
                'bindingsCreated' => $bindingsCreated,
            ];
        } catch (\Throwable $e) {
            $this->pdo->rollBack();
            // MySQL rolled back, but createForm made per-form SQLite files — clean them.
            foreach ($created['forms'] as $f) {
                try {
                    $this->formService->deleteForm($f['id']);
                } catch (\Throwable $cleanupError) {
                    // best-effort
                }
            }
            $created = ['apps' => [], 'forms' => [], 'workspaceFlows' => []];
            throw $e instanceof \RuntimeException || $e instanceof \InvalidArgumentException
                ? new \RuntimeException('Backup import failed: ' . $e->getMessage(), 0, $e)
                : $e;
        }
    }

    /** Common binding payload for createBinding/createFormBinding. */
    private function bindingData(array $bb, array $formIdMap, array &$warnings): array
    {
        $formId = null;
        $oldFormId = $bb['formId'] ?? null;
        if (is_string($oldFormId) && $oldFormId !== '') {
            $formId = $formIdMap[$oldFormId] ?? null;
            if ($formId === null) {
                $warnings[] = 'A flow binding was scoped to a form outside the backup — the scope was cleared.';
            }
        }
        return [
            'flow' => $bb['flow'] ?? null,
            'event' => $bb['event'] ?? null,
            'mode' => $bb['mode'] ?? null,
            'formId' => $formId,
            'connectorId' => $bb['connectorId'] ?? null,
            'condition' => $bb['condition'] ?? null,
            'inputMap' => $bb['inputMap'] ?? null,
            'outputActions' => is_array($bb['outputActions'] ?? null) ? $this->deepRemapIds($bb['outputActions'], $formIdMap) : null,
            'timeoutMs' => $bb['timeoutMs'] ?? null,
            'retryPolicy' => $bb['retryPolicy'] ?? null,
            'fallbackPolicy' => $bb['fallbackPolicy'] ?? null,
            'enabled' => (bool) ($bb['enabled'] ?? true),
            'sortOrder' => (int) ($bb['sortOrder'] ?? 0),
        ];
    }

    /**
     * Data phase: per form — remap linked answers through the backup-wide response-id
     * map, normalize (rewrites file urls to the new form id), restore in chunks; then
     * files; then the response_links pass (targets exist by then).
     *
     * @param array{formIdMap: array<string,string>} $maps
     * @return array{responses:int, files:int}
     */
    private function restoreRecords(array $structure, array $maps, array $stagedDbs, \ZipArchive $zip, array $entries, array &$warnings): array
    {
        $formIdMap = $maps['formIdMap'];

        // Old field defs per form (they carry the OLD linked-record targets that
        // drive the answer remap) + new (remapped) fields for normalize/links.
        $oldFieldsByForm = [];
        foreach ($structure['forms'] as $bf) {
            $oldFieldsByForm[(string) $bf['id']] = is_array($bf['fields'] ?? null) ? $bf['fields'] : [];
        }

        // Pre-generate every response id (ids only — memory is 2 uuids per row).
        $responseIdMap = [];
        foreach ($stagedDbs as $oldFormId => $path) {
            $src = $this->openSqliteReadOnly($path);
            $responseIdMap[$oldFormId] = [];
            foreach ($src->query('SELECT id FROM responses')->fetchAll(PDO::FETCH_COLUMN) as $oldId) {
                $responseIdMap[$oldFormId][(string) $oldId] = $this->generateUuid();
            }
            unset($src);
        }

        $responsesRestored = 0;
        $expectedLinks = [];
        foreach ($stagedDbs as $oldFormId => $path) {
            $newFormId = $formIdMap[$oldFormId];
            $newFields = $this->formService->getForm($newFormId)['fields'] ?? [];

            // fieldId => old target form id, for the forms that link records.
            $linkedTargets = [];
            foreach ($oldFieldsByForm[$oldFormId] as $field) {
                if (($field['type'] ?? '') === 'linked_record' && is_string($field['properties']['targetFormId'] ?? null)) {
                    $linkedTargets[(string) $field['id']] = $field['properties']['targetFormId'];
                }
            }

            $src = $this->openSqliteReadOnly($path);
            $hasComputed = $this->sqliteHasTable($src, 'computed');
            $hasTags = $this->sqliteHasTable($src, 'tags');
            $expectedLinks[$newFormId] = 0;

            for ($offset = 0; ; $offset += 500) {
                $rows = $src->query("SELECT id, answers, metadata, status, submitted_at, updated_at FROM responses ORDER BY rowid LIMIT 500 OFFSET {$offset}")
                    ->fetchAll(PDO::FETCH_ASSOC);
                if ($rows === []) {
                    break;
                }
                $oldIds = array_column($rows, 'id');
                $computedByResp = $hasComputed ? $this->childRows($src, 'computed', $oldIds, ['field_name', 'field_value', 'created_at']) : [];
                $tagsByResp = $hasTags ? $this->childRows($src, 'tags', $oldIds, ['tag', 'created_at']) : [];

                $chunk = [];
                foreach ($rows as $row) {
                    $oldId = (string) $row['id'];
                    $answers = json_decode((string) $row['answers'], true);
                    $answers = is_array($answers) ? $answers : [];

                    // Remap linked_record answers old→new response ids; values that
                    // don't map (dangling at export time) are dropped — they'd be
                    // stale foreign UUIDs in the fresh workspace.
                    foreach ($linkedTargets as $fieldId => $oldTarget) {
                        if (!isset($formIdMap[$oldTarget]) || !array_key_exists($fieldId, $answers)) {
                            continue; // target outside the backup → values left inert
                        }
                        $targetMap = $responseIdMap[$oldTarget] ?? [];
                        $value = $answers[$fieldId];
                        if (is_array($value)) {
                            $mapped = [];
                            foreach ($value as $v) {
                                if (is_string($v) && isset($targetMap[$v])) {
                                    $mapped[] = $targetMap[$v];
                                }
                            }
                            $answers[$fieldId] = $mapped;
                            $expectedLinks[$newFormId] += count($mapped);
                        } elseif (is_string($value)) {
                            $answers[$fieldId] = isset($targetMap[$value]) ? $targetMap[$value] : null;
                            if ($answers[$fieldId] !== null) {
                                $expectedLinks[$newFormId]++;
                            }
                        }
                    }

                    // Re-derives file urls for the NEW form id (same normalize every write path uses).
                    $answers = $this->responseService->normalizeAnswers($newFields, $answers, $newFormId);

                    $metadata = json_decode((string) ($row['metadata'] ?? '{}'), true);
                    $chunk[] = [
                        'id' => $responseIdMap[$oldFormId][$oldId],
                        'answers' => $answers,
                        // metadata (incl. submittedByUserId) is preserved verbatim: ids
                        // of members who don't exist here simply never match a scope
                        // filter, and same-account re-imports keep working.
                        'metadata' => is_array($metadata) ? $metadata : [],
                        'status' => (string) $row['status'],
                        'submittedAt' => (string) $row['submitted_at'],
                        'updatedAt' => (string) ($row['updated_at'] ?? $row['submitted_at']),
                        'computed' => array_map(static fn (array $c) => [
                            'name' => (string) $c['field_name'],
                            'rawValue' => (string) $c['field_value'],
                            'createdAt' => $c['created_at'] ?? null,
                        ], $computedByResp[$oldId] ?? []),
                        'tags' => array_map(static fn (array $t) => [
                            'tag' => (string) $t['tag'],
                            'createdAt' => $t['created_at'] ?? null,
                        ], $tagsByResp[$oldId] ?? []),
                    ];
                }
                $responsesRestored += $this->responseService->restoreResponses($newFormId, $chunk);
            }
            unset($src);
        }

        // Uploaded files → storage/uploads/<new form id>/ (stored names preserved;
        // answers already point at them via the normalize url rewrite).
        $filesRestored = 0;
        foreach ($entries as $name => $sha) {
            if (!str_starts_with($name, 'files/')) {
                continue;
            }
            [, $oldFormId, $basename] = explode('/', $name, 3);
            $newFormId = $formIdMap[$oldFormId] ?? null;
            if ($newFormId === null) {
                continue; // validateStructure guarantees this can't happen; belt and braces
            }
            $dir = $this->uploadsPath . '/' . $this->sanitizeId($newFormId);
            if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) {
                throw new \RuntimeException('Could not create the uploads directory for a restored form');
            }
            $this->extractEntryStreaming($zip, $name, $dir . '/' . $basename);
            $filesRestored++;
        }

        // Links pass: every target row exists now, so response_links rebuilds fully.
        foreach ($stagedDbs as $oldFormId => $path) {
            $newFormId = $formIdMap[$oldFormId];
            $form = $this->formService->getForm($newFormId);
            $newFields = $form['fields'] ?? [];
            $hasLinks = false;
            foreach ($newFields as $field) {
                if (($field['type'] ?? '') === 'linked_record') {
                    $hasLinks = true;
                    break;
                }
            }
            if (!$hasLinks) {
                continue;
            }
            $db = $this->sqlite->getFormDatabase($newFormId);
            for ($offset = 0; ; $offset += 500) {
                $rows = $db->query("SELECT id, answers FROM responses ORDER BY rowid LIMIT 500 OFFSET {$offset}")->fetchAll(PDO::FETCH_ASSOC);
                if ($rows === []) {
                    break;
                }
                foreach ($rows as $row) {
                    $answers = json_decode((string) $row['answers'], true);
                    $this->responseService->syncResponseLinks($newFormId, (string) $row['id'], $newFields, is_array($answers) ? $answers : []);
                }
            }
            $expected = $expectedLinks[$newFormId] ?? 0;
            if ($expected > 0) {
                $countStmt = $this->pdo->prepare('SELECT COUNT(*) FROM response_links WHERE source_form_id = :f');
                $countStmt->execute(['f' => $newFormId]);
                $actual = (int) $countStmt->fetchColumn();
                if ($actual < $expected) {
                    $warnings[] = "Restored form '" . ($form['title'] ?? $newFormId) . "': {$actual} of {$expected} record links could be rebuilt.";
                }
            }
        }

        return ['responses' => $responsesRestored, 'files' => $filesRestored];
    }

    /** Full compensation after a data-phase failure: delete everything this import created. */
    private function compensate(array $created, string $userId): void
    {
        foreach ($created['apps'] as $app) {
            try {
                $this->appService->deleteApp($app['id']);
            } catch (\Throwable $e) {
                $this->logger->warning('Backup import compensation: could not delete app', ['appId' => $app['id'], 'error' => $e->getMessage()]);
            }
        }
        foreach ($created['forms'] as $form) {
            try {
                // deleteForm cleans the sqlite db, uploads, response_metadata and
                // response_links; a failure leaves a durable store_ops record the
                // Doctor surfaces — log and continue, never mask the original error.
                $this->formService->deleteForm($form['id']);
            } catch (\Throwable $e) {
                $this->logger->warning('Backup import compensation: could not delete form', ['formId' => $form['id'], 'error' => $e->getMessage()]);
            }
        }
        foreach ($created['workspaceFlows'] as $flowId) {
            try {
                $this->flowService->deleteWorkspaceFlow($userId, $flowId);
            } catch (\Throwable $e) {
                $this->logger->warning('Backup import compensation: could not delete workspace flow', ['flowId' => $flowId, 'error' => $e->getMessage()]);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Remap helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Deep remap of form-id references inside arbitrary JSON structure (navConfig,
     * report specs, dashboard widgets, flowJson node data, app settings): any string
     * equal to an old form id becomes the new id, and "oldId::field" refs are
     * rewritten too. Form ids are UUIDs, so a blind string match is unambiguous.
     * Unmapped ids stay as-is (inert references to nothing — same as before export).
     */
    private function deepRemapIds(mixed $value, array $formIdMap): mixed
    {
        if (is_string($value)) {
            if (isset($formIdMap[$value])) {
                return $formIdMap[$value];
            }
            if (str_contains($value, '::')) {
                [$head, $rest] = explode('::', $value, 2);
                if (isset($formIdMap[$head])) {
                    return $formIdMap[$head] . '::' . $rest;
                }
            }
            return $value;
        }
        if (is_array($value)) {
            foreach ($value as $k => $v) {
                $value[$k] = $this->deepRemapIds($v, $formIdMap);
            }
            return $value;
        }
        return $value;
    }

    /** linked_record fields: remap targetFormId; a target outside the backup is unset (broken otherwise). */
    private function remapFields(array $fields, array $formIdMap, array &$warnings): array
    {
        foreach ($fields as &$field) {
            if (($field['type'] ?? '') === 'linked_record') {
                $target = $field['properties']['targetFormId'] ?? null;
                if (is_string($target) && $target !== '') {
                    if (isset($formIdMap[$target])) {
                        $field['properties']['targetFormId'] = $formIdMap[$target];
                    } else {
                        unset($field['properties']['targetFormId']);
                        $warnings[] = "Linked-record field '" . ($field['id'] ?? '?') . "' targeted a form outside the backup — the link target was cleared.";
                    }
                }
            }
        }
        unset($field);
        return $fields;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Small utilities
    // ─────────────────────────────────────────────────────────────────────────

    private function tmpDir(): string
    {
        $dir = dirname(__DIR__, 2) . '/storage/backups/tmp';
        if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) {
            throw new \RuntimeException('Could not create storage/backups/tmp');
        }
        return $dir;
    }

    /** Age-based sweep (>2h) — Windows can refuse unlinks while a stream handle lingers. */
    private function sweepTmp(): void
    {
        try {
            $cutoff = time() - 2 * 3600;
            foreach (glob($this->tmpDir() . '/*') ?: [] as $path) {
                if (@filemtime($path) < $cutoff) {
                    is_dir($path) ? $this->removeDir($path) : @unlink($path);
                }
            }
        } catch (\Throwable $e) {
            // sweep is best-effort
        }
    }

    private function removeDir(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        foreach (scandir($dir) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $path = $dir . '/' . $entry;
            is_dir($path) ? $this->removeDir($path) : @unlink($path);
        }
        @rmdir($dir);
    }

    private function readEntryBounded(\ZipArchive $zip, string $name, int $maxBytes): string
    {
        $stream = $zip->getStream($name);
        if ($stream === false) {
            throw new \RuntimeException("Backup is missing {$name}");
        }
        $data = stream_get_contents($stream, $maxBytes + 1);
        fclose($stream);
        if ($data === false || strlen($data) > $maxBytes) {
            throw new \RuntimeException("Backup entry {$name} is too large");
        }
        return $data;
    }

    private function extractEntryStreaming(\ZipArchive $zip, string $name, string $dest): void
    {
        $in = $zip->getStream($name);
        if ($in === false) {
            throw new \RuntimeException("Backup is missing {$name}");
        }
        $out = fopen($dest, 'wb');
        if ($out === false) {
            fclose($in);
            throw new \RuntimeException("Could not write {$dest}");
        }
        stream_copy_to_stream($in, $out);
        fclose($in);
        fclose($out);
    }

    private function openSqliteReadOnly(string $path): PDO
    {
        $options = [];
        if (defined('PDO::SQLITE_ATTR_OPEN_FLAGS') && defined('PDO::SQLITE_OPEN_READONLY')) {
            $options[\PDO::SQLITE_ATTR_OPEN_FLAGS] = \PDO::SQLITE_OPEN_READONLY;
        }
        $pdo = new PDO('sqlite:' . $path, null, null, $options);
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        if ($options === []) {
            $pdo->exec('PRAGMA query_only = 1');
        }
        return $pdo;
    }

    private function sqliteHasTable(PDO $db, string $table): bool
    {
        $stmt = $db->prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = :n");
        $stmt->execute(['n' => $table]);
        return $stmt->fetchColumn() !== false;
    }

    /** @return array<string, array<int, array<string,mixed>>> response_id => child rows */
    private function childRows(PDO $db, string $table, array $responseIds, array $columns): array
    {
        if ($responseIds === []) {
            return [];
        }
        $placeholders = implode(',', array_fill(0, count($responseIds), '?'));
        $cols = implode(', ', array_map(static fn (string $c) => '"' . $c . '"', $columns));
        $stmt = $db->prepare("SELECT response_id, {$cols} FROM \"{$table}\" WHERE response_id IN ({$placeholders})");
        $stmt->execute($responseIds);
        $out = [];
        while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
            $out[(string) $row['response_id']][] = $row;
        }
        return $out;
    }

    /** @return array{0:int,1:int} [fileCount, totalBytes] */
    private function uploadDirStats(string $dir): array
    {
        if (!is_dir($dir)) {
            return [0, 0];
        }
        $count = 0;
        $bytes = 0;
        foreach (scandir($dir) ?: [] as $name) {
            if ($name === '.' || $name === '..' || $name === '.pending') {
                continue;
            }
            $abs = $dir . '/' . $name;
            if (is_file($abs)) {
                $count++;
                $bytes += (int) filesize($abs);
            }
        }
        return [$count, $bytes];
    }

    /** Mirrors FileStorageService::sanitizeId — the uploads dir name for a form. */
    private function sanitizeId(string $id): string
    {
        return (string) preg_replace('/[^a-zA-Z0-9\-]/', '', $id);
    }

    private function decodeJson(?string $json): mixed
    {
        if ($json === null || $json === '') {
            return null;
        }
        $decoded = json_decode($json, true);
        return $decoded;
    }

    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
