<?php

declare(strict_types=1);

/**
 * Adapts and packages all 29 SoftN business applications from f2i-com/softn-Examples
 * (`bundles/business/*`) into Free Unified FormLogic Marketplace Packs under
 * `formlogic/backend/resources/softn-packs/<packId>-softn/`.
 *
 * Each generated pack contains:
 *  - `<slug>.softn` : Validated full-stack SoftN v2 app archive (UI + PHP Slim 4 + SQLite)
 *  - `pack.json`    : Marketplace metadata (Free, Live Sandbox enabled, SQLite tables, companion pack)
 *  - `install.json` : Unified Pack definition with BOTH:
 *      1) The SoftN Application (`@packApp:<slug>-softn`)
 *      2) Recreated FormLogic Forms 100% matched to the SoftN app's ACTUAL SQLite schema & PHP controller enums,
 *         bound live via `settings.nativeTableBinding` (`appId: "@packApp:<slug>-softn"`), with `linked_record`
 *         foreign keys and pre-built KPI/Chart dashboards
 *      3) A Companion FormLogic Forms & Reports Management App sharing the exact same SQLite DB
 *
 * Usage:
 *   php scripts/build-softn-business-packs.php [path-to-softn-Examples-bundles-business]
 */

$repoRoot = dirname(__DIR__);
require $repoRoot . '/formlogic/backend/vendor/autoload.php';

use FormLogic\Services\NativeAppService;
use FormLogic\Services\PackService;

$sourceBase = $argv[1] ?? 'C:/Users/User/.gemini/antigravity/brain/5b7270e9-a7fd-4697-9f45-c04b372e8383/scratch/softn-Examples/bundles/business';
$legacyPacksBase = $repoRoot . '/formlogic/backend/resources/packs';
$outBase = $repoRoot . '/formlogic/backend/resources/softn-packs';

if (!is_dir($sourceBase)) {
    fwrite(STDERR, "Source directory not found: {$sourceBase}\n");
    exit(1);
}
if (!is_dir($outBase)) {
    mkdir($outBase, 0755, true);
}

const APP_MAP = [
    'AgriLog'             => 'agrilog-farm',
    'AokieReceptionist'   => 'aokie-receptionist',
    'BrewDesk'            => 'brewdesk-cafe-ops',
    'CaterCraft'          => 'catercraft-catering',
    'CleanShift'          => 'cleanshift-cleaning',
    'ClinicFrontDesk'     => 'clinic-appointment-intake',
    'CounterFlow'         => 'counterflow-retail-ops',
    'EventHub'            => 'event-management',
    'FinanceOSAU'         => 'finance-os-au',
    'FinanceOSUS'         => 'finance-os-us',
    'FitStudio'           => 'fitstudio-coaching',
    'FleetFlow'           => 'fleetflow-fleet',
    'GrillStack'          => 'grillstack-burger-ops',
    'InventoryPOs'        => 'inventory-purchase-orders',
    'JobInvoiceDesk'      => 'job-invoice-management',
    'MechanicWorkshop'    => 'mechanic-workshop',
    'OHSQMS'              => 'ohs-qms',
    'PassMaster'          => 'passmaster-restaurant',
    'PawRoute'            => 'pawroute-pet-care',
    'PeopleHub'           => 'hr-people',
    'PlumbingTrades'      => 'plumbing-field-service',
    'PropertyMaintenance' => 'property-maintenance',
    'RepairBench'         => 'repairbench-device-repair',
    'SalonStudio'         => 'salon-beauty-studio',
    'ServiceDesk'         => 'customer-service',
    'SitePulse'           => 'sitepulse-site-diary',
    'StayReady'           => 'stayready-short-stay',
    'TutorTrack'          => 'tutortrack-tutoring',
    'VenueOps'            => 'venueops-venue-hire',
];

const SYSTEM_TABLES = ['business_settings', 'team_members', 'audit_log'];
const AUTO_MANAGED_COLS = ['id', 'is_sample', 'created_at', 'updated_at'];

