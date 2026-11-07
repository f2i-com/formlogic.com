<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * How a hosted SoftN app looks before it opens and wherever it is shared: its icon (a browser tab,
 * a home screen, the app once installed), its share image and description (what a link to it
 * shows), and its loading view's colours. The owner's choices come first (settings.softnLook), then
 * what the app's own manifest names (`icon`, `description`). Every image is one of the app's own
 * media files, drawn here at the sizes a browser asks for: nothing is fetched from elsewhere.
 */
final class AppLookService
{
    /** Icon sizes served as PNG: a tab, Apple's home screen, and the two an installed app needs. */
    public const ICON_SIZES = [32, 180, 192, 512];
    /** What a link preview shows, the proportions every service crops to. */
    public const SHARE_WIDTH = 1200;
    public const SHARE_HEIGHT = 630;
    /** A raster image of the app's: drawn at each size here. */
    private const RASTER = '~^assets/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+\.(?:png|jpe?g|gif|webp)$~Di';
    /** An SVG of the app's, for its icon only: sent as it is, under a policy that runs nothing in it. */
    private const VECTOR = '~^assets/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+\.svg$~Di';
    private const HEX = '/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/';
    /** No bitmap is decoded past this, whatever a small file claims: an icon or a preview needs no more. */
    private const MAX_PIXELS = 16_000_000;

    public function __construct(private NativeAppService $native) {}

    /** settings.softnLook held to its shape: anything else is dropped. */
    public static function sanitize(mixed $look): array
    {
        if (!is_array($look)) return [];
        $out = [];
        foreach (['icon' => true, 'shareImage' => false] as $field => $svg) {
            $path = $look[$field] ?? null;
            if (is_string($path) && strlen($path) <= 300 && !str_contains($path, '..')
                && (preg_match(self::RASTER, $path) || ($svg && preg_match(self::VECTOR, $path)))) {
                $out[$field] = $path;
            }
        }
        if (is_string($look['description'] ?? null)) {
            $description = self::plain($look['description']);
            if ($description !== '') $out['description'] = $description;
        }
        foreach (['background', 'spinner'] as $field) {
            if (is_string($look[$field] ?? null) && preg_match(self::HEX, $look[$field])) $out[$field] = strtolower($look[$field]);
        }
        return $out;
    }

