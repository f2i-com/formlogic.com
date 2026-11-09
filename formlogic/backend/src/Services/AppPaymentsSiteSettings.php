<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * The administrator's settings for app payments (docs/FREE_PLANS_AND_AI_SETUP.md, "App payments"),
 * kept in storage/app-payments.json beside app-ai.json. A missing or unreadable file is the safe
 * default: no app takes payments.
 *
 * v1 takes money into the site's own PayPal account, so only apps owned by an administrator can take
 * payments at all (AppWalletService::availability), whatever is set here.
 */
class AppPaymentsSiteSettings
{
    /** The smallest top-up: PayPal's fixed fee makes less poor value. */
    public const MIN_PACKAGE_CENTS = 200;
    public const MAX_PACKAGE_CENTS = 10000;
    public const MAX_PACKAGES = 6;
    /** The most one item may cost, as an app declares it (AppFormlogicManifest). */
    public const MAX_PRICE_CENTS = 500;

    public function __construct(private ?string $path = null)
    {
        $this->path ??= dirname(__DIR__, 2) . '/storage/app-payments.json';
    }

    public static function defaults(): array
    {
        return [
            // Whether apps (an administrator's) may take payments from their visitors' balances.
            'enabled' => false,
            // The top-ups a visitor may buy, in US cents, smallest first.
            'packages' => [200, 500, 1000],
            // The most one charge may be, whatever an owner sets.
            'maxChargeCents' => self::MAX_PRICE_CENTS,
            // The most one wallet may spend in a day (UTC).
            'dailyLimitCents' => 500,
        ];
    }

    public function current(): array
    {
        $raw = @file_get_contents($this->path);
        if ($raw === false) return self::defaults();
        try {
            return self::validate(json_decode($raw, true, 8, JSON_THROW_ON_ERROR));
        } catch (\Throwable) {
            return self::defaults();
        }
    }

    /** Validate and save a whole settings object; answers what was saved. */
    public function save(array $data): array
    {
        $out = self::validate($data);
        $dir = dirname($this->path);
        if (!is_dir($dir) && !@mkdir($dir, 0750, true) && !is_dir($dir)) throw new \RuntimeException('App payment settings storage is unavailable.');
        $tmp = tempnam($dir, '.app-payments-');
        if ($tmp === false) throw new \RuntimeException('Cannot save the app payment settings.');
        try {
            if (file_put_contents($tmp, json_encode($out, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR), LOCK_EX) === false || !rename($tmp, $this->path)) {
                throw new \RuntimeException('Cannot save the app payment settings.');
            }
        } finally {
            if (is_file($tmp)) @unlink($tmp);
        }
        return $out;
    }

    public static function validate(mixed $data): array
    {
        if (!is_array($data)) throw new \InvalidArgumentException('App payment settings must be an object.');
        $out = self::defaults();
        if (array_key_exists('enabled', $data)) {
            if (!is_bool($data['enabled'])) throw new \InvalidArgumentException('enabled must be true or false.');
            $out['enabled'] = $data['enabled'];
        }
        if (array_key_exists('packages', $data)) {
            $packages = $data['packages'];
            if (!is_array($packages) || !array_is_list($packages) || $packages === [] || count($packages) > self::MAX_PACKAGES) {
                throw new \InvalidArgumentException('Offer 1 to ' . self::MAX_PACKAGES . ' top-ups.');
            }
            foreach ($packages as $cents) {
                if (!is_int($cents) || $cents < self::MIN_PACKAGE_CENTS || $cents > self::MAX_PACKAGE_CENTS) {
                    throw new \InvalidArgumentException('Each top-up is a whole number of cents from ' . self::MIN_PACKAGE_CENTS . ' ($2) to ' . self::MAX_PACKAGE_CENTS . '.');
                }
            }
            $packages = array_values(array_unique($packages));
            sort($packages);
            $out['packages'] = $packages;
        }
        if (array_key_exists('maxChargeCents', $data)) $out['maxChargeCents'] = AppAiSiteSettings::limit($data['maxChargeCents'], 'maxChargeCents', [1, self::MAX_PRICE_CENTS]);
        if (array_key_exists('dailyLimitCents', $data)) $out['dailyLimitCents'] = AppAiSiteSettings::limit($data['dailyLimitCents'], 'dailyLimitCents', [1, 100000]);
        return $out;
    }
}
