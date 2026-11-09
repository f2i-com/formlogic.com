<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * The administrator's settings for App AI (docs/FREE_PLANS_AND_AI_SETUP.md, "AI for apps"), kept in
 * storage/app-ai.json beside platform-plans.json and site-ai-desktop.json. A missing or unreadable
 * file is the safe default: apps may not use the site's AI, and nothing is paused or allowed beyond
 * the default limits.
 */
class AppAiSiteSettings
{
    /** Each kind of limit: [lowest, highest] an administrator or owner may set. */
    public const LIMITS = [
        'perRequesterDay' => [0, 1000],
        'perIpDay' => [0, 5000],
        'perIpHour' => [0, 1000],
        'perAppDay' => [0, 100000],
    ];
    public const MAX_WORDS = 500;

    public function __construct(private ?string $path = null)
    {
        $this->path ??= dirname(__DIR__, 2) . '/storage/app-ai.json';
    }

    public static function defaults(): array
    {
        return [
            // Whether apps may use the site's own AI (its OAIY, or the .env upstream).
            'allowApps' => false,
            // Every app's AI stops taking jobs: the administrator's kill switch.
            'paused' => false,
            // The picture model apps' pictures use on the site's AI: an OAIY Engines image entry id
            // (or the .env upstream's model name). None chosen: no pictures.
            'pictureModel' => null,
            // The chat model for apps on the site's AI; null uses the site AI's own.
            'chatModel' => null,
            // What a new app's owner starts from.
            'defaults' => ['perRequesterDay' => 10, 'perIpDay' => 20, 'perIpHour' => 10, 'perAppDay' => 500],
            // Jobs the site's AI takes from every app together in a day.
            'siteDay' => 2000,
            // Words and phrases a prompt may not contain (case-insensitive, whole words).
            'words' => [],
        ];
    }

    public function current(): array
    {
        $raw = @file_get_contents($this->path);
        if ($raw === false) return self::defaults();
        try {
            return self::validate(json_decode($raw, true, 16, JSON_THROW_ON_ERROR));
        } catch (\Throwable) {
            // Unreadable settings never let apps use the site's AI.
            return self::defaults();
        }
    }

    /** Validate and save a whole settings object; answers what was saved. */
    public function save(array $data): array
    {
        $out = self::validate($data);
        $dir = dirname($this->path);
        if (!is_dir($dir) && !@mkdir($dir, 0750, true) && !is_dir($dir)) throw new \RuntimeException('App AI settings storage is unavailable.');
        $tmp = tempnam($dir, '.app-ai-');
        if ($tmp === false) throw new \RuntimeException('Cannot save the App AI settings.');
        try {
            if (file_put_contents($tmp, json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), LOCK_EX) === false || !rename($tmp, $this->path)) {
                throw new \RuntimeException('Cannot save the App AI settings.');
            }
        } finally {
            if (is_file($tmp)) @unlink($tmp);
        }
        return $out;
    }

    /** A validated settings object from $data; anything missing takes its default. */
    public static function validate(mixed $data): array
    {
        if (!is_array($data)) throw new \InvalidArgumentException('App AI settings must be an object.');
        $out = self::defaults();
        foreach (['allowApps', 'paused'] as $key) {
            if (array_key_exists($key, $data)) {
                if (!is_bool($data[$key])) throw new \InvalidArgumentException("{$key} must be true or false.");
                $out[$key] = $data[$key];
            }
        }
        foreach (['pictureModel', 'chatModel'] as $key) {
            if (array_key_exists($key, $data)) $out[$key] = self::model($data[$key], $key);
        }
        if (array_key_exists('defaults', $data)) {
            if (!is_array($data['defaults'])) throw new \InvalidArgumentException('defaults must be an object.');
            foreach (self::LIMITS as $key => $range) {
                if (array_key_exists($key, $data['defaults'])) $out['defaults'][$key] = self::limit($data['defaults'][$key], $key, $range);
            }
        }
        if (array_key_exists('siteDay', $data)) $out['siteDay'] = self::limit($data['siteDay'], 'siteDay', [0, 1000000]);
        if (array_key_exists('words', $data)) $out['words'] = self::words($data['words']);
        return $out;
    }

    /** A model id as OAIY or an OpenAI-compatible upstream names one, or null. */
    public static function model(mixed $value, string $label = 'The model'): ?string
    {
        if ($value === null || $value === '') return null;
        if (!is_string($value) || strlen($value) > 256 || preg_match('/[\x00-\x1f\x7f]/', $value)) throw new \InvalidArgumentException("{$label} must be a model id of up to 256 characters.");
        return trim($value);
    }

    /** A whole number within $range. */
    public static function limit(mixed $value, string $label, array $range): int
    {
        if (!is_int($value) || $value < $range[0] || $value > $range[1]) throw new \InvalidArgumentException("{$label} must be a whole number from {$range[0]} to {$range[1]}.");
        return $value;
    }

    /** @return list<string> */
    private static function words(mixed $value): array
    {
        if (!is_array($value) || !array_is_list($value) || count($value) > self::MAX_WORDS) throw new \InvalidArgumentException('words must be a list of up to ' . self::MAX_WORDS . ' words or phrases.');
        $words = [];
        foreach ($value as $word) {
            if (!is_string($word)) throw new \InvalidArgumentException('Each word must be text.');
            $word = mb_strtolower(trim(preg_replace('/\s+/u', ' ', $word) ?? ''));
            if ($word === '') continue;
            if (mb_strlen($word) > 60) throw new \InvalidArgumentException('Each word or phrase may be up to 60 characters.');
            $words[$word] = true;
        }
        return array_keys($words);
    }

    /** The first word of $words that $text contains as a whole word or phrase, or null. */
    public static function refusedWord(string $text, array $words): ?string
    {
        if ($words === []) return null;
        $lower = mb_strtolower($text);
        foreach ($words as $word) {
            if (preg_match('/(?<![\p{L}\p{N}])' . preg_quote((string) $word, '/') . '(?![\p{L}\p{N}])/u', $lower)) return (string) $word;
        }
        return null;
    }
}
