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
    /** Statuses an app's cancel still stops: waiting, sent, or back but not yet delivered. */
    public const CANCELLABLE = ['queued', 'sending', 'running', 'delivering'];
    /** Who asked, for a request no FormLogic page marked: nobody known. Its jobs are refused. */
    public const NOBODY = 'nobody';
    /** A binding's kind for a row written by a deliver route: a follow-up job for the delivered job's requester. */
    public const FOLLOW_UP = 'follow';
    /** The largest seed a picture may ask for: 2^53 - 1. */
    public const MAX_SEED = 9007199254740991;
    /**
     * What FormLogic reads of a chat answer, whatever the AI goes on to send: this many characters
     * for each token the answer may have (a token is about four characters, so twice what an answer
     * within its tokens takes), and never more than MAX_ANSWER_CHARACTERS. Past it the turn is ended
     * and the computer told to stop: an AI that does not know the token limit, or ignores it, cannot
     * run on (contract §0.13).
     */
    public const ANSWER_CHARACTERS_PER_TOKEN = 8;
    public const MAX_ANSWER_CHARACTERS = 32000;

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
        return $this->onSite($declared['kinds'], $site);
    }

    /**
     * Where the site's AI runs now: the administrator's chosen computer; `gone` when the one chosen
     * was unlinked or given a new key (its work goes nowhere else in its place); the provider in the
     * server's settings when no computer is chosen and the Site AI switch is on; or `none`.
     *
     * @return array{kind: string, computer: ?array}
     */
    private function siteSource(): array
    {
        $computer = $this->siteDesktop?->current();
        if ($computer !== null) return ['kind' => 'computer', 'computer' => $computer];
        if ($this->siteDesktop?->gone() !== null) return ['kind' => 'gone', 'computer' => null];
        if ($this->ai !== null && $this->ai->isConfigured()) return ['kind' => 'env', 'computer' => null];
        return ['kind' => 'none', 'computer' => null];
    }

    /**
     * What the site's AI can take now of $kinds, whoever asks: availability()'s answer for an app on
     * the site's AI, the administrator's switches for apps (allowApps, paused) aside.
     */
    private function onSite(array $kinds, array $site): array
    {
        $source = $this->siteSource();
        if ($source['kind'] === 'gone' || $source['kind'] === 'none') {
            return ['enabled' => false, 'source' => 'site', 'target' => null, 'label' => '', 'kinds' => [], 'reason' => $source['kind'] === 'gone' ? 'site_ai_gone' : 'site_ai_unavailable'];
        }
        // Pictures need a model chosen for them, and this server able to redraw what comes back.
        $pictures = AppAiPictures::available();
        $kinds = array_values(array_filter($kinds, static fn(string $kind) => $kind === 'chat' || ($pictures && $site['pictureModel'] !== null)));
        return [
            'enabled' => $kinds !== [], 'source' => 'site', 'target' => $source['kind'] === 'env' ? 'env' : (string) $source['computer']['connectionId'],
            'label' => 'This site\'s AI', 'kinds' => $kinds, 'reason' => $kinds === [] ? ($pictures ? 'model_unset' : 'no_pictures') : null,
        ];
    }

    /**
     * What the administrator's own test of the site's AI can ask for now (a picture, a chat), where
     * apps' requests on the site's AI go: the switches for apps aside, since the test is no app's.
     */
    public function siteTestAvailability(): array
    {
        return $this->onSite(['picture', 'chat'], $this->site->current());
    }

    // ------------------------------------------------------------------ a request

    /**
     * What one request of an app that declares AI gets: its `ai` context and the binding id its
     * subscriptions carry, always: a job written while the AI cannot take it is still taken, refused
     * and answered (contract §0.11). $requester is ['kind' => user|visitor, 'id' => …], or null when
     * nobody is known (an application-access request without FormLogic's visitor marker).
     *
     * @return array{context: array, binding: string}
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
        // Who is asking, as the delivery of their jobs will name them (contract §0.13).
        if (($who = self::requesterId($requester)) !== null) $context['requester'] = $who;
        if (!$context['enabled'] && $requester === null && $available['enabled']) $context['reason'] = 'visitor_required';
        elseif (!$available['enabled']) $context['reason'] = $available['reason'];
        // Every request carries the binding, whatever its AI can do now: a job it writes is always
        // taken and answered, refused with its code when it cannot run (contract §0.11).
        return ['context' => $context, 'binding' => self::binding($requester, $ipKey)];
    }

    /** The binding id a requester's subscription carries: who asked (`n`: nobody known), and from where. */
    public static function binding(?array $requester, string $ipKey): string
    {
        if ($requester === null) return self::BINDING_PREFIX . 'n-' . $ipKey;
        return self::BINDING_PREFIX . ($requester['kind'] === 'user' ? 'u' : 'v') . '-' . $requester['id'] . '-' . $ipKey;
    }

    /**
     * Who asked, as the app is told it (`req.context.formlogic.ai.requester`): `u-<member>` or
     * `v-<visitor>`, the same id the binding carries, or null when nobody is known. Opaque to the
     * app: the same for one person in one app, on their own requests and on the delivery of their
     * jobs, so an app can tell whose job a delivery is without keeping the person's own ids.
     */
    public static function requesterId(?array $requester): ?string
    {
        if ($requester === null || !in_array($requester['kind'] ?? null, ['user', 'visitor'], true)) return null;
        return ($requester['kind'] === 'user' ? 'u' : 'v') . '-' . $requester['id'];
    }

    /** A binding id read back: ['kind' => user|visitor|nobody, 'id' => …, 'ipKey' => …], a follow-up's ['kind' => follow, 'job' => …], or null when it is not App AI's. */
    public static function parseBinding(mixed $binding): ?array
    {
        if (!is_string($binding) || strlen($binding) > 100) return null;
        if (preg_match('/^fl-ai-u-([A-Za-z0-9-]{1,64})-([0-9a-f]{16})$/D', $binding, $m)) return ['kind' => 'user', 'id' => $m[1], 'ipKey' => $m[2]];
        if (preg_match('/^fl-ai-v-([0-9a-f]{32})-([0-9a-f]{16})$/D', $binding, $m)) return ['kind' => 'visitor', 'id' => $m[1], 'ipKey' => $m[2]];
        if (preg_match('/^fl-ai-n-([0-9a-f]{16})$/D', $binding, $m)) return ['kind' => self::NOBODY, 'id' => '', 'ipKey' => $m[1]];
        if (preg_match('/^fl-ai-f-([0-9a-f]{32})$/D', $binding, $m)) return ['kind' => self::FOLLOW_UP, 'job' => $m[1], 'id' => '', 'ipKey' => ''];
        return null;
    }

    /**
     * The subscription a delivery carries (contract §0.13): while an app's deliver route handles the
     * result of job $jobId, one new row it writes in its jobs table is taken as a follow-up job for
     * that job's requester (capture). Only the row's creation: a delivery that marks its own row done
     * or cancels another asks nothing.
     *
     * @return list<array{event: string, bindings: list<string>}>
     */
    public static function followUpSubscription(string $table, string $jobId): array
    {
        return [['event' => 'app.record.created.' . $table, 'bindings' => [self::BINDING_PREFIX . 'f-' . $jobId]]];
    }

    /**
     * Whether a row written while job $job (its app_ai_jobs row) is delivered is taken at all: the
     * job was asked for by a known member or visitor, and is not itself a follow-up that was refused
     * as it was written. The first such row is the job's follow-up; a second, or one written while a
     * follow-up is delivered, is refused and the app told (capture). Those refusals' own deliveries
     * ask for nothing, so however an app answers a delivery, the chain it starts is three jobs deep
     * and then over.
     */
    public static function deliveryMayAsk(array $job): bool
    {
        if (!in_array($job['requester_kind'] ?? null, ['user', 'visitor'], true)) return false;
        return ($job['follow_up_of'] ?? null) === null || ($job['status'] ?? null) !== 'refused';
    }

    /**
     * The request's subscriptions with App AI's binding added for the jobs table's
     * `app.record.created`, `.updated` and `.deleted` events (a job asked for, and a job cancelled:
     * contract §0.11): to a flow's entry for the same event when there is one (a second entry would
     * capture the write twice), or as a new entry. Null when the runner's limits (100 entries, 100
     * bindings an entry) leave no room: the request then runs without them and its jobs are not taken.
     */
    public static function withBinding(array $subscriptions, string $table, string $binding): ?array
    {
        foreach (['created', 'updated', 'deleted'] as $operation) {
            $event = 'app.record.' . $operation . '.' . $table;
            $joined = false;
            foreach ($subscriptions as $index => $subscription) {
                if (($subscription['event'] ?? null) !== $event) continue;
                $bindings = is_array($subscription['bindings'] ?? null) ? $subscription['bindings'] : [];
                if (count($bindings) >= 100) return null;
                $bindings[] = $binding;
                $subscriptions[$index]['bindings'] = $bindings;
                $joined = true;
                break;
            }
            if ($joined) continue;
            if (count($subscriptions) >= 100) return null;
            $subscriptions[] = ['event' => $event, 'bindings' => [$binding]];
        }
        return $subscriptions;
    }

    /**
     * A requester's waiting and running jobs: app job id → {status: queued|running, lane: picture|chat,
     * position?, waiting?} (contract §0.11). A waiting job's position counts the open jobs ahead of it
     * in its own lane (pictures and edits, or chats) on the same computer or the .env upstream, and
     * `waiting` says why it waits: `queue`, or `computer_offline` while the computer it waits for has
     * not been heard from in 90 seconds.
     */
    private function openJobs(string $appId, array $requester): array|object
    {
        $statement = $this->pdo()->prepare("SELECT app_job_id, kind, status, target, created_at FROM app_ai_jobs WHERE app_id = ? AND requester_kind = ? AND requester_id = ? AND status IN ('queued','sending','running') ORDER BY created_at LIMIT 10");
        $statement->execute([$appId, $requester['kind'], $requester['id']]);
        $jobs = [];
        $heard = [];
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $lane = $row['kind'] === 'chat' ? 'chat' : 'picture';
            if ($row['status'] !== 'queued') { $jobs[(string) $row['app_job_id']] = ['status' => 'running', 'lane' => $lane]; continue; }
            $kinds = $lane === 'chat' ? "('chat')" : "('picture','edit')";
            $ahead = $this->pdo()->prepare("SELECT COUNT(*) FROM app_ai_jobs WHERE target <=> ? AND kind IN {$kinds} AND status IN ('queued','sending','running') AND created_at < ?");
            $ahead->execute([$row['target'], $row['created_at']]);
            $target = (string) $row['target'];
            $heard[$target] ??= $target === 'env' || $this->heardFrom($target);
            $jobs[(string) $row['app_job_id']] = ['status' => 'queued', 'lane' => $lane, 'position' => (int) $ahead->fetchColumn() + 1, 'waiting' => $heard[$target] ? 'queue' : 'computer_offline'];
        }
        return $jobs === [] ? (object) [] : $jobs;
    }

    /** Whether the OAIY computer a job waits for (its connection id) has been heard from in the last 90 seconds. */
    private function heardFrom(string $connectionId): bool
    {
        $statement = $this->pdo()->prepare('SELECT 1 FROM desktop_connections WHERE id = ? AND last_seen_at > (NOW() - INTERVAL 90 SECOND)');
        $statement->execute([$connectionId]);
        return $statement->fetchColumn() !== false;
    }

    // ------------------------------------------------------------------ capture

    /**
     * Take the jobs one committed record event asks for. $bindings are the event's App AI bindings;
     * $readRow(table, column, value) reads a whole row from the app's database. Answers the number of
     * jobs taken (queued or refused), 0 when the event is not a job (already taken, or not the jobs
     * table). A jobs row updated to `status: cancelled`, or deleted, cancels its job instead (cancel()).
     * Throws only when MySQL cannot record it: the event is then left for the next dispatch.
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
        if ($app === null || $declared === null) return 0;
        $table = $declared['table'];
        // A row the app's deliver route wrote while it was handed a job's result (contract §0.13):
        // a follow-up job for whoever asked for that job, from the address they asked from.
        $followUpOf = null;
        $chained = false;
        if ($requester['kind'] === self::FOLLOW_UP) {
            if ($event !== 'app.record.created.' . $table) return 0;
            $delivered = $this->pdo()->prepare('SELECT id, status, requester_kind, requester_id, ip_key, follow_up_of FROM app_ai_jobs WHERE id = ? AND app_id = ?');
            $delivered->execute([$requester['job'], $appId]);
            $delivered = $delivered->fetch(PDO::FETCH_ASSOC);
            if (!is_array($delivered) || !self::deliveryMayAsk($delivered)) return 0;
            $followUpOf = (string) $delivered['id'];
            $chained = $delivered['follow_up_of'] !== null;
            $requester = ['kind' => (string) $delivered['requester_kind'], 'id' => (string) $delivered['requester_id'], 'ipKey' => (string) $delivered['ip_key']];
        }
        if ($event === 'app.record.updated.' . $table || $event === 'app.record.deleted.' . $table) {
            return $this->cancel($appId, $event === 'app.record.deleted.' . $table, $data, $readRow, $table);
        }
        if ($event !== 'app.record.created.' . $table) return 0;

        $key = $data['record']['id'] ?? null;
        $row = null;
        if ((is_string($key) || is_int($key)) && $readRow !== null) {
            try { $row = $readRow($declared['table'], 'id', $key); } catch (\Throwable) { $row = null; }
        }
        [$job, $refusal] = $this->jobFrom(is_array($row) ? $row : null, $key, $declared);
        // Nobody known asked (no FormLogic page marked the request): taken, and answered that it cannot run.
        if ($requester['kind'] === self::NOBODY) $refusal ??= ['code' => 'ai_unavailable', 'message' => self::REASONS['visitor_required']];
        // A chain ends by itself: the delivery of a follow-up asks for nothing more.
        if ($chained) $refusal ??= ['code' => 'limit_reached', 'message' => self::REASONS['follow_up_chained']];

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
            if ($refusal === null && $followUpOf !== null) {
                // One follow-up for a delivered job, whatever became of it: counted under the app's
                // lock, so two rows written by one delivery cannot both be taken.
                $asked = $pdo->prepare('SELECT 1 FROM app_ai_jobs WHERE follow_up_of = ? LIMIT 1');
                $asked->execute([$followUpOf]);
                if ($asked->fetchColumn() !== false) $refusal = ['code' => 'limit_reached', 'message' => self::REASONS['follow_up_taken']];
            }
            // A follow-up is its requester's own job: their allowance, their open jobs, their address.
            if ($refusal === null) $refusal = $this->admission($appId, $requester, $settings, $available, $site, (string) ($job['kind'] ?? ''), $day, $hour);
            $id = bin2hex(random_bytes(16));
            $status = $refusal === null ? 'queued' : 'refused';
            $pdo->prepare(
                'INSERT INTO app_ai_jobs (id, app_id, event_id, app_job_id, requester_kind, requester_id, ip_key, kind, status, source, target, prompt, prompt_sha256, size, seed, reference, max_output, follow_up_of, code, message, counted_day, counted_hour, next_attempt_at, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            )->execute([
                $id, $appId, $eventId, mb_substr((string) ($job['appJobId'] ?? (is_scalar($key) ? (string) $key : '')), 0, 100), $requester['kind'], $requester['id'], $requester['ipKey'],
                (string) ($job['kind'] ?? 'unknown'), $status, $status === 'queued' ? $available['source'] . '-' . ($available['target'] === 'env' ? 'env' : 'oaiy') : null,
                $status === 'queued' ? $available['target'] : null,
                $job['prompt'] ?? null, isset($job['prompt']) ? hash('sha256', (string) $job['prompt']) : null,
                $job['size'] ?? null, $job['seed'] ?? null, $job['reference'] ?? null, $job['maxOutput'] ?? null, $followUpOf,
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
     * An app's cancel (contract §0.11): its jobs row's `status` updated to `cancelled`, or the row
     * deleted, by a request that carries App AI's binding. A job not yet delivered is cancelled and its
     * use given back; what the AI is still doing for it is let go, and a result that comes back is
     * thrown away (AppAiWorker). A row updated to cancelled is told so once, `{jobId, status:
     * "cancelled"}`; a deleted row, nothing. A job already answered stands. Answers how many it cancelled.
     */
    private function cancel(string $appId, bool $deleted, array $data, ?callable $readRow, string $table): int
    {
        $record = is_array($data['record'] ?? null) ? $data['record'] : [];
        $key = $record['id'] ?? null;
        if (!is_string($key) && !is_int($key)) return 0;
        if (!$deleted) {
            // The event carries the row as written; a table whose preview leaves `status` out is read.
            $status = $record['status'] ?? null;
            if (!array_key_exists('status', $record) && $readRow !== null) {
                try { $row = $readRow($table, 'id', $key); } catch (\Throwable) { $row = null; }
                $status = is_array($row) ? ($row['status'] ?? null) : null;
            }
            if ($status !== 'cancelled') return 0;
        }
        $clock = $this->realClock ? microtime(true) : (float) ($this->now)();
        $marks = implode(',', array_fill(0, count(self::CANCELLABLE), '?'));
        $pdo = $this->pdo();
        $ids = [];
        $cancelled = 0;
        $pdo->beginTransaction();
        try {
            // Its open jobs, and any cancelled before whose use a failed refund has not yet given back
            // (this event is then dispatched again).
            $open = $pdo->prepare("SELECT id, status FROM app_ai_jobs WHERE app_id = ? AND app_job_id = ? AND requester_kind <> ? AND (status IN ({$marks}) OR (status = 'cancelled' AND refunded = 0)) FOR UPDATE");
            $open->execute([$appId, mb_substr((string) $key, 0, 100), self::TEST_REQUESTER, ...self::CANCELLABLE]);
            foreach ($open->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $ids[] = (string) $row['id'];
                if ($row['status'] === 'cancelled') continue;
                $pdo->prepare("UPDATE app_ai_jobs SET status = 'cancelled', code = 'cancelled', message = ?, finished_at = ?, next_attempt_at = ?, reference = NULL WHERE id = ?")
                    ->execute([$deleted ? 'The app deleted the job.' : 'The app cancelled the job.', self::stamp($clock), $deleted ? null : self::stamp($clock - 1), $row['id']]);
                $cancelled++;
            }
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
        foreach ($ids as $id) $this->refund($id);
        return $cancelled;
    }

    /**
     * How long a chat job's answer may be, in tokens: what its app asked for in its row's
     * `max_output` ($asked; null when it gave none), held to the administrator's ceiling ($site's
     * `chatMaxOutput`), which is also the answer when the app asked for nothing. Read as the job is
     * sent, so a ceiling lowered since applies.
     */
    public static function answerTokens(mixed $asked, array $site): int
    {
        $ceiling = (int) ($site['chatMaxOutput'] ?? AppAiSiteSettings::CHAT_MAX_OUTPUT_DEFAULT);
        return $asked === null ? $ceiling : max(1, min((int) $asked, $ceiling));
    }

    /** The characters FormLogic reads of an answer that may have $tokens tokens. */
    public static function answerCharacters(int $tokens): int
    {
        return min(self::MAX_ANSWER_CHARACTERS, max(1, $tokens) * self::ANSWER_CHARACTERS_PER_TOKEN);
    }

    /**
     * The code a job carries when the app's AI cannot take it, for $reason as REASONS names it:
     * `ai_off`, `ai_paused` (the site's pause, or the app's AI resting) or `ai_unavailable`.
     */
    public static function code(string $reason): string
    {
        return match ($reason) {
            'ai_off' => 'ai_off',
            'ai_paused', 'ai_resting' => 'ai_paused',
            default => 'ai_unavailable',
        };
    }

    /**
     * Why this job may not be queued now, or null. Called inside capture's transaction, with the
     * app's settings row locked: counts and queues read here cannot change under it.
     */
    private function admission(string $appId, array $requester, array $settings, array $available, array $site, string $kind, string $day, string $hour): ?array
    {
        if (!$available['enabled'] || !in_array($kind, $available['kinds'], true)) {
            $reason = $available['enabled'] ? 'not_offered' : (string) $available['reason'];
            return ['code' => self::code($reason), 'message' => self::REASONS[$reason] ?? self::REASONS['ai_off']];
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
            // How long the answer may be, in tokens, when the app says: a `max_output` column of its
            // jobs row. More than the site allows is held to what it allows as the job is sent.
            $maxOutput = $row['max_output'] ?? null;
            if ($maxOutput === '') $maxOutput = null;
            if (is_string($maxOutput) && preg_match('/^\d{1,9}$/D', $maxOutput)) $maxOutput = (int) $maxOutput;
            if (is_float($maxOutput) && floor($maxOutput) === $maxOutput && $maxOutput >= 1 && $maxOutput < 1e9) $maxOutput = (int) $maxOutput;
            if ($maxOutput !== null && (!is_int($maxOutput) || $maxOutput < 1)) return $bad('A chat job\'s max_output is a whole number of tokens, 1 or more.', ['kind' => $kind]);
            return [['appJobId' => $appJobId, 'kind' => $kind, 'prompt' => json_encode($clean, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR),
                'maxOutput' => $maxOutput === null ? null : min($maxOutput, AppAiSiteSettings::CHAT_MAX_OUTPUT[1])], null];
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
        'site_ai_gone' => 'The computer this site\'s AI runs on was unlinked or has a new key. An administrator can choose it again.',
        'model_unset' => 'No model is chosen for this kind of request yet.',
        'no_pictures' => 'This server cannot draw pictures for apps: it needs PHP\'s GD extension.',
        'not_offered' => 'This kind of AI request is not available for this app right now.',
        'visitor_required' => 'Open the app in your browser to use its AI.',
        'follow_up_taken' => 'One follow-up job may be asked for while a job\'s result is delivered, and this delivery has asked for its one.',
        'follow_up_chained' => 'A follow-up job\'s delivery cannot ask for another job.',
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
    /** The app a site test belongs to: none. The administrator's own test of the site's AI (queueSiteTest). */
    public const SITE_TEST = '';
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
            // Whether "Use this site's AI" would work for this app now, whatever it is set to, so its
            // owner is told why not before they choose it.
            'site' => $this->siteOffer($declared),
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
                    self::NOBODY => 'Unknown (not from the app\'s page)',
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

    /**
     * "Use this site's AI" as an app's owner would find it now, whatever the app is set to:
     * {offered, working, reason, kinds, missing}. `reason` says why it is not offered or would not
     * work (site_ai_closed, ai_paused, site_ai_gone, site_ai_unavailable, model_unset, no_pictures);
     * `missing` names what the app asks for that the site's AI cannot do yet (pictures with no picture
     * model chosen, say) and why.
     */
    private function siteOffer(?array $declared): array
    {
        $site = $this->site->current();
        $wanted = $declared['kinds'] ?? ['picture', 'chat'];
        $on = $this->onSite($wanted, $site);
        $reason = !$site['allowApps'] ? 'site_ai_closed' : ($site['paused'] ? 'ai_paused' : $on['reason']);
        $missing = $on['enabled'] ? array_values(array_diff($wanted, $on['kinds'])) : [];
        return [
            'offered' => (bool) $site['allowApps'],
            'working' => $reason === null,
            'reason' => $reason,
            'kinds' => $on['kinds'],
            'missing' => $missing === [] ? null : ['kinds' => $missing, 'reason' => AppAiPictures::available() ? 'model_unset' : 'no_pictures'],
        ];
    }

    /** When an OAIY computer was last heard from, and whether that was in the last 90 seconds. */
    private function computerSeen(string $connectionId): array
    {
        $statement = $this->pdo()->prepare('SELECT last_seen_at, last_seen_at > (NOW() - INTERVAL 90 SECOND) AS fresh FROM desktop_connections WHERE id = ?');
        $statement->execute([$connectionId]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        return ['online' => is_array($row) && (bool) $row['fresh'], 'lastSeenAt' => is_array($row) ? $row['last_seen_at'] : null];
    }

    /**
     * How the app's AI is doing now, in a sentence for its owner: {state, waiting, running, since,
     * offlineSince, message}. `offlineSince` is when its computer was last heard from, while offline.
     */
    private function status(string $appId, array $settings, array $available): array
    {
        $statement = $this->pdo()->prepare("SELECT SUM(status = 'queued') AS waiting, SUM(status IN ('sending','running')) AS running, MIN(CASE WHEN status = 'queued' THEN created_at END) AS since FROM app_ai_jobs WHERE app_id = ?");
        $statement->execute([$appId]);
        $row = $statement->fetch(PDO::FETCH_ASSOC) ?: [];
        $waiting = (int) ($row['waiting'] ?? 0);
        $running = (int) ($row['running'] ?? 0);
        $out = static fn(string $state, string $message, ?string $offlineSince = null) => ['state' => $state, 'waiting' => $waiting, 'running' => $running, 'since' => $row['since'] ?? null, 'offlineSince' => $offlineSince, 'message' => $message];
        if ($settings['mode'] === 'off') return $out('off', 'AI is off for this app: it is told so, and nothing is sent anywhere.');
        if ($settings['blocked']) return $out('blocked', 'The site\'s administrator has stopped this app\'s AI' . ($settings['blockedReason'] ? ': ' . $settings['blockedReason'] : '.'));
        if (!$available['enabled']) {
            $reason = (string) $available['reason'];
            if ($reason === 'ai_resting') return $out('paused', 'Its AI failed five times in a row, so it is resting until ' . gmdate('H:i', (int) strtotime((string) $settings['pausedUntil'] . ' UTC')) . ' UTC.');
            return $out($reason === 'ai_paused' ? 'paused' : 'off', self::REASONS[$reason] ?? self::REASONS['ai_off']);
        }
        if ($available['target'] !== 'env' && !$this->computerOnline($appId, $settings, $available)) {
            return $out('offline', 'The computer its AI runs on is offline. Requests wait for it, for up to 30 minutes.', $this->computerSeen((string) $available['target'])['lastSeenAt']);
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

    /** Why the administrator's test cannot start now, in their own words: it is no app's. */
    public const SITE_TEST_REFUSALS = [
        'site_ai_unavailable' => 'The site\'s AI is not set up yet. Choose where it runs first.',
        'site_ai_gone' => 'The computer the site\'s AI ran on was unlinked or has a new key. Choose a computer again first.',
        'model_unset' => 'No picture model is chosen yet. Choose one first.',
        'no_pictures' => 'This server cannot prepare pictures: it needs PHP\'s GD extension.',
    ];

    /**
     * Why the administrator's test failed, by the code its job ended with, where FormLogic is the one
     * to say (what the AI itself said is told as it said it). The test was let start, so each of the
     * first four is something that changed while it waited, and says which.
     */
    public const SITE_TEST_FAILURES = [
        'site_ai_unavailable' => 'The site\'s AI was switched off or changed while the test waited. Set it up again, then test.',
        'site_ai_gone' => 'The computer the site\'s AI runs on was unlinked, or got a new key, while the test waited. Choose a computer again, then test.',
        'model_unset' => 'The picture model was cleared while the test waited. Choose one, then test.',
        'no_pictures' => 'This server cannot prepare pictures: it needs PHP\'s GD extension.',
        'expired' => 'Nothing took the test in half an hour. Check that the AI worker runs and the computer is on, then test again.',
        'worker_outdated' => 'The AI worker that took the test was started before the last update, and does not know how to run it. Restart the AI worker, then test again.',
    ];

    /** What the administrator can try when the AI itself failed their test, after what it said. */
    public const SITE_TEST_ADVICE = [
        'model_disabled' => 'Turn the model on in OAIY (Engines) and check its files have downloaded, or choose another picture model.',
        'model_unknown' => 'The AI has no model by this name. Choose one from its list.',
        'timeout' => 'Check that the computer is on and OAIY is running, then test again.',
        'engine_failed' => 'Look at OAIY on the computer for why, then test again.',
        'busy' => 'The AI was busy with other work each time it was asked. Test again in a moment.',
    ];

    /**
     * An administrator's test's failure as they are told it: {code, message, advice}. $code and
     * $message are the job's own. `message` is FormLogic's own sentence where it is the one to say
     * (SITE_TEST_FAILURES), else what the AI said; `advice` is what to try, or ''.
     *
     * A job's coarse codes for an app whose AI cannot take it (`ai_unavailable`, `ai_off`,
     * `ai_paused`) are never a site test's from this code: only a worker running older code, which
     * does not know a test that is no app's, ends one so (`worker_outdated`). What it wrote ("AI is
     * turned off for this app") is never passed on: there is no app.
     *
     * @return array{code: string, message: string, advice: string}
     */
    public static function siteTestFailure(?string $code, ?string $message): array
    {
        $code = (string) $code;
        if (in_array($code, ['ai_unavailable', 'ai_off', 'ai_paused'], true)) $code = 'worker_outdated';
        if (isset(self::SITE_TEST_FAILURES[$code])) return ['code' => $code, 'message' => self::SITE_TEST_FAILURES[$code], 'advice' => ''];
        return [
            'code' => $code !== '' ? $code : 'engine_failed',
            'message' => $message !== null && trim($message) !== '' ? $message : 'The AI gave no reason.',
            'advice' => self::SITE_TEST_ADVICE[$code] ?? '',
        ];
    }

    /**
     * Queue the administrator's own test of the site's AI (the setup checklist's "Make a test
     * picture"): the same small picture or five-word chat as an owner's test, sent where apps'
     * requests on the site's AI go, by the same worker, and kept for the administrator to see. It
     * belongs to no app (SITE_TEST), needs no app to be allowed yet, and counts against no
     * allowance; one at a time.
     */
    public function queueSiteTest(string $adminId, string $kind): string
    {
        $kind = $kind === 'chat' ? 'chat' : 'picture';
        $available = $this->siteTestAvailability();
        if (!$available['enabled']) throw new \RuntimeException(self::SITE_TEST_REFUSALS[$available['reason']] ?? self::SITE_TEST_REFUSALS['site_ai_unavailable']);
        if (!in_array($kind, $available['kinds'], true)) throw new \RuntimeException(self::SITE_TEST_REFUSALS[AppAiPictures::available() ? 'model_unset' : 'no_pictures']);
        $pdo = $this->pdo();
        // One at a time, whoever asks: no row of its own to lock, so a named lock.
        $lock = $pdo->prepare('SELECT GET_LOCK(?, 5)');
        $lock->execute(['formlogic:app-ai-site-test']);
        if ((int) $lock->fetchColumn() !== 1) throw new \RuntimeException('A test is already running. Wait for it to finish.');
        try {
            $open = $pdo->prepare("SELECT COUNT(*) FROM app_ai_jobs WHERE app_id IS NULL AND requester_kind = ? AND status IN ('queued','sending','running')");
            $open->execute([self::TEST_REQUESTER]);
            if ((int) $open->fetchColumn() > 0) throw new \RuntimeException('A test is already running. Wait for it to finish.');
            $id = bin2hex(random_bytes(16));
            $prompt = $kind === 'chat' ? json_encode(self::TEST_CHAT, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) : self::TEST_PICTURE;
            $pdo->prepare(
                'INSERT INTO app_ai_jobs (id, app_id, event_id, app_job_id, requester_kind, requester_id, ip_key, kind, status, source, target, prompt, prompt_sha256, size, created_at)
                 VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            )->execute([
                $id, bin2hex(random_bytes(16)), 'site-test-' . substr($id, 0, 8), self::TEST_REQUESTER, mb_substr($adminId, 0, 64), self::TEST_IP_KEY,
                $kind, 'queued', 'site-' . ($available['target'] === 'env' ? 'env' : 'oaiy'), $available['target'],
                $prompt, hash('sha256', $prompt), $kind === 'chat' ? null : '512x512', self::stamp($this->realClock ? microtime(true) : ($this->now)()),
            ]);
            return $id;
        } finally {
            $pdo->prepare('SELECT RELEASE_LOCK(?)')->execute(['formlogic:app-ai-site-test']);
        }
    }

    /**
     * How a test is getting on: {status: queued|running|done|failed, picture?, text?, model, seed,
     * seconds, waitedSeconds?, code?, message?}, or null when $jobId is not a test of this app
     * (SITE_TEST: of the site's own). $results is where the worker keeps results (AppAiWorker).
     * A failed site test's code and message are the administrator's own, with `advice`
     * (siteTestFailure): it is no app's, and is never told as one.
     */
    public function testResult(string $appId, string $jobId, string $results): ?array
    {
        if (!preg_match('/^[a-f0-9]{32}$/D', $jobId)) return null;
        // A site test (the administrator's) belongs to no app.
        $statement = $this->pdo()->prepare('SELECT * FROM app_ai_jobs WHERE id = ? AND ' . ($appId === self::SITE_TEST ? 'app_id IS NULL' : 'app_id = ?') . ' AND requester_kind = ?');
        $statement->execute($appId === self::SITE_TEST ? [$jobId, self::TEST_REQUESTER] : [$jobId, $appId, self::TEST_REQUESTER]);
        $job = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($job)) return null;
        $seconds = $job['started_at'] !== null && $job['finished_at'] !== null ? round(max(0.0, self::seconds((string) $job['finished_at']) - self::seconds((string) $job['started_at'])), 1) : null;
        // While it waits: for how long, so whoever watches can be told what it is waiting for.
        $waited = (int) max(0, floor(($this->realClock ? microtime(true) : (float) ($this->now)()) - self::seconds((string) $job['created_at'])));
        if (in_array($job['status'], ['queued', 'sending'], true)) return ['status' => 'queued', 'waitedSeconds' => $waited];
        if ($job['status'] === 'running') return ['status' => 'running', 'waitedSeconds' => $waited];
        if ($job['status'] === 'done') {
            $result = $job['result_path'] !== null ? json_decode((string) @file_get_contents($results . '/' . basename((string) $job['result_path'])), true) : null;
            if (!is_array($result)) {
                return ['status' => 'failed', 'code' => 'expired', 'message' => 'This test\'s result is no longer kept. Run it again.', 'seconds' => $seconds]
                    + ($appId === self::SITE_TEST ? ['advice' => ''] : []);
            }
            return ['status' => 'done', 'seconds' => $seconds] + array_intersect_key($result, array_flip(['picture', 'text', 'model', 'seed', 'mimeType', 'width', 'height']));
        }
        // The administrator's test is no app's: its failure is told in their own words, never an app's.
        if ($appId === self::SITE_TEST) return ['status' => 'failed', 'seconds' => $seconds] + self::siteTestFailure($job['code'], $job['message']);
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

    /**
     * What the administrator's setup checklist shows (AppAiController::adminView): where the site's
     * AI runs now, and what apps on it would get.
     *
     * - `source`: `computer` (one is chosen and stands), `gone` (the one chosen was unlinked or given
     *   a new key: nothing takes its place), `env` (none chosen, and the server's settings name a
     *   provider), or `none`.
     * - `computer`: the chosen one, {connectionId, deviceName, providerId, online, lastSeenAt};
     *   `gone`: {deviceName} of the one that went.
     * - `provider`: the server's own: {named, on}: named in its settings, and the Site AI switch,
     *   without which it is never used.
     * - `drawing`: this server can redraw the pictures that come back (PHP's GD).
     * - `kinds`: what the site's AI takes now (picture, chat), and `reason` when it takes nothing.
     * - `ready`: apps can make pictures now: allowed, not paused, and `kinds` has picture.
     * - `lastTest`: the administrator's last finished test picture (lastSiteTest), or null.
     */
    public function adminSetup(): array
    {
        $site = $this->site->current();
        $source = $this->siteSource();
        $named = $this->ai !== null && $this->ai->envProvided();
        $computer = $source['computer'];
        $gone = $source['kind'] === 'gone' ? $this->siteDesktop?->gone() : null;
        $on = $this->onSite(['picture', 'chat'], $site);
        return [
            'source' => $source['kind'] === 'none' && $named ? 'env' : $source['kind'],
            'computer' => $computer === null ? null : [
                'connectionId' => (string) $computer['connectionId'],
                'deviceName' => (string) ($computer['deviceName'] ?? ''),
                'providerId' => (string) $computer['providerId'],
            ] + $this->computerSeen((string) $computer['connectionId']),
            'gone' => $gone === null ? null : ['deviceName' => (string) ($gone['deviceName'] ?? '')],
            'provider' => ['named' => $named, 'on' => $this->ai !== null && $this->ai->siteAiSwitch()],
            'drawing' => AppAiPictures::available(),
            'kinds' => $on['kinds'],
            'reason' => $on['reason'],
            'ready' => $site['allowApps'] && !$site['paused'] && in_array('picture', $on['kinds'], true),
            'lastTest' => $this->lastSiteTest($on, $site),
        ];
    }

    /**
     * The administrator's last finished test picture, so the checklist still says how it went after
     * the page is opened again: {status: done|failed, at, seconds, model, code, message, current}.
     * `current` when it ran where the site's AI runs now ($on), with the picture model chosen now:
     * a test from before either changed proves nothing about now. Null when none is kept.
     */
    private function lastSiteTest(array $on, array $site): ?array
    {
        $statement = $this->pdo()->prepare(
            "SELECT status, code, message, model, target, started_at, finished_at FROM app_ai_jobs
             WHERE app_id IS NULL AND requester_kind = ? AND kind = 'picture' AND status IN ('done', 'failed') AND finished_at IS NOT NULL
             ORDER BY finished_at DESC, created_at DESC LIMIT 1"
        );
        $statement->execute([self::TEST_REQUESTER]);
        $job = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($job)) return null;
        $failure = $job['status'] === 'failed' ? self::siteTestFailure($job['code'], $job['message']) : ['code' => null, 'message' => null];
        return [
            'status' => (string) $job['status'],
            'at' => substr((string) $job['finished_at'], 0, 19),
            'seconds' => $job['started_at'] !== null ? round(max(0.0, self::seconds((string) $job['finished_at']) - self::seconds((string) $job['started_at'])), 1) : null,
            'model' => $job['model'],
            'code' => $failure['code'],
            'message' => $failure['message'],
            'current' => $on['target'] !== null && $job['target'] === $on['target'] && $job['model'] !== null && $job['model'] === $site['pictureModel'],
        ];
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
