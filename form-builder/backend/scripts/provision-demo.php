<?php

/**
 * Provision the public "Demo" experience + marketplace catalog. Idempotent — safe to re-run.
 *
 * 1. Ensures an "official" publisher account and the shared "Demo" account.
 * 2. Seeds every marketplace pack (emitted from src/data/packs → resources/marketplace-packs) AND
 *    the bundled sample apps (resources/sample-apps) into the catalog (pack_catalog), published +
 *    public + featured, under the official publisher.
 * 3. Installs each catalog pack into the Demo account, publishes its apps, and seeds realistic
 *    demo responses so the dashboards are populated when a visitor tries the live demo.
 *
 * Usage (from backend/):  php scripts/provision-demo.php
 */

declare(strict_types=1);

require __DIR__ . '/../vendor/autoload.php';
Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\FormService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\PackService;
use FormLogic\Services\PackCatalogService;
use FormLogic\Services\ResponseService;

$conf = [
    'host' => $_ENV['DB_HOST'] ?? 'localhost',
    'port' => $_ENV['DB_PORT'] ?? '3306',
    'database' => $_ENV['DB_DATABASE'] ?? 'formlogic',
    'username' => $_ENV['DB_USERNAME'] ?? 'formlogic',
    'password' => $_ENV['DB_PASSWORD'] ?? '',
    'charset' => 'utf8mb4',
    'collation' => 'utf8mb4_unicode_ci',
];

$mysqlConn = new MySQLConnection($conf);
$pdo = $mysqlConn->getConnection();
$sqlite = new SQLiteConnection(__DIR__ . '/../' . ($_ENV['SQLITE_STORAGE_PATH'] ?? 'storage/forms'));

// Idempotent: ensure the marketplace-thumbnail column exists on dev/existing DBs (schema.sql has
// it for fresh installs; migrate.php is left alone here).
$colStmt = $pdo->prepare(
    "SELECT 1 FROM information_schema.columns
     WHERE table_schema = :db AND table_name = 'pack_catalog' AND column_name = 'screenshot' LIMIT 1"
);
$colStmt->execute(['db' => $conf['database']]);
if (!$colStmt->fetchColumn()) {
    $pdo->exec("ALTER TABLE `pack_catalog` ADD COLUMN `screenshot` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL AFTER `icon`");
    echo "  added pack_catalog.screenshot column\n";
}
$col2Stmt = $pdo->prepare(
    "SELECT 1 FROM information_schema.columns
     WHERE table_schema = :db AND table_name = 'pack_catalog' AND column_name = 'screenshots' LIMIT 1"
);
$col2Stmt->execute(['db' => $conf['database']]);
if (!$col2Stmt->fetchColumn()) {
    $pdo->exec("ALTER TABLE `pack_catalog` ADD COLUMN `screenshots` json DEFAULT NULL AFTER `screenshot`");
    echo "  added pack_catalog.screenshots column\n";
}
$col3Stmt = $pdo->prepare(
    "SELECT 1 FROM information_schema.columns
     WHERE table_schema = :db AND table_name = 'apps' AND column_name = 'reports' LIMIT 1"
);
$col3Stmt->execute(['db' => $conf['database']]);
if (!$col3Stmt->fetchColumn()) {
    $pdo->exec("ALTER TABLE `apps` ADD COLUMN `reports` json DEFAULT NULL");
    echo "  added apps.reports column\n";
}

$forms = new FormService($mysqlConn, $sqlite);
$apps = new AppService($mysqlConn, $forms);
$appUsers = new AppUserService($mysqlConn);
$packs = new PackService($mysqlConn, $forms, $apps, $appUsers);
$catalog = new PackCatalogService($mysqlConn);
$responses = new ResponseService($mysqlConn, $sqlite); // no runtime → onSubmit scripts are skipped when seeding

function out(string $m): void { echo $m . "\n"; }

function uuid(): string
{
    $d = random_bytes(16);
    $d[6] = chr(ord($d[6]) & 0x0f | 0x40);
    $d[8] = chr(ord($d[8]) & 0x3f | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
}

function ensureUser(PDO $pdo, string $email, string $name): string
{
    $stmt = $pdo->prepare("SELECT id FROM users WHERE email = ?");
    $stmt->execute([$email]);
    $id = $stmt->fetchColumn();
    if ($id) {
        return (string) $id;
    }
    $id = uuid();
    $pdo->prepare("INSERT INTO users (id, email, password_hash, name, cloud_until, created_at, updated_at)
                   VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 100 YEAR), NOW(), NOW())")
        ->execute([$id, $email, password_hash(bin2hex(random_bytes(24)), PASSWORD_DEFAULT), $name]);
    out("  created user $name <$email>");
    return $id;
}

function slugify(string $s): string
{
    $s = strtolower(trim($s));
    $s = preg_replace('/[^a-z0-9]+/', '-', $s) ?? '';
    return trim($s, '-') ?: 'pack';
}

/**
 * Human-friendly browse category for a pack. Curated per known slug so the marketplace's category
 * chips read cleanly ("Finance", "HR", "Safety & Quality"); unknown packs fall back to a title-cased
 * first tag. Categories remain fully dynamic — this only controls the label, not a fixed taxonomy.
 */
function niceCategory(string $slug, array $tags): string
{
    static $map = [
        'customer-service' => 'Customer Service',
        'event-management' => 'Events',
        'finance-os-au' => 'Finance',
        'finance-os-us' => 'Finance',
        'hr-people' => 'HR',
        'ohs-qms' => 'Safety & Quality',
        'sales-crm' => 'Sales & CRM',
        'expense-manager' => 'Finance',
        'people-onboarding-compliance' => 'HR',
        'plumbing-field-service' => 'Trades & Field Service',
        'job-invoice-management' => 'Billing & Invoicing',
        'salon-beauty-studio' => 'Beauty & Wellness',
        'mechanic-workshop' => 'Trades & Field Service',
        'property-maintenance' => 'Trades & Field Service',
        'clinic-appointment-intake' => 'Health & Wellness',
        'inventory-purchase-orders' => 'Operations',
    ];
    if (isset($map[$slug])) {
        return $map[$slug];
    }
    $first = (string)($tags[0] ?? 'General');
    return ucwords(str_replace('-', ' ', $first)) ?: 'General';
}

