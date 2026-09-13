<?php
declare(strict_types=1);

namespace FormLogic\Services;

/** Official release channel. Repository and network destinations are never supplied by a request. */
class GitHubReleaseService
{
    public const REPOSITORY = 'f2i-com/formlogic.com';
    public const MAX_ZIP_BYTES = 536870912;
    private const API = 'https://api.github.com/repos/' . self::REPOSITORY;

    public function latest(): ?array
    {
        try {
            $release = $this->metadata(self::API . '/releases/latest');
        } catch (\RuntimeException $error) {
            if ($error->getCode() === 404) return null;
            throw $error;
        }
        return $this->selectAsset($release);
    }

    /** Re-resolve the reviewed asset, rather than silently following a newly published latest release. */
    public function resolve(int $releaseId, int $assetId, string $digest): array
    {
        if ($releaseId < 1 || $assetId < 1 || !preg_match('/^[0-9a-f]{64}$/D', $digest)) {
            throw new \RuntimeException('Invalid release selection. Check for updates again.');
        }
        $release = $this->selectAsset($this->metadata(self::API . '/releases/' . $releaseId));
        if ($release === null || $release['releaseId'] !== $releaseId || $release['assetId'] !== $assetId
            || !hash_equals($digest, $release['digest'])) {
            throw new \RuntimeException('The selected GitHub release has changed or is no longer available. Check for updates again.');
        }
        return $release;
    }

    public function download(array $release, string $destination): void
    {
        $this->request(self::API . '/releases/assets/' . (int) $release['assetId'], $destination);
        $this->verifyArchive($destination, $release);
    }

    /** Also used before apply, against freshly fetched GitHub metadata. */
    public function verifyArchive(string $path, array $release): string
    {
        clearstatcache(true, $path);
        if (!is_file($path) || filesize($path) !== $release['sizeBytes']
            || !hash_equals($release['digest'], hash_file('sha256', $path) ?: '')) {
            throw new \RuntimeException('The release ZIP does not match GitHub\'s published size and SHA-256 digest. Download it again.');
        }
        if (!class_exists(\ZipArchive::class)) throw new \RuntimeException('The PHP zip extension is required for upgrades.');
        $zip = new \ZipArchive();
        if ($zip->open($path) !== true) throw new \RuntimeException('The GitHub release asset is not a readable ZIP.');
        try {
            $stat = $zip->statName('manifest.json');
            if ($stat === false || $stat['size'] > 8 * 1024 * 1024) {
                throw new \RuntimeException('The official release must contain a bounded manifest.json.');
            }
            $bytes = $zip->getFromName('manifest.json');
            if ($bytes === false) throw new \RuntimeException('Cannot read the official release manifest.');
            $manifest = json_decode($bytes, true);
            if (($manifest['version'] ?? null) !== $release['version']) {
                throw new \RuntimeException('The release manifest version does not match its GitHub tag.');
            }
            return hash('sha256', $bytes);
        } finally {
            $zip->close();
        }
    }

    private function metadata(string $url): array
    {
        try { $value = json_decode($this->request($url), true, 32, JSON_THROW_ON_ERROR); }
        catch (\JsonException $error) { throw new \RuntimeException('GitHub returned invalid release metadata.', 0, $error); }
        if (!is_array($value)) throw new \RuntimeException('GitHub returned invalid release metadata.');
        return $value;
    }

    private function selectAsset(array $release): ?array
    {
        if (($release['draft'] ?? true) !== false || ($release['prerelease'] ?? true) !== false
            || !is_string($release['published_at'] ?? null)
            || !is_int($release['id'] ?? null) || $release['id'] < 1
            || !is_string($release['tag_name'] ?? null)
            || !preg_match('/^v?(\d+\.\d+\.\d+)$/D', $release['tag_name'], $version)) return null;
        if (!is_array($release['assets'] ?? null)) throw new \RuntimeException('GitHub returned invalid release assets.');
        $matches = [];
        foreach ($release['assets'] ?? [] as $asset) {
            if (is_array($asset) && in_array($asset['name'] ?? null, ['formlogic-' . $version[1] . '.zip', 'formlogic-v' . $version[1] . '.zip'], true)
                && ($asset['state'] ?? null) === 'uploaded') $matches[] = $asset;
        }
        if ($matches === []) return null;
        if (count($matches) !== 1) throw new \RuntimeException('The release contains multiple FormLogic packages; the publisher must select one.');
        $asset = $matches[0];
        if (!is_int($asset['id'] ?? null) || $asset['id'] < 1
            || !is_int($asset['size'] ?? null) || $asset['size'] < 1 || $asset['size'] > self::MAX_ZIP_BYTES
            || !is_string($asset['digest'] ?? null) || !preg_match('/^sha256:([0-9a-f]{64})$/D', $asset['digest'], $digest)) {
            throw new \RuntimeException('The release needs a ZIP under 512 MiB with a GitHub SHA-256 digest. Older assets may need to be uploaded again.');
        }
        return [
            'releaseId' => $release['id'], 'assetId' => $asset['id'], 'version' => $version[1],
            'tag' => $release['tag_name'], 'name' => $asset['name'], 'sizeBytes' => $asset['size'],
            'digest' => $digest[1], 'publishedAt' => $release['published_at'],
            'url' => 'https://github.com/' . self::REPOSITORY . '/releases/tag/' . rawurlencode($release['tag_name']),
        ];
    }