    /** One line of plain text, at most 300 characters; '' for anything else. */
    private static function plain(string $text): string
    {
        $flat = preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $text);
        return is_string($flat) ? mb_substr(trim(preg_replace('/\s+/u', ' ', $flat) ?? ''), 0, 300) : '';
    }

    /**
     * The look of a SoftN app as it is served: null for any other app. `icon` and `shareImage` are
     * media files the installed app has; `version` changes whenever the app or its look does, so a
     * browser may keep an image addressed with it for good.
     *
     * @return array{icon: ?string, iconKind: ?string, shareImage: ?string, description: string, background: ?string, spinner: ?string, themeColor: ?string, version: string}|null
     */
    public function resolve(array $app): ?array
    {
        $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
        if (empty($settings['softnApp'])) return null;
        $chosen = self::sanitize($settings['softnLook'] ?? null);
        $manifest = [];
        $paths = [];
        $media = '';
        $runtime = null;
        try {
            $runtime = $this->native->runtimeProject((string) $app['id']);
            if ($runtime !== null) {
                $decoded = json_decode((string) ($runtime['project']['files']['manifest.json'] ?? ''), true);
                $manifest = is_array($decoded) ? $decoded : [];
                $media = (string) ($runtime['media']['sha256'] ?? '');
                $paths = array_flip($this->native->mediaPaths((string) $app['id']));
            }
        } catch (\Throwable) {
            // Nothing installed, or an update under way: the look without its images.
        }
        $usable = static fn(mixed $path, bool $svg): bool => is_string($path) && isset($paths[$path])
            && (preg_match(self::RASTER, $path) || ($svg && preg_match(self::VECTOR, $path)));
        $background = $chosen['background'] ?? null;
        // A raster image counts once it has been drawn (a file this server's GD cannot read, or too
        // large, does not): an app whose icon cannot be served keeps FormLogic's.
        $appId = (string) $app['id'];
        $key = $runtime !== null ? $this->native->projectKey($appId) : null;
        $drawable = fn(string $path, int $w, int $h, ?string $fill, float $inset): bool => $key !== null && $this->drawable($appId, $key, $path, $w, $h, $fill, $inset);
        $icon = null;
        foreach ([$chosen['icon'] ?? null, $manifest['icon'] ?? null] as $candidate) {
            if ($usable($candidate, true) && (preg_match(self::VECTOR, $candidate) || $drawable($candidate, 192, 192, null, 1.0))) { $icon = $candidate; break; }
        }
        $iconKind = $icon === null ? null : (preg_match(self::VECTOR, $icon) ? 'svg' : 'raster');
        // A link shows the share image, else a raster icon: a preview cannot show SVG.
        $share = null;
        foreach ([$chosen['shareImage'] ?? null, $iconKind === 'raster' ? $icon : null] as $candidate) {
            if ($usable($candidate, false) && $drawable($candidate, self::SHARE_WIDTH, self::SHARE_HEIGHT, $background ?? '#111827', 0.86)) { $share = $candidate; break; }
        }
        $description = $chosen['description']
            ?? (is_string($manifest['description'] ?? null) ? self::plain($manifest['description']) : '');
        if ($description === '' && is_string($app['description'] ?? null)) $description = self::plain($app['description']);
        $theme = is_string($settings['pwaThemeColor'] ?? null) && preg_match(self::HEX, $settings['pwaThemeColor']) ? strtolower($settings['pwaThemeColor']) : null;
        $look = [
            'icon' => $icon,
            'iconKind' => $iconKind,
            'shareImage' => $share,
            'description' => $description,
            'background' => $background,
            'spinner' => $chosen['spinner'] ?? null,
            'themeColor' => $theme,
        ];
        $look['version'] = substr(hash('sha256', $media . "\0" . json_encode($look)), 0, 16);
        return $look;
    }

    /**
     * One image of an app's look, by the name it is served at: `icon-<32|180|192|512>.png`,
     * `icon-512-maskable.png`, `share.png`, or `icon.svg` where the icon is SVG. Null where the app
     * has no such image.
     *
     * @return array{bytes: string, type: string}|null
     */
    public function image(array $app, string $name): ?array
    {
        $look = $this->resolve($app);
        if ($look === null) return null;
        $appId = (string) $app['id'];
        if ($name === 'icon.svg') {
            if ($look['iconKind'] !== 'svg') return null;
            $bytes = $this->native->mediaFile($appId, (string) $look['icon']);
            return $bytes === null ? null : ['bytes' => $bytes, 'type' => 'image/svg+xml'];
        }
        if (preg_match('/^icon-(32|180|192|512)(-maskable)?\.png$/D', $name, $match)) {
            if ($look['iconKind'] !== 'raster') return null;
            $size = (int) $match[1];
            $maskable = ($match[2] ?? '') !== '';
            if ($maskable && $size !== 512) return null;
            // Apple's home screen draws transparency black, and a maskable icon is cut to whatever
            // shape a launcher likes: both sit on the loading background, the second within its
            // safe zone (the middle 80%).
            $fill = $size === 180 || $maskable ? ($look['background'] ?? '#ffffff') : null;
            return $this->drawn($appId, (string) $look['icon'], $size, $size, $fill, $maskable ? 0.8 : 1.0);
        }
        if ($name === 'share.png') {
            if ($look['shareImage'] === null) return null;
            return $this->drawn($appId, $look['shareImage'], self::SHARE_WIDTH, self::SHARE_HEIGHT, $look['background'] ?? '#111827', 0.86);
        }
        return null;
    }

    /** The name derived() keeps a drawing under: what it is drawn from, and how. */
    private static function drawing(string $path, int $width, int $height, ?string $fill, float $inset): string
    {
        return "look\0$path\0{$width}x{$height}\0" . ($fill ?? '') . "\0$inset";
    }

    /**
     * Whether $path draws at that size, as far as is known: false once drawing it failed, true until
     * then. Nothing is drawn here: the page that asks for the image draws it (image()), so a request
     * that only describes the app never decodes a picture, and a failure is known from the next one.
     */
    private function drawable(string $appId, string $key, string $path, int $width, int $height, ?string $fill, float $inset): bool
    {
        // A picture that failed at any size fails at every size: it could not be decoded.
        if ($this->native->derivedState($appId, self::source($path), $key) === false) return false;
        return $this->native->derivedState($appId, self::drawing($path, $width, $height, $fill, $inset), $key) ?? true;
    }

    /** The name a failure to draw $path at all is kept under. */
    private static function source(string $path): string
    {
        return "source\0$path";
    }

    /** @return array{bytes: string, type: string}|null */
    private function drawn(string $appId, string $path, int $width, int $height, ?string $fill, float $inset): ?array
    {
        $bytes = $this->native->derived($appId, self::drawing($path, $width, $height, $fill, $inset), function () use ($appId, $path, $width, $height, $fill, $inset): ?string {
            $source = $this->native->mediaFile($appId, $path);
            return $source === null ? null : self::draw($source, $width, $height, $fill, $inset);
        });
        if ($bytes === null) {
            // Known for the picture itself, so the look stops naming it at every size.
            $this->native->derived($appId, self::source($path), static fn(): ?string => null);
            return null;
        }
        return ['bytes' => $bytes, 'type' => self::typeOf($bytes)];
    }

    /**
     * $source drawn into $width x $height as PNG: its proportions kept, as large as fits in $inset
     * of the box, centred, on $fill or on transparency. A PNG, JPEG, GIF or WebP only, never one
     * claiming more than MAX_PIXELS. Without GD, the source as it is (still an image a browser shows).
     */
    public static function draw(string $source, int $width, int $height, ?string $fill, float $inset): ?string
    {
        $info = @getimagesizefromstring($source);
        if ($info === false) return null;
        [$w, $h, $type] = $info;
        if (!in_array($type, [IMAGETYPE_PNG, IMAGETYPE_JPEG, IMAGETYPE_GIF, IMAGETYPE_WEBP], true)) return null;
        if ($w < 1 || $h < 1 || $w > 8192 || $h > 8192 || $w * $h > self::MAX_PIXELS) return null;
        if (!function_exists('imagecreatefromstring') || !function_exists('imagepng')) return $source;
        // The decoded bitmap is four bytes a pixel. Where the host gives no room for it, it is not
        // decoded: running out of memory would end the request with nothing recorded.
        if (!NativeAppService::raiseMemoryFor($w * $h)) return null;
        $image = @imagecreatefromstring($source);
        if ($image === false) return null;
        $canvas = imagecreatetruecolor($width, $height);
        if ($canvas === false) return null;
        imagealphablending($canvas, false);
        imagesavealpha($canvas, true);
        if ($fill !== null) {
            [$r, $g, $b] = self::rgb($fill);
            imagefilledrectangle($canvas, 0, 0, $width - 1, $height - 1, (int) imagecolorallocate($canvas, $r, $g, $b));
        } else {
            imagefilledrectangle($canvas, 0, 0, $width - 1, $height - 1, (int) imagecolorallocatealpha($canvas, 0, 0, 0, 127));
        }
        imagealphablending($canvas, true);
        $scale = min($width * $inset / $w, $height * $inset / $h);
        $dw = max(1, (int) round($w * $scale));
        $dh = max(1, (int) round($h * $scale));
        imagecopyresampled($canvas, $image, intdiv($width - $dw, 2), intdiv($height - $dh, 2), 0, 0, $dw, $dh, $w, $h);
        ob_start();
        $ok = imagepng($canvas, null, 9);
        $png = ob_get_clean();
        return $ok && is_string($png) && $png !== '' ? $png : null;
    }

    /** @return array{0: int, 1: int, 2: int} */
    private static function rgb(string $hex): array
    {
        $hex = ltrim($hex, '#');
        if (strlen($hex) === 3) $hex = $hex[0] . $hex[0] . $hex[1] . $hex[1] . $hex[2] . $hex[2];
        return [(int) hexdec(substr($hex, 0, 2)), (int) hexdec(substr($hex, 2, 2)), (int) hexdec(substr($hex, 4, 2))];
    }

    /** The image type its first bytes say. */
    public static function typeOf(string $bytes): string
    {
        return match (true) {
            str_starts_with($bytes, "\x89PNG") => 'image/png',
            str_starts_with($bytes, "\xFF\xD8") => 'image/jpeg',
            str_starts_with($bytes, 'GIF8') => 'image/gif',
            str_starts_with($bytes, 'RIFF') && substr($bytes, 8, 4) === 'WEBP' => 'image/webp',
            default => 'application/octet-stream',
        };
    }

    /** Where an image of the look is served for $slug, under the API's own base. */
    public static function imagePath(string $slug, string $name, string $version): string
    {
        return '/api/app/' . rawurlencode($slug) . '/look/' . $name . '?v=' . $version;
    }

    /**
     * The icons a web app manifest lists for the look, each at $prefix plus its name: a path relative
     * to the manifest's own address (`look/` beside /api/app/<slug>/manifest.json), which is the API's
     * wherever the API is, or a root path on a domain. [] where it has no icon of its own.
     *
     * @param array{icon: ?string, iconKind: ?string, version: string} $look
     * @return list<array<string, string>>
     */
    public static function manifestIcons(array $look, string $prefix): array
    {
        $src = static fn(string $name): string => $prefix . $name . '?v=' . $look['version'];
        if ($look['iconKind'] === 'svg') {
            return [['src' => $src('icon.svg'), 'sizes' => 'any', 'type' => 'image/svg+xml', 'purpose' => 'any']];
        }
        if ($look['iconKind'] !== 'raster') return [];
        return [
            ['src' => $src('icon-192.png'), 'sizes' => '192x192', 'type' => 'image/png', 'purpose' => 'any'],
            ['src' => $src('icon-512.png'), 'sizes' => '512x512', 'type' => 'image/png', 'purpose' => 'any'],
            ['src' => $src('icon-512-maskable.png'), 'sizes' => '512x512', 'type' => 'image/png', 'purpose' => 'maskable'],
        ];
    }
}
