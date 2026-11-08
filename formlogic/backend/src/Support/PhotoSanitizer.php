<?php

declare(strict_types=1);

namespace FormLogic\Support;

use GdImage;
use RuntimeException;

/**
 * The photo a SoftN app's upload route receives (`upload: "photo"`, which needs the app's `photos`
 * capability): the person's picture redrawn by this server, never their file. SoftN's own PHP host
 * does the same (apps/softn-host-php/runtime/photos.php in the SoftN repository), and its Rust host
 * the same again, so an app gets one answer whichever host it runs on:
 *
 *  - a still JPEG, PNG or WebP of at most 4 MB and 16 megapixels, 32 to 8,192 pixels a side, read
 *    from its bytes (a browser labels a file by its extension);
 *  - turned the way its EXIF says, transparency painted white;
 *  - written again as a 960-pixel JPEG (at most 400 KB) and a 240-pixel thumbnail (at most 60 KB),
 *    as data: URLs, with none of the original's metadata (no location, no camera).
 *
 * The app's backend gets `req.upload = {sanitized: true, image, thumbnail}` and an empty body. A
 * photo it will not take is still a request, counted against the person's limit by the app's
 * backend, which answers it `photo_rejected`.
 */
final class PhotoSanitizer
{
    public const MAX_DATA_URL = 5600000;
    public const MAX_BYTES = 4000000;

    /** Whether this PHP can redraw photos at all: GD, reading all three types and writing JPEG. */
    public static function available(): bool
    {
        if (!extension_loaded('gd') || !function_exists('imagecreatefromstring') || !function_exists('imagejpeg')) return false;
        $info = gd_info();
        return !empty($info['JPEG Support']) && !empty($info['PNG Support']) && !empty($info['WebP Support']);
    }

    /**
     * @return array{sanitized: true, thumbnail: string, image: string}
     * @throws RuntimeException naming why the photo was not taken (never shown to the person as it is)
     */
    public static function sanitize(mixed $url): array
    {
        if (!is_string($url) || strlen($url) > self::MAX_DATA_URL || !preg_match('~^data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$~D', $url, $match)) throw new RuntimeException('format');
        $data = base64_decode($match[2], true);
        if ($data === false || strlen($data) > self::MAX_BYTES) throw new RuntimeException('size');
        $size = @getimagesizefromstring($data);
        if (!$size || $size[0] < 32 || $size[1] < 32 || $size[0] > 8192 || $size[1] > 8192 || $size[0] * $size[1] > 16000000 || !in_array($size[2], [IMAGETYPE_JPEG, IMAGETYPE_PNG, IMAGETYPE_WEBP], true)) throw new RuntimeException('dimensions');
        if (($size[2] === IMAGETYPE_PNG && self::pngIsAnimated($data)) || ($size[2] === IMAGETYPE_WEBP && self::webpIsAnimated($data))) throw new RuntimeException('animation');
        // GD counts the decoded pixels against memory_limit, about eight bytes each: past it PHP
        // ends the request with a fatal error nothing catches. Room is asked for first, and a photo
        // the server will not make room for is refused like any other it will not take.
        if (!\FormLogic\Services\NativeAppService::raiseMemoryFor($size[0] * $size[1] * 2)) throw new RuntimeException('memory');
        $image = @imagecreatefromstring($data);
        if (!$image) throw new RuntimeException('decode');
        $orientation = $size[2] === IMAGETYPE_JPEG ? self::jpegOrientation($data) : 1;
        $result = ['sanitized' => true];
        foreach (['thumbnail' => 240, 'image' => 960] as $field => $side) {
            $ratio = min(1, $side / imagesx($image), $side / imagesy($image));
            $w = max(1, (int) floor(imagesx($image) * $ratio));
            $h = max(1, (int) floor(imagesy($image) * $ratio));
            $copy = imagecreatetruecolor($w, $h);
            if ($copy === false) throw new RuntimeException('memory');
            imagefill($copy, 0, 0, (int) imagecolorallocate($copy, 255, 255, 255));
            imagecopyresampled($copy, $image, 0, 0, 0, 0, $w, $h, imagesx($image), imagesy($image));
            // Turned once it is small: a 16 megapixel original is not held twice.
            $copy = self::upright($copy, $orientation);
            ob_start();
            try { imagejpeg($copy, null, 82); $bytes = (string) ob_get_contents(); } finally { ob_end_clean(); }
            unset($copy);
            if (strlen($bytes) > ($field === 'thumbnail' ? 60000 : 400000)) throw new RuntimeException('complexity');
            $result[$field] = 'data:image/jpeg;base64,' . base64_encode($bytes);
        }
        unset($image);
        return $result;
    }

