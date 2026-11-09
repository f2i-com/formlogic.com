<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * App AI: a SoftN app's server asks FormLogic's AI for pictures, edits and chat replies
 * (docs/HOSTED_APPS.md, "App AI, visitors and payments").
 *
 * - **Asking.** The app's server inserts a row into the jobs table its manifest declares
 *   (AppFormlogicManifest). FormLogic gives that one request a record-event subscription whose
 *   binding id names the requester and their address (`fl-ai-u-<user>-<ip>`, `fl-ai-v-<visitor>-<ip>`),
 *   so the insert is captured in the write's own transaction: a write that rolls back asks nothing.
 * - **Capture.** Every dispatcher hands such an event here (NativeRecordEventRouter) before it is
 *   acknowledged. The whole row is read from the app's database, checked, counted against the
 *   limits and kept as an app_ai_jobs row, once per event.
 * - **Context.** Every request of an app that declares AI is told where its AI comes from, how much
 *   of the day's allowance the requester and their address have used, and where their open jobs
 *   stand (`req.context.formlogic.ai`).
 *
 * The worker (AppAiWorker) sends queued jobs to the site's or the owner's OAIY, or the .env upstream,
 * and delivers the results to the app's own /api/site/ route.
 */
class AppAiService
{
    public const BINDING_PREFIX = 'fl-ai-';
    public const SIZES = ['512x512', '768x768', '1024x1024', '1024x768', '768x1024'];
    public const MAX_PROMPT = 4000;
    public const MAX_MESSAGES = 24;
    public const MAX_CHAT_CHARACTERS = 16000;
    /** A reference picture for an edit, as the app sends it: a data URL of at most 2 MB. */
    public const MAX_REFERENCE_BYTES = 2 * 1024 * 1024;
    /** Jobs waiting per app, and waiting or running per requester. */
    public const MAX_QUEUED_PER_APP = 20;
    public const MAX_OPEN_PER_REQUESTER = 2;
    /** Statuses a job holds the AI in (or waits for it). */
    public const OPEN = ['queued', 'sending', 'running'];
    /** The largest seed a picture may ask for: 2^53 - 1. */
    public const MAX_SEED = 9007199254740991;

    /** @var \Closure(): int */
    private \Closure $now;
    /** The real clock (not a test's): a job's creation is then stamped to the millisecond. */
    private bool $realClock;

    public function __construct(
        private MySQLConnection $mysql,
        private AppAiSiteSettings $site,
        private AppVisitors $visitors,
        private NativeAppService $native,
        private ?SiteAiDesktopSettings $siteDesktop = null,
        private ?AIService $ai = null,
        private ?PlanService $plans = null,
        ?\Closure $now = null,
    ) {
        $this->realClock = $now === null;
        $this->now = $now ?? static fn(): int => time();
    }

    /**
     * App AI as a command-line script needs it (bin/native-record-dispatch.php, bin/app-ai-worker.php),
     * wired as the web container wires it. PlanService is left out: the site builds it with plans
     * never enforced (public/index.php), so the answer is the same.
     */
    public static function standalone(MySQLConnection $mysql, ?NativeAppService $native = null): self
    {
        $computers = new SiteAiDesktopSettings($mysql);
        $ai = new AIService();
        $ai->useSiteDesktop(new SiteDesktopAi(new DesktopAiRelayService($mysql), $computers));
        return new self($mysql, new AppAiSiteSettings(), new AppVisitors($mysql), $native ?? new NativeAppService(), $computers, $ai);
    }

    // ------------------------------------------------------------------ the app's settings

