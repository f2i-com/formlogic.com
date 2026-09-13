<?php
declare(strict_types=1);
namespace FormLogic\Services;

/** Operator-owned pack folders. Reading a catalogue never executes pack source. */
final class FolderPackCatalog
{
    public function __construct(private ?string $bundled = null, private ?string $custom = null) {}

    public function load(): array
    {
        $root = dirname(__DIR__, 2);
        $entries = []; $hidden = []; $errors = []; $reserved = [];
        foreach ([$this->bundled ?? $root . '/resources/packs', $this->custom ?? $root . '/storage/pack-projects'] as $directory) {
            $folders = glob($directory . '/*', GLOB_ONLYDIR) ?: [];
            sort($folders, SORT_STRING);
            foreach (array_slice($folders, 0, 200) as $folder) {
                $id = basename($folder);
                try {
                    if (is_link($folder) || !preg_match('/^[a-z0-9][a-z0-9-]{0,79}$/D', $id)) throw new \InvalidArgumentException('Invalid folder name');
                    $meta = $this->json($folder, 'pack.json');
                    if (($meta['id'] ?? null) !== $id || ($meta['formatVersion'] ?? null) !== 1) throw new \InvalidArgumentException('pack.json identity or version is invalid');
                    $reserved[$id] = true;
                    $oldName = $meta['name'] ?? ($entries[$id]['name'] ?? $id);
                    if (is_string($oldName)) $reserved[trim(preg_replace('/[\s-]+/', '-', preg_replace('/[^a-z0-9\s-]/', '', strtolower(trim($oldName)))), '-')] = true;
                    if (($meta['disabled'] ?? false) === true) { unset($entries[$id]); $hidden[$id] = true; continue; }
                    if (!is_string($meta['name'] ?? null) || !trim($meta['name']) || strlen($meta['name']) > 200
                        || !is_string($meta['description'] ?? '') || !is_string($meta['version'] ?? null)
                        || !is_array($meta['tags'] ?? []) || !is_array($meta['projects'] ?? null)) throw new \InvalidArgumentException('Invalid pack metadata');
                    if (strlen($meta['description'] ?? '') > 10000 || strlen($meta['version']) > 50 || count($meta['tags'] ?? []) > 30 || count($meta['projects']) > 20) throw new \InvalidArgumentException('Metadata exceeds limits');
                    foreach (['icon', 'category'] as $key) if (isset($meta[$key]) && (!is_string($meta[$key]) || strlen($meta[$key]) > 100)) throw new \InvalidArgumentException('Invalid ' . $key);
                    foreach ($meta['tags'] ?? [] as $tag) if (!is_string($tag) || strlen($tag) > 100) throw new \InvalidArgumentException('Invalid tag');
                    $shots = $meta['screenshots'] ?? [];
                    if (!is_array($shots) || !array_is_list($shots) || count($shots) > 8) throw new \InvalidArgumentException('Invalid screenshots');
                    foreach ($shots as $shot) if (!is_array($shot) || !is_string($shot['label'] ?? null) || !is_string($shot['url'] ?? null) || !preg_match('~^/api/packs/screenshots/[a-zA-Z0-9_.-]+\.(png|jpg|webp)$~D', $shot['url'])) throw new \InvalidArgumentException('Invalid screenshot');
                    $pack = $this->json($folder, 'install.json');
                    if (($pack['packMeta']['id'] ?? null) !== $id || ($pack['packMeta']['version'] ?? null) !== $meta['version']) throw new \InvalidArgumentException('Installation identity/version differs from pack.json');
                    if (!is_array($pack['forms'] ?? null) || !is_array($pack['apps'] ?? null)) throw new \InvalidArgumentException('Expected forms and apps');
                    foreach ($pack['forms'] as &$form) {
                        if (isset($form['logicScriptFile'])) {
                            $form['logicScript'] = $this->read($folder, $form['logicScriptFile']);
                            unset($form['logicScriptFile']);
                        }
                    }
                    unset($form);
                    foreach ($pack['apps'] as &$app) {
                        $project = $meta['projects'][$app['packAppId']] ?? null;
                        if (!is_string($project)) throw new \InvalidArgumentException('Every app needs a project folder');
                        $loaded = $this->project($folder, $project);
                        unset($app['nativeProject'], $app['hostedProject']);
                        if (isset($loaded['files'])) { $app['nativeProject'] = $loaded; unset($app['settings']['hostedDashboard']); }
                        else { $app['hostedProject'] = $loaded; $app['settings']['hostedDashboard'] = true; }
                    }
                    unset($app);
                    // Use the same structural validation as imports, without constructing database services.
                    if (strlen(json_encode($pack, JSON_THROW_ON_ERROR)) > 5 * 1024 * 1024) throw new \InvalidArgumentException('Pack exceeds 5 MB');
                    PackService::validateDefinition($pack);
                    $entries[$id] = [...$meta, 'pack' => $pack];
                    unset($hidden[$id]);
                } catch (\Throwable $e) {
                    $errors[] = $id . ': ' . $e->getMessage();
                    error_log('Pack folder skipped: ' . end($errors));
                }
            }
            if (count($folders) > 200) $errors[] = 'Pack folder limit exceeded';
        }
        return ['entries' => $entries, 'hidden' => array_keys($hidden), 'errors' => $errors, 'reserved' => array_keys($reserved)];
    }

