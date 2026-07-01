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

$sampleIcons = ['crm' => "\u{1F91D}", 'sales' => "\u{1F91D}", 'expense' => "\u{1F4B3}", 'onboard' => "\u{1F9D1}\u{200D}\u{1F4BC}", 'people' => "\u{1F9D1}\u{200D}\u{1F4BC}"];
foreach (glob(__DIR__ . '/../resources/sample-apps/*.json') ?: [] as $file) {
    $p = json_decode((string) file_get_contents($file), true);
    if (!is_array($p) || empty($p['packMeta'])) { out("  skip (bad sample) " . basename($file)); continue; }
    $meta = $p['packMeta'];
    $key = basename($file, '.json');
    $icon = "\u{1F4E6}";
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
        out("  demo: already installed (refreshed $updated screen(s))");
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
            $shots[] = ['label' => $appName, 'url' => "/api/packs/screenshots/$found"];
        }
        $idx++;
    }
    // Fallback for packs with no dashboard app but a legacy <slug>.png on disk.
    if (empty($shots) && ($found = $findShot($s['slug']))) {
        $shots[] = ['label' => $s['name'], 'url' => "/api/packs/screenshots/$found"];
    }
    $catalog->setPackScreenshots($s['slug'], $shots);
    $linkedShots += count($shots);
}
@mkdir($shotDirs[0], 0775, true);
file_put_contents($shotDirs[0] . '/manifest.json', json_encode($manifest, JSON_PRETTY_PRINT));
out("screenshot manifest: " . count($manifest) . " app(s); linked images: $linkedShots");

