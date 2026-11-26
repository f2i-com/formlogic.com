<?php

declare(strict_types=1);
namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\{AccessGateService, AppAiService, AppFormlogicManifest, AppListening, AppService, AppUserService, AppVisitors, AppWalletService, FormService, ListenRefusal, NativeAppCalls, NativeAppCharges, NativeAppService, NativePhoneVerification, NativeRecordEventRouter, NativeTableFormBridge, PlanService, PluginService, FlowService, RuntimeEngineService, AppLookService, WalletRefusal};
use FormLogic\Support\AfterResponse;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class NativeAppController
{
    use JsonResponseTrait;

    private const DEMO_READ_ONLY = 'The shared demo is read-only: you can browse this app’s backend and database, but not change them.';
    /** How long a call refused because every worker was busy is told to wait: a request holds one for a fraction of a second. */
    private const BUSY_RETRY_SECONDS = 2;
    /** NativeAppService's recovery-required refusals (resolveJournal, assertNotRecoveryRequired). */
    private const RECOVERY_REQUIRED = '/^(?:The app (?:database )?needs operator recovery|Restore the app database before installing another update)/';
    /**
     * How many seconds apart a page with the app open asks whether there is a newer version, while
     * it is looked at (`updatesEvery`): its owner's page, and everyone else's. The asking has a
     * budget of its own (index.php's version limiter), so it never spends the app's calls.
     */
    private const UPDATES_EVERY_OWNER = 20;
    private const UPDATES_EVERY = 60;

    private ?FormService $forms = null;

    // $engines is required, not optional-with-a-default: this controller is autowired, and PHP-DI's
    // reflection autowiring SKIPS optional parameters (ReflectionBasedAutowiring), so an `= null`
    // here would silently hand production a controller that decides no app's engine.
    // $calls: the record of the app's calls (NativeAppCalls) its API section shows; none, and nothing is written down.
    // $listening: what puts a recording made for an app into words (AppListening); none, and no app is listened for.
    public function __construct(private AppService $apps, private AppUserService $users, private NativeAppService $native, private PlanService $plans, private FlowService $flows, private RuntimeEngineService $engines, private ?PluginService $plugins = null, private ?AccessGateService $gate = null, private ?AppLookService $look = null, private ?NativePhoneVerification $verification = null, private ?NativeRecordEventRouter $records = null, private ?AppVisitors $visitors = null, private ?AppAiService $ai = null, private ?AppWalletService $wallets = null, private ?NativeAppCharges $charges = null, private ?NativeAppCalls $calls = null, private ?AppListening $listening = null)
    {
        // Every dispatch goes through the one router, so App AI's jobs are never acknowledged unread.
        $this->records ??= new NativeRecordEventRouter($this->flows, $this->ai);
    }

    public function setFormService(?FormService $forms): void
    {
        $this->forms = $forms;
    }

    /**
     * Collect native record event subscriptions across this app and any sibling apps sharing the
     * same SQLite database. Calls the single-app method directly when unlinked so single-app
     * callers and mocks stay exact.
     *
     * @return list<array{event: string, bindings: list<string>}>
     */
    private function recordSubscriptionsFor(string $appId): array
    {
        $groupAppIds = $this->apps->sharedDatabaseGroupAppIds($appId);
        if (count($groupAppIds) > 1) {
            return $this->flows->nativeRecordSubscriptionsForApps($groupAppIds);
        }
        return $this->flows->nativeRecordSubscriptions($appId);
    }


    public function manage(Request $request, Response $response, array $args): Response
    {
        $app = $this->apps->getApp((string) $args['id']);
        $user = $request->getAttribute('userId');
        if (!$app || !$user || $app['ownerId'] !== $user) return $this->jsonError($response, 'App not found or access denied', 404);
        // The shared demo browses its apps' backends and databases read-only: the install PUT and
        // every records POST (whatever its action) are refused. DemoReadOnlyMiddleware refuses them
        // first, with its own demo_readonly text; this is the second guard, should that ever change.
        $readOnly = $this->isDemoRequest($request);
        if ($request->getMethod() !== 'GET' && ($blocked = $this->blockIfDemo($request, $response, self::DEMO_READ_ONLY))) return $blocked;
        return $this->respond($response, function () use ($request, $response, $app, $args, $readOnly) {
            // Phone sign-in codes, sent by the plugin that provides the app's provider
            // (NativePhoneVerification): the owner's settings for it, a secret never shown back.
            if (($args['operation'] ?? '') === 'verification') {
                if ($this->verification === null) throw new \RuntimeException('Phone verification is not available on this server', 503);
                if ($request->getMethod() === 'GET') return $this->verification->describe($app['id']);
                if ($request->getMethod() === 'DELETE') return $this->verification->clear($app['id']);
                $input = $request->getParsedBody();
                if (!is_array($input) || !is_array($input['values'] ?? null)) throw new \InvalidArgumentException('Send the settings, as values.');
                return $this->verification->save($app['id'], $input['values']);
            }
            // The app's data from where it ran before: its database, and optionally the earlier
            // host's private configuration for the key it was kept under (and, when the owner says
            // to use it, what it kept for the app's sign-in codes, for the plugin that sends them).
            if (($args['operation'] ?? '') === 'import') {
                $uploads = $request->getUploadedFiles();
                $database = $uploads['database'] ?? null;
                if (!$database instanceof \Psr\Http\Message\UploadedFileInterface || $database->getError() !== UPLOAD_ERR_OK) throw new \InvalidArgumentException('Choose the app\'s database file (application.sqlite).');
                $config = $uploads['config'] ?? null;
                $imported = ['key' => null];
                $held = null;
                if ($config instanceof \Psr\Http\Message\UploadedFileInterface && $config->getError() === UPLOAD_ERR_OK) {
                    if ($config->getSize() !== null && $config->getSize() > 65536) throw new \InvalidArgumentException('That key file is too large to be a host configuration.');
                    $text = (string) $config->getStream();
                    $imported = NativeAppService::importedKey($text);
                    // Only what the plugin that sends the app's codes names (its settings' `importFrom`).
                    $held = $this->verification?->heldIn($app['id'], (array) json_decode($text, true));
                    unset($text);
                }
                $found = $held !== null;
                $useVerification = (($request->getParsedBody() ?? [])['useVerification'] ?? '') === '1' && $found;
                // Settings the plugin would not take are said before anything changes, and never
                // take the data with them: the data is the import, the settings a setting.
                $verificationProblem = null;
                if ($useVerification) {
                    try { $this->verification->check($app['id'], $held); }
                    catch (\InvalidArgumentException $e) { $verificationProblem = 'Its sign-in code details were not used: ' . $e->getMessage(); $useVerification = false; }
                }
                $path = $this->native->importDropPath($app['id']);
                try {
                    $database->moveTo($path);
                    $installed = $this->native->importData($app['id'], $path, $imported['key'], (string) $app['ownerId']);
                } finally {
                    // With what SQLite made beside a WAL-mode upload as it was read.
                    foreach (['', '-wal', '-shm', '-journal'] as $suffix) if (is_file($path . $suffix)) @unlink($path . $suffix);
                }
                $verification = null;
                if ($useVerification) {
                    try { $verification = $this->verification->save($app['id'], $held); }
                    catch (\Throwable $e) { error_log('Native import: sign-in code details not kept for app ' . $app['id'] . ': ' . get_class($e)); $verificationProblem = 'Its sign-in code details could not be kept: enter them in Settings → Phone sign-in codes.'; }
                }
                unset($held);
                // The project is as it was (only its data came): with `media=refs`, its media named as the app's page reads them.
                if (($request->getQueryParams()['media'] ?? null) === 'refs') $installed = $this->native->ownerProject($app['id']) ?? $installed;
                return ['project' => $installed, 'keyImported' => $imported['key'] !== null, 'verificationFound' => $found, 'verification' => $verification, 'verificationProblem' => $verificationProblem];
            }
            // A new SoftN app's first version: the starter project, named after the app. Only
            // for an app with nothing installed (install() refuses expectedVersion 0 otherwise).
            if (($args['operation'] ?? '') === 'starter') {
                if (!empty($app['settings']['sourceProtected'])) {
                    throw new \RuntimeException('This Marketplace app is source-protected and its source cannot be replaced.', 403);
                }
                // A forms app hosts a project from App Studio; the starter would take over its address.
                if (empty($app['settings']['softnApp'])) throw new \InvalidArgumentException('This starter is for a web app. Add a project to a forms app from its App Studio.');
                $body = $request->getParsedBody();
                $template = is_array($body) ? ($body['template'] ?? 'classic') : 'classic';
                if (!is_string($template)) throw new \InvalidArgumentException(NativeAppService::UNKNOWN_STARTER);
                $installed = $this->native->install($app['id'], NativeAppService::starterProject((string) $app['name'], (string) $app['id'], $template), 0, null,
                    ['by' => (string) $app['ownerId'], 'how' => 'page', 'summary' => 'Started from the working starter']);
                return ['project' => $installed] + $this->engineAfterInstall($app['id'], RuntimeEngineService::languagesOf(NativeAppService::clientFiles($installed)));
            }
            // Shared database linking: view/set which app's SQLite database this app shares,
            // plus see all connected apps and linked FormLogic forms using this database.
            if (($args['operation'] ?? '') === 'database-link') {
                $ownerId = (string) $app['ownerId'];
                if ($request->getMethod() === 'PUT') {
                    $input = $request->getParsedBody();
                    if (!is_array($input)) throw new \InvalidArgumentException('Provide { targetAppId: string | null }.');
                    $targetId = $input['targetAppId'] ?? null;
                    if ($targetId !== null && !is_string($targetId)) {
                        throw new \InvalidArgumentException('targetAppId must be an app id string or null.');
                    }
                    $targetId = is_string($targetId) && trim($targetId) !== '' ? trim($targetId) : null;
                    if ($targetId !== null) {
                        $targetApp = $this->apps->getApp($targetId);
                        if (!$targetApp || ($targetApp['ownerId'] ?? null) !== $ownerId) {
                            throw new \InvalidArgumentException('Choose a target app owned by your account.');
                        }
                        if (!$this->native->hasManagedDatabase($targetId)) {
                            throw new \InvalidArgumentException('The target app does not have a SQLite database yet. Enable Unified SQLite on that Form App or install its SoftN backend first.');
                        }
                    }
                    $this->apps->setSharedDatabase($ownerId, (string) $app['id'], $targetId);
                    $this->native->setSharedDatabaseLink((string) $app['id'], $targetId);
                    $app = $this->apps->getApp((string) $app['id']) ?? $app;
                }
                return $this->describeDatabaseLink($app);
            }
            // One-click: create a secondary SoftN API Backend app pre-linked to this app's shared SQLite database.
            if (($args['operation'] ?? '') === 'create-api-backend') {
                $ownerId = (string) $app['ownerId'];
                $canonicalDbAppId = $this->native->databaseAppId((string) $app['id']);
                $schemas = $this->native->tableSchemas($canonicalDbAppId);
                $tableCols = [];
                foreach ($schemas as $tbl => $schema) {
                    $tableCols[$tbl] = array_values(array_map(static fn(array $f): string => (string) $f['name'], $schema['fields'] ?? []));
                }
                $body = $request->getParsedBody();
                $customName = is_array($body) && is_string($body['name'] ?? null) ? trim($body['name']) : '';
                $apiName = $customName !== '' ? mb_substr($customName, 0, 120) : ($app['name'] . ' API');
                $newApp = $this->apps->createApp([
                    'name' => $apiName,
                    'description' => 'Secondary SoftN API backend sharing the SQLite database of ' . $app['name'] . '.',
                    'settings' => [
                        'softnApp' => true,
                        'sharedDatabaseAppId' => $canonicalDbAppId,
                    ],
                ], $ownerId);
                $newAppId = (string) $newApp['id'];
                try {
                    $this->native->setSharedDatabaseLink($newAppId, $canonicalDbAppId);
                    $starter = NativeAppService::sharedApiBackendStarter($apiName, $newAppId, $tableCols);
                    $installed = $this->native->install($newAppId, $starter, 0, null, [
                        'by' => $ownerId,
                        'how' => 'page',
                        'summary' => 'Created secondary SoftN API backend on shared database',
                    ]);
                } catch (\Throwable $e) {
                    try { $this->native->remove($newAppId); } catch (\Throwable) {}
                    try { $this->apps->deleteApp($newAppId); } catch (\Throwable) {}
                    throw $e;
                }
                return ['app' => $newApp, 'project' => $installed, 'databaseAppId' => $canonicalDbAppId];
            }
            // One-click: create FormLogic Management Form(s) + starter Charts/KPIs bound directly
            // to one or more tables of this SoftN app's SQLite database.
            if (($args['operation'] ?? '') === 'create-management-form') {
                if ($this->forms === null) throw new \RuntimeException('Form service is unavailable', 503);
                $ownerId = (string) $app['ownerId'];
                $canonicalDbAppId = $this->native->databaseAppId((string) $app['id']);
                $schemas = $this->native->tableSchemas($canonicalDbAppId);
                if ($schemas === []) {
                    throw new \InvalidArgumentException('This app does not have any SQLite tables yet.');
                }
                $body = $request->getParsedBody();
                if (!is_array($body)) $body = [];
                $requestedTables = [];
                if (is_array($body['tables'] ?? null) && $body['tables'] !== []) {
                    foreach ($body['tables'] as $t) {
                        if (is_string($t) && isset($schemas[$t])) $requestedTables[] = $t;
                    }
                } elseif (is_string($body['table'] ?? null) && isset($schemas[$body['table']])) {
                    $requestedTables[] = $body['table'];
                } elseif (($body['table'] ?? null) === '*') {
                    $requestedTables = array_slice(array_keys($schemas), 0, 12);
                }
                $requestedTables = array_values(array_unique($requestedTables));
                if ($requestedTables === []) {
                    throw new \InvalidArgumentException('Choose at least one table from this app\'s database.');
                }
                if (!$this->plans->canCreateForms($ownerId, count($requestedTables))) {
                    throw new \RuntimeException(
                        'You\'ve reached your plan\'s limit of ' . $this->plans->formLimit($ownerId) . ' forms. Delete a form or upgrade to add more.',
                        402
                    );
                }

                $includeCharts = ($body['includeCharts'] ?? true) !== false;
                $targetAppId = is_string($body['targetAppId'] ?? null) ? trim($body['targetAppId']) : 'new';
                $managementApp = null;
                if ($targetAppId === 'new' || $targetAppId === '') {
                    $customName = is_string($body['appName'] ?? null) ? trim($body['appName']) : '';
                    $mgmtName = $customName !== '' ? mb_substr($customName, 0, 120) : ($app['name'] . ' Admin');
                    $managementApp = $this->apps->createApp([
                        'name' => $mgmtName,
                        'description' => 'Management forms, CRUD and charts linked to ' . $app['name'] . '\'s SQLite database.',
                        'rolePreset' => 'admin-console',
                        'settings' => [
                            'appKind' => 'admin',
                            'sharedDatabaseAppId' => $canonicalDbAppId,
                        ],
                    ], $ownerId);
                } elseif ($targetAppId !== 'none') {
                    $candidate = $this->apps->getApp($targetAppId);
                    if (!$candidate || ($candidate['ownerId'] ?? null) !== $ownerId) {
                        throw new \InvalidArgumentException('Target management app not found.');
                    }
                    $managementApp = $candidate;
                }

                $createdForms = [];
                $newReports = [];
                $dashboardWidgets = [];
                $widgetY = 0;

                foreach ($requestedTables as $tbl) {
                    $def = NativeTableFormBridge::buildFormDefinitionFromTable($canonicalDbAppId, $tbl, $schemas[$tbl]);
                    $prettyTable = ucwords(str_replace(['_', '-'], ' ', $tbl));
                    $form = $this->forms->createForm([
                        'userId' => $ownerId,
                        'title' => $prettyTable,
                        'description' => 'Live CRUD form connected to table "' . $tbl . '" in ' . $app['name'] . '.',
                        'status' => 'published',
                        'fields' => $def['fields'],
                        'settings' => [
                            'nativeTableBinding' => $def['binding'],
                        ],
                    ]);
                    $createdForms[] = $form;

                    if ($managementApp !== null) {
                        $this->apps->addFormToApp((string) $managementApp['id'], (string) $form['id'], $prettyTable);
                        if ($includeCharts) {
                            $fid = (string) $form['id'];
                            $kpiId = 'rep_' . bin2hex(random_bytes(5));
                            $kpiSpec = ['formId' => $fid, 'viz' => 'kpi', 'measure' => ['fn' => 'count'], 'color' => 'blue'];
                            $newReports[] = ['id' => $kpiId, 'name' => 'Total ' . $prettyTable, 'type' => 'builder', 'spec' => $kpiSpec];
                            $dashboardWidgets[] = ['id' => 'w_' . bin2hex(random_bytes(4)), 'kind' => 'report', 'title' => 'Total ' . $prettyTable, 'layout' => ['x' => 0, 'y' => $widgetY, 'w' => 4, 'h' => 2], 'spec' => $kpiSpec];

                            if (!empty($def['numericFields'][0])) {
                                $nf = $def['numericFields'][0];
                                $sumId = 'rep_' . bin2hex(random_bytes(5));
                                $sumSpec = ['formId' => $fid, 'viz' => 'kpi', 'measure' => ['fn' => 'sum', 'field' => $nf['id']], 'color' => 'green'];
                                $newReports[] = ['id' => $sumId, 'name' => 'Total ' . $nf['label'], 'type' => 'builder', 'spec' => $sumSpec];
                                $dashboardWidgets[] = ['id' => 'w_' . bin2hex(random_bytes(4)), 'kind' => 'report', 'title' => 'Total ' . $nf['label'], 'layout' => ['x' => 4, 'y' => $widgetY, 'w' => 4, 'h' => 2], 'spec' => $sumSpec];
                            }

                            if (!empty($def['categoryFields'][0])) {
                                $cf = $def['categoryFields'][0];
                                $barId = 'rep_' . bin2hex(random_bytes(5));
                                $barSpec = ['formId' => $fid, 'viz' => 'bar', 'groupBy' => ['field' => $cf['id'], 'bucket' => 'none'], 'measure' => ['fn' => 'count'], 'color' => 'violet', 'showDataLabels' => true];
                                $newReports[] = ['id' => $barId, 'name' => $prettyTable . ' by ' . $cf['label'], 'type' => 'builder', 'spec' => $barSpec];
                                $dashboardWidgets[] = ['id' => 'w_' . bin2hex(random_bytes(4)), 'kind' => 'report', 'title' => $prettyTable . ' by ' . $cf['label'], 'layout' => ['x' => 0, 'y' => $widgetY + 2, 'w' => 6, 'h' => 4], 'spec' => $barSpec];
                            }

                            $colIds = array_slice(array_map(static fn(array $f): string => (string) $f['id'], $def['fields']), 0, 6);
                            $dashboardWidgets[] = ['id' => 'w_' . bin2hex(random_bytes(4)), 'kind' => 'grid', 'title' => $prettyTable . ' Records', 'layout' => ['x' => 0, 'y' => $widgetY + 6, 'w' => 12, 'h' => 5], 'grid' => ['formId' => $fid, 'pageSize' => 10, 'columnFieldIds' => $colIds]];
                            $widgetY += 11;
                        }
                    }
                }

                if ($managementApp !== null && $includeCharts && ($newReports !== [] || $dashboardWidgets !== [])) {
                    $existingReports = is_array($managementApp['reports'] ?? null) ? $managementApp['reports'] : [];
                    $updatePayload = ['reports' => array_merge($existingReports, $newReports)];
                    if (empty($managementApp['customScreen']['dashboard']['widgets'])) {
                        $updatePayload['customScreen'] = [
                            'enabled' => true,
                            'mode' => 'dashboard',
                            'dashboard' => ['version' => 1, 'cols' => 12, 'widgets' => $dashboardWidgets],
                        ];
                    }
                    $managementApp = $this->apps->updateApp((string) $managementApp['id'], $updatePayload) ?? $managementApp;
                }

                if ($managementApp !== null && ($targetAppId === 'new' || $targetAppId === '')) {
                    $published = $this->apps->publishApp((string) $managementApp['id'], 'Initial management portal', $ownerId);
                    if (is_array($published['app'] ?? null)) {
                        $managementApp = $published['app'];
                    }
                }

                return [
                    'forms' => $createdForms,
                    'form' => $createdForms[0] ?? null,
                    'managementApp' => $managementApp,
                    'reportsCreated' => count($newReports),
                    'databaseAppId' => $canonicalDbAppId,
                ];
            }
            if (($args['operation'] ?? '') === 'records') {
                if ($request->getMethod() === 'POST') {
                    $input = $request->getParsedBody();
                    if (!is_array($input)) throw new \InvalidArgumentException('Provide a record action');
                    // Every action but `read` writes (create, update, delete, deleteMany): refused once
                    // the plan has lapsed, and followed by the automations its writes queued.
                    if (($input['action'] ?? '') !== 'read' && $this->plans->isEnforced() && !$this->plans->isCloudActive($app['ownerId'])) throw new \RuntimeException('Cloud access has expired. Records remain available to read.', 402);
                    $result = $this->native->manageRecord($app['id'], $input, $this->recordSubscriptionsFor((string) $app['id']));
                    if (($input['action'] ?? '') !== 'read') {
                        try { $this->native->dispatchRecordEvents($app['id'], $this->records->for($app['id'])); }
                        catch (\Throwable $error) { error_log('Native record automation delivery pending for app ' . $app['id']); }
                    }
                    return $result;
                }
                $query = $request->getQueryParams();
                $table = isset($query['table']) && is_string($query['table']) ? $query['table'] : null;
                // What the data manager asks beyond a table and an offset, as it was sent: the
                // store refuses what it cannot read. A caller that sends none of it is answered as before.
                $options = array_intersect_key($query, ['sort' => 1, 'dir' => 1, 'q' => 1, 'filter' => 1, 'view' => 1]);
                if (isset($query['limit']) && is_scalar($query['limit'])) $options['limit'] = (int) $query['limit'];
                if (($query['summary'] ?? null) === '1') $options['summary'] = true;
                // A file, not this controller's JSON: `table=*` is every shown table.
                if (isset($query['export'])) {
                    // Any visitor holds the shared demo's session: it browses, and takes nothing away
                    // (AppDataExportController refuses the same, in the same words).
                    if ($readOnly) throw new \RuntimeException('Data export is disabled on the shared live demo.', 403);
                    if ($table === null) throw new \InvalidArgumentException('Choose a table to export, or * for every table.');
                    $format = is_string($query['export']) ? $query['export'] : '';
                    $file = $this->native->exportRecords($app['id'], $table === '*' ? null : $table, $format, $options);
                    $name = self::fileName((string) ($app['slug'] ?? ''), 'app') . '-' . ($table === '*' ? 'all-tables' : self::fileName($table, 'table')) . ($format === 'csv' ? '.csv' : '.json');
                    $download = $response->withBody(new \Slim\Psr7\Stream($file['stream']))
                        ->withHeader('Content-Type', $format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8')
                        ->withHeader('Content-Disposition', 'attachment; filename="' . $name . '"')
                        ->withHeader('Content-Length', (string) (fstat($file['stream'])['size'] ?? 0))
                        ->withHeader('Cache-Control', 'no-store')->withHeader('X-Content-Type-Options', 'nosniff');
                    return $file['truncated'] ? $download->withHeader('X-FormLogic-Export-Truncated', '1') : $download;
                }
                $notInstalled = ['installed' => false, 'tables' => [], 'readOnly' => $readOnly];
                if (!$this->native->get($app['id']) && !isset($query['table'])) return $notInstalled;
                try {
                    $records = $this->native->records($app['id'], $table, (int) ($query['offset'] ?? 0), null, $options) + ['readOnly' => $readOnly];
                    if ($readOnly) {
                        unset($records['stamps']);
                    }
                    return $records;
                } catch (\RuntimeException $missing) {
                    // The unlocked get() saw the project.json of a first install a terminated process
                    // left unfinished; records() settled it under the lock, which removed it.
                    if ($missing->getCode() === 404 && !isset($query['table']) && !$this->native->get($app['id'])) return $notInstalled;
                    throw $missing;
                }
            }
            // The installed project's media for its owner's page: all of them in one pack, for a
            // download of the app or an editor (NativeAppService::ownerMediaPack), or one file named,
            // for a picture the page shows (ownerMediaFile).
            if (($args['operation'] ?? '') === 'media') {
                if (!empty($app['settings']['sourceProtected'])) {
                    throw new \RuntimeException('This Marketplace app is source-protected; downloading its files is disabled.', 403);
                }
                $query = $request->getQueryParams();
                if (!array_key_exists('path', $query) && !array_key_exists('kept', $query)) return $this->ownerMediaPack($request, $response, (string) $app['id']);
                $path = is_string($query['path'] ?? null) ? $query['path'] : '';
                $kept = is_string($query['kept'] ?? null) ? $query['kept'] : '';
                if ($path === '' || preg_match('/^[a-f0-9]{64}$/D', $kept) !== 1) throw new \InvalidArgumentException('Name the file and the copy of it the page has: ?path=…&kept=…');
                return $this->ownerMedia($request, $response, (string) $app['id'], $path, $kept);
            }
            if ($request->getMethod() === 'GET') {
                // available = artifacts prepared; preflight = the runtime actually starts here
                // (audit FL-03). Owner-only endpoint; preflight messages carry no paths or secrets.
                // The demo is public traffic that cannot install anything: it never forks the preflight.
                $preflight = !$readOnly && $this->native->available() ? $this->native->preflight() : null;
                // Read under the management lock, so an update left unfinished is settled before it is shown.
                // The engine block is the owner's settings view: choice, outcome, reason, and what
                // this site allows them to choose between.
                // `media=refs`: each media file named and sized, not sent (ownerProject). The app's page
                // asks for that; anything else is sent every file in base64, as it always was.
                $project = ($request->getQueryParams()['media'] ?? null) === 'refs' ? $this->native->ownerProject($app['id']) : $this->native->project($app['id']);
                // Derived from the same client files a member's frame receives, so the owner is
                // shown the engine (and the reason) their members actually get.
                $languages = RuntimeEngineService::languagesOf(NativeAppService::clientFiles($project ?? []));
                $sourceProtected = !empty($app['settings']['sourceProtected']);
                if ($sourceProtected && is_array($project)) {
                    // Never expose private Marketplace source files or media bytes to buyers.
                    $project = [
                        'home' => (bool) ($project['home'] ?? true),
                        'version' => (int) ($project['version'] ?? 1),
                        'updatedAt' => $project['updatedAt'] ?? null,
                        'access' => (string) ($project['access'] ?? 'members'),
                        'files' => (object) [],
                        'assets' => (object) [],
                        'sourceProtected' => true,
                    ];
                }
                $res = ['available' => $this->native->available(), 'ready' => $preflight !== null && $preflight['ok'], 'preflight' => $preflight, 'project' => $project, 'readOnly' => $readOnly,
                    'engine' => $this->engines->effective($app['id'], $languages), 'enginePolicy' => $this->engines->ownerPolicy()];
                if ($sourceProtected) {
                    $res['sourceProtected'] = true;
                }
                return $res;
            }
            if (!empty($app['settings']['sourceProtected'])) {
                throw new \RuntimeException('This Marketplace app is source-protected and its source cannot be modified.', 403);
            }
            $body = $request->getParsedBody();
            if (!is_array($body) || !is_array($body['project'] ?? null) || !is_int($body['expectedVersion'] ?? null) || $body['expectedVersion'] < 0) throw new \InvalidArgumentException('Provide a project and expectedVersion');
            // The engine block again, from the project JUST installed: a `.py` added or removed
            // changes the server's decision, and the owner's panel shows this answer.
            // A version that uses torch where it is off is refused before it is installed, and says why.
            $torch = $this->engines->torchRefusal($app, NativeAppService::clientFiles($body['project']));
            if ($torch !== null) throw new \InvalidArgumentException($torch);
            // For the app's history of versions (NativeAppVersions): its owner made this one, on the
            // app's page or (`how: "upload"`) from a file, and may say in a line what it is for.
            $origin = ['by' => (string) $app['ownerId'], 'how' => ($body['how'] ?? null) === 'upload' ? 'upload' : 'page', 'summary' => $body['summary'] ?? null];
            // Media the page left as they were come by name (`{kept}`) and are taken from the version
            // installed now, so a change to one page does not send the app's every picture and model again.
            $expected = $body['expectedVersion'];
            [$project, $known] = NativeAppService::namesKeptMedia($body['project']) ? $this->native->withKeptMedia($app['id'], $body['project'], $expected) : [$body['project'], null];
            unset($body);
            $installed = $this->native->install($app['id'], $project, $expected, null, $origin);
            unset($project);
            $answer = ($request->getQueryParams()['media'] ?? null) === 'refs' ? NativeAppService::mediaRefs($installed, $known ?? []) : $installed;
            return ['project' => $answer] + $this->engineAfterInstall($app['id'], RuntimeEngineService::languagesOf(NativeAppService::clientFiles($installed)));
        }, !$readOnly);
    }

    /** The image types a media file is sent as, so the owner's page can show it; any other file is sent as bytes. */
    private const OWNER_MEDIA_TYPES = ['png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'gif' => 'image/gif', 'webp' => 'image/webp', 'avif' => 'image/avif', 'svg' => 'image/svg+xml', 'ico' => 'image/x-icon', 'bmp' => 'image/bmp'];

    /** The SHA-256 a request's If-None-Match names, where it names one as this API's ETags are written ("<hex>"). */
    private static function etagAsked(Request $request): ?string
    {
        return preg_match('/^"([a-f0-9]{1,64})"$/D', trim($request->getHeaderLine('If-None-Match')), $match) === 1 ? $match[1] : null;
    }

    /**
     * One media file for the app's owner (GET /api/apps/{id}/native/media?path=…&kept=…): the bytes
     * `kept` names, the SHA-256 the page was given for them, wherever the app has them
     * (NativeAppService::ownerMediaFile); `path` is what the page calls it, for its type and name.
     * Checked with the server each time it is used (`no-cache`, answered 304 while the server still
     * has them, before anything is read), so a browser's copy is read only by its owner while signed
     * in. Whatever it is, it runs nothing where it is opened on its own: an SVG's scripts included
     * (SANDBOXED_IMAGE), and it is saved rather than shown.
     */
    private function ownerMedia(Request $request, Response $response, string $appId, string $path, string $kept): Response
    {
        $head = $request->getMethod() === 'HEAD';
        $file = $this->native->ownerMediaFile($appId, $path, $kept, self::etagAsked($request), !$head);
        if ($file === null) throw new \RuntimeException('This file is not on the server any more. Reload the page and try again.', 404);
        $extension = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        $name = trim((string) preg_replace('/[^A-Za-z0-9_.-]+/', '-', basename($path)), '-.');
        $response = $response
            ->withHeader('ETag', '"' . $file['kept'] . '"')
            ->withHeader('Cache-Control', 'private, no-cache')
            ->withHeader('X-Content-Type-Options', 'nosniff')
            ->withHeader('Content-Security-Policy', \FormLogic\Middleware\SecurityHeadersMiddleware::SANDBOXED_IMAGE)
            ->withHeader('Content-Disposition', 'attachment; filename="' . ($name === '' ? 'file' : $name) . '"');
        if (isset($file['unchanged'])) return $response->withStatus(304);
        $response = $response
            ->withHeader('Content-Type', self::OWNER_MEDIA_TYPES[$extension] ?? 'application/octet-stream')
            ->withHeader('Content-Length', (string) $file['size']);
        return isset($file['stream']) ? $response->withBody(new \Slim\Psr7\Stream($file['stream'])) : $response;
    }

    /**
     * Every media file of the installed app in one pack, for its owner's page (GET
     * /api/apps/{id}/native/media): what a download of the app or an editor reads. Checked with the
     * server each time it is used, answered 304 while the project is the one the browser's copy is of.
     * A pack that cannot be read whole says so in its own words (503).
     */
    private function ownerMediaPack(Request $request, Response $response, string $appId): Response
    {
        $head = $request->getMethod() === 'HEAD';
        try {
            $pack = $this->native->ownerMediaPack($appId, self::etagAsked($request), !$head);
        } catch (\RuntimeException $unread) {
            if ($unread->getCode() === 503 && $unread->getMessage() === NativeAppService::MEDIA_UNREADABLE) return $this->jsonError($response->withHeader('Cache-Control', 'no-store'), $unread->getMessage(), 503, 'media_unreadable');
            throw $unread;
        }
        if ($pack === null) throw new \RuntimeException('Native app not found', 404);
        $response = $response
            ->withHeader('ETag', '"' . $pack['etag'] . '"')
            ->withHeader('Cache-Control', 'private, no-cache')
            ->withHeader('X-Content-Type-Options', 'nosniff')
            ->withHeader('Content-Security-Policy', \FormLogic\Middleware\SecurityHeadersMiddleware::SANDBOXED_IMAGE)
            ->withHeader('Content-Disposition', 'attachment; filename="media.pack"');
        if (isset($pack['unchanged'])) return $response->withStatus(304);
        $response = $response
            ->withHeader('Content-Type', 'application/octet-stream')
            ->withHeader('Content-Length', (string) $pack['size']);
        return isset($pack['stream']) ? $response->withBody(new \Slim\Psr7\Stream($pack['stream'])) : $response;
    }

    /**
     * One part of a download's file name (the app's slug, a table's name): letters, digits, `_`
     * and `-` alone, so nothing in it can end the quoted name or begin another header.
     */
    private static function fileName(string $name, string $fallback): string
    {
        $safe = trim(substr((string) preg_replace('/[^A-Za-z0-9_-]+/', '-', $name), 0, 60), '-');
        return $safe === '' ? $fallback : $safe;
    }

    /**
     * The owner's engine view after an install that has already committed. A resolver failure here
     * is logged and leaves the block out rather than answering 503 for an install that succeeded:
     * the panel keeps the engine it had, and the next GET shows the fresh one.
     *
     * @param list<string> $languages
     */
    private function engineAfterInstall(string $appId, array $languages): array
    {
        try {
            return ['engine' => $this->engines->effective($appId, $languages), 'enginePolicy' => $this->engines->ownerPolicy()];
        } catch (\Throwable $e) {
            error_log('Native app engine after install unavailable: ' . $e->getMessage());
            return [];
        }
    }

    /**
     * Public entry metadata only; application source remains behind runtime access checks.
     * Read without the management lock on purpose: this runs on every visit, and the locked
     * read would answer 409 to every visitor for the length of each install (and hold the lock
     * against the installer). An unsettled update affects only home/access here; the runtime
     * reads that follow settle it.
     */
    public function entry(Request $request, Response $response, array $args): Response
    {
        $app = $this->apps->getAppBySlug((string) $args['slug']);
        if (!$app || !$this->apps->isRuntimeVisible($app, $request->getAttribute('userId'))) return $this->jsonResponse($response->withHeader('Cache-Control', 'no-store'), ['home' => false]);
        return $this->respond($response, function () use ($app) {
            $project = $this->native->summary($app['id']);
            $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
            $entry = ['home' => (bool) ($project['home'] ?? false), 'access' => $project['access'] ?? 'members', 'native' => $project !== null];
            $demoSandboxSlug = is_string($settings['demoSandboxPackSlug'] ?? null) ? trim((string) $settings['demoSandboxPackSlug']) : '';
            if ($demoSandboxSlug !== '' && !empty($settings['softnApp'])) {
                $softnCatalog = new \FormLogic\Services\SoftnPackCatalog();
                if ($softnCatalog->getMeta($demoSandboxSlug) !== null) {
                    $entry['home'] = true;
                    $entry['access'] = 'application';
                    $entry['demoSandboxSlug'] = $demoSandboxSlug;
                    $entry['appId'] = (string) ($app['id'] ?? '');
                    $entry['appName'] = (string) ($app['name'] ?? '');
                    $entry['linkedFormAppSlug'] = is_string($settings['linkedFormAppSlug'] ?? null) ? $settings['linkedFormAppSlug'] : null;
                    $entry['linkedFormAppName'] = is_string($settings['linkedFormAppName'] ?? null) ? $settings['linkedFormAppName'] : null;
                }
            }
            return $entry;
        });
    }

    /**
     * The media pack, streamed from disk. Its address carries its SHA-256 (`?h=`), so the browser
     * keeps what it fetched for as long as the app is unchanged, privately: a members-only or gated
     * app's pictures must never sit in a shared cache, Cloudflare's included. An address naming
     * another version is a page that read the project before an update: sent this pack, the old
     * version's code ran on the new one's media, files renamed or removed missing. It is refused
     * (409), and the page asks again. One naming none is answered with this pack, checked each time.
     *
     * A members-only app's media, or one behind a pass, are checked with the server each time they are used (`no-cache`,
     * answered 304 while unchanged), so a browser's copy is only ever read by someone still admitted.
     *
     * @param array{file?: string, sha256?: string, size?: int, stream?: resource} $media opened under the app's lock (NativeAppService::runtimeProject)
     */
    private function mediaPack(Request $request, Response $response, array $media, bool $revalidate): Response
    {
        $stream = $media['stream'] ?? false;
        $hash = (string) ($media['sha256'] ?? '');
        if (!is_resource($stream) || $hash === '') { if (is_resource($stream)) fclose($stream); throw new \RuntimeException('The app\'s media could not be read', 503); }
        $etag = '"' . $hash . '"';
        $current = hash_equals($hash, (string) ($request->getQueryParams()['h'] ?? ''));
        $response = $response
            ->withHeader('ETag', $etag)
            ->withHeader('Cache-Control', $current && !$revalidate ? 'private, max-age=31536000, immutable' : 'private, no-cache')
            ->withHeader('X-Content-Type-Options', 'nosniff');
        if (trim($request->getHeaderLine('If-None-Match')) === $etag) { fclose($stream); return $response->withStatus(304); }
        return $response
            ->withHeader('Content-Type', 'application/octet-stream')
            ->withHeader('Content-Length', (string) (fstat($stream)['size'] ?? 0))
            ->withBody(new \Slim\Psr7\Stream($stream));
    }

    /**
     * What the page shows before the app does, and where it is installed or shared (AppLookService):
     * the loading colours, the theme colour, the description, and which icon there is with the
     * version its address carries. Not for a plugin's page, which looks like the site's own. A look
     * that cannot be read is left out: the page shows its own.
     */
    private function lookForRuntime(array $app, ?array $plugin): array
    {
        if ($this->look === null || $plugin !== null) return [];
        try { $look = $this->look->resolve($app); } catch (\Throwable) { return []; }
        if ($look === null) return [];
        return ['look' => ['background' => $look['background'], 'spinner' => $look['spinner'], 'themeColor' => $look['themeColor'], 'description' => $look['description'], 'icon' => $look['iconKind'], 'version' => $look['version'],
            // Whether its manifest is served (AppPublicController::manifest): only a published app's, and a
            // browser asks for it without the owner's sign-in, so a draft's page links none.
            'installable' => ($app['status'] ?? '') === 'published']];
    }

    public function runtime(Request $request, Response $response, array $args): Response
    {
        $started = hrtime(true);
        // When the call came, for its record (NativeAppCalls): written after its answer on some servers.
        $arrived = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $app = $this->apps->getAppBySlug((string) $args['slug']);
        $user = $request->getAttribute('userId');
        $owner = $app && $user && $app['ownerId'] === $user;
        if (!$app || !$this->apps->isRuntimeVisible($app, (string) ($user ?? ''))) return $this->jsonError($response, 'App not found or access denied', 404);
        if ($blocked = $this->blockIfDemo($request, $response, 'Native hosting is unavailable in the shared demo.')) return $blocked;
        // A plugin's own app (PluginService): any signed-in person on this site runs its pages, as
        // a member with no membership row, while the plugin is enabled. Nobody owns it.
        $plugin = $this->plugins?->forApp($app);
        // The app's media, as one pack (NativeAppService::MEDIA_PACK_MAGIC), admitted exactly as the
        // project it belongs to is; and the project without its media, for a page that fetches the
        // pack (`?media=pack`). A page from before the pack is sent the media in the project, as always.
        $mediaRoute = $request->getMethod() === 'GET' && str_ends_with($request->getUri()->getPath(), '/native/media');
        $packed = $mediaRoute || ($request->getMethod() === 'GET' && ($request->getQueryParams()['media'] ?? '') === 'pack');
        // Only the app's version (`?only=version`), for a page that has the app open and asks whether
        // there is a newer one: admitted exactly as the project is, below, and nothing else is read or sent.
        $probe = !$mediaRoute && $request->getMethod() === 'GET' && ($request->getQueryParams()['only'] ?? '') === 'version';
        // A visitor's cookie, set (or its age renewed) for an app that asks for visitors (AppVisitors).
        $setCookie = null;
        // A call to the app's backend, once the request is one (its method and path, and who is
        // calling), and the backend's answer to it: written down for the app's owner once the call
        // is answered (recordCall).
        $call = null;
        $outcome = null;
        // The installed manifest's text, for whether an address the backend did not have is one the app
        // declares (recordCall); read only where that is asked.
        $manifest = null;
        // A call that dies in PHP itself (out of time or memory) ends the script: it is written down
        // as one that was never answered, by the function PHP runs as it ends (unansweredAtShutdown).
        $written = false;
        if ($this->calls !== null && $request->getMethod() === 'POST') {
            register_shutdown_function(function () use (&$call, &$written, &$manifest, $app, $started, $arrived): void {
                if (!$written && $call !== null && $app) $this->unansweredAtShutdown((string) $app['id'], $call, $started, $arrived, $manifest);
            });
        }
        $operation = function () use ($request, $response, $app, $user, $owner, $plugin, $mediaRoute, $packed, $probe, &$setCookie, &$call, &$outcome, &$manifest) {
            // Access is decided against the settled project (FL-S04), never an update's leftover project.json.
            // Read without its media where nothing here sends them: a game's are tens of megabytes. An
            // app's API call needs only its version and access, and decoded every picture and sound
            // for them on each call, a game with no backend to call included.
            $light = $packed || $probe || $request->getMethod() !== 'GET';
            $runtime = $light ? $this->native->runtimeProject($app['id']) : null;
            $project = $light ? ($runtime['project'] ?? null) : $this->native->project($app['id']);
            if (!$project) throw new \RuntimeException('Native app not found', 404);
            if ($plugin !== null) {
                if (!$plugin['enabled']) throw new \RuntimeException('This plugin is turned off on this site.', 403);
                if (!$user) throw new \RuntimeException('Sign in to continue', 403);
                $project['access'] = 'members';
                $membership = ['status' => 'active', 'roleId' => 'member'];
            } else {
                $membership = $user && !$owner && $project['access'] === 'members' ? $this->users->getAppUser($app['id'], $user) : null;
            }
            if ($project['access'] === 'members' && !$owner && (!$user || ($membership['status'] ?? '') !== 'active')) throw new \RuntimeException('Sign in with an active app membership to continue', 403);
            // The page was loaded on one engine; the server may have decided otherwise since (a
            // revocation, a policy edit). Inside respond(), so a resolver that cannot answer is the
            // same generic 503 every other failure here is; the refusal itself is a Response, which
            // respond() passes through, so it keeps the engine_changed code the parent remounts on.
            if ($stale = $this->refuseStaleEngine($request, $response, $app['id'])) return $stale;
            // The version alone, to whoever was just admitted to the project itself: no file of it, no
            // visitor's cookie, nothing a full opening would not also say.
            if ($probe) return ['version' => (int) ($project['version'] ?? 0)];
            $identity =$project['access'] === 'members' ? ['formlogic' => ['appId' => $app['id'], 'userId' => $user, 'roleId' => $owner ? 'owner' : ($membership['roleId'] ?? null)]] : [];
            // What the app asks of FormLogic itself (AppFormlogicManifest). Only an app that declares
            // AI or payments is given visitors and the context that goes with them; every other app's
            // requests are exactly what they were (Coffee.Dating reads any `formlogic` it is given as
            // a FormLogic member, and would refuse its own visitors).
            $asks = $plugin === null ? self::formlogicAsks($project) : null;
            if ($mediaRoute) {
                // An address naming another version than the one read for this request: refused before it is
                // opened (mediaPack).
                $asked = (string) ($request->getQueryParams()['h'] ?? '');
                if ($asked !== '' && !hash_equals((string) ($runtime['media']['sha256'] ?? ''), $asked)) throw new \RuntimeException('The app was updated while it was opening. Reload and try again.', 409);
                // Opened only now, admitted, and under the app's lock: an update cannot replace the pack while it
                // is sent, and one that came between the two reads is refused rather than sent unchecked.
                $opened = $this->native->runtimeProject($app['id'], true);
                $stream = $opened['media']['stream'] ?? null;
                if (($opened['media']['sha256'] ?? null) !== ($runtime['media']['sha256'] ?? null) || ($opened['project']['access'] ?? null) !== ($runtime['project']['access'] ?? null)) {
                    if (is_resource($stream)) fclose($stream);
                    throw new \RuntimeException('The app was updated while it was opening. Reload and try again.', 409);
                }
                // Members-only, or behind a pass: checked with the server each time, never read from the browser's copy unasked.
                $requires = is_array($app['settings'] ?? null) && !empty($app['settings']['requires']);
                return $this->mediaPack($request, $response, $opened['media'], $project['access'] === 'members' || $requires || $plugin !== null);
            }
            if ($request->getMethod() === 'GET') {
                $client = NativeAppService::clientFiles($project);
                // What this app's logic is written in, from these file names — the ones about to be
                // posted into the frame — and nothing else. A `.py` among them means the app needs
                // Python, which only zipp-web-python runs; the resolver clamps to it, and this
                // install must already know the rule or the app is not served at all.
                $languages = RuntimeEngineService::languagesOf($client);
                $this->engines->assertInstalledRuns($languages);
                // torch, where the site or the app turns it off: the app is not served.
                $this->engines->assertTorchAllowed($app, $client);
                $manifest = json_decode($client['manifest.json'], true);
                $origins = $manifest['config']['server']['allowedOrigins'] ?? [];
                unset($manifest['server'], $manifest['config']['server']);
                // The engine is the server's decision, never the project's: a manifest that names
                // one is stripped here, the way the server block above is, so a published project
                // can never talk its own shell into another engine.
                unset($manifest['engine'], $manifest['logicEngine'], $manifest['config']['engine']);
                // FormLogic's own sections are for FormLogic, not the page.
                unset($manifest['formlogicAi'], $manifest['formlogicPayments']);
                $client['manifest.json'] = json_encode($manifest, JSON_THROW_ON_ERROR);
                $client['permission.json'] = '{"permissions":{}}';
                // This host-owned namespace is emitted only after visibility and membership
                // admission. Neither manifest metadata nor client input can name its principal;
                // roles and slugs can change without changing the app/account's saved state.
                $storageScope = ['access' => $project['access'], 'appId' => $app['id']];
                if ($project['access'] === 'members') $storageScope['userId'] = $user;
                $media = $runtime['media'] ?? null;
                $served = $media !== null
                    // The pack's address names its content, so the browser keeps it until the app changes.
                    // `url` is under the API's own base, as every route the page calls is named.
                    ? ['assets' => (object) [], 'media' => ['url' => '/app/' . rawurlencode((string) $app['slug']) . '/native/media?h=' . $media['sha256'], 'sha256' => $media['sha256'], 'size' => $media['size'], 'count' => $media['count']]]
                    : ['assets' => $project['assets']];
                // Whether the app may open and save the person's files, as its owner chose (AppService's
                // settings.softnFiles): 'ask' has the page ask each person first. A plugin's page never may.
                $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
                $files = $plugin === null && in_array($settings['softnFiles'] ?? null, ['ask', 'allow'], true) ? ['files' => $settings['softnFiles']] : [];
                // What else the app may ask of FormLogic's own page, each off unless its owner allowed
                // it, and never for a plugin's page. `listen`: the page may listen to the person for
                // it and give it the words (settings.softnListen, and only while the site's speech
                // server would be asked for this app: AppListening::on). `offers`: it may offer the
                // signed-in person an app it made, which the page asks them about and adds to their
                // own apps (settings.softnApps).
                $asked = [
                    'listen' => $plugin === null && $this->listening !== null && $this->listening->on($app),
                    'offers' => $plugin === null && ($settings['softnApps'] ?? null) === 'allow',
                ];
                // An app that asks for FormLogic's visitors, AI or payments: the page marks its
                // requests (X-FormLogic-Visitor) and may open FormLogic's wallet. Its visitors'
                // browsers get their cookie here, or have its age renewed, once a page load.
                $formlogic = [];
                if ($asks !== null) {
                    $formlogic = ['formlogic' => ['visitors' => $project['access'] === 'application', 'ai' => $asks['ai'] !== null, 'payments' => $asks['payments'] !== null]];
                    if ($project['access'] === 'application' && $this->visitors !== null) $setCookie = $this->visitors->cookieFor($request);
                }
                // Whoever has the app open is shown a newer version as it is published, in the page they
                // have open (`updates: live`: the page asks for the version now and then, `?only=version`
                // above, and hands a newer one to the running app). `updatesEvery` is how many seconds
                // apart it asks while the page is looked at: the owner, who is the one publishing, sooner
                // than everyone else, who are many. A plugin's pages change with the plugin, not here.
                $updates = $plugin === null ? ['updates' => 'live', 'updatesEvery' => $owner ? self::UPDATES_EVERY_OWNER : self::UPDATES_EVERY] : [];
                // A JavaScript app: its pages are a built site, which the page shows in a frame of
                // its own from this address (SiteAppController). The ticket in it is what admits
                // the frame's requests, which carry no session, so it is made here: after
                // visibility, membership and the gate have admitted whoever is asking. `proof` is
                // what the site's page shows the framing page to be given its line to the backend.
                $site = [];
                $built = $plugin === null && isset($manifest['site']) ? $this->native->site((string) $app['id']) : null;
                if ($built !== null) {
                    // `frame`: the value this browser keeps for this app (SiteAppFrame), so its address
                    // is its own and stays the same for the day. One that sends none is given one.
                    $frame = $request->getQueryParams()['frame'] ?? null;
                    $ticket = NativeAppService::siteTicket($built['key'], (string) $app['id'], $built['version'], null, is_string($frame) ? $frame : null);
                    $site = ['site' => ['url' => SiteAppController::address((string) $app['slug'], $ticket, $built['entry']), 'entry' => $built['entry'], 'proof' => NativeAppService::siteProof($built['key'], $ticket)]];
                }
                $containerBackend = $plugin === null && NativeAppService::hasContainerBackend($project) ? ['containerBackend' => 'host'] : [];
                $ownerMeta = $plugin === null && $owner ? ['isOwner' => true] : [];
                return ['name' => $app['name'], 'project' => ['version' => $project['version'], 'client' => $client] + $served + ['access' => $project['access'], 'origins' => $origins, 'storageScope' => $storageScope] + $files + $asked + $formlogic + $site + $containerBackend]
                    + $ownerMeta + $updates + $this->lookForRuntime($app, $plugin) + $this->engineForRuntime($app['id'], $languages);
            }
            $input = $request->getParsedBody();
            // From here the request asks for one of the site's workers, and its account's share of
            // them is counted (NativeAppService::ownedBy). A plugin's app is the site's, and nobody's.
            if ($plugin === null) $this->native->ownedBy((string) $app['id'], (string) ($app['ownerId'] ?? ''));
            if ($plugin === null && NativeAppService::hasContainerBackend($project)) {
                $method = is_array($input) && is_string($input['method'] ?? null) ? strtoupper(trim($input['method'])) : '';
                $path = is_array($input) && is_string($input['path'] ?? null) ? $input['path'] : '';
                if (
                    $path === ''
                    || !str_starts_with($path, '/')
                    || str_starts_with($path, '//')
                    || strlen($path) > 2048
                    || str_contains($path, '..')
                    || str_contains($path, '\\')
                    || preg_match('/(?:%2e|%2f|%5c|[\x00-\x1f\x7f])/i', $path) === 1
                    || !in_array($method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'], true)
                ) {
                    throw new \InvalidArgumentException('Provide a valid container API path and method');
                }
                // The path the app's .htaccess and its backend read: decoded once, as SoftN's hosts
                // decode it at ingress and as this site's public API does (ExternalAppApiController).
                // Handed on as it came, `/api/%61dmin` passed a rule written for `/api/admin` that the
                // PHP app's own router, which decodes, then served. With `%25` refused, nothing in what
                // is handed on can be decoded again into something else.
                $decoded = rawurldecode($path);
                if (
                    preg_match('/%(?![0-9A-Fa-f]{2})|%(?:25|3f|23)/i', $path) === 1
                    || preg_match('/[\x00-\x1f\x7f]/', $decoded) === 1
                    || preg_match('//u', $decoded) !== 1
                ) {
                    throw new \InvalidArgumentException('Provide a valid container API path and method');
                }
                $path = $decoded;
                $decodedPath = strtolower(preg_replace('#/+#', '/', $path) ?? $path);
                if (str_starts_with($decodedPath, PluginService::SITE_ROUTE_PREFIX)) throw new \RuntimeException('Not found', 404);
                if (in_array($method, ['GET', 'POST', 'PUT', 'DELETE'], true)) {
                    $call = ['method' => $method, 'path' => $path, 'caller' => $owner ? 'owner' : ($project['access'] === 'members' ? 'member' : 'visitor')];
                    $manifest = is_string($project['files']['manifest.json'] ?? null) ? $project['files']['manifest.json'] : null;
                }
                if (in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true) && $this->plans->isEnforced() && !$this->plans->isCloudActive($app['ownerId'])) {
                    throw new \RuntimeException('The app owner’s cloud access has expired. Records remain available to read and export.', 402);
                }
                $headers = self::appRequestHeaders(is_array($input['headers'] ?? null) ? $input['headers'] : []);
                $query = '';
                if (is_string($input['query'] ?? null)) {
                    $query = ltrim($input['query'], '?');
                } elseif (is_array($input['query'] ?? null)) {
                    $query = http_build_query($input['query']);
                }
                if (strlen($query) > 4096 || preg_match('/[\x00-\x1f\x7f]/', $query) === 1) {
                    throw new \InvalidArgumentException('Invalid container query string');
                }
                $bodyBase64 = '';
                if (is_string($input['bodyBase64'] ?? null)) {
                    $bodyBase64 = $input['bodyBase64'];
                } elseif (array_key_exists('body', $input) && $input['body'] !== null && !in_array($method, ['GET', 'HEAD'], true)) {
                    $bodyBase64 = base64_encode(is_string($input['body']) ? $input['body'] : json_encode($input['body'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
                }
                if (strlen($bodyBase64) > 7600000) throw new \RuntimeException('This request is larger than the app accepts.', 413);
                $addresses = \FormLogic\Helpers\IpResolver::fromEnvironment();
                // The name and scheme the person reached this site by, as every other address the
                // site hands out is made (McpOAuthService::publicOrigin), and never a `host` the
                // app's page sent (refused above), as every caller of a container backend gives
                // them (NativeAppService::containerAddress). Without them the runner tells a PHP
                // backend it is http://localhost, and every link the backend writes says so.
                $containerReq = [
                    'method' => $method,
                    'path' => $path,
                    'query' => $query,
                    'headers' => (object) $headers,
                    'bodyBase64' => $bodyBase64,
                    'client_ip' => $addresses->getClientIp($request),
                ] + NativeAppService::containerAddress(\FormLogic\Services\McpOAuthService::publicOrigin($request));
                $subscriptions = $this->recordSubscriptionsFor((string) $app['id']);
                $result = $this->native->containerRequest($app['id'], $containerReq, $identity, (int) ($project['version'] ?? 0), $subscriptions);
                $extractedHeaders = NativeRecordEventRouter::extractContainerTriggers($result['headers']);
                $result['headers'] = $extractedHeaders['headers'];
                $triggers = $extractedHeaders['triggers'];
                try {
                    $this->native->dispatchRecordEvents($app['id'], $this->records->for($app['id']));
                } catch (\Throwable $error) {
                    error_log('Native record automation delivery pending for container app ' . $app['id']);
                }
                if ($triggers !== []) {
                    try { $this->records->triggerBackendFlows($app, $triggers); } catch (\Throwable) {}
                }
                $outcome = ['status' => $result['status'], 'body' => null];
                return ['result' => $result];
            }
            if (!is_array($input) || !is_string($input['path'] ?? null) || !preg_match('~^/api/[a-zA-Z0-9/_-]+$~D', $input['path']) || !in_array($input['method'] ?? null, ['GET','POST','PUT','DELETE'], true)) throw new \InvalidArgumentException('Provide an app API path and method');
            // /api/site/ routes are the site's own to call (App AI's deliveries, a plugin's camera
            // check: CameraCheckService), never a page's, for every app.
            if (str_starts_with(strtolower($input['path']), PluginService::SITE_ROUTE_PREFIX)) throw new \RuntimeException('Not found', 404);
            // From here the request is a call to the app's backend, answered or refused, and its owner
            // sees it among the app's calls: by its method and path and who made it, never what it carried.
            // A plugin's app is the site's, and nobody's to look at.
            if ($plugin === null) {
                $call = ['method' => $input['method'], 'path' => $input['path'], 'caller' => $owner ? 'owner' : ($project['access'] === 'members' ? 'member' : 'visitor')];
                $manifest = is_string($project['files']['manifest.json'] ?? null) ? $project['files']['manifest.json'] : null;
            }
            // A plugin is the site's own, on no one's plan.
            if ($plugin === null && in_array($input['method'], ['POST', 'PUT', 'DELETE'], true) && $this->plans->isEnforced() && !$this->plans->isCloudActive($app['ownerId'])) throw new \RuntimeException('The app owner’s cloud access has expired. Records remain available to read and export.', 402);
            $headers = is_array($input['headers'] ?? null) ? array_change_key_case($input['headers'], CASE_LOWER) : [];
            $authorization = is_string($headers['authorization'] ?? null) ? $headers['authorization'] : '';
            if (strlen($authorization) > 4096) throw new \InvalidArgumentException('Invalid application authorization');
            // An app retries a write with the same Idempotency-Key, so its backend can tell the
            // retry from a second write; it is passed on as the app sent it.
            $idempotency = is_string($headers['idempotency-key'] ?? null) ? $headers['idempotency-key'] : '';
            if (strlen($idempotency) > 255) throw new \InvalidArgumentException('Invalid idempotency key');
            // The body as the app sent it. The parsed request is arrays only, where `{}` and `[]`
            // are one, so an empty object reached the backend as a list.
            $sent = json_decode((string) $request->getBody(), false, 512);
            $body = is_object($sent) && property_exists($sent, 'body') && $sent->body !== null ? $sent->body : ($input['body'] ?? (object) []);
            if (is_string($body)) $body = json_decode($body, false, 64, JSON_THROW_ON_ERROR);
            if (!is_array($body) && !is_object($body)) throw new \InvalidArgumentException('App request body must be JSON');
            $addresses = \FormLogic\Helpers\IpResolver::fromEnvironment();
            $nativeRequest = [
                'method' => $input['method'], 'path' => $input['path'], 'query' => (object) ($input['query'] ?? []), 'body' => $body,
                // Both always present, empty when not sent, as SoftN's PHP host gives them. With
                // them, the other headers the app's own request carries, as its handlers are given
                // them on SoftN's hosts: every one but the cookie and those the host speaks for.
                'headers' => (object) (['authorization' => $authorization, 'idempotency-key' => $idempotency] + self::appRequestHeaders($headers, false)),
                'client_ip' => $addresses->getClientIp($request), 'photos' => false,
            ];
            $subscriptions = $this->recordSubscriptionsFor((string) $app['id']);
            $requester = null;
            if ($asks !== null) [$identity, $subscriptions, $setCookie, $requester] = $this->formlogicRequest($request, $app, $project, $asks, $identity, $subscriptions, (string) $nativeRequest['client_ip'], $user, $owner, $addresses->knownClientIp($request));
            // The app's own page (not a plugin's): photos are redrawn here, and the body held to its route.
            // $context is the host's word to the backend, added to who is asking (never the caller's);
            // $who replaces who is asking, for a charge's second run (NativeAppCharges).
            $run = fn(array $context = [], ?array $who = null) => $this->native->request($app['id'], $nativeRequest, ($who ?? $identity) + $context, $subscriptions, (int) ($project['version'] ?? 0), true, $plugin === null ? 'app' : 'plugin');
            if ($plugin === null && $this->charges !== null && ($asks['payments'] ?? null) !== null && NativeAppCharges::applies($asks['payments'], $nativeRequest)) {
                // A route that may ask for a charge: run once, and again with the outcome.
                // Both runs in one worker slot, held from the first to the last, so a debit is never
                // followed by a second run turned away busy.
                $result = $this->charges->handle($app, $asks['payments'], $requester, $identity, static fn(array $who) => $run([], $who),
                    fn(callable $work): array => $this->native->withSlots((string) $app['id'], $work),
                    fn(): bool => $this->native->lastRunRolledBack());
            } else {
                $result = $plugin === null && $this->verification !== null && $this->verification->applies($app['id'], $nativeRequest)
                    ? $this->verification->handle($app['id'], $nativeRequest, $run)
                    : $run();
            }
            if ($plugin !== null) {
                if ($this->gate === null) throw new \RuntimeException('Plugins are not available', 503);
                $result = $this->gate->recordFromPluginAnswer($plugin, (string) $user, $input['method'], $input['path'], $result);
            }
            $triggers = [];
            if ($plugin === null && is_array($result) && array_key_exists('body', $result)) {
                $extracted = NativeRecordEventRouter::extractBodyTriggers($result['body']);
                $result['body'] = $extracted['body'];
                $triggers = $extracted['triggers'];
            }
            $outcome = is_array($result) ? $result : null;
            try {
                $this->native->dispatchRecordEvents($app['id'], $this->records->for($app['id']));
            } catch (\Throwable $error) {
                // The app write already committed. Returning an error here could make the
                // caller repeat it; retain the durable event for the recovery dispatcher.
                error_log('Native record automation delivery pending for app ' . $app['id']);
            }
            if ($triggers !== []) {
                try { $this->records->triggerBackendFlows($app, $triggers); } catch (\Throwable) {}
            }
            return ['result' => $result];
        };
        try {
            $answer = $this->respond($response, $operation);
        } catch (\Throwable $failed) {
            // Failed in a way respond() does not answer (an Error in PHP itself): written down as the
            // 500 the caller is given, then left to the site's error handler as before.
            $written = true;
            if ($call !== null && $app) $this->recordUnanswered((string) $app['id'], $call, 500, self::FAILED_HERE, $started, $arrived, $manifest, true);
            throw $failed;
        }
        $written = true;
        if ($call !== null && $app) $this->recordCall((string) $app['id'], $call, $outcome, $answer, $started, $arrived, $manifest);
        return $setCookie !== null ? $answer->withAddedHeader('Set-Cookie', $setCookie) : $answer;
    }

    /** What the owner's list says of a call FormLogic failed on while answering (recordUnanswered). */
    private const FAILED_HERE = 'FormLogic failed while answering this call. The server’s log says why.';
    /** And of one PHP stopped before it was answered. */
    private const STOPPED_HERE = 'The call was stopped before it was answered: it took too long, or ran out of memory.';

    /**
     * A call PHP ended before it was answered (its time or its memory ran out): written down as one
     * with no answer (status 0). Run by the shutdown function runtime() registers, and only for an
     * error that ends a script; any other ending was written down already. ($last: the error PHP
     * ended on, error_get_last()'s; given by the tests, which cannot end their own script.)
     */
    public function unansweredAtShutdown(string $appId, array $call, int $started, \DateTimeImmutable $arrived, ?string $manifest, ?array $last = null): void
    {
        $last ??= error_get_last();
        if (!is_array($last) || !in_array($last['type'] ?? 0, [E_ERROR, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR], true)) return;
        $this->recordUnanswered($appId, $call, 0, self::STOPPED_HERE, $started, $arrived, $manifest, false);
    }

    /**
     * Write down a call FormLogic answered with no answer of the app's: never fails, as recordCall.
     * $later: after the answer where the server can end one early, as recordCall does (not at
     * shutdown, where the script is ending anyway).
     */
    private function recordUnanswered(string $appId, array $call, int $status, string $error, int $started, \DateTimeImmutable $arrived, ?string $manifest, bool $later): void
    {
        if ($this->calls === null) return;
        try {
            $calls = $this->calls;
            $path = self::keptPath($call, $manifest);
            $milliseconds = intdiv(max(0, hrtime(true) - $started), 1_000_000);
            $write = static function () use ($calls, $appId, $call, $path, $status, $milliseconds, $error, $arrived): void {
                $calls->record($appId, (string) $call['method'], $path, $status, $milliseconds, $error, (string) $call['caller'], $arrived);
            };
            if ($later && AfterResponse::serverCanFinish()) AfterResponse::run($write);
            else $write();
        } catch (\Throwable $e) {
            error_log('App call not recorded for app ' . $appId . ': ' . get_class($e));
        }
    }

    /**
     * The address a call is written down with: its own, but for a call from anyone other than the
     * owner to an address the app does not declare, whatever it was answered with (a 404, or a
     * refusal before any route was looked for), which is written without one. Anyone can send any
     * words there, and the owner's list is never to show them.
     */
    private static function keptPath(array $call, ?string $manifest): string
    {
        $path = (string) $call['path'];
        return ($call['caller'] ?? null) !== 'owner' && !self::declaresPath($manifest, $path) ? '' : $path;
    }

    /**
     * Whether the app's manifest declares a route at $path (for any method): an address the app has.
     * One it does not, or a manifest that cannot be read, is an address the caller made up.
     */
    private static function declaresPath(?string $manifest, string $path): bool
    {
        $decoded = $manifest !== null ? json_decode($manifest, true) : null;
        $routes = is_array($decoded) ? ($decoded['server']['routes'] ?? null) : null;
        if (!is_array($routes)) return false;
        foreach ($routes as $route) {
            if (is_array($route) && ($route['path'] ?? null) === $path) return true;
        }
        return false;
    }

    /**
     * Write down one call to the app's backend (NativeAppCalls) now it is answered: the status the
     * backend answered with, or the one FormLogic refused it with; how long the answer took, from
     * the request's arrival; and, where it failed, the first words of why, as the caller was told
     * them. Best effort: whatever happens here, the caller is answered as before.
     *
     * Where the server can end an answer early (PHP-FPM, LiteSpeed), the call is written once the
     * caller has its answer (AfterResponse). Elsewhere it is written before, as one quick statement:
     * there, waiting for later would close the connection and turn compression off for every call
     * (AfterResponseMiddleware), which costs more than the write.
     */
    private function recordCall(string $appId, array $call, ?array $outcome, Response $answer, int $started, \DateTimeImmutable $arrived, ?string $manifest = null): void
    {
        if ($this->calls === null) return;
        try {
            if ($outcome !== null && $answer->getStatusCode() === 200) {
                $status = is_numeric($outcome['status'] ?? null) ? (int) $outcome['status'] : 500;
                $error = $status >= 400 ? NativeAppCalls::errorOf($outcome['body'] ?? null) : null;
            } else {
                // Refused here, or failed before the backend answered: what FormLogic answered is a
                // short JSON error, whose message is what the caller read.
                $status = $answer->getStatusCode();
                $said = json_decode((string) $answer->getBody(), true);
                $error = is_array($said) && is_string($said['message'] ?? null) ? $said['message'] : null;
            }
            // A call to an address the app does not have, from anyone but its owner, however it was
            // answered: written without the address (keptPath). The owner's own calls keep theirs.
            $path = self::keptPath($call, $manifest);
            $calls = $this->calls;
            $milliseconds = intdiv(max(0, hrtime(true) - $started), 1_000_000);
            $write = static function () use ($calls, $appId, $call, $path, $status, $milliseconds, $error, $arrived): void {
                $calls->record($appId, (string) $call['method'], $path, $status, $milliseconds, $error, (string) $call['caller'], $arrived);
            };
            if (AfterResponse::serverCanFinish()) AfterResponse::run($write);
            else $write();
        } catch (\Throwable $e) {
            error_log('App call not recorded for app ' . $appId . ': ' . get_class($e));
        }
    }

    /**
     * A recording put into words for an app (AppListening), from FormLogic's own page, never the
     * app's frame: POST /api/app/{slug}/native/listen {audio: a RIFF/WAVE file in base64}. The page
     * records the person once they said it may, and gives the app the words this answers,
     * `{data: {text, seconds}}`; the app never has the sound. Admitted as the app's own requests are
     * (runtime()): whoever may open the app, a members' app's member or anyone at one open to all.
     * A plugin's page is never listened for.
     *
     * Refused in a plain sentence with a code: `listen_off` (403) where listening is not on for the
     * app now, `invalid_audio` (400), `too_long` (413), `listen_failed` (502) when the speech
     * server did not answer with words. Nothing is kept of the sound or the words.
     */
    public function listen(Request $request, Response $response, array $args): Response
    {
        $app = $this->apps->getAppBySlug((string) ($args['slug'] ?? ''));
        $user = $request->getAttribute('userId');
        $owner = $app && $user && $app['ownerId'] === $user;
        if (!$app || !$this->apps->isRuntimeVisible($app, (string) ($user ?? ''))) return $this->jsonError($response, 'App not found or access denied', 404);
        if ($blocked = $this->blockIfDemo($request, $response, 'Native hosting is unavailable in the shared demo.')) return $blocked;
        $setCookie = null;
        $answer = $this->respond($response, function () use ($request, $response, $app, $user, $owner, &$setCookie) {
            $off = fn(): Response => $this->jsonError($response->withHeader('Cache-Control', 'no-store'), 'Listening is not turned on for this app.', 403, 'listen_off');
            if ($this->plugins?->forApp($app) !== null) return $off();
            // Who may open the app, as runtime() decides it, against the settled project.
            $project = $this->native->runtimeProject($app['id'])['project'] ?? null;
            if (!$project) throw new \RuntimeException('Native app not found', 404);
            $membership = $user && !$owner && $project['access'] === 'members' ? $this->users->getAppUser($app['id'], $user) : null;
            if ($project['access'] === 'members' && !$owner && (!$user || ($membership['status'] ?? '') !== 'active')) throw new \RuntimeException('Sign in with an active app membership to continue', 403);
            if ($this->listening === null) return $off();
            // Who is asking, and from where, as App AI counts a request of this app's
            // (formlogicRequest): a members' app's member, or the visitor this browser is, where the
            // page marks the request as the app's own requests are marked. The recording is taken
            // from their allowances (AppListening::hear).
            $requester = null;
            if ($project['access'] === 'members') {
                $requester = ['kind' => 'user', 'id' => (string) $user];
            } elseif ($this->visitors !== null) {
                $visitor = $this->visitors->resolve($request, (string) $app['id'], $this->visitors->marked($request));
                if ($visitor !== null) {
                    $requester = ['kind' => 'visitor', 'id' => $visitor['id']];
                    $setCookie = $visitor['setCookie'];
                }
            }
            $ip = \FormLogic\Helpers\IpResolver::fromEnvironment()->getClientIp($request);
            $input = $request->getParsedBody();
            // The speech server is waited for up to AppListening::TIMEOUT seconds: longer than a
            // request is given on many servers. (Not where there is no limit, the command line's.)
            $limit = (int) ini_get('max_execution_time');
            if ($limit > 0 && $limit < AppListening::TIMEOUT + 30) @set_time_limit(AppListening::TIMEOUT + 30);
            try {
                $heard = $this->listening->hear($app, is_array($input) ? ($input['audio'] ?? null) : null, $requester, $ip);
            } catch (ListenRefusal $refused) {
                return $this->jsonError($response->withHeader('Cache-Control', 'no-store'), $refused->getMessage(), $refused->status, $refused->reason);
            }
            return ['data' => $heard];
        });
        // A browser that was no visitor of the app's yet is one now, as it would be after a request of the app's own.
        return $setCookie !== null ? $answer->withAddedHeader('Set-Cookie', $setCookie) : $answer;
    }

    /**
     * The app's wallet for whoever is asking (AppWalletService), from FormLogic's own wallet sheet,
     * never the app's frame: GET the sheet; POST `orders` {cents} to start a top-up and
     * `orders/{orderId}` once PayPal approved it, to capture it; POST `email` {purpose: save|restore,
     * email} for a code, and `confirm` {purpose, email, code}; and, where a stand-in answers for
     * PayPal (development only), POST `stand-in/{orderId}` to approve an order as a buyer does in
     * PayPal's own window. Admitted as the app's own requests are:
     * a members' app's member, or a visitor's browser on a request FormLogic's page marked.
     */
    public function wallet(Request $request, Response $response, array $args): Response
    {
        if ($this->wallets === null) return $this->jsonError($response, 'Not found', 404);
        $app = $this->apps->getAppBySlug((string) ($args['slug'] ?? ''));
        $user = $request->getAttribute('userId');
        $owner = $app && $user && $app['ownerId'] === $user;
        if (!$app || !$this->apps->isRuntimeVisible($app, (string) ($user ?? ''))) return $this->jsonError($response, 'App not found or access denied', 404);
        if ($blocked = $this->blockIfDemo($request, $response, 'Payments are unavailable in the shared demo.')) return $blocked;
        if ($this->plugins?->forApp($app) !== null) return $this->jsonError($response, 'Not found', 404);
        $project = $this->native->runtimeProject($app['id'])['project'] ?? null;
        $declared = is_array($project) ? AppFormlogicManifest::payments(AppFormlogicManifest::decode($project['files']['manifest.json'] ?? null)) : null;
        if ($declared === null) return $this->jsonError($response, 'This app takes no payments', 404);
        $setCookie = null;
        if ($project['access'] === 'members') {
            $membership = $user && !$owner ? $this->users->getAppUser($app['id'], (string) $user) : null;
            if (!$owner && (!$user || ($membership['status'] ?? '') !== 'active')) return $this->jsonError($response, 'Sign in with an active app membership to continue', 403);
            $holder = ['kind' => 'user', 'id' => (string) $user];
        } else {
            $visitor = $this->visitors?->resolve($request, (string) $app['id'], $this->visitors->marked($request));
            if ($visitor === null) return $this->jsonError($response, 'Open the app in your browser to use its wallet.', 403, 'visitor_required');
            $holder = ['kind' => 'visitor', 'id' => $visitor['id']];
            $setCookie = $visitor['setCookie'];
        }
        $operation = (string) ($args['operation'] ?? '');
        $body = $request->getParsedBody();
        $body = is_array($body) ? $body : [];
        $ip = \FormLogic\Helpers\IpResolver::fromEnvironment()->getClientIp($request);
        $ipKey = $this->visitors?->ipKey($ip) ?? substr(hash('sha256', $ip), 0, 16);
        $status = 200;
        try {
            if ($request->getMethod() === 'GET') {
                $data = $this->wallets->sheet($app, $declared, $holder);
            } elseif ($operation === 'stand-in' && isset($args['orderId'])) {
                // Development only (a stand-in for PayPal): 404 anywhere else.
                $data = $this->wallets->approveStandIn($app, $holder, (string) $args['orderId']);
            } elseif ($operation === 'orders' && isset($args['orderId'])) {
                $data = $this->wallets->captureTopup($app, $holder, (string) $args['orderId']);
            } elseif ($operation === 'orders') {
                $data = $this->wallets->createTopup($app, $holder, is_int($body['cents'] ?? null) ? $body['cents'] : 0, $ipKey);
            } elseif ($operation === 'email') {
                $this->wallets->sendCode($app, $holder, ($body['purpose'] ?? '') === 'restore' ? 'restore' : 'save', (string) ($body['email'] ?? ''), $ipKey);
                [$data, $status] = [['sent' => true], 202];
            } elseif ($operation === 'confirm') {
                $data = $this->wallets->confirmCode($app, $holder, ($body['purpose'] ?? '') === 'restore' ? 'restore' : 'save', (string) ($body['email'] ?? ''), (string) ($body['code'] ?? ''));
            } else {
                return $this->jsonError($response, 'Not found', 404);
            }
        } catch (WalletRefusal $e) {
            return $this->jsonError($response, $e->getMessage(), $e->status, $e->reason);
        } catch (\Throwable $e) {
            error_log('App wallet ' . $operation . ' failed for app ' . $app['id'] . ': ' . $e->getMessage());
            return $this->jsonError($response, 'Your balance could not be reached. Try again.', 503);
        }
        $answer = $this->jsonResponse($response->withHeader('Cache-Control', 'no-store'), ['data' => $data], $status);
        return $setCookie !== null ? $answer->withAddedHeader('Set-Cookie', $setCookie) : $answer;
    }

    /** The FormLogic sections an app's manifest declares: ['ai' => ?array, 'payments' => ?array], or null for neither. */
    private static function formlogicAsks(array $project): ?array
    {
        $manifest = AppFormlogicManifest::decode($project['files']['manifest.json'] ?? null);
        $ai = AppFormlogicManifest::ai($manifest);
        $payments = AppFormlogicManifest::payments($manifest);
        return $ai === null && $payments === null ? null : ['ai' => $ai, 'payments' => $payments];
    }

    /**
     * One request of an app that asks for FormLogic's visitors, AI or payments: who is asking (the
     * member, or the browser's visitor when FormLogic's page marked the request), their context, and
     * App AI's subscription for its jobs table, and the wallet of an app that takes payments.
     * Answers [identity, subscriptions, Set-Cookie or null, the requester or null].
     * The requester is FormLogic's word alone: nothing in the request's body or headers names one.
     *
     * $owner: the request is from the app's owner, signed in (runtime()'s own answer: the session's
     * account is the app's owner). On an app anyone may open, the backend is told so, `owner: true`,
     * and nothing else of them: no `userId`, and who is asking for AI and whose wallet it is stay the
     * browser's visitor. It is how an owner reaches their own app's settings once it is public. From
     * the sign-in alone, never from anything the page sends; a request that carries the sign-in
     * cookie reaches here only past the CSRF check (CsrfMiddleware, on every POST). Absent otherwise,
     * never false. A members' app says the same with `roleId: "owner"`, as it always has.
     *
     * $address: the address the request came from, where one is known (IpResolver::knownClientIp:
     * the address FormLogic's own limits count, or null). The backend is given a key for it,
     * `addressKey` (AppVisitors::addressKey), so the app's own limits can be per address: a count
     * per visitor alone is no limit, since a new cookie is a new visitor. On every request here,
     * a member's, a visitor's and one nobody marked alike; left out when no address is known, so
     * the app can tell that from an address. From the connection alone, as the server reads it
     * (TRUSTED_PROXIES), never from anything the page sends. FormLogic's own calls to /api/site/
     * do not pass here, and carry none.
     */
    private function formlogicRequest(Request $request, array $app, array $project, array $asks, array $identity, array $subscriptions, string $ip, mixed $user, bool $owner = false, ?string $address = null): array
    {
        $setCookie = null;
        $requester = null;
        if ($project['access'] === 'members') {
            $requester = ['kind' => 'user', 'id' => (string) $user];
        } elseif ($this->visitors !== null) {
            $visitor = $this->visitors->resolve($request, (string) $app['id'], $this->visitors->marked($request));
            if ($visitor !== null) {
                $requester = ['kind' => 'visitor', 'id' => $visitor['id']];
                $setCookie = $visitor['setCookie'];
            }
        }
        $formlogic = is_array($identity['formlogic'] ?? null) ? $identity['formlogic'] : ['appId' => $app['id']];
        if ($requester !== null && $requester['kind'] === 'visitor') $formlogic['visitor'] = ['id' => $requester['id']];
        if ($owner && $project['access'] !== 'members') $formlogic['owner'] = true;
        $addressKey = $address !== null ? $this->visitors?->addressKey((string) $app['id'], $address) : null;
        if ($addressKey !== null) $formlogic['addressKey'] = $addressKey;
        if ($asks['ai'] !== null && $this->ai !== null) {
            $plan = $this->ai->forRequest($app, $asks['ai'], $requester, $ip);
            $formlogic['ai'] = $plan['context'];
            $with = AppAiService::withBinding($subscriptions, $asks['ai']['table'], $plan['binding']);
            if ($with !== null) {
                $subscriptions = $with;
            } else {
                // No room for its subscriptions (the runner takes 100): this request's jobs would not be
                // seen, so the app is told its AI is not available rather than wait for them.
                $formlogic['ai']['enabled'] = false;
                $formlogic['ai']['reason'] = 'subscriptions_full';
            }
        }
        if ($asks['payments'] !== null && $this->wallets !== null) {
            $formlogic['wallet'] = $this->wallets->context($app, $asks['payments'], $requester === null ? null : ['kind' => $requester['kind'], 'id' => $requester['id']]);
        }
        $identity['formlogic'] = $formlogic;
        return [$identity, $subscriptions, $setCookie, $requester === null ? null : ['kind' => $requester['kind'], 'id' => $requester['id']]];
    }

    /**
     * $owner: the caller administers this app. Only then is an installation that needs operator
     * recovery named as such; its message lists the unfinished steps and folders relative to the
     * installation (the service replaces absolute locations; no keys or record values). Visitors
     * and the shared demo keep the generic 503.
     */
    /**
     * What a runtime mount needs: the id to run and the revision it must send back on requests.
     *
     * @param list<string> $languages
     */
    private function engineForRuntime(string $appId, array $languages): array
    {
        $effective = $this->engines->effective($appId, $languages);
        return ['engine' => ['id' => $effective['id'], 'revision' => $effective['revision']]];
    }

    /**
     * 409 engine_changed when the parent's X-FormLogic-Client-Engine no longer matches what the
     * server decides now. The header grants nothing — a request without it is answered as before
     * and asks the resolver nothing. A request WITH it pays for the decision: the resolver's reads
     * (the app and owner row, the policy row, the installed-runtime record) and the project's file
     * names, the same price the GET that mounted the frame paid.
     */
    private function refuseStaleEngine(Request $request, Response $response, string $appId): ?Response
    {
        $header = $request->getMethod() === 'GET' ? '' : $request->getHeaderLine('X-FormLogic-Client-Engine');
        if ($header === '') return null;
        // The SAME decision the GET made, languages included: without them a Python app whose owner
        // stored another engine would be handed zipp-web-python on the GET and then told on every
        // action that the engine had changed, which is a remount loop, not a revocation.
        if (RuntimeEngineService::headerMatches($header, $this->engines->effective($appId, $this->native->clientLanguages($appId)))) return null;
        return $this->jsonError(
            $response->withHeader('Cache-Control', 'no-store'),
            'This app is now set to run on a different engine. Reload to continue.',
            409,
            'engine_changed'
        );
    }

    /**
     * Summary of this app's shared-database relationship: which database it uses, eligible other
     * owned apps whose SQLite DB it can share, all sibling/consumer apps sharing this database,
     * and any FormLogic forms bound to tables in this database.
     *
     * @param array<string, mixed> $app
     * @return array<string, mixed>
     */
    private function describeDatabaseLink(array $app): array
    {
        $ownerId = (string) ($app['ownerId'] ?? '');
        $appId = (string) ($app['id'] ?? '');
        $sharedDbAppId = is_string($app['settings']['sharedDatabaseAppId'] ?? null) && $app['settings']['sharedDatabaseAppId'] !== ''
            ? (string) $app['settings']['sharedDatabaseAppId']
            : $this->native->sharedDatabaseAppId($appId);
        $canonicalDbAppId = $sharedDbAppId ?? $appId;

        $owned = $ownerId !== '' ? $this->apps->getAllApps($ownerId) : [];
        $ownedById = [];
        foreach ($owned as $a) {
            if (($a['ownerId'] ?? null) === $ownerId) $ownedById[(string) $a['id']] = $a;
        }
        $eligibleTargets = [];
        $connectedApps = [];
        foreach ($ownedById as $oid => $other) {
            $otherShared = is_string($other['settings']['sharedDatabaseAppId'] ?? null) && $other['settings']['sharedDatabaseAppId'] !== ''
                ? (string) $other['settings']['sharedDatabaseAppId']
                : null;
            if ($otherShared === $canonicalDbAppId && $oid !== $canonicalDbAppId) {
                $connectedApps[] = [
                    'id' => $oid,
                    'name' => $other['name'],
                    'slug' => $other['slug'],
                    'softnApp' => !empty($other['settings']['softnApp']),
                ];
            }
            if ($oid === $appId || $otherShared !== null) continue;
            $dbGlance = $this->native->databaseGlance($oid);
            if ($dbGlance === null) continue;
            $eligibleTargets[] = [
                'id' => $oid,
                'name' => $other['name'],
                'slug' => $other['slug'],
                'tables' => $dbGlance['tables'],
                'formDatabase' => $dbGlance['formDatabase'],
                'softnApp' => !empty($other['settings']['softnApp']),
            ];
        }
        $linkedForms = [];
        if ($this->forms !== null && $ownerId !== '') {
            foreach ($this->forms->getAllForms($ownerId, ['limit' => 500]) as $f) {
                $binding = is_array($f['settings']['nativeTableBinding'] ?? null) ? $f['settings']['nativeTableBinding'] : null;
                if ($binding !== null && ($binding['appId'] ?? null) === $canonicalDbAppId) {
                    $linkedForms[] = [
                        'id' => $f['id'],
                        'title' => $f['title'],
                        'table' => $binding['table'] ?? '',
                        'status' => $f['status'] ?? 'draft',
                    ];
                }
            }
        }
        $dbOwner = $ownedById[$canonicalDbAppId] ?? null;
        return [
            'appId' => $appId,
            'sharedDatabaseAppId' => $sharedDbAppId,
            'databaseAppId' => $canonicalDbAppId,
            'databaseOwner' => $dbOwner ? ['id' => $dbOwner['id'], 'name' => $dbOwner['name'], 'slug' => $dbOwner['slug']] : null,
            'eligibleTargets' => $eligibleTargets,
            'connectedApps' => $connectedApps,
            'linkedForms' => $linkedForms,
        ];
    }

    /**
     * The headers an app's own request carries to its backend, by name in lower case: what the
     * app's page set on its call, which reaches this site as part of the call's body. They are
     * never this site's own request headers (its session and the rest stay here). The rule is
     * AppRequestHeaders', which the app's API applies too (ExternalAppApiController).
     *
     * @param array<array-key, mixed> $sent
     * @return array<string, string>
     */
    private static function appRequestHeaders(array $sent, bool $cookies = true): array
    {
        return \FormLogic\Helpers\AppRequestHeaders::fromApp($sent, $cookies);
    }

    /** $operation answers with an array to encode, or with a finished Response (a typed refusal). */
    private function respond(Response $response, callable $operation, bool $owner = false): Response
    {
        $response = $response->withHeader('Cache-Control', 'no-store')->withHeader('X-Content-Type-Options', 'nosniff');
        try {
            $result = $operation();
            return $result instanceof Response ? $result : $this->jsonResponse($response, $result);
        }
        catch (\InvalidArgumentException|\JsonException $e) { return $this->jsonError($response, $e->getMessage(), 400); }
        catch (\RuntimeException $e) {
            // Every worker stayed busy while the request waited for one (NativeAppService's slots):
            // told how long to wait, as the limiter's own 429 is, so the app's page need not guess.
            if ($e->getCode() === 429) {
                return $this->jsonResponse($response->withHeader('Retry-After', (string) self::BUSY_RETRY_SECONDS), ['error' => true, 'message' => $e->getMessage(), 'retryAfter' => self::BUSY_RETRY_SECONDS], 429);
            }
            if (in_array($e->getCode(), [402,403,404,409,413,422,501], true)) return $this->jsonError($response, $e->getMessage(), $e->getCode());
            error_log('Native app error: ' . $e->getMessage());
            if ($owner && $e->getCode() === 0 && preg_match(self::RECOVERY_REQUIRED, $e->getMessage())) return $this->jsonError($response, $e->getMessage(), 503, 'recovery_required');
            return $this->jsonError($response, 'The native app host is unavailable. Check its runtime configuration.', 503);
        }
    }
}
