<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * The pictures App AI hands on, redrawn with PHP's GD so that what reaches an app, or OAIY, is a plain
 * picture and nothing else: decoded from its bytes, held to a size, written again without any of the
 * original's metadata.
 *
 * - **What an app is delivered** (contract §0.2): at most 1,500,000 bytes as a data URL, so the app
 *   can store it in one SQL call (2 MiB of arguments) and send it to its page in one answer (3 MiB).
 *   A JPEG (what OAIY sends, to fit its 256 KiB frame) comes back a *baseline* JPEG of up to 1024 px,
 *   never a PNG, which would only make it bigger. A PNG (what the .env upstream may send) stays a PNG
 *   while it fits, at 1024, 896, then 768 px; past that it becomes a baseline JPEG at 1024 px. Never
 *   WebP, never progressive: 5CD's own decoder reads PNG and baseline JPEG alone.
 * - **An edit's reference**, for the lane: a baseline JPEG small enough that the whole sealed request
 *   stays under 256 KiB (about 170 KB of picture).
 */
final class AppAiPictures
{
    public const MAX_DATA_URL = 1500000;
    public const MAX_SIDE = 1024;
    /** What a picture may be before it is decoded: a side and a pixel count, so a decompression bomb is refused unopened. */
    public const MAX_SOURCE_SIDE = 8192;
    public const MAX_SOURCE_PIXELS = 40000000;
    /** An edit's reference on the lane: OAIY takes 256 KiB decoded, and the whole sealed request 256 KiB. */
    public const MAX_REFERENCE_BYTES = 170000;

    /** Whether this server can redraw pictures: GD with PNG and JPEG (WebP is read where GD has it). */
    public static function available(): bool
    {
        return function_exists('imagecreatefromstring') && function_exists('imagepng') && function_exists('imagejpeg');
    }

    /**
     * A picture the AI made, as an app is given it.
     *
     * @return array{dataUrl: string, mimeType: string, width: int, height: int}
     * @throws \RuntimeException when it is not a picture this server can read, or cannot be made to fit
     */
    public static function deliverable(string $bytes): array
    {
        [$image, $type] = self::open($bytes);
        if ($type === IMAGETYPE_JPEG) return self::jpegLadder($image, self::MAX_SIDE, self::MAX_DATA_URL);
        foreach ([1024, 896, 768] as $side) {
            $png = self::png($image, $side);
            if ($png !== null && strlen($png['dataUrl']) <= self::MAX_DATA_URL) return $png;
        }
        return self::jpegLadder($image, self::MAX_SIDE, self::MAX_DATA_URL);
    }

    /**
     * An edit's picture as the app sent it (a PNG, JPEG or WebP data URL), redrawn as a baseline JPEG
     * of at most $maxBytes, for the sealed request.
     *
     * @throws \RuntimeException for a data URL that is not such a picture
     */
    public static function reference(string $dataUrl, int $maxBytes = self::MAX_REFERENCE_BYTES): string
    {
        if (!preg_match('#^data:image/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$#D', $dataUrl, $m)) throw new \RuntimeException('not_a_picture');
        $bytes = base64_decode($m[1], true);
        if ($bytes === false) throw new \RuntimeException('not_a_picture');
        [$image] = self::open($bytes);
        // Base64 is 4/3 the bytes, and the data URL's prefix is 23 characters.
        return self::jpegLadder($image, self::MAX_SIDE, (int) floor($maxBytes * 4 / 3) + 23, true)['dataUrl'];
    }

    /** Whether a JPEG is baseline: its frame header is SOF0 or SOF1, never SOF2 (progressive) or another. */
    public static function isBaselineJpeg(string $bytes): bool
    {
        $length = strlen($bytes);
        if ($length < 4 || $bytes[0] !== "\xFF" || $bytes[1] !== "\xD8") return false;
        $offset = 2;
        while ($offset + 4 <= $length) {
            if ($bytes[$offset] !== "\xFF") return false;
            $marker = ord($bytes[$offset + 1]);
            if ($marker === 0xC0 || $marker === 0xC1) return true;
            if ($marker >= 0xC2 && $marker <= 0xCF && $marker !== 0xC4 && $marker !== 0xC8 && $marker !== 0xCC) return false;
            $segment = (ord($bytes[$offset + 2]) << 8) | ord($bytes[$offset + 3]);
            $offset += 2 + $segment;
        }
        return false;
    }

