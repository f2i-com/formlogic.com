<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Support\DataEncryption;
use PDO;
use Psr\Log\LoggerInterface;

/**
 * App AI's worker (bin/app-ai-worker.php). It takes the jobs AppAiService queued, sends each to the AI
 * it goes to, reads what comes back, redraws it (AppAiPictures), and delivers it to the app's own
 * /api/site/ route.
 *
 * One pass (`tick`) runs these steps, as often as the script calls it:
 * 1. **Expire.** A job queued for 30 minutes is told it ran out, and its use is given back.
 * 2. **Catch up.** The record events of apps with AI on are dispatched. A job that a request's own
 *    dispatch left behind (another process held the app's events lock) is picked up within seconds.
 * 3. **Send, fairly.** On each computer (or the .env upstream), the app served least recently goes
 *    first, then within it the requester served least recently, then the oldest job. Each pass looks
 *    at each app's oldest few jobs, so no app's backlog hides another's. A computer takes one picture
 *    at a time and one App AI chat beside it (DesktopAiRelayService's lanes), so a picture never
 *    holds up a chat. A computer that is offline, or busy with members' chats, keeps its jobs
 *    waiting, and is asked again a few seconds later.
 * 4. **Collect, without waiting.** The worker reads OAIY's frames (SiteDesktopAi::collect, the path
 *    camera checks use) or the .env upstream's answers (AppAiUpstream). The turn's key is kept in the
 *    job's row, sealed with the site's data key where one is set, so a restarted worker carries on
 *    reading. The relay decides when an OAIY job is lost: a turn nobody claims in 5 minutes, or one
 *    silent for 5 minutes (OAIY's progress frames keep a picture alive while it is drawn).
 * 5. **Deliver** what is ready, as the site, to the app's deliver route. An app that is busy is asked
 *    again later, for about half an hour.
 *
 * A job that never reached the AI, or whose result was lost, is sent once more. A job that failed after
 * the AI took it is not resent, and its use is given back; so is one a worker died while sending,
 * which is failed rather than sent again. Five failures of the AI in a row rest an app's AI for ten
 * minutes. A test (AppAiService::queueTest) runs like any job, but its result is kept for the owner
 * and never delivered to the app.
 */
final class AppAiWorker
{
    /** However an OAIY job is doing, it is ended this long after it was sent (the relay ends one sooner). */
    public const RUNNING_BACKSTOP = 900;
    /** A job left waiting this long is told it ran out of time. */
    public const QUEUED_EXPIRY = 1800;
    /** Sends a job may have: once, and once more when it never reached the AI or its result was lost. */
    public const MAX_ATTEMPTS = 2;
    /** Sends a job may have when the AI answers `busy` (its own queue full): 30 seconds apart. */
    public const BUSY_ATTEMPTS = 4;
    /** Seconds before each further delivery try: about half an hour in all. */
    public const DELIVERY_BACKOFF = [5, 15, 60, 300, 600, 900];
    /** Tries for a delivery the app answers with something other than busy. */
    public const DELIVERY_REFUSALS = 3;
    public const BREAKER_FAILURES = 5;
    public const BREAKER_PAUSE = 600;
    /** The .env upstream takes this many App AI pictures and chats at once. */
    public const ENV_PICTURES = 1;
    public const ENV_CHATS = 2;
    /** An OAIY computer takes one App AI chat beside its one picture. */
    public const COMPUTER_CHATS = 1;
    /** How many of each app's waiting jobs of one kind a pass looks at: its oldest (send). */
    public const PER_APP_KIND = 3;
    /** How long a job waits before its computer is asked again, after it said it was busy, or was offline. */
    public const BUSY_RETRY = 5;
    public const OFFLINE_RETRY = 15;
    /**
     * How long a job may stay claimed for sending before it is taken to be a dead worker's: a send
     * takes seconds (an edit's picture is redrawn, at most 16 megapixels, then queued).
     */
    public const SENDING_STALE = 120;
    /** The most text read of a picture's turn, which has none (SiteDesktopAi::collect): past it, the turn is no picture. */
    public const PICTURE_TEXT_LIMIT = 65536;
    /** An edit's picture is never squeezed below this to fit the lane: the request is refused instead. */
    private const MIN_REFERENCE_BYTES = 16000;
    private const CATCH_UP_SECONDS = 5;
    private const SEAL_CONTEXT = 'app-ai-channel:';
    /** Codes that count against an app's breaker: the AI itself failing, not the request. */
    private const BREAKER_CODES = ['engine_failed', 'timeout', 'model_disabled', 'model_unknown'];
    /** The codes a job can end with, as the app is told them. */
    private const CODES = ['model_disabled', 'model_unknown', 'busy', 'bad_request', 'too_large', 'engine_failed', 'timeout'];

    /** A worker that has made no pass for this long is not running: cron starts one every minute. */
    public const QUIET_SECONDS = 120;

    private float $lastCatchUp = 0.0;
    private int $passes = 0;
    /** The log has been told this run that the site's data key is set and cannot be used (once, not for every job). */
    private bool $keyUnusableSaid = false;
    /** @var array{fingerprint: string, mode: string, startedAt: int}|null what this worker says of itself (identify) */
    private ?array $identity = null;

    public function __construct(
        private MySQLConnection $mysql,
        private AppAiService $ai,
        private AppAiSiteSettings $site,
        private NativeAppService $native,
        private NativeRecordEventRouter $records,
        private ?SiteDesktopAi $desktop,
        private ?SiteAiDesktopSettings $computers,
        private AppAiUpstream $env,
        private string $results,
        private ?DataEncryption $encryption = null,
        private ?LoggerInterface $logger = null,
    ) {
    }

    /** The worker as bin/app-ai-worker.php runs it, wired as the web container wires its parts. */
    public static function standalone(MySQLConnection $mysql): self
    {
        $native = new NativeAppService();
        $computers = new SiteAiDesktopSettings($mysql);
        $desktop = new SiteDesktopAi(new DesktopAiRelayService($mysql), $computers);
        $site = new AIService();
        $site->useSiteDesktop($desktop);
        $ai = AppAiService::standalone($mysql, $native);
        return new self(
            $mysql, $ai, new AppAiSiteSettings(), $native, new NativeRecordEventRouter(new FlowService($mysql), $ai),
            $desktop, $computers, new AppAiUpstream(static fn(): ?array => $site->envUpstream()), self::resultsPath(), DataEncryption::fromEnvironment(),
        );
    }

    /** Where results wait for delivery (and a test's for its owner): never in reach of the web. */
    public static function resultsPath(): string
    {
        return dirname(__DIR__, 2) . '/storage/app-ai/results';
    }