    /** The app's AI settings (app_ai_settings), or the site's defaults when the owner has set none. */
    public function settings(string $appId): array
    {
        $statement = $this->pdo()->prepare('SELECT * FROM app_ai_settings WHERE app_id = ?');
        $statement->execute([$appId]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        return is_array($row) ? self::shape($row) : $this->defaultSettings($appId);
    }

    private function defaultSettings(string $appId): array
    {
        $defaults = $this->site->current()['defaults'];
        return self::shape([
            'app_id' => $appId, 'mode' => 'off', 'per_requester_day' => $defaults['perRequesterDay'], 'per_ip_day' => $defaults['perIpDay'],
            'per_ip_hour' => $defaults['perIpHour'], 'per_app_day' => $defaults['perAppDay'],
        ]);
    }

    private static function shape(array $row): array
    {
        return [
            'appId' => (string) $row['app_id'],
            'mode' => in_array($row['mode'] ?? 'off', ['off', 'site', 'own'], true) ? (string) $row['mode'] : 'off',
            'own' => ($row['own_connection_id'] ?? null) === null ? null : [
                'connectionId' => (string) $row['own_connection_id'], 'instanceId' => (string) ($row['own_instance_id'] ?? ''),
                'publicKey' => (string) ($row['own_public_key'] ?? ''), 'providerId' => (string) ($row['own_provider_id'] ?? SiteDesktopAi::PROVIDER),
                'pictureModel' => $row['own_picture_model'] ?? null, 'chatModel' => $row['own_chat_model'] ?? null, 'deviceName' => (string) ($row['own_device_name'] ?? ''),
            ],
            'perRequesterDay' => (int) $row['per_requester_day'],
            'perIpDay' => (int) $row['per_ip_day'],
            'perIpHour' => (int) $row['per_ip_hour'],
            'perAppDay' => (int) $row['per_app_day'],
            'blocked' => (bool) ($row['blocked_by_admin'] ?? false),
            'blockedReason' => $row['blocked_reason'] ?? null,
            'pausedUntil' => $row['paused_until'] ?? null,
        ];
    }

    // ------------------------------------------------------------------ availability

    /**
     * Where the app's AI comes from now, and which kinds of job it can take:
     * {enabled, source: site|own|off, target, label, kinds: list<string>, reason: ?string}.
     * `target` is the queue it feeds: an OAIY computer's connection id, or `env` for the .env upstream.
     */
    public function availability(array $app, array $declared, ?array $settings = null): array
    {
        $settings ??= $this->settings((string) $app['id']);
        $off = static fn(string $reason, string $source = 'off') => ['enabled' => false, 'source' => $source, 'target' => null, 'label' => '', 'kinds' => [], 'reason' => $reason];
        if ($settings['mode'] === 'off') return $off('ai_off');
        $site = $this->site->current();
        if ($site['paused']) return $off('ai_paused', $settings['mode']);
        if ($settings['blocked']) return $off('ai_blocked', $settings['mode']);
        if ($settings['pausedUntil'] !== null && strtotime((string) $settings['pausedUntil'] . ' UTC') > ($this->now)()) return $off('ai_resting', $settings['mode']);
        if ($this->plans !== null && $this->plans->isEnforced() && !$this->plans->isCloudActive((string) $app['ownerId'])) return $off('plan_inactive', $settings['mode']);
        // Pictures need a model chosen for them, and this server able to redraw what comes back.
        $pictures = AppAiPictures::available();
        $unset = $pictures ? 'model_unset' : 'no_pictures';
        if ($settings['mode'] === 'own') {
            $own = $settings['own'];
            if ($own === null) return $off('own_unset', 'own');
            // The computer as the owner chose it: still theirs, and still the key it was pinned to.
            if (!$this->ownStillPinned((string) $app['ownerId'], $own)) return $off('own_changed', 'own');
            $kinds = array_values(array_filter($declared['kinds'], static fn(string $kind) => $kind === 'chat' || ($pictures && ($own['pictureModel'] ?? null) !== null)));
            return ['enabled' => $kinds !== [], 'source' => 'own', 'target' => $own['connectionId'], 'label' => $own['deviceName'] !== '' ? 'OAIY on ' . $own['deviceName'] : 'The owner\'s OAIY', 'kinds' => $kinds, 'reason' => $kinds === [] ? $unset : null];
        }
        if (!$site['allowApps']) return $off('site_ai_closed', 'site');
        $computer = $this->siteDesktop?->current();
        if ($computer !== null) {
            $target = (string) $computer['connectionId'];
        } elseif ($this->ai !== null && $this->ai->isConfigured()) {
            $target = 'env';
        } else {
            return $off('site_ai_unavailable', 'site');
        }
        $kinds = array_values(array_filter($declared['kinds'], static fn(string $kind) => $kind === 'chat' || ($pictures && $site['pictureModel'] !== null)));
        return ['enabled' => $kinds !== [], 'source' => 'site', 'target' => $target, 'label' => 'This site\'s AI', 'kinds' => $kinds, 'reason' => $kinds === [] ? $unset : null];
    }

    // ------------------------------------------------------------------ a request

    /**
     * What one request of an app that declares AI gets: its `ai` context and, when the requester may
     * ask, the binding id its subscription carries. $requester is ['kind' => user|visitor, 'id' => …],
     * or null when nobody is known (an application-access request without FormLogic's visitor marker).
     *
     * @return array{context: array, binding: ?string}
     */
    public function forRequest(array $app, array $declared, ?array $requester, string $ip): array
    {
        $settings = $this->settings((string) $app['id']);
        $available = $this->availability($app, $declared, $settings);
        $ipKey = $this->visitors->ipKey($ip);
        $day = $this->day();
        $context = [
            'enabled' => $available['enabled'] && $requester !== null,
            'source' => $available['source'],
            'label' => $available['label'],
            'uses' => array_values(array_filter($declared['uses'], static fn(string $use) => in_array(AppFormlogicManifest::AI_USES[$use], $available['kinds'], true))),
            'perDay' => $settings['perRequesterDay'],
            'usedToday' => $requester === null ? 0 : $this->used((string) $app['id'], 'requester', self::subject($requester), $day),
            'ipPerDay' => $settings['perIpDay'],
            'ipUsedToday' => $this->used((string) $app['id'], 'ip', $ipKey, $day),
            'jobs' => $requester === null ? (object) [] : $this->openJobs((string) $app['id'], $requester),
        ];
        if (!$context['enabled'] && $requester === null && $available['enabled']) $context['reason'] = 'visitor_required';
        elseif (!$available['enabled']) $context['reason'] = $available['reason'];
        $binding = $context['enabled'] ? self::binding($requester, $ipKey) : null;
        return ['context' => $context, 'binding' => $binding];
    }

    /** The binding id a requester's subscription carries: who asked, and from where. */
    public static function binding(array $requester, string $ipKey): string
    {
        return self::BINDING_PREFIX . ($requester['kind'] === 'user' ? 'u' : 'v') . '-' . $requester['id'] . '-' . $ipKey;
    }

    /** A binding id read back: ['kind' => user|visitor, 'id' => …, 'ipKey' => …], or null when it is not App AI's. */
    public static function parseBinding(mixed $binding): ?array
    {
        if (!is_string($binding) || strlen($binding) > 100) return null;
        if (preg_match('/^fl-ai-u-([A-Za-z0-9-]{1,64})-([0-9a-f]{16})$/D', $binding, $m)) return ['kind' => 'user', 'id' => $m[1], 'ipKey' => $m[2]];
        if (preg_match('/^fl-ai-v-([0-9a-f]{32})-([0-9a-f]{16})$/D', $binding, $m)) return ['kind' => 'visitor', 'id' => $m[1], 'ipKey' => $m[2]];
        return null;
    }

    /**
     * The request's subscriptions with App AI's binding added for `app.record.created.<table>`: to a
     * flow's entry for the same event when there is one (a second entry would capture the insert
     * twice), or as a new entry. Null when the runner's limits (100 entries, 100 bindings an entry)
     * leave no room: the request then runs without it and its jobs are not taken.
     */
    public static function withBinding(array $subscriptions, string $table, string $binding): ?array
    {
        $event = 'app.record.created.' . $table;
        foreach ($subscriptions as $index => $subscription) {
            if (($subscription['event'] ?? null) !== $event) continue;
            $bindings = is_array($subscription['bindings'] ?? null) ? $subscription['bindings'] : [];
            if (count($bindings) >= 100) return null;
            $bindings[] = $binding;
            $subscriptions[$index]['bindings'] = $bindings;
            return $subscriptions;
        }
        if (count($subscriptions) >= 100) return null;
        $subscriptions[] = ['event' => $event, 'bindings' => [$binding]];
        return $subscriptions;
    }

    /** A requester's waiting and running jobs: app job id → {status: queued|running, position?}. */
    private function openJobs(string $appId, array $requester): array|object
    {
        $statement = $this->pdo()->prepare("SELECT app_job_id, status, target, created_at FROM app_ai_jobs WHERE app_id = ? AND requester_kind = ? AND requester_id = ? AND status IN ('queued','sending','running') ORDER BY created_at LIMIT 10");
        $statement->execute([$appId, $requester['kind'], $requester['id']]);
        $jobs = [];
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
            if ($row['status'] !== 'queued') { $jobs[(string) $row['app_job_id']] = ['status' => 'running']; continue; }
            $ahead = $this->pdo()->prepare("SELECT COUNT(*) FROM app_ai_jobs WHERE target <=> ? AND status IN ('queued','sending','running') AND created_at < ?");
            $ahead->execute([$row['target'], $row['created_at']]);
            $jobs[(string) $row['app_job_id']] = ['status' => 'queued', 'position' => (int) $ahead->fetchColumn() + 1];
        }
        return $jobs === [] ? (object) [] : $jobs;
    }

    // ------------------------------------------------------------------ capture

