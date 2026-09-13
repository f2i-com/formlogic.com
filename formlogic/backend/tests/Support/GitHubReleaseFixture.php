<?php
declare(strict_types=1);
namespace FormLogic\Tests\Support;

use FormLogic\Services\GitHubReleaseService;

/** Local transport fixture: real metadata selection, archive hashing and manifest validation. */
class GitHubReleaseFixture extends GitHubReleaseService
{
    public array $metadata;
    public array $requests = [];
    public bool $offline = false;

    public function __construct(private string $zipPath, string $version = '2.0.0')
    {
        $this->metadata = [
            'id' => 101, 'tag_name' => 'v' . $version, 'draft' => false, 'prerelease' => false,
            'published_at' => '2026-09-12T00:00:00Z',
            'assets' => [[
                'id' => 202, 'name' => 'formlogic-' . $version . '.zip', 'state' => 'uploaded',
                'size' => filesize($zipPath), 'digest' => 'sha256:' . hash_file('sha256', $zipPath),
            ]],
        ];
    }

    protected function request(string $url, ?string $destination = null): string
    {
        $this->requests[] = $url;
        if ($this->offline) throw new \RuntimeException('GitHub unavailable', 503);
        if ($destination !== null) {
            copy($this->zipPath, $destination);
            return '';
        }
        return (string) json_encode($this->metadata);
    }
}
