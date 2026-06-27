<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Document Converter Service
 * Converts PDF, Word documents, and images to base64 images for AI processing
 */
class DocumentConverter
{
    private string $tempDir;
    private int $maxPages;
    private int $imageDpi;
    private int $maxImageWidth;
    private int $commandTimeoutSeconds;

    public function __construct()
    {
        $this->tempDir = sys_get_temp_dir() . '/formlogic_docs';
        $this->maxPages = 10; // Limit pages to process
        $this->imageDpi = 150; // DPI for PDF conversion
        $this->maxImageWidth = 1920; // Max width for images
        $this->commandTimeoutSeconds = 60; // Maximum time for any command

        if (!is_dir($this->tempDir)) {
            if (!@mkdir($this->tempDir, 0700, true) && !is_dir($this->tempDir)) {
                throw new \RuntimeException('Unable to create document temp directory');
            }
        } elseif (function_exists('posix_geteuid') && @fileowner($this->tempDir) !== posix_geteuid()) {
            // A pre-existing temp dir we do not own (e.g. on a shared host with a
            // world-writable /tmp) could be an attacker-staged symlink farm. Refuse it.
            throw new \RuntimeException('Document temp directory has unexpected ownership');
        }
    }

    /**
     * Unpredictable temp path base inside our private temp dir. Uses CSPRNG bytes
     * (not time-based uniqid) so an attacker on a shared host cannot pre-stage
     * symlinks at the expected output names.
     */
    private function randomTempBase(string $prefix): string
    {
        return $this->tempDir . '/' . $prefix . bin2hex(random_bytes(16));
    }

    /**
     * Execute a command with timeout protection
     *
     * @param string $command The command to execute
     * @return array{output: array, returnCode: int}
     */
    private function executeWithTimeout(string $command): array
    {
        // Wrap command with timeout to prevent hanging
        // Using 'timeout' command which is available on Linux
        $timeoutCommand = sprintf(
            'timeout --signal=KILL %d %s',
            $this->commandTimeoutSeconds,
            $command
        );

        $output = [];
        $returnCode = 0;
        exec($timeoutCommand, $output, $returnCode);

        // Return code 137 means killed by SIGKILL (timeout exceeded)
        if ($returnCode === 137) {
            throw new \Exception('Document conversion timed out. The file may be too complex or corrupted.');
        }

        return ['output' => $output, 'returnCode' => $returnCode];
    }

    /**
     * Convert an uploaded file to an array of base64 images
     *
     * @param string $filePath Path to the uploaded file
     * @param string $mimeType MIME type of the file
     * @return array Array of base64-encoded images
     */
    public function convertToImages(string $filePath, string $mimeType): array
    {
        $images = [];

        switch ($mimeType) {
            case 'application/pdf':
                $images = $this->convertPdfToImages($filePath);
                break;

            case 'application/msword':
            case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
                $images = $this->convertWordToImages($filePath);
                break;

            case 'image/jpeg':
            case 'image/png':
            case 'image/gif':
            case 'image/webp':
                $images = [$this->processImage($filePath)];
                break;

            default:
                throw new \Exception('Unsupported file type: ' . $mimeType);
        }

        return $images;
    }

    /**
     * Convert PDF pages to images using ImageMagick or Ghostscript
     */
    private function convertPdfToImages(string $pdfPath): array
    {
        $images = [];
        $outputPattern = $this->randomTempBase('pdf_') . '_%d.png';

        // Check if ImageMagick is available
        $hasImageMagick = $this->commandExists('convert');
        $hasGhostscript = $this->commandExists('gs');
        $hasPdftoppm = $this->commandExists('pdftoppm');

        if ($hasPdftoppm) {
            // Use pdftoppm (from poppler-utils) - most reliable
            $outputBase = $this->randomTempBase('pdf_');
            $command = sprintf(
                'pdftoppm -png -r %d -l %d %s %s 2>&1',
                $this->imageDpi,
                $this->maxPages,
                escapeshellarg($pdfPath),
                escapeshellarg($outputBase)
            );
            $result = $this->executeWithTimeout($command);
            $returnCode = $result['returnCode'];

            // Find generated files
            $files = glob($outputBase . '-*.png');
            sort($files);

            foreach ($files as $file) {
                if (is_link($file)) {
                    continue; // never follow a symlink we didn't create
                }
                $images[] = $this->processImage($file);
                unlink($file);
            }
        } elseif ($hasImageMagick) {
            // Use ImageMagick
            $command = sprintf(
                'convert -density %d -quality 90 %s[0-%d] %s 2>&1',
                $this->imageDpi,
                escapeshellarg($pdfPath),
                $this->maxPages - 1,
                escapeshellarg(str_replace('%d', '%03d', $outputPattern))
            );
            $result = $this->executeWithTimeout($command);
            $returnCode = $result['returnCode'];

            // Find generated files
            for ($i = 0; $i < $this->maxPages; $i++) {
                $file = sprintf(str_replace('%d', '%03d', $outputPattern), $i);
                if (file_exists($file) && !is_link($file)) {
                    $images[] = $this->processImage($file);
                    unlink($file);
                }
            }
        } elseif ($hasGhostscript) {
            // Use Ghostscript directly
            $outputPattern = $this->randomTempBase('pdf_') . '_%03d.png';
            // -dSAFER disables file/pipe/URL PostScript operators so a malicious
            // embedded-PostScript PDF can't read/write files or make requests
            // (CVE-2018-16509 class). Harmless no-op on modern gs (default on);
            // protective on old (<9.50) gs.
            $command = sprintf(
                'gs -dSAFER -dNOPAUSE -dBATCH -sDEVICE=png16m -r%d -dLastPage=%d -sOutputFile=%s %s 2>&1',
                $this->imageDpi,
                $this->maxPages,
                escapeshellarg($outputPattern),
                escapeshellarg($pdfPath)
            );
            $result = $this->executeWithTimeout($command);
            $returnCode = $result['returnCode'];

            // Find generated files
            for ($i = 1; $i <= $this->maxPages; $i++) {
                $file = sprintf($outputPattern, $i);
                if (file_exists($file) && !is_link($file)) {
                    $images[] = $this->processImage($file);
                    unlink($file);
                }
            }
        } else {
            throw new \Exception('No PDF conversion tool available. Please install poppler-utils, ImageMagick, or Ghostscript.');
        }

        if (empty($images)) {
            throw new \Exception('Failed to convert PDF to images');
        }

        return $images;
    }

