<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * The camera check: what the site gives a plugin that `uses` the camera, and nothing more
 * (docs/AGE_GATE_AND_SITE_AI.md, "Plugins and passes"). It knows nothing of what a plugin checks.
 *
 * The check is the plugin's own, in its sandboxed backend. When a member starts one, the plugin's
 * /api/site/camera/start route answers with the steps to show (its own words, and an arrow) and
 * its turn for the model, with places for the pictures and its own pictures (a control). When the
 * model has answered, its /api/site/camera/decide route reads the answer and decides, and may
 * answer with a pass. Both get the plugin's settings, as the administrator set them.
 *
 * This file is the part a sandbox cannot be. The site's own page holds the camera (a plugin's
 * frame cannot have one), shows the plugin's steps, and sends one picture per step here; this
 * fills them into the plugin's turn, seals it to the administrator's OAIY (CameraCheckSettings)
 * and queues it; the page then asks where it stands, and each ask reads what OAIY has sent so far
 * without waiting. The plugin never sees a picture, only the model's answer.
 *
 * The site keeps the limits (three tries a day, an hour after a plugin's "not_confirmed", one at a
 * time) and the outcome. A pass is recorded only for the member who took the check, of its kind,
 * within the plugin's grant, while the app still asks it. No picture, estimate or answer is kept:
 * the turn's key is kept while OAIY works and dropped when the check ends, and the relay drops the
 * sealed pictures then.
 */
final class CameraCheckService
{
    /** Longer than the relay keeps a turn (5 min waiting, 5 min after it is taken). */
    public const SESSION_SECONDS = 660;
    public const MAX_ATTEMPTS_PER_DAY = 3;
    /** After a plugin's "not_confirmed", a member waits this long before trying again. */
    public const COOLDOWN_SECONDS = 3600;
    /** One picture, decoded. The page sends 360 pixels wide at most. */
    public const MAX_FRAME_BYTES = 45000;
    public const MAX_STEPS = 6;
    /** The arrows the page can show for a step. */
    public const HINTS = ['center', 'left', 'right', 'up', 'down'];
    /** What a plugin's turn may hold: text, the pictures and its own pictures, within these. */
    private const MAX_PARTS = 40;
    private const MAX_TEXT = 12000;
    private const MAX_ASSETS = 2;
    private const MAX_ASSET_BYTES = 40000;
    private const MAX_ANSWER = 16000;

    private PDO $pdo;

    public function __construct(
        MySQLConnection $mysql,
        private CameraCheckSettings $settings,
        private SiteDesktopAi $desktop,
        private AccessGateService $gate,
        private PluginService $plugins,
        private AppService $apps,
        private NativeAppService $native,
    ) {
        $this->pdo = $mysql->getConnection();
    }

    /** Camera checks are set up on this site. */
    public function ready(): bool
    {
        return $this->settings->current() !== null;
    }

    /**
     * Whether a plugin's page can offer a camera check for a requirement: the plugin uses the
     * camera, the site has set it up, and the plugin was granted a strength above a declaration
     * that meets what the app asks.
     */
    public function offeredFor(array $plugin, array $requirement): bool
    {
        $grant = $this->plugins->grant($plugin['manifestId'], $requirement['kind']);
        if ($grant === null || !in_array('camera', $plugin['uses'], true) || !$this->ready()) {
            return false;
        }
        $rank = AccessGateService::ASSURANCE[$requirement['strength']] ?? 99;
        foreach ($grant['strengths'] as $strength) {
            if ($strength !== 'declared' && AccessGateService::ASSURANCE[$strength] >= $rank) {
                return true;
            }
        }
        return false;
    }

    /**
     * A member starts a check for one of an app's requirements. Refused when camera checks are not
     * set up, the plugin may not use them, the app does not ask this, or the member has used
     * today's tries, is waiting after "not_confirmed", or has a check with OAIY now.
     */
    public function start(string $userId, string $pluginId, string $appSlug, string $kind): array
    {
        $plugin = $this->plugins->find($pluginId);
        $app = $this->apps->getAppBySlug($appSlug);
        if ($plugin === null || !$plugin['enabled'] || $app === null || !$this->apps->isRuntimeVisible($app, $userId)) {
            throw new \InvalidArgumentException('That app or plugin is not available.');
        }
        $requirement = $this->requirementOf($app, $pluginId, $kind);
        if ($requirement === null || !$this->offeredFor($plugin, $requirement)) {
            throw new \InvalidArgumentException('A camera check is not offered for this.');
        }
        $this->assertMayStart($userId);
        return $this->begin($userId, 'member', $plugin, (string) $app['id'], $requirement);
    }

