<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\AppAiPictures;
use PHPUnit\Framework\TestCase;

/**
 * What App AI hands an app (contract §0.2): at most 1,500,000 bytes as a data URL, a JPEG kept a
 * baseline JPEG of at most 1024 px, a PNG kept a PNG while it fits, never WebP and never progressive;
 * and an edit's picture squeezed to the lane's budget. Nothing that is not a picture gets through.
 */
final class AppAiPicturesTest extends TestCase
{
    protected function setUp(): void
    {
        if (!AppAiPictures::available()) $this->markTestSkipped('No GD here');
    }

    private static function picture(int $width, int $height, string $as, bool $noise = false, bool $progressive = false): string
    {
        $image = imagecreatetruecolor($width, $height);
        if ($noise) {
            mt_srand(42);
            for ($y = 0; $y < $height; $y++) {
                for ($x = 0; $x < $width; $x++) imagesetpixel($image, $x, $y, mt_rand(0, 0xFFFFFF));
            }
        } else {
            imagefill($image, 0, 0, imagecolorallocate($image, 30, 120, 200));
            imagefilledellipse($image, intdiv($width, 2), intdiv($height, 2), intdiv($width, 2), intdiv($height, 2), imagecolorallocate($image, 250, 220, 40));
        }
        imageinterlace($image, $progressive);
        ob_start();
        match ($as) {
            'png' => imagepng($image),
            'jpeg' => imagejpeg($image, null, 92),
            'webp' => imagewebp($image),
        };
        return (string) ob_get_clean();
    }

    private static function bytes(string $dataUrl): string
    {
        return (string) base64_decode(substr($dataUrl, strpos($dataUrl, ',') + 1), true);
    }

    public function testAJpegComesBackABaselineJpegOfAtMost1024Pixels(): void
    {
        $progressive = self::picture(2048, 1536, 'jpeg', false, true);
        $this->assertFalse(AppAiPictures::isBaselineJpeg($progressive), 'the source is progressive');
        $out = AppAiPictures::deliverable($progressive);
        $this->assertSame(['image/jpeg', 1024, 768], [$out['mimeType'], $out['width'], $out['height']]);
        $this->assertStringStartsWith('data:image/jpeg;base64,', $out['dataUrl']);
        $this->assertTrue(AppAiPictures::isBaselineJpeg(self::bytes($out['dataUrl'])), 'JPEG in, baseline JPEG out');
        $this->assertSame([1024, 768], array_slice((array) getimagesizefromstring(self::bytes($out['dataUrl'])), 0, 2));
    }

    public function testAPngThatFitsStaysAPngAtItsOwnSize(): void
    {
        $out = AppAiPictures::deliverable(self::picture(512, 512, 'png'));
        $this->assertSame(['image/png', 512, 512], [$out['mimeType'], $out['width'], $out['height']]);
        $this->assertStringStartsWith("\x89PNG", self::bytes($out['dataUrl']));
    }

    /** A noisy 1024 px PNG is several megabytes: no PNG size fits, so it becomes a baseline JPEG at 1024 px. */
    public function testAPngTooLargeAtEverySizeBecomesABaselineJpegThatFits(): void
    {
        $noisy = self::picture(1024, 1024, 'png', true);
        $this->assertGreaterThan(AppAiPictures::MAX_DATA_URL, strlen($noisy));
        $out = AppAiPictures::deliverable($noisy);
        $this->assertSame(['image/jpeg', 1024, 1024], [$out['mimeType'], $out['width'], $out['height']]);
        $this->assertLessThanOrEqual(AppAiPictures::MAX_DATA_URL, strlen($out['dataUrl']));
        $this->assertTrue(AppAiPictures::isBaselineJpeg(self::bytes($out['dataUrl'])));
    }

    public function testNeverWebp(): void
    {
        if (!function_exists('imagewebp')) $this->markTestSkipped('GD without WebP');
        $out = AppAiPictures::deliverable(self::picture(300, 200, 'webp'));
        $this->assertContains($out['mimeType'], ['image/png', 'image/jpeg']);
        $this->assertStringNotContainsString('webp', $out['dataUrl']);
    }

    public function testAnEditsPictureFitsTheBudgetItIsGiven(): void
    {
        $source = 'data:image/png;base64,' . base64_encode(self::picture(1600, 1600, 'png', true));
        $reference = AppAiPictures::reference($source, 50000);
        $this->assertStringStartsWith('data:image/jpeg;base64,', $reference);
        $bytes = self::bytes($reference);
        $this->assertLessThanOrEqual(50000, strlen($bytes));
        $this->assertTrue(AppAiPictures::isBaselineJpeg($bytes));
        $this->assertLessThanOrEqual(1024, max(array_slice((array) getimagesizefromstring($bytes), 0, 2)));
    }

