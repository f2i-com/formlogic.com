<?php
declare(strict_types=1);

namespace FormLogic\Services;

/** Public pricing and payment opt-in; readable without a database connection. */
class PlatformPlansService
{
    public function __construct(private ?string $path = null)
    {
        $this->path ??= dirname(__DIR__, 2) . '/storage/platform-plans.json';
    }

    public static function defaults(): array
    {
        return [
            'paymentsEnabled' => false,
            'freeName' => 'Free',
            'freeDescription' => 'Build forms and apps with your own AI. No card required.',
            'paidName' => 'Supporter',
            'paidDescription' => 'Help support FormLogic development. The free workspace stays available to everyone.',
            'pricePerMonthCents' => 500,
            'currency' => 'USD',
            'siteAiEnabled' => false,
        ];
    }

    public function status(): array
    {
        $raw = @file_get_contents($this->path);
        if ($raw === false) return self::defaults();
        try {
            return $this->validate(json_decode($raw, true, 16, JSON_THROW_ON_ERROR));
        } catch (\Throwable) {
            // Missing/corrupt configuration must never enable purchases or hosted AI.
            return self::defaults();
        }
    }

    private function validate(mixed $data): array
    {
        if (!is_array($data)) throw new \InvalidArgumentException('Plan settings must be an object.');
        $out = self::defaults();
        foreach (['paymentsEnabled', 'siteAiEnabled'] as $key) {
            if (!is_bool($data[$key] ?? null)) throw new \InvalidArgumentException("$key must be a boolean.");
            $out[$key] = $data[$key];
        }
        foreach (['freeName' => 60, 'paidName' => 60, 'freeDescription' => 300, 'paidDescription' => 300] as $key => $max) {
            $value = $data[$key] ?? null;
            if (!is_string($value) || trim($value) === '' || mb_strlen($value) > $max) {
                throw new \InvalidArgumentException("$key must contain 1-$max characters.");
            }
            $out[$key] = trim($value);
        }
        $price = $data['pricePerMonthCents'] ?? null;
        if (!is_int($price) || $price < 100 || $price > 100000) {
            throw new \InvalidArgumentException('Price must be between 100 and 100000 cents.');
        }
        if (($data['currency'] ?? '') !== 'USD') throw new \InvalidArgumentException('Only USD is currently supported.');
        $out['pricePerMonthCents'] = $price;
        return $out;
    }

    public function save(array $data): array
    {
        $out = $this->validate($data);
        $dir = dirname($this->path);
        if (!is_dir($dir) && !@mkdir($dir, 0750, true) && !is_dir($dir)) throw new \RuntimeException('Plan settings storage is unavailable.');
        $tmp = tempnam($dir, '.plans-');
        if ($tmp === false) throw new \RuntimeException('Cannot save plan settings.');
        try {
            if (file_put_contents($tmp, json_encode($out, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR), LOCK_EX) === false || !rename($tmp, $this->path)) {
                throw new \RuntimeException('Cannot save plan settings.');
            }
        } finally {
            if (is_file($tmp)) @unlink($tmp);
        }
        return $out;
    }
}