    /** The administrator tries a plugin's whole check on themselves, for value $min: nothing is recorded, and they see the model's answer. */
    public function startTrial(string $adminId, string $pluginId, mixed $min): array
    {
        $plugin = $this->cameraPlugin($pluginId);
        $grant = $plugin['grants'][0] ?? throw new \InvalidArgumentException('That plugin issues no pass.');
        $min = is_int($min) && $min >= $grant['min'] && $min <= $grant['max'] ? $min : $grant['min'];
        $this->cancelOpen($adminId);
        return $this->begin($adminId, 'trial', $plugin, null, ['plugin' => $pluginId, 'kind' => $grant['kind'], 'min' => $min, 'strength' => self::strongest($grant)]);
    }

    /**
     * Whether the chosen model reads pictures: the plugin's turn with no steps, only its own
     * pictures. Sent at once; the plugin decides (the age gate says `reads_images` or `no_images`).
     */
    public function startProbe(string $adminId, string $pluginId): array
    {
        $plugin = $this->cameraPlugin($pluginId);
        $grant = $plugin['grants'][0] ?? throw new \InvalidArgumentException('That plugin issues no pass.');
        $this->cancelOpen($adminId);
        $check = $this->begin($adminId, 'probe', $plugin, null, ['plugin' => $pluginId, 'kind' => $grant['kind'], 'min' => $grant['min'], 'strength' => self::strongest($grant)]);
        $row = $this->row($check['id'], $adminId);
        $this->claim($row);
        $this->sendTurn($row, []);
        return $this->status($adminId, $check['id']);
    }

    /**
     * The pictures for a started check, one per step in the order shown, as JPEG data URLs. The
     * try counts from here. Answers at once; the page asks for the result after.
     */
    public function submit(string $userId, string $id, mixed $frames): array
    {
        $row = $this->row($id, $userId);
        if ($row['status'] !== 'started' || $row['mode'] === 'probe') {
            throw new \InvalidArgumentException('This check has already been sent.');
        }
        if (self::expired($row)) {
            $this->finish($row, 'cancelled', true);
            throw new \InvalidArgumentException('This check took too long. Start again.');
        }
        $images = self::frames($frames, count(json_decode((string) $row['steps'], true)));
        $this->claim($row);
        $this->sendTurn($row, $images);
        return $this->status($userId, $id);
    }

    /**
     * Where a check stands. While OAIY works, each call reads what it has sent so far; the call that
     * finds its answer hands it to the plugin to decide. {id, mode, status, outcome, message,
     * steps (while started), attemptsLeft, answer (the administrator's own trial or test only)}.
     */
    public function status(string $userId, string $id): array
    {
        $row = $this->row($id, $userId);
        $detail = null;
        if ($row['status'] === 'assessing') {
            [$row, $detail] = $this->advance($row);
        } elseif ($row['status'] === 'deciding' && self::expired($row)) {
            // The ask that was deciding it never finished.
            $row = $this->finish($row, 'unavailable', true);
        }
        return $this->describe($row, $detail);
    }

    /** Stop a started check the member left. One with OAIY is left to finish. */
    public function cancel(string $userId, string $id): void
    {
        $row = $this->row($id, $userId);
        if ($row['status'] === 'started') {
            $this->finish($row, 'cancelled', true);
        }
    }