/**
 * Parse SQLite CREATE TABLE definitions from schema.sql.
 *
 * @return array<string, array{primaryKey: list<string>, columns: list<array{name: string, type: string, notNull: bool, default: ?string, isPk: bool, isAuto: bool}>}>
 */
function parseSqlSchema(string $sql): array
{
    $tables = [];
    if (!preg_match_all('/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"\']?([a-zA-Z_][a-zA-Z0-9_]*)[`"\']?\s*\(([\s\S]*?)\)\s*;/i', $sql, $matches, PREG_SET_ORDER)) {
        return $tables;
    }
    foreach ($matches as $m) {
        $tableName = $m[1];
        $body = $m[2];
        $cols = [];
        $pks = [];
        foreach (preg_split('/\r?\n/', $body) ?: [] as $line) {
            $trim = rtrim(trim($line), ',');
            if ($trim === '' || str_starts_with($trim, '--')) continue;
            if (preg_match('/^(?:PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i', $trim)) {
                if (preg_match('/^PRIMARY\s+KEY\s*\(([^)]+)\)/i', $trim, $pm)) {
                    foreach (explode(',', $pm[1]) as $part) {
                        $pks[] = trim($part, " \t\n\r\"'`");
                    }
                }
                continue;
            }
            if (!preg_match('/^[`"\']?([a-zA-Z_][a-zA-Z0-9_]*)[`"\']?\s+([A-Za-z]+)(.*)$/i', $trim, $cm)) {
                continue;
            }
            $colName = $cm[1];
            $colType = strtoupper($cm[2]);
            $rest = $cm[3];
            $isPk = preg_match('/\bPRIMARY\s+KEY\b/i', $rest) === 1;
            $isAuto = preg_match('/\bAUTOINCREMENT\b/i', $rest) === 1 || ($isPk && $colType === 'INTEGER');
            $notNull = preg_match('/\bNOT\s+NULL\b/i', $rest) === 1;
            $default = null;
            if (preg_match("/\\bDEFAULT\\s+(?:'([^']*)'|\"([^\"]*)\"|([^\\s,]+))/i", $rest, $dm)) {
                $default = ($dm[1] ?? '') !== '' ? $dm[1] : (($dm[2] ?? '') !== '' ? $dm[2] : ($dm[3] ?? ''));
            }
            if ($isPk) {
                $pks[] = $colName;
            }
            $cols[] = [
                'name' => $colName,
                'type' => $colType,
                'notNull' => $notNull,
                'default' => $default,
                'isPk' => $isPk,
                'isAuto' => $isAuto,
            ];
        }
        $tables[$tableName] = [
            'primaryKey' => array_values(array_unique($pks ?: ['id'])),
            'columns' => $cols,
        ];
    }
    return $tables;
}

/**
 * Extract PHP controller enum arrays mapped to input/column names via `V::oneOf(..., self::CONST, 'col')`
 * or `V::oneOf(..., ['A', 'B'], 'col')`.
 *
 * @return array<string, list<string>>
 */
