<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Tests\Support\GitHubReleaseFixture;
use PHPUnit\Framework\TestCase;

class GitHubReleaseServiceTest extends TestCase
{
    private string $path;
    private GitHubReleaseFixture $github;

    protected function setUp(): void
    {
        $this->path = tempnam(sys_get_temp_dir(), 'fl-release-');
        $zip = new \ZipArchive();
        $zip->open($this->path, \ZipArchive::OVERWRITE);
        $zip->addFromString('manifest.json', '{"version":"2.0.0","files":{}}');
        $zip->close();
        $this->github = new GitHubReleaseFixture($this->path);
    }

    protected function tearDown(): void { @unlink($this->path); }

    public function testLatestSelectsBuiltZipAndVerifiesArchive(): void
    {
        $release = $this->github->latest();
        $this->assertSame('2.0.0', $release['version']);
        $this->assertSame(hash_file('sha256', $this->path), $release['digest']);
        $this->assertSame(hash('sha256', '{"version":"2.0.0","files":{}}'), $this->github->verifyArchive($this->path, $release));
        $this->assertSame($release, $this->github->resolve(101, 202, $release['digest']));
        $this->assertSame('https://api.github.com/repos/f2i-com/formlogic.com/releases/101', $this->github->requests[1]);
    }

    public function testDraftsPrereleasesAndSourceOnlyReleasesAreNotInstallable(): void
    {
        $this->github->metadata['draft'] = true;
        $this->assertNull($this->github->latest());
        $this->github->metadata['draft'] = false;
        $this->github->metadata['prerelease'] = true;
        $this->assertNull($this->github->latest());
        $this->github->metadata['prerelease'] = false;
        $this->github->metadata['assets'] = [];
        $this->assertNull($this->github->latest());
    }

    public function testMissingDigestIsNotTrusted(): void
    {
        $this->github->metadata['assets'][0]['digest'] = null;
        $this->expectExceptionMessage('GitHub SHA-256');
        $this->github->latest();
    }

    public function testChangedSelectionMustBeReviewedAgain(): void
    {
        $this->expectExceptionMessage('changed');
        $this->github->resolve(101, 203, hash_file('sha256', $this->path));
    }

    public function testChangedDownloadIsRejected(): void
    {
        $release = $this->github->latest();
        file_put_contents($this->path, 'incomplete download');
        $this->expectExceptionMessage('does not match');
        $this->github->verifyArchive($this->path, $release);
    }

    public function testManifestMustMatchReleaseTag(): void
    {
        $release = $this->github->latest();
        $release['version'] = '3.0.0';
        $this->expectExceptionMessage('does not match its GitHub tag');
        $this->github->verifyArchive($this->path, $release);
    }
}