    /**
     * Decode bytes into a GD image, refused unopened when they are not a PNG, JPEG or WebP of a sane
     * size. Answers [image, IMAGETYPE_*].
     *
     * @return array{0: \GdImage, 1: int}
     */
    private static function open(string $bytes): array
    {
        if (!self::available()) throw new \RuntimeException('no_gd');
        $info = @getimagesizefromstring($bytes);
        if (!is_array($info) || !in_array($info[2] ?? null, [IMAGETYPE_PNG, IMAGETYPE_JPEG, IMAGETYPE_WEBP], true)) throw new \RuntimeException('not_a_picture');
        [$width, $height] = [(int) $info[0], (int) $info[1]];
        if ($width < 1 || $height < 1 || $width > self::MAX_SOURCE_SIDE || $height > self::MAX_SOURCE_SIDE || $width * $height > self::MAX_SOURCE_PIXELS) throw new \RuntimeException('too_large');
        $image = @imagecreatefromstring($bytes);
        if (!$image instanceof \GdImage) throw new \RuntimeException('not_a_picture');
        // EXIF orientation is a camera's; an AI's picture is drawn upright, so it is not read.
        return [$image, (int) $info[2]];
    }

    /** $image scaled so its longer side is at most $side (never enlarged), as a new truecolour image keeping its alpha. */
    private static function scaled(\GdImage $image, int $side): \GdImage
    {
        $width = imagesx($image);
        $height = imagesy($image);
        $ratio = min(1.0, $side / max($width, $height));
        $w = max(1, (int) round($width * $ratio));
        $h = max(1, (int) round($height * $ratio));
        $out = imagecreatetruecolor($w, $h);
        imagealphablending($out, false);
        imagesavealpha($out, true);
        imagefill($out, 0, 0, imagecolorallocatealpha($out, 0, 0, 0, 127));
        imagecopyresampled($out, $image, 0, 0, 0, 0, $w, $h, $width, $height);
        return $out;
    }

    /** A PNG data URL of $image at most $side px, or null when GD cannot write one. */
    private static function png(\GdImage $image, int $side): ?array
    {
        $scaled = self::scaled($image, $side);
        ob_start();
        $ok = imagepng($scaled, null, 9);
        $bytes = (string) ob_get_clean();
        if (!$ok || $bytes === '') return null;
        return ['dataUrl' => 'data:image/png;base64,' . base64_encode($bytes), 'mimeType' => 'image/png', 'width' => imagesx($scaled), 'height' => imagesy($scaled)];
    }

    /**
     * A baseline JPEG data URL of $image, at most $side px, no longer than $maxDataUrl: quality 90 down
     * to 40 (85 to 45 for a reference), then three quarters the size, down to a 256 px side.
     * Transparency is painted white.
     *
     * @return array{dataUrl: string, mimeType: string, width: int, height: int}
     */
    private static function jpegLadder(\GdImage $image, int $side, int $maxDataUrl, bool $reference = false): array
    {
        while (true) {
            $scaled = self::scaled($image, $side);
            $flat = imagecreatetruecolor(imagesx($scaled), imagesy($scaled));
            imagefill($flat, 0, 0, imagecolorallocate($flat, 255, 255, 255));
            imagecopy($flat, $scaled, 0, 0, 0, 0, imagesx($scaled), imagesy($scaled));
            // Baseline, never progressive (contract §0.2).
            imageinterlace($flat, false);
            foreach ($reference ? [85, 75, 65, 55, 45] : [90, 85, 80, 72, 64, 56, 48, 40] as $quality) {
                ob_start();
                $ok = imagejpeg($flat, null, $quality);
                $bytes = (string) ob_get_clean();
                if (!$ok || $bytes === '') throw new \RuntimeException('encode_failed');
                $dataUrl = 'data:image/jpeg;base64,' . base64_encode($bytes);
                if (strlen($dataUrl) <= $maxDataUrl) return ['dataUrl' => $dataUrl, 'mimeType' => 'image/jpeg', 'width' => imagesx($flat), 'height' => imagesy($flat)];
            }
            $longer = max(imagesx($flat), imagesy($flat));
            if ($longer <= 256) throw new \RuntimeException('too_large');
            $side = max(256, (int) floor($longer * 0.75));
        }
    }
}