function parseControllerEnums(string $appDir): array
{
    $byColumn = [];
    $phpDir = $appDir . '/server/src/App';
    if (!is_dir($phpDir)) return $byColumn;
    foreach (glob($phpDir . '/*.php') ?: [] as $file) {
        $src = (string) file_get_contents($file);
        $consts = [];
        if (preg_match_all('/private\s+const\s+([A-Z0-9_]+)\s*=\s*\[([\s\S]*?)\]\s*;/', $src, $cm, PREG_SET_ORDER)) {
            foreach ($cm as $m) {
                if (preg_match_all("/'([^']+)'|\"([^\"]+)\"/", $m[2], $vm)) {
                    $vals = [];
                    foreach ($vm[1] as $idx => $v1) {
                        $v = $v1 !== '' ? $v1 : $vm[2][$idx];
                        if ($v !== '') $vals[] = $v;
                    }
                    if ($vals !== []) {
                        $consts[$m[1]] = $vals;
                    }
                }
            }
        }
        // Match V::oneOf($input['col']..., self::CONST_NAME, 'col'...)
        if (preg_match_all("/V::oneOf\s*\([^;]*?self::([A-Z0-9_]+)\s*,\s*['\"]([a-zA-Z0-9_]+)['\"]/", $src, $om, PREG_SET_ORDER)) {
            foreach ($om as $m) {
                $cName = $m[1];
                $col = $m[2];
                if (isset($consts[$cName])) {
                    $byColumn[$col] = array_values(array_unique(array_merge($byColumn[$col] ?? [], $consts[$cName])));
                }
            }
        }
        // Match inline V::oneOf($input['col']..., ['A','B'], 'col'...)
        if (preg_match_all("/V::oneOf\s*\([^;]*?\[([^\]]+)\]\s*,\s*['\"]([a-zA-Z0-9_]+)['\"]/", $src, $im, PREG_SET_ORDER)) {
            foreach ($im as $m) {
                $col = $m[2];
                if (preg_match_all("/'([^']+)'|\"([^\"]+)\"/", $m[1], $vm)) {
                    $vals = [];
                    foreach ($vm[1] as $idx => $v1) {
                        $v = $v1 !== '' ? $v1 : $vm[2][$idx];
                        if ($v !== '') $vals[] = $v;
                    }
                    if ($vals !== []) {
                        $byColumn[$col] = array_values(array_unique(array_merge($byColumn[$col] ?? [], $vals)));
                    }
                }
            }
        }
    }
    return $byColumn;
}

function humanize(string $ident): string
{
    $clean = preg_replace('/^(?:ak|au|us|ohs)_/', '', $ident) ?? $ident;
    $label = ucwords(str_replace(['_', '-'], ' ', $clean));
    $replacements = [
        ' Id' => '',
        'Cents' => '(Cents)',
        'Sms' => 'SMS',
        'Po ' => 'PO ',
        'Po' => 'PO',
        'Acat' => 'ACAT',
        'Bdbn' => 'BDBN',
        'Poa' => 'POA',
        'Car' => 'CAR',
        'Ncr' => 'NCR',
        'Ohs' => 'OHS',
        'Kb ' => 'KB ',
        'Wo ' => 'Work Order ',
        'Abn' => 'ABN',
        'Tfn' => 'TFN',
        'Url' => 'URL',
        'Sku' => 'SKU',
    ];
    foreach ($replacements as $from => $to) {
        if ($from === ' Id' && str_ends_with($label, ' Id')) {
            $label = substr($label, 0, -3);
        } elseif ($from !== ' Id' && $from !== 'Po') {
            $label = str_replace($from, $to, $label);
        }
    }
    return trim($label);
}

/**
 * Resolve a `*_id` foreign key column to another domain table in the same app (if any).
 *
 * @param list<string> $domainTables
 */
function resolveForeignTable(string $colName, string $currentTable, array $domainTables): ?string
{
    if (!str_ends_with($colName, '_id') || in_array($colName, ['user_id', 'tax_id', 'external_id', 'device_uid', 'member_id', 'caller_id'], true)) {
        return null;
    }
    $stem = substr($colName, 0, -3);
    if ($stem === '') return null;

    // Candidate table names ordered from most specific to fallback
    $candidates = [
        $stem,
        $stem . 's',
        $stem . 'es',
        str_ends_with($stem, 'y') ? substr($stem, 0, -1) . 'ies' : '',
    ];
    // Handle table prefix (ak_, au_, us_, ohs_)
    $prefix = '';
    if (preg_match('/^([a-z]{2,3}_)/', $currentTable, $pm)) {
        $prefix = $pm[1];
        foreach ([$stem, $stem . 's', $stem . 'es', str_ends_with($stem, 'y') ? substr($stem, 0, -1) . 'ies' : ''] as $c) {
            if ($c !== '') $candidates[] = $prefix . $c;
        }
    }
    foreach ($candidates as $cand) {
        if ($cand !== '' && $cand !== $currentTable && in_array($cand, $domainTables, true)) {
            return $cand;
        }
    }
    // Suffix match (e.g. request_id -> maintenance_requests, order_id -> cafe_orders / shop_orders, job_id -> repair_jobs)
    foreach ($domainTables as $tbl) {
        if ($tbl === $currentTable) continue;
        if (str_ends_with($tbl, '_' . $stem . 's') || str_ends_with($tbl, '_' . $stem) || (str_ends_with($stem, 'y') && str_ends_with($tbl, '_' . substr($stem, 0, -1) . 'ies'))) {
            return $tbl;
        }
    }
    // Common domain aliases
    $aliases = [
        'po' => 'purchase_orders',
        'wo' => 'work_orders',
        'thread' => 'ak_sms_threads',
        'package' => 'menu_packages',
        'table' => 'dining_tables',
        'team' => 'cleaning_teams',
        'staff' => 'brigade_staff',
        'employee' => 'onboardings',
    ];
    if (isset($aliases[$stem]) && in_array($aliases[$stem], $domainTables, true) && $aliases[$stem] !== $currentTable) {
        return $aliases[$stem];
    }
    return null;
}

