<?php

declare(strict_types=1);

namespace FormLogic\Tests\Support;

/**
 * Recordings for the tests of FormLogic's listening (AppListening): RIFF/WAVE files of PCM sound,
 * as a page's recorder makes them, and the same with what a file may also carry.
 */
final class Recording
{
    /**
     * A WAV of $seconds of quiet sound. $says: what the stand-in speech server is to do with it
     * (tests/Support/stub-images-server.php reads `[silent]`, `[broken]`… from the first bytes of
     * the sound). $before: chunks written between the format and the sound, as bytes.
     */
    public static function wav(float $seconds, int $rate = 16000, int $channels = 1, int $bits = 16, string $says = '', string $before = '', int $tag = 1): string
    {
        $frame = $channels * intdiv($bits, 8);
        $frames = (int) round($seconds * $rate);
        // The marker is the sound's first bytes, padded to whole samples; the rest is quiet.
        $marker = $says === '' ? '' : str_pad($says, (int) (ceil(strlen($says) / $frame) * $frame), "\0");
        $pcm = substr($marker . str_repeat("\0", max(0, $frames * $frame - strlen($marker))), 0, $frames * $frame);
        return self::file(self::format($tag, $channels, $rate, $bits) . $before . 'data' . pack('V', strlen($pcm)) . $pcm);
    }

    /** A format chunk: the 16 bytes PCM takes. */
    public static function format(int $tag, int $channels, int $rate, int $bits): string
    {
        $frame = $channels * intdiv($bits, 8);
        return 'fmt ' . pack('VvvVVvv', 16, $tag, $channels, $rate, $rate * $frame, $frame, $bits);
    }

    /** Chunks under a RIFF/WAVE header. */
    public static function file(string $chunks): string
    {
        return 'RIFF' . pack('V', 4 + strlen($chunks)) . 'WAVE' . $chunks;
    }

    /** A chunk of any name, padded to an even length as the format has them. */
    public static function chunk(string $id, string $body): string
    {
        return $id . pack('V', strlen($body)) . $body . (strlen($body) & 1 ? "\0" : '');
    }
}
