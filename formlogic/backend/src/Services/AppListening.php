<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Listening for a hosted SoftN app (docs/HOSTED_APPS.md, "Listening, and offering an app"). An
 * app's frame has no microphone and is never given one. FormLogic's own page records the person,
 * once they have said it may, and sends the recording here; the site's speech server
 * (AI_SPEECH_BASE_URL, the server App AI's lines are said by) puts it into words, and the app is
 * given the words alone.
 *
 * - **On** only where the app's owner allowed it (`settings.softnListen: "allow"`) and the site's
 *   speech server would be asked for this app now (AppAiService::siteSpeaksFor).
 * - **The recording** is a RIFF/WAVE file of PCM sound, a minute at most. It is read here before
 *   anything is sent, and what is sent is that sound under a header written here: nothing else
 *   the file carried goes with it.
 * - **Asked** as OAIY Voice takes one: `POST {speech base}/audio/transcriptions`
 *   {audio: base64 WAV, response_format: "json"}, answered {text}.
 * - **Kept**: nothing. Not the recording, not the words. Only that it happened and how long it
 *   was is counted, in the app's day (AppAiService::heard).
 */
final class AppListening
{
    /** The longest recording put into words, in seconds. */
    public const MAX_SECONDS = 60;
    /** What a recorder's last buffer may add to that: its sound comes in pieces, and the minute ends inside one. */
    private const GRACE_SECONDS = 1;
    /** The largest recording read, decoded: 2.2 MB. A minute at 16 kHz, 16 bits, one channel is 1.92 MB. */
    public const MAX_BYTES = 2306867;
    /** How long the speech server is waited for, in seconds. */
    public const TIMEOUT = 30;
    /** The most of the speech server's answer that is read: a minute's words are a few thousand characters. */
    private const MAX_ANSWER_BYTES = 262144;
    /** The most words given to the app, in characters. */
    private const MAX_TEXT = 8000;

    private const INVALID = 'That recording could not be read. It must be a WAV file of PCM sound.';
    private const TOO_LONG = 'That recording is too long. FormLogic listens for up to a minute at a time.';
    private const FAILED = 'The recording could not be put into words. Try again in a moment.';

    public function __construct(private ?AppAiService $ai, private ?AIService $site, private int $timeout = self::TIMEOUT)
    {
    }

    /**
     * Whether FormLogic listens for this app now: its owner allowed it, the site names a speech
     * server and its AI is on, and App AI would ask that server for this app (the owner's "AI for
     * this app" on this site's AI, with every switch that stops a line being said). An answer that
     * cannot be had is no: the app opens without it.
     */
    public function on(array $app): bool
    {
        $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
        if (($settings['softnListen'] ?? null) !== 'allow' || $this->ai === null || $this->site === null) return false;
        try {
            return $this->site->envSpeech() !== null && $this->ai->siteSpeaksFor($app);
        } catch (\Throwable $e) {
            error_log('App listening: whether it is on could not be read for app ' . (string) ($app['id'] ?? '') . ': ' . get_class($e));
            return false;
        }
    }

    /**
     * The words of a recording made for $app: ['text' => string, 'seconds' => float]. $audio is the
     * recording in base64, with or without `data:audio/wav;base64,` before it. Silence is an answer
     * too, with no words.
     *
     * A recording costs one of the app's AI requests, as a spoken line does, from the same
     * allowances (AppAiService::takeForListening): $requester is who asked, as App AI knows them
     * (['kind' => user|visitor, 'id' => …], or null where nobody is known), and $ip where from.
     * One the speech server could not put into words is given back.
     *
     * @return array{text: string, seconds: float}
     * @throws ListenRefusal listen_off, invalid_audio, too_long, limit_reached or listen_failed
     */
    public function hear(array $app, mixed $audio, ?array $requester = null, string $ip = ''): array
    {
        $speech = $this->on($app) ? $this->site?->envSpeech() : null;
        if ($speech === null) throw new ListenRefusal('Listening is not turned on for this app.', 'listen_off', 403);
        $recording = self::recording($audio);
        unset($audio);
        // Read before anything is counted: a recording that cannot be read costs nothing.
        $taken = $this->ai?->takeForListening((string) $app['id'], $requester, $ip);
        if (isset($taken['refused'])) throw new ListenRefusal($taken['refused']['message'], $taken['refused']['code'], 429);
        try {
            $text = $this->ask($speech, $recording['wav']);
        } catch (ListenRefusal $failed) {
            try {
                if (isset($taken['taken'])) $this->ai?->giveBackListening($taken['taken']);
            } catch (\Throwable $e) {
                error_log('App listening: not given back for app ' . (string) $app['id'] . ': ' . get_class($e));
            }
            throw $failed;
        }
        try {
            $this->ai?->heard((string) $app['id'], $recording['seconds']);
        } catch (\Throwable $e) {
            // The words are the person's to have whether or not the count was written.
            error_log('App listening: not counted for app ' . (string) $app['id'] . ': ' . get_class($e));
        }
        return ['text' => $text, 'seconds' => $recording['seconds']];
    }

    /**
     * A recording as it was sent, read: its sound under a header written here (PCM, as many
     * channels, samples a second and bits a sample as it said), and how long it is.
     *
     * @return array{wav: string, seconds: float}
     * @throws ListenRefusal invalid_audio or too_long
     */
    public static function recording(mixed $audio): array
    {
        if (!is_string($audio) || $audio === '') throw new ListenRefusal(self::INVALID, 'invalid_audio', 400);
        if (strncasecmp($audio, 'data:', 5) === 0) {
            $comma = strpos($audio, ',');
            if ($comma === false || $comma > 64 || preg_match('~^data:audio/(?:wav|wave|x-wav|vnd\.wave);base64$~i', substr($audio, 0, $comma)) !== 1) {
                throw new ListenRefusal(self::INVALID, 'invalid_audio', 400);
            }
            $audio = substr($audio, $comma + 1);
        }
        // Too large before it is decoded: four characters carry three bytes.
        if (strlen($audio) > intdiv(self::MAX_BYTES * 4, 3) + 4096) throw new ListenRefusal(self::TOO_LONG, 'too_long', 413);
        $wav = base64_decode($audio, true);
        unset($audio);
        if ($wav === false || strlen($wav) < 12 || substr($wav, 0, 4) !== 'RIFF' || substr($wav, 8, 4) !== 'WAVE') {
            throw new ListenRefusal(self::INVALID, 'invalid_audio', 400);
        }
        if (strlen($wav) > self::MAX_BYTES) throw new ListenRefusal(self::TOO_LONG, 'too_long', 413);

        // The file's chunks, each a name and a length: the format, and the sound. Others are passed over.
        $size = strlen($wav);
        $format = null;
        $sound = null;
        for ($at = 12; $at + 8 <= $size && ($format === null || $sound === null);) {
            $id = substr($wav, $at, 4);
            $length = self::number($wav, $at + 4, 'V');
            $start = $at + 8;
            // A recording written as it was made may say a length past its end: what is there is taken.
            $end = min($size, $start + $length);
            if ($id === 'fmt ' && $format === null) {
                if ($end - $start < 16) throw new ListenRefusal(self::INVALID, 'invalid_audio', 400);
                $format = ['tag' => self::number($wav, $start, 'v'), 'channels' => self::number($wav, $start + 2, 'v'), 'rate' => self::number($wav, $start + 4, 'V'), 'bits' => self::number($wav, $start + 14, 'v')];
                // WAVE_FORMAT_EXTENSIBLE: what the sound is, is the first two bytes of its sub-format.
                if ($format['tag'] === 0xFFFE && $end - $start >= 26) $format['tag'] = self::number($wav, $start + 24, 'v');
            } elseif ($id === 'data' && $sound === null) {
                $sound = [$start, $end - $start];
            }
            // Chunks are padded to an even length.
            $at = $start + $length + ($length & 1);
        }
        if ($format === null || $sound === null) throw new ListenRefusal(self::INVALID, 'invalid_audio', 400);
        // PCM alone, of a shape a recorder makes: one or two channels, 8 to 96 kHz, 8 to 32 bits.
        if ($format['tag'] !== 1 || !in_array($format['channels'], [1, 2], true) || $format['rate'] < 8000 || $format['rate'] > 96000 || !in_array($format['bits'], [8, 16, 24, 32], true)) {
            throw new ListenRefusal(self::INVALID, 'invalid_audio', 400);
        }
        $frame = $format['channels'] * intdiv($format['bits'], 8);
        $frames = intdiv($sound[1], $frame);
        if ($frames === 0) throw new ListenRefusal('That recording is empty.', 'invalid_audio', 400);
        $seconds = $frames / $format['rate'];
        if ($seconds > self::MAX_SECONDS + self::GRACE_SECONDS) throw new ListenRefusal(self::TOO_LONG, 'too_long', 413);
        $pcm = substr($wav, $sound[0], $frames * $frame);
        unset($wav);
        return [
            'wav' => 'RIFF' . pack('V', 36 + strlen($pcm)) . 'WAVEfmt ' . pack('VvvVVvv', 16, 1, $format['channels'], $format['rate'], $format['rate'] * $frame, $frame, $format['bits']) . 'data' . pack('V', strlen($pcm)) . $pcm,
            'seconds' => round($seconds, 2),
        ];
    }

    /** A little-endian number of the file: 'v' two bytes, 'V' four. */
    private static function number(string $bytes, int $at, string $kind): int
    {
        $read = unpack($kind, $bytes, $at);
        return is_array($read) ? (int) $read[1] : 0;
    }

    /**
     * Ask the speech server for the recording's words. Whatever goes wrong there is one refusal to
     * the page, in a plain sentence; what the server said is for the server's log, and is never what
     * was heard.
     *
     * @param array{url: string, key: string, model: string, voice: string} $speech
     */
    private function ask(array $speech, string $wav): string
    {
        $failed = static function (string $why): ListenRefusal {
            error_log('App listening: ' . $why);
            return new ListenRefusal(self::FAILED, 'listen_failed', 502);
        };
        if (!function_exists('curl_init')) throw $failed('PHP has no curl here');
        $handle = curl_init(rtrim($speech['url'], '/') . '/audio/transcriptions');
        if ($handle === false) throw $failed('the request could not be made');
        // `Expect:` empty: the recording is sent at once, not after a second's wait for a server that never says to go on.
        $headers = ['Content-Type: application/json', 'Accept: application/json', 'Expect:'];
        if ($speech['key'] !== '') $headers[] = 'Authorization: Bearer ' . $speech['key'];
        $answer = '';
        curl_setopt_array($handle, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode(['audio' => base64_encode($wav), 'response_format' => 'json'], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR),
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_TIMEOUT => $this->timeout,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            // No more of an answer is read than words take: past it the transfer is ended.
            CURLOPT_WRITEFUNCTION => static function ($handle, string $data) use (&$answer): int {
                if (strlen($answer) + strlen($data) > self::MAX_ANSWER_BYTES) return 0;
                $answer .= $data;
                return strlen($data);
            },
        ]);
        unset($wav);
        curl_exec($handle);
        $error = curl_errno($handle);
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        if ($error === CURLE_OPERATION_TIMEDOUT) throw $failed('the speech server did not answer in ' . $this->timeout . ' seconds');
        if ($error === CURLE_WRITE_ERROR) throw $failed('the speech server answered more than words take');
        if ($error !== CURLE_OK) throw $failed('the speech server could not be reached (curl ' . $error . ')');
        $json = json_decode($answer, true);
        if ($status < 200 || $status >= 300) {
            $said = is_array($json) ? (is_array($json['error'] ?? null) ? ($json['error']['message'] ?? null) : ($json['error'] ?? $json['message'] ?? null)) : null;
            throw $failed('the speech server answered HTTP ' . $status . (is_string($said) && trim($said) !== '' ? ': ' . mb_substr(trim($said), 0, 200) : ''));
        }
        if (!is_array($json) || !is_string($json['text'] ?? null)) throw $failed('the speech server answered without words');
        return mb_substr(trim($json['text']), 0, self::MAX_TEXT);
    }
}
