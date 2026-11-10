<?php

declare(strict_types=1);
namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\{AccessGateService, AppAiService, AppFormlogicManifest, AppService, AppUserService, AppVisitors, AppWalletService, NativeAppCharges, NativeAppService, NativePhoneVerification, NativeRecordEventRouter, PlanService, PluginService, FlowService, RuntimeEngineService, AppLookService, WalletRefusal};
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

    // $engines is required, not optional-with-a-default: this controller is autowired, and PHP-DI's
    // reflection autowiring SKIPS optional parameters (ReflectionBasedAutowiring), so an `= null`
    // here would silently hand production a controller that decides no app's engine.
    public function __construct(private AppService $apps, private AppUserService $users, private NativeAppService $native, private PlanService $plans, private FlowService $flows, private RuntimeEngineService $engines, private ?PluginService $plugins = null, private ?AccessGateService $gate = null, private ?AppLookService $look = null, private ?NativePhoneVerification $verification = null, private ?NativeRecordEventRouter $records = null, private ?AppVisitors $visitors = null, private ?AppAiService $ai = null, private ?AppWalletService $wallets = null, private ?NativeAppCharges $charges = null)
    {
        // Every dispatch goes through the one router, so App AI's jobs are never acknowledged unread.
        $this->records ??= new NativeRecordEventRouter($this->flows, $this->ai);
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
        return $this->respond($response, function () use ($request, $app, $args, $readOnly) {
            // Phone sign-in codes through the owner's Twilio Verify (NativePhoneVerification): the
            // two ids are shown back, the token never is.
            if (($args['operation'] ?? '') === 'verification') {
                if ($this->verification === null) throw new \RuntimeException('Phone verification is not available on this server', 503);
                if ($request->getMethod() === 'GET') return $this->verification->describe($app['id']);
                if ($request->getMethod() === 'DELETE') return $this->verification->clear($app['id']);
                $input = $request->getParsedBody();
                if (!is_array($input)) throw new \InvalidArgumentException('Provide the Twilio details');
                return $this->verification->save($app['id'], $input['accountSid'] ?? null, $input['serviceSid'] ?? null, $input['authToken'] ?? null);
            }
            // The app's data from where it ran before: its database, and optionally the earlier
            // host's private configuration for the key it was kept under (and its Twilio details,
            // when the owner says to use them).
            if (($args['operation'] ?? '') === 'import') {
                $uploads = $request->getUploadedFiles();
                $database = $uploads['database'] ?? null;
                if (!$database instanceof \Psr\Http\Message\UploadedFileInterface || $database->getError() !== UPLOAD_ERR_OK) throw new \InvalidArgumentException('Choose the app\'s database file (application.sqlite).');
                $config = $uploads['config'] ?? null;
                $imported = ['key' => null, 'verification' => null];
                if ($config instanceof \Psr\Http\Message\UploadedFileInterface && $config->getError() === UPLOAD_ERR_OK) {
                    if ($config->getSize() !== null && $config->getSize() > 65536) throw new \InvalidArgumentException('That key file is too large to be a host configuration.');
                    $imported = NativeAppService::importedKey((string) $config->getStream());
                }
                $useVerification = (($request->getParsedBody() ?? [])['useVerification'] ?? '') === '1' && $imported['verification'] !== null && $this->verification !== null;
                // Twilio details this site would not keep are said before anything changes, and
                // never take the data with them: the data is the import, the details a setting.
                $verificationProblem = null;
                if ($useVerification) {
                    try { NativePhoneVerification::assertDetails($imported['verification']['accountSid'], $imported['verification']['serviceSid'], $imported['verification']['authToken']); }
                    catch (\InvalidArgumentException $e) { $verificationProblem = 'Its Twilio details were not used: ' . $e->getMessage(); $useVerification = false; }
                }
                $path = $this->native->importDropPath($app['id']);
                try {
                    $database->moveTo($path);
                    $installed = $this->native->importData($app['id'], $path, $imported['key']);
                } finally {
                    // With what SQLite made beside a WAL-mode upload as it was read.
                    foreach (['', '-wal', '-shm', '-journal'] as $suffix) if (is_file($path . $suffix)) @unlink($path . $suffix);
                }
                $verification = null;
                if ($useVerification) {
                    try { $verification = $this->verification->save($app['id'], $imported['verification']['accountSid'], $imported['verification']['serviceSid'], $imported['verification']['authToken']); }
                    catch (\Throwable $e) { error_log('Native import: Twilio details not kept for app ' . $app['id'] . ': ' . get_class($e)); $verificationProblem = 'Its Twilio details could not be kept: enter them in Settings → Phone sign-in codes.'; }
                }
                return ['project' => $installed, 'keyImported' => $imported['key'] !== null, 'verificationFound' => $imported['verification'] !== null, 'verification' => $verification, 'verificationProblem' => $verificationProblem];
            }
            // A new SoftN app's first version: the starter project, named after the app. Only
            // for an app with nothing installed (install() refuses expectedVersion 0 otherwise).
            if (($args['operation'] ?? '') === 'starter') {
                // A forms app hosts a project from App Studio; the starter would take over its address.
                if (empty($app['settings']['softnApp'])) throw new \InvalidArgumentException('The starter is only for a SoftN app. Add a project to this app from its App Studio instead.');
                $installed = $this->native->install($app['id'], NativeAppService::starterProject((string) $app['name'], (string) $app['id']), 0);
                return ['project' => $installed] + $this->engineAfterInstall($app['id'], RuntimeEngineService::languagesOf(NativeAppService::clientFiles($installed)));
            }
            if (($args['operation'] ?? '') === 'records') {
                if ($request->getMethod() === 'POST') {
                    $input = $request->getParsedBody();
                    if (!is_array($input)) throw new \InvalidArgumentException('Provide a record action');
                    if (($input['action'] ?? '') !== 'read' && $this->plans->isEnforced() && !$this->plans->isCloudActive($app['ownerId'])) throw new \RuntimeException('Cloud access has expired. Records remain available to read.', 402);
                    $result = $this->native->manageRecord($app['id'], $input, $this->flows->nativeRecordSubscriptions($app['id']));
                    if (($input['action'] ?? '') !== 'read') {
                        try { $this->native->dispatchRecordEvents($app['id'], $this->records->for($app['id'])); }
                        catch (\Throwable $error) { error_log('Native record automation delivery pending for app ' . $app['id']); }
                    }
                    return $result;
                }
                $query = $request->getQueryParams();
                $notInstalled = ['installed' => false, 'tables' => [], 'readOnly' => $readOnly];
                if (!$this->native->get($app['id']) && !isset($query['table'])) return $notInstalled;
                try {
                    return $this->native->records($app['id'], isset($query['table']) && is_string($query['table']) ? $query['table'] : null, (int) ($query['offset'] ?? 0)) + ['readOnly' => $readOnly];
                } catch (\RuntimeException $missing) {
                    // The unlocked get() saw the project.json of a first install a terminated process
                    // left unfinished; records() settled it under the lock, which removed it.
                    if ($missing->getCode() === 404 && !isset($query['table']) && !$this->native->get($app['id'])) return $notInstalled;
                    throw $missing;
                }
            }
            if ($request->getMethod() === 'GET') {
                // available = artifacts prepared; preflight = the runtime actually starts here
                // (audit FL-03). Owner-only endpoint; preflight messages carry no paths or secrets.
                // The demo is public traffic that cannot install anything: it never forks the preflight.
                $preflight = !$readOnly && $this->native->available() ? $this->native->preflight() : null;
                // Read under the management lock, so an update left unfinished is settled before it is shown.
                // The engine block is the owner's settings view: choice, outcome, reason, and what
                // this site allows them to choose between.
                $project = $this->native->project($app['id']);
                // Derived from the same client files a member's frame receives, so the owner is
                // shown the engine (and the reason) their members actually get.
                $languages = RuntimeEngineService::languagesOf(NativeAppService::clientFiles($project ?? []));
                return ['available' => $this->native->available(), 'ready' => $preflight !== null && $preflight['ok'], 'preflight' => $preflight, 'project' => $project, 'readOnly' => $readOnly,
                    'engine' => $this->engines->effective($app['id'], $languages), 'enginePolicy' => $this->engines->ownerPolicy()];
            }
            $body = $request->getParsedBody();
            if (!is_array($body) || !is_array($body['project'] ?? null) || !is_int($body['expectedVersion'] ?? null) || $body['expectedVersion'] < 0) throw new \InvalidArgumentException('Provide a project and expectedVersion');
            // The engine block again, from the project JUST installed: a `.py` added or removed
            // changes the server's decision, and the owner's panel shows this answer.
            // A version that uses torch where it is off is refused before it is installed, and says why.
            $torch = $this->engines->torchRefusal($app, NativeAppService::clientFiles($body['project']));
            if ($torch !== null) throw new \InvalidArgumentException($torch);
            $installed = $this->native->install($app['id'], $body['project'], $body['expectedVersion']);
            return ['project' => $installed] + $this->engineAfterInstall($app['id'], RuntimeEngineService::languagesOf(NativeAppService::clientFiles($installed)));
        }, !$readOnly);
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
            return ['home' => (bool) ($project['home'] ?? false), 'access' => $project['access'] ?? 'members', 'native' => $project !== null];
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
        // A visitor's cookie, set (or its age renewed) for an app that asks for visitors (AppVisitors).
        $setCookie = null;
        $answer = $this->respond($response, function () use ($request, $response, $app, $user, $owner, $plugin, $mediaRoute, $packed, &$setCookie) {
            // Access is decided against the settled project (FL-S04), never an update's leftover project.json.
            // Read without its media where nothing here sends them: a game's are tens of megabytes. An
            // app's API call needs only its version and access, and decoded every picture and sound
            // for them on each call, a game with no backend to call included.
            $light = $packed || $request->getMethod() !== 'GET';
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
            $identity = $project['access'] === 'members' ? ['formlogic' => ['appId' => $app['id'], 'userId' => $user, 'roleId' => $owner ? 'owner' : ($membership['roleId'] ?? null)]] : [];
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
                // An app that asks for FormLogic's visitors, AI or payments: the page marks its
                // requests (X-FormLogic-Visitor) and may open FormLogic's wallet. Its visitors'
                // browsers get their cookie here, or have its age renewed, once a page load.
                $formlogic = [];
                if ($asks !== null) {
                    $formlogic = ['formlogic' => ['visitors' => $project['access'] === 'application', 'ai' => $asks['ai'] !== null, 'payments' => $asks['payments'] !== null]];
                    if ($project['access'] === 'application' && $this->visitors !== null) $setCookie = $this->visitors->cookieFor($request);
                }
                return ['name' => $app['name'], 'project' => ['version' => $project['version'], 'client' => $client] + $served + ['access' => $project['access'], 'origins' => $origins, 'storageScope' => $storageScope] + $files + $formlogic]
                    + $this->lookForRuntime($app, $plugin) + $this->engineForRuntime($app['id'], $languages);
            }
            $input = $request->getParsedBody();
            if (!is_array($input) || !is_string($input['path'] ?? null) || !preg_match('~^/api/[a-zA-Z0-9/_-]+$~D', $input['path']) || !in_array($input['method'] ?? null, ['GET','POST','PUT','DELETE'], true)) throw new \InvalidArgumentException('Provide an app API path and method');
            // /api/site/ routes are the site's own to call (App AI's deliveries, a plugin's camera
            // check: CameraCheckService), never a page's, for every app.
            if (str_starts_with(strtolower($input['path']), PluginService::SITE_ROUTE_PREFIX)) throw new \RuntimeException('Not found', 404);
            // A plugin is the site's own, on no one's plan.
            if ($plugin === null && in_array($input['method'], ['POST', 'PUT'], true) && $this->plans->isEnforced() && !$this->plans->isCloudActive($app['ownerId'])) throw new \RuntimeException('The app owner’s cloud access has expired. Records remain available to read and export.', 402);
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
            $nativeRequest = [
                'method' => $input['method'], 'path' => $input['path'], 'query' => (object) ($input['query'] ?? []), 'body' => $body,
                // Both always present, empty when not sent, as SoftN's PHP host gives them.
                'headers' => (object) ['authorization' => $authorization, 'idempotency-key' => $idempotency],
                'client_ip' => \FormLogic\Helpers\IpResolver::fromEnvironment()->getClientIp($request), 'photos' => false,
            ];
            $subscriptions = $this->flows->nativeRecordSubscriptions($app['id']);
            $requester = null;
            if ($asks !== null) [$identity, $subscriptions, $setCookie, $requester] = $this->formlogicRequest($request, $app, $project, $asks, $identity, $subscriptions, (string) $nativeRequest['client_ip'], $user);
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
            try {
                $this->native->dispatchRecordEvents($app['id'], $this->records->for($app['id']));
            } catch (\Throwable $error) {
                // The app write already committed. Returning an error here could make the
                // caller repeat it; retain the durable event for the recovery dispatcher.
                error_log('Native record automation delivery pending for app ' . $app['id']);
            }
            return ['result' => $result];
        });
        return $setCookie !== null ? $answer->withAddedHeader('Set-Cookie', $setCookie) : $answer;
    }

    /**
     * The app's wallet for whoever is asking (AppWalletService), from FormLogic's own wallet sheet,
     * never the app's frame: GET the sheet; POST `orders` {cents} to start a top-up and
     * `orders/{orderId}` once PayPal approved it, to capture it; POST `email` {purpose: save|restore,
     * email} for a code, and `confirm` {purpose, email, code}. Admitted as the app's own requests are:
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
     */
    private function formlogicRequest(Request $request, array $app, array $project, array $asks, array $identity, array $subscriptions, string $ip, mixed $user): array
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