    /**
     * Seconds since a worker last made a pass on this server (it touches a file in $results), or null
     * when none ever has: the administrator is warned when apps' jobs wait and none runs.
     */
    public static function idleSeconds(string $results): ?int
    {
        return self::heartbeat($results)['idleSeconds'] ?? null;
    }

    /**
     * What this worker says of itself in its heartbeat: the code it loaded (CodeFingerprint, read as
     * the process started) and how it runs, `watch` or `cron`. bin/app-ai-worker.php says it.
     */
    public function identify(string $fingerprint, string $mode): void
    {
        $this->identity = ['fingerprint' => $fingerprint, 'mode' => $mode === 'watch' ? 'watch' : 'cron', 'startedAt' => time()];
    }

    /**
     * The worker's heartbeat on this server: {idleSeconds, fingerprint, mode}, or null when none has
     * ever run. The file's time is the last pass; it holds what the worker said of itself (identify).
     * A worker from before heartbeats said anything left an empty file: its fingerprint and mode are null.
     */
    public static function heartbeat(string $results): ?array
    {
        $file = $results . '/.alive';
        clearstatcache(true, $file);
        $alive = @filemtime($file);
        if ($alive === false) return null;
        $said = json_decode((string) @file_get_contents($file), true);
        $said = is_array($said) ? $said : [];
        return [
            'idleSeconds' => max(0, time() - $alive),
            'fingerprint' => is_string($said['fingerprint'] ?? null) && $said['fingerprint'] !== '' ? $said['fingerprint'] : null,
            'mode' => in_array($said['mode'] ?? null, ['watch', 'cron'], true) ? $said['mode'] : null,
        ];
    }

    /**
     * Whether a worker runs on this server, and runs the code that is here now ($code,
     * CodeFingerprint::onDisk()): {state: ok|stale|missing, idleSeconds, mode}.
     *
     * - `missing`: none has ever run, or none has made a pass for QUIET_SECONDS.
     * - `stale`: one runs that was started before the code was last updated, so it does not know what
     *   the web now asks of it: a --watch worker nobody restarted, or one from before workers said
     *   what they run. A cron run notices the update, ends within seconds, and the next is fresh, so
     *   one whose code differs is not stale.
     */
    public static function state(string $results, string $code): array
    {
        $beat = self::heartbeat($results);
        if ($beat === null || $beat['idleSeconds'] > self::QUIET_SECONDS) {
            return ['state' => 'missing', 'idleSeconds' => $beat['idleSeconds'] ?? null, 'mode' => $beat['mode'] ?? null];
        }
        $stale = $beat['fingerprint'] === null || ($beat['fingerprint'] !== $code && $beat['mode'] !== 'cron');
        return ['state' => $stale ? 'stale' : 'ok', 'idleSeconds' => $beat['idleSeconds'], 'mode' => $beat['mode']];
    }

    /** One pass. $takeNew false finishes what is in flight and sends nothing new. Answers what it did, for the log. */
    public function tick(bool $takeNew = true): array
    {
        $this->passes++;
        if ($this->passes % 10 === 1) $this->beat();
        return [
            'expired' => $this->expire(),
            'cancelled' => $this->cancelled(),
            'caughtUp' => $takeNew ? $this->catchUp() : 0,
            'sent' => $takeNew ? $this->send() : 0,
            'collected' => $this->collect(),
            'delivered' => $this->deliver(),
        ];
    }

    /**
     * The heartbeat: a file in the results folder whose time is this worker's last pass. The first
     * pass writes what the worker said of itself (identify) into it, whole; later ones touch it.
     */
    private function beat(): void
    {
        if (!is_dir($this->results) && !@mkdir($this->results, 0700, true)) return;
        $file = $this->results . '/.alive';
        if ($this->passes === 1) {
            $said = (string) json_encode($this->identity ?? new \stdClass());
            $draft = $file . '.' . bin2hex(random_bytes(4));
            // Put in place whole, so a reader never finds half of it; written over where that is refused.
            if (@file_put_contents($draft, $said) !== false && @rename($draft, $file)) return;
            @unlink($draft);
            if (@file_put_contents($file, $said) !== false) return;
        }
        @touch($file);
    }

    /** Whether anything this process started on the .env upstream is still in flight (the script waits for it). */
    public function busy(): bool
    {
        return $this->env->count() > 0;
    }

    // ------------------------------------------------------------------ 1. expire

    private function expire(): int
    {
        $pdo = $this->pdo();
        $stale = $pdo->prepare("SELECT id FROM app_ai_jobs WHERE status = 'queued' AND created_at < ?");
        $stale->execute([AppAiService::stamp(time() - self::QUEUED_EXPIRY)]);
        $count = 0;
        foreach ($stale->fetchAll(PDO::FETCH_COLUMN) as $id) {
            $this->fail((string) $id, 'expired', 'The AI was too busy to get to this in time. Try again.');
            $count++;
        }
        // A pass sends what it claims within seconds, so a job claimed for sending longer ago than
        // SENDING_STALE was being sent when its worker died. It may be what killed it (a picture it
        // could not hold), and sent again it would kill this worker too, and every one after: it fails
        // instead, as FormLogic's own failure, and its use is given back. It does not count against its
        // app's AI, which never saw it. Only one so old: a second worker running beside this one (a
        // cron run and a `--watch` worker whose lock fell back to another folder) is sending its own.
        $stale = AppAiService::stamp(microtime(true) - self::SENDING_STALE);
        $left = $pdo->prepare("SELECT id FROM app_ai_jobs WHERE status = 'sending' AND (next_attempt_at IS NULL OR next_attempt_at < ?)");
        $left->execute([$stale]);
        foreach ($left->fetchAll(PDO::FETCH_COLUMN) as $id) {
            $this->logger?->warning('App AI: job ' . $id . ' was being sent when its worker stopped; it fails rather than being sent again');
            $this->fail((string) $id, 'engine_failed', 'FormLogic stopped while it was sending this, so it was not sent. Try again.');
            $count++;
        }
        // One the app cancelled while a worker that then died was sending it never reached the AI either.
        $gone = $pdo->prepare('SELECT id FROM app_ai_jobs WHERE status = ? AND code = ? AND started_at IS NULL AND refunded = 0 AND finished_at < ?');
        $gone->execute(['cancelled', AppAiService::CANCELLED_SENT, $stale]);
        foreach ($gone->fetchAll(PDO::FETCH_COLUMN) as $id) $this->ai->unsent((string) $id);
        // What is kept no longer than it is needed, about once an hour whoever runs the worker (the
        // nightly bin/privacy-sweep.php does the same).
        $marker = $this->results . '/.swept';
        if ((int) @filemtime($marker) < time() - 3600) {
            try {
                $this->ai->sweep($this->results);
                if (is_dir($this->results) || @mkdir($this->results, 0700, true)) @touch($marker);
            } catch (\Throwable $e) {
                $this->logger?->warning('App AI: the sweep failed: ' . $e->getMessage());
            }
        }
        return $count;
    }