// ── Seed sample reports (incl. cross-form joins) so the Reports section is populated in the demo ──
// Templates are keyed by app name; field refs use "<FormTitle>::<fieldId>" for joined-form fields and
// "<fieldId>" for the base form. Resolved to the demo's installed form ids per app. Idempotent
// (deterministic ids). Only touches the demo account's apps.
$SAMPLE_REPORTS = [
    'Field Service' => [
        ['name' => 'Jobs by status', 'baseForm' => 'Job', 'viz' => 'bar', 'groupBy' => ['field' => 'status'], 'measure' => ['fn' => 'count']],
        ['name' => 'Pipeline value by customer type', 'description' => 'Estimated job value grouped by the customer’s type (Jobs joined to Customers).', 'baseForm' => 'Job', 'joins' => [['via' => 'customer', 'form' => 'Customer', 'type' => 'left']], 'viz' => 'bar', 'groupBy' => ['field' => 'Customer::customer_type'], 'measure' => ['fn' => 'sum', 'field' => 'estimated_value']],
        ['name' => 'Total invoiced', 'baseForm' => 'Invoice', 'viz' => 'kpi', 'measure' => ['fn' => 'sum', 'field' => 'total']],
    ],
    'Billing Pipeline' => [
        ['name' => 'Pipeline by stage', 'baseForm' => 'Job', 'viz' => 'bar', 'groupBy' => ['field' => 'status'], 'measure' => ['fn' => 'sum', 'field' => 'estimated_value']],
        ['name' => 'Invoiced by client', 'description' => 'Invoice amounts grouped by client (Invoices joined to Clients).', 'baseForm' => 'Invoice', 'joins' => [['via' => 'client', 'form' => 'Client', 'type' => 'left']], 'viz' => 'bar', 'groupBy' => ['field' => 'Client::business_name'], 'measure' => ['fn' => 'sum', 'field' => 'amount']],
        ['name' => 'Invoices by status', 'baseForm' => 'Invoice', 'viz' => 'bar', 'groupBy' => ['field' => 'status'], 'measure' => ['fn' => 'sum', 'field' => 'amount']],
    ],
    'Salon' => [
        ['name' => 'Appointments by status', 'baseForm' => 'Appointment', 'viz' => 'bar', 'groupBy' => ['field' => 'status'], 'measure' => ['fn' => 'count']],
        ['name' => 'Revenue by service', 'description' => 'Appointment revenue grouped by service (Appointments joined to Services).', 'baseForm' => 'Appointment', 'joins' => [['via' => 'service', 'form' => 'Service', 'type' => 'left']], 'viz' => 'bar', 'groupBy' => ['field' => 'Service::name'], 'measure' => ['fn' => 'sum', 'field' => 'price']],
    ],
    'Workshop' => [
        ['name' => 'Job cards by status', 'baseForm' => 'Job Card', 'viz' => 'bar', 'groupBy' => ['field' => 'status'], 'measure' => ['fn' => 'count']],
        ['name' => 'Jobs by vehicle make', 'description' => 'Job cards grouped by vehicle make (Job Cards joined to Vehicles).', 'baseForm' => 'Job Card', 'joins' => [['via' => 'vehicle', 'form' => 'Vehicle', 'type' => 'left']], 'viz' => 'bar', 'groupBy' => ['field' => 'Vehicle::make'], 'measure' => ['fn' => 'count']],
    ],
    'Inventory' => [
        ['name' => 'Stock movements by type', 'baseForm' => 'Stock Movement', 'viz' => 'bar', 'groupBy' => ['field' => 'movement_type'], 'measure' => ['fn' => 'count']],
        ['name' => 'Purchase orders by status', 'baseForm' => 'Purchase Order', 'viz' => 'bar', 'groupBy' => ['field' => 'status'], 'measure' => ['fn' => 'sum', 'field' => 'total']],
        ['name' => 'Products by category', 'baseForm' => 'Product', 'viz' => 'pie', 'groupBy' => ['field' => 'category'], 'measure' => ['fn' => 'count']],
    ],
];
$seededReports = 0;
foreach ($apps->getAllApps($demoId) as $a) {
    $tpls = $SAMPLE_REPORTS[$a['name']] ?? null;
    if (!$tpls) { continue; }
    $rows = $pdo->query("SELECT f.id, f.title FROM app_forms af JOIN forms f ON f.id = af.form_id WHERE af.app_id = " . $pdo->quote($a['id']))->fetchAll(PDO::FETCH_ASSOC);
    $byTitle = [];
    foreach ($rows as $r) { $byTitle[$r['title']] = $r['id']; }
    $reports = [];
    foreach ($tpls as $t) {
        $baseId = $byTitle[$t['baseForm']] ?? null;
        if (!$baseId) { continue; }
        $titleToId = [];
        $joins = [];
        $ok = true;
        foreach ($t['joins'] ?? [] as $j) {
            $jid = $byTitle[$j['form']] ?? null;
            if (!$jid) { $ok = false; break; }
            $joins[] = ['via' => $j['via'], 'formId' => $jid, 'type' => $j['type'] ?? 'left'];
            $titleToId[$j['form']] = $jid;
        }
        if (!$ok) { continue; }
        $ref = static function (string $r) use ($titleToId): ?string {
            if (str_contains($r, '::')) { [$ft, $fid] = explode('::', $r, 2); return isset($titleToId[$ft]) ? $titleToId[$ft] . '::' . $fid : null; }
            return $r;
        };
        $spec = ['formId' => $baseId, 'viz' => $t['viz']];
        if ($joins) { $spec['joins'] = $joins; }
        if (isset($t['groupBy'])) {
            $gf = $ref($t['groupBy']['field']);
            if ($gf === null) { continue; }
            $spec['groupBy'] = array_merge(['field' => $gf], isset($t['groupBy']['bucket']) ? ['bucket' => $t['groupBy']['bucket']] : []);
            $spec['sort'] = 'desc';
        }
        if (isset($t['measure'])) {
            $m = $t['measure'];
            if (isset($m['field'])) { $mf = $ref($m['field']); if ($mf === null) { continue; } $m['field'] = $mf; }
            $spec['measure'] = $m;
        }
        $reports[] = ['id' => 'seed-' . substr(md5($t['name'] . $baseId), 0, 10), 'name' => $t['name'], 'description' => $t['description'] ?? null, 'type' => 'builder', 'spec' => $spec];
    }
    if ($reports) {
        $apps->updateApp($a['id'], ['reports' => $reports]);
        $seededReports += count($reports);
    }
}
out("seeded reports: $seededReports across demo apps");

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
        $answers = [];
        foreach ($fields as $f) {
            $v = genValue($f, $i, $seeded, $formName);
            if ($v !== null) { $answers[$f['id']] = $v; }
        }
        try {
            $r = $responseService->createResponse($formId, ['answers' => $answers]);
            if (is_array($r) && isset($r['id'])) { $ids[] = $r['id']; }
        } catch (\Throwable $e) {
            // skip a bad row, keep going
        }
    }
    return $ids;
}

/**
 * Generate a plausible value for a field, or null to leave it empty. Uses the FORM name + field label
 * together (`$ctx`) so demo data is domain-relevant — a "Name" field in a Product form yields a product,
 * in a Vehicle form the make/model yields a car, in a Salon Service form yields a service, etc.
 */