    /**
     * Convert Word document to images
     * Uses LibreOffice to convert to PDF first, then to images
     */
    private function convertWordToImages(string $wordPath): array
    {
        // Check if LibreOffice is available
        $hasLibreOffice = $this->commandExists('libreoffice') || $this->commandExists('soffice');

        if (!$hasLibreOffice) {
            throw new \Exception('LibreOffice is required for Word document conversion. Please install libreoffice.');
        }

        // Convert to PDF using LibreOffice
        $pdfDir = $this->tempDir;
        $command = sprintf(
            'libreoffice --headless --convert-to pdf --outdir %s %s 2>&1',
            escapeshellarg($pdfDir),
            escapeshellarg($wordPath)
        );
        $this->executeWithTimeout($command);

        // Find the generated PDF (sanitize basename to prevent path traversal)
        $baseName = preg_replace('/[^a-zA-Z0-9._\-]/', '_', pathinfo($wordPath, PATHINFO_FILENAME));
        $pdfPath = $pdfDir . '/' . $baseName . '.pdf';

        if (!file_exists($pdfPath)) {
            throw new \Exception('Failed to convert Word document to PDF');
        }

        try {
            $images = $this->convertPdfToImages($pdfPath);
        } finally {
            if (file_exists($pdfPath) && !is_link($pdfPath)) {
                unlink($pdfPath);
            }
        }

        return $images;
    }

    /**
     * Process an image: resize if needed, convert to base64
     */
    private function processImage(string $imagePath): string
    {
        $imageInfo = getimagesize($imagePath);
        if ($imageInfo === false) {
            throw new \Exception('Invalid image file: ' . $imagePath);
        }

        [$width, $height, $type] = $imageInfo;

        // Reject decompression bombs BEFORE imagecreatefrom*() allocates the full
        // uncompressed bitmap (a tiny file can declare huge dimensions).
        $maxPixels = 40_000_000; // ~40 megapixels
        if ($width < 1 || $height < 1 || $width > 20000 || $height > 20000 || ($width * $height) > $maxPixels) {
            throw new \Exception('Image dimensions too large');
        }

        // Load image
        $image = match ($type) {
            IMAGETYPE_JPEG => imagecreatefromjpeg($imagePath),
            IMAGETYPE_PNG => imagecreatefrompng($imagePath),
            IMAGETYPE_GIF => imagecreatefromgif($imagePath),
            IMAGETYPE_WEBP => imagecreatefromwebp($imagePath),
            default => throw new \Exception('Unsupported image type')
        };

        if ($image === false) {
            throw new \Exception('Failed to load image');
        }

        // Resize if needed
        if ($width > $this->maxImageWidth) {
            $newWidth = $this->maxImageWidth;
            $newHeight = (int) ($height * ($this->maxImageWidth / $width));

            $resized = imagecreatetruecolor($newWidth, $newHeight);
            if ($type === IMAGETYPE_PNG) {
                imagealphablending($resized, false);
                imagesavealpha($resized, true);
            }
            imagecopyresampled($resized, $image, 0, 0, 0, 0, $newWidth, $newHeight, $width, $height);
            imagedestroy($image);
            $image = $resized;
        }

        // Convert to PNG and base64
        ob_start();
        imagepng($image, null, 6); // Compression level 6
        $imageData = ob_get_clean();
        imagedestroy($image);

        if ($imageData === false) {
            throw new \RuntimeException('Failed to capture image output');
        }

        return base64_encode($imageData);
    }

    /**
     * Check if a command exists
     */
    private function commandExists(string $command): bool
    {
        $return = shell_exec(sprintf("which %s 2>/dev/null", escapeshellarg($command)));
        return !empty(trim($return ?? ''));
    }

    /**
     * Clean up old temporary files (call periodically)
     */
    public function cleanupTempFiles(int $maxAgeSeconds = 3600): void
    {
        $files = glob($this->tempDir . '/*');
        $now = time();

        foreach ($files as $file) {
            if (is_file($file) && !is_link($file) && ($now - filemtime($file)) > $maxAgeSeconds) {
                unlink($file);
            }
        }
    }
}
