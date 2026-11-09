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
 *    first, then within it the requester served least recently, then the oldest job. A computer
 *    takes one picture at a time and one App AI chat beside it (DesktopAiRelayService's lanes), so a
 *    picture never holds up a chat. A computer that is offline, or busy with members' chats, keeps
 *    its jobs waiting.
 * 4. **Collect, without waiting.** The worker reads OAIY's frames (SiteDesktopAi::collect, the path
 *    camera checks use) or the .env upstream's answers (AppAiUpstream). The turn's key is kept in the
 *    job's row, sealed with the site's data key where one is set, so a restarted worker carries on
 *    reading. The relay decides when an OAIY job is lost: a turn nobody claims in 5 minutes, or one
 *    silent for 5 minutes (OAIY's progress frames keep a picture alive while it is drawn).
 * 5. **Deliver** what is ready, as the site, to the app's deliver route. An app that is busy is asked
 *    again later, for about half an hour.
 *
 * A job that never reached the AI, or whose result was lost, is sent once more. A job that failed after
 * the AI took it is not resent, and its use is given back. Five failures in a row rest an app's AI for
 * ten minutes. A test (AppAiService::queueTest) runs like any job, but its result is kept for the owner
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
    /** An edit's picture is never squeezed below this to fit the lane: the request is refused instead. */
    private const MIN_REFERENCE_BYTES = 16000;
    private const CATCH_UP_SECONDS = 5;
    private const SEAL_CONTEXT = 'app-ai-channel:';
    /** Codes that count against an app's breaker: the AI itself failing, not the request. */
    private const BREAKER_CODES = ['engine_failed', 'timeout', 'model_disabled', 'model_unknown'];
    /** The codes a job can end with, as the app is told them. */
    private const CODES = ['model_disabled', 'model_unknown', 'busy', 'bad_request', 'too_large', 'engine_failed', 'timeout'];

    private float $lastCatchUp = 0.0;
    private int $passes = 0;

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
        $alive = @filemtime($results . '/.alive');
        return $alive === false ? null : max(0, time() - $alive);
    }

    /** One pass. $takeNew false finishes what is in flight and sends nothing new. Answers what it did, for the log. */
    public function tick(bool $takeNew = true): array
    {
        $this->passes++;
        if ($this->passes % 10 === 1 && (is_dir($this->results) || @mkdir($this->results, 0700, true))) @touch($this->results . '/.alive');
        return [
            'expired' => $this->expire(),
            'caughtUp' => $takeNew ? $this->catchUp() : 0,
            'sent' => $takeNew ? $this->send() : 0,
            'collected' => $this->collect(),
            'delivered' => $this->deliver(),
        ];
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
        // A job claimed for sending by a pass that ended before it was sent goes back to waiting: a
        // pass sends what it claims before it ends, and only one worker runs at a time (CronLock).
        if ($this->passes === 1) $pdo->exec("UPDATE app_ai_jobs SET status = 'queued' WHERE status = 'sending'");
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
        foreach ($this->pdo()->query("SELECT app_id FROM app_ai_settings WHERE mode <> 'off' AND blocked_by_admin = 0")->fetchAll(PDO::FETCH_COLUMN) as $appId) {
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
        $rows = $this->pdo()->query(
            "SELECT j.*, s.last_served_at FROM app_ai_jobs j LEFT JOIN app_ai_settings s ON s.app_id = j.app_id
             WHERE j.status = 'queued' AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= UTC_TIMESTAMP(3))
             ORDER BY j.created_at LIMIT 500"
        )->fetchAll(PDO::FETCH_ASSOC);
        if ($rows === []) return 0;

        // Where each app's AI goes now: a job goes where its app's AI goes when it is sent.
        $where = [];
        $groups = [];
        foreach ($rows as $job) {
            $appId = (string) $job['app_id'];
            if (!array_key_exists($appId, $where)) $where[$appId] = $this->route($appId);
            $route = $where[$appId];
            if ($route === null) {
                $this->fail((string) $job['id'], 'ai_unavailable', AppAiService::REASONS['ai_off']);
                continue;
            }
            if (!$route['availability']['enabled'] || !in_array($job['kind'], $route['availability']['kinds'], true)) {
                $reason = $route['availability']['enabled'] ? 'not_offered' : (string) $route['availability']['reason'];
                $this->fail((string) $job['id'], 'ai_unavailable', AppAiService::REASONS[$reason] ?? AppAiService::REASONS['not_offered']);
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
        $statement = $this->pdo()->prepare('SELECT id, owner_id AS ownerId, status FROM apps WHERE id = ?');
        $statement->execute([$appId]);
        $app = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($app)) return null;
        $declared = AppFormlogicManifest::ai($this->native->installedManifest($appId));
        if ($declared === null) return null;
        $settings = $this->ai->settings($appId);
        $availability = $this->ai->availability($app, $declared, $settings);
        $site = $this->site->current();
        $off = ['key' => 'off', 'kind' => 'off', 'target' => null, 'pictureModel' => null, 'chatModel' => null];
        $base = ['availability' => $availability, 'ownerId' => (string) $app['ownerId']];
        if (!$availability['enabled']) return $off + $base;
        if ($availability['target'] === 'env') {
            return ['key' => 'env', 'kind' => 'env', 'target' => null, 'pictureModel' => $site['pictureModel'], 'chatModel' => $site['chatModel']] + $base;
        }
        if ($availability['source'] === 'own') {
            $own = $settings['own'];
            $target = [
                'ownerUserId' => (string) $app['ownerId'], 'connectionId' => $own['connectionId'], 'instanceId' => $own['instanceId'],
                'publicKey' => $own['publicKey'], 'providerId' => $own['providerId'] !== '' ? $own['providerId'] : SiteDesktopAi::PROVIDER,
            ];
            return ['key' => 'computer:' . $own['connectionId'], 'kind' => 'oaiy', 'target' => $target, 'pictureModel' => $own['pictureModel'], 'chatModel' => $own['chatModel']] + $base;
        }
        $computer = $this->computers?->current();
        if ($computer === null) {
            return $off + ['availability' => ['enabled' => false, 'reason' => 'site_ai_unavailable'] + $availability] + $base;
        }
        return ['key' => 'computer:' . $computer['connectionId'], 'kind' => 'oaiy', 'target' => $computer, 'pictureModel' => $site['pictureModel'], 'chatModel' => $site['chatModel'] ?? $computer['model'] ?? null] + $base;
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
        $claim = $pdo->prepare("UPDATE app_ai_jobs SET status = 'sending' WHERE id = ? AND status = 'queued'");
        $claim->execute([$id]);
        if ($claim->rowCount() !== 1) return 'skip';
        $picture = $job['kind'] !== 'chat';
        $model = $picture ? $route['pictureModel'] : $route['chatModel'];
        $seed = $job['seed'] === null ? null : (int) $job['seed'];
        $size = (string) ($job['size'] ?: '1024x1024');
        $target = $route['kind'] === 'env' ? 'env' : (string) $route['target']['connectionId'];
        $source = $route['availability']['source'] . '-' . ($route['kind'] === 'env' ? 'env' : 'oaiy');
        $waitAgain = function (int $seconds) use ($pdo, $id): string {
            $pdo->prepare("UPDATE app_ai_jobs SET status = 'queued', next_attempt_at = ? WHERE id = ?")->execute([AppAiService::stamp(time() + $seconds), $id]);
            return 'wait';
        };

        if ($route['kind'] === 'env') {
            try {
                $reference = $job['kind'] === 'edit' ? AppAiPictures::reference((string) $job['reference']) : null;
            } catch (\RuntimeException) {
                $this->fail($id, 'bad_request', 'The picture to edit could not be read.');
                return 'skip';
            }
            try {
                $this->env->start($id, ['kind' => $job['kind'], 'model' => $model, 'prompt' => $job['prompt'], 'size' => $size, 'seed' => $seed, 'reference' => $reference,
                    'messages' => $picture ? null : json_decode((string) $job['prompt'], true)]);
            } catch (\Throwable $e) {
                $this->logger?->warning('App AI: the .env upstream could not be asked: ' . $e->getMessage());
                return $waitAgain(30);
            }
            $this->started($job, $target, $source, (string) ($model ?? ''), null, null, null);
            return 'sent';
        }

        if ($this->desktop === null) return $waitAgain(30);
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
                    $this->fail($id, 'too_large', 'The prompt is too long to send with a picture to edit. Use a shorter one.');
                    return 'skip';
                }
                try {
                    $body['reference'] = AppAiPictures::reference((string) $job['reference'], $maxBytes);
                } catch (\RuntimeException) {
                    $this->fail($id, 'bad_request', 'The picture to edit could not be read.');
                    return 'skip';
                }
            }
        } else {
            // OAIY's own engine answers with the model chosen in OAIY; another provider with the one named here.
            $body = ['kind' => 'chat', 'messages' => json_decode((string) $job['prompt'], true)]
                + ((($computer['providerId'] ?? SiteDesktopAi::PROVIDER) !== SiteDesktopAi::PROVIDER && $model !== null) ? ['model' => $model] : []);
        }
        try {
            // Queued as the app's owner: a computer serves it while its owner is an administrator
            // (the site's), or always when it is the owner's own (DesktopAiRelayService::SERVED_SQL).
            [$relayId, $pair] = $this->desktop->send($computer, $body, $route['ownerId'], DesktopAiRelayService::SOURCE_APP_AI);
        } catch (SiteAiTooLargeException) {
            $this->fail($id, 'too_large', 'The picture to edit is too large to send.');
            return 'skip';
        } catch (SiteAiBusyException) {
            // Offline, or its places are taken: the job waits, and is told so in the app's context.
            $pdo->prepare("UPDATE app_ai_jobs SET status = 'queued' WHERE id = ?")->execute([$id]);
            return 'wait';
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
        $this->pdo()->prepare("UPDATE app_ai_jobs SET status = 'running', target = ?, source = ?, model = ?, relay_id = ?, relay_owner = ?, channel = ?, started_at = ?, attempts = attempts + 1, next_attempt_at = NULL WHERE id = ?")
            ->execute([$target, $source, $model !== '' ? $model : null, $relayId, $relayOwner, $channel, $now, $job['id']]);
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
                if (!$this->env->has((string) $job['id'])) { $this->lost($job); $count++; }
                elseif ($age > self::RUNNING_BACKSTOP) {
                    $this->env->abandon((string) $job['id']);
                    $this->finish($job, ['ok' => false, 'code' => 'timeout', 'message' => 'The AI did not answer in time.']);
                    $count++;
                }
                continue;
            }
            if ($this->desktop === null) continue;
            $pair = $this->open($job);
            if ($pair === null) { $this->lost($job); $count++; continue; }
            try {
                $seen = $this->desktop->collect((string) $job['relay_id'], (string) $job['relay_owner'], $pair);
            } catch (\Throwable $e) {
                $this->desktop->abandon((string) $job['relay_id'], (string) $job['relay_owner']);
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
            } elseif ($job['kind'] === 'chat' && ($final !== null || ($seen['status'] === 'done' && $seen['content'] !== ''))) {
                // A chat's reply, streamed or whole in its final frame.
                $this->finish($job, ['ok' => true, 'text' => mb_substr($seen['content'], 0, 32000), 'model' => $job['model']]);
            } elseif (in_array($seen['status'], ['failed', 'expired', 'done', null], true)) {
                // Gone without an answer: never taken in time, given up on as silent, or its frames gone.
                $this->lost($job);
            } elseif ($age > self::RUNNING_BACKSTOP) {
                $this->desktop->abandon((string) $job['relay_id'], (string) $job['relay_owner']);
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
                $this->pdo()->prepare("UPDATE app_ai_jobs SET status = 'queued', relay_id = NULL, relay_owner = NULL, channel = NULL, started_at = NULL, next_attempt_at = ? WHERE id = ?")
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
        $this->pdo()->prepare("UPDATE app_ai_jobs SET status = ?, result_path = ?, result_meta = ?, code = NULL, message = NULL, channel = NULL, reference = NULL, finished_at = ?, next_attempt_at = ?, model = COALESCE(?, model) WHERE id = ?")
            ->execute([$test ? 'done' : 'delivering', $file, json_encode($meta, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR), $now, $test ? null : self::due(), $result['model'] ?? null, $id]);
        $this->breaker((string) $job['app_id'], false);
    }

    /** A job whose answer is gone (never taken, its frames purged, or its worker gone): sent once more, else failed. */
    private function lost(array $job): void
    {
        if ((int) $job['attempts'] < self::MAX_ATTEMPTS) {
            $this->pdo()->prepare("UPDATE app_ai_jobs SET status = 'queued', relay_id = NULL, relay_owner = NULL, channel = NULL, started_at = NULL WHERE id = ? AND status = 'running'")->execute([$job['id']]);
            return;
        }
        $this->fail((string) $job['id'], 'timeout', 'The AI did not answer. Try again.');
        $this->breaker((string) $job['app_id'], true);
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

    /** Fail a job: the app is told as the delivery next runs, and its use is given back. */
    private function fail(string $id, string $code, string $message): void
    {
        $this->pdo()->prepare("UPDATE app_ai_jobs SET status = 'failed', code = ?, message = ?, channel = NULL, reference = NULL, finished_at = ?, next_attempt_at = ? WHERE id = ? AND status NOT IN ('done', 'failed', 'refused')")
            ->execute([$code, mb_substr($message, 0, 300), AppAiService::stamp(microtime(true)), self::due(), $id]);
        $this->ai->refund($id);
    }

    // ------------------------------------------------------------------ 5. deliver

    private function deliver(): int
    {
        $due = $this->pdo()->prepare(
            "SELECT * FROM app_ai_jobs WHERE status IN ('delivering','failed','refused') AND delivered_at IS NULL AND requester_kind <> ?
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
        } else {
            $body += ['status' => 'failed', 'code' => (string) ($job['code'] ?? 'engine_failed'), 'message' => (string) ($job['message'] ?? '')];
        }
        $request = [
            'method' => 'POST', 'path' => $declared['deliver'], 'query' => (object) [], 'body' => (object) $body,
            // The same key on every try of one delivery, so the app can tell a retry from a second result.
            'headers' => (object) ['authorization' => '', 'idempotency-key' => 'fl-ai-' . $id], 'client_ip' => '127.0.0.1', 'photos' => false,
        ];
        // As the site itself, never a page: with no subscription, so nothing a delivery writes asks for AI.
        $identity = ['formlogic' => ['appId' => (string) $job['app_id'], 'ai' => ['delivery' => true]]];
        try {
            $answer = $this->native->request((string) $job['app_id'], $request, $identity);
            $status = is_int($answer['status'] ?? null) ? $answer['status'] : 0;
        } catch (\RuntimeException $e) {
            $status = in_array($e->getCode(), [404, 409, 413, 429], true) ? (int) $e->getCode() : 503;
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
                $pdo->prepare("UPDATE app_ai_jobs SET status = 'failed', code = 'undelivered', message = 'The app did not take the result.', delivered_at = ?, delivery_attempts = delivery_attempts + 1 WHERE id = ?")->execute([$now, $id]);
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