    private function read(string $root, mixed $path): string
    {
        if (!is_string($path) || !PackFileService::isSafeZipEntryName($path) || str_contains($path, '..')) throw new \InvalidArgumentException('Invalid source path');
        $resolvedRoot = realpath($root);
        $file = realpath($root . '/' . $path);
        if (!$resolvedRoot || !$file || !str_starts_with(str_replace('\\', '/', $file), str_replace('\\', '/', $resolvedRoot) . '/')
            || !is_file($file) || filesize($file) > 5 * 1024 * 1024) throw new \InvalidArgumentException('Missing or oversized source file');
        // Reject symlink components, including directory links within a valid root.
        $walk = $root;
        foreach (explode('/', $path) as $part) { $walk .= '/' . $part; if (is_link($walk)) throw new \InvalidArgumentException('Linked sources are not supported'); }
        $source = file_get_contents($file);
        if ($source === false) throw new \InvalidArgumentException('Source could not be read');
        return $source;
    }

    private function json(string $root, string $path): array
    {
        $value = json_decode($this->read($root, $path), true, 128, JSON_THROW_ON_ERROR);
        if (!is_array($value)) throw new \InvalidArgumentException('Expected a JSON object');
        return $value;
    }

    private function project(string $folder, string $path): array
    {
        $manifest = $this->json($folder, $path . '/manifest.json');
        $config = $this->json($folder, $path . '/formlogic.json');
        if (($config['formatVersion'] ?? null) === 1 && ($config['hosting'] ?? null) === 'native') {
            if (!is_array($config['files'] ?? null) || !array_is_list($config['files']) || count($config['files']) > 200 || !is_array($config['assets'] ?? []) || count($config['assets'] ?? []) > 100) throw new \InvalidArgumentException('Invalid native file list');
            $files = []; $assets = [];
            foreach (array_unique(['manifest.json', ...$config['files']]) as $name) $files[$name] = $this->read($folder, $path . '/' . $name);
            foreach ($config['assets'] ?? [] as $name) $assets[$name] = base64_encode($this->read($folder, $path . '/' . $name));
            $project = ['version' => 0, 'home' => true, 'access' => $config['access'] ?? 'members', 'files' => $files, 'assets' => $assets];
            if (!in_array($project['access'], ['members', 'application'], true)) throw new \InvalidArgumentException('Invalid native app access');
            NativeAppService::validateProject($project);
            return $project;
        }
        if (($config['formatVersion'] ?? null) !== 1 || !is_array($config['actions'] ?? null)) throw new \InvalidArgumentException('Invalid project configuration');
        $names = array_unique(['manifest.json', 'permission.json', $manifest['main'] ?? '', ...($manifest['files']['ui'] ?? []), ...($manifest['files']['logic'] ?? [])]);
        $client = [];
        foreach ($names as $name) $client[$name] = $this->read($folder, $path . '/' . $name);
        $actions = [];
        foreach ($config['actions'] as $name => $action) {
            $actions[$name] = ['source' => $this->read($folder, $path . '/' . ($action['file'] ?? '')), 'mode' => $action['mode'] ?? null, 'access' => $action['access'] ?? null];
        }
        return (new HostedAppService(new SandboxRunner()))->validate(['version' => 1, 'client' => $client, 'actions' => $actions]);
    }

    public static function summary(array $entry): array
    {
        return [
            'id' => 'folder-' . $entry['id'], 'slug' => $entry['id'], 'name' => $entry['name'], 'description' => $entry['description'] ?? '',
            'icon' => $entry['icon'] ?? null, 'tags' => $entry['tags'] ?? [], 'category' => $entry['category'] ?? null,
            'itemType' => 'application_package', 'trustLevel' => 'community', 'official' => false, 'folderSource' => true,
            'visibility' => 'public', 'status' => 'published', 'downloadCount' => 0, 'avgRating' => 0, 'ratingCount' => 0,
            'featured' => ($entry['featured'] ?? false) === true, 'publisherId' => '', 'publisherName' => 'Server catalogue',
            'latestVersion' => $entry['version'], 'formatVersion' => 1, 'formCount' => count($entry['pack']['forms']), 'appCount' => count($entry['pack']['apps']),
            'nodeCount' => 0, 'screenshot' => $entry['screenshots'][0]['url'] ?? null, 'screenshots' => $entry['screenshots'] ?? [], 'versions' => [], 'createdAt' => '', 'updatedAt' => '',
            'formTitles' => array_column($entry['pack']['forms'], 'title'), 'appNames' => array_column($entry['pack']['apps'], 'name'),
        ];
    }
}