    /** The plugin's start route: the steps to show, and its turn for the model with places for the pictures. */
    private function begin(string $userId, string $mode, array $plugin, ?string $appId, array $requirement): array
    {
        if (!$this->ready()) {
            throw new \InvalidArgumentException('Camera checks are not set up on this site.');
        }
        $id = bin2hex(random_bytes(16));
        $answer = $this->callPlugin($plugin, $userId, PluginService::CAMERA_ROUTES['start'], [
            'check' => $id,
            'mode' => $mode,
            'requirement' => ['kind' => $requirement['kind'], 'min' => $requirement['min'], 'strength' => $requirement['strength']],
            'settings' => $plugin['settings'],
        ]);
        $steps = self::steps($answer['steps'] ?? null, $mode === 'probe');
        $turn = $this->turnTemplate($plugin, $answer['turn'] ?? null, count($steps));
        $now = time();
        $this->pdo->prepare(
            "INSERT INTO camera_checks (id, user_id, mode, plugin_id, app_id, kind, min_value, steps, turn, status, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', ?, ?)"
        )->execute([$id, $userId, $mode, $plugin['manifestId'], $appId, $requirement['kind'], (int) $requirement['min'],
            json_encode($steps, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE), json_encode($turn, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES),
            gmdate('Y-m-d H:i:s', $now), gmdate('Y-m-d H:i:s', $now + self::SESSION_SECONDS)]);
        return $this->describe($this->row($id, $userId), null);
    }

    /** A plugin's steps: {say, hint}, its words (plain text) and an arrow; none for a probe. */
    private static function steps(mixed $steps, bool $probe): array
    {
        if (!is_array($steps) || !array_is_list($steps) || count($steps) > self::MAX_STEPS || $probe !== ($steps === [])) {
            throw new \RuntimeException('The plugin did not say which steps to show.');
        }
        $out = [];
        foreach ($steps as $step) {
            $say = is_array($step) ? ($step['say'] ?? null) : null;
            $hint = is_array($step) ? ($step['hint'] ?? null) : null;
            if (!is_string($say) || trim($say) === '' || mb_strlen($say) > 80 || preg_match('/[\x00-\x1f\x7f]/', $say)
                || ($hint !== null && !in_array($hint, self::HINTS, true))) {
                throw new \RuntimeException('The plugin wrote a step the site does not show.');
            }
            $out[] = ['say' => trim($say), 'hint' => $hint];
        }
        return $out;
    }

    /**
     * A plugin's turn, held to its shape: a system text and parts that are text, a camera picture
     * by number (each exactly once), or one of its own pictures by asset path. The assets are read
     * from its installed project here, so the turn carries only what it shipped.
     */
    private function turnTemplate(array $plugin, mixed $turn, int $frames): array
    {
        if (!is_array($turn) || !is_string($turn['system'] ?? null) || !is_array($turn['parts'] ?? null) || !array_is_list($turn['parts'])
            || count($turn['parts']) > self::MAX_PARTS) {
            throw new \RuntimeException('The plugin wrote no turn for the model.');
        }
        $project = $this->native->get($plugin['appId']);
        $assets = is_array($project['assets'] ?? null) ? $project['assets'] : [];
        $text = strlen($turn['system']);
        $seen = [];
        $own = 0;
        $parts = [];
        foreach ($turn['parts'] as $part) {
            if (is_array($part) && count($part) === 1 && is_string($part['text'] ?? null)) {
                $text += strlen($part['text']);
                $parts[] = ['text' => $part['text']];
            } elseif (is_array($part) && count($part) === 1 && is_int($part['frame'] ?? null) && $part['frame'] >= 1 && $part['frame'] <= $frames && !isset($seen[$part['frame']])) {
                $seen[$part['frame']] = true;
                $parts[] = ['frame' => $part['frame']];
            } elseif (is_array($part) && count($part) === 1 && is_string($part['asset'] ?? null) && isset($assets[$part['asset']])
                && preg_match('~^assets/[a-zA-Z0-9/_.-]+\.(?:jpe?g|png)$~D', $part['asset']) && $own < self::MAX_ASSETS) {
                $bytes = base64_decode((string) $assets[$part['asset']], true);
                if ($bytes === false || strlen($bytes) > self::MAX_ASSET_BYTES) {
                    throw new \RuntimeException('A picture of the plugin\'s own is too large for the turn.');
                }
                $own++;
                $parts[] = ['asset' => $part['asset'], 'type' => str_ends_with(strtolower($part['asset']), '.png') ? 'image/png' : 'image/jpeg', 'data' => base64_encode($bytes)];
            } else {
                throw new \RuntimeException('The plugin\'s turn holds a part the site does not send.');
            }
        }
        if ($text > self::MAX_TEXT || count($seen) !== $frames) {
            throw new \RuntimeException('The plugin\'s turn is too long, or does not place every picture once.');
        }
        $template = ['system' => $turn['system'], 'parts' => $parts];
        // A check the administrator's OAIY runs on the pictures itself, beside the model's turn (an age model, for
        // one): its name, and which pictures (the camera's, or every one in the turn). An OAIY without it answers
        // the turn as before.
        if (array_key_exists('verify', $turn)) {
            $verify = $turn['verify'];
            if (!is_array($verify) || !is_string($verify['task'] ?? null) || !preg_match('/^[a-z0-9-]{1,32}$/D', $verify['task'])
                || !in_array($verify['images'] ?? null, ['frames', 'all'], true)) {
                throw new \RuntimeException('The plugin asks OAIY for a check the site cannot send.');
            }
            $template['verify'] = ['task' => $verify['task'], 'images' => $verify['images']];
        }
        return $template;
    }