    /** The EXIF orientation of a JPEG, 1 to 8, or 1 when it carries none or it cannot be read. */
    public static function jpegOrientation(string $data): int
    {
        $length = strlen($data);
        if ($length < 4 || $data[0] !== "\xFF" || $data[1] !== "\xD8") return 1;
        for ($at = 2; $at + 4 <= $length && $data[$at] === "\xFF";) {
            $marker = ord($data[$at + 1]);
            if ($marker === 0xFF) { $at++; continue; }
            if ($marker === 0x01 || ($marker >= 0xD0 && $marker <= 0xD8)) { $at += 2; continue; }
            if ($marker === 0xDA || $marker === 0xD9) break;
            $size = (ord($data[$at + 2]) << 8) | ord($data[$at + 3]);
            if ($size < 2 || $at + 2 + $size > $length) break;
            if ($marker === 0xE1 && substr($data, $at + 4, 6) === "Exif\0\0") return self::tiffOrientation(substr($data, $at + 10, $size - 8));
            $at += 2 + $size;
        }
        return 1;
    }

    private static function tiffOrientation(string $tiff): int
    {
        $length = strlen($tiff);
        if ($length < 14) return 1;
        $order = substr($tiff, 0, 2);
        if ($order !== 'II' && $order !== 'MM') return 1;
        $u16 = $order === 'II' ? 'v' : 'n';
        $u32 = $order === 'II' ? 'V' : 'N';
        if (unpack($u16, $tiff, 2)[1] !== 42) return 1;
        $directory = unpack($u32, $tiff, 4)[1];
        if ($directory < 8 || $directory + 2 > $length) return 1;
        $count = unpack($u16, $tiff, $directory)[1];
        for ($i = 0; $i < $count; $i++) {
            $entry = $directory + 2 + 12 * $i;
            if ($entry + 12 > $length) return 1;
            if (unpack($u16, $tiff, $entry)[1] !== 0x0112) continue;
            $value = unpack($u16, $tiff, $entry + 8)[1];
            return unpack($u16, $tiff, $entry + 2)[1] === 3 && $value >= 1 && $value <= 8 ? $value : 1;
        }
        return 1;
    }

    /** The image as it is meant to be seen. imagerotate() turns counter-clockwise. */
    private static function upright(GdImage $image, int $orientation): GdImage
    {
        $turn = [3 => 180, 5 => 270, 6 => 270, 7 => 270, 8 => 90][$orientation] ?? 0;
        if ($turn !== 0) {
            $turned = imagerotate($image, $turn, 0);
            if (!$turned) throw new RuntimeException('orientation');
            $image = $turned;
        }
        $flip = [2 => IMG_FLIP_HORIZONTAL, 4 => IMG_FLIP_VERTICAL, 5 => IMG_FLIP_HORIZONTAL, 7 => IMG_FLIP_VERTICAL][$orientation] ?? null;
        if ($flip !== null) imageflip($image, $flip);
        return $image;
    }

    /** An APNG: an `acTL` chunk among those before the image data (not those letters anywhere). */
    public static function pngIsAnimated(string $data): bool
    {
        $length = strlen($data);
        for ($at = 8; $at + 8 <= $length;) {
            $type = substr($data, $at + 4, 4);
            if ($type === 'acTL') return true;
            if ($type === 'IDAT' || $type === 'IEND') return false;
            $at += 12 + unpack('N', $data, $at)[1];
        }
        return false;
    }

    /** An animated WebP: the extended format with its VP8X animation flag set. */
    public static function webpIsAnimated(string $data): bool
    {
        return strlen($data) >= 21 && substr($data, 12, 4) === 'VP8X' && (ord($data[20]) & 0x02) !== 0;
    }
}