    /**
     * Take the jobs one committed record event asks for. $bindings are the event's App AI bindings;
     * $readRow(table, column, value) reads a whole row from the app's database. Answers the number of
     * jobs taken (queued or refused), 0 when the event is not a job (already taken, or not the jobs
     * table). Throws only when MySQL cannot record it: the event is then left for the next dispatch.
     */
    public function capture(string $appId, string $eventId, string $event, array $data, array $bindings, ?callable $readRow): int
    {
        if (!preg_match('/^[a-f0-9]{32}$/D', $eventId)) return 0;
        $requester = null;
        foreach ($bindings as $binding) {
            if (($requester = self::parseBinding($binding)) !== null) break;
        }
        if ($requester === null) return 0;
        $app = $this->app($appId);
        $declared = $app === null ? null : AppFormlogicManifest::ai($this->native->installedManifest($appId));
        if ($app === null || $declared === null || $event !== 'app.record.created.' . $declared['table']) return 0;

        $key = $data['record']['id'] ?? null;
        $row = null;
        if ((is_string($key) || is_int($key)) && $readRow !== null) {
            try { $row = $readRow($declared['table'], 'id', $key); } catch (\Throwable) { $row = null; }
        }
        [$job, $refusal] = $this->jobFrom(is_array($row) ? $row : null, $key, $declared);

        $pdo = $this->pdo();
        $now = ($this->now)();
        $day = gmdate('Y-m-d', $now);
        $hour = gmdate('Y-m-d\TH', $now);
        $site = $this->site->current();
        $pdo->beginTransaction();
        try {
            // One capture at a time per app: its limits and queue are counted under this lock.
            $pdo->prepare('INSERT IGNORE INTO app_ai_settings (app_id, per_requester_day, per_ip_day, per_ip_hour, per_app_day) VALUES (?, ?, ?, ?, ?)')
                ->execute([$appId, $site['defaults']['perRequesterDay'], $site['defaults']['perIpDay'], $site['defaults']['perIpHour'], $site['defaults']['perAppDay']]);
            $lock = $pdo->prepare('SELECT * FROM app_ai_settings WHERE app_id = ? FOR UPDATE');
            $lock->execute([$appId]);
            $settingsRow = $lock->fetch(PDO::FETCH_ASSOC);
            $seen = $pdo->prepare('SELECT 1 FROM app_ai_jobs WHERE app_id = ? AND event_id = ?');
            $seen->execute([$appId, $eventId]);
            if ($seen->fetchColumn() !== false) { $pdo->commit(); return 0; }
            $settings = is_array($settingsRow) ? self::shape($settingsRow) : $this->defaultSettings($appId);
            $available = $this->availability($app, $declared, $settings);
            if ($refusal === null) $refusal = $this->admission($appId, $requester, $settings, $available, $site, (string) ($job['kind'] ?? ''), $day, $hour);
            $id = bin2hex(random_bytes(16));
            $status = $refusal === null ? 'queued' : 'refused';
            $pdo->prepare(
                'INSERT INTO app_ai_jobs (id, app_id, event_id, app_job_id, requester_kind, requester_id, ip_key, kind, status, source, target, prompt, prompt_sha256, size, seed, reference, code, message, counted_day, counted_hour, next_attempt_at, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            )->execute([
                $id, $appId, $eventId, mb_substr((string) ($job['appJobId'] ?? (is_scalar($key) ? (string) $key : '')), 0, 100), $requester['kind'], $requester['id'], $requester['ipKey'],
                (string) ($job['kind'] ?? 'unknown'), $status, $status === 'queued' ? $available['source'] . '-' . ($available['target'] === 'env' ? 'env' : 'oaiy') : null,
                $status === 'queued' ? $available['target'] : null,
                $job['prompt'] ?? null, isset($job['prompt']) ? hash('sha256', (string) $job['prompt']) : null,
                $job['size'] ?? null, $job['seed'] ?? null, $job['reference'] ?? null,
                $refusal['code'] ?? null, $refusal['message'] ?? null, $day, $hour,
                // A refused job is told to the app as soon as the worker next looks.
                // Created to the millisecond: queue positions and fair turns follow this order.
                $status === 'refused' ? gmdate('Y-m-d H:i:s', $now) : null, self::stamp($this->realClock ? microtime(true) : $now),
            ]);
            if ($status === 'queued') {
                foreach ($this->counters($appId, $requester, $day, $hour, $available['source'] === 'site') as [$counterApp, $scope, $subject, $period]) {
                    $pdo->prepare('INSERT INTO app_ai_counters (app_id, scope, subject, period, used) VALUES (?, ?, ?, ?, 1) ON DUPLICATE KEY UPDATE used = used + 1')
                        ->execute([$counterApp, $scope, $subject, $period]);
                }
            }
            $pdo->commit();
            return 1;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }

    /**
     * Why this job may not be queued now, or null. Called inside capture's transaction, with the
     * app's settings row locked: counts and queues read here cannot change under it.
     */
    private function admission(string $appId, array $requester, array $settings, array $available, array $site, string $kind, string $day, string $hour): ?array
    {
        if (!$available['enabled'] || !in_array($kind, $available['kinds'], true)) {
            $reason = $available['enabled'] ? 'not_offered' : (string) $available['reason'];
            return ['code' => 'ai_unavailable', 'message' => self::REASONS[$reason] ?? self::REASONS['ai_off']];
        }
        $pdo = $this->pdo();
        $queued = $pdo->prepare("SELECT COUNT(*) FROM app_ai_jobs WHERE app_id = ? AND status = 'queued'");
        $queued->execute([$appId]);
        if ((int) $queued->fetchColumn() >= self::MAX_QUEUED_PER_APP) return ['code' => 'busy', 'message' => 'The AI has too many requests waiting. Try again in a few minutes.'];
        $open = $pdo->prepare("SELECT COUNT(*) FROM app_ai_jobs WHERE app_id = ? AND requester_kind = ? AND requester_id = ? AND status IN ('queued','sending','running')");
        $open->execute([$appId, $requester['kind'], $requester['id']]);
        if ((int) $open->fetchColumn() >= self::MAX_OPEN_PER_REQUESTER) return ['code' => 'busy', 'message' => 'Wait for your current requests to finish first.'];
        $limits = [
            ['requester', self::subject($requester), $day, $settings['perRequesterDay'], 'You have used today\'s AI allowance. It starts again tomorrow (UTC).'],
            ['ip', $requester['ipKey'], $day, $settings['perIpDay'], 'Today\'s free AI requests from this network are used up. They start again tomorrow (UTC).'],
            ['ip-hour', $requester['ipKey'], $hour, $settings['perIpHour'], 'Too many AI requests from this network this hour. Try again later.'],
            ['app', '', $day, $settings['perAppDay'], 'This app has used its AI for today. Try again tomorrow (UTC).'],
        ];
        foreach ($limits as [$scope, $subject, $period, $limit, $message]) {
            if ($this->used($appId, $scope, $subject, $period) >= $limit) return ['code' => 'limit_reached', 'message' => $message];
        }
        // The whole site's day, counted across apps: its row is locked too, so two apps' captures
        // at once cannot both take its last job.
        $pdo->prepare("INSERT IGNORE INTO app_ai_counters (app_id, scope, subject, period, used) VALUES ('', 'site', '', ?, 0)")->execute([$day]);
        $siteRow = $pdo->prepare("SELECT used FROM app_ai_counters WHERE app_id = '' AND scope = 'site' AND subject = '' AND period = ? FOR UPDATE");
        $siteRow->execute([$day]);
        if ((int) $siteRow->fetchColumn() >= (int) $site['siteDay'] && $available['source'] === 'site') return ['code' => 'limit_reached', 'message' => 'The site\'s AI has done all it can for apps today. Try again tomorrow (UTC).'];
        return null;
    }