    /** The positions, among the turn's pictures in order, of those its check names: the camera's, or all. */
    private static function verifyImages(array $turn): array
    {
        $at = 0;
        $named = [];
        foreach ($turn['parts'] as $part) {
            if (isset($part['text'])) {
                continue;
            }
            if (($turn['verify']['images'] ?? null) === 'all' || isset($part['frame'])) {
                $named[] = $at;
            }
            $at++;
        }
        return $named;
    }

    /**
     * What OAIY said of the turn's check, for the plugin: as it said it, held to its shape (the task, an error and
     * its words, or each picture's face count and age), or null when it said nothing (an OAIY without the check).
     */
    public static function verification(mixed $said): ?array
    {
        if (!is_array($said) || !is_string($said['task'] ?? null)) {
            return null;
        }
        $out = ['task' => mb_substr($said['task'], 0, 32)];
        if (is_string($said['error'] ?? null)) {
            return $out + ['error' => mb_substr($said['error'], 0, 32), 'message' => is_string($said['message'] ?? null) ? mb_substr($said['message'], 0, 300) : ''];
        }
        foreach (['model', 'detector'] as $key) {
            if (is_string($said[$key] ?? null)) {
                $out[$key] = mb_substr($said[$key], 0, 64);
            }
        }
        $images = [];
        foreach (array_slice(is_array($said['images'] ?? null) ? $said['images'] : [], 0, 16) as $image) {
            // No count stays no count: read as 0, it would tell the person their face was not found, and charge them.
            $one = is_int($image['faces'] ?? null) && $image['faces'] >= 0 ? ['faces' => min($image['faces'], 99)] : [];
            if (is_int($image['age'] ?? null) || is_float($image['age'] ?? null)) {
                $one['age'] = round((float) $image['age'], 1);
            }
            // Which way the one face points, in degrees (OAIY measures it from the face's landmarks).
            foreach (['yaw', 'pitch'] as $angle) {
                if ((is_int($image[$angle] ?? null) || is_float($image[$angle] ?? null)) && abs((float) $image[$angle]) <= 90) {
                    $one[$angle] = round((float) $image[$angle], 1);
                }
            }
            $images[] = $one;
        }
        return $out + ['images' => $images];
    }

    /** The plugin's turn with the camera pictures in their places, as messages for OAIY. */
    public static function messages(array $turn, array $images): array
    {
        $content = [];
        foreach ($turn['parts'] as $part) {
            if (isset($part['text'])) {
                $content[] = ['type' => 'text', 'text' => $part['text']];
            } elseif (isset($part['frame'])) {
                $content[] = ['type' => 'image_url', 'image_url' => ['url' => 'data:image/jpeg;base64,' . base64_encode($images[$part['frame'] - 1])]];
            } else {
                $content[] = ['type' => 'image_url', 'image_url' => ['url' => 'data:' . $part['type'] . ';base64,' . $part['data']]];
            }
        }
        return [['role' => 'system', 'content' => $turn['system']], ['role' => 'user', 'content' => $content]];
    }

    private function claim(array $row): void
    {
        // Claimed before it is sent, so the same check is never sent twice.
        $claim = $this->pdo->prepare("UPDATE camera_checks SET status = 'sending' WHERE id = ? AND status = 'started'");
        $claim->execute([$row['id']]);
        if ($claim->rowCount() !== 1) {
            throw new \InvalidArgumentException('This check has already been sent.');
        }
    }