    public function testWhatIsNotAPictureIsRefused(): void
    {
        foreach (['hello', '', "\x89PNG\r\n\x1a\nnot really", '<svg xmlns="http://www.w3.org/2000/svg"/>'] as $bytes) {
            try {
                AppAiPictures::deliverable($bytes);
                $this->fail('read as a picture: ' . substr($bytes, 0, 20));
            } catch (\RuntimeException) {
                $this->addToAssertionCount(1);
            }
        }
        foreach (['data:image/png;base64,AAAA', 'data:text/html;base64,' . base64_encode('<b>x</b>'), 'data:image/svg+xml;base64,' . base64_encode('<svg/>'), 'https://example.com/a.png'] as $dataUrl) {
            try {
                AppAiPictures::reference($dataUrl);
                $this->fail('read as a picture: ' . $dataUrl);
            } catch (\RuntimeException) {
                $this->addToAssertionCount(1);
            }
        }
    }

    /** A picture whose header says 20,000 px square is refused before anything is decoded. */
    public function testAPictureTooLargeToOpenIsRefusedUnopened(): void
    {
        $chunk = static fn(string $type, string $data): string => pack('N', strlen($data)) . $type . $data . pack('N', crc32($type . $data));
        $bomb = "\x89PNG\r\n\x1a\n" . $chunk('IHDR', pack('NNCCCCC', 20000, 20000, 8, 2, 0, 0, 0)) . $chunk('IDAT', (string) gzcompress('')) . $chunk('IEND', '');
        try {
            AppAiPictures::deliverable($bomb);
            $this->fail('opened');
        } catch (\RuntimeException $e) {
            $this->assertSame('too_large', $e->getMessage());
        }
    }

    /**
     * A flat truecolor PNG of $width × $height, written row by row so the test never holds it whole:
     * a 6,000 px square is about 100 KB on disk and 108 MB of pixels.
     */
    private static function flatPng(int $width, int $height): string
    {
        $chunk = static fn(string $type, string $data): string => pack('N', strlen($data)) . $type . $data . pack('N', crc32($type . $data));
        $zlib = deflate_init(ZLIB_ENCODING_DEFLATE, ['level' => 9]);
        $row = "\0" . str_repeat("\x40\x80\xC0", $width);
        $idat = '';
        for ($y = 0; $y < $height; $y++) $idat .= deflate_add($zlib, $row, ZLIB_NO_FLUSH);
        $idat .= deflate_add($zlib, '', ZLIB_FINISH);
        return "\x89PNG\r\n\x1a\n" . $chunk('IHDR', pack('NNCCCCC', $width, $height, 8, 2, 0, 0, 0)) . $chunk('IDAT', $idat) . $chunk('IEND', '');
    }

    /**
     * The worker that opened a 6,000 px square PNG of about 100 KB, an edit's picture or the AI's
     * own, died: GD holds it decoded at four bytes a pixel, far past the 128 MB PHP's command line
     * gives by default, and a fatal error nothing catches ended the worker, every time it was started
     * again. It is refused now, by its header, before anything is decoded.
     */
    public function testASmallFileOfAHugePictureIsRefusedBeforeItCanKillTheWorker(): void
    {
        $png = self::flatPng(6000, 6000);
        $this->assertLessThan(200000, strlen($png), 'a small file');
        $file = tempnam(sys_get_temp_dir(), 'app-ai-huge-');
        file_put_contents($file, $png);
        try {
            foreach (['reference', 'deliverable'] as $as) {
                $process = proc_open([PHP_BINARY, '-d', 'memory_limit=128M', '-d', 'xdebug.mode=off', dirname(__DIR__) . '/Support/app-ai-picture-open.php', $file, $as], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
                $out = (string) stream_get_contents($pipes[1]) . (string) stream_get_contents($pipes[2]);
                $exit = proc_close($process);
                $this->assertSame([0, ['refused' => 'too_large']], [$exit, json_decode($out, true)], $as . ': ' . $out);
            }
        } finally {
            @unlink($file);
        }
        $this->assertSame('too_large', AppAiPictures::refusal($png));
    }

    /** 16 megapixels, as a photo an app takes (PhotoSanitizer), and 8,192 pixels a side. */
    public function testWhatAPictureMayBeIsReadFromItsHeaderAlone(): void
    {
        $this->assertSame(16000000, AppAiPictures::MAX_SOURCE_PIXELS);
        $this->assertNull(AppAiPictures::refusal(self::flatPng(4000, 4000)), 'sixteen megapixels');
        $this->assertSame('too_large', AppAiPictures::refusal(self::flatPng(4001, 4000)));
        $this->assertSame('too_large', AppAiPictures::refusal(self::flatPng(8193, 16)), 'a side too long');
        $this->assertSame('not_a_picture', AppAiPictures::refusal('<svg xmlns="http://www.w3.org/2000/svg"/>'));
        $this->assertSame('not_a_picture', AppAiPictures::refusal("GIF89a\x01\x00\x01\x00\x00\x00\x00;"), 'not one of the three it reads');
    }

    public function testBaselineIsToldFromProgressive(): void
    {
        $this->assertTrue(AppAiPictures::isBaselineJpeg(self::picture(64, 64, 'jpeg')));
        $this->assertFalse(AppAiPictures::isBaselineJpeg(self::picture(64, 64, 'jpeg', false, true)));
        $this->assertFalse(AppAiPictures::isBaselineJpeg(self::picture(64, 64, 'png')));
        $this->assertFalse(AppAiPictures::isBaselineJpeg("\xFF\xD8\xFF"));
    }
}