    /**
     * The counters a queued job adds one to: [app id, scope, subject, period] each. An owner's test
     * counts in the app's day, and against nobody's own allowance. Only a job for the site's AI
     * ($siteAi) counts in the site's day: an owner's own OAIY spends none of it.
     */
    private function counters(string $appId, array $requester, string $day, string $hour, bool $siteAi): array
    {
        $site = $siteAi ? [['', 'site', '', $day]] : [];
        if ($requester['kind'] === self::TEST_REQUESTER) return [[$appId, 'app', '', $day], ...$site];
        return [
            [$appId, 'requester', self::subject($requester), $day],
            [$appId, 'ip', $requester['ipKey'], $day],
            [$appId, 'ip-hour', $requester['ipKey'], $hour],
            [$appId, 'app', '', $day],
            ...$site,
        ];
    }

    /**
     * Give a job's use back (it failed without a result, or expired): each counter it was counted
     * in, once. Answers whether this call gave it back.
     */
    public function refund(string $jobId): bool
    {
        $pdo = $this->pdo();
        $pdo->beginTransaction();
        try {
            $statement = $pdo->prepare("SELECT * FROM app_ai_jobs WHERE id = ? AND refunded = 0 AND counted_day IS NOT NULL AND status NOT IN ('refused') FOR UPDATE");
            $statement->execute([$jobId]);
            $job = $statement->fetch(PDO::FETCH_ASSOC);
            if (!is_array($job)) { $pdo->commit(); return false; }
            $requester = ['kind' => $job['requester_kind'], 'id' => $job['requester_id'], 'ipKey' => $job['ip_key']];
            // Given back where it was counted: the site's day only for a job sent to the site's AI.
            $siteAi = str_starts_with((string) ($job['source'] ?? ''), 'site-');
            foreach ($this->counters((string) $job['app_id'], $requester, (string) $job['counted_day'], (string) $job['counted_hour'], $siteAi) as [$counterApp, $scope, $subject, $period]) {
                $pdo->prepare('UPDATE app_ai_counters SET used = used - 1 WHERE app_id = ? AND scope = ? AND subject = ? AND period = ? AND used > 0')->execute([$counterApp, $scope, $subject, $period]);
            }
            $pdo->prepare('UPDATE app_ai_jobs SET refunded = 1 WHERE id = ?')->execute([$jobId]);
            $pdo->commit();
            return true;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }

    /**
     * The job a row of the app's jobs table asks for, checked: [job fields, refusal or null].
     * $key is the row's id from the event, used when the row itself can no longer be read.
     */
    private function jobFrom(?array $row, mixed $key, array $declared): array
    {
        $appJobId = is_array($row) && (is_string($row['id'] ?? null) || is_int($row['id'] ?? null)) ? (string) $row['id'] : (is_scalar($key) ? (string) $key : '');
        $bad = static fn(string $message, array $job = []) => [['appJobId' => $appJobId] + $job, ['code' => 'bad_request', 'message' => $message]];
        if ($row === null) return $bad('The job could not be read from the app\'s database.');
        if ($appJobId === '' || strlen($appJobId) > 100) return $bad('A job\'s id must be 1 to 100 characters.');
        $kind = $row['kind'] ?? null;
        if (!is_string($kind) || !in_array($kind, AppFormlogicManifest::AI_USES, true)) return $bad('A job\'s kind is picture, edit or chat.');
        if (!in_array($kind, $declared['kinds'], true)) return $bad("This app's manifest does not use the AI for {$kind} jobs.", ['kind' => $kind]);
        $site = $this->site->current();
        if ($kind === 'chat') {
            $messages = is_string($row['messages'] ?? null) ? json_decode($row['messages'], true) : null;
            if (!is_array($messages) || !array_is_list($messages) || $messages === [] || count($messages) > self::MAX_MESSAGES) return $bad('A chat job needs messages: a JSON list of 1 to ' . self::MAX_MESSAGES . ' {role, content}.', ['kind' => $kind]);
            $total = 0;
            $clean = [];
            foreach ($messages as $message) {
                $role = is_array($message) ? ($message['role'] ?? null) : null;
                $content = is_array($message) ? ($message['content'] ?? null) : null;
                if (!in_array($role, ['system', 'user', 'assistant'], true) || !is_string($content) || preg_match('/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u', $content) === 1) return $bad('Each chat message is {role: system, user or assistant, content: text}.', ['kind' => $kind]);
                $total += mb_strlen($content);
                $clean[] = ['role' => $role, 'content' => $content];
                if ($role === 'user' && ($word = AppAiSiteSettings::refusedWord($content, $site['words'])) !== null) return [['appJobId' => $appJobId, 'kind' => $kind], ['code' => 'prompt_refused', 'message' => 'That request includes words this site does not allow.']];
            }
            if ($total > self::MAX_CHAT_CHARACTERS) return $bad('A chat job may hold up to ' . self::MAX_CHAT_CHARACTERS . ' characters.', ['kind' => $kind]);
            return [['appJobId' => $appJobId, 'kind' => $kind, 'prompt' => json_encode($clean, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR)], null];
        }
        $prompt = $row['prompt'] ?? null;
        if (!is_string($prompt) || trim($prompt) === '' || mb_strlen($prompt) > self::MAX_PROMPT || preg_match('/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u', $prompt) === 1) return $bad('A picture job needs a prompt of 1 to ' . self::MAX_PROMPT . ' characters.', ['kind' => $kind]);
        $size = $row['size'] ?? null;
        if ($size === null || $size === '') $size = '1024x1024';
        if (!is_string($size) || !in_array($size, self::SIZES, true)) return $bad('A picture\'s size is one of ' . implode(', ', self::SIZES) . '.', ['kind' => $kind]);
        $seed = $row['seed'] ?? null;
        if ($seed !== null && $seed !== '') {
            // OAIY takes 0 to 2^53 - 1, the whole numbers JavaScript holds exactly (contract §0.9).
            if (is_string($seed) && preg_match('/^\d{1,16}$/D', $seed)) $seed = (int) $seed;
            if (is_float($seed) && floor($seed) === $seed && $seed >= 0 && $seed <= self::MAX_SEED) $seed = (int) $seed;
            if (!is_int($seed) || $seed < 0 || $seed > self::MAX_SEED) return $bad('A seed is a whole number from 0 to ' . self::MAX_SEED . '.', ['kind' => $kind]);
        } else {
            $seed = null;
        }
        $reference = null;
        if ($kind === 'edit') {
            $reference = $row['reference'] ?? null;
            if (!is_string($reference) || strlen($reference) > self::MAX_REFERENCE_BYTES * 4 / 3 + 64 || !preg_match('#^data:image/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$#D', $reference)) return $bad('An edit needs its picture: a PNG, JPEG or WebP data URL of at most 2 MB.', ['kind' => $kind]);
        }
        if (AppAiSiteSettings::refusedWord($prompt, $site['words']) !== null) return [['appJobId' => $appJobId, 'kind' => $kind], ['code' => 'prompt_refused', 'message' => 'That request includes words this site does not allow.']];
        return [['appJobId' => $appJobId, 'kind' => $kind, 'prompt' => $prompt, 'size' => $size, 'seed' => $seed, 'reference' => $reference], null];
    }

    /** What the app hears for each reason its AI is off (its `ai.reason` and refused jobs' messages). */
    public const REASONS = [
        'ai_off' => 'AI is turned off for this app.',
        'ai_paused' => 'The site has paused AI for apps for now.',
        'ai_blocked' => 'AI is not available for this app.',
        'ai_resting' => 'The AI is having trouble and is resting for a few minutes.',
        'plan_inactive' => 'AI is not available for this app right now.',
        'own_unset' => 'The app\'s owner has not chosen their OAIY yet.',
        'own_changed' => 'The computer this app\'s AI runs on was unlinked, or has a new key. Its owner can choose it again.',
        'site_ai_closed' => 'The site does not offer its AI to apps.',
        'site_ai_unavailable' => 'The site\'s AI is not set up.',
        'model_unset' => 'No model is chosen for this kind of request yet.',
        'no_pictures' => 'This server cannot draw pictures for apps: it needs PHP\'s GD extension.',
        'not_offered' => 'This kind of AI request is not available for this app right now.',
        'visitor_required' => 'Open the app in your browser to use its AI.',
        'subscriptions_full' => 'This app watches too many of its tables for its AI requests to be seen. Its owner can remove a database automation.',
    ];

    // ------------------------------------------------------------------ the owner's "AI for this app"

    /** A test's picture and chat: small, and the same every time. */
    public const TEST_PICTURE = 'A small round badge with a coffee cup, flat colours, on a white background';
    public const TEST_CHAT = [['role' => 'user', 'content' => 'Say hello in five words.']];
    /** The requester a test job is recorded under: never a member or a visitor, so never delivered to the app. */
    public const TEST_REQUESTER = 'test';
    /** A test's address key: it counts against no address. */
    private const TEST_IP_KEY = '0000000000000000';
    /** Jobs the owner's page lists. */
    private const LOG_ROWS = 50;

    /**
     * The owner's "AI for this app" (AppAiController): what the app declares, its settings, where its
     * AI comes from now, how its queue is doing, today's numbers and its latest requests.
     */
    public function ownerView(array $app): array
    {
        $appId = (string) $app['id'];
        $declared = AppFormlogicManifest::ai($this->native->installedManifest($appId));
        $settings = $this->settings($appId);
        $available = $declared === null
            ? ['enabled' => false, 'source' => 'off', 'target' => null, 'label' => '', 'kinds' => [], 'reason' => 'ai_off']
            : $this->availability($app, $declared, $settings);
        $day = $this->day();
        $pdo = $this->pdo();
        $today = $pdo->prepare("SELECT SUM(status = 'failed' AND code <> 'undelivered') AS failed, SUM(status = 'refused') AS refused FROM app_ai_jobs WHERE app_id = ? AND counted_day = ? AND requester_kind <> ?");
        $today->execute([$appId, $day, self::TEST_REQUESTER]);
        $counts = $today->fetch(PDO::FETCH_ASSOC) ?: [];
        $log = $pdo->prepare('SELECT id, app_job_id, kind, status, code, message, requester_kind, requester_id, created_at, started_at, finished_at FROM app_ai_jobs WHERE app_id = ? ORDER BY created_at DESC LIMIT ' . self::LOG_ROWS);
        $log->execute([$appId]);
        unset($settings['appId']);
        if ($settings['own'] !== null) unset($settings['own']['publicKey'], $settings['own']['instanceId']);
        return [
            'declared' => $declared === null ? null : ['uses' => $declared['uses'], 'purpose' => $declared['purpose'], 'table' => $declared['table'], 'deliver' => $declared['deliver']],
            'settings' => $settings,
            'availability' => array_diff_key($available, ['target' => true]),
            'reasonText' => $available['reason'] !== null ? (self::REASONS[$available['reason']] ?? null) : null,
            'siteOffers' => (bool) $this->site->current()['allowApps'],
            // The owner's own linked computers that could serve the app ("Use my OAIY"): each with a
            // published chat key, and whether it was heard from in the last 90 seconds.
            'computers' => $this->siteDesktop?->candidates((string) $app['ownerId']) ?? [],
            'status' => $this->status($appId, $settings, $available),
            'today' => [
                'jobs' => $this->used($appId, 'app', '', $day),
                'failed' => (int) ($counts['failed'] ?? 0),
                'refused' => (int) ($counts['refused'] ?? 0),
            ],
            'log' => array_map(static fn(array $row): array => [
                'id' => (string) $row['id'],
                'appJobId' => (string) $row['app_job_id'],
                'kind' => (string) $row['kind'],
                'status' => (string) $row['status'],
                'code' => $row['code'],
                'message' => $row['message'],
                // Who asked, as far as the owner needs: never a visitor's whole id or an address.
                'requester' => match ($row['requester_kind']) {
                    self::TEST_REQUESTER => 'Test',
                    'user' => 'Member ' . substr((string) $row['requester_id'], 0, 8),
                    default => 'Visitor ' . substr((string) $row['requester_id'], 0, 6),
                },
                'test' => $row['requester_kind'] === self::TEST_REQUESTER,
                'createdAt' => (string) $row['created_at'],
                'finishedAt' => $row['finished_at'],
                'seconds' => $row['started_at'] !== null && $row['finished_at'] !== null
                    ? round(max(0.0, self::seconds((string) $row['finished_at']) - self::seconds((string) $row['started_at'])), 1) : null,
            ], $log->fetchAll(PDO::FETCH_ASSOC)),
        ];
    }

    /** How the app's AI is doing now, in a sentence for its owner. */
    private function status(string $appId, array $settings, array $available): array
    {
        $statement = $this->pdo()->prepare("SELECT SUM(status = 'queued') AS waiting, SUM(status IN ('sending','running')) AS running, MIN(CASE WHEN status = 'queued' THEN created_at END) AS since FROM app_ai_jobs WHERE app_id = ?");
        $statement->execute([$appId]);
        $row = $statement->fetch(PDO::FETCH_ASSOC) ?: [];
        $waiting = (int) ($row['waiting'] ?? 0);
        $running = (int) ($row['running'] ?? 0);
        $out = static fn(string $state, string $message) => ['state' => $state, 'waiting' => $waiting, 'running' => $running, 'since' => $row['since'] ?? null, 'message' => $message];
        if ($settings['mode'] === 'off') return $out('off', 'AI is off for this app: it is told so, and nothing is sent anywhere.');
        if ($settings['blocked']) return $out('blocked', 'The site\'s administrator has stopped this app\'s AI' . ($settings['blockedReason'] ? ': ' . $settings['blockedReason'] : '.'));
        if (!$available['enabled']) {
            $reason = (string) $available['reason'];
            if ($reason === 'ai_resting') return $out('paused', 'Its AI failed five times in a row, so it is resting until ' . gmdate('H:i', (int) strtotime((string) $settings['pausedUntil'] . ' UTC')) . ' UTC.');
            return $out($reason === 'ai_paused' ? 'paused' : 'off', self::REASONS[$reason] ?? self::REASONS['ai_off']);
        }
        if ($available['target'] !== 'env' && !$this->computerOnline($appId, $settings, $available)) {
            return $out('offline', 'The computer its AI runs on is offline. Requests wait for it, for up to 30 minutes.');
        }
        if ($waiting + $running > 0) return $out('busy', "Working on {$running}, with {$waiting} waiting.");
        return $out('idle', 'Ready: ' . $available['label'] . '.');
    }

    /**
     * One of the owner's own linked computers, pinned to the key it has published now
     * (SiteAiDesktopSettings::pin), with the provider that chats on it and the models the app's
     * pictures and chat use: {connectionId, providerId?, pictureModel?, chatModel?}. OAIY's own
     * engine draws the pictures whatever provider chats.
     */
    private function pinOwn(string $ownerId, mixed $choice): array
    {
        if (!is_array($choice) || !is_string($choice['connectionId'] ?? null)) throw new \InvalidArgumentException('Choose one of your linked computers.');
        if ($this->siteDesktop === null) throw new \InvalidArgumentException('OAIY computers are not available on this site.');
        $pinned = $this->siteDesktop->pin($ownerId, $choice['connectionId']);
        $provider = SiteAiDesktopSettings::provider(is_string($choice['providerId'] ?? null) && $choice['providerId'] !== '' ? $choice['providerId'] : SiteDesktopAi::PROVIDER);
        return [
            'connectionId' => $pinned['connectionId'], 'instanceId' => $pinned['instanceId'], 'publicKey' => $pinned['publicKey'], 'deviceName' => mb_substr($pinned['deviceName'], 0, 255),
            'providerId' => $provider,
            'pictureModel' => AppAiSiteSettings::model($choice['pictureModel'] ?? null, 'The picture model'),
            'chatModel' => $provider === SiteDesktopAi::PROVIDER ? null : SiteAiDesktopSettings::model($provider, is_string($choice['chatModel'] ?? null) ? $choice['chatModel'] : null),
        ];
    }

    /** Whether the owner's chosen computer is still theirs, with the key it was pinned to. */
    private function ownStillPinned(string $ownerId, array $own): bool
    {
        $statement = $this->pdo()->prepare('SELECT e2e_public_key FROM desktop_connections WHERE id = ? AND owner_user_id = ?');
        $statement->execute([$own['connectionId'], $ownerId]);
        $key = $statement->fetchColumn();
        return is_string($key) && hash_equals($key, (string) $own['publicKey']);
    }

    /** Whether the OAIY computer the app's AI goes to has been heard from in the last 90 seconds. */
    private function computerOnline(string $appId, array $settings, array $available): bool
    {
        if ($this->siteDesktop === null) return false;
        if ($available['source'] === 'own') {
            $own = $settings['own'];
            return $own !== null && $this->siteDesktop->online(['connectionId' => $own['connectionId'], 'ownerUserId' => (string) ($this->app($appId)['ownerId'] ?? '')]);
        }
        $computer = $this->siteDesktop->current();
        return $computer !== null && $this->siteDesktop->online($computer);
    }

    /**
     * Save the owner's settings: {mode: off|site|own, perRequesterDay, perIpDay, perIpHour, perAppDay}.
     * On the site's AI an app may make at most the site's default requests a day (the administrator's
     * ceiling for every app). Answers the owner's view.
     */
    public function saveSettings(array $app, array $input, string $userId): array
    {
        $appId = (string) $app['id'];
        if (AppFormlogicManifest::ai($this->native->installedManifest($appId)) === null) throw new \InvalidArgumentException('This app does not ask for AI: its manifest has no formlogicAi section.');
        $current = $this->settings($appId);
        $site = $this->site->current();
        $mode = $input['mode'] ?? $current['mode'];
        if (!in_array($mode, ['off', 'site', 'own'], true)) throw new \InvalidArgumentException('Choose off, this site\'s AI, or your own OAIY.');
        if ($mode === 'site' && !$site['allowApps'] && $current['mode'] !== 'site') throw new \InvalidArgumentException(self::REASONS['site_ai_closed']);
        $own = $current['own'];
        if (array_key_exists('own', $input)) $own = $input['own'] === null ? null : $this->pinOwn((string) $app['ownerId'], $input['own']);
        if ($mode === 'own' && $own === null) throw new \InvalidArgumentException('Choose one of your linked computers first.');
        $labels = ['perRequesterDay' => 'Requests per visitor or member a day', 'perIpDay' => 'Requests per address a day', 'perIpHour' => 'Requests per address an hour', 'perAppDay' => 'Requests for the whole app a day'];
        $limits = [];
        foreach (AppAiSiteSettings::LIMITS as $key => $range) {
            $value = array_key_exists($key, $input) ? $input[$key] : $current[$key];
            $limits[$key] = AppAiSiteSettings::limit($value, $labels[$key], $range);
        }
        if ($mode === 'site' && $limits['perAppDay'] > $site['defaults']['perAppDay']) {
            throw new \InvalidArgumentException("On this site's AI, an app may make at most {$site['defaults']['perAppDay']} requests a day.");
        }
        $this->pdo()->prepare(
            'INSERT INTO app_ai_settings (app_id, mode, per_requester_day, per_ip_day, per_ip_hour, per_app_day, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE mode = VALUES(mode), per_requester_day = VALUES(per_requester_day), per_ip_day = VALUES(per_ip_day),
             per_ip_hour = VALUES(per_ip_hour), per_app_day = VALUES(per_app_day), updated_by = VALUES(updated_by)'
        )->execute([$appId, $mode, $limits['perRequesterDay'], $limits['perIpDay'], $limits['perIpHour'], $limits['perAppDay'], $userId]);
        if (array_key_exists('own', $input)) {
            $this->pdo()->prepare('UPDATE app_ai_settings SET own_connection_id = ?, own_instance_id = ?, own_public_key = ?, own_provider_id = ?, own_picture_model = ?, own_chat_model = ?, own_device_name = ? WHERE app_id = ?')
                ->execute([$own['connectionId'] ?? null, $own['instanceId'] ?? null, $own['publicKey'] ?? null, $own['providerId'] ?? null, $own['pictureModel'] ?? null, $own['chatModel'] ?? null, $own['deviceName'] ?? null, $appId]);
        }
        // An owner who turns the AI back on gives it a fresh start.
        if ($mode !== 'off') $this->pdo()->prepare('UPDATE app_ai_settings SET paused_until = NULL, failures_in_row = 0 WHERE app_id = ? AND paused_until IS NOT NULL AND ? <> ?')->execute([$appId, $mode, $current['mode']]);
        return $this->ownerView($app);
    }

    /**
     * Queue a test for the owner: a small picture (512 px) or a five-word chat, sent where the app's
     * visitors' requests go, and kept for the owner to see, never delivered to the app. It counts in
     * the app's day and the site's, like any job; one test at a time per app.
     */
    public function queueTest(array $app, string $kind): string
    {
        $appId = (string) $app['id'];
        $declared = AppFormlogicManifest::ai($this->native->installedManifest($appId)) ?? throw new \RuntimeException('This app does not ask for AI.');
        $kind = $kind === 'chat' ? 'chat' : 'picture';
        $pdo = $this->pdo();
        $now = ($this->now)();
        $day = gmdate('Y-m-d', $now);
        $hour = gmdate('Y-m-d\TH', $now);
        $site = $this->site->current();
        $pdo->beginTransaction();
        try {
            $pdo->prepare('INSERT IGNORE INTO app_ai_settings (app_id, per_requester_day, per_ip_day, per_ip_hour, per_app_day) VALUES (?, ?, ?, ?, ?)')
                ->execute([$appId, $site['defaults']['perRequesterDay'], $site['defaults']['perIpDay'], $site['defaults']['perIpHour'], $site['defaults']['perAppDay']]);
            $lock = $pdo->prepare('SELECT * FROM app_ai_settings WHERE app_id = ? FOR UPDATE');
            $lock->execute([$appId]);
            $settings = self::shape($lock->fetch(PDO::FETCH_ASSOC));
            $available = $this->availability($app, $declared, $settings);
            if (!$available['enabled']) throw new \RuntimeException(self::REASONS[$available['reason']] ?? self::REASONS['ai_off']);
            if (!in_array($kind, $available['kinds'], true)) throw new \RuntimeException($kind === 'chat' ? 'This app does not use chat.' : self::REASONS['model_unset']);
            $open = $pdo->prepare("SELECT COUNT(*) FROM app_ai_jobs WHERE app_id = ? AND requester_kind = ? AND status IN ('queued','sending','running')");
            $open->execute([$appId, self::TEST_REQUESTER]);
            if ((int) $open->fetchColumn() > 0) throw new \RuntimeException('A test is already running. Wait for it to finish.');
            if ($this->used($appId, 'app', '', $day) >= $settings['perAppDay']) throw new \RuntimeException('This app has used its AI for today.');
            if ($available['source'] === 'site') {
                $pdo->prepare("INSERT IGNORE INTO app_ai_counters (app_id, scope, subject, period, used) VALUES ('', 'site', '', ?, 0)")->execute([$day]);
                $siteRow = $pdo->prepare("SELECT used FROM app_ai_counters WHERE app_id = '' AND scope = 'site' AND subject = '' AND period = ? FOR UPDATE");
                $siteRow->execute([$day]);
                if ((int) $siteRow->fetchColumn() >= (int) $site['siteDay']) throw new \RuntimeException('The site\'s AI has done all it can for apps today.');
            }
            $id = bin2hex(random_bytes(16));
            $prompt = $kind === 'chat' ? json_encode(self::TEST_CHAT, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) : self::TEST_PICTURE;
            $pdo->prepare(
                'INSERT INTO app_ai_jobs (id, app_id, event_id, app_job_id, requester_kind, requester_id, ip_key, kind, status, source, target, prompt, prompt_sha256, size, counted_day, counted_hour, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            )->execute([
                $id, $appId, bin2hex(random_bytes(16)), 'test-' . substr($id, 0, 8), self::TEST_REQUESTER, (string) $app['ownerId'], self::TEST_IP_KEY,
                $kind, 'queued', $available['source'] . '-' . ($available['target'] === 'env' ? 'env' : 'oaiy'), $available['target'],
                $prompt, hash('sha256', $prompt), $kind === 'chat' ? null : '512x512', $day, $hour, self::stamp($this->realClock ? microtime(true) : $now),
            ]);
            foreach ($this->counters($appId, ['kind' => self::TEST_REQUESTER, 'id' => (string) $app['ownerId'], 'ipKey' => self::TEST_IP_KEY], $day, $hour, $available['source'] === 'site') as [$counterApp, $scope, $subject, $period]) {
                $pdo->prepare('INSERT INTO app_ai_counters (app_id, scope, subject, period, used) VALUES (?, ?, ?, ?, 1) ON DUPLICATE KEY UPDATE used = used + 1')
                    ->execute([$counterApp, $scope, $subject, $period]);
            }
            $pdo->commit();
            return $id;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }

    /**
     * How a test is getting on: {status: queued|running|done|failed, picture?, text?, model, seed,
     * seconds, code?, message?}, or null when $jobId is not a test of this app. $results is where the
     * worker keeps results (AppAiWorker).
     */
    public function testResult(string $appId, string $jobId, string $results): ?array
    {
        if (!preg_match('/^[a-f0-9]{32}$/D', $jobId)) return null;
        $statement = $this->pdo()->prepare('SELECT * FROM app_ai_jobs WHERE id = ? AND app_id = ? AND requester_kind = ?');
        $statement->execute([$jobId, $appId, self::TEST_REQUESTER]);
        $job = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($job)) return null;
        $seconds = $job['started_at'] !== null && $job['finished_at'] !== null ? round(max(0.0, self::seconds((string) $job['finished_at']) - self::seconds((string) $job['started_at'])), 1) : null;
        if (in_array($job['status'], ['queued', 'sending'], true)) return ['status' => 'queued'];
        if ($job['status'] === 'running') return ['status' => 'running'];
        if ($job['status'] === 'done') {
            $result = $job['result_path'] !== null ? json_decode((string) @file_get_contents($results . '/' . basename((string) $job['result_path'])), true) : null;
            if (!is_array($result)) return ['status' => 'failed', 'code' => 'expired', 'message' => 'This test\'s result is no longer kept. Run it again.', 'seconds' => $seconds];
            return ['status' => 'done', 'seconds' => $seconds] + array_intersect_key($result, array_flip(['picture', 'text', 'model', 'seed', 'mimeType', 'width', 'height']));
        }
        return ['status' => 'failed', 'code' => $job['code'], 'message' => $job['message'], 'seconds' => $seconds];
    }

