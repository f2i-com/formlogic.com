<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Support\PhotoSanitizer;
use PHPUnit\Framework\TestCase;

/**
 * A SoftN app's photo upload route gets the photo this server redrew, as SoftN's PHP and Rust hosts
 * give it: never the person's file, its metadata or its animation.
 */
final class PhotoSanitizerTest extends TestCase
{
    protected function setUp(): void
    {
        if (!PhotoSanitizer::available()) $this->markTestSkipped('GD with JPEG, PNG and WebP');
    }

    private static function image(int $w, int $h, string $type): string
    {
        $image = imagecreatetruecolor($w, $h);
        imagefill($image, 0, 0, (int) imagecolorallocate($image, 30, 120, 90));
        // A mark in the top left, to see which way the result faces.
        imagefilledrectangle($image, 0, 0, (int) ($w / 4), (int) ($h / 4), (int) imagecolorallocate($image, 250, 10, 10));
        ob_start();
        match ($type) { 'png' => imagepng($image), 'webp' => imagewebp($image), default => imagejpeg($image, null, 90) };
        return (string) ob_get_clean();
    }

    private static function url(string $bytes, string $label): string
    {
        return 'data:image/' . $label . ';base64,' . base64_encode($bytes);
    }

    /** The size of a data: URL's JPEG. */
    private static function dimensions(string $url): array
    {
        $bytes = base64_decode(substr($url, strlen('data:image/jpeg;base64,')), true);
        $info = getimagesizefromstring((string) $bytes);
        return [$info[0], $info[1], $info[2]];
    }

    public function testAPhotoIsRedrawnAsAJpegAndAThumbnailWithinTheirSizes(): void
    {
        foreach (['jpeg', 'png', 'webp'] as $type) {
            $result = PhotoSanitizer::sanitize(self::url(self::image(1600, 1200, $type), $type));
            $this->assertTrue($result['sanitized']);
            $this->assertStringStartsWith('data:image/jpeg;base64,', $result['image']);
            $this->assertSame([960, 720, IMAGETYPE_JPEG], self::dimensions($result['image']), $type);
            $this->assertSame([240, 180, IMAGETYPE_JPEG], self::dimensions($result['thumbnail']), $type);
        }
        // A small one keeps its size: nothing is drawn larger than it was.
        $this->assertSame([300, 200, IMAGETYPE_JPEG], self::dimensions(PhotoSanitizer::sanitize(self::url(self::image(300, 200, 'png'), 'png'))['image']));
    }

    public function testWhatAPhotoIsComesFromItsBytesNotItsLabel(): void
    {
        // A browser labels by the file's extension: a PNG called .jpg is still a photo.
        $this->assertTrue(PhotoSanitizer::sanitize(self::url(self::image(400, 300, 'png'), 'jpeg'))['sanitized']);
    }

    public function testAPhoneHeldUprightGivesAnUprightPhoto(): void
    {
        // A sensor's rows as they come, 400 wide and 300 high, with EXIF saying "turn a quarter" (6).
        $jpeg = self::image(400, 300, 'jpeg');
        $tiff = 'II' . pack('v', 42) . pack('V', 8) . pack('v', 1) . pack('vvVvv', 0x0112, 3, 1, 6, 0) . pack('V', 0);
        $app1 = "\xFF\xE1" . pack('n', 2 + 6 + strlen($tiff)) . "Exif\0\0" . $tiff;
        $turned = substr($jpeg, 0, 2) . $app1 . substr($jpeg, 2);
        $this->assertSame(6, PhotoSanitizer::jpegOrientation($turned));
        $this->assertSame([300, 400, IMAGETYPE_JPEG], self::dimensions(PhotoSanitizer::sanitize(self::url($turned, 'jpeg'))['image']));
        // None at all reads as upright.
        $this->assertSame(1, PhotoSanitizer::jpegOrientation($jpeg));
    }

    public function testNoMetadataOfTheOriginalSurvives(): void
    {
        $jpeg = self::image(400, 300, 'jpeg');
        $comment = "\xFF\xFE" . pack('n', 2 + 20) . 'GPS -37.80,144.96 xy';
        $result = PhotoSanitizer::sanitize(self::url(substr($jpeg, 0, 2) . $comment . substr($jpeg, 2), 'jpeg'));
        $this->assertStringNotContainsString('GPS', (string) base64_decode(substr($result['image'], 23)));
    }

    public function testWhatIsNotAStillPhotoWithinTheLimitsIsRefused(): void
    {
        $refused = static function (mixed $url): string {
            try { PhotoSanitizer::sanitize($url); return 'taken'; } catch (\RuntimeException $e) { return $e->getMessage(); }
        };
        $this->assertSame('format', $refused(null));
        $this->assertSame('format', $refused('data:image/gif;base64,R0lGODdh'));
        $this->assertSame('format', $refused('https://example.com/a.jpg'));
        $this->assertSame('dimensions', $refused(self::url(self::image(20, 20, 'png'), 'png')), 'too small to be a photo');
        $this->assertSame('dimensions', $refused(self::url('not an image at all', 'png')));
        $this->assertSame('size', $refused(self::url(str_repeat('a', PhotoSanitizer::MAX_BYTES + 1), 'png')));
        // An APNG says so in an acTL chunk before its image data.
        $png = self::image(64, 64, 'png');
        $chunk = pack('N', 8) . 'acTL' . pack('NN', 2, 0) . pack('N', crc32('acTL' . pack('NN', 2, 0)));
        $this->assertSame('animation', $refused(self::url(substr($png, 0, 33) . $chunk . substr($png, 33), 'png')));
        // The letters alone, somewhere in a still PNG, are not animation.
        $this->assertFalse(PhotoSanitizer::pngIsAnimated(substr($png, 0, 33) . pack('N', 4) . 'tEXt' . 'acTL' . pack('N', 0) . substr($png, 33)));
    }
}