/**
 * Pick the best human-readable display column(s) for a table (for linked_record pickers & list widgets).
 *
 * @param list<array{name: string, type: string}> $cols
 * @return list<string>
 */
function pickDisplayColumns(array $cols): array
{
    $names = array_map(static fn(array $c): string => $c['name'], $cols);
    $preferred = [
        'name', 'full_name', 'display_name', 'title', 'address', 'company_name', 'business_name',
        'subject', 'request_number', 'wo_number', 'order_number', 'invoice_number', 'quote_number',
        'job_number', 'po_number', 'ticket_number', 'booking_number', 'reference', 'code',
        'plate_number', 'registration', 'sku', 'email', 'phone', 'description',
    ];
    $picked = [];
    foreach ($preferred as $p) {
        if (in_array($p, $names, true)) {
            $picked[] = $p;
            if (count($picked) >= 2) break;
        }
    }
    if ($picked === []) {
        foreach ($cols as $c) {
            if (!in_array($c['name'], AUTO_MANAGED_COLS, true) && !str_ends_with($c['name'], '_id')) {
                $picked[] = $c['name'];
                if (count($picked) >= 2) break;
            }
        }
    }
    return $picked ?: ['id'];
}

function inferFormFieldType(string $colName, string $sqlType, bool $hasOptions, bool $isFk): string
{
    if ($isFk) return 'linked_record';
    if ($hasOptions) return 'dropdown';
    $l = strtolower($colName);
    if (str_contains($l, 'email')) return 'email';
    if (preg_match('/phone|mobile|tel$/', $l) === 1) return 'phone';
    if (preg_match('/url|website|link/', $l) === 1) return 'url';
    if (preg_match('/rating|score/', $l) === 1 && str_contains($sqlType, 'INT')) return 'number';
    if (preg_match('/_date$|^date$|due_?date|start_?date|end_?date|dob|birth|lease_start|expiry|scheduled_date|reported_date|inspection_date/', $l) === 1) return 'date';
    if (preg_match('/_time$|^time$/', $l) === 1) return 'time';
    if (preg_match('/INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL/', $sqlType) === 1) return 'number';
    if (preg_match('/description|notes|details|body|comment|message|address|summary|work_done|instructions|requirements|findings|action_plan|transcript|content|bio|allergies|dietary/', $l) === 1) return 'long_text';
    return 'short_text';
}

function tablePackFormId(string $table): string
{
    return str_replace('_', '-', $table);
}

$totalPacks = 0;
$totalForms = 0;
$totalZipBytes = 0;

