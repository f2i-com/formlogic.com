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
        if ($settings['mode'] === 'own') {
            $own = $settings['own'];
            if ($own === null) return $off('own_unset', 'own');
            $kinds = array_values(array_filter($declared['kinds'], static fn(string $kind) => $kind === 'chat' || ($own['pictureModel'] ?? null) !== null));
            return ['enabled' => $kinds !== [], 'source' => 'own', 'target' => $own['connectionId'], 'label' => $own['deviceName'] !== '' ? 'OAIY on ' . $own['deviceName'] : 'The owner\'s OAIY', 'kinds' => $kinds, 'reason' => $kinds === [] ? 'model_unset' : null];
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
        $kinds = array_values(array_filter($declared['kinds'], static fn(string $kind) => $kind === 'chat' || $site['pictureModel'] !== null));
        return ['enabled' => $kinds !== [], 'source' => 'site', 'target' => $target, 'label' => 'This site\'s AI', 'kinds' => $kinds, 'reason' => $kinds === [] ? 'model_unset' : null];
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
                foreach ($this->counters($appId, $requester, $day, $hour) as [$counterApp, $scope, $subject, $period]) {
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

    /** The counters a queued job adds one to: [app id, scope, subject, period] each. */
    private function counters(string $appId, array $requester, string $day, string $hour): array
    {
        return [
            [$appId, 'requester', self::subject($requester), $day],
            [$appId, 'ip', $requester['ipKey'], $day],
            [$appId, 'ip-hour', $requester['ipKey'], $hour],
            [$appId, 'app', '', $day],
            ['', 'site', '', $day],
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
            foreach ($this->counters((string) $job['app_id'], $requester, (string) $job['counted_day'], (string) $job['counted_hour']) as [$counterApp, $scope, $subject, $period]) {
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
            if (is_string($seed) && preg_match('/^\d{1,10}$/D', $seed)) $seed = (int) $seed;
            if (!is_int($seed) || $seed < 0 || $seed > 4294967295) return $bad('A seed is a whole number from 0 to 4294967295.', ['kind' => $kind]);
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
        'site_ai_closed' => 'The site does not offer its AI to apps.',
        'site_ai_unavailable' => 'The site\'s AI is not set up.',
        'model_unset' => 'No model is chosen for this kind of request yet.',
        'not_offered' => 'This kind of AI request is not available for this app right now.',
        'visitor_required' => 'Open the app in your browser to use its AI.',
        'subscriptions_full' => 'This app watches too many of its tables for its AI requests to be seen. Its owner can remove a database automation.',
    ];

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