    /** Bounded HTTPS transfers. Redirects are checked individually; no token is needed for public releases. */
    protected function request(string $url, ?string $destination = null): string
    {
        if (!extension_loaded('curl')) throw new \RuntimeException('The PHP curl extension is required for GitHub updates.');
        $limit = $destination === null ? 2 * 1024 * 1024 : self::MAX_ZIP_BYTES;
        $file = $destination === null ? null : fopen($destination, 'wb');
        if ($destination !== null && $file === false) throw new \RuntimeException('Cannot write the release download.');
        $deadline = time() + ($destination === null ? 20 : 180);
        try {
            for ($hop = 0; $hop < 4; $hop++) {
                $parts = parse_url($url);
                if ($parts === false || ($parts['scheme'] ?? '') !== 'https' || isset($parts['user']) || isset($parts['pass'])
                    || (isset($parts['port']) && $parts['port'] !== 443)
                    || !in_array($parts['host'] ?? '', ['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'], true)) {
                    throw new \RuntimeException('GitHub redirected the download outside the official release hosts.');
                }
                if (time() >= $deadline) throw new \RuntimeException('GitHub release download timed out.');
                $body = ''; $location = null; $received = 0;
                if (is_resource($file)) { ftruncate($file, 0); rewind($file); }
                $curl = curl_init($url);
                curl_setopt_array($curl, [
                    CURLOPT_FOLLOWLOCATION => false, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
                    CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
                    CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_TIMEOUT => max(1, $deadline - time()),
                    CURLOPT_USERAGENT => 'FormLogic-Updater',
                    CURLOPT_HTTPHEADER => ['Accept: ' . ($destination === null ? 'application/vnd.github+json' : 'application/octet-stream'), 'X-GitHub-Api-Version: 2022-11-28'],
                    CURLOPT_HEADERFUNCTION => static function ($handle, string $line) use (&$location): int {
                        if (stripos($line, 'Location:') === 0) $location = trim(substr($line, 9));
                        return strlen($line);
                    },
                    CURLOPT_WRITEFUNCTION => static function ($handle, string $chunk) use (&$body, &$received, $file, $limit): int {
                        $received += strlen($chunk);
                        if ($received > $limit) return 0;
                        if (is_resource($file)) return fwrite($file, $chunk) ?: 0;
                        $body .= $chunk;
                        return strlen($chunk);
                    },
                ]);
                // Windows PHP commonly has no default CA file; use the shipped bundle.
                // Respect a CA path explicitly configured by the operator.
                $caBundle = dirname(__DIR__, 2) . '/resources/cacert.pem';
                if (trim((string) ini_get('curl.cainfo')) === '' && is_file($caBundle)) {
                    curl_setopt($curl, CURLOPT_CAINFO, $caBundle);
                }
                $ok = curl_exec($curl);
                $curlError = curl_errno($curl);
                $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
                curl_close($curl);
                if ($curlError === 60 /* libcurl peer certificate verification error */) {
                    throw new \RuntimeException('GitHub TLS certificate verification failed. Check the PHP CA certificate configuration.');
                }
                if ($ok === false) throw new \RuntimeException('GitHub transfer failed or exceeded the download limit. Check connectivity and try again.');
                if (in_array($status, [301, 302, 303, 307, 308], true) && is_string($location)) {
                    $url = $location;
                    continue;
                }
                if ($status !== 200) throw new \RuntimeException('GitHub release request failed (HTTP ' . $status . '). Try again later; public API rate limits may apply.', $status);
                return $body;
            }
            throw new \RuntimeException('GitHub returned too many download redirects.');
        } finally {
            if (is_resource($file)) fclose($file);
        }
    }
}