    private function sendTurn(array $row, array $images): void
    {
        $settings = $this->settings->current();
        $turn = json_decode((string) $row['turn'], true);
        if ($settings === null || !is_array($turn)) {
            $this->finish($row, 'unavailable', true);
            throw new \InvalidArgumentException('Camera checks are not set up on this site any more.');
        }
        $body = ['kind' => 'chat', 'messages' => self::messages($turn, $images)];
        if ($settings['model'] !== null) {
            $body['model'] = $settings['model'];
        }
        if (isset($turn['verify']) && ($named = self::verifyImages($turn)) !== []) {
            $body['verify'] = ['task' => $turn['verify']['task'], 'images' => $named];
        }
        try {
            [$relayId, $pair] = $this->desktop->send($settings, $body, $row['mode'] === 'member' ? (string) $row['user_id'] : null);
        } catch (\Throwable $e) {
            // Not sent: not a try. The page says why.
            $this->finish($row, 'unavailable', true);
            throw $e instanceof SiteAiBusyException ? new SiteAiBusyException('The camera check is not available right now. ' . $e->getMessage(), $e->reason) : $e;
        }
        // The template is not needed again: only the steps, and the key to read OAIY's answer.
        $this->pdo->prepare(
            "UPDATE camera_checks SET status = 'assessing', submitted_at = ?, relay_id = ?, relay_owner = ?, channel = ?, turn = NULL WHERE id = ?"
        )->execute([gmdate('Y-m-d H:i:s'), $relayId, $settings['ownerUserId'], base64_encode($pair), $row['id']]);
        sodium_memzero($pair);
    }

    /** One look at OAIY's answer; when it is there, the plugin decides. */
    private function advance(array $row): array
    {
        $pair = base64_decode((string) $row['channel'], true);
        if ($pair === false || $row['relay_id'] === null) {
            return [$this->finish($row, 'unavailable', true), null];
        }
        try {
            $seen = $this->desktop->collect((string) $row['relay_id'], (string) $row['relay_owner'], $pair);
        } catch (\Throwable $e) {
            error_log('Camera check ' . $row['id'] . ': ' . $e->getMessage());
            return [$this->finish($row, 'unavailable', true), ['error' => $e->getMessage()]];
        } finally {
            sodium_memzero($pair);
        }
        if ($seen['error'] !== null || in_array($seen['status'], ['failed', 'expired', null], true)) {
            return [$this->finish($row, 'unavailable', true), ['error' => $seen['error'] ?? 'OAIY did not answer in time.']];
        }
        if ($seen['status'] !== 'done' && $seen['final'] === null) {
            if (self::expired($row)) {
                $this->desktop->abandon((string) $row['relay_id'], (string) $row['relay_owner']);
                return [$this->finish($row, 'unavailable', true), null];
            }
            return [$row, null];
        }
        // Claimed before the plugin decides, so two asks at once (two tabs, a reload) decide once:
        // the other reads the check as it then stands.
        $claim = $this->pdo->prepare("UPDATE camera_checks SET status = 'deciding' WHERE id = ? AND status = 'assessing'");
        $claim->execute([$row['id']]);
        if ($claim->rowCount() !== 1) {
            return [$this->row((string) $row['id'], (string) $row['user_id']), null];
        }
        return $this->decide(['status' => 'deciding'] + $row, mb_substr($seen['content'], 0, self::MAX_ANSWER), self::verification($seen['final']['verification'] ?? null));
    }