    // ------------------------------------------------------------------ 1b. cancelled

    /**
     * Jobs the app cancelled once they were sent or back (AppAiService::cancel): what the AI is still
     * asked is cancelled (a request not yet taken is withdrawn; one being drawn or written frees its
     * place now, and its computer is answered `cancelled` on its next frame and stops: contract
     * §0.13), and a result already back is thrown away.
     */
    private function cancelled(): int
    {
        $count = 0;
        foreach ($this->env->ids() as $id) {
            $job = $this->job($id);
            if ($job !== null && $job['status'] === 'cancelled') { $this->env->abandon($id); $count++; }
        }
        $rows = $this->pdo()->query("SELECT * FROM app_ai_jobs WHERE status = 'cancelled' AND (relay_id IS NOT NULL OR result_path IS NOT NULL OR channel IS NOT NULL)")->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as $job) {
            // Whatever the computer is doing for it: one drawing it is told so on its next frame, and stops.
            // One no computer had taken yet (it waited on the lane) asked the AI nothing: its use is given back.
            if ($job['relay_id'] !== null && $this->desktop?->cancelTurn((string) $job['relay_id'], (string) $job['relay_owner']) === 'pending' && $job['code'] === AppAiService::CANCELLED_SENT) {
                $this->ai->untaken((string) $job['id']);
            }
            $this->removeResult($job);
            $this->pdo()->prepare('UPDATE app_ai_jobs SET relay_id = NULL, relay_owner = NULL, channel = NULL, result_path = NULL WHERE id = ?')->execute([$job['id']]);
            $count++;
        }
        return $count;
    }

    /** A moment ago, as MySQL's clock reads it: due now, whatever the two clocks' milliseconds. */
    private static function due(): string
    {
        return AppAiService::stamp(microtime(true) - 1);
    }

    // ------------------------------------------------------------------ 2. catch up

    private function catchUp(): int
    {
        if (microtime(true) - $this->lastCatchUp < self::CATCH_UP_SECONDS) return 0;
        $this->lastCatchUp = microtime(true);
        $count = 0;
        // Every app with AI settings, its AI on or off: a job written while it is off is answered too.
        foreach ($this->pdo()->query('SELECT app_id FROM app_ai_settings')->fetchAll(PDO::FETCH_COLUMN) as $appId) {
            try {
                $count += $this->native->dispatchRecordEvents((string) $appId, $this->records->for((string) $appId));
            } catch (\Throwable $e) {
                $this->logger?->warning('App AI: record events still pending for app ' . $appId . ': ' . $e->getMessage());
            }
        }
        return $count;
    }

    // ------------------------------------------------------------------ 3. send

    private function send(): int
    {
        // What routes and orders the jobs, never their prompts or pictures (an edit's is up to 2 MB,
        // and sendOne reads it for the one job it sends). The oldest few of each app's kind, not the
        // oldest of the whole site: jobs waiting on one owner's computer that is off can fill any
        // window by age, and every other app would wait behind them. A requester holds at most
        // MAX_OPEN_PER_REQUESTER jobs, so PER_APP_KIND of them always include another requester's
        // when there is one, for the fair turns below.
        $perKind = self::PER_APP_KIND;
        $rows = $this->pdo()->query(
            "SELECT j.id, j.app_id, j.kind, j.requester_kind, j.requester_id, j.size, j.seed, j.max_output, j.attempts, j.created_at, s.last_served_at
             FROM (
                 SELECT id, app_id, kind, requester_kind, requester_id, size, seed, max_output, attempts, created_at,
                        ROW_NUMBER() OVER (PARTITION BY app_id, kind ORDER BY created_at, id) AS queue_place
                 FROM app_ai_jobs
                 WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= UTC_TIMESTAMP(3))
             ) j
             LEFT JOIN app_ai_settings s ON s.app_id = j.app_id
             WHERE j.queue_place <= {$perKind}
             ORDER BY j.created_at LIMIT 2000"
        )->fetchAll(PDO::FETCH_ASSOC);
        if ($rows === []) return 0;

        // Where each app's AI goes now: a job goes where its app's AI goes when it is sent.
        $where = [];
        $groups = [];
        foreach ($rows as $job) {
            // A site test belongs to no app (AppAiService::SITE_TEST): its app id reads as ''.
            $appId = (string) $job['app_id'];
            $job['app_id'] = $appId;
            if (!array_key_exists($appId, $where)) $where[$appId] = $this->route($appId);
            $route = $where[$appId];
            if ($route === null) {
                $this->fail((string) $job['id'], 'ai_unavailable', AppAiService::REASONS['ai_off']);
                continue;
            }
            // The app's AI cannot take it now (turned off, paused, or its computer unlinked or given a new
            // key since it was asked for): answered at once with the code, and its use given back.
            if (!$route['availability']['enabled'] || !in_array($job['kind'], $route['availability']['kinds'], true)) {
                if ($appId === AppAiService::SITE_TEST) {
                    // The administrator's test is no app's: it keeps the reason itself, which says what
                    // changed while it waited, and is told in the administrator's own words.
                    $reason = $route['availability']['enabled'] ? (AppAiPictures::available() ? 'model_unset' : 'no_pictures') : (string) $route['availability']['reason'];
                    $this->fail((string) $job['id'], $reason, AppAiService::siteTestFailure($reason, null)['message']);
                    continue;
                }
                $reason = $route['availability']['enabled'] ? 'not_offered' : (string) $route['availability']['reason'];
                $this->fail((string) $job['id'], AppAiService::code($reason), AppAiService::REASONS[$reason] ?? AppAiService::REASONS['not_offered']);
                continue;
            }
            $groups[$route['key'] . '|' . ($job['kind'] === 'chat' ? 'chat' : 'picture')][] = $job + ['_route' => $route];
        }

        // Fair turns: the app served least recently, then within it the requester served least
        // recently, then the oldest job. Each send moves its app and requester to the back.
        $served = $this->requestersServed(array_keys($where));
        $appServed = [];
        $order = static function (array $a, array $b) use (&$served, &$appServed): int {
            $key = static fn(array $job): array => [
                $appServed[$job['app_id']] ?? (string) $job['last_served_at'],
                $served[$job['app_id'] . '|' . $job['requester_kind'] . '|' . $job['requester_id']] ?? '',
                (string) $job['created_at'],
            ];
            return $key($a) <=> $key($b);
        };
        $sent = 0;
        foreach ($groups as $group => $jobs) {
            [, $lane] = explode('|', $group, 2);
            $room = $this->room($jobs[0]['_route'], $lane);
            while ($room > 0 && $jobs !== []) {
                usort($jobs, $order);
                $job = array_shift($jobs);
                $outcome = $this->sendOne($job, $job['_route']);
                if ($outcome === 'sent') {
                    $sent++;
                    $room--;
                    $now = AppAiService::stamp(microtime(true));
                    $served[$job['app_id'] . '|' . $job['requester_kind'] . '|' . $job['requester_id']] = $now;
                    $appServed[$job['app_id']] = $now;
                } elseif ($outcome === 'wait') {
                    break;
                }
            }
        }
        return $sent;
    }

    /**
     * Where an app's AI goes now: {key, kind: oaiy|env|off, target (the computer, for OAIY),
     * availability, ownerId, pictureModel, chatModel}, or null when the app is gone or declares no AI.
     */
    private function route(string $appId): ?array
    {
        // The administrator's own test of the site's AI: no app's, so no app's settings or switches.
        if ($appId === AppAiService::SITE_TEST) return $this->siteRoute($this->ai->siteTestAvailability(), null);
        $statement = $this->pdo()->prepare('SELECT id, owner_id AS ownerId, status FROM apps WHERE id = ?');
        $statement->execute([$appId]);
        $app = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($app)) return null;
        $declared = AppFormlogicManifest::ai($this->native->installedManifest($appId));
        if ($declared === null) return null;
        $settings = $this->ai->settings($appId);
        $availability = $this->ai->availability($app, $declared, $settings);
        if ($availability['enabled'] && $availability['source'] === 'own') {
            $own = $settings['own'];
            $target = [
                'ownerUserId' => (string) $app['ownerId'], 'connectionId' => $own['connectionId'], 'instanceId' => $own['instanceId'],
                'publicKey' => $own['publicKey'], 'providerId' => $own['providerId'] !== '' ? $own['providerId'] : SiteDesktopAi::PROVIDER,
            ];
            return ['key' => 'computer:' . $own['connectionId'], 'kind' => 'oaiy', 'target' => $target, 'pictureModel' => $own['pictureModel'], 'chatModel' => $own['chatModel'],
                'availability' => $availability, 'ownerId' => (string) $app['ownerId']];
        }
        return $this->siteRoute($availability, (string) $app['ownerId']);
    }

    /**
     * The site's AI as a route, for $availability (an app's on it, or a site test's): its .env
     * upstream, or the administrator's chosen computer. $ownerId is who its requests are queued as
     * on a computer: the app's owner, or for a site test (null) the computer's own administrator.
     */
    private function siteRoute(array $availability, ?string $ownerId): array
    {
        $site = $this->site->current();
        $off = ['key' => 'off', 'kind' => 'off', 'target' => null, 'pictureModel' => null, 'chatModel' => null];
        $base = ['availability' => $availability, 'ownerId' => (string) $ownerId];
        if (!$availability['enabled']) return $off + $base;
        if ($availability['target'] === 'env') {
            // The site's AI is its .env upstream, yet this worker has none to ask: nothing can take the job.
            if (!$this->env->configured()) return $off + ['availability' => ['enabled' => false, 'reason' => 'site_ai_unavailable'] + $availability] + $base;
            return ['key' => 'env', 'kind' => 'env', 'target' => null, 'pictureModel' => $site['pictureModel'], 'chatModel' => $site['chatModel']] + $base;
        }
        $computer = $this->computers?->current();
        if ($computer === null) {
            return $off + ['availability' => ['enabled' => false, 'reason' => 'site_ai_unavailable'] + $availability] + $base;
        }
        return ['key' => 'computer:' . $computer['connectionId'], 'kind' => 'oaiy', 'target' => $computer, 'pictureModel' => $site['pictureModel'], 'chatModel' => $site['chatModel'] ?? $computer['model'] ?? null,
            'availability' => $availability, 'ownerId' => $ownerId ?? (string) $computer['ownerUserId']];
    }

    /** When each requester of these apps was last served: "app|kind|id" => started_at. */
    private function requestersServed(array $appIds): array
    {
        if ($appIds === []) return [];
        $marks = implode(',', array_fill(0, count($appIds), '?'));
        $statement = $this->pdo()->prepare("SELECT app_id, requester_kind, requester_id, MAX(started_at) AS served FROM app_ai_jobs WHERE app_id IN ({$marks}) AND started_at IS NOT NULL GROUP BY app_id, requester_kind, requester_id");
        $statement->execute(array_values($appIds));
        $out = [];
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) $out[$row['app_id'] . '|' . $row['requester_kind'] . '|' . $row['requester_id']] = (string) $row['served'];
        return $out;
    }

    /** How many more jobs of this lane the route takes now. */
    private function room(array $route, string $lane): int
    {
        if ($route['kind'] === 'off') return 0;
        $limit = $route['kind'] === 'env' ? ($lane === 'chat' ? self::ENV_CHATS : self::ENV_PICTURES) : ($lane === 'chat' ? self::COMPUTER_CHATS : 1);
        $kinds = $lane === 'chat' ? "('chat')" : "('picture','edit')";
        $target = $route['kind'] === 'env' ? 'env' : (string) $route['target']['connectionId'];
        $statement = $this->pdo()->prepare("SELECT COUNT(*) FROM app_ai_jobs WHERE target = ? AND status IN ('sending','running') AND kind IN {$kinds}");
        $statement->execute([$target]);
        return max(0, $limit - (int) $statement->fetchColumn());
    }

    /** Send one job: 'sent', 'skip' (this one, not the rest) or 'wait' (the route takes none now). */
    private function sendOne(array $job, array $route): string
    {
        $pdo = $this->pdo();
        $id = (string) $job['id'];
        // Claimed with the time it was (in next_attempt_at, which a job being sent has no other use for):
        // what tells a job a dead worker left from one another worker is sending now (sweepSending).
        $claim = $pdo->prepare("UPDATE app_ai_jobs SET status = 'sending', next_attempt_at = ? WHERE id = ? AND status = 'queued'");
        $claim->execute([AppAiService::stamp(microtime(true)), $id]);
        if ($claim->rowCount() !== 1) return 'skip';
        // What the job asks, read for this one job alone: send() reads no prompt and no picture.
        $asked = $pdo->prepare('SELECT prompt, reference FROM app_ai_jobs WHERE id = ?');
        $asked->execute([$id]);
        $asked = $asked->fetch(PDO::FETCH_ASSOC);
        if (!is_array($asked)) return 'skip';
        $job += $asked;
        $picture = $job['kind'] !== 'chat';
        $model = $picture ? $route['pictureModel'] : $route['chatModel'];
        $seed = $job['seed'] === null ? null : (int) $job['seed'];
        $size = (string) ($job['size'] ?: '1024x1024');
        $target = $route['kind'] === 'env' ? 'env' : (string) $route['target']['connectionId'];
        $source = $route['availability']['source'] . '-' . ($route['kind'] === 'env' ? 'env' : 'oaiy');
        // A chat's answer may be this long, in tokens: what the app asked for, within the site's ceiling.
        $tokens = $this->answerTokens($job);
        $waitAgain = function (int $seconds) use ($pdo, $id): string {
            // Back in the queue only while it is still this worker's to send: one the app cancelled
            // meanwhile stays cancelled (it was put back and sent before), and, never sent, has its use back.
            $back = $pdo->prepare("UPDATE app_ai_jobs SET status = 'queued', next_attempt_at = ? WHERE id = ? AND status = 'sending'");
            $back->execute([AppAiService::stamp(time() + $seconds), $id]);
            if ($back->rowCount() === 0) $this->ai->unsent($id);
            return 'wait';
        };

        if ($route['kind'] === 'env') {
            try {
                $reference = $job['kind'] === 'edit' ? AppAiPictures::reference((string) $job['reference']) : null;
            } catch (\RuntimeException $e) {
                $this->unreadablePicture($id, $e->getMessage(), unsent: true);
                return 'skip';
            }
            try {
                $this->env->start($id, ['kind' => $job['kind'], 'model' => $model, 'prompt' => $job['prompt'], 'size' => $size, 'seed' => $seed, 'reference' => $reference,
                    'messages' => $picture ? null : json_decode((string) $job['prompt'], true),
                    // `max_tokens` to the upstream, and how much of its answer is read whatever it sends.
                    'maxTokens' => $picture ? null : $tokens, 'maxCharacters' => $picture ? null : AppAiService::answerCharacters($tokens)]);
            } catch (\Throwable $e) {
                $this->logger?->warning('App AI: the .env upstream could not be asked: ' . $e->getMessage());
                return $waitAgain(30);
            }
            $this->started($job, $target, $source, (string) ($model ?? ''), null, null, null);
            return 'sent';
        }

        if ($this->desktop === null) return $waitAgain(30);
        // A data key that is set and cannot be used: the turn's key could only be kept in the clear, which is never done
        // once encryption is asked for (DataEncryption). Nothing is sent; the job waits for the key to be put right.
        if ($this->encryption !== null && !$this->encryption->usable()) {
            if (!$this->keyUnusableSaid) {
                $this->logger?->warning('App AI: DATA_ENCRYPTION_KEY is set but is not a valid key, so no job is sent to a computer until it is put right');
                $this->keyUnusableSaid = true;
            }
            return $waitAgain(60);
        }
        $computer = $route['target'];
        if ($picture) {
            // A picture is made by the computer's own engines, whatever provider its chat uses.
            $computer['providerId'] = SiteDesktopAi::PROVIDER;
            $body = ['kind' => DesktopAiRelayService::PICTURE_KIND, 'requestId' => 'fl-ai-job-' . $id, 'model' => $model, 'prompt' => (string) $job['prompt'],
                'size' => $size, 'seed' => $seed, 'reference' => null, 'incognito' => true];
            if ($job['kind'] === 'edit') {
                // The edit's picture gets what room the prompt leaves in the lane's 256 KiB request:
                // a prompt's characters can take up to 12 bytes each, written as JSON.
                $room = SiteDesktopAi::room($computer, ['reference' => ''] + $body) - 64;
                $maxBytes = min(AppAiPictures::MAX_REFERENCE_BYTES, (int) floor(($room - 23) * 3 / 4));
                if ($maxBytes < self::MIN_REFERENCE_BYTES) {
                    $this->fail($id, 'too_large', 'The prompt is too long to send with a picture to edit. Use a shorter one.', unsent: true);
                    return 'skip';
                }
                try {
                    $body['reference'] = AppAiPictures::reference((string) $job['reference'], $maxBytes);
                } catch (\RuntimeException $e) {
                    $this->unreadablePicture($id, $e->getMessage(), unsent: true);
                    return 'skip';
                }
            }
        } else {
            // OAIY's own engine answers with the model chosen in OAIY; another provider with the one named here.
            // `maxTokens` is the answer's limit for its engine (contract §0.13); an OAIY that does not
            // know the field ignores it, and collect() stops reading at the characters it allows.
            $body = ['kind' => 'chat', 'messages' => json_decode((string) $job['prompt'], true), 'maxTokens' => $tokens]
                + ((($computer['providerId'] ?? SiteDesktopAi::PROVIDER) !== SiteDesktopAi::PROVIDER && $model !== null) ? ['model' => $model] : []);
        }
        try {
            // Queued as the app's owner: a computer serves it while its owner is an administrator
            // (the site's), or always when it is the owner's own (DesktopAiRelayService::SERVED_SQL).
            [$relayId, $pair] = $this->desktop->send($computer, $body, $route['ownerId'], DesktopAiRelayService::SOURCE_APP_AI);
        } catch (SiteAiTooLargeException) {
            $this->fail($id, 'too_large', 'The picture to edit is too large to send.', unsent: true);
            return 'skip';
        } catch (SiteAiBusyException $busy) {
            // Offline, or its places are taken: the job waits, and is told so in the app's context. It
            // is asked again in a moment, not on every pass, so the jobs of a computer that is off or
            // full are not what each pass looks at first.
            return $waitAgain($busy->reason === 'site_ai_offline' ? self::OFFLINE_RETRY : self::BUSY_RETRY);
        } catch (\Throwable $e) {
            $this->logger?->warning('App AI: a job could not be sent: ' . $e->getMessage());
            return $waitAgain(30);
        }
        try {
            $this->started($job, $target, $source, (string) ($model ?? ''), $relayId, (string) $computer['ownerUserId'], $this->seal($pair, $id));
        } finally {
            sodium_memzero($pair);
        }
        return 'sent';
    }

    private function started(array $job, string $target, string $source, string $model, ?string $relayId, ?string $relayOwner, ?string $channel): void
    {
        $now = AppAiService::stamp(microtime(true));
        $running = $this->pdo()->prepare("UPDATE app_ai_jobs SET status = 'running', target = ?, source = ?, model = ?, relay_id = ?, relay_owner = ?, channel = ?, started_at = ?, attempts = attempts + 1, next_attempt_at = NULL WHERE id = ? AND status = 'sending'");
        $running->execute([$target, $source, $model !== '' ? $model : null, $relayId, $relayOwner, $channel, $now, $job['id']]);
        if ($running->rowCount() === 0) {
            // Cancelled by the app while it was being sent: what was just asked for is let go at once,
            // before the AI has started on it, so the job's use is given back.
            if ($relayId !== null) $this->desktop?->cancel($relayId, (string) $relayOwner);
            else $this->env->abandon((string) $job['id']);
            $this->ai->unsent((string) $job['id']);
            return;
        }
        $this->pdo()->prepare('UPDATE app_ai_settings SET last_served_at = ? WHERE app_id = ?')->execute([$now, $job['app_id']]);
    }

    // ------------------------------------------------------------------ 4. collect

    private function collect(): int
    {
        $count = 0;
        foreach ($this->env->poll($this->env->count() > 0 ? 0.2 : 0.0) as $id => $answer) {
            $job = $this->job((string) $id);
            if ($job === null || $job['status'] !== 'running') continue;
            $this->finish($job, $answer);
            $count++;
        }
        $running = $this->pdo()->query("SELECT * FROM app_ai_jobs WHERE status = 'running'")->fetchAll(PDO::FETCH_ASSOC);
        foreach ($running as $job) {
            $age = microtime(true) - (float) strtotime(substr((string) $job['started_at'], 0, 19) . ' UTC');
            if ($job['relay_id'] === null) {
                // On the .env upstream, but not in this process: the worker that asked has gone.
                if (!$this->env->has((string) $job['id'])) { $this->lost($job, false); $count++; }
                elseif ($age > self::RUNNING_BACKSTOP) {
                    $this->env->abandon((string) $job['id']);
                    $this->finish($job, ['ok' => false, 'code' => 'timeout', 'message' => 'The AI did not answer in time.']);
                    $count++;
                }
                continue;
            }
            if ($this->desktop === null) continue;
            $pair = $this->open($job);
            if ($pair === null) { $this->lost($job, false); $count++; continue; }
            try {
                // A chat's answer is read no further than what is kept of it (four bytes a character at
                // most), so an answer that runs on is never held whole in this worker. A picture's turn
                // has no text in it (its picture comes whole in its final frame, after progress frames):
                // little is read of any it sends, and one that sends that much is no picture (below).
                $enough = $job['kind'] === 'chat' ? 4 * AppAiService::answerCharacters($this->answerTokens($job)) : self::PICTURE_TEXT_LIMIT;
                $seen = $this->desktop->collect((string) $job['relay_id'], (string) $job['relay_owner'], $pair, $enough);
            } catch (\Throwable $e) {
                $this->desktop->cancel((string) $job['relay_id'], (string) $job['relay_owner']);
                $this->finish($job, ['ok' => false, 'code' => 'engine_failed', 'message' => 'OAIY sent an answer that could not be read.']);
                $count++;
                continue;
            } finally {
                sodium_memzero($pair);
            }
            $final = $seen['final'];
            if (is_array($final) && is_array($final['picture'] ?? null)) {
                $bytes = base64_decode((string) ($final['picture']['data'] ?? ''), true);
                $this->finish($job, $bytes === false || $bytes === ''
                    ? ['ok' => false, 'code' => 'engine_failed', 'message' => 'OAIY sent no picture.']
                    : ['ok' => true, 'picture' => $bytes, 'seed' => is_int($final['picture']['seed'] ?? null) ? $final['picture']['seed'] : null,
                        'model' => is_string($final['picture']['model'] ?? null) ? $final['picture']['model'] : $job['model']]);
            } elseif (is_array($final) && is_array($final['error'] ?? null)) {
                $this->finish($job, ['ok' => false, 'code' => (string) ($final['error']['code'] ?? 'engine_failed'), 'message' => mb_substr((string) ($final['error']['message'] ?? 'OAIY could not do it.'), 0, 300)]);
            } elseif ($seen['error'] !== null) {
                $this->finish($job, ['ok' => false, 'code' => 'engine_failed', 'message' => mb_substr($seen['error'], 0, 300)]);
            } elseif ($job['kind'] !== 'chat' && strlen($seen['content']) >= self::PICTURE_TEXT_LIMIT) {
                // Words where a picture was asked for, as many as are read: no picture OAIY draws. The
                // turn ends now, and its computer is told to stop, rather than read again every pass.
                $this->desktop->cancel((string) $job['relay_id'], (string) $job['relay_owner']);
                $this->finish($job, ['ok' => false, 'code' => 'engine_failed', 'message' => 'OAIY sent text where a picture was asked for.']);
            } elseif ($job['kind'] === 'chat' && ($final !== null || ($seen['status'] === 'done' && $seen['content'] !== ''))) {
                // A chat's reply, streamed or whole in its final frame: as much of it as is read.
                $this->finish($job, ['ok' => true, 'text' => mb_substr($seen['content'], 0, AppAiService::answerCharacters($this->answerTokens($job))), 'model' => $job['model']]);
            } elseif ($job['kind'] === 'chat' && mb_strlen($seen['content']) >= AppAiService::answerCharacters($this->answerTokens($job))) {
                // The answer has run past all that is read of it, and is still coming (an OAIY that
                // does not know `maxTokens`, or a model that ignores it): the turn ends here with what
                // was read, and the computer is told to stop on its next frame.
                $this->desktop->cancel((string) $job['relay_id'], (string) $job['relay_owner']);
                $this->finish($job, ['ok' => true, 'text' => mb_substr($seen['content'], 0, AppAiService::answerCharacters($this->answerTokens($job))), 'model' => $job['model']]);
            } elseif (in_array($seen['status'], ['failed', 'expired', 'done', null], true)) {
                // Gone without an answer: never taken in time, given up on as silent, or its frames gone.
                $this->lost($job, $seen['taken']);
            } elseif ($age > self::RUNNING_BACKSTOP) {
                // Out of time: the computer is told to stop, on its next frame.
                $this->desktop->cancel((string) $job['relay_id'], (string) $job['relay_owner']);
                $this->finish($job, ['ok' => false, 'code' => 'timeout', 'message' => 'The AI did not answer in time.']);
            } else {
                continue;
            }
            $count++;
        }
        return $count;
    }

    /** What came back for a job: a result to deliver (or keep, for a test), or a failure. */
    private function finish(array $job, array $answer): void
    {
        $id = (string) $job['id'];
        $test = $job['requester_kind'] === AppAiService::TEST_REQUESTER;
        if (!$answer['ok']) {
            $code = in_array($answer['code'], self::CODES, true) ? (string) $answer['code'] : 'engine_failed';
            if ($code === 'busy' && (int) $job['attempts'] < self::BUSY_ATTEMPTS) {
                $this->pdo()->prepare("UPDATE app_ai_jobs SET status = 'queued', relay_id = NULL, relay_owner = NULL, channel = NULL, started_at = NULL, next_attempt_at = ? WHERE id = ? AND status = 'running'")
                    ->execute([AppAiService::stamp(time() + 30), $id]);
                return;
            }
            if (in_array($code, ['model_disabled', 'model_unknown'], true)) {
                $this->logger?->error('App AI: ' . ($code === 'model_disabled' ? 'the picture model is switched off or missing its files' : 'the picture model is unknown') . ' on ' . $job['target'] . ': ' . $answer['message']);
            }
            $this->fail($id, $code, (string) $answer['message']);
            $this->breaker((string) $job['app_id'], in_array($code, self::BREAKER_CODES, true));
            return;
        }
        try {
            if (isset($answer['picture'])) {
                $picture = AppAiPictures::deliverable($answer['picture']);
                $result = ['picture' => $picture['dataUrl'], 'mimeType' => $picture['mimeType'], 'width' => $picture['width'], 'height' => $picture['height'],
                    'seed' => $answer['seed'] ?? null, 'model' => $answer['model'] ?? $job['model']];
            } else {
                $result = ['text' => (string) $answer['text'], 'model' => $answer['model'] ?? $job['model']];
            }
        } catch (\RuntimeException $e) {
            $this->fail($id, 'engine_failed', 'The AI\'s picture could not be read.');
            $this->breaker((string) $job['app_id'], true);
            return;
        }
        if (!is_dir($this->results) && !@mkdir($this->results, 0700, true) && !is_dir($this->results)) throw new \RuntimeException('App AI results storage is unavailable');
        $file = $id . '.json';
        if (file_put_contents($this->results . '/' . $file, json_encode($result, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), LOCK_EX) === false) {
            throw new \RuntimeException('App AI results storage is unavailable');
        }
        $meta = array_diff_key($result, ['picture' => true, 'text' => true]);
        $now = AppAiService::stamp(microtime(true));
        // Ready: delivered to the app as the next pass looks; a test's result waits for its owner instead.
        $ready = $this->pdo()->prepare("UPDATE app_ai_jobs SET status = ?, result_path = ?, result_meta = ?, code = NULL, message = NULL, channel = NULL, reference = NULL, finished_at = ?, next_attempt_at = ?, model = COALESCE(?, model) WHERE id = ? AND status = 'running'");
        $ready->execute([$test ? 'done' : 'delivering', $file, json_encode($meta, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR), $now, $test ? null : self::due(), $result['model'] ?? null, $id]);
        if ($ready->rowCount() === 0) {
            // Cancelled by the app while the AI worked on it: what came back is thrown away.
            @unlink($this->results . '/' . $file);
            return;
        }
        $this->breaker((string) $job['app_id'], false);
    }

    /**
     * A job whose answer is gone (never taken, its frames purged, or its worker gone): sent once more,
     * else failed. It counts against its app's AI only when the AI took it ($taken) and then gave no
     * answer: a computer too busy or too long off to take it in time, or a worker that stopped, is
     * not the AI failing, and five such jobs in a row would otherwise rest an app's AI that never ran.
     */
    private function lost(array $job, bool $taken): void
    {
        if ((int) $job['attempts'] < self::MAX_ATTEMPTS) {
            $this->pdo()->prepare("UPDATE app_ai_jobs SET status = 'queued', relay_id = NULL, relay_owner = NULL, channel = NULL, started_at = NULL WHERE id = ? AND status = 'running'")->execute([$job['id']]);
            return;
        }
        $this->fail((string) $job['id'], 'timeout', 'The AI did not answer. Try again.');
        if ($taken) $this->breaker((string) $job['app_id'], true);
    }

    /** Count an app's failure in a row (or end the run of them); five rest its AI for ten minutes. */
    private function breaker(string $appId, bool $failed): void
    {
        $pdo = $this->pdo();
        if (!$failed) {
            $pdo->prepare('UPDATE app_ai_settings SET failures_in_row = 0 WHERE app_id = ? AND failures_in_row > 0')->execute([$appId]);
            return;
        }
        $pdo->prepare('UPDATE app_ai_settings SET failures_in_row = failures_in_row + 1 WHERE app_id = ?')->execute([$appId]);
        $rested = $pdo->prepare('UPDATE app_ai_settings SET paused_until = ?, failures_in_row = 0 WHERE app_id = ? AND failures_in_row >= ?');
        $rested->execute([gmdate('Y-m-d H:i:s', time() + self::BREAKER_PAUSE), $appId, self::BREAKER_FAILURES]);
        if ($rested->rowCount() > 0) $this->logger?->warning('App AI: app ' . $appId . ' failed ' . self::BREAKER_FAILURES . ' times in a row; its AI rests for ' . (self::BREAKER_PAUSE / 60) . ' minutes');
    }

    /**
     * Fail a job: the app is told as the delivery next runs, and its use is given back. A job that
     * ended meanwhile (the app cancelled it, say) keeps the end it has, and whether its use was
     * given back is that end's to say.
     */
    private function fail(string $id, string $code, string $message, bool $unsent = false): void
    {
        $failed = $this->pdo()->prepare("UPDATE app_ai_jobs SET status = 'failed', code = ?, message = ?, channel = NULL, reference = NULL, finished_at = ?, next_attempt_at = ? WHERE id = ? AND status NOT IN ('done', 'failed', 'refused', 'cancelled')");
        $failed->execute([$code, mb_substr($message, 0, 300), AppAiService::stamp(microtime(true)), self::due(), $id]);
        if ($failed->rowCount() === 1) $this->ai->refund($id);
        // ($unsent: it failed before it was sent. Cancelled by the app meanwhile, it never reached the AI, so its use is given back.)
        elseif ($unsent) $this->ai->unsent($id);
    }

    /**
     * Fail an edit whose picture could not be made ready for the AI, by why ($reason, as
     * AppAiPictures says it): too large (by its header, or past what the lane takes at any quality),
     * this server unable to hold or draw it, or not a picture it can read.
     */
    private function unreadablePicture(string $id, string $reason, bool $unsent = false): void
    {
        match ($reason) {
            'too_large' => $this->fail($id, 'too_large', 'The picture to edit is too large to send.', $unsent),
            'memory' => $this->fail($id, 'engine_failed', 'This server could not make room to read the picture to edit.', $unsent),
            'no_gd' => $this->fail($id, 'engine_failed', 'This server cannot prepare pictures: it needs PHP\'s GD extension.', $unsent),
            default => $this->fail($id, 'bad_request', 'The picture to edit could not be read.', $unsent),
        };
    }

    // ------------------------------------------------------------------ 5. deliver

    private function deliver(): int
    {
        $due = $this->pdo()->prepare(
            "SELECT * FROM app_ai_jobs WHERE status IN ('delivering','failed','refused','cancelled') AND delivered_at IS NULL AND requester_kind <> ?
             AND next_attempt_at IS NOT NULL AND next_attempt_at <= UTC_TIMESTAMP(3) ORDER BY next_attempt_at LIMIT 20"
        );
        $due->execute([AppAiService::TEST_REQUESTER]);
        $count = 0;
        foreach ($due->fetchAll(PDO::FETCH_ASSOC) as $job) {
            if ($this->deliverOne($job)) $count++;
        }
        return $count;
    }

    private function deliverOne(array $job): bool
    {
        $pdo = $this->pdo();
        $id = (string) $job['id'];
        $declared = AppFormlogicManifest::ai($this->native->installedManifest((string) $job['app_id']));
        if ($declared === null) {
            // The app no longer asks for AI: there is nobody to tell.
            $this->delivered($job, false);
            return false;
        }
        $body = ['jobId' => (string) $job['app_job_id']];
        if ($job['status'] === 'delivering') {
            $result = $job['result_path'] !== null ? json_decode((string) @file_get_contents($this->results . '/' . basename((string) $job['result_path'])), true) : null;
            if (!is_array($result)) {
                $this->fail($id, 'engine_failed', 'The AI\'s answer was lost before it could be delivered. Try again.');
                return false;
            }
            $body += ['status' => 'done'] + $result;
        } elseif ($job['status'] === 'cancelled') {
            // The app's own cancel, told once (contract §0.11).
            $body += ['status' => 'cancelled'];
        } else {
            $body += ['status' => 'failed', 'code' => (string) ($job['code'] ?? 'engine_failed'), 'message' => (string) ($job['message'] ?? '')];
        }
        $request = [
            'method' => 'POST', 'path' => $declared['deliver'], 'query' => (object) [], 'body' => (object) $body,
            // The same key on every try of one delivery, so the app can tell a retry from a second result.
            'headers' => (object) ['authorization' => '', 'idempotency-key' => 'fl-ai-' . $id], 'client_ip' => '127.0.0.1', 'photos' => false,
        ];
        // As the site itself, never a page. The delivery names who asked for the job, as their own
        // requests do (`ai.requester`), and carries one subscription: a new row the deliver route
        // writes in the jobs table is a follow-up job for that requester (AppAiService::capture; one
        // for a delivered job, none from a follow-up's delivery: contract §0.13). Nothing else a
        // delivery writes asks for AI, and no flow hears of it. A refused follow-up's delivery
        // carries none, so a deliver route that writes a row every time it is called ends there.
        $who = AppAiService::requesterId(['kind' => (string) $job['requester_kind'], 'id' => (string) $job['requester_id']]);
        $identity = ['formlogic' => ['appId' => (string) $job['app_id'], 'ai' => ['delivery' => true] + ($who !== null ? ['requester' => $who] : [])]];
        $subscriptions = AppAiService::deliveryMayAsk($job) ? AppAiService::followUpSubscription($declared['table'], $id) : [];
        try {
            $answer = $this->native->request((string) $job['app_id'], $request, $identity, $subscriptions);
            $status = is_int($answer['status'] ?? null) ? $answer['status'] : 0;
        } catch (\RuntimeException $e) {
            $status = in_array($e->getCode(), [404, 409, 413, 429], true) ? (int) $e->getCode() : 503;
        }
        if ($subscriptions !== []) {
            // A follow-up the delivery asked for is taken now, not at the next catch-up.
            try {
                $this->native->dispatchRecordEvents((string) $job['app_id'], $this->records->for((string) $job['app_id']));
            } catch (\Throwable $e) {
                $this->logger?->warning('App AI: record events still pending for app ' . $job['app_id'] . ': ' . $e->getMessage());
            }
        }
        if ($status >= 200 && $status < 300) {
            $this->delivered($job, true);
            return true;
        }
        $attempts = (int) $job['delivery_attempts'];
        // An app that is busy or updating is asked again for about half an hour; one that refuses
        // the delivery itself, a few times.
        $retryable = $status === 0 || in_array($status, [409, 429, 503], true);
        if ($attempts + 1 >= ($retryable ? count(self::DELIVERY_BACKOFF) : self::DELIVERY_REFUSALS)) {
            $this->logger?->warning('App AI: job ' . $id . ' could not be delivered to app ' . $job['app_id'] . ' (HTTP ' . $status . ')');
            $now = AppAiService::stamp(microtime(true));
            if ($job['status'] === 'delivering') {
                $pdo->prepare("UPDATE app_ai_jobs SET status = 'failed', code = 'undelivered', message = 'The app did not take the result.', delivered_at = ?, delivery_attempts = delivery_attempts + 1 WHERE id = ? AND status = 'delivering'")->execute([$now, $id]);
                $this->removeResult($job);
            } else {
                $pdo->prepare('UPDATE app_ai_jobs SET delivered_at = ?, delivery_attempts = delivery_attempts + 1 WHERE id = ?')->execute([$now, $id]);
            }
            return false;
        }
        $pdo->prepare('UPDATE app_ai_jobs SET delivery_attempts = delivery_attempts + 1, next_attempt_at = ? WHERE id = ?')
            ->execute([AppAiService::stamp(time() + self::DELIVERY_BACKOFF[min($attempts, count(self::DELIVERY_BACKOFF) - 1)]), $id]);
        return false;
    }

    private function delivered(array $job, bool $told): void
    {
        $this->pdo()->prepare("UPDATE app_ai_jobs SET status = CASE WHEN status = 'delivering' THEN 'done' ELSE status END, delivered_at = ?, delivery_attempts = delivery_attempts + ?, result_path = NULL WHERE id = ?")
            ->execute([AppAiService::stamp(microtime(true)), $told ? 1 : 0, $job['id']]);
        $this->removeResult($job);
    }

    private function removeResult(array $job): void
    {
        if ($job['result_path'] !== null) @unlink($this->results . '/' . basename((string) $job['result_path']));
    }

    // ------------------------------------------------------------------ helpers

    /** How long a chat job's answer may be, in tokens: its app's `max_output` within the site's ceiling, or the ceiling. */
    private function answerTokens(array $job): int
    {
        return AppAiService::answerTokens($job['max_output'] ?? null, $this->site->current());
    }

    private function job(string $id): ?array
    {
        $statement = $this->pdo()->prepare('SELECT * FROM app_ai_jobs WHERE id = ?');
        $statement->execute([$id]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        return is_array($row) ? $row : null;
    }

    /** The turn's key pair as kept in the row: sealed with the site's data key where one is set. */
    private function seal(string $pair, string $jobId): string
    {
        $encoded = base64_encode($pair);
        return $this->encryption !== null && $this->encryption->enabled() ? $this->encryption->seal($encoded, self::SEAL_CONTEXT . $jobId) : $encoded;
    }

    private function open(array $job): ?string
    {
        $stored = (string) ($job['channel'] ?? '');
        if ($stored === '') return null;
        try {
            $encoded = DataEncryption::isSealed($stored) ? ($this->encryption?->open($stored, self::SEAL_CONTEXT . $job['id']) ?? '') : $stored;
        } catch (\Throwable) {
            return null;
        }
        $pair = base64_decode($encoded, true);
        return $pair === false || strlen($pair) !== SODIUM_CRYPTO_BOX_KEYPAIRBYTES ? null : $pair;
    }

    private function pdo(): PDO
    {
        return $this->mysql->getConnection();
    }
}