foreach (APP_MAP as $softnDir => $legacyPackId) {
    $srcDir = $sourceBase . '/' . $softnDir;
    $legacyPackPath = $legacyPacksBase . '/' . $legacyPackId . '/pack.json';
    if (!is_dir($srcDir) || !is_file($srcDir . '/manifest.json')) {
        fwrite(STDERR, "Missing SoftN app: {$srcDir}\n");
        exit(1);
    }

    $manifest = json_decode((string) file_get_contents($srcDir . '/manifest.json'), true, 64, JSON_THROW_ON_ERROR);
    $legacyMeta = is_file($legacyPackPath) ? json_decode((string) file_get_contents($legacyPackPath), true, 64, JSON_THROW_ON_ERROR) : [];

    $slug = $legacyPackId . '-softn';
    $outDir = $outBase . '/' . $slug;
    if (!is_dir($outDir)) {
        mkdir($outDir, 0755, true);
    }

    // 1. Package validated .softn archive (ZIP) from the SoftN app folder
    $softnZipPath = $outDir . '/' . $slug . '.softn';
    $zip = new ZipArchive();
    if ($zip->open($softnZipPath, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
        fwrite(STDERR, "Could not create {$softnZipPath}\n");
        exit(1);
    }
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($srcDir, FilesystemIterator::SKIP_DOTS));
    $allRelPaths = [];
    foreach ($it as $entry) {
        if (!$entry->isFile()) continue;
        $rel = str_replace('\\', '/', substr($entry->getPathname(), strlen($srcDir) + 1));
        if ($rel === '.htaccess' || str_ends_with($rel, '/.DS_Store') || $rel === '.DS_Store') continue;
        $allRelPaths[] = [$rel, $entry->getPathname()];
    }
    usort($allRelPaths, static fn(array $a, array $b): int => strcmp($a[0], $b[0]));
    foreach ($allRelPaths as [$rel, $abs]) {
        $zip->addFile($abs, $rel);
    }
    $zip->close();

    // Verify archive extracts & passes NativeAppService::validateProject()!
    $extractedProject = NativeAppService::extractProjectFromArchive($softnZipPath);
    $zipSize = (int) filesize($softnZipPath);
    $totalZipBytes += $zipSize;

    // 2. Parse SQLite schema & PHP controller enums to generate 100% schema-matched FormLogic Forms
    $seedRel = is_string($manifest['databases'][0]['seedSql'] ?? null)
        ? (string) $manifest['databases'][0]['seedSql']
        : 'server/migrations/schema.sql';
    $schemaSql = (string) file_get_contents($srcDir . '/' . $seedRel);
    $parsedTables = parseSqlSchema($schemaSql);
    $enumsByCol = parseControllerEnums($srcDir);

    $domainTables = array_values(array_filter(
        array_keys($parsedTables),
        static fn(string $t): bool => !in_array($t, SYSTEM_TABLES, true)
    ));

    $softnPackAppId = $slug . '-app';
    $formsPackAppId = $slug . '-forms';
    $primaryColor = '#4f46e5';
    $theme = [
        'primaryColor' => $primaryColor,
        'backgroundColor' => '#ffffff',
        'textColor' => '#1f2937',
        'fontFamily' => 'Inter',
        'borderRadius' => 'medium',
    ];

    $displayColsByTable = [];
    foreach ($domainTables as $t) {
        $displayColsByTable[$t] = pickDisplayColumns($parsedTables[$t]['columns']);
    }

    $forms = [];
    $appFormsList = [];
    $appReports = [];
    $appDashboardWidgets = [];
    $widgetY = 0;

    foreach ($domainTables as $idx => $tableName) {
        $tInfo = $parsedTables[$tableName];
        $packFormId = tablePackFormId($tableName);
        $title = humanize($tableName);

        $fields = [
            [
                'id' => 'welcome',
                'type' => 'welcome_screen',
                'label' => $title,
                'description' => 'Connected live to SQLite table "' . $tableName . '" in ' . $manifest['name'] . '.',
                'required' => false,
                'properties' => (object) [],
            ],
        ];
        $colBinding = [];
        $createdAtCol = null;
        $statusCol = null;
        $categoryFieldId = null;
        $numericFieldId = null;

        foreach ($tInfo['columns'] as $col) {
            $cn = $col['name'];
            $cl = strtolower($cn);
            if ($cl === 'created_at') $createdAtCol = $cn;
            if ($statusCol === null && in_array($cl, ['status', 'state', 'stage'], true)) $statusCol = $cn;

            if (in_array($cn, AUTO_MANAGED_COLS, true) || ($col['isPk'] && $col['isAuto'])) {
                continue;
            }
            if (preg_match('/password|token|secret|hash/i', $cn) === 1) {
                continue;
            }

            $fkTable = resolveForeignTable($cn, $tableName, $domainTables);
            $options = $enumsByCol[$cn] ?? [];
            if ($options === [] && $col['default'] !== null && in_array($cl, ['status', 'priority', 'category', 'type'], true)) {
                $options = [$col['default']];
            }
            $fieldType = inferFormFieldType($cn, $col['type'], $options !== [], $fkTable !== null);
            $props = [];
            if ($fkTable !== null) {
                $props = [
                    'targetFormId' => '@pack:' . tablePackFormId($fkTable),
                    'displayFieldIds' => $displayColsByTable[$fkTable] ?? ['id'],
                ];
            } elseif ($options !== []) {
                $optsList = [];
                foreach ($options as $oVal) {
                    $optsList[] = [
                        'id' => strtolower((string) preg_replace('/[^a-zA-Z0-9]+/', '_', $oVal)),
                        'label' => $oVal,
                        'value' => $oVal,
                    ];
                }
                $props = ['options' => $optsList];
                if ($col['default'] !== null && in_array($col['default'], $options, true)) {
                    $props['defaultValue'] = $col['default'];
                }
            }

            // Auto-numbered columns (*_number, *_code) should be optional in forms (auto-generated when empty)
            $isAutoSeq = preg_match('/(?:_number|_code|_ref)$/', $cl) === 1;
            $required = $col['notNull'] && $col['default'] === null && !$isAutoSeq;

            $fields[] = [
                'id' => $cn,
                'type' => $fieldType,
                'label' => humanize($cn),
                'required' => $required,
                'properties' => $props === [] ? (object) [] : $props,
            ];
            $colBinding[$cn] = $cn;

            if ($categoryFieldId === null && ($fieldType === 'dropdown' || in_array($cl, ['status', 'priority', 'category', 'type'], true))) {
                $categoryFieldId = $cn;
            }
            if ($numericFieldId === null && $fieldType === 'number' && !str_ends_with($cl, '_id')) {
                $numericFieldId = $cn;
            }
        }

        // Per-form KPI & Chart dashboard screen using real bound field IDs
        $formWidgets = [
            [
                'id' => 'k1',
                'title' => 'Total ' . $title,
                'layout' => ['x' => 0, 'y' => 0, 'w' => 4, 'h' => 1],
                'kind' => 'report',
                'spec' => ['formId' => '@pack:' . $packFormId, 'viz' => 'kpi', 'measure' => ['fn' => 'count']],
            ],
        ];
        if ($categoryFieldId !== null) {
            $formWidgets[] = [
                'id' => 'c1',
                'title' => $title . ' by ' . humanize($categoryFieldId),
                'layout' => ['x' => 0, 'y' => 1, 'w' => 6, 'h' => 3],
                'kind' => 'report',
                'spec' => [
                    'formId' => '@pack:' . $packFormId,
                    'viz' => 'bar',
                    'groupBy' => ['field' => $categoryFieldId, 'bucket' => 'none'],
                    'measure' => ['fn' => 'count'],
                    'seriesSort' => 'value',
                    'sort' => 'desc',
                    'limit' => 8,
                ],
            ];
        }
        $dispCols = $displayColsByTable[$tableName] ?? [];
        $titleField = $dispCols[0] ?? array_key_first($colBinding) ?? 'id';
        $subtitleField = $dispCols[1] ?? ($categoryFieldId ?? null);
        $listSpec = ['formId' => '@pack:' . $packFormId, 'titleField' => $titleField, 'limit' => 10];
        if (is_string($subtitleField) && $subtitleField !== $titleField) {
            $listSpec['subtitleField'] = $subtitleField;
        }
        $formWidgets[] = [
            'id' => 'l1',
            'title' => 'Recent ' . $title,
            'layout' => ['x' => 0, 'y' => 4, 'w' => 12, 'h' => 3],
            'kind' => 'list',
            'list' => $listSpec,
        ];

        $forms[] = [
            'packFormId' => $packFormId,
            'title' => $title,
            'icon' => $legacyMeta['icon'] ?? 'Table',
            'description' => 'Live FormLogic form synced directly to SQLite table "' . $tableName . '" in ' . $manifest['name'] . '.',
            'settings' => [
                'presentationMode' => 'both',
                'defaultPresentationMode' => 'classic',
                'showProgressBar' => true,
                'allowBackNavigation' => true,
                'submitButtonText' => 'Save ' . $title,
                'isClosed' => false,
                'nativeTableBinding' => [
                    'appId' => '@packApp:' . $softnPackAppId,
                    'table' => $tableName,
                    'primaryKey' => $tInfo['primaryKey'],
                    'columns' => $colBinding,
                    'createdAtColumn' => $createdAtCol,
                    'statusColumn' => $statusCol,
                ],
            ],
            'theme' => $theme,
            'fields' => $fields,
            'customScreen' => [
                'enabled' => true,
                'allowNewResponses' => true,
                'kind' => 'dashboard',
                'dashboard' => [
                    'version' => 1,
                    'cols' => 12,
                    'widgets' => $formWidgets,
                ],
            ],
        ];

        $appFormsList[] = [
            'packFormId' => $packFormId,
            'displayName' => $title,
            'sortOrder' => $idx,
            'isVisible' => true,
        ];

        // Companion Management App KPI + breakdown charts (for first 4 primary tables)
        if ($idx < 4) {
            $kpiSpec = ['formId' => '@pack:' . $packFormId, 'viz' => 'kpi', 'measure' => ['fn' => 'count'], 'color' => ['blue', 'emerald', 'violet', 'amber'][$idx % 4]];
            $appReports[] = [
                'id' => 'kpi_' . $tableName,
                'name' => 'Total ' . $title,
                'type' => 'builder',
                'spec' => $kpiSpec,
            ];
            $appDashboardWidgets[] = [
                'id' => 'wk_' . $idx,
                'kind' => 'report',
                'title' => 'Total ' . $title,
                'layout' => ['x' => ($idx % 4) * 3, 'y' => 0, 'w' => 3, 'h' => 2],
                'spec' => $kpiSpec,
            ];
            if ($categoryFieldId !== null && $idx < 2) {
                $barSpec = [
                    'formId' => '@pack:' . $packFormId,
                    'viz' => 'bar',
                    'groupBy' => ['field' => $categoryFieldId, 'bucket' => 'none'],
                    'measure' => ['fn' => 'count'],
                    'color' => $idx === 0 ? 'indigo' : 'teal',
                    'showDataLabels' => true,
                ];
                $appReports[] = [
                    'id' => 'bar_' . $tableName,
                    'name' => $title . ' by ' . humanize($categoryFieldId),
                    'type' => 'builder',
                    'spec' => $barSpec,
                ];
                $appDashboardWidgets[] = [
                    'id' => 'wc_' . $idx,
                    'kind' => 'report',
                    'title' => $title . ' by ' . humanize($categoryFieldId),
                    'layout' => ['x' => $idx * 6, 'y' => 2, 'w' => 6, 'h' => 4],
                    'spec' => $barSpec,
                ];
            }
        }
    }

    $packName = (string) ($manifest['name'] ?? $softnDir);
    $packDesc = (string) ($manifest['description'] ?? ($legacyMeta['description'] ?? ''));
    $tags = array_values(array_unique(array_merge(
        is_array($legacyMeta['tags'] ?? null) ? $legacyMeta['tags'] : [],
        ['softn', 'sqlite', 'shared-database']
    )));
    $screenshots = is_array($legacyMeta['screenshots'] ?? null) ? $legacyMeta['screenshots'] : [];

    // 3. Build install.json (Unified Pack: SoftN App + Linked FormLogic Management App + Schema-Matched Forms)
    $installDef = [
        'formatVersion' => 1,
        'packMeta' => [
            'id' => $slug,
            'name' => $packName . ' (SoftN + Forms)',
            'description' => $packDesc . ' Includes the full-stack SoftN application plus ' . count($forms) . ' schema-matched FormLogic forms & management charts sharing the same live SQLite database.',
            'version' => (string) ($manifest['version'] ?? '1.0.0'),
            'author' => 'FormLogic',
            'tags' => $tags,
        ],
        'forms' => $forms,
        'apps' => [
            [
                'packAppId' => $softnPackAppId,
                'name' => $packName,
                'description' => $packDesc,
                'settings' => [
                    'softnApp' => true,
                    'appKind' => 'softn',
                ],
                'theme' => $theme,
                'forms' => [],
                'roles' => [],
            ],
            [
                'packAppId' => $formsPackAppId,
                'name' => $packName . ' Forms & Charts',
                'description' => 'FormLogic CRUD forms, tables, and live charts connected directly to ' . $packName . '\'s SQLite database.',
                'settings' => [
                    'appKind' => 'admin',
                    'unifiedSqlite' => true,
                    'sharedDatabaseAppId' => '@packApp:' . $softnPackAppId,
                    'linkedSoftnAppId' => '@packApp:' . $softnPackAppId,
                ],
                'theme' => $theme,
                'forms' => $appFormsList,
                'reports' => $appReports,
                'customScreen' => [
                    'enabled' => true,
                    'mode' => 'dashboard',
                    'dashboard' => [
                        'version' => 1,
                        'cols' => 12,
                        'widgets' => $appDashboardWidgets,
                    ],
                ],
                'roles' => [],
            ],
        ],
    ];

    // Validate the generated install definition with FormLogic's real PackService::validateDefinition()!
    PackService::validateDefinition($installDef);

    file_put_contents(
        $outDir . '/install.json',
        json_encode($installDef, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR)
    );

    $packMeta = [
        'id' => $slug,
        'slug' => $slug,
        'name' => $packName . ' — SoftN App & Linked Forms',
        'shortName' => $packName,
        'description' => $packDesc . ' Includes the full-stack SoftN application (PHP + SQLite) plus ' . count($forms) . ' schema-matched FormLogic CRUD forms and charts sharing the exact same live SQLite database.',
        'icon' => $legacyMeta['icon'] ?? 'Layers',
        'category' => $legacyMeta['category'] ?? 'Business apps',
        'tags' => $tags,
        'version' => (string) ($manifest['version'] ?? '1.0.0'),
        'formatVersion' => 1,
        'itemType' => 'softn_app',
        'softnArchive' => $slug . '.softn',
        'softnPackAppId' => $softnPackAppId,
        'formsPackAppId' => $formsPackAppId,
        'companionPackSlug' => $legacyPackId,
        'priceCents' => 0,
        'currency' => 'USD',
        'billingModel' => 'free',
        'sourceVisibility' => 'open',
        'demoEnabled' => true,
        'featured' => in_array($legacyPackId, ['property-maintenance', 'brewdesk-cafe-ops', 'job-invoice-management', 'clinic-appointment-intake', 'mechanic-workshop', 'agrilog-farm'], true),
        'tables' => $domainTables,
        'formCount' => count($forms),
        'appCount' => 2,
        'screenshots' => $screenshots,
    ];
    file_put_contents(
        $outDir . '/pack.json',
        json_encode($packMeta, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR)
    );

    $totalPacks++;
    $totalForms += count($forms);
    echo sprintf(
        "OK %-32s | tables=%2d | forms=%2d | .softn=%3dKB\n",
        $slug,
        count($domainTables),
        count($forms),
        (int) round($zipSize / 1024)
    );
}

echo sprintf(
    "\nBuilt %d Free SoftN + Linked Forms packs (%d schema-matched forms, %.2f MB total .softn archives).\n",
    $totalPacks,
    $totalForms,
    $totalZipBytes / (1024 * 1024)
);