    // ------------------------------------------------------------------ the administrator's "AI for apps"

    /** Every app that has used or set up AI: its settings and today's numbers, busiest first. */
    public function adminOverview(): array
    {
        $day = $this->day();
        $statement = $this->pdo()->prepare(
            "SELECT s.app_id, s.mode, s.blocked_by_admin, s.blocked_reason, s.paused_until, a.name, u.email AS owner_email,
                    COALESCE(c.used, 0) AS jobs_today,
                    (SELECT COUNT(*) FROM app_ai_jobs j WHERE j.app_id = s.app_id AND j.counted_day = ? AND j.status = 'failed') AS failed_today
             FROM app_ai_settings s
             JOIN apps a ON a.id = s.app_id
             LEFT JOIN users u ON u.id = a.owner_id
             LEFT JOIN app_ai_counters c ON c.app_id = s.app_id AND c.scope = 'app' AND c.subject = '' AND c.period = ?
             ORDER BY jobs_today DESC, a.name LIMIT 200"
        );
        $statement->execute([$day, $day]);
        return array_map(static fn(array $row): array => [
            'appId' => (string) $row['app_id'],
            'name' => (string) $row['name'],
            'ownerEmail' => (string) ($row['owner_email'] ?? ''),
            'mode' => (string) $row['mode'],
            'jobsToday' => (int) $row['jobs_today'],
            'failedToday' => (int) $row['failed_today'],
            'blocked' => (bool) $row['blocked_by_admin'],
            'blockedReason' => $row['blocked_reason'],
            'pausedUntil' => $row['paused_until'],
        ], $statement->fetchAll(PDO::FETCH_ASSOC));
    }

