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

$officialId = ensureUser($pdo, $_ENV['OFFICIAL_EMAIL'] ?? 'official@formlogic.local', 'FormLogic');
$demoId = ensureUser($pdo, $_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local', 'Demo');

// ── Collect pack sources ────────────────────────────────────────────────────
$sources = [];

foreach (glob(__DIR__ . '/../resources/marketplace-packs/*.json') ?: [] as $file) {
    $e = json_decode((string) file_get_contents($file), true);
    if (!is_array($e) || empty($e['pack'])) { out("  skip (bad) " . basename($file)); continue; }
    $sources[] = [
        'slug' => $e['id'] ?? slugify($e['name'] ?? basename($file, '.json')),
        'name' => $e['name'] ?? 'Pack',
        'description' => $e['description'] ?? '',
        'icon' => $e['icon'] ?? null,
        'tags' => $e['tags'] ?? [],
        'category' => ($e['tags'][0] ?? 'general'),
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
    $sources[] = [
        'slug' => slugify($meta['name'] ?? $key),
        'name' => $meta['name'] ?? 'Sample',
        'description' => $meta['description'] ?? '',
        'icon' => $icon,
        'tags' => $meta['tags'] ?? ['sample'],
        'category' => 'sample',
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
        $pdo->prepare("UPDATE pack_catalog SET featured = 1, description = ?, icon = ?, tags = ? WHERE id = ?")
            ->execute([$s['description'], $s['icon'], json_encode($s['tags']), $catalogId]);
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
        out("  demo: already installed");
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

out("\nDone. Demo apps: " . count($apps->getAllApps($demoId)));

// ── Generic seeder ──────────────────────────────────────────────────────────

/** Seed each created form with a handful of plausible responses. Two passes so linked_record
 *  fields can reference already-seeded target records. Returns total responses created. */
function seedResponses(FormService $formService, ResponseService $responseService, array $createdForms): int
{
    $defs = [];
    foreach ($createdForms as $cf) {
        $full = $formService->getForm($cf['id']);
        if ($full) { $defs[$cf['id']] = $full['fields'] ?? []; }
    }
    $hasLink = static function (array $fields): bool {
        foreach ($fields as $f) { if (($f['type'] ?? '') === 'linked_record') { return true; } }
        return false;
    };
    $seeded = []; // formId => [responseIds]
    $total = 0;
    // Pass A: forms with no linked_record.
    foreach ($defs as $fid => $fields) {
        if ($hasLink($fields)) { continue; }
        $seeded[$fid] = seedForm($responseService, $fid, $fields, $seeded);
        $total += count($seeded[$fid]);
    }
    // Pass B: forms that reference others.
    foreach ($defs as $fid => $fields) {
        if (!$hasLink($fields)) { continue; }
        $seeded[$fid] = seedForm($responseService, $fid, $fields, $seeded);
        $total += count($seeded[$fid]);
    }
    return $total;
}

/** Create N plausible responses for one form. Returns the created response ids. */
function seedForm(ResponseService $responseService, string $formId, array $fields, array $seeded): array
{
    $ids = [];
    $count = random_int(9, 14);
    for ($i = 0; $i < $count; $i++) {
        $answers = [];
        foreach ($fields as $f) {
            $v = genValue($f, $i, $seeded);
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

/** Generate a plausible value for a field, or null to leave it empty. */
function genValue(array $field, int $i, array $seeded)
{
    $type = $field['type'] ?? 'short_text';
    $label = strtolower((string) ($field['label'] ?? $field['id'] ?? ''));
    $props = $field['properties'] ?? [];
    $opts = $props['options'] ?? [];

    $NAMES = ['Ada Lovelace', 'Alan Turing', 'Grace Hopper', 'Katherine Johnson', 'Linus Pauling', 'Rosalind Franklin', 'Nikola Tesla', 'Marie Curie', 'Ada Byron', 'Claude Shannon', 'Dorothy Vaughan', 'Tim Berners-Lee'];
    $COMPANIES = ['Acme Corp', 'Globex', 'Initech', 'Umbrella Co', 'Soylent', 'Hooli', 'Stark Industries', 'Wayne Enterprises', 'Wonka Inc', 'Cyberdyne'];
    $WORDS = ['Follow-up required', 'Reviewed and approved', 'Pending manager sign-off', 'Great progress this week', 'Needs additional detail', 'On track for delivery', 'Escalated to the lead', 'Resolved successfully'];
    $rand = static fn (array $a) => $a[array_rand($a)];

    $optValue = static function (array $opts) {
        if (empty($opts)) { return null; }
        $o = $opts[array_rand($opts)];
        return is_array($o) ? ($o['value'] ?? null) : $o;
    };

    switch ($type) {
        case 'short_text':
            if (str_contains($label, 'name') && !str_contains($label, 'company') && !str_contains($label, 'file') && !str_contains($label, 'user')) {
                $full = $rand($NAMES);
                if (str_contains($label, 'first') || str_contains($label, 'given')) { return explode(' ', $full)[0]; }
                if (str_contains($label, 'last') || str_contains($label, 'surname') || str_contains($label, 'family')) { return explode(' ', $full)[1] ?? 'Smith'; }
                return $full;
            }
            if (str_contains($label, 'company') || str_contains($label, 'organization') || str_contains($label, 'organisation') || str_contains($label, 'employer') || str_contains($label, 'vendor')) {
                return $rand($COMPANIES);
            }
            if (str_contains($label, 'title') || str_contains($label, 'subject') || str_contains($label, 'position') || str_contains($label, 'role')) {
                return $rand(['Q3 Review', 'Onboarding kit', 'System access', 'Budget approval', 'Site inspection', 'Client meeting', 'Policy update']);
            }
            return $rand(['Sample entry', 'Reference #' . (1000 + $i), $rand($COMPANIES), $rand($WORDS)]);
        case 'long_text':
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
            if (str_contains($label, 'amount') || str_contains($label, 'cost') || str_contains($label, 'value') || str_contains($label, 'price') || str_contains($label, 'budget') || str_contains($label, 'salary') || str_contains($label, 'aum')) {
                return random_int(5, 250) * 100;
            }
            if (str_contains($label, 'day') || str_contains($label, 'qty') || str_contains($label, 'quantity') || str_contains($label, 'count') || str_contains($label, 'score') || str_contains($label, 'age')) {
                return random_int(1, 30);
            }
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
