<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\AppAiService;
use FormLogic\Services\AppAiSiteSettings;
use FormLogic\Services\AppVisitors;
use FormLogic\Services\NativeAppService;
use FormLogic\Tests\Support\LinkedComputers;
use PHPUnit\Framework\TestCase;

/**
 * An edit's picture is checked as its job is taken from the app's row (AppAiService's capture), by
 * its header: a small file that says it is a picture larger than the worker may open is refused
 * then, with a reason the app can show, rather than reaching the worker at all.
 */
final class AppAiEditPictureCheckTest extends TestCase
{
    private string $settingsPath = '';

    protected function tearDown(): void
    {
        if ($this->settingsPath !== '') @unlink($this->settingsPath);
    }

    /** What capture makes of one row of the app's jobs table: [job, refusal or null]. */
    private function taken(array $row): array
    {
        $this->settingsPath = sys_get_temp_dir() . '/app-ai-edit-check-' . bin2hex(random_bytes(4)) . '.json';
        $ai = new AppAiService(new LinkedComputers(), new AppAiSiteSettings($this->settingsPath), new AppVisitors(null), $this->createMock(NativeAppService::class));
        return (new \ReflectionMethod(AppAiService::class, 'jobFrom'))->invoke($ai, $row, $row['id'], ['kinds' => ['picture', 'edit', 'chat']]);
    }

    private static function png(int $width, int $height): string
    {
        $chunk = static fn(string $type, string $data): string => pack('N', strlen($data)) . $type . $data . pack('N', crc32($type . $data));
        $zlib = deflate_init(ZLIB_ENCODING_DEFLATE, ['level' => 9]);
        $idat = '';
        $row = "\0" . str_repeat("\xFF\xFF\xFF", $width);
        for ($y = 0; $y < $height; $y++) $idat .= deflate_add($zlib, $row, ZLIB_NO_FLUSH);
        $idat .= deflate_add($zlib, '', ZLIB_FINISH);
        return 'data:image/png;base64,' . base64_encode("\x89PNG\r\n\x1a\n" . $chunk('IHDR', pack('NNCCCCC', $width, $height, 8, 2, 0, 0, 0)) . $chunk('IDAT', $idat) . $chunk('IEND', ''));
    }

    public function testAnEditsPictureTooLargeToOpenIsRefusedAsItsJobIsTaken(): void
    {
        [$job, $refusal] = $this->taken(['id' => 'job-1', 'kind' => 'edit', 'prompt' => 'Make it blue', 'reference' => self::png(6000, 6000)]);
        $this->assertSame(['code' => 'bad_request', 'message' => 'An edit\'s picture may be at most 16 megapixels, and 8,192 pixels a side.'], $refusal);
        $this->assertArrayNotHasKey('reference', $job, 'nothing of it is kept');
    }

    /** Its bytes are read as the job is taken: what is no picture is refused then, not when the worker gets to it. */
    public function testAnEditsPictureThatIsNoPictureIsRefusedAsItsJobIsTaken(): void
    {
        [, $refusal] = $this->taken(['id' => 'job-2', 'kind' => 'edit', 'prompt' => 'Make it blue', 'reference' => 'data:image/png;base64,' . base64_encode('not a picture')]);
        $this->assertSame('An edit needs its picture: a PNG, JPEG or WebP data URL of at most 2 MB.', $refusal['message'] ?? null);
    }

    public function testAnEditsPictureOfASaneSizeIsTaken(): void
    {
        [$job, $refusal] = $this->taken(['id' => 'job-3', 'kind' => 'edit', 'prompt' => 'Make it blue', 'reference' => self::png(1200, 800)]);
        $this->assertNull($refusal);
        $this->assertStringStartsWith('data:image/png;base64,', $job['reference']);
    }
}