    /**
     * The plugin's decide route reads the model's answer (the text, and the JSON object in it) and
     * answers {outcome, message, pass?}. A pass is recorded only for a member's check that passed.
     */
    private function decide(array $row, string $content, ?array $verification = null): array
    {
        $json = self::parse($content);
        $plugin = $this->plugins->find((string) $row['plugin_id']);
        try {
            if ($plugin === null || !$plugin['enabled']) {
                throw new \RuntimeException('The plugin is off.');
            }
            $answer = $this->callPlugin($plugin, (string) $row['user_id'], PluginService::CAMERA_ROUTES['decide'], [
                'check' => (string) $row['id'],
                'mode' => (string) $row['mode'],
                'answer' => ['content' => $content, 'json' => $json, 'verification' => $verification],
                'settings' => $plugin['settings'],
            ]);
        } catch (\Throwable $e) {
            error_log('Camera check ' . $row['id'] . ' decide: ' . $e->getMessage());
            return [$this->finish($row, 'unavailable', true), ['error' => $e->getMessage(), 'model' => $json ?? mb_substr($content, 0, 400), 'verification' => $verification]];
        }
        $outcome = is_string($answer['outcome'] ?? null) && preg_match('/^[a-z_]{1,32}$/D', $answer['outcome']) ? $answer['outcome'] : 'unavailable';
        $message = is_string($answer['message'] ?? null) && trim($answer['message']) !== '' ? mb_substr(trim($answer['message']), 0, 300) : null;
        if ($outcome === 'passed' && $row['mode'] === 'member' && !$this->issue($row, $plugin, $answer['pass'] ?? null)) {
            $outcome = 'unavailable';
            $message = null;
        }
        $row = $this->finish($row, $outcome, $outcome === 'unavailable', $message);
        return [$row, ['model' => $json ?? mb_substr($content, 0, 400), 'verification' => $verification, 'plugin' => ['outcome' => $outcome, 'message' => $message]]];
    }

    /**
     * Record the plugin's pass for the member who took the check, if everything still holds: the
     * kind the check was for, a strength above a declaration that meets the app's requirement, and
     * within the plugin's grant (AccessGateService::issueFromPlugin).
     */
    private function issue(array $row, array $plugin, mixed $pass): bool
    {
        $app = $row['app_id'] !== null ? $this->apps->getApp((string) $row['app_id']) : null;
        $requirement = $app !== null ? $this->requirementOf($app, (string) $row['plugin_id'], (string) $row['kind']) : null;
        $strength = is_array($pass) ? ($pass['strength'] ?? null) : null;
        if ($requirement === null || !$this->offeredFor($plugin, $requirement) || !is_array($pass)
            || ($pass['kind'] ?? null) !== $row['kind'] || !is_string($strength) || $strength === 'declared'
            || (AccessGateService::ASSURANCE[$strength] ?? 0) < AccessGateService::ASSURANCE[$requirement['strength']]) {
            return false;
        }
        $grant = $this->plugins->grant((string) $row['plugin_id'], (string) $row['kind']);
        try {
            $this->gate->issueFromPlugin($grant, (string) $row['plugin_id'], (string) $row['user_id'], $pass + ['method' => 'camera_check']);
        } catch (\InvalidArgumentException $e) {
            error_log('Camera check ' . $row['id'] . ': ' . $e->getMessage());
            return false;
        }
        return true;
    }

    /** One of the plugin's /api/site/ routes, in its sandbox, as the person the check is for. */
    private function callPlugin(array $plugin, string $userId, string $path, array $body): array
    {
        $result = $this->native->request($plugin['appId'], [
            'method' => 'POST', 'path' => $path, 'query' => (object) [], 'body' => $body,
            'headers' => (object) ['authorization' => '', 'idempotency-key' => ''], 'client_ip' => '127.0.0.1', 'photos' => false,
        ], ['formlogic' => ['appId' => $plugin['appId'], 'userId' => $userId, 'roleId' => 'member']]);
        if (!is_int($result['status'] ?? null) || $result['status'] < 200 || $result['status'] > 299 || !is_array($result['body'] ?? null)) {
            $said = is_array($result['body'] ?? null) && is_string($result['body']['error'] ?? null) ? ': ' . mb_substr($result['body']['error'], 0, 200) : '';
            throw new \RuntimeException('The plugin refused the camera check (' . ($result['status'] ?? '?') . ')' . $said);
        }
        return $result['body'];
    }

    private function cameraPlugin(string $pluginId): array
    {
        $plugin = $this->plugins->find($pluginId);
        if (!$this->ready()) {
            throw new \InvalidArgumentException('Set up camera checks first.');
        }
        if ($plugin === null || !$plugin['enabled'] || !in_array('camera', $plugin['uses'], true)) {
            throw new \InvalidArgumentException('That plugin does not use the camera.');
        }
        return $plugin;
    }