function genValue(array $field, int $i, array $seeded, string $formName = '')
{
    $type = $field['type'] ?? 'short_text';
    $label = strtolower((string) ($field['label'] ?? $field['id'] ?? ''));
    $ctx = trim($formName . ' ' . $label); // form + field context drives domain-aware values
    $props = $field['properties'] ?? [];
    $opts = $props['options'] ?? [];

    $NAMES = ['Ada Lovelace', 'Alan Turing', 'Grace Hopper', 'Katherine Johnson', 'Linus Pauling', 'Rosalind Franklin', 'Nikola Tesla', 'Marie Curie', 'Ada Byron', 'Claude Shannon', 'Dorothy Vaughan', 'Tim Berners-Lee'];
    $COMPANIES = ['Acme Corp', 'Globex', 'Initech', 'Umbrella Co', 'Soylent Foods', 'Hooli', 'Stark Industries', 'Wayne Enterprises', 'Wonka Inc', 'Cyberdyne Systems', 'Northwind Traders', 'Contoso Ltd'];
    $PARTS = ['Brake Pads', 'Oil Filter', 'Spark Plug Set', 'Air Filter', 'Timing Belt', 'Alternator', 'Radiator Hose', 'Clutch Kit', 'Wiper Blades', 'Battery', 'Brake Disc', 'Fuel Pump'];
    $PRODUCTS = ['Copper Pipe 15mm', 'PVC Elbow Joint', 'Silicone Sealant', 'Ball Valve', 'Cable Ties (100pk)', 'LED Downlight', 'Extension Lead', 'Safety Gloves', 'Paint Roller Set', 'Masking Tape', 'Cordless Drill', 'Screw Assortment'];
    $SERVICES = ['Cut & Blow Dry', 'Full Head Colour', 'Balayage', 'Gel Manicure', 'Facial Treatment', 'Deep Tissue Massage', 'Beard Trim', 'Highlights', 'Keratin Treatment', 'Pedicure'];
    $CAR_MAKES = ['Toyota', 'Ford', 'Mazda', 'Honda', 'Hyundai', 'Volkswagen', 'Subaru', 'Nissan', 'Kia', 'Holden'];
    $CAR_MODELS = ['Corolla', 'Ranger', 'CX-5', 'Civic', 'i30', 'Golf', 'Outback', 'X-Trail', 'Cerato', 'Commodore'];
    $STREETS = ['Baker Street', 'Elm Avenue', 'Maple Court', 'King Road', 'Station Street', 'Harbour Lane', 'Victoria Parade', 'Rosewood Drive', 'George Street', 'Park Terrace'];
    $CITIES = ['Springfield', 'Riverton', 'Fairview', 'Lakeside', 'Newport', 'Ashford'];
    $WORDS = ['Follow-up required', 'Reviewed and approved', 'Pending manager sign-off', 'On track for delivery', 'Escalated to the lead', 'Resolved successfully'];
    $rand = static fn (array $a) => $a[array_rand($a)];
    $has = static function (string $s, array $kw): bool { foreach ($kw as $k) { if (str_contains($s, $k)) { return true; } } return false; };
    $addr = static fn () => random_int(1, 199) . ' ' . $STREETS[array_rand($STREETS)] . ', ' . $CITIES[array_rand($CITIES)];
    $code = static fn (string $p) => $p . '-' . str_pad((string) (1001 + $i), 4, '0', STR_PAD_LEFT);

    $optValue = static function (array $opts) {
        if (empty($opts)) { return null; }
        $o = $opts[array_rand($opts)];
        return is_array($o) ? ($o['value'] ?? null) : $o;
    };

    switch ($type) {
        case 'short_text':
            // Codes / reference numbers
            if ($has($ctx, ['sku', 'item code', 'product code', 'part number', 'part no'])) { return 'SKU-' . str_pad((string) (1000 + $i), 5, '0', STR_PAD_LEFT); }
            if ($has($ctx, ['invoice']) && $has($ctx, ['number', ' no', 'ref', '#'])) { return $code('INV'); }
            if ($has($ctx, ['purchase order', 'po number', 'p.o']) || ($has($ctx, ['order']) && $has($ctx, ['number', ' no', '#']))) { return $code('PO'); }
            if ($has($ctx, ['quote']) && $has($ctx, ['number', ' no', 'ref', '#'])) { return $code('QT'); }
            if ($has($ctx, ['reference', 'ref no', 'ticket', 'case number', 'job number', 'work order number'])) { return $code('REF'); }
            if ($has($ctx, ['registration', 'rego', 'number plate', 'plate', 'licence plate', 'license plate'])) { return strtoupper($rand(['ABC', 'XYZ', 'QRS', 'JKL', 'MNP', 'TRK'])) . '-' . random_int(100, 999); }
            if ($has($ctx, ['vin', 'chassis'])) { return strtoupper(substr(bin2hex(random_bytes(9)), 0, 17)); }
            // Domain nouns (form context matters: a "Name" in a Product/Vehicle/Service form isn't a person)
            if ($has($ctx, ['make']) && !$has($ctx, ['maker', 'remake'])) { return $rand($CAR_MAKES); }
            if ($has($ctx, ['model'])) { return $rand($CAR_MODELS); }
            if ($has($ctx, ['service']) && !$has($ctx, ['customer service'])) { return $rand($SERVICES); }
            if ($has($ctx, ['part', 'material', 'component'])) { return $rand($PARTS); }
            if ($has($ctx, ['product', 'item', 'stock'])) { return $rand($PRODUCTS); }
            if ($has($ctx, ['address', 'street', 'site'])) { return $addr(); }
            if ($has($ctx, ['supplier', 'vendor', 'company', 'business', 'organization', 'organisation', 'employer', 'agency', 'manufacturer', 'brand'])) { return $rand($COMPANIES); }
            // People
            if ($has($ctx, ['name', 'client', 'customer', 'patient', 'contact', 'tenant', 'stylist', 'technician', 'provider', 'staff', 'assigned', 'attendee', 'applicant', 'employee', 'owner', 'manager'])
                && !$has($ctx, ['file', 'username', 'filename'])) {
                $full = $rand($NAMES);
                if ($has($ctx, ['first', 'given'])) { return explode(' ', $full)[0]; }
                if ($has($ctx, ['last', 'surname', 'family'])) { return explode(' ', $full)[1] ?? 'Smith'; }
                return $full;
            }
            if ($has($ctx, ['title', 'subject', 'position', 'role'])) {
                return $rand(['Q3 Review', 'Onboarding kit', 'System access', 'Budget approval', 'Site inspection', 'Client meeting', 'Policy update']);
            }
            return $rand(['Sample entry', $code('REF'), $rand($COMPANIES)]);
        case 'long_text':
            if ($has($ctx, ['address'])) { return $addr(); }
            if ($has($ctx, ['complaint', 'problem', 'issue', 'fault', 'symptom'])) {
                return $rand(['Intermittent fault reported by the customer.', 'Not working as expected since last week.', 'Making an unusual noise under load.', 'Needs inspection and diagnosis.', 'Reported shortly after the last service.']);
            }
            if ($has($ctx, ['performed', 'work done', 'resolution', 'action taken'])) {
                return $rand(['Completed the requested work and tested.', 'Replaced the faulty part and verified operation.', 'Serviced, cleaned and signed off.', 'Diagnosed the issue and scheduled a follow-up.']);
            }
            if ($has($ctx, ['description', 'reason', 'notes', 'detail', 'summary', 'comment', 'instruction', 'preference', 'medication', 'work'])) {
                return $rand(['Standard request logged for review.', 'Customer prefers a morning appointment.', 'Follow-up required within the week.', 'Awaiting parts before completion.', 'Routine item, no issues noted.', 'Please call ahead before attending.']);
            }
            return $rand($WORDS) . '. ' . $rand($WORDS) . '.';
        case 'email':
            $n = strtolower(str_replace(' ', '.', $rand($NAMES)));
            return $n . '@example.com';
        case 'phone':
            return '555-01' . str_pad((string) random_int(0, 99), 2, '0', STR_PAD_LEFT);
        case 'url':
            return 'https://example.com/' . random_int(100, 999);
        case 'number': {
            $min = isset($props['min']) ? (int) $props['min'] : 0;
            $max = isset($props['max']) ? (int) $props['max'] : 0;
            if ($max > $min) { return random_int($min, $max); }
            if ($has($ctx, ['year'])) { return random_int(2015, 2024); }
            if ($has($ctx, ['odometer', 'mileage', 'kms', ' km'])) { return random_int(15, 190) * 1000; }
            if ($has($ctx, ['duration', 'minute', 'mins'])) { return $rand([15, 30, 45, 60, 90, 120]); }
            if ($has($ctx, ['hour'])) { return random_int(1, 8); }
            if ($has($ctx, ['lead time', 'lead-time', 'days'])) { return random_int(1, 14); }
            if ($has($ctx, ['reorder', 'on hand', 'on-hand', 'stock', 'quantity', 'qty', 'count', 'units'])) { return random_int(0, 80); }
            if ($has($ctx, ['amount', 'cost', 'value', 'price', 'budget', 'salary', 'aum', 'total', 'subtotal', 'tax', 'fee', 'rate', 'labour', 'labor', 'parts', 'paid'])) {
                return random_int(5, 950) * 10;
            }
            if ($has($ctx, ['age'])) { return random_int(18, 75); }
            return random_int(1, 100);
        }
        case 'dropdown':
        case 'multiple_choice':
            return $optValue($opts);
        case 'checkboxes': {
            if (empty($opts)) { return null; }
            $picked = [];
            foreach ($opts as $o) { if (random_int(0, 1)) { $picked[] = is_array($o) ? ($o['value'] ?? null) : $o; } }
            if (empty($picked)) { $o = $opts[0]; $picked[] = is_array($o) ? ($o['value'] ?? null) : $o; }
            return array_values(array_filter($picked));
        }
        case 'date': {
            $days = random_int(-30, 20);
            return date('Y-m-d', strtotime("$days days"));
        }
        case 'datetime': {
            $days = random_int(-20, 5);
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
            return $rand(['Sample', 'Example', 'Demo value']);
    }
}