$officialId = ensureUser($pdo, $_ENV['OFFICIAL_EMAIL'] ?? 'official@formlogic.local', 'FormLogic');
$demoId = ensureUser($pdo, $_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local', 'Demo');

// ── Collect pack sources ────────────────────────────────────────────────────
$sources = [];

foreach (glob(__DIR__ . '/../resources/marketplace-packs/*.json') ?: [] as $file) {
    $e = json_decode((string) file_get_contents($file), true);
    if (!is_array($e) || empty($e['pack'])) { out("  skip (bad) " . basename($file)); continue; }
    $slug = $e['id'] ?? slugify($e['name'] ?? basename($file, '.json'));
    $tags = $e['tags'] ?? [];
    $sources[] = [
        'slug' => $slug,
        'name' => $e['name'] ?? 'Pack',
        'description' => $e['description'] ?? '',
        'icon' => $e['icon'] ?? null,
        'tags' => $tags,
        'category' => niceCategory($slug, $tags),
        'pack' => $e['pack'],
    ];
}

// Lucide icon NAMES (flat vector, rendered by the SPA's PackIcon/DynamicIcon), not emoji.
$sampleIcons = ['crm' => 'Handshake', 'sales' => 'Handshake', 'expense' => 'CreditCard', 'onboard' => 'UserCheck', 'people' => 'UserCheck'];
foreach (glob(__DIR__ . '/../resources/sample-apps/*.json') ?: [] as $file) {
    $p = json_decode((string) file_get_contents($file), true);
    if (!is_array($p) || empty($p['packMeta'])) { out("  skip (bad sample) " . basename($file)); continue; }
    $meta = $p['packMeta'];
    $key = basename($file, '.json');
    $icon = 'Package';
    foreach ($sampleIcons as $frag => $emoji) { if (str_contains(strtolower($key . ' ' . ($meta['name'] ?? '')), $frag)) { $icon = $emoji; break; } }
    $slug = slugify($meta['name'] ?? $key);
    $tags = $meta['tags'] ?? ['sample'];
    $sources[] = [
        'slug' => $slug,
        'name' => $meta['name'] ?? 'Sample',
        'description' => $meta['description'] ?? '',
        'icon' => $icon,
        'tags' => $tags,
        'category' => niceCategory($slug, $tags),
        'pack' => $p,
    ];
}

out(count($sources) . " pack source(s) found.");

// ── Seed catalog + provision Demo ───────────────────────────────────────────
foreach ($sources as $s) {
    $existing = $catalog->getCatalogBySlug($s['slug']);
    if ($existing) {
        $catalogId = $existing['id'];
        $ver = $catalog->getPackVersion($catalogId);
        $versionId = $ver['id'] ?? null;
        // Refresh the stored pack + metadata so the marketplace serves the current pack (e.g. entries
        // seeded before custom-screen dashboards were added get updated in place).
        if ($versionId) {
            $pdo->prepare("UPDATE pack_versions SET pack_data = ? WHERE id = ?")
                ->execute([json_encode($s['pack']), $versionId]);
        }
        $pdo->prepare("UPDATE pack_catalog SET featured = 1, description = ?, icon = ?, tags = ?, category = ? WHERE id = ?")
            ->execute([$s['description'], $s['icon'], json_encode($s['tags']), $s['category'], $catalogId]);
        out("catalog: '{$s['slug']}' refreshed");
    } else {
        $r = $catalog->publishPack($s['pack'], $officialId, [
            'slug' => $s['slug'],
            'name' => $s['name'],
            'description' => $s['description'],
            'icon' => $s['icon'],
            'tags' => $s['tags'],
            'category' => $s['category'],
        ]);
        $catalogId = $r['catalogId'];
        $versionId = $r['versionId'];
        $pdo->prepare("UPDATE pack_catalog SET featured = 1 WHERE id = ?")->execute([$catalogId]);
        out("catalog: '{$s['slug']}' published");
    }

    if ($packs->isCatalogPackInstalled($catalogId, $demoId)) {
        // Already installed — just refresh the demo apps' custom screens to the latest pack (e.g. after
        // re-authoring dashboards) without wiping the seeded response data.
        $updated = refreshDemoScreens($pdo, $demoId, $s['pack']);
        $updatedForms = refreshDemoFormScreens($pdo, $demoId, $catalogId, $s['pack']);
        out("  demo: already installed (refreshed $updated app screen(s), $updatedForms form screen(s))");
        continue;
    }

    try {
        $res = $packs->importPack($s['pack'], $demoId, $catalogId, $versionId);
    } catch (\Throwable $e) {
        out("  demo: install FAILED — " . $e->getMessage());
        continue;
    }
    foreach ($res['apps'] ?? [] as $app) {
        try { $packs->publishApp($app['id'], $demoId); } catch (\Throwable $e) { out("  publish failed for app {$app['id']}: " . $e->getMessage()); }
    }
    $n = seedResponses($forms, $responses, $res['forms'] ?? []);
    $GLOBALS['demoDataChanged'] = true;
    out("  demo: installed " . count($res['forms'] ?? []) . " forms / " . count($res['apps'] ?? []) . " apps, seeded $n responses");
}

// ── Optional: regenerate demo data in place (RESEED_DEMO=1) ──────────────────
// Re-run the (domain-aware) seeder over ALREADY-installed demo apps without reinstalling — app slugs and
// screenshots stay stable. Clears each pack's form responses + linked-record rows, then re-seeds per pack
// so the 2-pass linked-record resolution stays within the pack. createResponse re-syncs response_count.
if ($_ENV['RESEED_DEMO'] ?? getenv('RESEED_DEMO')) {
    $instStmt = $pdo->prepare("SELECT form_ids FROM pack_installations WHERE user_id = ? ORDER BY installed_at");
    $instStmt->execute([$demoId]);
    $reseeded = 0; $packsReseeded = 0;
    foreach ($instStmt->fetchAll(PDO::FETCH_COLUMN) as $fj) {
        $formIds = json_decode((string) $fj, true) ?: [];
        if (!$formIds) { continue; }
        foreach ($formIds as $fid) {
            if ($sqlite->formDatabaseExists($fid)) {
                try {
                    $db = $sqlite->getFormDatabase($fid);
                    foreach (['responses', 'computed', 'tags', 'script_logs'] as $t) {
                        try { $db->exec("DELETE FROM $t"); } catch (\Throwable $e) { /* table may not exist */ }
                    }
                } catch (\Throwable $e) { /* skip */ }
            }
            $pdo->prepare("DELETE FROM response_links WHERE source_form_id = ? OR target_form_id = ?")->execute([$fid, $fid]);
        }
        $reseeded += seedResponses($forms, $responses, array_map(static fn ($id) => ['id' => $id], $formIds));
        $packsReseeded++;
    }
    out("RESEED: regenerated $reseeded responses across $packsReseeded demo pack(s)");
    if ($reseeded > 0) { $GLOBALS['demoDataChanged'] = true; }
}

// ── Screenshot manifest + linking ───────────────────────────────────────────
// Emit a manifest mapping each catalog pack → the demo app slug that renders its dashboard, so the
// capture pipeline (ui/scripts/capture-pack-shots.mjs) can visit /app/<appSlug> and save
// <catalogSlug>.png deterministically. Then attach the served URL to any pack whose image is on
// disk (clearing it otherwise so a deleted file doesn't leave a broken thumbnail).
$shotDirs = [__DIR__ . '/../storage/pack-screenshots', __DIR__ . '/../resources/pack-screenshots'];
$appSlugByName = $pdo->prepare("SELECT slug FROM apps WHERE owner_id = ? AND name = ? LIMIT 1");
// Returns "<base>.<ext>" if a captured file exists on disk, else null.
$findShot = static function (string $base) use ($shotDirs): ?string {
    foreach (['png', 'jpg', 'jpeg', 'webp'] as $ext) {
        foreach ($shotDirs as $dir) {
            if (is_file("$dir/$base.$ext")) { return "$base.$ext"; }
        }
    }
    return null;
};
/** Version-busted screenshot URL: filenames are stable but content changes on re-capture, so the
 *  linked URL carries the file's mtime — every regeneration produces a new URL and old browser/CDN
 *  cache entries simply stop being referenced. */
$shotUrl = static function (string $file) use ($shotDirs): string {
    $v = 0;
    foreach ($shotDirs as $dir) {
        if (is_file("$dir/$file")) { $v = (int) filemtime("$dir/$file"); break; }
    }
    return "/api/packs/screenshots/$file" . ($v ? "?v=$v" : '');
};
$manifest = []; // flat: [{catalogSlug, appSlug, label, file}] — one entry per dashboard app
$linkedShots = 0;
foreach ($sources as $s) {
    $shots = [];   // [{label, url}] — one per app that has a dashboard + a captured file
    $idx = 0;
    foreach ($s['pack']['apps'] ?? [] as $a) {
        $enabled = !empty($a['customScreen']['enabled'] ?? ($a['customScreen'] ?? null));
        if (!$enabled) { continue; }
        $appName = $a['name'] ?? null;
        if ($appName === null) { continue; }
        // Stable filename per app: <slug>.png, <slug>-2.png, <slug>-3.png … (order = pack app order).
        $base = $s['slug'] . ($idx === 0 ? '' : '-' . ($idx + 1));
        $appSlugByName->execute([$demoId, $appName]);
        $appSlug = $appSlugByName->fetchColumn() ?: null;
        if ($appSlug) {
            $manifest[] = ['catalogSlug' => $s['slug'], 'appSlug' => $appSlug, 'label' => $appName, 'file' => "$base.png"];
        }
        if ($found = $findShot($base)) {
            $shots[] = ['label' => $appName, 'url' => $shotUrl($found)];
        }
        $idx++;
    }
    // Fallback for packs with no dashboard app but a legacy <slug>.png on disk.
    if (empty($shots) && ($found = $findShot($s['slug']))) {
        $shots[] = ['label' => $s['name'], 'url' => $shotUrl($found)];
    }
    $catalog->setPackScreenshots($s['slug'], $shots);
    $linkedShots += count($shots);
}
@mkdir($shotDirs[0], 0775, true);
file_put_contents($shotDirs[0] . '/manifest.json', json_encode($manifest, JSON_PRETTY_PRINT));
out("screenshot manifest: " . count($manifest) . " app(s); linked images: $linkedShots");

// ── Apply each pack's pre-configured reports (charts + PDF documents) to the demo apps ──────────
// Packs now carry their own reports with portable @pack:<packFormId> refs. importPack seeds them on a
// fresh install; here we re-resolve + re-apply to the (possibly already-installed) demo apps so every
// re-provision reflects the latest pack-authored reports. Deterministic ids → idempotent overwrite.
$seededReports = 0;
$appIdByName = [];
foreach ($apps->getAllApps($demoId) as $a) { $appIdByName[$a['name']] = $a['id']; }
foreach ($sources as $s) {
    // packFormId => form title (from the pack's top-level forms).
    $titleByPackForm = [];
    foreach ($s['pack']['forms'] ?? [] as $pf) {
        if (!empty($pf['packFormId'])) { $titleByPackForm[$pf['packFormId']] = $pf['title'] ?? ''; }
    }
    foreach ($s['pack']['apps'] ?? [] as $pa) {
        if (empty($pa['reports']) || !is_array($pa['reports'])) { continue; }
        $appId = $appIdByName[$pa['name']] ?? null;
        if (!$appId) { continue; }
        // installed form title => real id (for this demo app).
        $rows = $pdo->query("SELECT f.id, f.title FROM app_forms af JOIN forms f ON f.id = af.form_id WHERE af.app_id = " . $pdo->quote($appId))->fetchAll(PDO::FETCH_ASSOC);
        $idByTitle = [];
        foreach ($rows as $r) { $idByTitle[$r['title']] = $r['id']; }
        // packFormId => installed form id.
        $formIdMap = [];
        foreach ($titleByPackForm as $pfid => $title) {
            if ($title !== '' && isset($idByTitle[$title])) { $formIdMap[$pfid] = $idByTitle[$title]; }
        }
        $reports = $packs->resolvePackReports($pa['reports'], $formIdMap, static fn (string $rid) => 'pack-' . substr(md5($appId . $rid), 0, 12));
        if ($reports) {
            $apps->updateApp($appId, ['reports' => $reports]);
            $seededReports += count($reports);
        }
    }
}
out("seeded reports: $seededReports across demo apps");

// Bump the demo seed epoch whenever response data was (re)generated — clients purge their
// browser-local overlay on mismatch so stale records never dangle against a replaced dataset.
if (!empty($GLOBALS['demoDataChanged'])) {
    try {
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS system_meta (
                meta_key VARCHAR(64) NOT NULL PRIMARY KEY,
                meta_value TEXT NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");
        $pdo->prepare("INSERT INTO system_meta (meta_key, meta_value, updated_at) VALUES ('demo_seed_epoch', ?, NOW())
                       ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value), updated_at = NOW()")
            ->execute([(string) time()]);
        out('demo seed epoch bumped');
    } catch (\Throwable $e) {
        out('WARN: could not bump demo seed epoch: ' . $e->getMessage());
    }
}

out("\nDone. Demo apps: " . count($apps->getAllApps($demoId)));

/** Update the demo apps' custom screens to match the pack (by app name), without touching data. */
function refreshDemoScreens(PDO $pdo, string $demoId, array $pack): int
{
    $n = 0;
    foreach ($pack['apps'] ?? [] as $app) {
        $cs = $app['customScreen'] ?? null;
        $name = $app['name'] ?? null;
        if (!$cs || !$name) {
            continue;
        }
        $stmt = $pdo->prepare("UPDATE apps SET custom_screen = ? WHERE owner_id = ? AND name = ?");
        $stmt->execute([json_encode($cs), $demoId, $name]);
        $n += $stmt->rowCount();
        // Also sync the pack-authored app icon (settings.icon) onto already-installed demo apps —
        // installs copy settings once, so icon additions would otherwise never reach the demo.
        $icon = is_array($app['settings'] ?? null) ? ($app['settings']['icon'] ?? null) : null;
        if (is_string($icon) && $icon !== '') {
            $sel = $pdo->prepare("SELECT id, settings FROM apps WHERE owner_id = ? AND name = ?");
            $sel->execute([$demoId, $name]);
            foreach ($sel->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $settings = json_decode((string) ($row['settings'] ?? '{}'), true);
                $settings = is_array($settings) ? $settings : [];
                if (($settings['icon'] ?? null) === $icon) {
                    continue;
                }
                $settings['icon'] = $icon;
                $pdo->prepare("UPDATE apps SET settings = ? WHERE id = ?")
                    ->execute([json_encode($settings), $row['id']]);
            }
        }
    }
    return $n;
}

/**
 * Update the demo FORMS' custom screens (section dashboards) to match the pack, without touching
 * data. Scoped to THIS pack's installation form_ids and matched by title WITHIN that set — form
 * titles repeat across packs ("Document Vault" ships in both Finance OS packs), so a global
 * title match would cross-contaminate.
 */
function refreshDemoFormScreens(PDO $pdo, string $demoId, string $catalogId, array $pack): int
{
    $byTitle = [];
    foreach ($pack['forms'] ?? [] as $pf) {
        if (!empty($pf['customScreen']) && !empty($pf['title'])) {
            $byTitle[(string) $pf['title']] = $pf['customScreen'];
        }
    }
    if (!$byTitle) {
        return 0;
    }
    $inst = $pdo->prepare("SELECT form_ids FROM pack_installations WHERE user_id = ? AND catalog_id = ? ORDER BY installed_at DESC LIMIT 1");
    $inst->execute([$demoId, $catalogId]);
    $formIds = json_decode((string) ($inst->fetchColumn() ?: '[]'), true) ?: [];
    if (!$formIds) {
        return 0;
    }
    $in = implode(',', array_fill(0, count($formIds), '?'));
    $sel = $pdo->prepare("SELECT id, title FROM forms WHERE user_id = ? AND id IN ($in)");
    $sel->execute(array_merge([$demoId], $formIds));
    $n = 0;
    foreach ($sel->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $cs = $byTitle[(string) $row['title']] ?? null;
        if ($cs === null) {
            continue;
        }
        $upd = $pdo->prepare("UPDATE forms SET custom_screen = ? WHERE id = ?");
        $upd->execute([json_encode($cs), $row['id']]);
        $n += $upd->rowCount();
    }
    return $n;
}

// ── Generic seeder ──────────────────────────────────────────────────────────

/** Seed each created form with a handful of plausible responses. Two passes so linked_record
 *  fields can reference already-seeded target records. Returns total responses created. */
function seedResponses(FormService $formService, ResponseService $responseService, array $createdForms): int
{
    $defs = [];
    foreach ($createdForms as $cf) {
        $full = $formService->getForm($cf['id']);
        if ($full) { $defs[$cf['id']] = ['title' => (string) ($full['title'] ?? ''), 'fields' => $full['fields'] ?? []]; }
    }
    $hasLink = static function (array $fields): bool {
        foreach ($fields as $f) { if (($f['type'] ?? '') === 'linked_record') { return true; } }
        return false;
    };
    $seeded = []; // formId => [responseIds]
    $total = 0;
    // Pass A: forms with no linked_record.
    foreach ($defs as $fid => $def) {
        if ($hasLink($def['fields'])) { continue; }
        $seeded[$fid] = seedForm($responseService, $fid, $def, $seeded);
        $total += count($seeded[$fid]);
    }
    // Pass B: forms that reference others.
    foreach ($defs as $fid => $def) {
        if (!$hasLink($def['fields'])) { continue; }
        $seeded[$fid] = seedForm($responseService, $fid, $def, $seeded);
        $total += count($seeded[$fid]);
    }
    return $total;
}

/** Create N plausible responses for one form. Returns the created response ids. */
function seedForm(ResponseService $responseService, string $formId, array $def, array $seeded): array
{
    $fields = $def['fields'] ?? [];
    $formName = strtolower((string) ($def['title'] ?? ''));
    $ids = [];
    $count = random_int(9, 14);
    for ($i = 0; $i < $count; $i++) {
        // Decide this row's submission moment up-front so signing/acknowledgement dates can be
        // aligned to it AND backdateResponse can apply the very same timestamp — keeping the
        // domain date, the stored submitted_at and the "Nd ago" chip all telling one story.
        $daysAgo = (int) floor((random_int(0, 1000) / 1000) ** 1.7 * 55);
        $submittedTs = date('Y-m-d H:i:s', strtotime("-{$daysAgo} days") - random_int(0, 36000));
        $submittedDate = substr($submittedTs, 0, 10);
        $answers = [];
        foreach ($fields as $f) {
            $v = genValue($f, $i, $seeded, $formName, $count);
            if ($v !== null) { $answers[$f['id']] = $v; }
        }
        coherencePass($fields, $answers, $submittedDate, $i, $count, $formName);
        try {
            $r = $responseService->createResponse($formId, ['answers' => $answers]);
            if (is_array($r) && isset($r['id'])) {
                $ids[] = $r['id'];
                backdateResponse($formId, (string) $r['id'], $submittedTs);
            }
        } catch (\Throwable $e) {
            // skip a bad row, keep going
        }
    }
    return $ids;
}

/**
 * Keep generated answers self-consistent across fields: dates ordered, status ↔ date/amount
 * coherence (both directions), signing dates tied to the submission, calculated fields computed
 * from the SAME record's inputs, domain money reconciled, and category-driven descriptions. Rules
 * are label/type-driven so they generalise across packs (the finance/trades/CRM specifics are
 * expressed as label patterns, not per-form hacks).
 */
function coherencePass(array $fields, array &$answers, string $submittedDate = '', int $i = 0, int $count = 12, string $formName = ''): void
{
    $P = seedPools();
    $formName = strtolower($formName);
    $today = date('Y-m-d');
    $sub = $submittedDate !== '' ? $submittedDate : $today;

    $byId = [];
    $labelOf = [];
    $hasTime = false;
    foreach ($fields as $f) {
        $id = (string) ($f['id'] ?? '');
        if ($id === '') { continue; }
        $byId[$id] = $f;
        $labelOf[$id] = strtolower((string) ($f['label'] ?? $id));
        if (($f['type'] ?? '') === 'time') { $hasTime = true; }
    }
    $findByLabel = function (array $kw) use ($fields): ?string {
        foreach ($fields as $f) {
            $l = strtolower((string) ($f['label'] ?? '') . ' ' . ($f['id'] ?? ''));
            if (hasKw($l, $kw)) { return (string) ($f['id'] ?? ''); }
        }
        return null;
    };
    $findAll = function (array $kw) use ($fields): array {
        $r = [];
        foreach ($fields as $f) {
            $l = strtolower((string) ($f['label'] ?? '') . ' ' . ($f['id'] ?? ''));
            if (hasKw($l, $kw)) { $r[] = (string) ($f['id'] ?? ''); }
        }
        return $r;
    };
    $optVals = function (?string $id) use ($byId): array {
        $vals = [];
        if ($id === null) { return $vals; }
        foreach (($byId[$id]['properties']['options'] ?? []) as $o) {
            $v = is_array($o) ? ($o['value'] ?? null) : $o;
            if (is_string($v)) { $vals[] = $v; }
        }
        return $vals;
    };
    // A grand "Total" field — NOT "Subtotal" or a "Line Total" (both contain the substring "total").
    $findTotal = function () use ($fields): ?string {
        foreach ($fields as $f) {
            $l = strtolower((string) ($f['label'] ?? '') . ' ' . ($f['id'] ?? ''));
            if (hasKw($l, ['total']) && !hasKw($l, ['subtotal', 'line total'])) { return (string) ($f['id'] ?? ''); }
        }
        return null;
    };
    $mk = static fn (int $d, string $base): string => date('Y-m-d', strtotime($base . ' ' . ($d >= 0 ? '+' : '') . $d . ' days'));
    $iv = static fn (string $id) => isset($answers[$id]) ? (int) $answers[$id] : 0;

    // ── 1. End dates never precede their start dates ──────────────────────────
    foreach ($fields as $f) {
        $id = (string) ($f['id'] ?? '');
        if (($f['type'] ?? '') !== 'date' || !str_contains($id, 'end')) { continue; }
        $startId = str_replace('end', 'start', $id);
        if (isset($answers[$startId], $answers[$id]) && is_string($answers[$id]) && is_string($answers[$startId])
            && $answers[$id] < $answers[$startId]) {
            $answers[$id] = $mk(random_int(1, 7), $answers[$startId]);
        }
    }

    // ── 2. Signing / acknowledgement / effective dates == the submission; past-only dates clamped ─
    foreach ($fields as $f) {
        if (($f['type'] ?? '') !== 'date') { continue; }
        $id = (string) ($f['id'] ?? '');
        $l = $labelOf[$id] ?? '';
        if (!isset($answers[$id]) || !is_string($answers[$id])) { continue; }
        if (hasKw($l, ['acknowledg', 'declaration', 'nomination', 'effective']) || (hasKw($l, ['sign']) && !hasKw($l, ['assign']))) {
            $answers[$id] = $mk(-random_int(0, 2), $sub);
            continue;
        }
        // Escalation date == the submission (0-1 day earlier) so domain + submitted dates agree.
        if (hasKw($l, ['escalation date'])) {
            $answers[$id] = $mk(-random_int(0, 1), $sub);
            continue;
        }
        if (hasKw($l, ['last reviewed', 'reviewed', 'review date', 'activity', 'sale date', 'payment date', 'issue date', 'reported', 'incident', 'order date', 'last day', 'interview date', 'audit'])
            && !hasKw($l, ['next', 'expiry', 'expire', 'due', 'expected', 'valid'])) {
            if ($answers[$id] > $today) { $answers[$id] = $mk(-random_int(1, 20), $sub); }
        }
        if (hasKw($l, ['client since', 'member since', 'lease', 'hire', 'purchase date']) && $answers[$id] > $sub) {
            $answers[$id] = $mk(-random_int(30, 800), $sub);
        }
    }

    // ── 3. Review period follows the review date's quarter ────────────────────
    $pf = $findByLabel(['review period']);
    $rd = $findByLabel(['review date']);
    if ($pf && $rd && isset($answers[$rd]) && is_string($answers[$rd])) {
        $m = (int) date('n', strtotime($answers[$rd]));
        $q = $m <= 3 ? 'q1' : ($m <= 6 ? 'q2' : ($m <= 9 ? 'q3' : 'q4'));
        $vals = $optVals($pf);
        $ap = array_values(array_intersect(['annual', 'probation'], $vals));
        if ($ap && random_int(0, 9) < 3) { $answers[$pf] = $ap[array_rand($ap)]; }
        elseif (in_array($q, $vals, true)) { $answers[$pf] = $q; }
    }

    // ── 4. Email follows the record's own person name ─────────────────────────
    $personName = null;
    $fn = $findByLabel(['first name', 'given']);
    $ln = $findByLabel(['last name', 'surname', 'family']);
    if ($fn && $ln && !empty($answers[$fn]) && !empty($answers[$ln])) {
        $personName = trim((string) $answers[$fn] . ' ' . (string) $answers[$ln]);
    }
    if ($personName === null) {
        foreach ($fields as $f) {
            if (($f['type'] ?? '') !== 'short_text') { continue; }
            $id = (string) ($f['id'] ?? '');
            $l = ($labelOf[$id] ?? '') . ' ' . $id;
            if (!hasKw($l, ['name']) || hasKw($l, ['company', 'business', 'fund', 'product', 'document', 'course', 'deal', 'account', 'service'])) { continue; }
            $v = $answers[$id] ?? null;
            if (is_string($v) && preg_match('/^[A-Z][a-z]+ [A-Z][A-Za-z-]+$/', $v)) { $personName = $v; break; }
        }
    }
    if ($personName !== null) {
        foreach ($fields as $f) {
            if (($f['type'] ?? '') === 'email' && isset($answers[$f['id']])) {
                $answers[$f['id']] = strtolower(str_replace(' ', '.', $personName)) . '@example.com';
            }
        }
    }

    // ── 5. Status ↔ schedule-date coherence (both directions) ─────────────────
    $statusIds = $findAll(['status']);
    $schedId = $findByLabel(['scheduled date', 'appointment date', 'appt', 'visit date', 'date in']);
    if (!$schedId && $hasTime && isset($byId['date'])) { $schedId = 'date'; }
    if ($schedId && isset($answers[$schedId]) && is_string($answers[$schedId])) {
        $future = $answers[$schedId] > $today;
        $past = $answers[$schedId] < $today;
        $pastTense = ['completed', 'no-show', 'no_show', 'arrived', 'invoiced', 'paid', 'part-paid', 'received', 'part-received', 'closed', 'ready', 'in-progress', 'in_progress', 'awaiting-parts'];
        $futureTense = ['scheduled', 'booked', 'confirmed', 'pending', 'new', 'requested', 'sent', 'quoted', 'lead'];
        foreach ($statusIds as $sid) {
            $cur = $answers[$sid] ?? null;
            if (!is_string($cur)) { continue; }
            $lc = strtolower($cur);
            $vals = $optVals($sid);
            if ($future && in_array($lc, $pastTense, true)) {
                $cand = array_values(array_filter($vals, static fn ($v) => in_array(strtolower($v), array_merge($futureTense, ['on-hold']), true)));
                if ($cand) { $answers[$sid] = $cand[array_rand($cand)]; }
            } elseif ($past && in_array($lc, $futureTense, true)) {
                $prefer = random_int(0, 9) < 7 ? ['completed', 'arrived', 'received', 'invoiced'] : ['no-show', 'no_show', 'cancelled'];
                $cand = array_values(array_filter($vals, static fn ($v) => in_array(strtolower($v), $prefer, true)));
                if (!$cand) { $cand = array_values(array_filter($vals, static fn ($v) => in_array(strtolower($v), $pastTense, true))); }
                if ($cand) { $answers[$sid] = $cand[array_rand($cand)]; }
            }
        }
    }

    // ── 6. Invoice: status spread by index + amount_paid / dates coherence ─────
    $stId = $findByLabel(['status']);
    $invNoId = $findByLabel(['invoice number']);
    $amountPaidId = $findByLabel(['amount paid']);
    if ($stId && ($invNoId || $amountPaidId)) {
        $vals = $optVals($stId);
        $order = ['paid', 'sent', 'paid', 'part-paid', 'overdue', 'paid', 'sent', 'draft', 'paid', 'sent', 'overdue', 'part-paid', 'paid', 'sent'];
        $want = $order[$i % count($order)];
        $mapS = static function (string $w) use ($vals): ?string {
            if (in_array($w, $vals, true)) { return $w; }
            $fb = ['part-paid' => 'sent', 'draft' => 'sent', 'overdue' => 'sent'];
            $c = $fb[$w] ?? null;
            if ($c && in_array($c, $vals, true)) { return $c; }
            return in_array('sent', $vals, true) ? 'sent' : ($vals[0] ?? null);
        };
        $st = $mapS($want);
        if ($st !== null) { $answers[$stId] = $st; }
        $stl = strtolower((string) $st);
        $amountId = null;
        foreach ($fields as $f) {
            $id = (string) ($f['id'] ?? '');
            if (($f['type'] ?? '') === 'number' && hasKw($labelOf[$id] ?? '', ['amount']) && !hasKw($labelOf[$id] ?? '', ['amount paid'])) { $amountId = $id; break; }
        }
        if ($amountPaidId && $amountId && isset($answers[$amountId])) {
            $amt = (int) $answers[$amountId];
            if ($stl === 'paid') { $answers[$amountPaidId] = $amt; }
            elseif ($stl === 'part-paid') { $answers[$amountPaidId] = (int) round($amt * (random_int(30, 70) / 100)); }
            else { $answers[$amountPaidId] = 0; }
        }
        $labId = $findByLabel(['labour', 'labor']);
        $partsId = $findByLabel(['parts amount']);
        $totId = $findTotal();
        if ($totId && $labId && $partsId && isset($answers[$labId], $answers[$partsId])) {
            $answers[$totId] = (int) $answers[$labId] + (int) $answers[$partsId];
        }
        $issueId = $findByLabel(['issue date']);
        if ($issueId && isset($answers[$issueId])) {
            if ($stl === 'overdue') { $answers[$issueId] = $mk(-random_int(35, 80), $today); }
            elseif ($stl === 'draft') { $answers[$issueId] = $mk(-random_int(0, 10), $today); }
        }
        $dueId = $findByLabel(['due date']);
        if ($dueId) {
            if ($stl === 'overdue') { $answers[$dueId] = $mk(-random_int(3, 30), $today); }
            elseif (in_array($stl, ['sent', 'part-paid'], true)) { $answers[$dueId] = $mk(random_int(3, 30), $today); }
            elseif ($stl === 'paid') { $answers[$dueId] = $mk(-random_int(1, 25), $today); }
            elseif ($stl === 'draft') { $answers[$dueId] = $mk(random_int(10, 40), $today); }
        }
    }

    // ── 7. Quote: expired ↔ valid-until; subtotal + tax = total ───────────────
    $vuId = $findByLabel(['valid until']);
    $qstId = $findByLabel(['status']);
    if ($vuId && $qstId && isset($answers[$qstId]) && !$invNoId && !$amountPaidId) {
        $st = strtolower((string) $answers[$qstId]);
        if ($st === 'expired') { $answers[$vuId] = $mk(-random_int(3, 40), $today); }
        elseif (in_array($st, ['sent', 'draft'], true)) { $answers[$vuId] = $mk(random_int(5, 40), $today); }
    }
    $subId = $findByLabel(['subtotal']);
    $taxId = $findByLabel(['tax']);
    $totId2 = $findTotal();
    if ($subId && $taxId && $totId2 && isset($answers[$subId])) {
        $s = (int) $answers[$subId];
        $t = (int) round($s * 0.1);
        $answers[$taxId] = $t;
        $answers[$totId2] = $s + $t;
    }

    // ── 8. PO line total = qty × unit; PO expected-delivery vs status ──────────
    $qtyId = $findByLabel(['quantity']);
    $ucId = $findByLabel(['unit cost']);
    $ltId = $findByLabel(['line total']);
    if ($qtyId && $ucId && $ltId && isset($answers[$qtyId], $answers[$ucId])) {
        $answers[$ltId] = (int) $answers[$qtyId] * (int) $answers[$ucId];
    }
    $poNoId = $findByLabel(['po number']);
    $poStId = $findByLabel(['status']);
    $expId = $findByLabel(['expected delivery', 'expected date']);
    if ($poNoId && $poStId && $expId) {
        $st = strtolower((string) ($answers[$poStId] ?? ''));
        if ($st === 'draft') { unset($answers[$expId]); }
        elseif (in_array($st, ['ordered', 'part-received'], true)) { $answers[$expId] = $mk(random_int(-20, 20), $today); }
        elseif ($st === 'received') { $answers[$expId] = $mk(-random_int(1, 25), $today); }
    }

    // ── 9. Inventory sell price >= unit cost (plausible markup) ───────────────
    $ucP = $findByLabel(['unit cost']);
    $spP = $findByLabel(['sell price']);
    if ($ucP && $spP && isset($answers[$ucP]) && !$ltId) {
        $answers[$spP] = (int) round((int) $answers[$ucP] * (120 + random_int(0, 60)) / 100);
    }

    // ── 10. Leave: total_days derived from the start/end span ─────────────────
    $sd = $findByLabel(['start date']);
    $ed = $findByLabel(['end date']);
    $td = $findByLabel(['total days']);
    if ($sd && $ed && $td && isset($answers[$sd], $answers[$ed]) && is_string($answers[$sd]) && is_string($answers[$ed])) {
        if ($answers[$ed] < $answers[$sd]) { $answers[$ed] = $mk(random_int(0, 6), $answers[$sd]); }
        $span = (int) floor((strtotime($answers[$ed]) - strtotime($answers[$sd])) / 86400) + 1;
        $answers[$td] = max(1, min($span, (int) round($span * 5 / 7) ?: 1));
    }

    // ── 11. Salon service: category + price follow the service name ───────────
    $svcName = $findByLabel(['service name']);
    $catId = $findByLabel(['category']);
    $priceId = $findByLabel(['price']);
    if ($svcName && isset($answers[$svcName]) && is_string($answers[$svcName])) {
        $nm = $answers[$svcName];
        if ($catId && isset($P['salonServiceCat'][$nm]) && in_array($P['salonServiceCat'][$nm], $optVals($catId), true)) {
            $answers[$catId] = $P['salonServiceCat'][$nm];
        }
        if ($priceId && isset($P['salonServicePrice'][$nm])) { $answers[$priceId] = $P['salonServicePrice'][$nm]; }
    }

    // ── 12. Appointment notes: scheduling note ~half the time, else empty ─────
    $isAppt = $findByLabel(['appointment date', 'appt']) !== null || ($hasTime && $stId !== null);
    $notesId = $findByLabel(['notes']);
    if ($isAppt && $notesId) {
        if (random_int(0, 9) < 5) { $answers[$notesId] = $P['schedNotes'][seedHash($sub . $i . 'note') % count($P['schedNotes'])]; }
        else { unset($answers[$notesId]); }
    }

    // ── 12b. Availability roster: guarantee a bookable majority (~75%) so the KPI never reads 0 ─
    foreach ($fields as $f) {
        if (($f['type'] ?? '') !== 'checkboxes') { continue; }
        $id = (string) ($f['id'] ?? '');
        if (!hasKw($labelOf[$id] ?? '', ['availability'])) { continue; }
        $ov = $optVals($id);
        if (count($ov) !== 1) { continue; }
        $answers[$id] = ($i % 4 !== 0) ? [$ov[0]] : [];
    }

    // ── 12c. Policy acknowledgement: ~2/3 of starters fully signed (deterministic → stable KPI) ─
    foreach ($fields as $f) {
        if (($f['type'] ?? '') !== 'checkboxes') { continue; }
        $id = (string) ($f['id'] ?? '');
        if (!hasKw($labelOf[$id] ?? '', ['policy', 'acknowledg'])) { continue; }
        $ov = $optVals($id);
        if (count($ov) < 4) { continue; }
        $answers[$id] = ($i % 3 !== 0) ? $ov : array_slice($ov, 0, random_int(2, count($ov) - 1));
    }

    // ── 13. Description follows its record's category (expenses & maintenance) ─
    $catId2 = $findByLabel(['category', 'expense category']);
    $descId2 = $findByLabel(['description']);
    if ($catId2 && $descId2) {
        $cv = (string) ($answers[$catId2] ?? '');
        $catVals = $optVals($catId2);
        $pool = null;
        if (array_intersect($catVals, ['plumbing', 'electrical', 'appliance', 'structural', 'garden'])) {
            $pool = $P['maintByCat'][$cv] ?? $P['maintByCat']['other'];
        } elseif (array_intersect($catVals, ['travel', 'meals', 'software', 'accommodation', 'supplies', 'technology'])) {
            $pool = $P['expenseByCat'][$cv] ?? $P['expenseByCat']['other'];
        }
        if ($pool) { $answers[$descId2] = $pool[($i + seedHash($cv . $descId2)) % count($pool)]; }
    }

    // ── 14. Support-survey comments follow the satisfaction score ─────────────
    $satId = $findByLabel(['overall satisfaction', 'satisfaction']);
    $comId = $findByLabel(['comments']);
    if ($comId && $satId && isset($answers[$satId])) {
        $s = (int) $answers[$satId];
        $pool = $s >= 4 ? $P['csGood'] : ($s <= 2 ? $P['csBad'] : array_merge($P['csGood'], $P['csBad']));
        $answers[$comId] = $pool[$i % count($pool)];
    }

    // ── 15. CRM activity subject follows the touch type ───────────────────────
    $typeId = $findByLabel(['type']);
    $subjId = $findByLabel(['subject']);
    if ($typeId && $subjId && isset($answers[$typeId]) && isset($P['activityByType'][(string) $answers[$typeId]])) {
        $tp = $P['activityByType'][(string) $answers[$typeId]];
        $answers[$subjId] = $tp[$i % count($tp)];
    }

    // ── 16. CRM deal: won/lost close in the past, open deals in the future ────
    $stageId = $findByLabel(['stage']);
    $closeId = $findByLabel(['expected close', 'close date']);
    if ($stageId && $closeId && isset($answers[$stageId])) {
        $stg = strtolower((string) $answers[$stageId]);
        $answers[$closeId] = in_array($stg, ['won', 'lost'], true) ? $mk(-random_int(1, 30), $today) : $mk(random_int(7, 60), $today);
    }

    // ── 17. Vehicle: year 1998-2025, fuel coherent with the year ──────────────
    $yearId = $findByLabel(['year']);
    $fuelId = $findByLabel(['fuel']);
    $makeId = $findByLabel(['make']);
    if ($makeId && $yearId) {
        $yr = random_int(1998, 2025);
        $answers[$yearId] = $yr;
        if ($fuelId && isset($answers[$fuelId])) {
            $fv = strtolower((string) $answers[$fuelId]);
            $fvals = $optVals($fuelId);
            if (($fv === 'electric' && $yr < 2015) || ($fv === 'hybrid' && $yr < 2005)) {
                $answers[$fuelId] = in_array('petrol', $fvals, true) ? 'petrol' : ($fvals[0] ?? $fv);
            }
        }
    }

    // ── 18. Job priority follows an emergency job type ────────────────────────
    $jtId = $findByLabel(['job type']);
    $prioId = $findByLabel(['priority']);
    if ($jtId && $prioId && strtolower((string) ($answers[$jtId] ?? '')) === 'emergency') {
        $cand = array_values(array_filter($optVals($prioId), static fn ($v) => in_array(strtolower($v), ['high', 'urgent'], true)));
        if ($cand && !in_array(strtolower((string) ($answers[$prioId] ?? '')), ['high', 'urgent'], true)) {
            $answers[$prioId] = $cand[array_rand($cand)];
        }
    }

    // ── 19. Post-event recommendation follows the star rating ─────────────────
    $ratId = $findByLabel(['overall rating']);
    $recId = $findByLabel(['would you recommend', 'recommend']);
    if ($recId && $ratId && isset($answers[$ratId])) {
        $r = (int) $answers[$ratId];
        $want = $r >= 4 ? 'yes' : ($r <= 2 ? 'no' : 'maybe');
        if (in_array($want, $optVals($recId), true)) { $answers[$recId] = $want; }
    }
    $attId = $findByLabel(['would you attend', 'attend again']);
    if ($attId && $ratId && isset($answers[$ratId])) {
        $r = (int) $answers[$ratId];
        $want = $r >= 5 ? 'definitely' : ($r === 4 ? 'probably' : ($r === 3 ? 'unsure' : 'no'));
        if (in_array($want, $optVals($attId), true)) { $answers[$attId] = $want; }
    }

    // ── 20. Liquid assets never exceed net assets/worth ───────────────────────
    $netId = $findByLabel(['net worth', 'net assets']);
    $liqId = $findByLabel(['liquid net worth', 'liquid assets']);
    if ($netId && $liqId && isset($answers[$netId], $answers[$liqId]) && (int) $answers[$liqId] > (int) $answers[$netId]) {
        $answers[$liqId] = (int) round((int) $answers[$netId] * (random_int(30, 80) / 100));
    }

    // ── 21. Beneficiary nominations: fill 1-3 primary / 0-2 contingent, sum 100 ─
    if (isset($byId['primary_name_1'])) {
        $nP = random_int(1, 3);
        for ($s = 1; $s <= 3; $s++) {
            $nmId = "primary_name_$s"; $relId = "primary_relationship_$s"; $pctId = "primary_percentage_$s"; $dobId = "primary_dob_$s";
            if (!isset($byId[$nmId])) { continue; }
            if ($s <= $nP) {
                if (isset($byId[$dobId])) { $answers[$dobId] = date('Y-m-d', strtotime('-' . random_int(6600, 25000) . ' days')); }
            } else {
                unset($answers[$nmId], $answers[$relId], $answers[$pctId], $answers[$dobId]);
            }
        }
        if ($nP === 1) {
            if (isset($byId['primary_percentage_1'])) { $answers['primary_percentage_1'] = 100; }
        } elseif ($nP === 2) {
            $a = random_int(30, 70);
            if (isset($byId['primary_percentage_1'])) { $answers['primary_percentage_1'] = $a; }
            if (isset($byId['primary_percentage_2'])) { $answers['primary_percentage_2'] = 100 - $a; }
        } else {
            $a = random_int(20, 50); $rem = 100 - $a; $b = random_int(10, $rem - 10); $c = $rem - $b;
            if (isset($byId['primary_percentage_1'])) { $answers['primary_percentage_1'] = $a; }
            if (isset($byId['primary_percentage_2'])) { $answers['primary_percentage_2'] = $b; }
            if (isset($byId['primary_percentage_3'])) { $answers['primary_percentage_3'] = $c; }
        }
        $nC = random_int(0, 2);
        for ($s = 1; $s <= 2; $s++) {
            $nmId = "contingent_name_$s"; $relId = "contingent_relationship_$s"; $pctId = "contingent_percentage_$s";
            if (!isset($byId[$nmId])) { continue; }
            if ($s > $nC) { unset($answers[$nmId], $answers[$relId], $answers[$pctId]); }
        }
        if ($nC === 1 && isset($byId['contingent_percentage_1'])) { $answers['contingent_percentage_1'] = 100; }
        elseif ($nC >= 2) {
            $a = random_int(30, 70);
            if (isset($byId['contingent_percentage_1'])) { $answers['contingent_percentage_1'] = $a; }
            if (isset($byId['contingent_percentage_2'])) { $answers['contingent_percentage_2'] = 100 - $a; }
        }
    }

    // ── 21b. Trip odometer end >= start; stay check-out >= check-in; withholding after application ─
    $soId = $findByLabel(['start odometer', 'odometer start']);
    $eoId = $findByLabel(['end odometer', 'odometer end']);
    if ($soId && $eoId && isset($answers[$soId])) { $answers[$eoId] = (int) $answers[$soId] + random_int(5, 600); }
    $ciId = $findByLabel(['check-in', 'check in', 'checkin']);
    $coId = $findByLabel(['check-out', 'check out', 'checkout']);
    if ($ciId && $coId && isset($answers[$ciId]) && is_string($answers[$ciId])
        && (!isset($answers[$coId]) || !is_string($answers[$coId]) || $answers[$coId] < $answers[$ciId])) {
        $answers[$coId] = $mk(random_int(1, 7), $answers[$ciId]);
    }
    $whpId = $findByLabel(['withholding']);
    $appId = $findByLabel(['application date', 'harvest date', 'spray date']);
    if ($whpId && $appId && isset($answers[$appId]) && is_string($answers[$appId])) {
        $answers[$whpId] = $mk(random_int(3, 30), $answers[$appId]);
    }

    // ── 22. Superannuation partial rollover amount < balance (only when partial) ─
    $paId = $findByLabel(['partial rollover', 'partial amount']);
    if ($paId) {
        $bal = $iv($findByLabel(['estimated balance']) ?? '');
        $rt = strtolower((string) ($answers[$findByLabel(['rollover type']) ?? ''] ?? ''));
        if ($rt === 'partial' && $bal > 0) { $answers[$paId] = (int) round($bal * (random_int(20, 80) / 100)); }
        else { unset($answers[$paId]); }
    }

    // ── 23. Calculated fields computed from the SAME record's inputs ───────────
    foreach ($fields as $f) {
        if (($f['type'] ?? '') !== 'calculated') { continue; }
        $id = (string) ($f['id'] ?? '');
        $l = $labelOf[$id] ?? '';
        if (hasKw($l, ['risk score', 'risk profile score'])) {
            $lcId = $findByLabel(['loss capacity']) ?: $findByLabel(['risk tolerance']);
            $thId = $findByLabel(['time horizon']);
            $agId = $findByLabel(['age']);
            $A = $lcId && isset($answers[$lcId]) ? (int) $answers[$lcId] : random_int(3, 9);
            $B = $thId && isset($answers[$thId]) ? (int) $answers[$thId] : random_int(3, 15);
            $AG = $agId && isset($answers[$agId]) ? (int) $answers[$agId] : random_int(30, 70);
            $answers[$id] = max(22, min(88, (int) round($A * 5 + $B * 2 + (120 - $AG) / 2)));
        } elseif (hasKw($l, ['annual fee'])) {
            $pvId = $findByLabel(['portfolio value', 'current portfolio', 'current aum', 'account value', 'portfolio']);
            $pv = $pvId ? $iv($pvId) : 0;
            if ($pv > 0) {
                $rate = $pv <= 500000 ? 0.011 : ($pv <= 1000000 ? 0.0088 : 0.0077);
                $answers[$id] = (int) round($pv * $rate);
            }
        } elseif (hasKw($l, ['wholesale'])) {
            $inc = $iv($findByLabel(['annual income']) ?? '');
            $net = $iv($findByLabel(['net assets', 'net worth']) ?? '');
            $answers[$id] = ($inc >= 250000 || $net >= 2500000) ? 'Yes' : 'No';
        } elseif (hasKw($l, ['transfer fee'])) {
            $answers[$id] = random_int(50, 125);
        } elseif (hasKw($l, ['accredited'])) {
            $inc = $iv($findByLabel(['annual income']) ?? '');
            $net = $iv($findByLabel(['net worth', 'net assets']) ?? '');
            $answers[$id] = ($inc > 200000 || $net > 1000000) ? 'Accredited' : 'Retail';
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  New app-pack coherence — hospitality, retail, trades, property, pets, farm.
    //  $formName is available, so rules can be scoped per pack/form.
    // ══════════════════════════════════════════════════════════════════════════
    $fnHas = static fn (array $kw): bool => hasKw($formName, $kw);
    $addMin = static function (string $t, int $m): string {
        $p = explode(':', $t);
        $tot = ((int) ($p[0] ?? 8)) * 60 + (int) ($p[1] ?? 0) + $m;
        $tot = max(0, min($tot, 23 * 60 + 45));
        return str_pad((string) intdiv($tot, 60), 2, '0', STR_PAD_LEFT) . ':' . str_pad((string) ($tot % 60), 2, '0', STR_PAD_LEFT);
    };
    $catId = $findByLabel(['category']);
    $catVal = ($catId && isset($answers[$catId]) && is_string($answers[$catId])) ? $answers[$catId] : '';
    $setDom = static function (string $nameId, array $byCat, array $flat) use (&$answers, $catVal, $i, $formName): void {
        $pool = ($catVal !== '' && !empty($byCat[$catVal])) ? $byCat[$catVal] : $flat;
        if ($pool) { $answers[$nameId] = $pool[($i + seedHash($formName . '|' . $catVal . '|' . $nameId)) % count($pool)]; }
    };

    // N1. Item / product / ingredient / supply names coherent with the record's category.
    if (isset($byId['item_name']) && $fnHas(['menu'])) {
        if (in_array($catVal, ['burger', 'side', 'drink', 'dessert', 'combo'], true)) { $setDom('item_name', $P['menuGrillByCat'], $P['menuGrillFlat']); }
        else { $setDom('item_name', $P['menuCafeByCat'], $P['menuCafeFlat']); }
    }
    if (isset($byId['ingredient'])) { $setDom('ingredient', $P['prepGrillByCat'], $P['prepGrillFlat']); }
    if (isset($byId['item']) && $fnHas(['stock item'])) { $setDom('item', $P['stockCafeByCat'], $P['stockCafeFlat']); }
    if (isset($byId['product_name']) && in_array($catVal, ['apparel', 'homewares', 'gifts', 'stationery', 'jewellery', 'seasonal'], true)) { $setDom('product_name', $P['retailByCat'], $P['retailFlat']); }
    if (isset($byId['supply_item'])) {
        if ($fnHas(['clean']) || in_array($catVal, ['chemicals', 'cloths-and-pads', 'equipment', 'consumables'], true)) { $setDom('supply_item', $P['cleaningSupByCat'], $P['cleaningSupFlat']); }
        else { $answers['supply_item'] = $P['stayReadySup'][($i + seedHash($formName . 'sup')) % count($P['stayReadySup'])]; }
    }
    if (isset($byId['prep_item']) && $fnHas(['prep'])) { $answers['prep_item'] = $P['prepItems'][($i + seedHash($formName . 'prepitem')) % count($P['prepItems'])]; }
    // Stock unit follows the category (beans -> kg, milk/syrup -> litres, cups/packaging -> units).
    $unitId2 = $findByLabel(['unit']);
    if ($unitId2 && $catVal !== '') {
        $catUnit = ['beans' => 'kg', 'milk' => 'litres', 'syrup' => 'litres', 'cups' => 'units', 'food-prep' => 'units', 'packaging' => 'units', 'bun' => 'units', 'patty' => 'units', 'salad' => 'units', 'sauce' => 'litres', 'drink' => 'units'];
        if (isset($catUnit[$catVal])) {
            $luv = array_map('strtolower', $optVals($unitId2));
            $k = array_search($catUnit[$catVal], $luv, true);
            if ($k !== false) { $answers[$unitId2] = $optVals($unitId2)[$k]; }
        }
    }
    // Menu prep station follows the category (burger -> grill, drink -> drinks, coffee -> espresso, ...).
    if ($fnHas(['menu']) && $catVal !== '') {
        $stationByCat = ['coffee' => 'espresso', 'tea' => 'espresso', 'cold-drink' => 'cold-bar', 'food' => 'kitchen', 'retail-beans' => 'retail', 'burger' => 'grill', 'side' => 'fryer', 'drink' => 'drinks', 'dessert' => 'cold-station', 'combo' => 'grill'];
        $stnFieldId = $findByLabel(['prep station', 'station']);
        if ($stnFieldId && isset($stationByCat[$catVal]) && in_array($stationByCat[$catVal], $optVals($stnFieldId), true)) {
            $answers[$stnFieldId] = $stationByCat[$catVal];
        }
    }

    // N2. Stock status derived from on-hand vs par/reorder (never flag an overstocked item 'out').
    $onId = $findByLabel(['current quantity', 'current count', 'current stock', 'stock on hand', 'on hand', 'on-hand']);
    $parId = $findByLabel(['par level', 'reorder point', 'reorder']);
    $stkStatusId = $findByLabel(['status']);
    if ($onId && $parId && $stkStatusId && $onId !== $parId) {
        $sv = $optVals($stkStatusId);
        $lcv = array_map('strtolower', $sv);
        $trigger = (bool) array_intersect($lcv, ['out', 'low-stock', 'discontinued']) || (in_array('ok', $lcv, true) && in_array('low', $lcv, true));
        if ($trigger) {
            $par = random_int(8, 50);
            $r = $i % 6;
            if ($r === 0) { $on = random_int(0, 1); $state = 'out'; }
            elseif ($r <= 2) { $on = random_int(1, max(1, $par - 1)); $state = 'low'; }
            else { $on = random_int($par, (int) round($par * 1.4)); $state = 'ok'; }
            $answers[$parId] = $par;
            $answers[$onId] = $on;
            if (isset($byId['opening_count'])) { $answers['opening_count'] = $on + random_int(0, $par); }
            $pickS = static function (array $prefs) use ($sv, $lcv) {
                foreach ($prefs as $p) { $k = array_search($p, $lcv, true); if ($k !== false) { return $sv[$k]; } }
                return null;
            };
            $chosen = $state === 'out' ? $pickS(['out', 'low-stock', 'low', 'discontinued'])
                : ($state === 'low' ? $pickS(['low', 'low-stock', 'out']) : $pickS(['ok', 'active']));
            if ($chosen !== null) { $answers[$stkStatusId] = $chosen; }
        }
    }

    // N2b. Retail cost/retail price: sensible magnitudes with retail marked up above cost.
    if (isset($byId['cost_price'], $byId['retail_price'])) {
        $cp = random_int(5, 150);
        $answers['cost_price'] = $cp;
        $answers['retail_price'] = (int) round($cp * (140 + random_int(0, 100)) / 100);
    }

    // N3. Order status rebalance: collected/served dominate, few live, rare cancellation (cafe/burger).
    $ordStId = $findByLabel(['status']);
    if (isset($byId['order_type']) && $ordStId && !isset($byId['device_type'])) {
        $ov = $optVals($ordStId);
        $lo = array_map('strtolower', $ov);
        $pick = static function (array $prefs) use ($ov, $lo) {
            foreach ($prefs as $p) { $k = array_search($p, $lo, true); if ($k !== false) { return $ov[$k]; } }
            return null;
        };
        $rr = seedHash($formName . 'ord' . $i) % 12;
        $tok = $rr === 0 ? 'cancel' : ($rr <= 3 ? 'live' : 'done');
        $chosen = $tok === 'cancel' ? $pick(['cancelled'])
            : ($tok === 'live' ? $pick(['making', 'preparing', 'new', 'pulling-shots']) : $pick(['served', 'collected', 'ready']));
        if ($chosen !== null) { $answers[$ordStId] = $chosen; }
        // Cafe/burger order value is a handful of items, not an invoice-sized total.
        $totF = $findByLabel(['order total']) ?: (isset($byId['total']) ? 'total' : null);
        if ($totF) { $answers[$totF] = random_int(9, 75); }
    }

    // N4. Live queue timestamps within hours; completed_at after started_at.
    $liveActive = ['new', 'making', 'preparing', 'cooking', 'queued', 'pulling-shots', 'pouring', 'plating', 'fire', 'held'];
    $qStId = $findByLabel(['status']);
    $qActive = $qStId && in_array(strtolower((string) ($answers[$qStId] ?? '')), $liveActive, true);
    foreach ($fields as $f) {
        if (($f['type'] ?? '') !== 'datetime') { continue; }
        $id = (string) ($f['id'] ?? '');
        $ll = $labelOf[$id] ?? '';
        if (hasKw($ll, ['created', 'started'])) {
            $mins = $qActive ? random_int(2, 180) : random_int(150, 2880);
            $answers[$id] = date('Y-m-d\TH:i', strtotime("-{$mins} minutes"));
        } elseif (hasKw($ll, ['checked', 'last checked'])) {
            // A stock check happened recently, in the PAST (never "in 5 days").
            $answers[$id] = date('Y-m-d\TH:i', strtotime('-' . random_int(30, 4320) . ' minutes'));
        }
    }
    if (isset($byId['started_at'], $byId['completed_at'])) {
        $sv2 = strtolower((string) ($qStId ? ($answers[$qStId] ?? '') : ''));
        if (in_array($sv2, ['ready', 'served', 'collected', 'done'], true) && isset($answers['started_at']) && is_string($answers['started_at'])) {
            $answers['completed_at'] = date('Y-m-d\TH:i', strtotime($answers['started_at'] . ' +' . random_int(8, 40) . ' minutes'));
        } else {
            unset($answers['completed_at']);
        }
    }

    // N5. Barista modifiers: temperature exclusivity, shots + milk coherent with the drink.
    if (isset($byId['drink_type'], $byId['extras'])) {
        $dt = strtolower((string) ($answers['drink_type'] ?? ''));
        $ex = is_array($answers['extras'] ?? null) ? $answers['extras'] : [];
        if (in_array('extra-hot', $ex, true) && in_array('iced', $ex, true)) {
            $answers['extras'] = array_values(array_filter($ex, static fn ($v) => $v !== 'iced'));
        }
        if (isset($byId['shots'])) { $answers['shots'] = in_array($dt, ['matcha', 'chai'], true) ? 0 : random_int(1, 2); }
        if (isset($byId['milk']) && in_array($dt, ['long-black', 'espresso'], true)) { unset($answers['milk']); }
    }

    // N6. Daily close: realistic beans (kg) with roughly proportional milk (litres).
    if (isset($byId['beans_used'], $byId['milk_used'])) {
        $b = random_int(5, 15);
        $answers['beans_used'] = $b;
        $answers['milk_used'] = $b * random_int(4, 7) + random_int(0, 10);
    }

    // N7. Roster: weight toward front-of-house/production, few managers; shifts land this week.
    $roleId = $findByLabel(['role']);
    $shiftDId = $findByLabel(['shift date']);
    if ($roleId && $shiftDId) {
        $rv = $optVals($roleId);
        $weighted = [];
        foreach ($rv as $v) {
            $w = strtolower($v);
            $n = in_array($w, ['manager'], true) ? 1 : (in_array($w, ['barista', 'front-counter', 'grill', 'runner', 'server'], true) ? 4 : 2);
            for ($k = 0; $k < $n; $k++) { $weighted[] = $v; }
        }
        if ($weighted) { $answers[$roleId] = $weighted[seedHash($formName . 'role' . $i) % count($weighted)]; }
        $answers[$shiftDId] = $mk(random_int(-1, 6), $today);
    }

    // N8. Shift close: revenue proportional to covers.
    if (isset($byId['covers_served'], $byId['sales_total'])) {
        $cv = (int) ($answers['covers_served'] ?? 0);
        if ($cv <= 0) { $cv = random_int(45, 110); $answers['covers_served'] = $cv; }
        $answers['sales_total'] = $cv * random_int(55, 95);
        if (isset($byId['voids_comps'])) { $answers['voids_comps'] = random_int(0, (int) round($cv * 1.5)); }
    }

    // N9. Kitchen ticket: allergy notes a minority (so the pill carries signal).
    if (isset($byId['allergy_notes'], $byId['items'])) {
        if ($i % 3 !== 0) { unset($answers['allergy_notes']); }
        else { $answers['allergy_notes'] = $P['allergyNotes'][$i % count($P['allergyNotes'])]; }
    }

    // N10. Property: realistic bedrooms / bathrooms (studio = 0 bd; ba <= bd + 1).
    if (isset($byId['bedrooms'], $byId['bathrooms'])) {
        $ptId = $findByLabel(['property type']);
        $pt = strtolower((string) ($ptId ? ($answers[$ptId] ?? '') : ''));
        $bd = $pt === 'studio' ? 0 : random_int(1, 6);
        $answers['bedrooms'] = $bd;
        $answers['bathrooms'] = $bd === 0 ? 1 : max(1, min($bd + 1, random_int(1, $bd + 1)));
    }

    // N11. Bookings: dates + status coherent (future = enquiry/confirmed; past = completed/checked-out).
    if (isset($byId['check_in'], $byId['status'])) { // StayReady booking
        $ci = $mk(random_int(-18, 20), $today);
        $answers['check_in'] = $ci;
        $answers['check_out'] = $mk(random_int(1, 7), $ci);
        $bsv = $optVals($findByLabel(['status']));
        $s = $ci > $today ? 'confirmed' : ($answers['check_out'] < $today ? 'checked-out' : 'checked-in');
        if (in_array($s, $bsv, true)) { $answers['status'] = $s; }
    }
    if (isset($byId['booking_date'], $byId['status'])) { // VenueOps booking
        $bd2 = $mk(random_int(-25, 21), $today);
        $answers['booking_date'] = $bd2;
        $bsv2 = $optVals($findByLabel(['status']));
        $cand = $bd2 > $today
            ? [['enquiry', 'confirmed', 'paid'], ['confirmed', 'paid', 'enquiry'], ['paid', 'confirmed', 'enquiry']][$i % 3]
            : ((seedHash($formName . 'bk' . $i) % 8 === 0) ? ['cancelled', 'completed'] : ['completed']);
        foreach ($cand as $c) { if (in_array($c, $bsv2, true)) { $answers['status'] = $c; break; } }
    }

    // N11b. Reservations spread across tonight & upcoming so "covers tonight" and upcoming populate.
    if (isset($byId['party_size'], $byId['date']) && $findByLabel(['status'])) {
        $rd = $mk(random_int(-6, 14), $today);
        $answers['date'] = $rd;
        $rsv = $optVals($findByLabel(['status']));
        $s = $rd > $today ? 'booked' : ($rd === $today ? 'seated' : ((seedHash($formName . 'rz' . $i) % 5 === 0) ? 'no-show' : 'seated'));
        if (in_array($s, $rsv, true)) { $answers['status'] = $s; }
    }

    // N12. Catering job event dates lean future for open jobs so "upcoming" panels populate.
    if (isset($byId['event_date'])) {
        $st = strtolower((string) ($answers[$findByLabel(['status']) ?? ''] ?? ''));
        if (in_array($st, ['enquiry', 'quoted', 'confirmed'], true)) { $answers['event_date'] = $mk(random_int(2, 30), $today); }
        elseif ($st === 'prep') { $answers['event_date'] = $mk(random_int(0, 5), $today); }
        elseif (in_array($st, ['delivered', 'closed'], true)) { $answers['event_date'] = $mk(-random_int(2, 40), $today); }
        else { $answers['event_date'] = $mk(random_int(-8, 20), $today); }
    }

    // N13. Time pairs: end after start / drop after departure.
    foreach ([['start_time', 'end_time'], ['pickup_time', 'delivery_time']] as $tp) {
        [$ta, $tb] = $tp;
        if (isset($answers[$ta], $answers[$tb]) && is_string($answers[$ta]) && is_string($answers[$tb]) && $answers[$tb] <= $answers[$ta]) {
            $answers[$tb] = $addMin((string) $answers[$ta], random_int(30, 180));
        }
    }

    // N14. Delivery date lands in the recent past (a "received" delivery can't be future-dated).
    if (isset($byId['delivery_date'], $byId['material'])) {
        $answers['delivery_date'] = $mk(-random_int(0, 18), $today);
    }

    // N15. Harvest load magnitude realistic per unit.
    if (isset($byId['harvest_date'])) {
        $uId = $findByLabel(['unit']);
        $qId = $findByLabel(['quantity']);
        $u = strtolower((string) ($uId ? ($answers[$uId] ?? '') : ''));
        if ($qId) {
            if ($u === 'kg') { $answers[$qId] = random_int(500, 6000); }
            elseif ($u === 'tonnes') { $answers[$qId] = random_int(5, 45); }
            elseif (in_array($u, ['bins', 'bales'], true)) { $answers[$qId] = random_int(8, 40); }
        }
    }

    // N16. Repair bench: device brand/model coherent with a (phone-weighted) type; quote by issue.
    if (isset($byId['device_type'], $byId['brand'], $byId['model'])) {
        $dtVals = $optVals($findByLabel(['device type']));
        $order = ['phone', 'phone', 'laptop', 'phone', 'tablet', 'console', 'phone', 'laptop', 'phone', 'desktop', 'tablet', 'phone', 'laptop', 'console'];
        $want = $order[$i % count($order)];
        if (in_array($want, $dtVals, true)) { $answers['device_type'] = $want; }
        $dt2 = (string) ($answers['device_type'] ?? 'phone');
        $pool = $P['deviceByType'][$dt2] ?? $P['deviceByType']['phone'];
        $entry = $pool[($i + seedHash($formName . $dt2)) % count($pool)];
        $bm = explode('|', $entry);
        $answers['brand'] = $bm[0];
        $answers['model'] = $bm[1] ?? 'Model';
    }
    if (isset($byId['quote_amount'], $byId['issue_type'])) {
        $it = strtolower((string) ($answers['issue_type'] ?? ''));
        $answers['quote_amount'] = in_array($it, ['data-recovery', 'water-damage'], true) ? random_int(250, 1400)
            : (in_array($it, ['screen', 'charging'], true) ? random_int(90, 450) : random_int(45, 300));
    }

    // N17. Fleet: make/model coherent with the vehicle-name category.
    if (isset($byId['vehicle_name'], $byId['make_model']) && isset($answers['vehicle_name']) && is_string($answers['vehicle_name'])) {
        $vn = strtolower($answers['vehicle_name']);
        $key = 'car';
        foreach (['ute', 'van', 'truck', 'hatch', 'wagon'] as $k) { if (str_contains($vn, $k)) { $key = $k; break; } }
        $pool = $P['fleetMakeByType'][$key] ?? $P['fleetMakeByType']['car'];
        $answers['make_model'] = $pool[($i + seedHash($formName . $key)) % count($pool)];
    }

    // N18. Fitness: program goal matches the program name; payment amount by type; body metrics realistic.
    if (isset($byId['program_name'], $byId['goal']) && isset($answers['program_name'])) {
        $pn = (string) $answers['program_name'];
        if (isset($P['fitProgramGoal'][$pn]) && in_array($P['fitProgramGoal'][$pn], $optVals($findByLabel(['goal'])), true)) {
            $answers['goal'] = $P['fitProgramGoal'][$pn];
        }
    }
    $ptId2 = $findByLabel(['payment type']);
    $amtF = $findByLabel(['amount']);
    if ($ptId2 && $amtF && isset($answers[$ptId2])) {
        $pt2 = strtolower((string) $answers[$ptId2]);
        $map = ['casual-visit' => [15, 40], 'session-pack' => [150, 800], 'program-fee' => [300, 1500], 'membership' => [60, 200]];
        if (isset($map[$pt2])) { $answers[$amtF] = random_int($map[$pt2][0], $map[$pt2][1]); }
    }
    if (isset($byId['weight_kg'], $byId['body_fat_pct'])) {
        $w = (int) ($answers['weight_kg'] ?? 0);
        if ($w < 45 || $w > 130) { $w = random_int(55, 110); }
        $answers['weight_kg'] = $w;
        $base = 12 + (int) round(($w - 55) / 55 * 18);
        $answers['body_fat_pct'] = max(8, min(38, $base + random_int(-4, 6)));
    }

    // N19. Venue payments: refunds are a small minority, well below collections.
    $payStId = $findByLabel(['status']);
    if ($payStId && isset($byId['method'], $byId['amount'])) { // VenueOps payment (has 'method')
        $psv = $optVals($payStId);
        if (in_array('refunded', $psv, true)) {
            $want = (seedHash($formName . 'pay' . $i) % 8 === 3) ? 'refunded' : ((seedHash($formName . 'pay2' . $i) % 3 === 0) ? 'pending' : 'paid');
            if (in_array($want, $psv, true)) { $answers[$payStId] = $want; }
            if (($answers[$payStId] ?? '') === 'refunded') { $answers[$findByLabel(['amount'])] = random_int(60, 400); }
        }
    }

    // N20. Pets: dog-heavy roster; size coherent with species (only dogs go large/giant); care notes match type.
    if (isset($byId['species'], $byId['size'])) {
        $spVals = $optVals($findByLabel(['species']));
        $wsp = ['dog', 'dog', 'cat', 'dog', 'dog', 'cat', 'dog', 'other', 'cat', 'dog', 'dog', 'cat'][$i % 12];
        if (in_array($wsp, $spVals, true)) { $answers['species'] = $wsp; }
        $sp = strtolower((string) ($answers['species'] ?? ''));
        $szVals = $optVals($findByLabel(['size']));
        $lz = array_map('strtolower', $szVals);
        if ($sp !== 'dog') {
            $cand = array_values(array_filter($szVals, static fn ($v) => in_array(strtolower($v), ['small', 'medium'], true)));
            if ($cand) { $answers['size'] = $cand[$i % count($cand)]; }
        } else {
            $wseq = ['small', 'medium', 'small', 'medium', 'large', 'small', 'medium', 'large', 'giant', 'medium', 'small', 'large'];
            $k = array_search($wseq[$i % count($wseq)], $lz, true);
            if ($k !== false) { $answers['size'] = $szVals[$k]; }
        }
        if (isset($byId['breed'])) {
            $bp = $sp === 'cat' ? $P['catBreeds'] : ($sp === 'dog' ? $P['dogBreeds'] : $P['otherBreeds']);
            $answers['breed'] = $bp[($i + seedHash($formName . 'br')) % count($bp)];
        }
    }
    if (isset($byId['incident_type'], $byId['action_taken'])) {
        $it2 = strtolower((string) ($answers['incident_type'] ?? ''));
        $dp = $P['careDescByType'][$it2] ?? null;
        $ap = $P['careActionByType'][$it2] ?? null;
        $dId = $findByLabel(['description']);
        if ($dId && $dp) { $answers[$dId] = $dp[$i % count($dp)]; }
        if ($ap) { $answers['action_taken'] = $ap[$i % count($ap)]; }
    }

    // N21. Cleaning: price by job type; issue description/resolution track status; follow-up on low scores.
    $jtId = $findByLabel(['job type']);
    if ($jtId && isset($byId['duration_hours'], $answers[$jtId])) {
        $prId = $findByLabel(['price']);
        $jt = strtolower((string) $answers[$jtId]);
        $jmap = ['regular-clean' => [120, 200], 'deep-clean' => [250, 400], 'end-of-lease' => [280, 480], 'office' => [150, 300], 'airbnb-turnover' => [90, 180]];
        if ($prId && isset($jmap[$jt])) { $answers[$prId] = random_int($jmap[$jt][0], $jmap[$jt][1]); }
        // Bias to completed-recent so the "revenue 30d" KPI reflects a working operation; keep a
        // near-future tail for the run sheet's upcoming jobs.
        $sdId = $findByLabel(['scheduled date']);
        $cjStId = $findByLabel(['status']);
        if ($sdId && $cjStId) {
            $sd = $mk(random_int(-28, 9), $today);
            $answers[$sdId] = $sd;
            $csv = $optVals($cjStId);
            $s = $sd > $today ? 'scheduled' : ($sd === $today ? 'in-progress' : ((seedHash($formName . 'cj' . $i) % 6 === 0) ? 'cancelled' : 'completed'));
            if (in_array($s, $csv, true)) { $answers[$cjStId] = $s; }
        }
    }
    if (isset($byId['description'], $byId['resolution'], $byId['issue_type'])) {
        $iStId = $findByLabel(['status']);
        $ist = strtolower((string) ($iStId ? ($answers[$iStId] ?? '') : ''));
        $answers['description'] = $P['issueDesc'][$i % count($P['issueDesc'])];
        if ($ist === 'resolved') { $answers['resolution'] = $P['issueResolution'][$i % count($P['issueResolution'])]; }
        else { unset($answers['resolution']); }
    }
    if (isset($byId['rating'], $byId['follow_up'])) {
        $rt = (int) ($answers['rating'] ?? 5);
        $fv = $optVals($findByLabel(['follow']));
        $wantF = $rt <= 3 ? 'yes' : 'no';
        if (in_array($wantF, $fv, true)) { $answers['follow_up'] = $wantF; }
    }

    // N22. Tutoring: lesson fee from duration; status follows the date; invoice amounts realistic.
    if (isset($byId['fee'], $byId['duration'], $byId['student'])) {
        $mins = (int) ($answers['duration'] ?? 0);
        if ($mins > 0) { $answers['fee'] = (int) round($mins / 60 * random_int(45, 80)); }
        $ldId = $findByLabel(['lesson date']);
        $lStId = $findByLabel(['status']);
        if ($ldId && $lStId && isset($answers[$ldId]) && is_string($answers[$ldId])) {
            $lsv = $optVals($lStId);
            $s = $answers[$ldId] > $today ? 'scheduled' : ((seedHash($formName . 'ls' . $i) % 6 === 0) ? 'no-show' : 'completed');
            if (in_array($s, $lsv, true)) { $answers[$lStId] = $s; }
        }
    }
    if (isset($byId['billing_period'])) {
        $answers['billing_period'] = $P['billingPeriods'][($i + seedHash($formName . 'bp')) % count($P['billingPeriods'])];
        $amI = $findByLabel(['amount']);
        if ($amI) { $answers[$amI] = random_int(80, 420); }
    }

    // N23. Counterflow: damage/sale movements reduce stock (negative); supplier names realistic.
    if (isset($byId['movement_type'], $byId['quantity_change'])) {
        $mt = strtolower((string) ($answers['movement_type'] ?? ''));
        $q = abs((int) ($answers['quantity_change'] ?? 0));
        if ($q === 0) { $q = random_int(1, 30); }
        if (in_array($mt, ['sale-adjustment', 'damage'], true)) { $answers['quantity_change'] = -$q; }
        elseif ($mt === 'stock-count') { $answers['quantity_change'] = random_int(-5, 5); }
        else { $answers['quantity_change'] = $q; }
    }
    if (isset($byId['contact_person'])) { // Counterflow supplier
        $snId = $findByLabel(['supplier name']);
        if ($snId) { $answers[$snId] = $P['retailSuppliers'][($i + seedHash($formName . 'rsup')) % count($P['retailSuppliers'])]; }
        // The "Supplier" form context otherwise strips this to empty ("No contact on file").
        $answers['contact_person'] = pickSeq($P['namesPrimary'], $formName, 'contactp', $i);
    }
}

/**
 * Spread demo submissions over the past ~8 weeks (skewed toward recent) instead of "everything
 * seeded just now" — dashboards' sparklines/"Nd ago" chips read as a live business, not a fresh
 * seed. Updates the per-form SQLite row AND the MySQL response_metadata mirror. Cosmetic: failures
 * are swallowed.
 */
function backdateResponse(string $formId, string $responseId, string $ts): void
{
    global $sqlite, $pdo;
    try {
        $db = $sqlite->getFormDatabase($formId);
        $st = $db->prepare('UPDATE responses SET submitted_at = :ts, updated_at = :ts2 WHERE id = :id');
        $st->execute(['ts' => $ts, 'ts2' => $ts, 'id' => $responseId]);
        $ms = $pdo->prepare('UPDATE response_metadata SET submitted_at = :ts WHERE id = :id');
        $ms->execute(['ts' => $ts, 'id' => $responseId]);
    } catch (\Throwable $e) {
        // cosmetic only — never fail provisioning over a backdate
    }
}

/**
 * Generate a plausible value for a field, or null to leave it empty. Uses the FORM name + field label
 * together so demo data is domain-relevant — a "Name" field in a Product form yields a product, in a
 * Vehicle form the make/model yields a car, in a Salon Service form yields a service, etc. Person and
 * entity names are drawn WITHOUT replacement per form (deterministic per (form,row)) so visible lists
 * never repeat, and NEVER emits placeholder strings like "Sample entry".
 */
function genValue(array $field, int $i, array $seeded, string $formName = '', int $count = 12)
{
    $P = seedPools();
    $type = $field['type'] ?? 'short_text';
    $fid = (string) ($field['id'] ?? '');
    $label = strtolower((string) ($field['label'] ?? $fid));
    $ctx = trim($formName . ' ' . $label);
    $props = $field['properties'] ?? [];
    $opts = $props['options'] ?? [];

    $rand = static fn (array $a) => $a[array_rand($a)];
    $has = static fn (string $s, array $kw): bool => hasKw($s, $kw);
    $STREETS = ['Baker Street', 'Elm Avenue', 'Maple Court', 'King Road', 'Station Street', 'Harbour Lane', 'Victoria Parade', 'Rosewood Drive', 'George Street', 'Park Terrace'];
    $CITIES = ['Springfield', 'Riverton', 'Fairview', 'Lakeside', 'Newport', 'Ashford'];
    $addr = static fn () => random_int(1, 199) . ' ' . $STREETS[array_rand($STREETS)] . ', ' . $CITIES[array_rand($CITIES)];
    $code = static fn (string $p) => $p . '-' . str_pad((string) (1001 + $i), 4, '0', STR_PAD_LEFT);
    $optValue = static function (array $opts) {
        if (empty($opts)) { return null; }
        $o = $opts[array_rand($opts)];
        return is_array($o) ? ($o['value'] ?? null) : $o;
    };
    // Form is a roster/directory OF workers (patients-vs-providers, clients-vs-stylists must stay
    // disjoint) — such forms draw their identity names from the STAFF pool, everyone else from PRIMARY.
    $roster = $has($formName, ['stylist', 'provider', 'therapist', 'practitioner', 'dentist', 'walker', 'instructor', 'tutor', 'trainer', 'driver', 'team member']);
    // Finance forms give estimated/contract "values" six-to-seven-figure magnitudes; trades forms don't.
    $finance = $has($formName, ['client onboarding', 'new client', 'risk', 'transfer', 'rollover', 'acat', '1035', 'exchange', 'fee agreement', 'fee disclosure', 'beneficiary', 'death benefit', 'annual client review', 'superannuation', 'off-market']);

    switch ($type) {
        case 'short_text':
            // ── Codes / reference numbers (LABEL-driven: the form name must never turn a name/subject
            // field into a code — e.g. the "Event Registration" form must not stamp plate codes). ──
            if ($has($label, ['sku', 'item code', 'product code'])) { return 'SKU-' . str_pad((string) (1000 + $i), 5, '0', STR_PAD_LEFT); }
            if ($has($label, ['part number', 'part no'])) { return strtoupper($rand(['BP', 'OF', 'SP', 'AF', 'TB', 'RH'])) . '-' . random_int(1000, 9999); }
            if ($has($label, ['invoice number', 'invoice no', 'invoice #'])) { return $code('INV'); }
            if ($has($label, ['po number', 'purchase order'])) { return $code('PO'); }
            if ($has($label, ['quote number', 'quote no', 'quote #'])) { return $code('QT'); }
            if ($has($label, ['order']) && $has($label, ['number', ' no', '#'])) { return $code('ORD'); }
            if ($has($label, ['reference', 'ref no', 'ref number', 'ticket number', 'case number', 'job number', 'work order number'])) { return $code('REF'); }
            if ($has($label, ['registration', 'rego', 'number plate', 'plate', 'licence plate', 'license plate']) && !$has($label, ['template'])) { return strtoupper($rand(['ABC', 'XYZ', 'QRS', 'JKL', 'MNP', 'TRK'])) . '-' . random_int(100, 999); }
            if ($has($label, ['vin', 'chassis'])) { return strtoupper(substr(bin2hex(random_bytes(9)), 0, 17)); }
            if ($has($label, ['member number'])) { return 'M' . random_int(1000000, 9999999); }
            if ($has($label, ['policy number'])) { return 'POL-' . random_int(100000, 999999); }
            if ($has($label, ['account number', 'receiving account', 'current account'])) { return (string) random_int(10000000, 99999999); }
            if ($has($label, ['account reference']) || preg_match('/\b(hin|srn)\b/', $label)) { return 'X' . random_int(100000000, 999999999); }
            if ($has($label, ['abn'])) { return random_int(10, 99) . ' ' . random_int(100, 999) . ' ' . random_int(100, 999) . ' ' . random_int(100, 999); }
            if ($fid === 'account' || $label === 'account') { return $rand($P['accountLabels']) . ' ····' . random_int(1000, 9999); }
            // ── Relationship / short descriptors ──
            if ($has($label, ['relationship'])) { return $rand(['Spouse', 'Parent', 'Sibling', 'Partner', 'Child', 'Friend']); }
            // ── New app-pack identity/domain fields (hospitality, retail, trades, property, pets, farm) ──
            if ($has($label, ['pet name'])) { return pickSeq($P['petNames'], $formName, 'petname', $i); }
            if ($has($label, ['breed'])) { return pickSeq($P['petBreeds'], $formName, 'breed', $i); }
            if ($has($label, ['property name'])) { return pickSeq($P['propertyNames'], $formName, 'propname', $i); }
            if ($has($label, ['space name'])) { return pickSeq($P['venueSpaces'], $formName, 'space', $i); }
            if ($has($label, ['package name'])) { return pickSeq($P['caterPackages'], $formName, 'pkg', $i); }
            if ($has($label, ['event name'])) { return pickSeq($P['eventNames'], $formName, 'event', $i); }
            if ($has($label, ['project name'])) { return pickSeq($P['projectNames'], $formName, 'proj', $i); }
            if ($has($label, ['issue title'])) { return pickSeq($P['defectTitles'], $formName, 'defect', $i); }
            if ($has($label, ['variation title'])) { return pickSeq($P['variationTitles'], $formName, 'variation', $i); }
            if ($has($label, ['program name'])) { return pickSeq($P['fitPrograms'], $formName, 'program', $i); }
            if ($has($label, ['team name'])) { return pickSeq($P['crewNames'], $formName, 'crew', $i); }
            if ($has($label, ['block name', 'paddock name', 'field name'])) { return pickSeq($P['paddockNames'], $formName, 'paddock', $i); }
            if ($has($label, ['machine name', 'asset name', 'equipment name']) || ($has($label, ['machine']) && $has($label, ['name']))) { return pickSeq($P['machineNames'], $formName, 'machine', $i); }
            if ($has($label, ['table number'])) { return 'Table ' . ($i + 1); }
            if ($label === 'task' || $has($label, ['task name'])) { return pickSeq($P['caterTasks'], $formName, 'task', $i); }
            // "Assigned to" is a worker ref; route early so a form named "...Production..." (contains
            // the "product" exclusion substring) still resolves it to a person rather than null.
            if ($has($label, ['assigned to', 'assignee', 'assigned technician'])) { return pickRef($P['namesStaff'], $formName, 'assignee', $i, 5); }
            if ($has($label, ['business name']) && $has($formName, ['subcontractor'])) { return pickSeq($P['tradeCompanies'], $formName, 'trade', $i); }
            if ($has($label, ['material']) && !$has($label, ['materials used', 'raw material', 'material type'])) { return pickSeq($P['buildMaterials'], $formName, 'material', $i); }
            if ($has($label, ['part name']) && $has($formName, ['parts order', 'repair', 'device'])) { return pickSeq($P['electronicsParts'], $formName, 'epart', $i); }
            if ($label === 'prep item' || $has($label, ['prep item'])) { return pickSeq($P['prepItems'], $formName, 'prep', $i); }
            if ($label === 'supply item' || $has($label, ['supply item'])) { return pickSeq($P['stayReadySup'], $formName, 'supply', $i); }
            if ($label === 'ingredient' || $has($label, ['ingredient'])) { return pickSeq($P['prepGrillFlat'], $formName, 'ingredient', $i); }
            if ($has($label, ['vehicle']) && !$has($label, ['vehicle name', 'vehicle model', 'vehicle type', 'make'])) { return pickSeq($P['fleetNames'], $formName, 'veh', $i); }
            // ── Domain nouns (form context matters) ──
            if ($has($label, ['make and model', 'make/model', 'make & model', 'vehicle model']) || ($has($label, ['make']) && $has($label, ['model']))) { return pickSeq($P['makeModels'], $formName, 'vehicle', $i); }
            if ($has($label, ['make']) && !$has($label, ['maker', 'remake'])) { return explode(' ', (string) pickSeq($P['makeModels'], $formName, 'vehicle', $i), 2)[0]; }
            if ($has($label, ['model'])) { $mm = explode(' ', (string) pickSeq($P['makeModels'], $formName, 'vehicle', $i), 2); return $mm[1] ?? 'Corolla'; }
            if ($has($label, ['vehicle name'])) { return pickSeq($P['fleetNames'], $formName, 'vname', $i); }
            if ($has($label, ['crop'])) { return pickSeq($P['crops'], $formName, 'crop', $i); }
            if ($has($label, ['product used', 'chemical', 'herbicide', 'pesticide', 'fungicide'])) { return pickSeq($P['chemicals'], $formName, 'chem', $i); }
            if ($has($label, ['fund']) && !$has($label, ['refund'])) { return pickSeq($P['superFunds'], $formName, 'fund' . $fid, $i); }
            if ($has($label, ['custodian'])) { return pickSeq($P['custodians'], $formName, 'cust' . $fid, $i); }
            if ($has($label, ['course', 'program']) && !$has($label, ['programme note'])) { return pickSeq($P['courses'], $formName, 'course', $i); }
            if ($has($label, ['document name', 'file name', 'report name'])) { return pickSeq($P['docNames'], $formName, 'doc', $i); }
            if ($has($label, ['service']) && !$has($label, ['customer service', 'service type', 'self-service', 'services statement', 'services we', 'services provide'])) { return pickSeq($P['salonServices'], $formName, 'service', $i); }
            if ($fid === 'item' || $label === 'item' || $has($label, ['line item'])) { return $has($formName, ['budget', 'event']) ? null : pickSeq($P['plumbItems'], $formName, 'item', $i); }
            if ($has($label, ['part name']) || ($has($label, ['part']) && !$has($label, ['participant', 'party', 'department', 'apartment']))) { return $rand($P['partsAuto']); }
            if ($has($label, ['product'])) { return $has($formName, ['sale', 'retail', 'salon', 'boutique']) ? pickSeq($P['salonProducts'], $formName, 'product', $i) : pickSeq($P['productsHW'], $formName, 'product', $i); }
            if ($has($label, ['stock']) && $has($label, ['name'])) { return pickSeq($P['productsHW'], $formName, 'product', $i); }
            if ($has($label, ['supplier', 'vendor']) && !$has($label, ['supplier name'])) {
                if ($has($formName, ['parts order', 'repair', 'device'])) { return pickRef($P['electronicsSuppliers'], $formName, 'supplier', $i, 5); }
                if ($has($formName, ['parts used', ' used', 'vehicle', 'mechanic', 'workshop', 'auto'])) { return pickRef($P['autoSuppliers'], $formName, 'supplier', $i, 5); }
                if ($has($formName, ['maintenance'])) { return pickRef($P['workshops'], $formName, 'supplier', $i, 6); }
                if ($has($formName, ['delivery', 'site'])) { return pickRef($P['buildingSuppliers'], $formName, 'supplier', $i, 6); }
                if ($has($formName, ['parts & materials', 'material', 'request', 'plumb'])) { return pickRef($P['plumbSuppliers'], $formName, 'supplier', $i, 5); }
                return pickRef($P['companies'], $formName, 'supplier', $i, 6);
            }
            if ($has($label, ['supplier name', 'company name', 'business', 'employer', 'agency', 'manufacturer', 'brand', 'organization', 'organisation']) && !$has($label, ['contact'])) {
                if ($has($label, ['organization', 'organisation']) && random_int(0, 9) < 4) { return null; }
                return pickSeq($P['companies'], $formName, 'company', $i);
            }
            if ($has($label, ['address', 'street', 'site address'])) { return $addr(); }
            if ($has($label, ['location'])) {
                if ($has($formName, ['incident', 'event', 'safety', 'hazard'])) { return $rand($P['venueSpots']); }
                return pickSeq($P['warehouseLoc'], $formName, 'loc', $i);
            }
            if ($has($label, ['unit', 'room', 'apartment', 'apt'])) { return random_int(0, 4) === 0 ? null : pickSeq($P['unitRooms'], $formName, 'unit', $i); }
            if ($label === 'reason' || $has($label, ['reason /', 'reason / reference'])) { return $has($formName, ['leave']) ? $rand($P['leaveReasons']) : $rand($P['movementReasons']); }
            if ($has($label, ['escalated to', 'escalate to'])) { return pickSeq($P['escalationTargets'], $formName, 'esc', $i); }
            // ── Title / subject registers (unique per form, domain-appropriate) ──
            if ($has($label, ['bug title'])) { return pickSeq($P['bugTitles'], $formName, 'title', $i); }
            if ($has($label, ['feature title'])) { return pickSeq($P['featureTitles'], $formName, 'title', $i); }
            if ($has($label, ['article title']) || ($has($formName, ['knowledge']) && $has($label, ['title']))) { return pickSeq($P['kbTitles'], $formName, 'title', $i); }
            if ($has($label, ['subject']) && $has($formName, ['ticket', 'support'])) { return pickSeq($P['ticketSubjects'], $formName, 'subject', $i); }
            if ($has($label, ['topic', 'session title'])) { return pickSeq($P['sessionTitles'], $formName, 'title', $i); }
            if ($has($label, ['job title']) && !$has($formName, ['application', 'candidate', 'interview'])) { return pickSeq($P['tradeJobs'], $formName, 'jobtitle', $i); }
            if ($has($label, ['deal title'])) { return pickSeq($P['companies'], $formName, 'deal', $i) . ' ' . pickSeq($P['dealSuffix'], $formName, 'dealsfx', $i); }
            if ($has($label, ['subject']) && $has($formName, ['activity'])) { return pickSeq($P['activityAll'], $formName, 'subject', $i); }
            // ── People (drawn without replacement; staff pool for worker-rosters/references) ──
            if ($has($ctx, ['name', 'client', 'customer', 'patient', 'contact', 'tenant', 'stylist', 'technician', 'provider', 'staff', 'assigned', 'attendee', 'applicant', 'employee', 'owner', 'manager', 'inspector', 'reporter', 'reviewer', 'interviewer', 'witness', 'author', 'submitter', 'escalated by', 'requested by', 'principal', 'agent', 'advisor', 'adviser', 'driver', 'walker', 'instructor', 'tutor', 'operator', 'groomer', 'cleaner', 'checked by', 'received by', 'guardian'])
                && !$has($ctx, ['file', 'username', 'filename', 'fund', 'company', 'business', 'document', 'product', 'course', 'account', 'deal', 'vehicle', 'material', 'service', 'supplier', 'location', 'title', 'subject', 'topic', 'crop'])) {
                $isRef = $has($label, ['technician', 'inspector', 'assigned', 'assignee', 'reporter', 'handled', 'escalated to', 'escalate to', 'advisor', 'adviser', 'agent', 'author', 'interviewer', 'reviewer', 'manager', 'driver', 'walker', 'instructor', 'tutor', 'requested by', 'operator', 'groomer', 'lead cleaner', 'checked by', 'received by'])
                    && !($roster && $has($label, ['name']));
                $slot = preg_match('/(\d+)/', $label . ' ' . $fid, $mm) ? $mm[0] : '';
                if ($isRef && $slot === '') {
                    $full = pickRef($P['namesStaff'], $formName, 'worker', $i, 5);
                } elseif ($has($label, ['witness'])) {
                    $full = pickSeq($P['namesStaff'], $formName, 'wit' . $fid, $i);
                } else {
                    $pool = $roster ? $P['namesStaff'] : $P['namesPrimary'];
                    $full = $slot !== '' ? pickSeq($pool, $formName, 'bene' . $fid, $i) : pickSeq($pool, $formName, 'fullname', $i);
                }
                $full = (string) $full;
                if ($has($label, ['first', 'given'])) { return explode(' ', $full)[0]; }
                if ($has($label, ['last', 'surname', 'family'])) { return explode(' ', $full)[1] ?? 'Smith'; }
                return $full;
            }
            if ($has($label, ['title', 'subject', 'headline'])) { return pickSeq($P['genericTitles'], $formName, 'title', $i); }
            return null; // leave unknown short_text empty — never a placeholder string
        case 'long_text':
            if ($has($label, ['address'])) { return $addr(); }
            if ($has($label, ['complaint', 'fault', 'symptom', 'work requested'])) { return pickSeq($P['complaints'], $formName, 'complaint', $i); }
            if ($has($label, ['work done', 'work performed', 'resolution', 'action taken']) && !$has($formName, ['incident', 'care', 'pet', 'walk'])) { return pickSeq($P['workDone'], $formName, 'workdone', $i); }
            if ($has($label, ['reason for visit'])) { return pickSeq($P['clinicReasons'], $formName, 'reason', $i); }
            if ($has($label, ['action', 'next steps']) && $has($formName, ['follow'])) { return pickSeq($P['clinicActions'], $formName, 'action', $i); }
            if ($has($label, ['materials used'])) { return pickSeq($P['plumbItems'], $formName, 'matused', $i) . ', ' . pickSeq($P['plumbItems'], $formName, 'matused2', $i); }
            // These are refined by coherencePass (category / status coherent) — leave empty here.
            if ($has($label, ['description']) && $has($formName, ['maintenance', 'expense', 'claim'])) { return null; }
            if ($has($label, ['notes']) && $has($formName, ['appointment'])) { return null; }
            if ($has($label, ['description']) && $has($formName, ['job'])) { return pickSeq($P['jobDesc'], $formName, 'jobdesc', $i); }
            // ── New app-pack order/ticket line items + domain notes (refined further in coherencePass) ──
            if ($fid === 'items_summary' || $fid === 'ticket_items') { return pickSeq($P['orderLinesFast'], $formName, 'oline', $i); }
            if ($fid === 'items' || $label === 'items') { return $has($formName, ['cafe', 'coffee', 'brew']) ? pickSeq($P['cafeOrderLines'], $formName, 'cline', $i) : pickSeq($P['dishTickets'], $formName, 'dish', $i); }
            if ($has($label, ['work completed']) && $has($formName, ['diary', 'site'])) { return pickSeq($P['siteActivities'], $formName, 'siteact', $i); }
            if ($has($label, ['homework'])) { return pickSeq($P['homeworkNotes'], $formName, 'hw', $i); }
            if ($has($label, ['notes']) && $has($formName, ['progress note'])) { return pickSeq($P['tutorProgress'], $formName, 'tprog', $i); }
            return pickSeq($P['genericNotes'], $formName, $fid, $i);
        case 'email':
            return strtolower(str_replace(' ', '.', (string) pickSeq($P['namesPrimary'], $formName, 'email', $i))) . '@example.com';
        case 'phone':
            return '(555) 555-' . str_pad((string) ((seedHash($formName . 'phone') % 8500) + 1000 + $i), 4, '0', STR_PAD_LEFT);
        case 'url':
            return 'https://example.com/' . random_int(100, 999);
        case 'number': {
            $min = isset($props['min']) ? (int) $props['min'] : null;
            $max = isset($props['max']) ? (int) $props['max'] : null;
            // ── New app-pack numeric ranges (must precede the generic hour/duration/money rules) ──
            if ($has($label, ['hourly rate']) || ($has($label, ['rate']) && $has($label, ['hour']))) {
                if ($has($formName, ['space', 'venue', 'hall', 'room', 'hire', 'court', 'studio'])) { return random_int(80, 600); }
                if ($has($formName, ['tutor', 'lesson', 'coach'])) { return random_int(35, 90); }
                return random_int(40, 150);
            }
            if ($has($label, ['party size'])) { return random_int(2, 8); }
            if ($has($label, ['guest count', 'number of guests'])) { return $has($formName, ['catering', 'event']) ? random_int(20, 180) : random_int(1, 8); }
            if ($has($label, ['covers'])) { return random_int(45, 110); }
            if ($has($label, ['capacity', 'seats'])) {
                if ($has($formName, ['table'])) { return random_int(2, 10); }
                if ($has($formName, ['space', 'venue', 'room', 'hall', 'court', 'studio'])) { return random_int(30, 300); }
            }
            if ($has($label, ['body fat'])) { return random_int(12, 34); }
            if (($has($label, ['weight']) && $has($label, ['kg']))) { return random_int(55, 110); }
            if ($has($label, ['duration']) && $has($label, ['hour'])) { return random_int(1, 6); }
            if ($has($label, ['area']) && $has($label, ['hectare', ' ha'])) { return random_int(5, 120); }
            if ($has($label, ['year']) && !$has($label, ['years of service', 'tenure', 'fiscal'])) { return random_int(2005, 2024); }
            if ($has($label, ['odometer', 'mileage', 'kms', ' km'])) { return random_int(15, 190) * 1000; }
            if ($has($label, ['duration', 'minute', 'mins'])) { return $rand([15, 30, 45, 60, 90, 120]); }
            if ($has($label, ['hour'])) { return random_int(1, 8); }
            if ($has($label, ['lead time', 'lead-time'])) { return random_int(1, 14); }
            if ($has($label, ['tenure', 'years of service'])) { return random_int(1, 12); }
            if ($has($label, ['percentage', 'percent'])) { return random_int(1, 100); }
            if ($has($label, ['total days', 'number of days'])) { return random_int(1, 10); }
            if ($has($label, ['quantity', 'qty'])) {
                if ($has($formName, ['sale'])) { return random_int(1, 3); }
                if ($has($formName, ['parts', 'materials', 'line item', ' used'])) { return random_int(1, 6); }
                return random_int(1, 40);
            }
            if ($has($label, ['reorder', 'on hand', 'on-hand', 'stock on hand', 'units', 'par level', 'current count'])) { return random_int(0, 80); }
            if ($has($label, ['score', 'rating', 'satisfaction', 'skills', 'communication', 'culture fit', 'problem solving', 'knowledge', 'quality of work', 'productivity', 'teamwork', 'initiative', 'goal progress', 'progress'])) {
                $mx = ($max !== null && $max > 0) ? $max : 5;
                $mn = ($min !== null && $min > 0) ? $min : 1;
                return random_int(max($mn, (int) ceil($mx * 0.4)), $mx);
            }
            $m = seedMoney($label, $formName, $finance);
            if ($m !== null) { return $m; }
            if ($has($label, ['age'])) { return random_int(18, 75); }
            if ($has($label, ['count'])) { return random_int(0, 80); }
            if ($max !== null && $min !== null && $max > $min) { return random_int($min, $max); }
            if ($max !== null && $max > 0) { return random_int($min ?? 0, $max); }
            return random_int(1, 100);
        }
        case 'dropdown':
        case 'multiple_choice':
            if ($has($label, ['goals met'])) {
                $w = ['met', 'met', 'met', 'met', 'exceeded', 'exceeded', 'partially_met', 'partially_met', 'not_met'];
                $pick = $w[seedHash($formName . 'goals' . $i) % count($w)];
                foreach ($opts as $o) { $ov = is_array($o) ? ($o['value'] ?? null) : $o; if ($ov === $pick) { return $pick; } }
            }
            return $optValue($opts);
        case 'checkboxes': {
            if (empty($opts)) { return null; }
            $val = static fn ($o) => is_array($o) ? ($o['value'] ?? null) : $o;
            if (count($opts) === 1) {
                // Single-option toggles (availability / follow-up / consent): leave a realistic share off.
                $p = 70;
                if ($has($label, ['follow'])) { $p = 30; }
                elseif ($has($label, ['availability'])) { $p = 72; }
                elseif ($has($label, ['consent', 'confirm', 'over 18', 'declaration'])) { $p = 90; }
                return random_int(1, 100) <= $p ? array_values(array_filter([$val($opts[0])])) : [];
            }
            if ($has($label, ['policy', 'acknowledg'])) {
                if (random_int(1, 100) <= 65) { return array_values(array_filter(array_map($val, $opts))); }
                $shuf = $opts; shuffle($shuf); $n = random_int(2, min(4, count($shuf)));
                return array_values(array_filter(array_map($val, array_slice($shuf, 0, $n))));
            }
            $picked = [];
            foreach ($opts as $o) { if (random_int(0, 1)) { $picked[] = $val($o); } }
            if (empty($picked)) { $picked[] = $val($opts[0]); }
            return array_values(array_filter($picked));
        }
        case 'date':
            return seedDate($label, $formName);
        case 'datetime': {
            $days = $has($ctx, ['due', 'scheduled', 'expected', 'next', 'follow'])
                ? random_int(-2, 14)
                : random_int(-20, 5);
            return date('Y-m-d\TH:i', strtotime("$days days"));
        }
        case 'time':
            return str_pad((string) random_int(8, 18), 2, '0', STR_PAD_LEFT) . ':' . $rand(['00', '15', '30', '45']);
        case 'rating':
        case 'scale':
        case 'nps': {
            $max = isset($props['max']) ? (int) $props['max'] : ($type === 'nps' ? 10 : 5);
            $min = isset($props['min']) ? (int) $props['min'] : ($type === 'nps' ? 0 : 1);
            return random_int(max($min, (int) ceil($max * 0.5)), $max); // skew positive
        }
        case 'boolean':
        case 'yes_no':
            return (bool) random_int(0, 1);
        case 'location':
            if ($has($label, ['destination'])) { return $rand($P['destinations']); }
            return $addr();
        case 'linked_record': {
            $target = $props['targetFormId'] ?? null;
            if ($target && !empty($seeded[$target])) {
                return $seeded[$target][array_rand($seeded[$target])];
            }
            return null;
        }
        case 'file_upload':
        case 'signature':
        case 'statement':
        case 'welcome_screen':
        case 'thank_you':
        case 'hidden':
        case 'calculated':
            return null;
        default:
            return null;
    }
}

/** Substring keyword match helper (shared by genValue + coherencePass). */
function hasKw(string $s, array $kw): bool
{
    foreach ($kw as $k) {
        if ($k !== '' && str_contains($s, $k)) { return true; }
    }
    return false;
}

/** Deterministic unsigned hash so per-(form,salt) sequences are stable within a seed run. */
function seedHash(string $s): int
{
    return (int) sprintf('%u', crc32($s));
}

/**
 * Draw the i-th item from a pool WITHOUT replacement within a form: a per-form offset plus the row
 * index walks the pool, so a form's visible list never repeats (as long as rows <= pool size) and two
 * different forms take different windows. Used for person/company/title fields.
 */
function pickSeq(array $pool, string $formName, string $salt, int $i)
{
    $n = count($pool);
    if ($n === 0) { return null; }
    $off = seedHash($formName . '|' . $salt) % $n;
    return $pool[($off + $i) % $n];
}

/**
 * Draw from a SMALL slice of a pool WITH repetition — for worker references (technician/assignee)
 * where a handful of names should recur across rows so "by technician" counts vary (4/3/2/2), not
 * a distinct person on every row.
 */
function pickRef(array $pool, string $formName, string $salt, int $i, int $k = 5)
{
    $small = array_slice($pool, 0, min($k, count($pool)));
    $n = count($small);
    if ($n === 0) { return null; }
    return $small[seedHash($formName . '|' . $salt . '|' . $i) % $n];
}

/** Realistic money magnitude by label semantics (or null when the label isn't a money field). */
function seedMoney(string $label, string $formName, bool $finance): ?int
{
    $r = static fn (int $a, int $b) => random_int($a, $b);
    if (hasKw($label, ['net worth', 'net assets', 'liquid net worth', 'liquid assets'])) { return random_int(0, 3) === 0 ? $r(120, 800) * 10000 : $r(30, 99) * 10000; }
    if (hasKw($label, ['annual income', 'income'])) { return random_int(0, 6) === 0 ? $r(220, 1200) * 1000 : $r(60, 190) * 1000; }
    if (hasKw($label, ['salary'])) { return $r(55, 160) * 1000; }
    if (hasKw($label, ['estimated balance'])) { return random_int(0, 4) === 0 ? $r(200, 500) * 1000 : $r(20, 199) * 1000; }
    if (hasKw($label, ['contract value', 'policy value', 'estimated policy'])) { return $r(25, 500) * 1000; }
    if (hasKw($label, ['portfolio', 'aum', 'assets under', 'account value', 'current aum'])) { return $r(10, 500) * 10000; }
    if (hasKw($label, ['estimated value', 'estimated account'])) { return $finance ? $r(10, 500) * 10000 : $r(15, 2000) * 10; }
    if (hasKw($label, ['partial rollover', 'partial amount'])) { return $r(10, 150) * 1000; }
    if (hasKw($label, ['unit cost', 'unit price'])) {
        if (hasKw($formName, ['parts', 'materials', ' used'])) { return random_int(0, 3) === 0 ? $r(120, 450) : $r(5, 120); }
        return random_int(0, 3) === 0 ? $r(60, 200) : $r(2, 60);
    }
    if (hasKw($label, ['sell price', 'retail price'])) { return $r(5, 300); }
    if (hasKw($label, ['line total'])) { return $r(50, 4000); }
    if (hasKw($label, ['labour', 'labor'])) { return $r(100, 2500); }
    if (hasKw($label, ['parts amount'])) { return $r(50, 2500); }
    if (hasKw($label, ['tax'])) { return $r(50, 1500); }
    if (hasKw($label, ['subtotal', 'total'])) { return $r(500, 20000); }
    // ── New app-pack money magnitudes (menus, per-person, per-visit, electronics) ──
    if (hasKw($label, ['base price'])) { return $r(2, 20); }
    if (hasKw($label, ['price per person'])) { return $r(28, 120); }
    if (hasKw($label, ['price'])) {
        if (hasKw($formName, ['menu item'])) { return $r(3, 14); }
        if (hasKw($formName, ['service'])) { return $r(25, 350); }
        if (hasKw($formName, ['appointment'])) { return $r(40, 300); }
        if (hasKw($formName, ['cleaning'])) { return $r(120, 380); }
        return $r(10, 400);
    }
    if (hasKw($label, ['quote']) && hasKw($formName, ['repair', 'device'])) { return $r(80, 600); }
    if (hasKw($label, ['charge'])) { return hasKw($formName, ['walk', 'visit', 'pet']) ? $r(15, 70) : $r(20, 300); }
    if (hasKw($label, ['amount'])) {
        if (hasKw($formName, ['sale'])) { return $r(20, 150); }
        if (hasKw($formName, ['refund', 'return'])) { return $r(20, 400); }
        if (hasKw($formName, ['expense', 'claim'])) { return $r(30, 2500); }
        return $r(500, 15000);
    }
    if (hasKw($label, ['monthly limit', 'budget'])) { return $r(1000, 20000); }
    if (hasKw($label, ['fuel'])) { return $r(20, 250); }
    if (hasKw($label, ['fee'])) {
        if (hasKw($formName, ['lesson'])) { return $r(35, 110); }
        if (hasKw($formName, ['session'])) { return $r(20, 90); }
        return $r(200, 5000);
    }
    if (hasKw($label, ['cost'])) {
        if (hasKw($formName, ['parts order'])) { return $r(10, 300); }
        return hasKw($formName, ['work order', 'maintenance']) ? $r(100, 2500) : $r(50, 2000);
    }
    if (hasKw($label, ['value'])) { return $finance ? $r(10, 500) * 10000 : $r(500, 15000); }
    return null;
}

/** Semantics-aware date by label: log dates stay past, planning dates lean future, expiries spread. */
function seedDate(string $label, string $formName): string
{
    $mk = static fn (int $d) => date('Y-m-d', strtotime("$d days"));
    if (hasKw($label, ['birth', 'dob'])) { return date('Y-m-d', strtotime('-' . random_int(7300, 25500) . ' days')); }
    if (hasKw($label, ['next review'])) { $r = random_int(0, 9); return $mk($r < 2 ? random_int(5, 60) : ($r === 2 ? random_int(-20, -1) : random_int(200, 400))); }
    if (hasKw($label, ['expiry', 'expire', 'expiration', 'valid until', 'valid', 'renewal', 'renew'])) { $r = random_int(0, 9); return $mk($r < 2 ? random_int(-90, 55) : random_int(60, 540)); }
    if (hasKw($label, ['expected', 'delivery'])) { return $mk(random_int(-10, 40)); }
    if (hasKw($label, ['due'])) { return $mk(random_int(-25, 35)); }
    if (hasKw($label, ['reported'])) { $r = random_int(0, 9); return $mk($r < 4 ? random_int(-7, 0) : ($r < 8 ? random_int(-30, -8) : random_int(-75, -31))); }
    if (hasKw($label, ['expense date', 'claim date', 'purchase date'])) { $r = random_int(0, 9); return $mk($r < 3 ? random_int(-14, 0) : random_int(-60, -1)); }
    if (hasKw($label, ['scheduled', 'appointment', 'appt', 'follow-up date', 'followup'])) { $r = random_int(0, 9); return $mk($r < 4 ? random_int(0, 7) : ($r < 6 ? random_int(-14, -1) : random_int(8, 21))); }
    if (hasKw($label, ['visit'])) { return $mk(random_int(-30, 7)); }
    if (hasKw($label, ['review date'])) { return $mk(random_int(-90, -1)); }
    if (hasKw($label, ['acknowledg', 'declaration', 'nomination', 'effective']) || (hasKw($label, ['sign']) && !hasKw($label, ['assign']))) { return $mk(random_int(-30, 0)); }
    if (hasKw($label, ['last reviewed', 'reviewed'])) { return $mk(random_int(-90, -1)); }
    if (hasKw($label, ['inspection'])) { $r = random_int(0, 9); return $mk($r < 5 ? random_int(-30, 0) : random_int(-90, -31)); }
    if (hasKw($label, ['date in', 'date_in'])) { return $mk(random_int(-25, 0)); }
    if (hasKw($label, ['client since', 'member since', 'lease', 'hire'])) { return $mk(-random_int(30, 900)); }
    if (hasKw($label, ['availability', 'earliest', 'start date'])) { return $mk(random_int(-20, 25)); }
    if (hasKw($label, ['incident', 'received', 'raised', 'issue date', 'order date', 'payment date', 'sale date', 'audit', 'interview', 'escalation', 'activity', 'last day', 'declaration date'])) { return $mk(random_int(-60, -1)); }
    if (hasKw($label, ['date'])) {
        // A bare "Date" on a booking/appointment form leans upcoming; elsewhere (activity/movement
        // logs) it skews to the last two weeks so "this week" KPIs read as a live business.
        if (hasKw($formName, ['appointment', 'booking', 'appt'])) { $r = random_int(0, 9); return $mk($r < 4 ? random_int(0, 7) : ($r < 6 ? random_int(-14, -1) : random_int(8, 21))); }
        $r = random_int(0, 9);
        return $mk($r < 5 ? -random_int(0, 13) : -random_int(14, 45));
    }
    return $mk(random_int(-30, 14));
}

/**
 * Single source of the demo vocabularies. Cached so the arrays are built once per run. All strings
 * are ASCII (no apostrophes) to keep the seeder encoding-safe.
 */
function seedPools(): array
{
    static $P = null;
    if ($P !== null) { return $P; }

    $salonServiceMeta = [
        'Cut & Blow Dry' => ['hair', 55], 'Ladies Cut & Finish' => ['hair', 70], 'Mens Cut' => ['hair', 40],
        'Blow Dry & Style' => ['hair', 45], 'Beard Trim' => ['hair', 30],
        'Full Head Colour' => ['colour', 130], 'Half Head Foils' => ['colour', 150], 'Balayage' => ['colour', 220],
        'Highlights' => ['colour', 175], 'Toner & Gloss' => ['colour', 60], 'Keratin Treatment' => ['colour', 260],
        'Gel Manicure' => ['nails', 45], 'Classic Pedicure' => ['nails', 55],
        'Facial Treatment' => ['skin', 95], 'Brow Shape & Tint' => ['skin', 35],
        'Deep Tissue Massage' => ['massage', 120], 'Relaxation Massage' => ['massage', 100],
    ];
    $salonCat = [];
    $salonPrice = [];
    foreach ($salonServiceMeta as $nm => $meta) { $salonCat[$nm] = $meta[0]; $salonPrice[$nm] = $meta[1]; }

    $activityByType = [
        'call' => ['Intro call with prospect', 'Follow-up call: pricing', 'Discovery call', 'Check-in call', 'Closing call'],
        'email' => ['Follow-up email: proposal', 'Sent contract for signature', 'Pricing details emailed', 'Intro email and deck', 'Renewal reminder email'],
        'meeting' => ['Demo meeting', 'Quarterly business review', 'Kickoff meeting', 'On-site discovery', 'Contract walkthrough'],
    ];

    // ── New app-pack vocabularies (hospitality, retail, trades, property, pets, farm) ──
    // Item/product names keyed by their form's category value so name ↔ category stays coherent.
    $menuCafeByCat = [
        'coffee' => ['Espresso', 'Long Black', 'Flat White', 'Latte', 'Cappuccino', 'Mocha', 'Piccolo', 'Cold Brew', 'Iced Latte'],
        'tea' => ['English Breakfast', 'Earl Grey', 'Green Tea', 'Peppermint', 'Chai Latte'],
        'cold-drink' => ['Iced Chocolate', 'Lemonade', 'Sparkling Water', 'Orange Juice', 'Iced Tea'],
        'food' => ['Ham & Cheese Croissant', 'Banana Bread', 'Bacon & Egg Roll', 'Avocado Toast', 'Blueberry Muffin', 'Almond Croissant'],
        'retail-beans' => ['House Blend 250g', 'Single Origin 250g', 'Decaf 250g', 'House Blend 1kg'],
    ];
    $stockCafeByCat = [
        'beans' => ['House blend beans', 'Single origin beans', 'Decaf beans'],
        'milk' => ['Full cream milk', 'Skim milk', 'Oat milk', 'Almond milk', 'Soy milk'],
        'syrup' => ['Vanilla syrup', 'Caramel syrup', 'Hazelnut syrup'],
        'cups' => ['8oz cups', '12oz cups', 'Cup lids'],
        'food-prep' => ['Croissants', 'Muffins', 'Sourdough loaves'],
        'packaging' => ['Takeaway bags', 'Napkins', 'Carry trays'],
    ];
    $menuGrillByCat = [
        'burger' => ['Classic Cheeseburger', 'Bacon Deluxe', 'Double Stack', 'Crispy Chicken Burger', 'Veggie Burger', 'BBQ Bacon Burger'],
        'side' => ['Fries', 'Loaded Fries', 'Onion Rings', 'Coleslaw', 'Sweet Potato Fries'],
        'drink' => ['Cola', 'Lemonade', 'Chocolate Shake', 'Vanilla Shake', 'Bottled Water'],
        'dessert' => ['Apple Pie', 'Sundae', 'Choc Cookie'],
        'combo' => ['Classic Combo', 'Deluxe Combo', 'Kids Combo'],
    ];
    $prepGrillByCat = [
        'bun' => ['Brioche buns', 'Sesame buns', 'Gluten-free buns'],
        'patty' => ['Beef patties', 'Chicken fillets', 'Plant patties'],
        'sauce' => ['Burger sauce', 'BBQ sauce', 'Mayo', 'Ketchup'],
        'salad' => ['Lettuce', 'Tomatoes', 'Pickles', 'Sliced onion'],
        'packaging' => ['Burger boxes', 'Fry cartons', 'Napkins'],
        'drink' => ['Cola syrup', 'Cups', 'Lids'],
    ];
    $retailByCat = [
        'apparel' => ['Linen Shirt', 'Wool Scarf', 'Cotton Tote', 'Knit Beanie'],
        'homewares' => ['Ceramic Vase', 'Scented Candle', 'Throw Blanket', 'Serving Board'],
        'gifts' => ['Gift Card', 'Photo Frame', 'Gift Hamper'],
        'stationery' => ['A5 Notebook', 'Fountain Pen', 'Greeting Card'],
        'jewellery' => ['Silver Necklace', 'Gold Studs', 'Leather Bracelet'],
        'seasonal' => ['Holiday Wreath', 'Advent Calendar'],
    ];
    $cleaningSupByCat = [
        'chemicals' => ['All-purpose spray', 'Glass cleaner', 'Bathroom cleaner', 'Floor cleaner', 'Bleach'],
        'cloths-and-pads' => ['Microfibre cloths', 'Scourer pads', 'Mop heads'],
        'equipment' => ['Vacuum bags', 'Spray bottles', 'Buckets'],
        'consumables' => ['Bin liners', 'Paper towels', 'Disposable gloves'],
    ];
    $deviceByType = [
        'phone' => ['Apple|iPhone 14 Pro', 'Apple|iPhone 13', 'Samsung|Galaxy S23', 'Google|Pixel 7', 'Apple|iPhone 12'],
        'tablet' => ['Apple|iPad Air', 'Apple|iPad Pro 11', 'Samsung|Galaxy Tab S8'],
        'laptop' => ['Apple|MacBook Pro 14', 'Apple|MacBook Air', 'Dell|XPS 13', 'Lenovo|ThinkPad X1', 'HP|Spectre'],
        'desktop' => ['Dell|OptiPlex', 'HP|Pavilion', 'Apple|iMac 24'],
        'console' => ['Sony|PlayStation 5', 'Microsoft|Xbox Series X', 'Nintendo|Switch OLED'],
        'other' => ['Apple|Apple Watch', 'Bose|QC Headphones', 'GoPro|Hero 11'],
    ];
    $fleetMakeByType = [
        'ute' => ['Ford Ranger', 'Toyota HiLux', 'Isuzu D-Max', 'Mitsubishi Triton'],
        'van' => ['Toyota HiAce', 'Ford Transit', 'Hyundai iLoad', 'Renault Trafic'],
        'truck' => ['Isuzu N-Series', 'Hino 300', 'Fuso Canter', 'Isuzu F-Series'],
        'hatch' => ['Kia Cerato', 'Toyota Corolla', 'Mazda 3', 'Hyundai i30'],
        'wagon' => ['Subaru Outback', 'Toyota Camry', 'Skoda Octavia'],
        'car' => ['Toyota Corolla', 'Mazda 3', 'Hyundai i30', 'Kia Cerato'],
    ];
    $fitProgramGoal = [
        '12-Week Fat Loss' => 'fat-loss', 'Strength Foundations' => 'strength', 'Marathon Prep' => 'endurance',
        'Mobility Reset' => 'mobility', 'Powerlifting Block' => 'strength', 'Beginner Bootcamp' => 'fat-loss',
        'Post-Rehab Return' => 'rehab', 'Hypertrophy Builder' => 'muscle-gain', 'Core & Conditioning' => 'endurance',
        'Kettlebell Strength' => 'strength',
    ];
    $careDescByType = [
        'injury' => ['Small graze on the left front paw noticed mid-walk', 'Limping slightly on the back leg', 'Minor cut to the paw pad from the footpath', 'Scraped nose on a fence'],
        'escape-risk' => ['Slipped the collar near the park gate', 'Bolted after a passing dog', 'Dug under the side fence', 'Tried to jump the back gate'],
        'aggression' => ['Growled at another dog at the park', 'Snapped when approached by a stranger', 'Lunged at a passing cyclist', 'Resource-guarded a found ball'],
        'illness' => ['Vomited once early in the walk', 'Seemed lethargic and off food', 'Loose stools during the visit', 'Excessive panting in the heat'],
        'no-access' => ['Key not in the lockbox as arranged', 'Gate was bolted from the inside', 'Alarm was armed, could not enter', 'Nobody home and no key left'],
        'owner-note' => ['Owner requested extra playtime', 'Please use the harness, not the collar', 'Feed half a scoop after the walk', 'Drop the mail on the bench inside'],
    ];
    $careActionByType = [
        'injury' => ['Cleaned the wound and monitored', 'Cut the walk short and rested', 'Advised the owner to check with the vet', 'Applied first aid and noted for follow-up'],
        'escape-risk' => ['Secured with a backup lead and harness', 'Returned to the yard and checked fencing', 'Noted to use a martingale collar next time', 'Advised the owner to reinforce the gate'],
        'aggression' => ['Kept distance from other dogs', 'Muzzled for the rest of the walk', 'Walked a quieter route', 'Advised the owner on a trainer referral'],
        'illness' => ['Offered water and rested in the shade', 'Cut the visit short', 'Advised the owner to monitor overnight', 'Recommended a vet check'],
        'no-access' => ['Called the owner, no answer', 'Left a note and rescheduled', 'Waited 10 minutes then moved on', 'Logged the missed visit'],
        'owner-note' => ['Noted on the pet profile', 'Confirmed with the owner by text', 'Updated the care instructions', 'Acknowledged and actioned'],
    ];

    $P = [
        'namesPrimary' => [
            'Olivia Bennett', 'Liam Harper', 'Emma Sinclair', 'Noah Fletcher', 'Ava Whitfield', 'Ethan Marsh',
            'Sophia Delgado', 'Mason Reed', 'Isabella Cross', 'Lucas Hayes', 'Mia Donovan', 'Henry Nakamura',
            'Amelia Frost', 'Jack Osei', 'Charlotte Vance', 'Leo Abbott', 'Harper Quinn', 'Daniel Mercer',
            'Ella Rosenthal', 'Samuel Ford', 'Grace Okafor', 'Owen Bishop', 'Chloe Ramsey', 'Nathan Boyd',
            'Zoe Calderon', 'Julian Pryce', 'Layla Hoffman', 'Adrian Wells', 'Nora Bianchi', 'Caleb Stone',
            'Ruby Callahan', 'Elias Navarro', 'Hazel Trent', 'Marcus Webb', 'Priya Nair', 'Dana Whitlock',
            'Ivy Lawson', 'Felix Barron', 'Aria Solomon', 'Theo Ellison',
        ],
        'namesStaff' => [
            'Jake Morrison', 'Tom Wheeler', 'Sara Kim', 'Ben Castillo', 'Nina Patel', 'Cole Sanders',
            'Maya Brooks', 'Rhys Coleman', 'Tara Lindqvist', 'Victor Ortega', 'Georgia Pike', 'Anders Holt',
            'Kelly Doyle', 'Rafael Mendes', 'Bianca Nunez', 'Dylan Reyes', 'Fiona Walsh', 'Omar Haddad',
            'Sienna Park', 'Blake Turner', 'Yara Aziz', 'Hugo Larsen', 'Melissa Cho', 'Karl Jensen',
        ],
        'companies' => [
            'Acme Corp', 'Globex', 'Initech', 'Umbrella Co', 'Soylent Foods', 'Hooli', 'Stark Industries',
            'Wayne Enterprises', 'Wonka Inc', 'Cyberdyne Systems', 'Northwind Traders', 'Contoso Ltd',
            'Vandelay Industries', 'Massive Dynamic', 'Prestige Worldwide', 'Bluth Company', 'Pied Piper',
            'Sterling Cooper', 'Fabrikam', 'Aperture Labs', 'Tyrell Corp', 'Gringotts Bank',
        ],
        'partsAuto' => ['Brake Pads', 'Oil Filter', 'Spark Plug Set', 'Air Filter', 'Timing Belt', 'Alternator', 'Radiator Hose', 'Clutch Kit', 'Wiper Blades', 'Battery', 'Brake Disc', 'Fuel Pump'],
        'plumbItems' => ['15mm Copper Elbow', 'Tap Cartridge', 'PVC Coupling 40mm', 'Hot Water Tempering Valve', 'Flexible Hose 900mm', 'Toilet Cistern Kit', 'Basin Mixer Tap', 'Push-Fit Tee 20mm', 'Ball Float Valve', 'Compression Union 15mm', 'Pipe Lagging 2m', 'Isolating Valve', 'Waste Trap 40mm', 'Silicone Sealant'],
        'productsHW' => ['Copper Pipe 15mm', 'PVC Elbow Joint', 'Silicone Sealant', 'Ball Valve', 'Cable Ties (100pk)', 'LED Downlight', 'Extension Lead', 'Safety Gloves', 'Paint Roller Set', 'Masking Tape', 'Cordless Drill', 'Screw Assortment', 'Pipe Insulation', 'Junction Box', 'Wall Anchors (50pk)', 'Teflon Tape'],
        'salonProducts' => ['Shampoo', 'Conditioner', 'Styling Wax', 'Hair Serum', 'Heat Protection Spray', 'Dry Shampoo', 'Leave-in Treatment', 'Argan Hair Oil', 'Curl Cream', 'Gift Card', 'Hairspray', 'Colour-safe Shampoo', 'Deep Repair Mask', 'Sea Salt Spray'],
        'salonServices' => array_keys($salonServiceMeta),
        'salonServiceCat' => $salonCat,
        'salonServicePrice' => $salonPrice,
        'makeModels' => ['Toyota Corolla', 'Toyota Hilux', 'Mazda 3', 'Mazda CX-5', 'Honda Civic', 'Ford Ranger', 'Ford Focus', 'Volkswagen Golf', 'Hyundai i30', 'Nissan X-Trail', 'Subaru Outback', 'Kia Cerato', 'Mitsubishi Triton', 'Holden Commodore'],
        'superFunds' => ['AustralianSuper', 'Hostplus', 'REST Super', 'HESTA', 'UniSuper', 'Cbus', 'Aware Super', 'Australian Retirement Trust'],
        'custodians' => ['Fidelity', 'Charles Schwab', 'Vanguard', 'Empower', 'Principal', 'Voya', 'T. Rowe Price', 'TIAA'],
        'courses' => ['AWS Solutions Architect - Associate', 'Advanced React Workshop', 'PMP Certification Prep', 'Leadership Essentials', 'Excel for Analysts', 'ITIL Foundation', 'Scrum Master Certification', 'Public Speaking Masterclass', 'Data Privacy & GDPR', 'First Aid at Work', 'Google Analytics Certification', 'Financial Modelling Bootcamp', 'Design Systems Intensive', 'Negotiation Skills'],
        'docNames' => ['2023 Tax Return', 'Statement of Advice', 'Trust Deed', 'Insurance Policy Schedule', 'ID Verification', 'Annual Statement', 'Estate Plan Summary', 'Super Member Statement', 'Risk Profile Report', 'Fee Disclosure', 'Product Disclosure Statement', 'Beneficiary Form'],
        'tradeJobs' => ['Office fit-out', 'HVAC service', 'Hot water system install', 'Bathroom renovation', 'Leaking tap repair', 'Blocked drain clearing', 'Switchboard upgrade', 'Roof gutter replacement', 'Kitchen splashback tiling', 'Deck restoration', 'Split-system aircon install', 'Emergency burst pipe', 'Solar panel install', 'Fence repair'],
        'bugTitles' => ['Login fails on Android 14', 'API returns 500 on export', 'Dashboard chart renders blank in Safari', 'Password reset email never arrives', 'Attachment upload stalls at 99%', 'Dark mode text unreadable on invoices', 'Search returns no results for valid query', 'App crashes on startup after update', 'Timezone off by one on reports', 'Duplicate notifications on mobile', 'CSV export missing last column', 'Session expires too quickly', 'Broken image thumbnails in gallery', 'Form submit button unresponsive'],
        'featureTitles' => ['Add CSV export', 'Dark mode support', 'Bulk-edit records', 'Slack notifications', 'Custom report scheduling', 'Two-factor authentication', 'Recurring reminders', 'Kanban board view', 'Inline commenting', 'API webhooks', 'Custom dashboard widgets', 'Offline mode', 'Role-based permissions', 'Saved filters'],
        'kbTitles' => ['How to reset your password', 'Setting up two-factor authentication', 'Understanding your invoice', 'Troubleshooting sync errors', 'Refund policy explained', 'Getting started guide', 'Managing team members', 'Exporting your data', 'Connecting integrations', 'Billing FAQ', 'Keyboard shortcuts', 'Data retention overview', 'Changing your plan', 'Mobile app setup'],
        'ticketSubjects' => ['Cannot log in after password change', 'Charged twice this month', 'Order arrived damaged', 'App crashes on launch', 'Feature not working as expected', 'Need help with account setup', 'Payment declined repeatedly', 'Missing order confirmation', 'How do I cancel my plan', 'Data not syncing across devices', 'Unable to upload files', 'Wrong item shipped', 'Discount code not applying', 'Requesting a refund'],
        'sessionTitles' => ['Scaling live-event Wi-Fi', 'Designing inclusive keynotes', 'Sponsorships that actually convert', 'Crowd flow modelling 101', 'Hybrid events done right', 'Stage design on a budget', 'Accessibility for large venues', 'Data-driven event marketing', 'Sustainable event operations', 'Volunteer management at scale', 'Live captioning workflows', 'Post-event analytics', 'Ticketing that scales', 'Green room logistics'],
        'dealSuffix' => ['renewal', 'pilot', 'expansion', 'annual plan', 'upsell', 'onboarding'],
        'genericTitles' => ['Q3 planning', 'Weekly sync', 'Process update', 'Onboarding pack', 'Budget review', 'Vendor check-in', 'Status report', 'Kickoff notes', 'Policy update', 'Site walkthrough', 'Renewal review', 'Handover notes', 'Audit prep', 'Roadmap review'],
        'warehouseLoc' => ['Aisle 3, Bay B', 'Rack 12, Shelf 2', 'Mezzanine, Bin 7', 'Aisle 1, Bay A', 'Cold Store, Shelf 4', 'Rack 5, Shelf 1', 'Loading Bay Overflow', 'Aisle 7, Bay C', 'Rack 9, Shelf 3', 'Bulk Store, Pallet 12', 'Aisle 2, Bay D', 'Mezzanine, Bin 3'],
        'unitRooms' => ['Unit 1', 'Unit 2', 'Unit 3', 'Apt 4B', 'Apt 12A', 'Room 2', 'Room 5', 'Unit 7', 'Apt 3C', 'Townhouse 9', 'Unit 11', 'Studio 6'],
        'venueSpots' => ['Main stage', 'Hall B entrance', 'Registration desk', 'Loading dock', 'Car park level 2', 'Catering marquee', 'Green room', 'Backstage left', 'Foyer', 'Exhibitor hall', 'First-aid station', 'North gate'],
        'escalationTargets' => ['Tier 2 - Billing', 'Legal & Compliance', 'Engineering On-call', 'Priya Sharma (Senior Support)', 'Account Management', 'Product Team', 'Tier 3 - Infrastructure', 'Customer Success Lead'],
        'movementReasons' => ['Supplier delivery', 'Customer order', 'Cycle count adjustment', 'Customer return', 'Damaged in transit', 'Stocktake correction'],
        'accountLabels' => ['Roth IRA', 'Traditional IRA', 'Brokerage', '401(k)', 'Joint Taxable', 'SEP IRA'],
        'leaveReasons' => ['Family holiday', 'Medical appointment', 'Personal matters', 'Rest and recovery', 'Caring responsibilities', 'Interstate relocation'],
        'schedNotes' => ['Prefers morning slot', 'Room 2', 'Interpreter needed', 'New client paperwork emailed', 'Allergy noted on file', 'Running 10 min late', 'Requested same team member', 'Parking validated', 'Confirmed by SMS', 'First visit'],
        'genericNotes' => ['Logged for review.', 'Confirmed with the client.', 'No issues noted.', 'Follow-up scheduled.', 'Details added to the record.', 'Reviewed and approved.', 'Pending sign-off.', 'On track for the timeline.', 'Additional context noted.', 'Handled per procedure.', 'Flagged for this week.', 'Noted on the file.', 'Awaiting next steps.', 'Completed as requested.'],
        'complaints' => ['Grinding noise when braking at low speed', 'Coolant leak under the front of the engine', 'A/C blows warm air', 'Engine warning light on', 'Rough idle and stalling', 'Timing belt service due at 120k', 'Vibration through the steering at highway speed', 'Battery not holding charge', 'Clunking noise over bumps', 'Excessive exhaust smoke', 'Clutch slipping under load', 'Overheating in traffic'],
        'jobDesc' => ['Full inspection and quote for the works', 'Supply and install as per site assessment', 'Repair and test to manufacturer spec', 'Scheduled maintenance and service', 'Diagnose fault and rectify', 'Fit-out works across the site', 'Replace worn components and recommission', 'Make safe and provide report'],
        'workDone' => ['Replaced kitchen tap washer', 'HVAC quarterly filter service', 'Cleared blocked shower drain', 'Repaired leaking cistern', 'Replaced faulty power point', 'Serviced hot water unit', 'Patched and repainted ceiling', 'Refitted loose fence panel', 'Tested and reset switchboard', 'Replaced door lock and handle', 'Sealed bathroom silicone', 'Serviced split-system aircon'],
        'clinicReasons' => ['Annual check-up', 'Persistent cough for two weeks', 'Medication review', 'Sore lower back', 'Vaccination', 'Skin rash assessment', 'Blood pressure review', 'Follow-up on test results', 'Ear pain', 'Travel health advice', 'Minor injury', 'Fatigue and low energy'],
        'clinicActions' => ['Call patient re: lab results', 'Reschedule cleaning after cancellation', 'Confirm referral letter sent', 'Book blood test before review', 'Send prescription to pharmacy', 'Follow up on imaging report', 'Arrange specialist referral', 'Check wound healing progress', 'Confirm booster is due', 'Review medication adherence', 'Schedule annual health check', 'Discuss results by phone'],
        'maintByCat' => [
            'plumbing' => ['Kitchen tap leaking under sink', 'Hot water system not heating', 'Blocked shower drain', 'Running toilet cistern', 'Burst pipe in laundry'],
            'electrical' => ['Hallway light flickering', 'Power point not working in bedroom', 'Tripping circuit breaker', 'Smoke alarm chirping', 'Outdoor sensor light stuck on'],
            'appliance' => ['Dishwasher not draining', 'Oven not reaching temperature', 'Fridge seal split', 'Washing machine leaking', 'Rangehood fan noisy'],
            'structural' => ['Cracked plaster in living room', 'Sticking front door', 'Loose balcony railing', 'Water stain on ceiling', 'Warped skirting board'],
            'garden' => ['Back fence panel loose', 'Overgrown hedges need trimming', 'Broken sprinkler head', 'Blocked gutter downpipe', 'Retaining wall leaning'],
            'other' => ['General handyman visit requested', 'Squeaky garage door', 'Lock replacement needed', 'Pest inspection follow-up', 'Gate hinge needs adjusting'],
        ],
        'expenseByCat' => [
            'travel' => ['Flight MEL-SYD for Q3 client review', 'Airport taxi - client site visit', 'Train fare - regional site visit', 'Fuel reimbursement - site trips'],
            'meals' => ['Client lunch - Acme kickoff', 'Team dinner - sprint close', 'Coffee meeting with prospect', 'Working lunch - planning day'],
            'accommodation' => ['Hotel, 2 nights - trade show', 'Serviced apartment - regional install', 'Hotel - client onsite'],
            'supplies' => ['Standing desk riser', 'Printer toner restock', 'Stationery order', 'Whiteboard markers and pads'],
            'office' => ['Standing desk riser', 'Printer toner restock', 'Stationery order', 'Ergonomic chair mat'],
            'software' => ['SaaS renewal - design tools', 'IDE licence renewal', 'Cloud hosting top-up', 'Analytics subscription'],
            'technology' => ['Monitor for new starter', 'USB-C dock', 'Wireless keyboard and mouse', 'External SSD'],
            'training' => ['Conference ticket - DevWorld', 'Online course enrolment', 'Certification exam fee'],
            'client' => ['Client entertainment - dinner', 'Gift for client milestone', 'Event tickets - client hosting'],
            'other' => ['Courier fees', 'Parking - client visit', 'Bank fees reimbursement', 'Conference travel insurance'],
        ],
        'csGood' => ['Agent resolved my issue quickly', 'Great follow-up, thank you', 'Very helpful and patient support', 'Sorted on the first contact', 'Friendly and knowledgeable team'],
        'csBad' => ['Waited too long for a reply', 'Had to explain my problem three times', 'Issue still not fully resolved', 'Support was hard to reach', 'Felt passed around between agents'],
        'activityByType' => $activityByType,
        'activityAll' => array_merge($activityByType['call'], $activityByType['email'], $activityByType['meeting']),
        'plumbSuppliers' => ['Reece Plumbing', 'Tradelink', 'Bunnings Trade', 'Plumbers Supplies Co-op', 'Samios Plumbing Supplies', 'Kembla Trade'],
        'autoSuppliers' => ['Repco', 'Bapcor Trade', 'NAPA Auto Parts', 'Burson Auto Parts', 'Sprint Auto Spares', 'GPC Asia Pacific'],
        'fleetNames' => ['Van 1', 'Van 2', 'Ute 1', 'Ute 2', 'Truck 1', 'Truck 2', 'Wagon 1', 'Hatch 1', 'Van 3', 'Ute 3', 'Truck 3', 'Pool Car 1'],
        'crops' => ['Wheat', 'Barley', 'Canola', 'Sorghum', 'Cotton', 'Corn', 'Chickpeas', 'Oats', 'Lucerne', 'Sunflower'],
        'chemicals' => ['Roundup', 'Glyphosate 450', 'Sprayseed', '2,4-D Amine', 'Urea', 'MAP Fertiliser', 'Copper Fungicide', 'Sulfur Dust'],
        // ── New app-pack pools ──
        'menuCafeByCat' => $menuCafeByCat,
        'menuCafeFlat' => array_merge(...array_values($menuCafeByCat)),
        'menuGrillByCat' => $menuGrillByCat,
        'menuGrillFlat' => array_merge(...array_values($menuGrillByCat)),
        'stockCafeByCat' => $stockCafeByCat,
        'stockCafeFlat' => array_merge(...array_values($stockCafeByCat)),
        'prepGrillByCat' => $prepGrillByCat,
        'prepGrillFlat' => array_merge(...array_values($prepGrillByCat)),
        'retailByCat' => $retailByCat,
        'retailFlat' => array_merge(...array_values($retailByCat)),
        'cleaningSupByCat' => $cleaningSupByCat,
        'cleaningSupFlat' => array_merge(...array_values($cleaningSupByCat)),
        'stayReadySup' => ['Bath towels', 'Hand towels', 'Bed linen sets', 'Toilet paper', 'Coffee pods', 'Tea bags', 'Shampoo bottles', 'Soap bars', 'Dishwashing liquid', 'Bin liners', 'Welcome snacks', 'Bottled water'],
        'prepItems' => ['Diced onions', 'Chopped herbs', 'House stock', 'Bread rolls', 'Salad mix', 'Dessert plating', 'Sauce base', 'Marinated chicken', 'Prepped vegetables', 'Portioned proteins'],
        'cafeOrderLines' => ['2x Flat White', '1x Cappuccino, 1x Banana Bread', '1x Latte, 1x Almond Croissant', '2x Long Black', '1x Mocha, 1x Blueberry Muffin', '3x Flat White', '1x Cold Brew, 1x Avocado Toast', '2x Cappuccino, 1x Ham & Cheese Croissant', '1x Chai Latte', '1x Iced Latte, 1x Bacon & Egg Roll'],
        'orderLinesFast' => ['2x Classic Cheeseburger, 1x Fries', '1x Bacon Deluxe, 1x Onion Rings, 1x Cola', '1x Double Stack, 1x Loaded Fries', '3x Cheeseburger, 2x Fries', '1x Crispy Chicken Burger, 1x Coleslaw', '1x Veggie Burger, 1x Sweet Potato Fries', '2x Classic Combo', '1x Kids Combo, 1x Chocolate Shake', '1x BBQ Bacon Burger, 1x Fries, 1x Cola', '2x Deluxe Combo'],
        'dishTickets' => ['T4 - 2x Scotch Fillet, 1x Barramundi', 'T12 - 3x Scallops, 2x Ribeye', 'T7 - 1x Sea Bass, 1x Duck Breast', 'T2 - 2x Pork Belly, 1x Gnocchi', 'T18 - 1x Lamb Rack, 1x Risotto', 'T9 - 2x Market Fish, 1x Eye Fillet', 'T5 - 1x Wagyu Burger, 1x Caesar Salad', 'T14 - 2x Ribeye, 1x Sea Bass', 'T3 - 1x Mushroom Tagliatelle, 1x Steak Frites', 'T20 - 2x Confit Duck, 1x Barramundi'],
        'allergyNotes' => ['No nuts - severe allergy', 'Gluten free required', 'Dairy free', 'Shellfish allergy', 'No onion or garlic'],
        'deviceByType' => $deviceByType,
        'fleetMakeByType' => $fleetMakeByType,
        'electronicsParts' => ['Screen assembly', 'OLED display', 'Battery', 'Charging port', 'Digitizer', 'Logic board', 'Ribbon cable', 'Rear camera', 'Speaker module', 'Back glass'],
        'electronicsSuppliers' => ['Mobile Parts Co', 'ScreenSupply', 'RepairSource', 'PartsWholesale', 'iFixit AU'],
        'propertyNames' => ['Seaside Loft', 'Harbour View Apartment', 'The Garden Cottage', 'City Skyline Suite', 'Beachfront Bungalow', 'Parkside Townhouse', 'The Riverside Retreat', 'Hilltop Cabin', 'Sunset Studio', '12 Harbour St', 'The Boathouse', 'Clifftop House'],
        'venueSpaces' => ['Main Hall', 'Meeting Room A', 'Meeting Room B', 'Studio 1', 'Sports Court', 'Rooftop Terrace', 'Conference Room', 'Community Room', 'Function Room', 'The Boardroom'],
        'caterPackages' => ['Breakfast Grazing', 'Corporate Lunch Buffet', 'Plated Three-Course Dinner', 'Canape Selection', 'Grazing Table', 'Morning Tea Package', 'BBQ Feast', 'High Tea', 'Cocktail Reception', 'Working Lunch'],
        'caterTasks' => ['Bake bread', 'Prep canapes', 'Assemble grazing boxes', 'Cook mains', 'Pack delivery crates', 'Plate desserts', 'Portion salads', 'Load the van', 'Prep marinades', 'Garnish platters'],
        'eventNames' => ['Harbour View Wedding', 'Q3 Board Lunch', 'Anderson 50th Birthday', 'Tech Summit Catering', 'Charity Gala Dinner', 'Corporate Awards Night', 'Riverside Engagement', 'Product Launch Canapes', 'Annual Staff Party', 'School Fundraiser Lunch'],
        'projectNames' => ['Riverside Apartments Stage 2', 'Parkview Office Fitout', 'Harbour Lane Townhouses', 'Sunset Ridge Duplex', 'Central Plaza Retail', 'Northgate Warehouse', 'The Grove Residences', 'Bayside Medical Centre', 'Kingston Road Upgrade', 'Westfield Cafe Refit'],
        'defectTitles' => ['Cracked render to north wall', 'Leaking shower recess', 'Uneven floor tiles', 'Paint runs in stairwell', 'Loose balustrade', 'Gap in weatherboard', 'Chipped floor tile', 'Door not closing', 'Grout cracking in ensuite', 'Skirting board gap', 'Window seal failing', 'Scratched benchtop'],
        'variationTitles' => ['Add rear deck', 'Upgrade kitchen benchtops', 'Extra powerpoints', 'Change to tiled roof', 'Additional bathroom', 'Upgrade to stone flooring', 'Extend the driveway', 'Add solar provisions', 'Relocate laundry', 'Upgrade insulation'],
        'siteActivities' => ['Poured ground floor slab', 'Framing to first floor', 'Roof trusses installed', 'Bricklaying to east elevation', 'Rough-in plumbing started', 'Electrical rough-in', 'Plastering ground floor', 'Waterproofing to wet areas', 'Window installation', 'Site clean and prep'],
        'tradeCompanies' => ['Apex Electrical', 'Coastline Plumbing', 'Solidset Concreting', 'TrueLine Carpentry', 'Summit Roofing', 'ProFinish Painting', 'Groundworks Earthmoving', 'Metro Waterproofing', 'Precision Tiling', 'Reliable Steelfix'],
        'buildingSuppliers' => ['BuildRight Supplies', 'Metro Building Materials', 'Hanson Concrete', 'Boral Timber', 'Reece Plumbing', 'Steelforce', 'National Tiles', 'CSR Plasterboard', 'Bristile Roofing', 'Trade Depot'],
        'buildMaterials' => ['Reinforcing steel', 'Concrete mix', 'Timber framing', 'Plasterboard', 'Roof trusses', 'Insulation batts', 'Face bricks', 'Sand', 'Gravel', 'Window units'],
        'fitPrograms' => ['12-Week Fat Loss', 'Strength Foundations', 'Marathon Prep', 'Mobility Reset', 'Powerlifting Block', 'Beginner Bootcamp', 'Post-Rehab Return', 'Hypertrophy Builder', 'Core & Conditioning', 'Kettlebell Strength'],
        'fitProgramGoal' => $fitProgramGoal,
        'paddockNames' => ['North 40', 'River Block', 'Home Paddock', 'Top Ridge', 'Creek Flat', 'Long Paddock', 'Stony Rise', 'West Field', 'Bottom Forty', 'Springvale Block', 'Eastern Downs', 'Sandy Loam'],
        'machineNames' => ['John Deere S680 Harvester', 'Case IH Magnum 340', 'New Holland T7 Tractor', 'Kubota M7', 'Fendt 720 Vario', 'John Deere 8R Tractor', 'Case IH Axial-Flow', 'Massey Ferguson 8S', 'Deutz-Fahr 6215', 'Claas Lexion 8900'],
        'petNames' => ['Bella', 'Max', 'Luna', 'Charlie', 'Bailey', 'Milo', 'Ruby', 'Coco', 'Rocky', 'Daisy', 'Buddy', 'Molly', 'Bear', 'Lucy', 'Oscar', 'Poppy', 'Toby', 'Rosie', 'Jack', 'Nala', 'Ziggy', 'Pepper', 'Frankie', 'Willow'],
        'petBreeds' => ['Labrador', 'Golden Retriever', 'Border Collie', 'Kelpie', 'Cavoodle', 'French Bulldog', 'Staffy', 'German Shepherd', 'Beagle', 'Jack Russell', 'Domestic Shorthair', 'Ragdoll', 'British Shorthair', 'Groodle'],
        'dogBreeds' => ['Labrador', 'Golden Retriever', 'Border Collie', 'Kelpie', 'Cavoodle', 'French Bulldog', 'Staffy', 'German Shepherd', 'Beagle', 'Jack Russell', 'Groodle', 'Cocker Spaniel'],
        'catBreeds' => ['Domestic Shorthair', 'Ragdoll', 'British Shorthair', 'Burmese', 'Maine Coon', 'Siamese', 'Tabby', 'Russian Blue'],
        'otherBreeds' => ['Rabbit', 'Guinea Pig', 'Cockatiel', 'Ferret', 'Budgie'],
        'billingPeriods' => ['June 2026', 'May 2026', 'April 2026', 'Term 2 2026', 'Term 1 2026', 'Q2 2026'],
        'careDescByType' => $careDescByType,
        'careActionByType' => $careActionByType,
        'crewNames' => ['Blue Team', 'Green Team', 'Crew A', 'Crew B', 'Red Team', 'North Crew', 'City Crew', 'Coastal Team', 'Team Alpha', 'Weekend Crew'],
        'workshops' => ['Ultra Tune', 'Kmart Tyre & Auto', 'mycar Tyre & Auto', 'Bob Jane T-Marts', 'Midas', 'JAX Tyres', 'Beaurepaires', 'Repco Authorised Service'],
        'retailSuppliers' => ['Homeware Wholesale Co', 'Artisan Gifts Supply', 'Northline Apparel', 'Ceramica Imports', 'The Candle Works', 'Paperie Stationery', 'Silverleaf Jewellery', 'Seasons & Co', 'Coastal Homewares', 'Maker & Co Distribution', 'Willow Textiles', 'Boxed Gift Supply'],
        'destinations' => ['Springfield Depot', 'Riverton Site', 'Fairview Office', 'Lakeside Warehouse', 'Newport Yard', 'Ashford Site Office', 'CBD Client Site', 'Northern Suburbs', 'Airport Freight', 'Harbour Precinct'],
        'issueDesc' => ['Streaks left on the front windows', 'Bins were not emptied in the kitchen', 'Bathroom mirror was missed', 'Team arrived 30 minutes late', 'Skirting boards still dusty', 'Vacuum missed under the beds', 'Cabinets not wiped down', 'Rubbish left in the courtyard'],
        'issueResolution' => ['Re-cleaned the area the same day', 'Sent the team back to finish', 'Refunded the affected portion', 'Apologised and rescheduled a touch-up', 'Spoke with the crew lead and corrected', 'Follow-up clean booked at no charge'],
        'homeworkNotes' => ['Practise times tables 6-9', 'Read chapter 4 and summarise', 'Complete the worksheet on fractions', 'Revise irregular verbs', 'Learn the C major scale', 'Past-paper section B', 'Vocabulary list weeks 3-4', 'Practise sight-reading', 'Complete algebra set 2', 'Essay plan for Friday'],
        'tutorProgress' => ['Strong grasp of the new topic today', 'Needs more practice with word problems', 'Confidence improving steadily', 'Great progress on exam technique', 'Struggled with the harder questions', 'Excellent focus this session', 'Revised prior material well', 'Ready to move to the next unit'],
    ];
    return $P;
}