    private static function strongest(array $grant): string
    {
        $strengths = $grant['strengths'];
        usort($strengths, fn ($a, $b) => AccessGateService::ASSURANCE[$b] <=> AccessGateService::ASSURANCE[$a]);
        return $strengths[0];
    }

    /**
     * The JSON object in a model's answer, whatever is around it: code fences, words, or a reasoning
     * model's thinking (dropped first). The first `{` to the last `}`; failing that, the last whole
     * object in the text that parses, as when thinking that was not marked off has braces of its own.
     */
    public static function parse(string $content): ?array
    {
        $content = (string) preg_replace('#<think>.*?(</think>|$)#s', '', $content);
        $start = strpos($content, '{');
        $end = strrpos($content, '}');
        if ($start === false || $end === false || $end < $start) {
            return null;
        }
        $decoded = json_decode(substr($content, $start, $end - $start + 1), true, 16);
        if (is_array($decoded)) {
            return $decoded;
        }
        // Each `{` in turn, to the `}` that closes it (strings and escapes followed): one that parses
        // is an answer, and the search goes on after it; one that does not is skipped.
        $last = null;
        $n = strlen($content);
        for ($at = $start; $at !== false && $at < $n; $at = strpos($content, '{', $at + 1)) {
            $depth = 0;
            $inString = false;
            for ($i = $at; $i < $n; $i++) {
                $c = $content[$i];
                if ($inString) {
                    if ($c === '\\') { $i++; } elseif ($c === '"') { $inString = false; }
                    continue;
                }
                if ($c === '"') { $inString = true; } elseif ($c === '{') { $depth++; } elseif ($c === '}' && --$depth === 0) { break; }
            }
            if ($i >= $n) {
                continue;
            }
            $decoded = json_decode(substr($content, $at, $i - $at + 1), true, 16);
            if (is_array($decoded)) {
                $last = $decoded;
                $at = $i;
            }
        }
        return $last;
    }

    /** Pictures as sent: JPEG data URLs, the number expected, each within the size. */
    private static function frames(mixed $frames, int $expected): array
    {
        if (!is_array($frames) || !array_is_list($frames) || count($frames) !== $expected) {
            throw new \InvalidArgumentException("Send {$expected} pictures, one for each step.");
        }
        $out = [];
        foreach ($frames as $frame) {
            if (!is_string($frame) || !str_starts_with($frame, 'data:image/jpeg;base64,')) {
                throw new \InvalidArgumentException('Each picture is a JPEG.');
            }
            $bytes = base64_decode(substr($frame, 23), true);
            if ($bytes === false || strlen($bytes) > self::MAX_FRAME_BYTES || !str_starts_with($bytes, "\xFF\xD8\xFF")) {
                throw new \InvalidArgumentException('A picture is too large or not a JPEG.');
            }
            $out[] = $bytes;
        }
        return $out;
    }

    private function requirementOf(array $app, string $pluginId, string $kind): ?array
    {
        foreach ($this->gate->requirementsOf($app) as $requirement) {
            if ($requirement['plugin'] === $pluginId && $requirement['kind'] === $kind) {
                return $requirement;
            }
        }
        return null;
    }

    private function assertMayStart(string $userId): void
    {
        $this->expireOld($userId);
        $open = $this->pdo->prepare("SELECT COUNT(*) FROM camera_checks WHERE user_id = ? AND status IN ('sending', 'assessing', 'deciding')");
        $open->execute([$userId]);
        if ((int) $open->fetchColumn() > 0) {
            throw new \InvalidArgumentException('Your last check is still being looked at. Wait for it to finish.');
        }
        if ($this->attemptsLeft($userId) < 1) {
            throw new \InvalidArgumentException('You have used today\'s camera checks. Try again tomorrow.');
        }
        // A member's check only: an administrator's trial on themselves leaves no mark on their own real one.
        $last = $this->pdo->prepare("SELECT 1 FROM camera_checks WHERE user_id = ? AND mode = 'member' AND outcome = 'not_confirmed' AND finished_at > ? LIMIT 1");
        $last->execute([$userId, gmdate('Y-m-d H:i:s', time() - self::COOLDOWN_SECONDS)]);
        if ($last->fetchColumn() !== false) {
            throw new \InvalidArgumentException('Your last check could not confirm this. You can try again in an hour.');
        }
        $this->cancelOpen($userId);
    }