    /**
     * What the administrator should know about App AI now: a picture model the computer refused in the
     * last day (switched off, or its files missing), or none chosen while apps may use the site's AI.
     *
     * @return list<array{code: string, message: string}>
     */
    public function adminWarnings(): array
    {
        $warnings = [];
        $site = $this->site->current();
        if ($site['allowApps'] && $site['pictureModel'] === null) {
            $warnings[] = ['code' => 'picture_model_unset', 'message' => 'Apps may use this site\'s AI, but no picture model is chosen, so they can ask for chat only.'];
        }
        $statement = $this->pdo()->prepare("SELECT code, message, model, MAX(finished_at) AS last_at FROM app_ai_jobs WHERE code IN ('model_disabled', 'model_unknown') AND finished_at > ? GROUP BY code, message, model ORDER BY last_at DESC LIMIT 3");
        $statement->execute([self::stamp(($this->now)() - 86400)]);
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $warnings[] = ['code' => (string) $row['code'], 'message' => ($row['code'] === 'model_disabled'
                ? 'The picture model ' . ($row['model'] ?? '') . ' is switched off or missing its files on the AI computer: '
                : 'The AI computer does not know the picture model ' . ($row['model'] ?? '') . ': ') . (string) $row['message']];
        }
        return $warnings;
    }

    /** Whether any job has waited at least $seconds to be sent or delivered (the worker is not running, if so). */
    public function jobsWaitingFor(int $seconds): bool
    {
        $statement = $this->pdo()->prepare("SELECT 1 FROM app_ai_jobs WHERE status IN ('queued', 'delivering') AND (next_attempt_at IS NULL OR next_attempt_at < ?) AND created_at < ? LIMIT 1");
        $statement->execute([self::stamp(($this->now)() - $seconds), self::stamp(($this->now)() - $seconds)]);
        return $statement->fetchColumn() !== false;
    }

    /** Stop (or let again) one app's AI. Its waiting jobs are told so as the worker next looks. */
    public function block(string $appId, bool $blocked, ?string $reason, string $adminId): void
    {
        $defaults = $this->site->current()['defaults'];
        $this->pdo()->prepare(
            'INSERT INTO app_ai_settings (app_id, per_requester_day, per_ip_day, per_ip_hour, per_app_day, blocked_by_admin, blocked_reason, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE blocked_by_admin = VALUES(blocked_by_admin), blocked_reason = VALUES(blocked_reason), updated_by = VALUES(updated_by)'
        )->execute([$appId, $defaults['perRequesterDay'], $defaults['perIpDay'], $defaults['perIpHour'], $defaults['perAppDay'], $blocked ? 1 : 0, $blocked ? $reason : null, $adminId]);
    }

    // ------------------------------------------------------------------ keeping

    /**
     * What App AI keeps, kept no longer than it needs (bin/privacy-sweep.php, and the worker now and
     * then): prompts and pictures to edit are cleared after $promptDays, rows removed after $rowDays,
     * counters after three days, and results the worker no longer needs (a test's after an hour)
     * deleted from $results. Answers what it did.
     */
    public function sweep(string $results, int $promptDays = 30, int $rowDays = 90): array
    {
        $pdo = $this->pdo();
        $now = ($this->now)();
        $cleared = $pdo->prepare('UPDATE app_ai_jobs SET prompt = NULL, reference = NULL WHERE created_at < ? AND (prompt IS NOT NULL OR reference IS NOT NULL)');
        $cleared->execute([self::stamp($now - $promptDays * 86400)]);
        $old = $pdo->prepare('SELECT id, result_path FROM app_ai_jobs WHERE created_at < ?');
        $old->execute([self::stamp($now - $rowDays * 86400)]);
        $removed = 0;
        foreach (array_chunk($old->fetchAll(PDO::FETCH_ASSOC), 500) as $chunk) {
            foreach ($chunk as $row) {
                if ($row['result_path'] !== null) @unlink($results . '/' . basename((string) $row['result_path']));
            }
            $marks = implode(',', array_fill(0, count($chunk), '?'));
            $delete = $pdo->prepare("DELETE FROM app_ai_jobs WHERE id IN ({$marks})");
            $delete->execute(array_column($chunk, 'id'));
            $removed += $delete->rowCount();
        }
        $counters = $pdo->prepare('DELETE FROM app_ai_counters WHERE period < ?');
        $counters->execute([gmdate('Y-m-d', $now - 3 * 86400)]);
        // A test's result once the owner has had an hour to look at it.
        $tests = $pdo->prepare("SELECT id, result_path FROM app_ai_jobs WHERE requester_kind = ? AND result_path IS NOT NULL AND finished_at < ?");
        $tests->execute([self::TEST_REQUESTER, self::stamp($now - 3600)]);
        $files = 0;
        foreach ($tests->fetchAll(PDO::FETCH_ASSOC) as $row) {
            if (@unlink($results . '/' . basename((string) $row['result_path']))) $files++;
            $pdo->prepare('UPDATE app_ai_jobs SET result_path = NULL WHERE id = ?')->execute([$row['id']]);
        }
        // Anything left behind by a worker that stopped mid-delivery, a day on.
        foreach (glob($results . '/*.json') ?: [] as $file) {
            if (filemtime($file) < $now - 86400) {
                $job = $pdo->prepare("SELECT 1 FROM app_ai_jobs WHERE result_path = ? AND status = 'delivering'");
                $job->execute([basename($file)]);
                if ($job->fetchColumn() === false && @unlink($file)) $files++;
            }
        }
        return ['promptsCleared' => $cleared->rowCount(), 'rowsRemoved' => $removed, 'countersRemoved' => $counters->rowCount(), 'filesRemoved' => $files];
    }

    /** A DATETIME(3) value read as seconds since the epoch. */
    private static function seconds(string $stamp): float
    {
        $whole = strtotime(substr($stamp, 0, 19) . ' UTC');
        return (float) $whole + (strlen($stamp) > 20 ? (float) ('0' . substr($stamp, 19)) : 0.0);
    }

    // ------------------------------------------------------------------ helpers

    private function used(string $appId, string $scope, string $subject, string $period): int
    {
        $statement = $this->pdo()->prepare('SELECT used FROM app_ai_counters WHERE app_id = ? AND scope = ? AND subject = ? AND period = ?');
        $statement->execute([$appId, $scope, $subject, $period]);
        return (int) $statement->fetchColumn();
    }

    private static function subject(array $requester): string
    {
        return ($requester['kind'] === 'user' ? 'u:' : 'v:') . $requester['id'];
    }

    /** The app's id, owner and status, or null when it is gone. */
    private function app(string $appId): ?array
    {
        $statement = $this->pdo()->prepare('SELECT id, owner_id AS ownerId, status FROM apps WHERE id = ?');
        $statement->execute([$appId]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        return is_array($row) ? $row : null;
    }

    private function day(): string
    {
        return gmdate('Y-m-d', ($this->now)());
    }

    /** A DATETIME(3) value, UTC. */
    public static function stamp(int|float $time): string
    {
        $whole = (int) floor($time);
        return gmdate('Y-m-d H:i:s', $whole) . sprintf('.%03d', (int) round(($time - $whole) * 1000) % 1000);
    }

    private function pdo(): PDO
    {
        return $this->mysql->getConnection();
    }
}