    /** One started check at a time: a new one ends any left. */
    private function cancelOpen(string $userId): void
    {
        $this->pdo->prepare("UPDATE camera_checks SET status = 'done', outcome = 'cancelled', finished_at = ?, channel = NULL, turn = NULL WHERE user_id = ? AND status = 'started'")
            ->execute([gmdate('Y-m-d H:i:s'), $userId]);
    }

    /** Checks past their time with OAIY are ended, and their turn given up. */
    private function expireOld(string $userId): void
    {
        $stmt = $this->pdo->prepare("SELECT * FROM camera_checks WHERE user_id = ? AND status IN ('sending', 'assessing', 'deciding') AND expires_at < ?");
        $stmt->execute([$userId, gmdate('Y-m-d H:i:s')]);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            if ($row['relay_id'] !== null) {
                $this->desktop->abandon((string) $row['relay_id'], (string) $row['relay_owner']);
            }
            $this->finish($row, 'unavailable', true);
        }
    }

    private static function expired(array $row): bool
    {
        return strtotime((string) $row['expires_at'] . ' UTC') < time();
    }

    private function row(string $id, string $userId): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM camera_checks WHERE id = ? AND user_id = ?');
        $stmt->execute([$id, $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            throw new \InvalidArgumentException('No such check.');
        }
        return $row;
    }

    /**
     * End a check with its outcome; $refund: it did not run, so it is not a try. A check already
     * ended keeps its outcome: a late expiry or a losing ask never overwrites one.
     */
    private function finish(array $row, string $outcome, bool $refund = false, ?string $message = null): array
    {
        $done = $this->pdo->prepare(
            "UPDATE camera_checks SET status = 'done', outcome = ?, message = ?, finished_at = ?, channel = NULL, turn = NULL" . ($refund ? ', submitted_at = NULL' : '') . " WHERE id = ? AND status <> 'done'"
        );
        $done->execute([$outcome, $message, gmdate('Y-m-d H:i:s'), $row['id']]);
        if ($done->rowCount() !== 1) {
            return $this->row((string) $row['id'], (string) $row['user_id']);
        }
        return ['status' => 'done', 'outcome' => $outcome, 'message' => $message, 'channel' => null, 'turn' => null] + ($refund ? ['submitted_at' => null] : []) + $row;
    }

    private function attemptsLeft(string $userId): int
    {
        $used = $this->pdo->prepare("SELECT COUNT(*) FROM camera_checks WHERE user_id = ? AND mode = 'member' AND submitted_at IS NOT NULL AND submitted_at > ?");
        $used->execute([$userId, gmdate('Y-m-d H:i:s', time() - 86400)]);
        return max(0, self::MAX_ATTEMPTS_PER_DAY - (int) $used->fetchColumn());
    }

    private function describe(array $row, ?array $detail): array
    {
        $status = in_array($row['status'], ['sending', 'deciding'], true) ? 'assessing' : (string) $row['status'];
        $outcome = $row['outcome'];
        $out = [
            'id' => (string) $row['id'],
            'mode' => (string) $row['mode'],
            'status' => $status,
            'outcome' => $outcome,
            // The plugin's words for its outcome when it gave them; the site's own otherwise.
            'message' => $outcome === null ? null : (($row['message'] ?? null) ?: self::message((string) $outcome)),
            'attemptsLeft' => $row['mode'] === 'member' ? $this->attemptsLeft((string) $row['user_id']) : null,
            'expiresAt' => $row['expires_at'],
        ];
        if ($status === 'started') {
            $out['steps'] = json_decode((string) $row['steps'], true);
        }
        if ($detail !== null && $row['mode'] !== 'member') {
            $out['answer'] = $detail;
        }
        return $out;
    }

    /** The site's words for an outcome a plugin gave none for. */
    public static function message(string $outcome): string
    {
        return match ($outcome) {
            'passed' => 'Done.',
            'unavailable' => 'The camera check is not working right now. This did not count as one of your tries.',
            'cancelled' => 'This check was stopped.',
            'not_confirmed' => 'This check could not confirm it. You can try again in an hour.',
            default => 'The check ended.',
        };
    }
}
